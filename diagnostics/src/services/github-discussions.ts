import { XMLParser, XMLValidator } from 'fast-xml-parser';

export type GithubDiscussion = { number: number; title: string; url: string; updated_at: string };
export type GithubDiscussionsFeed = {
  items: GithubDiscussion[]; total: number; repository_url: string; fetched_at: string; stale: boolean;
};
type Dependencies = {
  fetch?: typeof fetch; cache?: Pick<Cache, 'match' | 'put'> | null; now?: () => number; timeoutMs?: number;
};

const REPOSITORY_URL = 'https://github.com/thomasthanos/nexusmods-bypass/discussions';
const ATOM_URL = `${REPOSITORY_URL}.atom`;
const ATOM_NAMESPACE = 'http://www.w3.org/2005/Atom';
const CACHE_KEY = `${ATOM_URL}?diagnostics-public-feed=v1`;
const FRESH_MS = 5 * 60_000;
const RETAIN_MS = 24 * 60 * 60_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 100;
const TIMEOUT_MS = 5000;

function unavailable(): Error { return new Error('GitHub discussions unavailable'); }
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function title(value: unknown): string {
  const source = record(value);
  const plain = source && Object.keys(source).every((key) => key === '#text' || key.startsWith('@_')) ? source['#text'] : value;
  if (typeof plain !== 'string') return '';
  return Array.from(plain.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ').trim()).slice(0, 512).join('');
}
function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  // Date.parse normalizes impossible days. Validate the local calendar first,
  // then accept Atom's RFC3339 timezone offsets and return a canonical UTC date.
  const local = Date.parse(`${value.slice(0, 19)}Z`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(local) || !Number.isFinite(parsed) || new Date(local).toISOString().slice(0, 19) !== value.slice(0, 19)) return null;
  return new Date(parsed).toISOString();
}
function discussion(value: unknown): GithubDiscussion | null {
  const source = record(value);
  if (!source || typeof source.url !== 'string' || !source.url.startsWith(`${REPOSITORY_URL}/`)) return null;
  const id = source.url.slice(REPOSITORY_URL.length + 1);
  if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id))) return null;
  const normalizedTitle = title(source.title);
  const updated = timestamp(source.updated_at);
  if (!normalizedTitle || !updated) return null;
  return { number: Number(id), title: normalizedTitle, url: `${REPOSITORY_URL}/${id}`, updated_at: updated };
}

/** Parse only Atom metadata; never interpret HTML or resolve external resources. */
export function parseDiscussionAtom(xml: string): GithubDiscussion[] {
  try {
    // DTDs and custom entities are unnecessary for Atom. Reject them before
    // either validator or parser can process declarations or entity expansion.
    if (new TextEncoder().encode(xml).byteLength > MAX_BODY_BYTES || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)
      || XMLValidator.validate(xml) !== true) throw unavailable();
    const parser = new XMLParser({
      ignoreAttributes: false, ignoreDeclaration: true, ignorePiTags: true,
      parseTagValue: false, parseAttributeValue: false, trimValues: false,
      // This option also enables XML numeric character references in v5.11.
      // It decodes characters only; titles are always returned as plain text.
      htmlEntities: true, maxNestedTags: 20, strictReservedNames: true,
      processEntities: { enabled: true, maxEntitySize: 1024, maxExpansionDepth: 2,
        maxTotalExpansions: 10_000, maxExpandedLength: MAX_BODY_BYTES, maxEntityCount: 16 },
      onDangerousProperty() { throw unavailable(); }
    });
    const parsed: unknown = parser.parse(xml);
    const document = record(parsed);
    const roots = document ? Object.keys(document) : [];
    if (!document || roots.length !== 1) throw unavailable();
    const rootName = roots[0] ?? '';
    if (!/^(?:[A-Za-z_][A-Za-z0-9_.-]*:)?feed$/.test(rootName)) throw unavailable();
    const prefix = rootName.slice(0, -4);
    const feed = record(document[rootName]);
    const namespaceKey = prefix ? `@_xmlns:${prefix.slice(0, -1)}` : '@_xmlns';
    if (!feed || feed[namespaceKey] !== ATOM_NAMESPACE) throw unavailable();
    const raw = feed[`${prefix}entry`];
    const entries: unknown[] = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    if (entries.length > MAX_ENTRIES) throw unavailable();
    const items = new Map<number, GithubDiscussion>();
    for (const entry of entries) {
      const source = record(entry);
      if (!source || (source[namespaceKey] !== undefined && source[namespaceKey] !== ATOM_NAMESPACE)) continue;
      const rawLinks = source[`${prefix}link`];
      const links: unknown[] = Array.isArray(rawLinks) ? rawLinks : [rawLinks];
      const link = links.map(record).find((candidate) => candidate && (candidate['@_rel'] === undefined || candidate['@_rel'] === 'alternate'));
      const normalized = discussion({ title: source[`${prefix}title`], url: link?.['@_href'], updated_at: source[`${prefix}updated`] });
      if (normalized && (!items.has(normalized.number) || (items.get(normalized.number)?.updated_at ?? '') < normalized.updated_at)) {
        items.set(normalized.number, normalized);
      }
    }
    return [...items.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.number - a.number);
  } catch { throw unavailable(); }
}

