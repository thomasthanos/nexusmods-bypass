// Official-API layer (src/content/nexus-api.js): throttle, 429 backoff, caching, fallback, batching,
// update policy, query/schema contract; plus NDC's API paths and the MD5 used for archive lookup.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');

const recorded = [];
const debugEntries = [];

function loadApi() {
  const ctx = vm.createContext({ console, URL, setTimeout, clearTimeout, Promise, JSON, Math, Date });
  ctx.window = ctx;
  ctx.NexusExt = ctx.window.NexusExt = {
    Errors: {
      create: (code, extra = {}) => { const e = { code, ...extra }; if (extra.record !== false) recorded.push(e); return e; },
      record: (e) => { recorded.push(e); return e; }
    }
  };
  ctx.NXTK = { queueDebugEntry: (level, text) => debugEntries.push({ level, text }) };
  vm.runInContext(fs.readFileSync('src/content/nexus-api.js', 'utf8'), ctx, { filename: 'nexus-api.js' });
  return ctx.window.NexusExt.NexusApi;
}

const NexusApi = loadApi();

function harness({ responses = [], storageData = {} } = {}) {
  let clock = 1_000_000;
  const calls = [];
  const sleeps = [];
  const store = { ...storageData };
  const queue = [...responses];
  const api = NexusApi.createNexusApi({
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    random: () => 0,
    referrer: () => 'https://www.nexusmods.com/',
    storage: {
      get: async (key) => store[key],
      set: async (key, value) => { store[key] = JSON.parse(JSON.stringify(value)); }
    },
    request: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body), credentials: options.credentials });
      const next = typeof queue[0] === 'function' ? queue[0](url) : queue.shift();
      return next || ok({ data: { ok: true } });
    }
  });
  return { api, calls, sleeps, store, advance: (ms) => { clock += ms; } };
}

const ok = (json) => ({ ok: true, status: 200, text: JSON.stringify(json) });
const limited = (retryAfterSeconds = null) => ({ ok: false, status: 429, text: '', error: { code: 'rate_limited' }, rateLimit: { retryAfterSeconds } });
const netFail = () => ({ ok: false, status: 0, text: '', error: { code: 'network_error' } });

