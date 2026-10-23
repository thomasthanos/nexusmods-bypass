import type { D1Database } from '@cloudflare/workers-types';
import { fetchStoreSnapshot } from './store-source.ts';
import type { StoreReview, StoreSnapshot } from './store-source.ts';
import { sendWebPush } from './delivery.ts';
import type { DeliveryResult, PushPayload, PushTarget } from './delivery.ts';

type Clock = number | (() => number);
export type StoreMetadata = Omit<StoreSnapshot, 'reviews'>;
export type StoreDashboard = {
  state: 'ready' | 'unavailable'; snapshot: StoreMetadata | null;
  reviews: (StoreReview & { is_new: boolean })[]; new_review_count: number;
  last_checked_at: number | null; sync_interval_seconds: number; stale: boolean; message: string | null;
};
export type StoreSyncOptions = { fetchSnapshot?: () => Promise<StoreSnapshot>; now?: Clock };
export type StoreSyncResult = { state: 'synced' | 'busy' | 'lost_lease' | 'failed'; reviews_added: number };
export type ReviewPushConfiguration = { vapid: { publicKey: string; privateKey: string; subject: string } }
  | { VAPID_PUBLIC_KEY: string; VAPID_PRIVATE_KEY: string; VAPID_SUBJECT: string };
export type ReviewPushOptions = { now?: Clock; send?: typeof sendWebPush };
export type ReviewPushSummary = { attempted: number; delivered: number; failed: number; expired: number; retryable: boolean };
type State = { snapshot_json: string | null; baseline_at: number | null; last_checked_at: number | null;
  last_success_at: number | null; last_error_at: number | null; lease_token: string | null; lease_expires_at: number | null };
type ReviewRow = StoreReview & { acknowledged_at: number | null };
type Target = PushTarget & { review_id: string; subscription_id: number; lease_token: string;
  attempts: number; created_at: number; author: string; body: string; rating: number };

const ID = 'chfghiknjhpcncpcjopglefnckckdlpj';
const STORE_URL = `https://chromewebstore.google.com/detail/nexusmods-bypass/${ID}`;
const RELEASE_PREFIX = 'https://github.com/thomasthanos/nexusmods-bypass/releases/tag/';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_TIME = 253_402_300_799_999;
const SYNC_INTERVAL = 900;
const LEASE_MS = 60_000;
// Twenty sends plus claims/completions/expired cleanup stay below 100 outbound
// subrequests. Unclaimed targets remain durable work for a later invocation.
const MAX_TARGETS = 20;
const DELIVERY_BUDGET_MS = 18_000;
// D1 limits one bound value to 2,000,000 bytes, below 2 MiB. Keep headroom
// before building the single JSON parameter used by the atomic review upsert.
const MAX_REVIEW_BATCH_BYTES = 1_900_000;
const FENCE = 'id=1 AND lease_token=? AND lease_expires_at>? AND (last_success_at IS NULL OR last_success_at<=?)';

