import type { D1Database } from '@cloudflare/workers-types';
import { compare } from 'compare-versions';
import { RELAYED_INSTALL_ID, versionSchema } from '../schemas/ingest.ts';
import { countedInstall } from '../utils/installs.ts';
import type { ErrorReport } from '../schemas/ingest.ts';
import { sanitizeReport, sanitizeText } from '../utils/sanitize.ts';
import { sendDiscordReport, sendWebPush } from './delivery.ts';
import type { DeliveryResult, PushPayload, PushTarget } from './delivery.ts';
import type { RuleEvaluation } from './ruleEngine.ts';

export type NotificationTrigger = 'NEW_CRITICAL' | 'REGRESSION' | 'SPIKE_DETECTED' | 'UPSTREAM_CHANGE';
export type NotificationConfiguration = {
  dashboardOrigin: string;
  discordWebhookUrl: string;
  vapid: { publicKey: string; privateKey: string; subject: string };
  cooldownMs?: number;
  windowMs?: number;
  spikeReportThreshold?: number;
  distinctInstallThreshold?: number;
  requestTimeoutMs?: number;
};

export type NotificationInput = {
  issueId: number;
  report: ErrorReport;
  rule: RuleEvaluation;
  isNewIssue: boolean;
  // Identity of the one committed fixed -> regressed transition, supplied by
  // the future ingestion transaction, never simply the current issue status.
  regressionEventId?: string;
  now?: number;
};

export type PushClaim = {
  issue_id: number;
  event_type: NotificationTrigger;
  dedupe_key: string;
  lease_token: string;
  lease_expires_at: number;
};

export type PushSummary = {
  state: 'suppressed' | 'already_claimed' | 'no_subscriptions' | 'delivered' | 'partial' | 'failed';
  trigger: NotificationTrigger | null;
  attempted: number;
  delivered: number;
  expired: number;
  failed: number;
  retryable: boolean;
};

type IssueState = {
  id: number;
  fingerprint: string;
  status: 'new' | 'investigating' | 'fixed' | 'regressed' | 'ignored';
  muted: number;
  fixed_in_version: string | null;
  last_pushed_at: number | null;
  last_seen_at: number;
};
type SubscriptionRow = PushTarget & { id: number };
type WindowCounts = { report_count: number; distinct_installs: number };

const MAX_TIME = 253_402_300_799_999;
const LEASE_MS = 30_000;
const DELIVERY_BUDGET_MS = 18_000;
const MAX_SUBSCRIPTIONS_PER_DISPATCH = 100;
const PUSH_CONCURRENCY = 4;
const triggers: readonly NotificationTrigger[] = ['NEW_CRITICAL', 'REGRESSION', 'SPIKE_DETECTED', 'UPSTREAM_CHANGE'];

function integer(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`Invalid ${label}`);
  return value;
}

function timestamp(value: number): number {
  return integer(value, 0, MAX_TIME - LEASE_MS, 'server timestamp');
}

function settings(config: NotificationConfiguration) {
  const origin = new URL(config.dashboardOrigin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new TypeError('Dashboard must be an HTTPS origin');
  }
  return {
    origin: origin.origin,
    cooldownMs: integer(config.cooldownMs ?? 1_800_000, 1000, 86_400_000, 'push cooldown'),
    windowMs: integer(config.windowMs ?? 900_000, 1000, 86_400_000, 'detection window'),
    spikeReportThreshold: integer(config.spikeReportThreshold ?? 10, 1, 1_000_000, 'spike threshold'),
    distinctInstallThreshold: integer(config.distinctInstallThreshold ?? 3, 2, 1_000_000, 'installation threshold'),
    requestTimeoutMs: integer(config.requestTimeoutMs ?? 5000, 1, 5000, 'request timeout')
  };
}

function summary(state: PushSummary['state'], trigger: NotificationTrigger | null): PushSummary {
  return { state, trigger, attempted: 0, delivered: 0, expired: 0, failed: 0, retryable: false };
}

