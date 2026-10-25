import { getAnalyticsSnapshot, type AnalyticsSnapshot } from './analytics-source.ts';

type Cached = AnalyticsSnapshot & { stale: boolean };
type Options = { credentials?: string; now?: number; fetchSnapshot?: () => Promise<AnalyticsSnapshot> };
type CacheRow = { snapshot_json: string | null; checked_at: number };
const TTL = 60_000;
const LEASE = 30_000;

function read(row: CacheRow | null): AnalyticsSnapshot | null {
  if (!row?.snapshot_json) return null;
  try { return JSON.parse(row.snapshot_json) as AnalyticsSnapshot; } catch { return null; }
}
function result(snapshot: AnalyticsSnapshot, now: number): Cached {
  return { ...snapshot, stale: snapshot.fetched_at === null || now - snapshot.fetched_at >= TTL };
}

/** The database lease is shared across isolates; only aggregates are persisted. */
export async function cachedAnalytics(db: D1Database, options: Options = {}): Promise<Cached> {
  const now = options.now ?? Date.now();
  if (!options.credentials) return { ...await getAnalyticsSnapshot(), stale: false };
  await db.prepare('INSERT INTO analytics_cache (id) VALUES (1) ON CONFLICT(id) DO NOTHING').run();
  const row = await db.prepare('SELECT snapshot_json, checked_at FROM analytics_cache WHERE id = 1').first<CacheRow>();
  const previous = read(row);
  if (previous && row && now >= row.checked_at && now - row.checked_at < TTL) return result(previous, now);
  const token = crypto.randomUUID();
  const owned = await db.prepare(`UPDATE analytics_cache SET lease_token = ?, lease_expires_at = ?
    WHERE id = 1 AND (lease_expires_at IS NULL OR lease_expires_at <= ?) RETURNING id`)
    .bind(token, now + LEASE, now).first();
  if (!owned) {
    if (previous) return { ...result(previous, now), stale: true };
    return { ...await getAnalyticsSnapshot({ credentials: '{}' }), stale: true,
      message: 'Analytics refresh in progress. Try again shortly.' };
  }
  try {
    const latest = await (options.fetchSnapshot?.() ?? getAnalyticsSnapshot({ credentials: options.credentials, now: () => now }));
    const snapshot = latest.state !== 'ready' && previous?.state === 'ready'
      ? { ...previous, message: 'Analytics temporarily unavailable. Showing the last successful report.' } : latest;
    await db.prepare(`UPDATE analytics_cache SET snapshot_json = ?, checked_at = ?, lease_token = NULL, lease_expires_at = NULL
      WHERE id = 1 AND lease_token = ?`).bind(JSON.stringify(snapshot), now, token).run();
    return { ...result(snapshot, now), stale: latest.state !== 'ready' || result(snapshot, now).stale };
  } finally {
    // A timed-out owner never releases a newer owner's lease.
    await db.prepare('UPDATE analytics_cache SET lease_token = NULL, lease_expires_at = NULL WHERE id = 1 AND lease_token = ?').bind(token).run();
  }
}