function integer(value: unknown, maximum = MAX_TIME): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) throw new TypeError('Invalid store value');
  return Number(value);
}
function clock(value: Clock | undefined): () => number {
  return () => integer(typeof value === 'function' ? value() : value ?? Date.now());
}
function text(value: unknown, limit: number): string {
  if (typeof value !== 'string') throw new TypeError('Invalid store text');
  const result = Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim()).slice(0, limit).join('');
  if (!result) throw new TypeError('Invalid store text');
  return result;
}
function version(value: unknown): string {
  if (typeof value !== 'string' || value.length > 24 || !/^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){0,3}$/.test(value)
    || value.split('.').some((part) => Number(part) > 65535)) throw new TypeError('Invalid store version');
  return value;
}
function checkedSnapshot(value: StoreSnapshot, now: number): StoreSnapshot {
  if (!value || value.extension_id !== ID || value.store_url !== STORE_URL || typeof value.reviews_complete !== 'boolean'
    || !Array.isArray(value.reviews) || value.reviews.length > 500 || typeof value.rating_average !== 'number'
    || !Number.isFinite(value.rating_average) || value.rating_average < 0 || value.rating_average > 5) throw new TypeError('Invalid store snapshot');
  const fetched = integer(value.fetched_at);
  if (fetched > now + 300_000) throw new TypeError('Invalid store time');
  const seen = new Set<string>();
  const reviews = value.reviews.map((review) => {
    if (!review || typeof review.id !== 'string' || !UUID.test(review.id) || seen.has(review.id)) throw new TypeError('Invalid store review');
    seen.add(review.id);
    const created = integer(review.created_at); const updated = integer(review.updated_at);
    const rating = integer(review.rating, 5);
    if (rating < 1 || created > now + 300_000 || updated > now + 300_000) throw new TypeError('Invalid store review');
    if (review.language !== null && (typeof review.language !== 'string' || review.language.length > 35
      || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(review.language))) throw new TypeError('Invalid store language');
    return { id: review.id, author: text(review.author, 200), rating, body: text(review.body, 4096), created_at: created,
      // The upstream's nanosecond timestamp can be slightly backwards within a
      // second. Keep the persistent row monotonic without changing its identity.
      updated_at: Math.max(created, updated), version: review.version === null ? null : version(review.version), language: review.language };
  });
  const latestVersion = value.latest_release_version;
  const latestUrl = value.latest_release_url;
  if ((latestVersion === null) !== (latestUrl === null) || latestVersion !== null && (typeof latestVersion !== 'string'
    || latestVersion.length > 64 || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(latestVersion)
    || typeof latestUrl !== 'string' || !latestUrl.startsWith(RELEASE_PREFIX)
    || !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/.test(latestUrl.slice(RELEASE_PREFIX.length)))
    || !['up_to_date', 'store_behind', 'store_ahead', 'unknown'].includes(value.version_status)) throw new TypeError('Invalid store release');
  const result: StoreSnapshot = { extension_id: ID, store_url: STORE_URL, version: version(value.version),
    users: integer(value.users, Number.MAX_SAFE_INTEGER), rating_average: value.rating_average,
    rating_count: integer(value.rating_count, Number.MAX_SAFE_INTEGER), written_review_count: integer(value.written_review_count, Number.MAX_SAFE_INTEGER),
    reviews, fetched_at: fetched, reviews_complete: value.reviews_complete,
    latest_release_version: latestVersion, latest_release_url: latestUrl, version_status: value.version_status };
  if (new TextEncoder().encode(JSON.stringify(reviews)).byteLength > MAX_REVIEW_BATCH_BYTES) throw new TypeError('Store review batch too large');
  return result;
}

