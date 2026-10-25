export type AnalyticsSnapshot = {
  property_id: '547084285';
  source: 'ga4_store_listing';
  state: 'ready' | 'not_configured' | 'unavailable';
  fetched_at: number | null;
  online_30m: number | null;
  weekly_active: number | null;
  previous_weekly_active: number | null;
  weekly_change_percent: number | null;
  history_total_users: number | null;
  history_start_date: string | null;
  time_zone: string | null;
  quality: { subject_to_thresholding: boolean; sampled: boolean; data_loss: boolean };
  message: string | null;
};

type Dependencies = { credentials?: string; fetch?: typeof fetch; now?: () => number };
type Credentials = { client_id: string; client_secret: string; refresh_token: string };
type ParsedReport = { counts: Map<string, number>; timeZone: string | null; quality: AnalyticsSnapshot['quality'] };

const PROPERTY = '547084285';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PROPERTY_URL = `https://analyticsadmin.googleapis.com/v1beta/properties/${PROPERTY}`;
const REPORT_URL = `https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY}:runReport`;
const REALTIME_URL = `https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY}:runRealtimeReport`;
const MAX_BODY_BYTES = 65_536;
const TIMEOUT_MS = 5000;

function unavailable(): Error { return new Error('Analytics unavailable'); }
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function empty(state: AnalyticsSnapshot['state'], message: string): AnalyticsSnapshot {
  return { property_id: PROPERTY, source: 'ga4_store_listing', state, fetched_at: null,
    online_30m: null, weekly_active: null, previous_weekly_active: null, weekly_change_percent: null,
    history_total_users: null, history_start_date: null, time_zone: null,
    quality: { subject_to_thresholding: false, sampled: false, data_loss: false }, message };
}
function credentials(value: string): Credentials {
  if (value.length > 16_384) throw unavailable();
  const source = record(JSON.parse(value));
  const text = (name: string) => {
    const item = source?.[name];
    if (typeof item !== 'string' || item.length < 1 || item.length > 8192 || /[\u0000-\u0020\u007f]/.test(item)) throw unavailable();
    return item;
  };
  return { client_id: text('client_id'), client_secret: text('client_secret'), refresh_token: text('refresh_token') };
}

/** Count actual bytes; neither missing nor misleading Content-Length can bypass the cap. */
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw unavailable();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (signal.aborted) throw unavailable();
    while (true) {
      const chunk = await reader.read();
      if (signal.aborted) throw unavailable();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) { cancel(); throw unavailable(); }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

async function requestJson(fetcher: typeof fetch, url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, TIMEOUT_MS);
  });
  const operation = async () => {
    // Workers does not support redirect:error. Never follow a redirect with credentials.
    const response = await fetcher(url, { ...init, redirect: 'manual', signal: controller.signal });
    if (!response.ok || controller.signal.aborted) {
      void response.body?.cancel().catch(() => {});
      throw unavailable();
    }
    return boundedJson(response, controller.signal);
  };
  try { return await Promise.race([operation(), deadline]); }
  finally { clearTimeout(timer); }
}

