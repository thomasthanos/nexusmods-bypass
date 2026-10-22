import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Context } from 'hono';
import type { AppEnv } from '../http/types.ts';
import { boundedJson } from '../http/security.ts';
import { ingestionOptions, integerSetting, notificationConfiguration } from '../http/config.ts';
import { browserSchema, destinationSchema, metricDateSchema, osSchema, severitySchema, versionSchema } from '../schemas/ingest.ts';
import { validateSubscription } from '../services/delivery.ts';
import { sendTestNotification } from '../services/notifications.ts';
import { sanitizeText } from '../utils/sanitize.ts';

type SqlValue = string | number | null;
type IssueRow = Record<string, unknown> & {
  id: number; status: string; muted: number; fixed_in_version: string | null;
  github_issue_url: string | null; updated_at: number;
};
type ReportRow = Record<string, unknown> & {
  breadcrumbs_json: string; dom_state_json: string | null; context_json: string;
};
type Metrics = {
  attempts_count: number; success_count: number; fallback_triggered_count: number; heartbeat_count: number;
};
type SubscriptionRow = {
  id: number; endpoint: string; user_agent: string | null; expiration_time: number | null; created_at: number; updated_at: number;
};
type DateWindow = { from: string; to: string; start: number; end: number };

const DAY = 86_400_000;
const MAX_TIME = 253_402_300_799_999;
const statusSchema = z.enum(['new', 'investigating', 'fixed', 'regressed', 'ignored']);
const faultSchema = z.enum(['client_env', 'upstream_site', 'rate_limit', 'extension_bug', 'unknown']);
const categorySchema = z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_.:-]*$/);
const pageSchema = z.string().regex(/^[1-9][0-9]{0,4}$/).transform(Number).pipe(z.number().int().max(10_000)).default(1);
const limitSchema = z.string().regex(/^[1-9][0-9]{0,2}$/).transform(Number).pipe(z.number().int().max(100)).default(30);
const dateFields = { from: metricDateSchema.optional(), to: metricDateSchema.optional() };
const paginationFields = { page: pageSchema, limit: limitSchema };
const releaseFields = { ...dateFields, browser: browserSchema.optional(), destination: destinationSchema.optional() };
const issueQuerySchema = z.strictObject({
  ...dateFields, ...paginationFields, version: versionSchema.optional(), browser: browserSchema.optional(), os: osSchema.optional(),
  destination: destinationSchema.optional(), download_mode: z.enum(['manual', 'auto']).optional(), status: statusSchema.optional(),
  fault_origin: faultSchema.optional(), category: categorySchema.optional(), severity: severitySchema.optional(),
  muted: z.enum(['true', 'false']).optional(), q: z.string().trim().min(1).max(200).optional()
});
const releaseQuerySchema = z.strictObject({ ...releaseFields, ...paginationFields, version: versionSchema.optional() });
const compareQuerySchema = z.strictObject({ ...releaseFields, before: versionSchema, after: versionSchema });
const overviewQuerySchema = z.strictObject(releaseFields);
const reportQuerySchema = z.strictObject(paginationFields);

function githubIssue(value: string): boolean {
  if (!/^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]+\/issues\/[1-9][0-9]*$/.test(value)) return false;
  try {
    const url = new URL(value);
    const id = url.pathname.split('/').at(-1) ?? '';
    return url.href === value && Number.isSafeInteger(Number(id));
  } catch { return false; }
}

const issuePatchSchema = z.strictObject({
  status: statusSchema.optional(), fixed_in_version: versionSchema.nullable().optional(),
  github_issue_url: z.string().max(2048).refine(githubIssue, 'Expected a GitHub issue URL').nullable().optional(),
  muted: z.boolean().optional(),
  expected: z.strictObject({
    status: statusSchema,
    fixed_in_version: versionSchema.nullable(),
    github_issue_url: z.string().max(2048).refine(githubIssue).nullable(),
    muted: z.boolean(),
    updated_at: z.number().int().min(0).max(MAX_TIME)
  }).optional()
}).refine((value) => Object.keys(value).some((key) => key !== 'expected'), 'At least one update is required');
const subscriptionSchema = z.strictObject({
  endpoint: z.string().min(9).max(2048),
  expirationTime: z.number().int().min(0).max(MAX_TIME).nullable(),
  keys: z.strictObject({ p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/), auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/) })
});
const testPushSchema = z.strictObject({});