/** One owned lease fences every statement of the snapshot/review transaction. */
export async function syncStore(db: D1Database, options: StoreSyncOptions = {}): Promise<StoreSyncResult> {
  const now = clock(options.now); const started = now(); const token = crypto.randomUUID();
  await db.prepare('INSERT INTO store_monitor_state(id) VALUES(1) ON CONFLICT(id) DO NOTHING').run();
  const acquired = await db.prepare(`UPDATE store_monitor_state SET lease_token=?,lease_expires_at=?
    WHERE id=1 AND (lease_expires_at IS NULL OR lease_expires_at<=?) RETURNING id`)
    .bind(token, started + LEASE_MS, started).first();
  if (!acquired) return { state: 'busy', reviews_added: 0 };
  try {
    const value = await (options.fetchSnapshot ?? fetchStoreSnapshot)();
    const finished = Math.max(started, now());
    const snapshot = checkedSnapshot(value, finished);
    const { reviews, ...metadata } = snapshot;
    const guard = [token, finished, snapshot.fetched_at];
    const results = await db.batch([
      db.prepare(`INSERT INTO store_reviews(id,author,rating,body,created_at,updated_at,version,language,first_seen_at,last_seen_at,acknowledged_at,first_seen_run_token)
        SELECT json_extract(value,'$.id'),json_extract(value,'$.author'),json_extract(value,'$.rating'),json_extract(value,'$.body'),
          json_extract(value,'$.created_at'),json_extract(value,'$.updated_at'),json_extract(value,'$.version'),json_extract(value,'$.language'),?,?,
          CASE WHEN (SELECT baseline_at FROM store_monitor_state WHERE id=1) IS NULL THEN ? ELSE NULL END,?
        FROM json_each(?) WHERE EXISTS(SELECT 1 FROM store_monitor_state WHERE ${FENCE})
        ON CONFLICT(id) DO UPDATE SET
          author=CASE WHEN excluded.updated_at>=store_reviews.updated_at THEN excluded.author ELSE store_reviews.author END,
          rating=CASE WHEN excluded.updated_at>=store_reviews.updated_at THEN excluded.rating ELSE store_reviews.rating END,
          body=CASE WHEN excluded.updated_at>=store_reviews.updated_at THEN excluded.body ELSE store_reviews.body END,
          version=CASE WHEN excluded.updated_at>=store_reviews.updated_at THEN excluded.version ELSE store_reviews.version END,
          language=CASE WHEN excluded.updated_at>=store_reviews.updated_at THEN excluded.language ELSE store_reviews.language END,
          updated_at=max(store_reviews.updated_at,excluded.updated_at),last_seen_at=max(store_reviews.last_seen_at,excluded.last_seen_at)`)
        .bind(finished, finished, finished, token, JSON.stringify(reviews), ...guard),
      db.prepare(`INSERT INTO store_review_deliveries(review_id,subscription_id,endpoint,p256dh,auth,expiration_time,created_at,next_attempt_at)
        SELECT r.id,s.id,s.endpoint,s.p256dh,s.auth,s.expiration_time,?,? FROM store_reviews r CROSS JOIN push_subscriptions s
        WHERE r.first_seen_run_token=? AND (s.expiration_time IS NULL OR s.expiration_time>?)
          AND EXISTS(SELECT 1 FROM store_monitor_state WHERE ${FENCE} AND baseline_at IS NOT NULL)
        ON CONFLICT(review_id,subscription_id) DO NOTHING`).bind(finished, finished, token, finished, ...guard),
      db.prepare('SELECT COUNT(*) AS count FROM store_reviews WHERE first_seen_run_token=?').bind(token),
      db.prepare(`UPDATE store_monitor_state SET snapshot_json=?,baseline_at=CASE WHEN ? THEN coalesce(baseline_at,?) ELSE baseline_at END,
        last_checked_at=?,last_success_at=?,last_error_at=NULL,lease_token=NULL,lease_expires_at=NULL
        WHERE ${FENCE} RETURNING id`).bind(JSON.stringify(metadata), snapshot.reviews_complete ? 1 : 0, finished,
        finished, snapshot.fetched_at, ...guard)
    ]);
    if (!results[3]?.results.length) {
      await db.prepare('UPDATE store_monitor_state SET lease_token=NULL,lease_expires_at=NULL WHERE id=1 AND lease_token=?').bind(token).run();
      return { state: 'lost_lease', reviews_added: 0 };
    }
    const row = results[2]?.results[0] as { count?: number } | undefined;
    return { state: 'synced', reviews_added: row?.count ?? 0 };
  } catch {
    // Never replace the last good metadata or clear a successor's lease on error.
    try {
      const failed = Math.max(started, now());
      await db.prepare(`UPDATE store_monitor_state SET last_checked_at=?,last_error_at=?,lease_token=NULL,lease_expires_at=NULL
        WHERE id=1 AND lease_token=? AND lease_expires_at>?`).bind(failed, failed, token, failed).run();
    } catch { /* Database availability must not turn provider details into logs. */ }
    return { state: 'failed', reviews_added: 0 };
  }
}