(async () => {
  // ---- Token bucket: 60 at once, then one per second.
  {
    const h = harness();
    for (let i = 0; i < 60; i++) await h.api.graphql({ query: 'q', operationName: 'Q' });
    assert.equal(h.sleeps.length, 0, 'the first 60 requests go out without waiting');
    await h.api.graphql({ query: 'q', operationName: 'Q' });
    assert.equal(h.sleeps.length, 1);
    assert.ok(h.sleeps[0] >= 999 && h.sleeps[0] <= 1000, `61st waits about a second (${h.sleeps[0]})`);
    assert.equal(h.calls[0].url, NexusApi.V2_URL, 'reads go to the documented v2 endpoint');
    assert.equal(h.calls[0].credentials, 'include', 'the page session is used, no API key');
  }

  // ---- 429 honours Retry-After, then retries.
  {
    const h = harness({ responses: [limited(5), ok({ data: { a: 1 } })] });
    const r = await h.api.graphql({ query: 'q', operationName: 'Q' });
    assert.equal(r.ok, true);
    assert.deepEqual(h.sleeps, [5000], 'waits exactly Retry-After');
    assert.equal(h.calls.length, 2);
  }

  // ---- 429 without a header backs off 60 s, then doubles; too long to wait inline -> rate_limited.
  {
    const h = harness({ responses: [limited(), limited(), ok({ data: {} })] });
    const r = await h.api.graphql({ query: 'q', operationName: 'Q' });
    assert.equal(h.sleeps[0], 60000, 'first backoff is 60 s');
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'rate_limited');
    assert.equal(r.rateLimit.retryAfterSeconds, 120, 'second backoff doubles and is reported, not slept');
    assert.equal(h.calls.length, 2);
    const blocked = await h.api.graphql({ query: 'q2', operationName: 'Q' });
    assert.equal(blocked.error.code, 'rate_limited', 'nothing is sent while backing off');
    assert.equal(h.calls.length, 2);
    h.advance(121000);
    const after = await h.api.graphql({ query: 'q3', operationName: 'Q' });
    assert.equal(after.ok, true, 'sends again once the backoff is over');
  }

  // ---- Mutations: never retried, cached or rerouted.
  {
    const h = harness({ responses: [limited(1)] });
    const r = await h.api.modAction('endorse', '123');
    assert.equal(r.ok, false);
    assert.equal(h.calls.length, 1, 'a click sends exactly one request');
    const h2 = harness({ responses: [netFail()] });
    await h2.api.modAction('track', '123');
    assert.equal(h2.calls.length, 1, 'mutations do not fall back to the router');
    assert.match(h2.calls[0].body.query, /trackMod/);
    const bad = await h2.api.modAction('delete', '123');
    assert.equal(bad.ok, false, 'unknown actions are refused');
    assert.equal(h2.calls.length, 1);
    const h3 = harness({ responses: [ok({ data: { createModEndorsement: { success: true } } })] });
    assert.equal((await h3.api.modAction('endorse', '42')).ok, true);
    assert.equal(h3.calls[0].body.variables.modUid, '42');
  }

  // ---- Fallback to the router: network failure and adult-content refusal yes; Cloudflare/403 no.
  {
    const h = harness({ responses: [netFail(), ok({ data: { x: 1 } })] });
    const r = await h.api.graphql({ query: 'q', operationName: 'Q' });
    assert.equal(r.source, 'router');
    assert.equal(h.calls[1].url, NexusApi.ROUTER_URL);
    const adult = harness({ responses: [ok({ errors: [{ extensions: { code: 'ADULT_CONTENT_BLOCKED' } }], data: null }), ok({ data: { y: 1 } })] });
    assert.equal((await adult.api.graphql({ query: 'q', operationName: 'Q' })).source, 'router');
    for (const answer of [{ ok: false, status: 403, text: '', error: { code: 'access_denied' } }, { ok: false, status: 503, text: '', error: { code: 'cloudflare' } }]) {
      const h2 = harness({ responses: [answer] });
      await h2.api.graphql({ query: 'q', operationName: 'Q' });
      assert.equal(h2.calls.length, 1, `${answer.error.code} is reported, never routed around`);
    }
    const off = harness({ responses: [netFail()] });
    await off.api.graphql({ query: 'q', operationName: 'Q', fallback: false });
    assert.equal(off.calls.length, 1);
  }

  // ---- Caching: TTL, permanent published revisions (persisted), latest not permanent, in-flight dedupe.
  // A fallback is a real request too, and its 429 must block subsequent calls.
  {
    const h = harness({ responses: [netFail(), limited(5), ok({ data: { a: 1 } })] });
    assert.equal((await h.api.graphql({ query: 'q', operationName: 'Q' })).ok, true);
    assert.deepEqual(h.sleeps, [5000], 'router Retry-After is honoured');
    assert.equal(h.calls.length, 3);
    const burst = harness({ responses: Array.from({ length: 31 }, () => [netFail(), ok({ data: {} })]).flat() });
    for (let i = 0; i < 31; i++) await burst.api.graphql({ query: 'q', operationName: 'Q' });
    assert.deepEqual(burst.sleeps, [1000, 1000], 'both endpoints consume the shared request budget');
  }

  // Concurrent cache reads share one storage read rather than replacing each other's store.
  {
    let reads = 0;
    let release;
    const api = NexusApi.createNexusApi({
      storage: { get: () => { reads++; return new Promise((r) => { release = r; }); }, set: async () => {} },
      request: async (_url, options) => ok({ data: { game: { id: JSON.parse(options.body).variables.domainName === 'skyrim' ? 1 : 2 } } })
    });
    const a = api.gameId('skyrim');
    const b = api.gameId('fallout4');
    await new Promise((r) => setImmediate(r));
    assert.equal(reads, 1, 'cache initialization is shared across different concurrent queries');
    release({});
    assert.deepEqual(await Promise.all([a, b]), ['1', '2']);
  }

  // Successful actions invalidate viewer-state caches; refused actions keep valid cached data.
  {
    const mods = (tracked) => ok({ data: { legacyModsByDomain: { nodes: [{ modId: 1, uid: '42', viewerTracked: tracked, game: { domainName: 'skyrim' } }] } } });
    const h = harness({ responses: [mods(false), ok({ data: { trackMod: { success: true } } }), mods(true)] });
    const pairs = [{ gameDomain: 'skyrim', modId: 1 }];
    await h.api.modsByDomain(pairs);
    await h.api.modAction('track', '42');
    assert.equal((await h.api.modsByDomain(pairs)).get('skyrim:1').viewerTracked, true);
    assert.equal(h.calls.length, 3, 'viewer state is fetched again after a successful action');
    const refused = harness({ responses: [mods(false), ok({ data: { trackMod: { success: false } } })] });
    await refused.api.modsByDomain(pairs);
    await refused.api.modAction('track', '42');
    await refused.api.modsByDomain(pairs);
    assert.equal(refused.calls.length, 2, 'a refused action does not invalidate the cache');

    let finishOld;
    let reads = 0;
    const api = NexusApi.createNexusApi({ storage: null, request: async (_url, options) => {
      if (JSON.parse(options.body).operationName === 'TrackMod') return ok({ data: { trackMod: { success: true } } });
      return ++reads === 1 ? new Promise((r) => { finishOld = r; }) : mods(true);
    } });
    const old = api.modsByDomain(pairs);
    await new Promise((r) => setImmediate(r));
    await api.modAction('track', '42');
    assert.equal((await api.modsByDomain(pairs)).get('skyrim:1').viewerTracked, true, 'an old in-flight read is not reused after an action');
    finishOld(mods(false));
    await old;
    assert.equal((await api.modsByDomain(pairs)).get('skyrim:1').viewerTracked, true, 'an old response cannot overwrite the refreshed cache');
  }

  // GraphQL failures and missing data are not valid empty file lists.
  {
    for (const response of [ok({ errors: [{ message: 'schema changed' }], data: null }), ok({ data: {} })]) {
      const h = harness({ responses: [response] });
      assert.equal(await h.api.modFiles({ modId: 1, gameId: 2 }), null);
    }
    const h = harness({ responses: [ok({ data: { modFiles: [] } })] });
    assert.equal((await h.api.modFiles({ modId: 1, gameId: 2 })).length, 0);
  }

  {
    const published = ok({ data: { collectionRevision: { revisionNumber: 4, revisionStatus: 'published', modFiles: [] } } });
    const h = harness({ responses: [published, published] });
    await h.api.collectionRevisionMods({ slug: 'abc123', revision: 4 });
    await h.api.collectionRevisionMods({ slug: 'abc123', revision: 4 });
    assert.equal(h.calls.length, 1, 'second read comes from cache');
    assert.ok(h.store.nxtk_api_cache?.['rev:abc123:4'], 'published revision is stored permanently');
    h.advance(400 * 24 * 3600 * 1000);
    await h.api.collectionRevisionMods({ slug: 'abc123', revision: 4 });
    assert.equal(h.calls.length, 1, 'never expires');

    const restarted = harness({ storageData: { nxtk_api_cache: h.store.nxtk_api_cache } });
    const fromDisk = await restarted.api.collectionRevisionMods({ slug: 'abc123', revision: 4 });
    assert.equal(fromDisk.source, 'cache');
    assert.equal(restarted.calls.length, 0, 'survives a page reload');

    const latest = harness({ responses: [published, published] });
    await latest.api.collectionRevisionMods({ slug: 'abc123' });
    assert.equal(latest.store.nxtk_api_cache, undefined, '"latest" is not permanent');
    latest.advance(11 * 60 * 1000);
    await latest.api.collectionRevisionMods({ slug: 'abc123' });
    assert.equal(latest.calls.length, 2, '"latest" expires after 10 minutes');

    const draft = harness({ responses: [ok({ data: { collectionRevision: { revisionStatus: 'draft', modFiles: [] } } })] });
    await draft.api.collectionRevisionMods({ slug: 'abc123', revision: 5 });
    assert.equal(draft.store.nxtk_api_cache, undefined, 'drafts are not permanent');

    const errors = harness({ responses: [ok({ errors: [{ message: 'x' }], data: null }), ok({ data: { game: { id: 1 } } })] });
    await errors.api.gameId('skyrim', {});
    assert.equal(await errors.api.gameId('skyrim'), '1', 'error answers are not cached');

    let release;
    const slow = harness({ responses: [() => new Promise((r) => { release = r; })] });
    const a = slow.api.gameId('fallout4');
    const b = slow.api.gameId('fallout4');
    await new Promise((r) => setImmediate(r));
    release(ok({ data: { game: { id: 1151 } } }));
    assert.deepEqual([await a, await b], ['1151', '1151']);
    assert.equal(slow.calls.length, 1, 'concurrent identical reads share one request');
  }

  // ---- Batched mod details: 120 mods -> 3 requests of <= 50.
  {
    const pairs = Array.from({ length: 120 }, (_, i) => ({ gameDomain: 'SkyrimSpecialEdition', modId: i + 1 }));
    pairs.push({ gameDomain: 'skyrimspecialedition', modId: 1 }, { gameDomain: '', modId: 3 });
    const batched = harness({
      responses: Array.from({ length: 3 }, (_, i) => ok({ data: { legacyModsByDomain: { nodes: [{ modId: i * 50 + 1, uid: '9', version: '2', game: { domainName: 'skyrimspecialedition' } }] } } }))
    });
    const map = await batched.api.modsByDomain(pairs);
    assert.equal(batched.calls.length, 3);
    assert.ok(batched.calls.every((c) => c.body.variables.ids.length <= 50));
    assert.equal(batched.calls[0].body.variables.ids[0].gameDomain, 'skyrimspecialedition', 'domains are normalised');
    assert.equal(map.get('skyrimspecialedition:1').uid, '9');
  }

  // ---- Update policy.
  {
    const files = [
      { fileId: 1, groupId: 7, category: 'ARCHIVED', date: 100 },
      { fileId: 2, groupId: 7, category: 'OLD_VERSION', date: 200 },
      { fileId: 3, groupId: 7, category: 'MAIN', date: 300 },
      { fileId: 4, groupId: 8, category: 'MAIN', date: 400 },
      { fileId: 5, groupId: 7, category: 'REMOVED', date: 500 }
    ];
    assert.equal(NexusApi.resolveByPolicy('exact', files, 1), null, 'exact pins never change');
    assert.equal(NexusApi.resolveByPolicy('latest', files, 1).fileId, 3, 'latest: newest active file in the same group');
    assert.equal(NexusApi.resolveByPolicy('latest', files, 3), null, 'already the newest');
    assert.equal(NexusApi.resolveByPolicy('prefer', files, 3), null, 'prefer keeps an active pinned file');
    assert.equal(NexusApi.resolveByPolicy('prefer', files, 1).fileId, 3, 'prefer moves off an archived file');
    assert.equal(NexusApi.resolveByPolicy('latest', files, 99), null, 'unknown file: unchanged');
    assert.equal(NexusApi.resolveByPolicy('latest', null, 1), null);
    assert.equal(NexusApi.resolveByPolicy('unknown', files, 1), null, 'unknown policy never changes a pinned file');
  }

  // ---- Every query is valid against the schema snapshot (tools/schema-watch.mjs checks the live one).
  {
    let graphql = null;
    try { graphql = require('graphql'); } catch (_) { console.log('graphql package not installed; schema contract skipped'); }
    if (graphql) {
      const schema = graphql.buildClientSchema(JSON.parse(fs.readFileSync('tests/fixtures/nexus-v2-schema.json', 'utf8')));
      for (const [name, query] of Object.entries(NexusApi.QUERIES)) {
        const errors = graphql.validate(schema, graphql.parse(query));
        assert.deepEqual(errors.map((e) => e.message), [], `${name} matches the schema`);
      }
    }
    const legacy = fs.readFileSync('src/content/ndc.js', 'utf8');
    assert.ok(legacy.includes(NexusApi.QUERIES.CollectionRevisionModsLegacy.slice(0, 60)) || legacy.includes('CollectionRevisionModsLegacy'),
      'the legacy path still sends the pre-2.10 query');
  }

  // ---- MD5 for archive lookup.
  {
    const ctx = vm.createContext({ console, URL, TextDecoder, Uint8Array, Uint32Array });
    ctx.window = ctx;
    ctx.NexusExt = ctx.window.NexusExt = {};
    vm.runInContext(fs.readFileSync('src/content/wabbajack-importer.js', 'utf8'), ctx);
    const W = ctx.window.NexusExt.WabbajackImporter;
    const md5 = (s) => W.md5Bytes(new Uint8Array(Buffer.from(s)));
    assert.equal(md5(''), 'd41d8cd98f00b204e9800998ecf8427e');
    assert.equal(md5('abc'), '900150983cd24fb0d6963f7d28e17f72');
    assert.equal(md5('The quick brown fox jumps over the lazy dog'), '9e107d9d372bb6826bd81d3542a419d6');
    for (const size of [55, 56, 63, 64, 65, 1000, 70000]) {
      const bytes = crypto.randomBytes(size);
      assert.equal(W.md5Bytes(new Uint8Array(bytes)), crypto.createHash('md5').update(bytes).digest('hex'), `md5 of ${size} bytes`);
    }
    // Chunked file reads give the same digest.
    const big = crypto.randomBytes(9 * 1024 * 1024 + 17);
    const file = { size: big.length, slice: (a, b) => ({ arrayBuffer: async () => big.subarray(a, b) }) };
    assert.equal(await W.md5File(file), crypto.createHash('md5').update(big).digest('hex'));
    const results = await W.identifyArchives([{ name: 'a.7z', ...file }], {
      api: { fileByMd5: async () => [{ modFile: { fileId: 5, name: 'Main', version: '1.0', mod: { modId: 9, name: 'Mod', game: { domainName: 'skyrimspecialedition' } } } }] }
    });
    assert.equal(results[0].match.url, 'https://www.nexusmods.com/skyrimspecialedition/mods/9?tab=files&file_id=5');
  }

  // ---- NDC: flag off keeps the legacy router call; flag on uses the API; update policy swap.
  {
    const src = fs.readFileSync('src/content/ndc.js', 'utf8');
    assert.match(src, /fetchModsLegacy\(collectionId, revision\)/);
    assert.match(src, /this\.useOfficialApi = settings\.UseOfficialApi !== false/);
    assert.match(src, /mods = await this\.applyUpdatePolicy\(mods\);/);
    const nnw = fs.readFileSync('src/content/nnw.js', 'utf8');
    assert.match(nnw, /cfg\.UseOfficialApi !== false/);
    const shared = fs.readFileSync('src/lib/shared.js', 'utf8');
    assert.match(shared, /UseOfficialApi: true,\s*FollowUpdatePolicy: false,\s*WriteMo2Meta: false,\s*ShowModActions: true/);
  }

  // ---- NDC behaviour with a stub API.
  {
    const ctx = vm.createContext({ console, URL, Intl, setTimeout, clearTimeout, Promise, JSON, Math, Date });
    ctx.window = ctx;
    ctx.document = { location: { href: 'https://www.nexusmods.com/' } };
    ctx.NXTK = { t: (_k, _s, fallback) => fallback, tPlural: (_k, _n, fallback) => fallback, escapeHtml: String };
    const legacyCalls = [];
    ctx.NexusExt = ctx.window.NexusExt = {
      Errors: {
        DEFAULT_TIMEOUT_MS: 30000,
        create: (code, extra = {}) => ({ code, ...extra }),
        classifyContent: () => null,
        request: async (url, options) => { legacyCalls.push({ url, body: JSON.parse(options.body) }); return ok({ data: { collectionRevision: { modFiles: [] } } }); }
      },
      Auth: {},
      Storage: {},
      UI: {}
    };
    vm.runInContext(fs.readFileSync('src/content/nexus-api.js', 'utf8'), ctx);
    vm.runInContext(fs.readFileSync('src/content/ndc.js', 'utf8'), ctx);
    const NDC = ctx.window.NexusExt.NDC;
    const mod = (fileId, updatePolicy, extra = {}) => ({
      fileId, optional: false, updatePolicy, version: '1.0',
      file: { fileId, name: `f${fileId}`, size: 10, version: '1.0', url: 'x', mod: { modId: 9, name: 'M', version: '2.0', game: { domainName: 'skyrimspecialedition', id: 1704 } } },
      ...extra
    });

    // Flag off: the pre-2.10 query to the router, nothing else.
    const off = new NDC('skyrimspecialedition', 'abc123', 3);
    off.loadRunSettings({ UseOfficialApi: false });
    assert.equal(off.api(), null);
    await off.fetchMods();
    assert.equal(legacyCalls.length, 1);
    assert.equal(legacyCalls[0].url, ctx.window.NexusExt.NexusApi.ROUTER_URL);
    assert.equal(legacyCalls[0].body.query, ctx.window.NexusExt.NexusApi.QUERIES.CollectionRevisionModsLegacy);
    assert.equal(await off.applyUpdatePolicy([mod(1, 'latest')]).then((m) => m[0].fileId), 1, 'flag off: never swaps');

    // Flag on, follow policy on: only latest/prefer entries are looked up and swapped.
    const lookups = [];
    const stubApi = {
      modFiles: async ({ modId }) => { lookups.push(modId); return [{ fileId: 1, groupId: 7, category: 'OLD_VERSION', date: 1 }, { fileId: 2, groupId: 7, category: 'MAIN', date: 2, name: 'new', version: '2.0', size: 20 }]; },
      collectionRevisionMods: async () => ok({ data: { collectionRevision: { revisionNumber: 3, latest: false, modFiles: [mod(1, 'latest')] } } }),
      collectionRevisions: async () => ok({ data: { collection: { revisions: [
        { revisionNumber: 3, revisionStatus: 'published' }, { revisionNumber: 5, revisionStatus: 'published' }, { revisionNumber: 6, revisionStatus: 'draft' }
      ] } } })
    };
    const on = new NDC('skyrimspecialedition', 'abc123', 3);
    on.loadRunSettings({ UseOfficialApi: true, FollowUpdatePolicy: true });
    on.api = () => stubApi;
    const swapped = await on.applyUpdatePolicy([mod(1, 'exact'), mod(1, 'latest'), mod(1, 'prefer'), mod(1, 'unknown')]);
    assert.deepEqual([...swapped].map((m) => m.fileId), [1, 2, 2, 1]);
    assert.equal(swapped[1].file.url, 'https://www.nexusmods.com/skyrimspecialedition/mods/9?tab=files&file_id=2');
    assert.equal(lookups.length, 2, 'exact and unknown policies cost no request');
    on.followUpdatePolicy = false;
    assert.equal((await on.applyUpdatePolicy([mod(1, 'latest')]))[0].fileId, 1, 'setting off: never swaps');

    const rev = await on.fetchMods();
    assert.equal(rev.revisionNumber, 3);
    on.loadedRevision = { number: 3 };
    assert.equal((await on.newerRevision()).revisionNumber, 5, 'newest published revision, drafts ignored');
    on.loadedRevision = { number: 5 };
    assert.equal(await on.newerRevision(), null);

    assert.equal(NDC.updateAvailable(mod(1, 'latest')), true, 'policy allows and Nexus is newer');
    assert.equal(NDC.updateAvailable(mod(1, 'exact')), false, 'exact pins never show it');
    assert.equal(NDC.updateAvailable({ ...mod(1, 'prefer'), api: { version: '1.0' } }), false, 'same version');
  }

    // ---- Attempt failures are quiet; only the final outcome is logged (2.10.2).
  {
    recorded.length = 0; debugEntries.length = 0;
    const h = harness({ responses: [netFail(), ok({ data: { a: 1 } })] });
    const r = await h.api.graphql({ query: 'q', operationName: 'Q' });
    assert.equal(r.ok, true);
    assert.equal(r.source, 'router');
    assert.equal(recorded.length, 0, 'a v2 network failure the router answered is not an error');
    assert.equal(debugEntries.length, 1, 'it goes to the debug log');
    assert.equal(debugEntries[0].level, 'debug');
    const h2 = harness({ responses: [netFail(), netFail()] });
    const r2 = await h2.api.graphql({ query: 'q', operationName: 'Q' });
    assert.equal(r2.ok, false);
    assert.equal(recorded.length, 1, 'all fallbacks failed: logged once');
    assert.equal(recorded[0].code, 'network_error');

    // E-0fk41cm / E-0fejmvr: "Loading mod files" failing in a background tab came in as a network
    // fault. The mod page works without it: a dropped connection there is a debug note, not an error.
    recorded.length = 0; debugEntries.length = 0;
    const quiet = harness({ responses: [netFail(), netFail()] });
    assert.equal(await quiet.api.modFiles({ modId: 1, gameId: 2 }), null);
    assert.equal(recorded.length, 0, 'an optional page enhancement does not log a connection failure');
    assert.ok(debugEntries.some((entry) => /ModFiles.*network_error/.test(entry.text)), 'it is noted in the debug log');
    const game = harness({ responses: [netFail(), netFail()] });
    assert.equal(await game.api.gameId('skyrim'), '');
    assert.equal(recorded.length, 0, 'nor does the game lookup the page falls back from');
  }

  // ---- v2 "not signed in" falls back to the session-backed router.
  {
    recorded.length = 0;
    const loggedOut = () => ({ ok: false, status: 200, text: '{"errors":[{"message":"not signed in"}]}', error: { code: 'requires_login' } });
    const h = harness({ responses: [loggedOut(), ok({ data: { collectionRevision: { modFiles: [] } } })] });
    const r = await h.api.graphql({ query: 'q', operationName: 'Q' });
    assert.equal(r.ok, true, 'the router answer counts');
    assert.equal(h.calls[1].url, NexusApi.ROUTER_URL);
    assert.equal(recorded.length, 0, 'no false requires_login in the error log');
  }

  // ---- Both say requires_login but the viewer query says signed in: not a login problem.
  {
    recorded.length = 0;
    const loggedOut = () => ({ ok: false, status: 200, text: '', error: { code: 'requires_login' } });
    const h = harness({ responses: [loggedOut(), loggedOut(), ok({ data: { preferences: { adult: false } } })] });
    const r = await h.api.graphql({ query: 'q', operationName: 'Q' });
    assert.equal(h.calls[2].body.operationName, 'Viewer');
    assert.equal(h.calls[2].url, NexusApi.ROUTER_URL, 'viewer check uses the site session');
    assert.equal(r.error.code, 'access_denied');
    assert.match(r.error.technicalMessage, /adult content hidden/);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].code, 'access_denied');
    // Signed out for real: requires_login stands and is logged once.
    recorded.length = 0;
    const h2 = harness({ responses: [loggedOut(), loggedOut(), ok({ errors: [{ message: 'You must be logged in to retrieve user preferences', extensions: { code: 'UNAUTHORIZED' } }], data: { preferences: null } })] });
    const r2 = await h2.api.graphql({ query: 'q', operationName: 'Q' });
    assert.equal(r2.error.code, 'requires_login');
    assert.equal(recorded.length, 1);
    const who = await h2.api.viewer();
    assert.equal(who.signedIn, false);
    assert.equal(h2.calls.length, 3, 'viewer answer is cached');
  }

  console.log('nexus api behavior OK');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
