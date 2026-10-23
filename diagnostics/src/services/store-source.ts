import { compare, validateStrict } from 'compare-versions';

export type StoreReview = {
  id: string; author: string; rating: number; body: string;
  created_at: number; updated_at: number; version: string | null; language: string | null;
};
export type StoreSnapshot = {
  extension_id: string; store_url: string; version: string; users: number;
  rating_average: number; rating_count: number; written_review_count: number;
  reviews: StoreReview[]; fetched_at: number; reviews_complete: boolean;
  latest_release_version: string | null; latest_release_url: string | null;
  version_status: 'up_to_date' | 'store_behind' | 'store_ahead' | 'unknown';
};
type Dependencies = { fetch?: typeof fetch; now?: () => number; timeoutMs?: number };
type VersionComparison = Pick<StoreSnapshot, 'latest_release_version' | 'latest_release_url' | 'version_status'>;

const EXTENSION_ID = 'chfghiknjhpcncpcjopglefnckckdlpj';
const STORE_URL = `https://chromewebstore.google.com/detail/nexusmods-bypass/${EXTENSION_ID}`;
const RPC_URL = 'https://chromewebstore.google.com/_/ChromeWebStoreConsumerFeUi/data/batchexecute';
const RELEASE_API = 'https://api.github.com/repos/thomasthanos/nexusmods-bypass/releases/latest';
const RELEASE_PREFIX = 'https://github.com/thomasthanos/nexusmods-bypass/releases/tag/';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 5;
const PAGE_SIZE = 100;
const MAX_TIME = 253_402_300_799_999;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNKNOWN_VERSION: VersionComparison = { latest_release_version: null, latest_release_url: null, version_status: 'unknown' };

function unavailable(): Error { return new Error('Chrome Web Store unavailable'); }
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw unavailable();
  return value;
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) throw unavailable();
  return Number(value);
}
function plainText(value: unknown, limit: number): string {
  if (typeof value !== 'string') throw unavailable();
  const text = Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim()).slice(0, limit).join('');
  if (!text) throw unavailable();
  return text;
}
function version(value: unknown): string {
  // Chrome manifest versions contain one to four components, each at most 65535.
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){0,3}$/.test(value)
    || value.split('.').some((part) => Number(part) > 65535)) throw unavailable();
  return value;
}
function timestamp(value: unknown): number {
  const parts = array(value);
  if (parts.length !== 2) throw unavailable();
  return integer(parts[0], 253_402_300_799) * 1000 + Math.floor(integer(parts[1], 999_999_999) / 1_000_000);
}
function review(value: unknown, now: number): StoreReview {
  const row = array(value);
  if (row.length < 15 || typeof row[0] !== 'string' || !UUID.test(row[0]) || row[14] !== EXTENSION_ID) throw unavailable();
  const rating = integer(row[2], 5);
  if (rating < 1) throw unavailable();
  const created = timestamp(row[4]); const updated = timestamp(row[5]);
  // One real review has updated nanoseconds 18ms before created nanoseconds in
  // the same second. Preserve both observed times while rejecting older seconds.
  if (Math.floor(updated / 1000) < Math.floor(created / 1000) || updated > Math.min(MAX_TIME, now + 300_000)) throw unavailable();
  const language = row[13] === null || row[13] === undefined ? null : row[13];
  if (language !== null && (typeof language !== 'string' || language.length > 35
    || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(language))) throw unavailable();
  return { id: row[0], author: plainText(array(row[1])[0], 200), rating, body: plainText(row[3], 4096),
    created_at: created, updated_at: updated,
    version: row[11] === null || row[11] === undefined ? null : version(row[11]), language };
}