export async function getStoreDashboard(db: D1Database, now = Date.now()): Promise<StoreDashboard> {
  integer(now);
  const [state, rows, counts] = await Promise.all([
    db.prepare('SELECT * FROM store_monitor_state WHERE id=1').first<State>(),
    db.prepare('SELECT id,author,rating,body,created_at,updated_at,version,language,acknowledged_at FROM store_reviews ORDER BY created_at DESC,id LIMIT 100').all<ReviewRow>(),
    db.prepare('SELECT COUNT(*) AS count FROM store_reviews WHERE acknowledged_at IS NULL').first<{ count: number }>()
  ]);
  let snapshot: StoreMetadata | null = null;
  try {
    if (state?.snapshot_json && new TextEncoder().encode(state.snapshot_json).byteLength <= 8192) {
      const value = JSON.parse(state.snapshot_json) as StoreMetadata;
      const { reviews: _reviews, ...metadata } = checkedSnapshot({ ...value, reviews: [] }, Math.max(now, value.fetched_at));
      snapshot = metadata;
    }
  } catch { /* Corrupt stored metadata is unavailable, never unvalidated output. */ }
  const stale = !snapshot || snapshot.reviews_complete === false || state?.last_error_at !== null && state?.last_error_at !== undefined
    || now - snapshot.fetched_at > SYNC_INTERVAL * 2000;
  return { state: snapshot ? 'ready' : 'unavailable', snapshot,
    reviews: rows.results.map(({ acknowledged_at, ...row }) => ({ ...row, is_new: acknowledged_at === null })),
    new_review_count: counts?.count ?? 0, last_checked_at: state?.last_checked_at ?? null,
    sync_interval_seconds: SYNC_INTERVAL, stale,
    message: !snapshot ? 'Store data has not been fetched yet.' : snapshot.reviews_complete === false
      ? 'The latest store review check is incomplete.' : stale ? 'Showing saved store data while the latest check is unavailable.' : null };
}

/** Explicit user action only; dashboard reads and notification clicks never call this. */
export async function acknowledgeReviews(db: D1Database, ids: string[], now = Date.now()): Promise<{ acknowledged: number }> {
  integer(now);
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || ids.some((id) => typeof id !== 'string' || !UUID.test(id))) throw new TypeError('Invalid review IDs');
  const result = await db.prepare(`UPDATE store_reviews SET acknowledged_at=?
    WHERE acknowledged_at IS NULL AND id IN(SELECT value FROM json_each(?))`).bind(now, JSON.stringify([...new Set(ids)])).run();
  return { acknowledged: result.meta.changes };
}

function origin(value: string): string {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f\\]/.test(value)) throw new TypeError('Invalid dashboard origin');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port) throw new TypeError('Invalid dashboard origin');
  return url.origin;
}
function failure(): DeliveryResult {
  return { ok: false, status: null, retryable: true, expired: false, retry_after_ms: null, reason: 'network_error' };
}

