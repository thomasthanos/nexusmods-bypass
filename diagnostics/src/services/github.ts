import { feedCache } from './feed-cache.ts';

export type GithubIssue = {
  number: number;
  title: string;
  url: string;
  state: 'open';
  labels: string[];
  created_at: string;
  updated_at: string;
  comments: number;
};

export type GithubIssuesFeed = {
  items: GithubIssue[];
  total: number;
  truncated: boolean;
  repository_url: string;
  fetched_at: string;
  stale: boolean;
};

type Dependencies = {
  fetch?: typeof fetch;
  cache?: Pick<Cache, 'match' | 'put'> | null;
  now?: () => number;
  timeoutMs?: number;
  token?: unknown;
};

const REPOSITORY_URL = 'https://github.com/thomasthanos/nexusmods-bypass/issues';
const API_URL = 'https://api.github.com/repos/thomasthanos/nexusmods-bypass/issues';
// This cache contains only the normalized public feed, never an authenticated
// dashboard response, request headers, issue bodies, or GitHub user profiles.
const CACHE_KEY = `${API_URL}?diagnostics-public-feed=v1`;
const FRESH_MS = 5 * 60_000;
const RETAIN_MS = 24 * 60 * 60_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 3;
const PAGE_SIZE = 100;
const TIMEOUT_MS = 5000;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string') return '';
  return Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ').trim()).slice(0, maximum).join('');
}

function date(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const canonical = new Date(milliseconds).toISOString();
  return canonical === (value.length === 20 ? value.replace('Z', '.000Z') : value) ? canonical : null;
}

function issue(value: unknown, cached = false): GithubIssue | null {
  const source = record(value);
  if (!source || Object.hasOwn(source, 'pull_request') || source.state !== 'open'
    || !Number.isSafeInteger(source.number) || Number(source.number) <= 0
    || !Number.isSafeInteger(source.comments) || Number(source.comments) < 0 || !Array.isArray(source.labels)) return null;
  const url = `${REPOSITORY_URL}/${Number(source.number)}`;
  if ((cached ? source.url : source.html_url) !== url) return null;
  const title = text(source.title, 512);
  const created = date(source.created_at);
  const updated = date(source.updated_at);
  if (!title || !created || !updated) return null;
  const labels = [...new Set(source.labels.slice(0, 100).map((label: unknown) => text(typeof label === 'string' ? label : record(label)?.name, 100)).filter(Boolean))];
  return { number: Number(source.number), title, url, state: 'open', labels, created_at: created, updated_at: updated, comments: Number(source.comments) };
}