/** The cap counts streamed bytes; Content-Length alone is never trusted. */
async function boundedText(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw unavailable();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      if (signal.aborted) throw unavailable();
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
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

/** A separate deadline also handles a provider or test fetch that ignores abort. */
async function bounded<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, timeoutMs);
  });
  try { return await Promise.race([operation(controller.signal), deadline]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

async function rpc(fetcher: typeof fetch, name: 'xY2Ddd' | 'x1DgCd', payload: unknown[], signal: AbortSignal): Promise<unknown[]> {
  // These are the public listing's observed read RPCs, not a supported Google API.
  // https://developer.chrome.com/docs/webstore/api/reference/rest documents the
  // publishing API; it exposes no public reviews or rating metrics endpoint.
  // SOCS=CAI is a fixed, stateless consent preference that avoids the regional
  // consent interstitial. It is never read from a user's browser or account.
  const body = new URLSearchParams({ 'f.req': JSON.stringify([[[name, JSON.stringify(payload), null, 'generic']]]) });
  const response = await fetcher(`${RPC_URL}?rpcids=${name}&hl=en`, {
    method: 'POST', redirect: 'manual', signal,
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', cookie: 'SOCS=CAI' }, body: body.toString()
  });
  // Workers support manual and follow redirect modes. A manual
  // 3xx is rejected here and can never carry the stateless cookie to another host.
  if (!response.ok) { void response.body?.cancel().catch(() => {}); throw unavailable(); }
  const text = await boundedText(response, signal);
  if (!text.startsWith(")]}'\n") && !text.startsWith(")]}'\r\n")) throw unavailable();
  const envelope = array(JSON.parse(text.slice(4).trim()) as unknown);
  if (envelope.length > 64) throw unavailable();
  const rows = envelope.filter((entry) => Array.isArray(entry) && entry[0] === 'wrb.fr');
  if (rows.length !== 1) throw unavailable();
  const row = array(rows[0]);
  if (row[1] !== name || typeof row[2] !== 'string') throw unavailable();
  return array(JSON.parse(row[2]) as unknown);
}

async function storeSnapshot(fetcher: typeof fetch, now: number, signal: AbortSignal): Promise<Omit<StoreSnapshot, keyof VersionComparison>> {
  const detail = await rpc(fetcher, 'xY2Ddd', [EXTENSION_ID], signal);
  const card = array(detail[0]);
  if (card[0] !== EXTENSION_ID || typeof card[3] !== 'number' || !Number.isFinite(card[3]) || card[3] < 0 || card[3] > 5) throw unavailable();
  const count = integer(card[4]);
  if (count > 0 && card[3] < 1) throw unavailable();
  const storeVersion = version(detail[13]);
  const users = integer(card[14]);
  const reviews = new Map<string, StoreReview>();
  const tokens = new Set<string>();
  let token: string | null = null;
  let writtenCount: number | undefined;
  let consistentTotal = true;
  let complete = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    // 2 is the store UI's Recent sort. ['all'] is essential: the default is
    // English only and currently hides five reviews, including the newest one.
    const data = await rpc(fetcher, 'x1DgCd', [EXTENSION_ID, token === null ? [PAGE_SIZE] : [PAGE_SIZE, token],
      2, null, null, ['all'], 0], signal);
    const continuation = array(data[0]); const rows = array(data[1]);
    const total = integer(data[2]);
    if (data.length !== 3 || rows.length > PAGE_SIZE || continuation.length > 1) throw unavailable();
    if (writtenCount === undefined) writtenCount = total;
    else consistentTotal &&= writtenCount === total;
    for (const row of rows) {
      const item = review(row, now);
      const previous = reviews.get(item.id);
      if (previous && previous.created_at !== item.created_at) throw unavailable();
      if (!previous || item.updated_at >= previous.updated_at) reviews.set(item.id, item);
    }
    if (!continuation.length) { complete = consistentTotal && reviews.size === writtenCount; break; }
    const next = continuation[0];
    if (typeof next !== 'string' || next.length < 1 || next.length > 8192 || /[\u0000-\u001f\u007f]/.test(next)) throw unavailable();
    if (tokens.has(next)) break;
    tokens.add(next); token = next;
  }
  return { extension_id: EXTENSION_ID, store_url: STORE_URL, version: storeVersion, users,
    rating_average: card[3], rating_count: count, written_review_count: writtenCount ?? 0,
    reviews: [...reviews.values()].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id)),
    fetched_at: now, reviews_complete: complete };
}

async function latestRelease(fetcher: typeof fetch, storeVersion: string, timeoutMs: number): Promise<VersionComparison> {
  try {
    return await bounded(Math.min(3000, timeoutMs), async (signal) => {
      const response = await fetcher(RELEASE_API, { method: 'GET', redirect: 'manual', signal,
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'NexusMods-Diagnostics' } });
      if (!response.ok) { void response.body?.cancel().catch(() => {}); return { ...UNKNOWN_VERSION }; }
      const value: unknown = JSON.parse(await boundedText(response, signal));
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ...UNKNOWN_VERSION };
      const source = value as Record<string, unknown>;
      if (typeof source.tag_name !== 'string' || source.tag_name.length > 64 || typeof source.html_url !== 'string'
        || source.html_url !== `${RELEASE_PREFIX}${source.tag_name}` || source.draft === true || source.prerelease === true) return { ...UNKNOWN_VERSION };
      const normalized = source.tag_name.replace(/^v/, '');
      if (!validateStrict(normalized)) return { ...UNKNOWN_VERSION };
      return { latest_release_version: normalized, latest_release_url: source.html_url,
        version_status: compare(storeVersion, normalized, '=') ? 'up_to_date'
          : compare(storeVersion, normalized, '<') ? 'store_behind' : 'store_ahead' };
    });
  } catch { return { ...UNKNOWN_VERSION }; }
}

/** Only fixed public read endpoints; no diagnostics, cookies or credentials enter this source. */
export async function fetchStoreSnapshot(dependencies: Dependencies = {}): Promise<StoreSnapshot> {
  try {
    const fetcher = dependencies.fetch ?? fetch;
    const now = integer((dependencies.now ?? Date.now)(), MAX_TIME);
    const timeout = integer(dependencies.timeoutMs ?? 12_000, 30_000);
    if (timeout < 1) throw unavailable();
    const snapshot = await bounded(timeout, (signal) => storeSnapshot(fetcher, now, signal));
    return { ...snapshot, ...await latestRelease(fetcher, snapshot.version, timeout) };
  } catch { throw unavailable(); }
}