/** Durable per-device work; successful targets remain terminal across cron retries. */
export async function dispatchReviewPush(db: D1Database, configuration: ReviewPushConfiguration,
  dashboardOrigin: string, options: ReviewPushOptions = {}): Promise<ReviewPushSummary> {
  const dashboard = origin(dashboardOrigin); const now = clock(options.now); const started = now();
  const vapid = 'vapid' in configuration ? configuration.vapid : {
    publicKey: configuration.VAPID_PUBLIC_KEY, privateKey: configuration.VAPID_PRIVATE_KEY, subject: configuration.VAPID_SUBJECT
  };
  if (!vapid || [vapid.publicKey, vapid.privateKey, vapid.subject].some((value) => typeof value !== 'string' || !value)) throw new TypeError('Invalid push configuration');
  const token = crypto.randomUUID();
  const claimed = await db.prepare(`UPDATE store_review_deliveries SET lease_token=?,lease_expires_at=?,attempts=attempts+1
    WHERE (review_id,subscription_id) IN(SELECT review_id,subscription_id FROM store_review_deliveries
      WHERE delivered_at IS NULL AND abandoned_at IS NULL AND attempts<100 AND next_attempt_at<=?
        AND (lease_expires_at IS NULL OR lease_expires_at<=?) ORDER BY created_at,review_id,subscription_id LIMIT ?)
    RETURNING *,(SELECT author FROM store_reviews WHERE id=review_id) AS author,
      (SELECT body FROM store_reviews WHERE id=review_id) AS body,(SELECT rating FROM store_reviews WHERE id=review_id) AS rating`)
    .bind(token, started + LEASE_MS, started, started, MAX_TARGETS).all<Target>();
  const summary: ReviewPushSummary = { attempted: 0, delivered: 0, failed: 0, expired: 0, retryable: false };
  if (!claimed.results.length) return summary;
  const badge = await db.prepare(`SELECT (SELECT COUNT(*) FROM store_reviews WHERE acknowledged_at IS NULL)
    +(SELECT COUNT(*) FROM issues WHERE status IN('new','investigating','regressed') AND muted=0) AS count`).first<{ count: number }>();
  const deadline = performance.now() + DELIVERY_BUDGET_MS; let next = 0;
  async function deliver(target: Target): Promise<void> {
    summary.attempted++;
    const payload: PushPayload = { title: `New store review · ${target.rating}/5`,
      body: text(`${target.author}: ${target.body}`, 240), tag: `store-review:${target.review_id}`,
      data: { url: `${dashboard}/?review=${target.review_id}`, issue_id: null, fingerprint: null, trigger: 'NEW_REVIEW', review_id: target.review_id },
      badge_count: Math.min(9999, badge?.count ?? 0) };
    let result: DeliveryResult;
    try { result = await (options.send ?? sendWebPush)(target, payload, vapid, { now: started, timeoutMs: 4000 }); }
    catch { result = failure(); }
    const finished = Math.max(started, now());
    if (result.ok) {
      summary.delivered++;
      await db.prepare(`UPDATE store_review_deliveries SET delivered_at=?,lease_token=NULL,lease_expires_at=NULL
        WHERE review_id=? AND subscription_id=? AND lease_token=? AND delivered_at IS NULL AND abandoned_at IS NULL`)
        .bind(finished, target.review_id, target.subscription_id, token).run();
      return;
    }
    summary.failed++;
    if (result.expired) {
      summary.expired++;
      // Keys may have rotated while an old target was being delivered.
      await db.prepare(`DELETE FROM push_subscriptions WHERE id=? AND endpoint=? AND p256dh=? AND auth=?
        AND EXISTS(SELECT 1 FROM store_review_deliveries WHERE review_id=? AND subscription_id=?
          AND lease_token=? AND delivered_at IS NULL AND abandoned_at IS NULL)`)
        .bind(target.subscription_id, target.endpoint, target.p256dh, target.auth, target.review_id, target.subscription_id, token).run();
    }
    const retry = !result.expired && result.retryable && target.attempts < 100;
    summary.retryable ||= retry;
    const backoff = Math.min(86_400_000, Math.max(60_000 * 2 ** Math.min(16, target.attempts - 1),
      Number.isFinite(result.retry_after_ms) ? result.retry_after_ms ?? 0 : 0));
    await db.prepare(`UPDATE store_review_deliveries SET next_attempt_at=?,abandoned_at=?,lease_token=NULL,lease_expires_at=NULL
      WHERE review_id=? AND subscription_id=? AND lease_token=? AND delivered_at IS NULL AND abandoned_at IS NULL`)
      .bind(Math.min(MAX_TIME, finished + backoff), retry ? null : finished, target.review_id, target.subscription_id, token).run();
  }
  const results = await Promise.allSettled(Array.from({ length: Math.min(4, claimed.results.length) }, async () => {
    while (next < claimed.results.length && performance.now() < deadline) {
      const target = claimed.results[next++];
      if (target) await deliver(target);
    }
  }));
  summary.retryable ||= results.some((result) => result.status === 'rejected') || summary.attempted < claimed.results.length;
  // Release only unattempted work. An accepted push whose D1 completion failed
  // keeps its lease until expiry, reducing immediate duplicates on DB outages.
  const unattempted = claimed.results.slice(next).map((target) => [target.review_id, target.subscription_id]);
  if (unattempted.length) await db.prepare(`UPDATE store_review_deliveries SET lease_token=NULL,lease_expires_at=NULL
    WHERE lease_token=? AND EXISTS(SELECT 1 FROM json_each(?) pair
      WHERE json_extract(pair.value,'$[0]')=review_id AND json_extract(pair.value,'$[1]')=subscription_id)`)
    .bind(token, JSON.stringify(unattempted)).run();
  return summary;
}
