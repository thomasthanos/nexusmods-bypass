// The one place the extension talks to Nexus Mods' documented GraphQL API (v2). Every read goes
// through a token bucket (burst 60, then 1 per second), honours Retry-After on 429 with capped
// exponential backoff, and is cached: published collection revisions never change, so they are
// kept permanently; everything else expires. Calls use the page's own session (credentials:
// 'include'), exactly as nexusmods.com does; no API key is stored or needed.
// See docs/nexus-site-map.md for the study this is based on.
window.NexusExt = window.NexusExt || {};

(function () {
  'use strict';

  const NexusExt = window.NexusExt;
  if (NexusExt.NexusApi) return;

  const V2_URL = 'https://api.nexusmods.com/v2/graphql';
  // The router nexusmods.com itself calls. Same schema; kept as the fallback and the legacy path.
  const ROUTER_URL = 'https://api-router.nexusmods.com/graphql';

  const BUCKET_CAPACITY = 60;
  const REFILL_PER_MS = 1 / 1000;
  const BACKOFF_BASE_MS = 60 * 1000;
  const BACKOFF_MAX_MS = 15 * 60 * 1000;
  const MAX_INLINE_WAIT_MS = 90 * 1000;
  const PERSIST_KEY = 'nxtk_api_cache';
  const PERSIST_MAX_ENTRIES = 20;
  const PERSIST_MAX_CHARS = 1500000;
  const BATCH_SIZE = 50;

  const TTL = Object.freeze({
    revisionLatest: 10 * 60 * 1000,
    revisions: 10 * 60 * 1000,
    modFiles: 10 * 60 * 1000,
    mods: 60 * 60 * 1000,
    game: Infinity
  });

  const MOD_FILE_FIELDS = 'fileId, name, uri, size, version, date, mod { adult, modId, name, version, game { domainName, id } }';

  // Every query the extension sends. tools/schema-watch.mjs validates these against the live schema.
  const QUERIES = Object.freeze({
    // Legacy form, byte-for-byte what earlier versions sent (used when the official API is off).
    CollectionRevisionModsLegacy: `query CollectionRevisionMods ($revision: Int, $slug: String!, $viewAdultContent: Boolean) { collectionRevision (revision: $revision, slug: $slug, viewAdultContent: $viewAdultContent) { externalResources { id, name, resourceType, resourceUrl }, modFiles { fileId, optional, file { ${MOD_FILE_FIELDS} } } } }`,
    CollectionRevisionMods: `query CollectionRevisionMods ($revision: Int, $slug: String!, $viewAdultContent: Boolean) { collectionRevision (revision: $revision, slug: $slug, viewAdultContent: $viewAdultContent) { revisionNumber, revisionStatus, latest, externalResources { id, name, resourceType, resourceUrl }, modFiles { fileId, optional, updatePolicy, version, file { ${MOD_FILE_FIELDS} } } } }`,
    CollectionRevisions: 'query CollectionRevisions ($domainName: String, $slug: String!) { collection (domainName: $domainName, slug: $slug) { revisions {adultContent, createdAt, discardedAt, id, latest, revisionNumber, revisionStatus, totalSize, modCount, collectionChangelog { description, id}, gameVersions { reference } } } }',
    GameId: 'query GameId ($domainName: String) { game (domainName: $domainName) { id, domainName } }',
    ModFiles: 'query ModFiles ($modId: ID!, $gameId: ID!) { modFiles (modId: $modId, gameId: $gameId) { fileId, name, version, category, groupId, date, size, uri } }',
    ModsByDomain: 'query ModsByDomain ($ids: [CompositeDomainWithIdInput!]!, $count: Int) { legacyModsByDomain (ids: $ids, count: $count) { nodes { uid, modId, name, version, updatedAt, viewerEndorsed, viewerTracked, viewerUpdateAvailable, game { domainName, id } } } }',
    FileHash: 'query FileHash ($md5: String!) { fileHash (md5: $md5) { md5, fileName, fileSize, gameId, modFileId, modFile { fileId, name, version, mod { modId, name, game { domainName, id } } } } }',
    EndorseMod: 'mutation EndorseMod ($modUid: String!) { createModEndorsement (modUid: $modUid) { success } }',
    AbstainMod: 'mutation AbstainMod ($modUid: String!) { abstainFromModEndorsement (modUid: $modUid) { success } }',
    TrackMod: 'mutation TrackMod ($modUid: ID!) { trackMod (modUid: $modUid) { success } }',
    UntrackMod: 'mutation UntrackMod ($modUid: ID!) { untrackMod (modUid: $modUid) { success } }'
  });

  // GraphQL error codes for which the router (the page's own endpoint) is worth one more try.
  const FALLBACK_GRAPHQL_CODES = /"code"\s*:\s*"(ADULT_CONTENT_BLOCKED|UNAUTHENTICATED|FORBIDDEN)"/;

  function fallbackWorthy(result) {
    if (!result) return true;
    if (!result.ok) {
      const code = result.error?.code || '';
      if (code === 'rate_limited' || code === 'aborted') return false;
      // A Cloudflare challenge or a 403 is an answer, not an outage: it is reported, never routed around.
      if (code === 'cloudflare' || code === 'access_denied' || result.status === 403) return false;
      return !result.status || result.status >= 500 || result.status === 404
        || ['network_error', 'timeout', 'server_error'].includes(code);
    }
    return FALLBACK_GRAPHQL_CODES.test(result.text || '');
  }

  function parseJson(text) {
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  function chromeStorage() {
    try {
      const area = chrome?.storage?.local;
      if (!area || !chrome.runtime?.id) return null;
      return {
        get: (key) => new Promise((resolve) => {
          try { area.get(key, (r) => resolve(chrome.runtime.lastError ? undefined : r?.[key])); } catch (_) { resolve(undefined); }
        }),
        set: (key, value) => new Promise((resolve) => {
          try { area.set({ [key]: value }, () => resolve()); } catch (_) { resolve(); }
        })
      };
    } catch (_) {
      return null;
    }
  }

  function createNexusApi({
    request = (...args) => NexusExt.Errors.request(...args),
    now = () => Date.now(),
    sleep = (ms, signal) => new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener?.('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    }),
    random = Math.random,
    storage = chromeStorage(),
    referrer = () => (typeof document !== 'undefined' ? document.location.href : undefined)
  } = {}) {
    const bucket = { tokens: BUCKET_CAPACITY, at: now() };
    const limiter = { blockedUntil: 0, strikes: 0 };
    const memory = new Map();
    const inflight = new Map();
    let persisted = null;
    const stats = { requests: 0, cacheHits: 0, fallbacks: 0, rateLimited: 0 };

    function refill() {
      const t = now();
      bucket.tokens = Math.min(BUCKET_CAPACITY, bucket.tokens + Math.max(0, t - bucket.at) * REFILL_PER_MS);
      bucket.at = t;
    }

    // Resolves when a request may go out, or returns the wait it would need when that is too long.
    async function acquire(signal) {
      for (;;) {
        if (signal?.aborted) return { aborted: true };
        const blocked = limiter.blockedUntil - now();
        if (blocked > 0) {
          if (blocked > MAX_INLINE_WAIT_MS) return { waitMs: blocked };
          await sleep(blocked, signal);
          continue;
        }
        refill();
        if (bucket.tokens >= 1) {
          bucket.tokens -= 1;
          return { ok: true };
        }
        await sleep(Math.ceil((1 - bucket.tokens) / REFILL_PER_MS), signal);
      }
    }

    function noteRateLimited(retryAfterSeconds) {
      stats.rateLimited++;
      const fromHeader = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0 ? retryAfterSeconds * 1000 : null;
      const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * (2 ** limiter.strikes)) * (1 + random() * 0.2);
      limiter.strikes = Math.min(limiter.strikes + 1, 8);
      limiter.blockedUntil = now() + (fromHeader ?? backoff);
      bucket.tokens = 0;
    }

    function rateLimitedResult(waitMs) {
      const Errors = NexusExt.Errors;
      const error = Errors?.create
        ? Errors.create('rate_limited', { context: 'Nexus API', technicalMessage: `client backoff ${Math.ceil(waitMs / 1000)}s` })
        : { code: 'rate_limited' };
      if (error) error.retryAfterSeconds = Math.ceil(waitMs / 1000);
      return { ok: false, status: 429, text: '', error, rateLimit: { retryAfterSeconds: Math.ceil(waitMs / 1000) } };
    }

    async function loadPersisted() {
      if (persisted) return persisted;
      const stored = storage ? await storage.get(PERSIST_KEY) : null;
      persisted = stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...stored } : {};
      return persisted;
    }

    async function readCache(key) {
      if (!key) return null;
      const hit = memory.get(key);
      if (hit && hit.expires > now()) return hit.text;
      if (hit) memory.delete(key);
      const store = await loadPersisted();
      const entry = store[key];
      if (entry && typeof entry.text === 'string') {
        memory.set(key, { text: entry.text, expires: Infinity });
        return entry.text;
      }
      return null;
    }

    async function writeCache(key, text, ttlMs, permanent) {
      if (!key) return;
      memory.set(key, { text, expires: permanent ? Infinity : now() + ttlMs });
      if (!permanent || !storage || text.length > PERSIST_MAX_CHARS) return;
      const store = await loadPersisted();
      store[key] = { text, at: now() };
      const keys = Object.keys(store).sort((a, b) => (store[a].at || 0) - (store[b].at || 0));
      let total = keys.reduce((sum, k) => sum + (store[k].text?.length || 0), 0);
      while (keys.length > PERSIST_MAX_ENTRIES || total > PERSIST_MAX_CHARS * 2) {
        const oldest = keys.shift();
        total -= store[oldest]?.text?.length || 0;
        delete store[oldest];
      }
      await storage.set(PERSIST_KEY, store);
    }

    function post(url, body, { signal, timeoutMs, context }) {
      stats.requests++;
      return request(url, {
        headers: { 'content-type': 'application/json' },
        referrer: referrer(),
        referrerPolicy: 'strict-origin-when-cross-origin',
        body,
        method: 'POST',
        mode: 'cors',
        credentials: 'include'
      }, { timeoutMs, context, signal });
    }

    // One GraphQL operation. Returns the Errors.request shape ({ ok, status, text, error }) plus
    // `source`: 'cache', 'v2' or 'router'.
    async function graphql({
      query, operationName, variables = {}, context = 'Nexus API', signal = null, timeoutMs,
      cacheKey = '', ttlMs = 0, permanentIf = null, fallback = true, mutation = false, retries = 2
    }) {
      const cached = mutation ? null : await readCache(cacheKey);
      if (cached != null) {
        stats.cacheHits++;
        return { ok: true, status: 200, text: cached, source: 'cache' };
      }
      const key = !mutation && cacheKey ? cacheKey : '';
      if (key && inflight.has(key)) return inflight.get(key);

      const run = (async () => {
        const body = JSON.stringify({ query, variables, operationName });
        let attempt = 0;
        for (;;) {
          const slot = await acquire(signal);
          if (slot.aborted) return { ok: false, status: 0, text: '', error: NexusExt.Errors?.create?.('aborted', { context }) || { code: 'aborted' } };
          if (slot.waitMs) return rateLimitedResult(slot.waitMs);

          let result = await post(V2_URL, body, { signal, timeoutMs, context });
          let source = 'v2';
          if (result.status === 429 || result.error?.code === 'rate_limited') {
            noteRateLimited(result.rateLimit?.retryAfterSeconds);
            if (mutation || attempt++ >= retries) return { ...result, source };
            continue;
          }
          if (!mutation && fallback && fallbackWorthy(result)) {
            stats.fallbacks++;
            const routed = await post(ROUTER_URL, body, { signal, timeoutMs, context });
            if (routed.ok || !result.ok) {
              result = routed;
              source = 'router';
            }
          }
          if (result.ok) {
            limiter.strikes = 0;
            const json = parseJson(result.text);
            const clean = json && !Array.isArray(json.errors) && json.data;
            if (clean && key) {
              const permanent = typeof permanentIf === 'function' && !!permanentIf(json);
              await writeCache(key, result.text, ttlMs, permanent);
            }
          }
          return { ...result, source };
        }
      })();
      if (key) {
        inflight.set(key, run);
        run.finally(() => inflight.delete(key)).catch(() => {});
      }
      return run;
    }

    async function data(options) {
      const result = await graphql(options);
      const json = result.ok ? parseJson(result.text) : null;
      return { result, json, data: json?.data || null };
    }

    const isPublished = (rev) => String(rev?.revisionStatus || '').toLowerCase() === 'published';

    // ---- Typed helpers -------------------------------------------------------------------------

    function collectionRevisionMods({ slug, revision = null, signal, timeoutMs }) {
      const explicit = Number.isInteger(revision) && revision > 0;
      return graphql({
        query: QUERIES.CollectionRevisionMods,
        operationName: 'CollectionRevisionMods',
        variables: { slug, viewAdultContent: true, revision: explicit ? revision : null },
        context: 'Loading collection details',
        signal,
        timeoutMs,
        cacheKey: `rev:${slug}:${explicit ? revision : 'latest'}`,
        ttlMs: TTL.revisionLatest,
        // A published revision is immutable; one looked up as "latest" may be superseded.
        permanentIf: (json) => explicit && isPublished(json?.data?.collectionRevision)
      });
    }

    function collectionRevisions({ slug, domainName, signal, timeoutMs }) {
      return graphql({
        query: QUERIES.CollectionRevisions,
        operationName: 'CollectionRevisions',
        variables: { domainName, slug },
        context: 'Loading collection revisions',
        signal,
        timeoutMs,
        cacheKey: `revs:${domainName}:${slug}`,
        ttlMs: TTL.revisions
      });
    }

    async function gameId(domainName, { signal } = {}) {
      const domain = String(domainName || '').toLowerCase();
      if (!/^[a-z0-9_-]{1,64}$/.test(domain)) return '';
      const { data: d } = await data({
        query: QUERIES.GameId,
        operationName: 'GameId',
        variables: { domainName: domain },
        context: 'Looking up game',
        signal,
        cacheKey: `game:${domain}`,
        permanentIf: (json) => !!json?.data?.game?.id
      });
      const id = d?.game?.id;
      return id ? String(id) : '';
    }

    async function modFiles({ modId, gameId: gid, signal }) {
      if (!/^\d+$/.test(String(modId)) || !/^\d+$/.test(String(gid))) return null;
      const { data: d, result } = await data({
        query: QUERIES.ModFiles,
        operationName: 'ModFiles',
        variables: { modId: String(modId), gameId: String(gid) },
        context: 'Loading mod files',
        signal,
        cacheKey: `files:${gid}:${modId}`,
        ttlMs: TTL.modFiles
      });
      return Array.isArray(d?.modFiles) ? d.modFiles : (result.ok ? [] : null);
    }

    // Details for many mods in batches of 50: Map("domain:modId" -> mod).
    async function modsByDomain(pairs, { signal } = {}) {
      const unique = new Map();
      for (const pair of pairs || []) {
        const domain = String(pair?.gameDomain || '').toLowerCase();
        const id = Number(pair?.modId);
        if (domain && Number.isInteger(id) && id > 0) unique.set(`${domain}:${id}`, { gameDomain: domain, modId: id });
      }
      const out = new Map();
      const list = [...unique.values()];
      for (let i = 0; i < list.length; i += BATCH_SIZE) {
        const chunk = list.slice(i, i + BATCH_SIZE);
        const { data: d } = await data({
          query: QUERIES.ModsByDomain,
          operationName: 'ModsByDomain',
          variables: { ids: chunk, count: chunk.length },
          context: 'Loading mod details',
          signal,
          cacheKey: `mods:${chunk.map((p) => `${p.gameDomain}:${p.modId}`).join(',')}`,
          ttlMs: TTL.mods
        });
        for (const node of d?.legacyModsByDomain?.nodes || []) {
          const domain = String(node?.game?.domainName || '').toLowerCase();
          if (domain && node?.modId) out.set(`${domain}:${node.modId}`, node);
        }
        if (signal?.aborted) break;
      }
      return out;
    }

    async function fileByMd5(md5, { signal } = {}) {
      const hash = String(md5 || '').toLowerCase();
      if (!/^[0-9a-f]{32}$/.test(hash)) return [];
      const { data: d } = await data({
        query: QUERIES.FileHash,
        operationName: 'FileHash',
        variables: { md5: hash },
        context: 'Looking up archive hash',
        signal,
        cacheKey: `md5:${hash}`,
        ttlMs: TTL.mods
      });
      return Array.isArray(d?.fileHash) ? d.fileHash : [];
    }

    // Endorse/track. Only ever called from a click handler; never retried, cached or rerouted.
    async function modAction(action, modUid) {
      const ops = { endorse: 'EndorseMod', abstain: 'AbstainMod', track: 'TrackMod', untrack: 'UntrackMod' };
      const operationName = ops[action];
      if (!operationName || !/^\d{1,20}$/.test(String(modUid || ''))) return { ok: false, error: { code: 'invalid_request' } };
      const { result, json } = await data({
        query: QUERIES[operationName],
        operationName,
        variables: { modUid: String(modUid) },
        context: 'Updating mod',
        mutation: true
      });
      const payload = json?.data && Object.values(json.data)[0];
      const message = Array.isArray(json?.errors) ? String(json.errors[0]?.message || '').slice(0, 200) : '';
      return { ok: !!payload?.success, message, error: result.ok ? null : result.error };
    }

    return {
      graphql,
      collectionRevisionMods,
      collectionRevisions,
      gameId,
      modFiles,
      modsByDomain,
      fileByMd5,
      modAction,
      stats,
      _state: { bucket, limiter, memory }
    };
  }

  // The newest still-offered file in the same group (the chain of updates for one download).
  const ACTIVE_CATEGORIES = new Set(['MAIN', 'UPDATE', 'OPTIONAL', 'MISCELLANEOUS']);
  function latestInGroup(files, fileId) {
    const list = Array.isArray(files) ? files : [];
    const pinned = list.find((f) => String(f?.fileId) === String(fileId));
    if (!pinned || pinned.groupId == null) return null;
    const candidates = list.filter((f) => f.groupId === pinned.groupId && ACTIVE_CATEGORIES.has(String(f.category)));
    if (!candidates.length) return null;
    return candidates.reduce((best, f) => (Number(f.date) > Number(best.date) || (Number(f.date) === Number(best.date) && f.fileId > best.fileId) ? f : best));
  }

  // Which file a collection entry should download under its curator's update policy.
  //  exact  -> the pinned file, always.
  //  prefer -> the pinned file while Nexus still offers it, otherwise the newest in its group.
  //  latest -> the newest file in its group.
  function resolveByPolicy(policy, files, fileId) {
    const p = String(policy || 'exact').toLowerCase();
    if (p === 'exact') return null;
    const pinned = (files || []).find((f) => String(f?.fileId) === String(fileId));
    if (p === 'prefer' && pinned && ACTIVE_CATEGORIES.has(String(pinned.category))) return null;
    const latest = latestInGroup(files, fileId);
    return latest && String(latest.fileId) !== String(fileId) ? latest : null;
  }

  NexusExt.NexusApi = Object.freeze({
    V2_URL,
    ROUTER_URL,
    QUERIES,
    TTL,
    BUCKET_CAPACITY,
    createNexusApi,
    latestInGroup,
    resolveByPolicy,
    fallbackWorthy,
    // Shared instance for the page; created on first use so tests can load the file without chrome.
    shared: () => sharedInstance()
  });

  let sharedApi = null;
  function sharedInstance() {
    if (!sharedApi) sharedApi = createNexusApi();
    return sharedApi;
  }
})();