function badRequest(c: Context<AppEnv>) { return c.json({ error: 'Invalid request' }, 400); }
function notFound(c: Context<AppEnv>) { return c.json({ error: 'Not found' }, 404); }
function conflict(c: Context<AppEnv>) { return c.json({ error: 'Resource changed; refresh and retry' }, 409); }
function issueValue(row: IssueRow) { return { ...row, muted: row.muted === 1 }; }
function reportValue(row: ReportRow) {
  const { breadcrumbs_json, dom_state_json, context_json, ...rest } = row;
  return { ...rest, breadcrumbs: JSON.parse(breadcrumbs_json) as unknown, dom_state: dom_state_json === null ? null : JSON.parse(dom_state_json) as unknown, context: JSON.parse(context_json) as unknown };
}
function identifier(value: string): number | null {
  if (!/^[1-9][0-9]{0,15}$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}
function query<T extends z.ZodType>(c: Context<AppEnv>, schema: T): z.output<T> | null {
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of new URL(c.req.url).searchParams) {
    if (Object.hasOwn(values, key)) return null;
    values[key] = value;
  }
  const parsed = schema.safeParse(values);
  return parsed.success ? parsed.data : null;
}
function dateWindow(input: { from?: string | undefined; to?: string | undefined }, now: number): DateWindow | null {
  const today = new Date(now).toISOString().slice(0, 10);
  const to = input.to ?? today;
  const endDay = Date.parse(`${to}T00:00:00.000Z`);
  const from = input.from ?? new Date(Math.max(0, endDay - 29 * DAY)).toISOString().slice(0, 10);
  const start = Date.parse(`${from}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(endDay) || start < 0 || endDay < start || endDay - start >= 366 * DAY) return null;
  return { from, to, start, end: Math.min(MAX_TIME, endDay + DAY - 1) };
}
function percentages(metrics: Metrics) {
  return {
    ...metrics,
    success_rate_percent: metrics.attempts_count ? metrics.success_count * 100 / metrics.attempts_count : null,
    fallback_rate_percent: metrics.attempts_count ? metrics.fallback_triggered_count * 100 / metrics.attempts_count : null
  };
}
function releaseWhere(input: { browser?: string | undefined; destination?: string | undefined }, window: DateWindow, version?: string) {
  const conditions = ['metric_date>=?', 'metric_date<=?'];
  const values: SqlValue[] = [window.from, window.to];
  for (const name of ['browser', 'destination'] as const) {
    if (input[name]) { conditions.push(`${name}=?`); values.push(input[name]); }
  }
  if (version !== undefined) { conditions.push('version=?'); values.push(version); }
  return { where: conditions.join(' AND '), values };
}
const sums = `COALESCE(SUM(attempts_count),0) AS attempts_count,COALESCE(SUM(success_count),0) AS success_count,
  COALESCE(SUM(fallback_triggered_count),0) AS fallback_triggered_count,COALESCE(SUM(heartbeat_count),0) AS heartbeat_count`;
async function aggregate(db: AppEnv['Bindings']['DB'], filter: ReturnType<typeof releaseWhere>): Promise<Metrics> {
  return await db.prepare(`SELECT ${sums} FROM release_metrics WHERE ${filter.where}`).bind(...filter.values).first<Metrics>()
    ?? { attempts_count: 0, success_count: 0, fallback_triggered_count: 0, heartbeat_count: 0 };
}
function provider(endpoint: string): string {
  const hostname = new URL(endpoint).hostname;
  if (hostname.endsWith('.push.apple.com')) return 'apple';
  if (hostname === 'fcm.googleapis.com') return 'google';
  if (hostname === 'push.services.mozilla.com' || hostname.endsWith('.push.services.mozilla.com')) return 'mozilla';
  if (hostname.endsWith('.notify.windows.com')) return 'microsoft';
  return 'unknown';
}
function subscriptionValue(row: SubscriptionRow) {
  const { endpoint, ...metadata } = row;
  return { ...metadata, provider: provider(endpoint) };
}

/** Parent Worker verifies Access and same-origin mutations before mounting. */
export const adminRoutes = new Hono<AppEnv>();

adminRoutes.get('/overview', async (c) => {
  const input = query(c, overviewQuerySchema);
  if (!input) return badRequest(c);
  const window = dateWindow(input, c.get('serverNow'));
  if (!window) return badRequest(c);
  const reportConditions = ['created_at>=?', 'created_at<=?'];
  const reportValues: SqlValue[] = [window.start, window.end];
  for (const name of ['browser', 'destination'] as const) {
    if (input[name]) { reportConditions.push(`${name}=?`); reportValues.push(input[name]); }
  }
  const reportFilter = reportConditions.join(' AND ');
  const issueFilter = input.browser || input.destination
    ? `EXISTS (SELECT 1 FROM reports WHERE issue_id=issues.id AND ${reportFilter})`
    : 'last_seen_at>=? AND last_seen_at<=?';
  const issueValues = input.browser || input.destination ? reportValues : [window.start, window.end];
  const detection = ingestionOptions(c.env);
  const spikeThreshold = integerSetting(c.env.SPIKE_REPORT_THRESHOLD, 1, 1_000_000);
  const liveConditions = ['r.created_at>=?', 'r.created_at<=?', "i.status<>'ignored'", 'i.muted=0'];
  const liveValues: SqlValue[] = [Math.max(0, c.get('serverNow') - detection.windowMs), c.get('serverNow')];
  for (const name of ['browser', 'destination'] as const) {
    if (input[name]) { liveConditions.push(`r.${name}=?`); liveValues.push(input[name]); }
  }
  const [issues, reports, metrics, spikes] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(status='new'),0) AS new_count,COALESCE(SUM(status='investigating'),0) AS investigating_count,
      COALESCE(SUM(status='fixed'),0) AS fixed_count,COALESCE(SUM(status='regressed'),0) AS regressed_count,
      COALESCE(SUM(status='ignored'),0) AS ignored_count,COALESCE(SUM(muted=1),0) AS muted_count
      FROM issues WHERE ${issueFilter}`).bind(...issueValues).first<Record<string, number>>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS total,COUNT(DISTINCT install_id) AS distinct_installs
      FROM reports WHERE ${reportFilter}`).bind(...reportValues).first<Record<string, number>>(),
    aggregate(c.env.DB, releaseWhere(input, window)),
    c.env.DB.prepare(`SELECT i.id AS issue_id,i.category,i.status,COUNT(*) AS report_count,
      COUNT(DISTINCT r.install_id) AS distinct_installs,MAX(r.created_at) AS last_seen_at
      FROM reports r JOIN issues i ON i.id=r.issue_id
      WHERE ${liveConditions.join(' AND ')} GROUP BY i.id
      HAVING COUNT(*)>=? AND COUNT(DISTINCT r.install_id)>=?
      ORDER BY MAX(r.created_at) DESC,i.id DESC LIMIT 5`)
      .bind(...liveValues, spikeThreshold, detection.distinctInstallThreshold).all()
  ]);
  return c.json({ window: { from: window.from, to: window.to }, issues, reports, releases: percentages(metrics),
    alerts: { window_seconds: detection.windowMs / 1000, spikes: spikes.results } });
});

adminRoutes.get('/issues', async (c) => {
  const input = query(c, issueQuerySchema);
  if (!input) return badRequest(c);
  const window = dateWindow(input, c.get('serverNow'));
  if (!window) return badRequest(c);
  const conditions: string[] = [];
  const values: SqlValue[] = [];
  for (const name of ['status', 'fault_origin', 'category'] as const) {
    if (input[name]) { conditions.push(`i.${name}=?`); values.push(input[name]); }
  }
  if (input.muted !== undefined) { conditions.push('i.muted=?'); values.push(input.muted === 'true' ? 1 : 0); }
  const reportConditions = ['r.issue_id=i.id', 'r.created_at>=?', 'r.created_at<=?'];
  const reportValues: SqlValue[] = [window.start, window.end];
  let hasReportDimension = false;
  for (const name of ['version', 'browser', 'os', 'destination', 'download_mode', 'severity'] as const) {
    if (input[name]) { reportConditions.push(`r.${name}=?`); reportValues.push(input[name]); hasReportDimension = true; }
  }
  if (input.q) {
    const search = `%${input.q.replace(/[\\%_]/g, '\\$&')}%`;
    const issueSearch = `i.fingerprint LIKE ? ESCAPE '\\' OR i.category LIKE ? ESCAPE '\\'
      OR i.error_code LIKE ? ESCAPE '\\' OR i.normalized_top_frame LIKE ? ESCAPE '\\'`;
    if (hasReportDimension) {
      reportConditions.push(`(${issueSearch} OR r.error_message LIKE ? ESCAPE '\\')`);
      reportValues.push(search, search, search, search, search);
    } else {
      conditions.push(`(${issueSearch} OR EXISTS (SELECT 1 FROM reports search_report WHERE search_report.issue_id=i.id
        AND search_report.created_at>=? AND search_report.created_at<=? AND search_report.error_message LIKE ? ESCAPE '\\'))`);
      values.push(search, search, search, search, window.start, window.end, search);
    }
  }
  if (hasReportDimension) {
    conditions.push(`EXISTS (SELECT 1 FROM reports r WHERE ${reportConditions.join(' AND ')})`);
    values.push(...reportValues);
  } else {
    conditions.push('i.last_seen_at>=? AND i.last_seen_at<=?'); values.push(window.start, window.end);
  }
  const where = conditions.join(' AND ');
  const [total, items] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM issues i WHERE ${where}`).bind(...values),
    c.env.DB.prepare(`SELECT i.* FROM issues i WHERE ${where} ORDER BY i.last_seen_at DESC,i.id DESC LIMIT ? OFFSET ?`)
      .bind(...values, input.limit, (input.page - 1) * input.limit)
  ]);
  const count = total?.results[0] as { total: number } | undefined;
  return c.json({ items: (items?.results as IssueRow[] ?? []).map(issueValue), total: count?.total ?? 0, page: input.page, limit: input.limit });
});