function timeZone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 100) return null;
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); return value; }
  catch { return null; }
}
function quality(metadata: Record<string, unknown>): AnalyticsSnapshot['quality'] {
  return { subject_to_thresholding: metadata.subjectToThresholding === true,
    sampled: Array.isArray(metadata.samplingMetadatas) && metadata.samplingMetadatas.length > 0,
    data_loss: metadata.dataLossFromOtherRow === true || (Array.isArray(metadata.dataTruncationReasons) && metadata.dataTruncationReasons.length > 0) };
}
function mergeQuality(...reports: ParsedReport[]): AnalyticsSnapshot['quality'] {
  return { subject_to_thresholding: reports.some((report) => report.quality.subject_to_thresholding),
    sampled: reports.some((report) => report.quality.sampled), data_loss: reports.some((report) => report.quality.data_loss) };
}
function parseReport(value: unknown, metric: string, ranges?: readonly string[]): ParsedReport {
  const source = record(value);
  const metrics = source?.metricHeaders;
  if (!source || !Array.isArray(metrics) || metrics.length !== 1
    || record(metrics[0])?.name !== metric || record(metrics[0])?.type !== 'TYPE_INTEGER') throw unavailable();
  const dimensions = source.dimensionHeaders ?? [];
  if (!Array.isArray(dimensions) || (ranges ? dimensions.length !== 1 || record(dimensions[0])?.name !== 'dateRange' : dimensions.length !== 0)) throw unavailable();
  const metadata = source.metadata === undefined ? {} : record(source.metadata);
  if (!metadata || (typeof metadata.emptyReason === 'string' && metadata.emptyReason.length > 0)) throw unavailable();
  const rows = source.rows ?? [];
  if (!Array.isArray(rows) || rows.length > (ranges?.length ?? 1)
    || (source.rowCount !== undefined && source.rowCount !== rows.length)) throw unavailable();
  const counts = new Map<string, number>();
  for (const item of rows) {
    const row = record(item);
    const values = row?.metricValues;
    const text = Array.isArray(values) && values.length === 1 ? record(values[0])?.value : undefined;
    if (typeof text !== 'string' || !/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw unavailable();
    const dimensionValues = row?.dimensionValues ?? [];
    if (!Array.isArray(dimensionValues) || dimensionValues.length !== (ranges ? 1 : 0)) throw unavailable();
    const range = ranges ? record(dimensionValues[0])?.value : 'total';
    if (typeof range !== 'string' || (ranges && !ranges.includes(range)) || counts.has(range)) throw unavailable();
    counts.set(range, Number(text));
  }
  return { counts, timeZone: timeZone(metadata.timeZone), quality: quality(metadata) };
}

function creationDate(value: unknown, now: number): { startDate: string; timeZone: string } | null {
  const source = record(value);
  const created = source?.createTime;
  const zone = timeZone(source?.timeZone);
  if (source?.name !== `properties/${PROPERTY}` || !zone || typeof created !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(created)) return null;
  const timestamp = Date.parse(created);
  if (!Number.isFinite(timestamp) || timestamp > now || new Date(timestamp).toISOString().slice(0, 19) !== created.slice(0, 19)) return null;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(timestamp);
  const part = (name: string) => parts.find((item) => item.type === name)?.value;
  const startDate = `${part('year')}-${part('month')}-${part('day')}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(startDate) ? { startDate, timeZone: zone } : null;
}

/** Read existing Chrome Web Store listing analytics; this function never sends tracking events. */
export async function getAnalyticsSnapshot(dependencies: Dependencies = {}): Promise<AnalyticsSnapshot> {
  if (!dependencies.credentials?.trim()) return empty('not_configured', 'Connect Google Analytics to see store listing activity.');
  try {
    const configuration = credentials(dependencies.credentials);
    const fetcher = dependencies.fetch ?? fetch;
    const now = (dependencies.now ?? Date.now)();
    const token = record(await requestJson(fetcher, TOKEN_URL, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'refresh_token', ...configuration }).toString() }));
    const accessToken = token?.access_token;
    if (typeof accessToken !== 'string' || accessToken.length < 1 || accessToken.length > 8192
      || /[\u0000-\u0020\u007f]/.test(accessToken) || token?.token_type !== 'Bearer') throw unavailable();
    const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Content-Type': 'application/json' };
    const post = (url: string, body: object) => requestJson(fetcher, url, { method: 'POST', headers, body: JSON.stringify(body) });
    // Request-local I/O only: Access-protected callers can cache normalized aggregates separately.
    const [realtimeResponse, weeklyResponse, propertyResponse] = await Promise.allSettled([
      post(REALTIME_URL, { metrics: [{ name: 'activeUsers' }], minuteRanges: [{ name: 'last_30_minutes', startMinutesAgo: 29, endMinutesAgo: 0 }], returnPropertyQuota: true }),
      post(REPORT_URL, { metrics: [{ name: 'activeUsers' }], dateRanges: [
        { startDate: '7daysAgo', endDate: 'yesterday', name: 'current_week' },
        { startDate: '14daysAgo', endDate: '8daysAgo', name: 'previous_week' }
      ], returnPropertyQuota: true }),
      requestJson(fetcher, PROPERTY_URL, { method: 'GET', headers })
    ]);
    if (realtimeResponse.status !== 'fulfilled' || weeklyResponse.status !== 'fulfilled') throw unavailable();
    const realtime = parseReport(realtimeResponse.value, 'activeUsers');
    const weekly = parseReport(weeklyResponse.value, 'activeUsers', ['current_week', 'previous_week']);
    const current = weekly.counts.get('current_week') ?? 0;
    const previous = weekly.counts.get('previous_week') ?? 0;
    const snapshot: AnalyticsSnapshot = { property_id: PROPERTY, source: 'ga4_store_listing', state: 'ready', fetched_at: now,
      online_30m: realtime.counts.get('total') ?? 0, weekly_active: current, previous_weekly_active: previous,
      weekly_change_percent: previous > 0 ? (current - previous) / previous * 100 : null,
      history_total_users: null, history_start_date: null, time_zone: weekly.timeZone,
      quality: mergeQuality(realtime, weekly), message: null };
    const property = propertyResponse.status === 'fulfilled' ? creationDate(propertyResponse.value, now) : null;
    if (!property) {
      snapshot.message = 'Historical users are unavailable because the property creation date could not be read.';
      return snapshot;
    }
    snapshot.history_start_date = property.startDate;
    snapshot.time_zone ??= property.timeZone;
    try {
      const history = parseReport(await post(REPORT_URL, { metrics: [{ name: 'totalUsers' }], dateRanges: [{ startDate: property.startDate, endDate: 'today' }], returnPropertyQuota: true }), 'totalUsers');
      snapshot.history_total_users = history.counts.get('total') ?? 0;
      snapshot.quality = mergeQuality(realtime, weekly, history);
    } catch {
      snapshot.message = 'Historical users are temporarily unavailable; recent store listing activity is still shown.';
    }
    return snapshot;
  } catch {
    // Provider errors can contain credentials and identifiers; expose only this fixed explanation.
    return empty('unavailable', 'Google Analytics is unavailable. Check the read-only connection and try again.');
  }
}
