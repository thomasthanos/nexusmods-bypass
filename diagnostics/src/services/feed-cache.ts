export type FeedCache = Pick<Cache, 'match' | 'put'>;

// One entry per public feed name; this module only ever holds normalized public metadata. It keeps
// plain text: a Worker cannot read a Response or stream that another request created.
const memory = new Map<string, { body: string; status: number; headers: [string, string][] }>();

/**
 * The Cache API is not available to Workers behind Cloudflare Access, and this dashboard always is:
 * there a named cache keeps nothing, so every refresh asked GitHub again and an outage had no copy to
 * fall back on. The last good feed is therefore also kept in this isolate's memory. The edge cache is
 * still consulted first wherever it works. Callers validate what either layer returns.
 */
export async function feedCache(name: string): Promise<FeedCache | undefined> {
  // Outside a Workers runtime, as in the Node tests, there is no cache at all.
  if (typeof caches === 'undefined') return undefined;
  let edge: FeedCache | undefined;
  try { edge = await caches.open(name); } catch { /* No usable Cache API: memory alone. */ }
  const key = (request: RequestInfo | URL) => `${name} ${request instanceof Request ? request.url : String(request)}`;
  return {
    async match(request) {
      const stored = await edge?.match(request).catch(() => undefined);
      const remembered = memory.get(key(request));
      return stored ?? (remembered && new Response(remembered.body, { status: remembered.status, headers: remembered.headers }));
    },
    async put(request, response) {
      memory.set(key(request), { body: await response.clone().text(), status: response.status, headers: [...response.headers] });
      await edge?.put(request, response);
    }
  };
}

/** Tests only: forget what this isolate remembered. */
export function forgetFeeds(): void { memory.clear(); }