adminRoutes.get('/issues/:id/reports', async (c) => {
  const id = identifier(c.req.param('id'));
  const input = query(c, reportQuerySchema);
  if (id === null || !input) return badRequest(c);
  const exists = await c.env.DB.prepare('SELECT id FROM issues WHERE id=?').bind(id).first<{ id: number }>();
  if (!exists) return notFound(c);
  const [count, rows] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT COUNT(*) AS total FROM reports WHERE issue_id=?').bind(id),
    c.env.DB.prepare('SELECT * FROM reports WHERE issue_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').bind(id, input.limit, (input.page - 1) * input.limit)
  ]);
  return c.json({ items: (rows?.results as ReportRow[] ?? []).map(reportValue), total: (count?.results[0] as { total: number } | undefined)?.total ?? 0, page: input.page, limit: input.limit });
});

adminRoutes.get('/issues/:id', async (c) => {
  const id = identifier(c.req.param('id'));
  if (id === null || !query(c, z.strictObject({}))) return badRequest(c);
  const [issueResult, summaryResult, latestResult] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT * FROM issues WHERE id=?').bind(id),
    c.env.DB.prepare(`SELECT COUNT(*) AS retained_report_count,COUNT(DISTINCT install_id) AS retained_distinct_installs,
      json_group_array(DISTINCT browser) AS browsers_json,
      (SELECT json_group_array(version) FROM (SELECT DISTINCT version FROM reports WHERE issue_id=? ORDER BY version LIMIT 101)) AS versions_json,
      json_group_array(DISTINCT os) AS operating_systems_json FROM reports WHERE issue_id=?`).bind(id, id),
    c.env.DB.prepare('SELECT * FROM reports WHERE issue_id=? ORDER BY created_at DESC,id DESC LIMIT 1').bind(id)
  ]);
  const issue = issueResult?.results[0] as IssueRow | undefined;
  if (!issue) return notFound(c);
  const summary = summaryResult?.results[0] as { retained_report_count: number; retained_distinct_installs: number; browsers_json: string; versions_json: string; operating_systems_json: string };
  const versions = JSON.parse(summary.versions_json) as string[];
  const latest = latestResult?.results[0] as ReportRow | undefined;
  return c.json({ issue: issueValue(issue), report_summary: {
    retained_report_count: summary.retained_report_count, retained_distinct_installs: summary.retained_distinct_installs,
    browsers: JSON.parse(summary.browsers_json) as string[], versions: versions.slice(0, 100), versions_truncated: versions.length > 100,
    operating_systems: JSON.parse(summary.operating_systems_json) as string[]
  }, latest_report: latest ? reportValue(latest) : null });
});