/** Atomically reserve a single event while enforcing issue-wide cooldown/leases. */
export async function reservePushNotification(db: D1Database, input: {
  issueId: number; trigger: NotificationTrigger; dedupeKey: string; now: number; cooldownMs?: number; leaseMs?: number;
}): Promise<PushClaim | null> {
  integer(input.issueId, 1, Number.MAX_SAFE_INTEGER, 'issue ID');
  const now = timestamp(input.now);
  const cooldown = integer(input.cooldownMs ?? 1_800_000, 1000, 86_400_000, 'push cooldown');
  const lease = integer(input.leaseMs ?? LEASE_MS, 1, LEASE_MS, 'lease duration');
  if (!triggers.includes(input.trigger) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.dedupeKey)) throw new TypeError('Invalid notification event identity');
  const token = crypto.randomUUID();
  return db.prepare(`
    INSERT INTO notification_claims (issue_id,event_type,dedupe_key,lease_token,lease_expires_at,created_at)
    SELECT i.id, ?, ?, ?, ?, ? FROM issues i
    WHERE i.id = ? AND i.muted = 0 AND i.status <> 'ignored'
      AND (? <> 'REGRESSION' OR i.status = 'regressed')
      AND (? = 'REGRESSION' OR i.last_pushed_at IS NULL OR i.last_pushed_at <= ?)
      AND (? = 'REGRESSION' OR NOT EXISTS (
        SELECT 1 FROM notification_claims active
        WHERE active.issue_id = i.id AND active.delivered_at IS NULL AND active.lease_expires_at > ?
      ))
    ON CONFLICT (issue_id,event_type,dedupe_key) DO UPDATE SET
      lease_token=excluded.lease_token, lease_expires_at=excluded.lease_expires_at
    WHERE notification_claims.delivered_at IS NULL
      AND (notification_claims.lease_expires_at IS NULL OR notification_claims.lease_expires_at <= ?)
    RETURNING issue_id,event_type,dedupe_key,lease_token,lease_expires_at
  `).bind(
    input.trigger, input.dedupeKey, token, now + lease, now, input.issueId,
    input.trigger, input.trigger, now - cooldown, input.trigger, now, now
  ).first<PushClaim>();
}

/** Complete only the currently owned lease; stale workers cannot start cooldown. */
export async function completePushNotification(db: D1Database, claim: PushClaim, completedAt: number): Promise<boolean> {
  timestamp(completedAt);
  const results = await db.batch([
    db.prepare(`UPDATE notification_claims SET delivered_at=?
      WHERE issue_id=? AND event_type=? AND dedupe_key=? AND lease_token=? AND delivered_at IS NULL
      RETURNING issue_id`).bind(completedAt, claim.issue_id, claim.event_type, claim.dedupe_key, claim.lease_token),
    db.prepare(`UPDATE issues SET last_pushed_at=CASE
        WHEN last_pushed_at IS NULL OR last_pushed_at < ? THEN ? ELSE last_pushed_at END,
        updated_at=max(updated_at,?)
      WHERE id=? AND EXISTS (SELECT 1 FROM notification_claims
        WHERE issue_id=? AND event_type=? AND dedupe_key=? AND lease_token=? AND delivered_at=?)`
    ).bind(completedAt, completedAt, completedAt, claim.issue_id, claim.issue_id, claim.event_type, claim.dedupe_key, claim.lease_token, completedAt)
  ]);
  return (results[0]?.results.length ?? 0) === 1;
}

export async function releasePushNotification(db: D1Database, claim: PushClaim): Promise<boolean> {
  const result = await db.prepare(`UPDATE notification_claims SET lease_token=NULL,lease_expires_at=NULL
    WHERE issue_id=? AND event_type=? AND dedupe_key=? AND lease_token=? AND delivered_at IS NULL`
  ).bind(claim.issue_id, claim.event_type, claim.dedupe_key, claim.lease_token).run();
  return result.meta.changes === 1;
}

async function subscriptionRows(db: D1Database): Promise<{ total: number; rows: SubscriptionRow[] }> {
  const [count, subscriptions] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS total FROM push_subscriptions').first<{ total: number }>(),
    db.prepare('SELECT id,endpoint,p256dh,auth,expiration_time FROM push_subscriptions ORDER BY id LIMIT ?')
      .bind(MAX_SUBSCRIPTIONS_PER_DISPATCH).all<SubscriptionRow>()
  ]);
  return { total: count?.total ?? 0, rows: subscriptions.results };
}