/** Stream and count bytes even when Content-Length is missing or incorrect. */
async function boundedText(response: Response, signal?: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw unavailable();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (signal?.aborted) throw unavailable();
    while (true) {
      const chunk = await reader.read();
      if (signal?.aborted) throw unavailable();
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
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

async function cachedFeed(cache: Dependencies['cache'], now: number): Promise<GithubDiscussionsFeed | null> {
  if (!cache) return null;
  try {
    const response = await cache.match(CACHE_KEY);
    if (!response?.ok) return null;
    const parsed: unknown = JSON.parse(await boundedText(response));
    const source = record(parsed);
    if (!source || source.repository_url !== REPOSITORY_URL || source.stale !== false || !Array.isArray(source.items)
      || source.items.length > MAX_ENTRIES || source.total !== source.items.length) return null;
    const fetched = timestamp(source.fetched_at);
    if (!fetched || Date.parse(fetched) > now || now - Date.parse(fetched) > RETAIN_MS) return null;
    const items = source.items.map((entry: unknown) => discussion(entry));
    if (items.some((entry) => entry === null)) return null;
    return { items: items.filter((entry): entry is GithubDiscussion => entry !== null), total: items.length,
      repository_url: REPOSITORY_URL, fetched_at: fetched, stale: false };
  } catch { return null; }
}

async function fetchFeed(fetcher: typeof fetch, now: number, timeoutMs: number): Promise<GithubDiscussionsFeed> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, timeoutMs);
  });
  try {
    return await Promise.race([deadline, (async () => {
      const response = await fetcher(ATOM_URL, { method: 'GET', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/atom+xml', 'User-Agent': 'nexusmods-bypass-diagnostics' } });
      if (!response.ok || !/^(?:application\/atom\+xml|application\/xml|text\/xml)(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
        void response.body?.cancel().catch(() => {});
        throw unavailable();
      }
      const items = parseDiscussionAtom(await boundedText(response, controller.signal));
      return { items, total: items.length, repository_url: REPOSITORY_URL, fetched_at: new Date(now).toISOString(), stale: false };
    })()]);
  } finally { clearTimeout(timer); }
}

async function edgeCache(): Promise<Dependencies['cache']> {
  try { return typeof caches === 'undefined' ? undefined : await caches.open('nexusmods-github-discussions-public-v1'); }
  catch { return undefined; }
}

/** Only normalized public metadata is cached; protected responses remain no-store. */
export async function getGithubDiscussions(dependencies: Dependencies = {}): Promise<GithubDiscussionsFeed> {
  const now = (dependencies.now ?? Date.now)();
  const cache = dependencies.cache === undefined ? await edgeCache() : dependencies.cache;
  const cached = await cachedFeed(cache, now);
  if (cached && now - Date.parse(cached.fetched_at) <= FRESH_MS) return cached;
  try {
    const feed = await fetchFeed(dependencies.fetch ?? fetch, now, Math.max(1, Math.min(TIMEOUT_MS, dependencies.timeoutMs ?? TIMEOUT_MS)));
    if (cache) {
      try { await cache.put(CACHE_KEY, Response.json(feed, { headers: { 'Cache-Control': `public, max-age=${RETAIN_MS / 1000}` } })); }
      catch { /* Public metadata remains available when caching fails. */ }
    }
    return feed;
  } catch {
    if (cached) return { ...cached, stale: true };
    throw unavailable();
  }
}