adminRoutes.patch('/issues/:id', boundedJson, zValidator('json', issuePatchSchema, (result, c) => {
  if (!result.success) return c.json({ error: 'Invalid request' }, 400);
}), async (c) => {
  const id = identifier(c.req.param('id'));
  if (id === null || !query(c, z.strictObject({}))) return badRequest(c);
  const input = c.req.valid('json');
  const previous = await c.env.DB.prepare('SELECT * FROM issues WHERE id=?').bind(id).first<IssueRow>();
  if (!previous) return notFound(c);
  if (input.expected && (input.expected.status !== previous.status
    || input.expected.fixed_in_version !== previous.fixed_in_version
    || input.expected.github_issue_url !== previous.github_issue_url
    || input.expected.muted !== (previous.muted === 1)
    || input.expected.updated_at !== previous.updated_at)) return conflict(c);
  const nextStatus = input.status ?? previous.status;
  const fixedVersion = Object.hasOwn(input, 'fixed_in_version') ? input.fixed_in_version ?? null : previous.fixed_in_version;
  const githubUrl = Object.hasOwn(input, 'github_issue_url') ? input.github_issue_url ?? null : previous.github_issue_url;
  const muted = input.muted === undefined ? previous.muted : input.muted ? 1 : 0;
  if ((nextStatus === 'fixed' || nextStatus === 'regressed') && fixedVersion === null) return badRequest(c);
  const changed = await c.env.DB.prepare(`UPDATE issues SET status=?,fixed_in_version=?,github_issue_url=?,muted=?,updated_at=max(updated_at,?)
    WHERE id=? AND status=? AND fixed_in_version IS ? AND github_issue_url IS ? AND muted=? AND updated_at=? RETURNING *`)
    .bind(nextStatus, fixedVersion, githubUrl, muted, c.get('serverNow'), id, previous.status, previous.fixed_in_version, previous.github_issue_url, previous.muted, previous.updated_at).first<IssueRow>();
  return changed ? c.json({ issue: issueValue(changed) }) : conflict(c);
});