async function dispatchPush(db: D1Database, targets: { total: number; rows: SubscriptionRow[] }, payload: PushPayload,
  config: NotificationConfiguration, now: number, timeoutMs: number): Promise<PushSummary> {
  const result = summary(targets.total ? 'failed' : 'no_subscriptions', payload.data.trigger === 'TEST' ? null : payload.data.trigger as NotificationTrigger);
  if (!targets.total) return result;
  const deadline = performance.now() + DELIVERY_BUDGET_MS;
  let next = 0;
  async function worker(): Promise<void> {
    while (next < targets.rows.length && performance.now() < deadline) {
      const target = targets.rows[next++];
      if (!target) return;
      const remaining = Math.floor(deadline - performance.now());
      if (remaining < 1) return;
      result.attempted += 1;
      const delivery = await sendWebPush(target, payload, config.vapid, { timeoutMs: Math.min(timeoutMs, remaining), now });
      if (delivery.ok) result.delivered += 1;
      else {
        result.failed += 1;
        result.retryable ||= delivery.retryable;
        if (delivery.expired) {
          result.expired += 1;
          // A subscription may have rotated while delivery was in flight.
          try {
            await db.prepare('DELETE FROM push_subscriptions WHERE id=? AND endpoint=? AND p256dh=? AND auth=?')
              .bind(target.id, target.endpoint, target.p256dh, target.auth).run();
          } catch {
            // Cleanup is best effort. It must not release the issue claim while
            // another worker is still delivering or erase accepted deliveries.
            result.retryable = true;
          }
        }
      }
    }
  }
  const workers = await Promise.allSettled(Array.from({ length: Math.min(PUSH_CONCURRENCY, targets.rows.length) }, () => worker()));
  result.retryable ||= workers.some((workerResult) => workerResult.status === 'rejected');
  const unattempted = Math.max(0, targets.total - result.attempted);
  result.failed += unattempted;
  result.failed = Math.max(result.failed, targets.total - result.delivered);
  result.retryable ||= unattempted > 0;
  result.state = result.delivered ? (result.failed ? 'partial' : 'delivered') : 'failed';
  return result;
}

function chooseTrigger(issue: IssueState, input: NotificationInput, counts: WindowCounts, config: ReturnType<typeof settings>): NotificationTrigger | null {
  if (issue.status === 'ignored' || issue.muted) return null;
  if (input.regressionEventId && issue.status === 'regressed' && issue.fixed_in_version
    && versionSchema.safeParse(issue.fixed_in_version).success && compare(input.report.version, issue.fixed_in_version, '>')) return 'REGRESSION';
  if (input.rule.structural_category !== null && counts.distinct_installs >= config.distinctInstallThreshold) return 'UPSTREAM_CHANGE';
  if (input.isNewIssue && (input.report.severity === 'error' || input.report.severity === 'fatal')) return 'NEW_CRITICAL';
  if (!input.isNewIssue && counts.report_count >= config.spikeReportThreshold && counts.distinct_installs >= config.distinctInstallThreshold) return 'SPIKE_DETECTED';
  return null;
}

function eventKey(trigger: NotificationTrigger, input: NotificationInput, now: number, cooldown: number): string {
  if (trigger === 'REGRESSION') return input.regressionEventId ?? input.report.report_id;
  if (trigger === 'NEW_CRITICAL') return 'initial';
  return `${trigger.toLowerCase()}:${Math.floor(now / cooldown)}`;
}

function pushPayload(trigger: NotificationTrigger, issue: IssueState, input: NotificationInput, origin: string, badgeCount: number): PushPayload {
  const title: Record<NotificationTrigger, string> = {
    NEW_CRITICAL: 'New critical issue', REGRESSION: 'Regression detected',
    SPIKE_DETECTED: 'Issue spike detected', UPSTREAM_CHANGE: 'Upstream change detected'
  };
  return {
    title: title[trigger],
    body: Array.from(sanitizeText(`${input.rule.category}: ${input.report.error_message}`)).slice(0, 240).join(''),
    tag: issue.fingerprint,
    data: { url: new URL(`/?issue=${issue.id}`, origin).href, issue_id: issue.id, fingerprint: issue.fingerprint, trigger },
    badge_count: badgeCount
  };
}