/** Count streamed bytes; a false or missing Content-Length cannot bypass the cap. */
async function boundedJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Invalid GitHub response');
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (signal?.aborted) throw new Error('GitHub request timed out');
    while (true) {
      const chunk = await reader.read();
      if (signal?.aborted) throw new Error('GitHub request timed out');
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        cancel();
        throw new Error('GitHub response too large');
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

async function cachedFeed(cache: Dependencies['cache'], now: number): Promise<GithubIssuesFeed | null> {
  if (!cache) return null;
  try {
    const response = await cache.match(CACHE_KEY);
    if (!response?.ok) return null;
    const value = record(await boundedJson(response));
    if (!value || value.repository_url !== REPOSITORY_URL || value.stale !== false || typeof value.truncated !== 'boolean'
      || !Array.isArray(value.items) || value.items.length > MAX_PAGES * PAGE_SIZE || value.total !== value.items.length) return null;
    const fetched = date(value.fetched_at);
    if (!fetched || Date.parse(fetched) > now || now - Date.parse(fetched) > RETAIN_MS) return null;
    const items = value.items.map((entry: unknown) => issue(entry, true));
    if (items.some((entry) => entry === null)) return null;
    return { items: items.filter((entry): entry is GithubIssue => entry !== null), total: items.length,
      truncated: value.truncated, repository_url: REPOSITORY_URL, fetched_at: fetched, stale: false };
  } catch { return null; }
}

/**
 * Optional `GITHUB_TOKEN` secret. Unauthenticated API reads are limited per address, and a Worker's
 * outbound address is shared with other Cloudflare traffic, so they can run out without any use
 * here. A read-only token has its own limit. It is sent to the fixed API host only, never cached.
 */
function authorization(token: unknown): Record<string, string> {
  const value = typeof token === 'string' ? token.trim() : '';
  return /^[A-Za-z0-9_]{20,255}$/.test(value) ? { Authorization: `Bearer ${value}` } : {};
}

async function fetchFeed(fetcher: typeof fetch, now: number, timeoutMs: number, token: unknown): Promise<GithubIssuesFeed> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('GitHub issues unavailable'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([deadline, (async () => {
      const items = new Map<number, GithubIssue>();
      let truncated = false;
      let credentials = authorization(token);
      for (let page = 1; page <= MAX_PAGES; page++) {
        const url = `${API_URL}?state=open&sort=updated&direction=desc&per_page=${PAGE_SIZE}&page=${page}`;
        // Workers implement only 'follow' and 'manual': 'error' throws a TypeError before any request
        // is sent, so the deployed feed never reached GitHub. A manual 3xx is not ok, never followed.
        const read = () => fetcher(url, {
          method: 'GET', redirect: 'manual', signal: controller.signal,
          headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'nexusmods-bypass-diagnostics', ...credentials }
        });
        let response = await read();
        if (response.status === 401 && credentials.Authorization) {
          // An expired or revoked token must not hide the list: GitHub still answers anonymously.
          void response.body?.cancel().catch(() => {});
          credentials = {};
          response = await read();
        }
        if (!response.ok) {
          // Provider error bodies may contain internal details. Do not read them.
          void response.body?.cancel().catch(() => {});
          throw new Error('GitHub issues unavailable');
        }
        const values = await boundedJson(response, controller.signal);
        if (!Array.isArray(values) || values.length > PAGE_SIZE) throw new Error('Invalid GitHub response');
        for (const value of values) {
          const normalized = issue(value);
          if (normalized) items.set(normalized.number, normalized);
        }
        // The next URL is always constructed locally. Never follow upstream links.
        const hasNext = /(?:^|,)\s*<[^>]*>\s*;\s*rel="next"/.test(response.headers.get('link') ?? '');
        if (!hasNext) break;
        if (page === MAX_PAGES) truncated = true;
      }
      const sorted = [...items.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.number - a.number);
      return { items: sorted, total: sorted.length, truncated, repository_url: REPOSITORY_URL, fetched_at: new Date(now).toISOString(), stale: false };
    })()]);
  } finally { clearTimeout(timer); }
}

/** Optional Cache API use keeps local Node tests and cache failures functional. */
export async function getGithubIssues(dependencies: Dependencies = {}): Promise<GithubIssuesFeed> {
  const now = (dependencies.now ?? Date.now)();
  const cache = dependencies.cache === undefined ? await feedCache('nexusmods-github-public-v1') : dependencies.cache;
  const cached = await cachedFeed(cache, now);
  if (cached && now - Date.parse(cached.fetched_at) <= FRESH_MS) return cached;
  try {
    const timeout = Math.max(1, Math.min(TIMEOUT_MS, dependencies.timeoutMs ?? TIMEOUT_MS));
    const feed = await fetchFeed(dependencies.fetch ?? fetch, now, timeout, dependencies.token);
    if (cache) {
      try { await cache.put(CACHE_KEY, Response.json(feed, { headers: { 'Cache-Control': `public, max-age=${RETAIN_MS / 1000}` } })); }
      catch { /* A public feed remains usable when edge caching is unavailable. */ }
    }
    return feed;
  } catch {
    if (cached) return { ...cached, stale: true };
    throw new Error('GitHub issues unavailable');
  }
}