adminRoutes.get('/releases/compare', async (c) => {
  const input = query(c, compareQuerySchema);
  if (!input) return badRequest(c);
  const window = dateWindow(input, c.get('serverNow'));
  if (!window) return badRequest(c);
  const [beforeMetrics, afterMetrics] = await Promise.all([
    aggregate(c.env.DB, releaseWhere(input, window, input.before)), aggregate(c.env.DB, releaseWhere(input, window, input.after))
  ]);
  const before = { version: input.before, ...percentages(beforeMetrics) };
  const after = { version: input.after, ...percentages(afterMetrics) };
  return c.json({ window: { from: window.from, to: window.to }, before, after,
    success_rate_delta_pp: before.success_rate_percent === null || after.success_rate_percent === null ? null : after.success_rate_percent - before.success_rate_percent,
    fallback_rate_delta_pp: before.fallback_rate_percent === null || after.fallback_rate_percent === null ? null : after.fallback_rate_percent - before.fallback_rate_percent });
});

adminRoutes.get('/releases', async (c) => {
  const input = query(c, releaseQuerySchema);
  if (!input) return badRequest(c);
  const window = dateWindow(input, c.get('serverNow'));
  if (!window) return badRequest(c);
  const filter = releaseWhere(input, window, input.version);
  const [count, rows] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT COUNT(DISTINCT version) AS total FROM release_metrics WHERE ${filter.where}`).bind(...filter.values),
    c.env.DB.prepare(`SELECT version,${sums} FROM release_metrics WHERE ${filter.where} GROUP BY version ORDER BY MAX(metric_date) DESC,version DESC LIMIT ? OFFSET ?`)
      .bind(...filter.values, input.limit, (input.page - 1) * input.limit)
  ]);
  return c.json({ items: (rows?.results as (Metrics & { version: string })[] ?? []).map(percentages), total: (count?.results[0] as { total: number } | undefined)?.total ?? 0, page: input.page, limit: input.limit });
});

adminRoutes.get('/push/config', (c) => {
  if (!query(c, z.strictObject({}))) return badRequest(c);
  return c.json({ public_key: c.env.VAPID_PUBLIC_KEY });
});

adminRoutes.get('/push/subscriptions', async (c) => {
  if (!query(c, z.strictObject({}))) return badRequest(c);
  const rows = await c.env.DB.prepare('SELECT id,endpoint,user_agent,expiration_time,created_at,updated_at FROM push_subscriptions ORDER BY id DESC LIMIT 100').all<SubscriptionRow>();
  return c.json({ items: rows.results.map(subscriptionValue) });
});

adminRoutes.post('/push/subscriptions', boundedJson, zValidator('json', subscriptionSchema, (result, c) => {
  if (!result.success) return c.json({ error: 'Invalid request' }, 400);
}), async (c) => {
  if (!query(c, z.strictObject({}))) return badRequest(c);
  const input = c.req.valid('json');
  const now = c.get('serverNow');
  if (input.expirationTime !== null && input.expirationTime <= now) return badRequest(c);
  let endpoint: URL;
  try { endpoint = await validateSubscription({ endpoint: input.endpoint, ...input.keys, expiration_time: input.expirationTime }, now); }
  catch { return badRequest(c); }
  const ua = c.req.header('User-Agent');
  const userAgent = ua ? Array.from(sanitizeText(ua)).slice(0, 512).join('') : null;
  const previous = await c.env.DB.prepare('SELECT id FROM push_subscriptions WHERE endpoint=?').bind(endpoint.href).first<{ id: number }>();
  const result = await c.env.DB.prepare(`INSERT INTO push_subscriptions (endpoint,p256dh,auth,user_agent,expiration_time,created_at,updated_at)
    SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM push_subscriptions)<100 OR EXISTS(SELECT 1 FROM push_subscriptions WHERE endpoint=?)
    ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth,user_agent=excluded.user_agent,
      expiration_time=excluded.expiration_time,updated_at=max(push_subscriptions.updated_at,excluded.updated_at)
    RETURNING id,endpoint,user_agent,expiration_time,created_at,updated_at`)
    .bind(endpoint.href, input.keys.p256dh, input.keys.auth, userAgent, input.expirationTime, now, now, endpoint.href).first<SubscriptionRow>();
  if (!result) return c.json({ error: 'Subscription capacity reached' }, 409);
  return c.json({ subscription: subscriptionValue(result) }, previous ? 200 : 201);
});

adminRoutes.delete('/push/subscriptions/:id', async (c) => {
  const id = identifier(c.req.param('id'));
  if (id === null || !query(c, z.strictObject({}))) return badRequest(c);
  const removed = await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE id=? RETURNING id').bind(id).first<{ id: number }>();
  return removed ? c.body(null, 204) : notFound(c);
});

adminRoutes.post('/push/test', boundedJson, zValidator('json', testPushSchema, (result, c) => {
  if (!result.success) return c.json({ error: 'Invalid request' }, 400);
}), async (c) => {
  if (!query(c, z.strictObject({}))) return badRequest(c);
  const result = await sendTestNotification(c.env.DB, notificationConfiguration(c.env, new URL(c.req.url).origin), c.get('serverNow'));
  return c.json(result);
});

adminRoutes.get('/health', async (c) => {
  if (!query(c, z.strictObject({}))) return badRequest(c);
  const result = await c.env.DB.prepare('SELECT 1 AS ready').first<{ ready: number }>();
  return result?.ready === 1 ? c.json({ ok: true }) : c.json({ error: 'Service unavailable' }, 503);
});

export default adminRoutes;