async function issuePush(db: D1Database, issue: IssueState, input: NotificationInput,
  config: NotificationConfiguration, resolved: ReturnType<typeof settings>, now: number): Promise<PushSummary> {
  const counts = await db.prepare(`SELECT COUNT(*) AS report_count,COUNT(DISTINCT ${countedInstall('install_id')}) AS distinct_installs
    FROM reports WHERE issue_id=? AND created_at>=? AND created_at<=?`
  ).bind(issue.id, Math.max(0, now - resolved.windowMs), now).first<WindowCounts>();
  const trigger = chooseTrigger(issue, input, counts ?? { report_count: 0, distinct_installs: 0 }, resolved);
  if (!trigger) return summary('suppressed', null);
  const targets = await subscriptionRows(db);
  if (!targets.total) return summary('no_subscriptions', trigger);
  const claim = await reservePushNotification(db, {
    issueId: issue.id, trigger, dedupeKey: eventKey(trigger, input, now, resolved.cooldownMs), now, cooldownMs: resolved.cooldownMs
  });
  if (!claim) return summary('already_claimed', trigger);
  try {
    const badge = await db.prepare("SELECT COUNT(*) AS count FROM issues WHERE status IN ('new','investigating','regressed') AND muted=0").first<{ count: number }>();
    const result = await dispatchPush(db, targets, pushPayload(trigger, issue, input, resolved.origin, Math.min(9999, badge?.count ?? 0)), config, now, resolved.requestTimeoutMs);
    if (result.delivered) await completePushNotification(db, claim, Math.max(now, Date.now()));
    else await releasePushNotification(db, claim);
    return result;
  } catch (error) {
    await releasePushNotification(db, claim);
    throw error;
  }
}

/** Call after a newly accepted report is committed, from ctx.waitUntil(). */
export async function sendIssueNotifications(db: D1Database, input: NotificationInput, config: NotificationConfiguration): Promise<{ discord: DeliveryResult; push: PushSummary }> {
  const resolved = settings(config);
  const now = timestamp(input.now ?? Date.now());
  const report = sanitizeReport(input.report);
  const issue = await db.prepare(`SELECT i.id,i.fingerprint,i.status,i.muted,i.fixed_in_version,i.last_pushed_at,i.last_seen_at
    FROM issues i JOIN report_receipts receipt ON receipt.issue_id=i.id
    WHERE i.id=? AND receipt.id=? AND receipt.install_id=?`
  ).bind(input.issueId, report.report_id, report.install_id).first<IssueState>();
  if (!issue) throw new Error('Report must be persisted for the selected issue before delivery');
  const sanitizedInput = { ...input, report };
  // Request clocks can be ordered differently from D1 commits. Include the
  // latest known receipt when detecting current canaries/spikes and claiming
  // their delivery, while Discord retains this report's diagnostic context.
  const pushNow = timestamp(Math.max(now, issue.last_seen_at));
  // Discord is independent of push mute/cooldown and receives every newly
  // accepted report. The ingestion transaction must not schedule report retries.
  // Relayed reports reach Discord through the relay, which suppresses its own duplicates.
  const posted: DeliveryResult = { ok: true, status: null, retryable: false, expired: false, retry_after_ms: null, reason: 'already_posted' };
  const [discord, push] = await Promise.allSettled([
    report.install_id === RELAYED_INSTALL_ID ? Promise.resolve(posted) : sendDiscordReport(config.discordWebhookUrl, report, {
      issueId: issue.id, fingerprint: issue.fingerprint, dashboardOrigin: resolved.origin,
      category: input.rule.category, faultOrigin: input.rule.fault_origin, suggestedAction: input.rule.suggested_action
    }, { timeoutMs: resolved.requestTimeoutMs, now }),
    issuePush(db, issue, sanitizedInput, config, resolved, pushNow)
  ]);
  const failedPush = summary('failed', null);
  failedPush.retryable = true;
  return {
    discord: discord.status === 'fulfilled' ? discord.value : {
      ok: false, status: null, retryable: true, expired: false, retry_after_ms: null, reason: 'network_error'
    },
    push: push.status === 'fulfilled' ? push.value : failedPush
  };
}

/** Future protected admin endpoint: test delivery without issue/cooldown changes. */
export async function sendTestNotification(db: D1Database, config: NotificationConfiguration, now = Date.now()): Promise<PushSummary> {
  const resolved = settings(config);
  timestamp(now);
  return dispatchPush(db, await subscriptionRows(db), {
    title: 'Diagnostics test', body: 'Web Push is connected.', tag: 'diagnostics-test',
    data: { url: new URL('/', resolved.origin).href, issue_id: null, fingerprint: null, trigger: 'TEST' }, badge_count: 0
  }, config, now, resolved.requestTimeoutMs);
}
