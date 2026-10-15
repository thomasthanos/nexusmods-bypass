const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
  const context = vm.createContext({ URL, Date, console, setTimeout, clearTimeout, AbortController, structuredClone,
    navigator: { userAgent: 'Mozilla/5.0 Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0' } });
  for (const name of ['shared.js', 'auto-reports.js']) vm.runInContext(fs.readFileSync(`src/${name}`, 'utf8'), context);
  const kit = context.NXTK;
  const { Reporter, KEY, WINDOW, NETWORK_WINDOW } = context.NXTKAutoReports;
  const store = { [kit.SETTINGS_KEY]: { AutoErrorReports: false } };
  let now = Date.UTC(2026, 9, 14, 12);
  let delivery = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
  const sent = [];
  const alarms = [];
  const deps = {
    kit, read: async (key, fallback) => structuredClone(store[key] ?? fallback),
    write: async (key, value) => { store[key] = structuredClone(value); }, clock: () => now,
    api: {
      runtime: { getManifest: () => ({ version: '3.1.1' }) },
      alarms: { create: async (name, value) => { alarms.push({ name, ...value }); }, clear: async () => {} }
    },
    fetchImpl: async (url, init) => { sent.push({ url, payload: JSON.parse(init.body), init }); return delivery(url, init); }
  };
  let reporter = new Reporter(deps);
  return {
    kit, KEY, WINDOW, NETWORK_WINDOW, store, sent, alarms, get reporter() { return reporter; },
    enable: () => { store[kit.SETTINGS_KEY].AutoErrorReports = true; },
    disable: () => { store[kit.SETTINGS_KEY].AutoErrorReports = false; },
    advance: (ms) => { now += ms; }, delivery: (fn) => { delivery = fn; }, restart: () => { reporter = new Reporter(deps); },
    entry: (overrides = {}) => kit.buildErrorEntry({ code: 'nexus_api_changed', context: 'Reading collection response', ...overrides })
  };
}

async function run() {
  {
    const f = fixture();
    assert.equal(await f.reporter.enqueue(f.entry()), false);
    f.enable();
    assert.equal(await f.reporter.enabled(), true, 'opt-in is enough: no permissions API is required');
    for (const code of ['offline', 'aborted', 'requires_login', 'rate_limited', 'context_invalid']) {
      assert.equal(await f.reporter.enqueue(f.entry({ code })), false, `${code} stays local`);
    }
    assert.equal(await f.reporter.enqueue(f.entry({ code: 'queue_item_failed', causeCode: 'USER_CANCELED' })), false);
    await f.reporter.enqueue(f.entry()); await f.reporter.flush();
    await f.reporter.enqueue(f.entry({ code: 'uncaught_exception' })); await f.reporter.flush();
    assert.equal(f.sent.length, 2, 'distinct bugs send immediately, even seconds apart');
    assert.equal(f.sent[0].payload.browser, 'Edge 155');
    assert.equal(f.sent[0].payload.page, 'extension');
    assert.equal(f.sent[0].init.credentials, 'omit');
    assert.equal(f.store[f.KEY].count, 2);
    assert.equal(f.store[f.KEY].pending.length, 0);
    for (let i = 0; i < 4; i += 1) await f.reporter.enqueue(f.entry());
    await f.reporter.flush();
    assert.equal(f.sent.length, 2, 'repeats wait for their own summary window');
    assert.equal(f.store[f.KEY].pending[0].payload.occurrences, 4);
    f.advance(f.WINDOW); await f.reporter.flush();
    assert.equal(f.sent.length, 3);
    assert.equal(f.sent[2].payload.occurrences, 4);
  }
  {
    for (const entry of [{ code: 'network_error' }, { code: 'queue_item_failed', causeCode: 'timeout' }]) {
      const f = fixture(); f.enable();
      await f.reporter.enqueue(f.entry(entry)); await f.reporter.flush();
      await f.reporter.enqueue(f.entry(entry)); await f.reporter.flush();
      f.advance(f.WINDOW); f.restart(); await f.reporter.flush();
      assert.equal(f.sent.length, 1, 'network repeats do not send hourly, including after restart');
      // An existing pending report created with the old ten-minute policy is also held back.
      f.store[f.KEY].pending[0].nextAt = 0;
      await f.reporter.flush();
      assert.equal(f.sent.length, 1, 'stored pending diagnostics respect the new repeat policy');
      f.advance(f.NETWORK_WINDOW - f.WINDOW); await f.reporter.flush();
      assert.equal(f.sent.length, 2, 'network repeats are summarised after six hours');
      assert.equal(f.sent[1].payload.occurrences, 1);
      assert.equal(f.sent[1].payload.error.causeCode, entry.causeCode || '');
    }
  }
  {
    const f = fixture(); f.enable();
    f.delivery(async () => { throw new TypeError('offline'); });
    await f.reporter.enqueue(f.entry()); await f.reporter.flush();
    assert.equal(f.store[f.KEY].count, 0, 'failed delivery is not a sent report');
    assert.equal(Object.keys(f.store[f.KEY].sent).length, 0);
    assert.equal(f.store[f.KEY].pending.length, 1);
    assert.ok(f.alarms.length > 0, 'a persisted retry is armed');
    f.restart(); f.advance(60000);
    f.delivery(async () => ({ ok: true, json: async () => ({ ok: true, duplicate: true }) }));
    await f.reporter.flush();
    assert.equal(f.store[f.KEY].count, 1);
    assert.equal(f.store[f.KEY].pending.length, 0, 'relay acknowledgement completes delivery after restart');
  }
  {
    const f = fixture(); f.enable();
    f.delivery(async () => ({ ok: false, status: 429, headers: { get: () => '3600' } }));
    await f.reporter.enqueue(f.entry()); await f.reporter.flush();
    await f.reporter.enqueue(f.entry({ code: 'background_error' })); await f.reporter.flush();
    assert.equal(f.sent.length, 1, '429 cools down new errors too');
    f.advance(3600000); f.delivery(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    await f.reporter.flush();
    assert.equal(f.sent[1].payload.severity, 'critical', 'crashes go first after cooldown');
    assert.equal(f.store[f.KEY].pending.length, 0);
  }
  {
    const f = fixture(); f.enable();
    await Promise.all(Array.from({ length: 12 }, (_, i) => f.reporter.enqueue(f.entry({ context: `stage ${String.fromCharCode(65 + i)}` }))));
    await f.reporter.flush();
    assert.equal(f.store[f.KEY].count, 10, 'concurrent faults obey the daily success cap');
    assert.equal(f.store[f.KEY].pending.length, 2, 'excess new bugs remain queued');
    f.advance(12 * 3600000); await f.reporter.flush();
    assert.equal(f.store[f.KEY].count, 2, 'daily allowance resets at midnight UTC');
  }
  {
    const f = fixture(); f.enable();
    let started;
    const inFlight = new Promise((resolve) => { started = resolve; });
    f.delivery((_url, init) => new Promise((resolve) => {
      started();
      init.signal.addEventListener('abort', () => resolve({ ok: false, status: 0 }), { once: true });
    }));
    await f.reporter.enqueue(f.entry()); await inFlight;
    f.disable(); await f.reporter.stop();
    assert.deepEqual(f.store[f.KEY], {}, 'opt-out aborts and discards pending data');
    await f.reporter.flush(); assert.equal(f.sent.length, 1, 'no sends after opt-out');
  }
  {
    const f = fixture(); f.enable();
    let release;
    let started;
    const inFlight = new Promise((resolve) => { started = resolve; });
    f.delivery(() => new Promise((resolve) => { release = resolve; started(); }));
    await f.reporter.enqueue(f.entry()); await inFlight;
    await Promise.all(Array.from({ length: 3 }, () => f.reporter.enqueue(f.entry())));
    assert.equal(f.store[f.KEY].pending[0].payload.occurrences, 4, 'slow delivery does not block recording new occurrences');
    release({ ok: true, json: async () => ({ ok: true }) }); await f.reporter.flush();
    assert.equal(f.store[f.KEY].pending[0].payload.occurrences, 3, 'only the acknowledged snapshot is removed');
    f.advance(f.WINDOW); f.delivery(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    await f.reporter.flush(); assert.equal(f.sent[1].payload.occurrences, 3);
  }
  {
    const f = fixture(); f.enable();
    f.delivery(async () => ({ ok: true, json: async () => ({ ok: false }) }));
    await f.reporter.enqueue(f.entry()); await f.reporter.flush();
    assert.equal(f.store[f.KEY].count, 0, 'HTTP 200 without acknowledgement is not delivered');
    f.disable(); await f.reporter.flush();
    assert.deepEqual(f.store[f.KEY], {}, 'opt-out discards pending reports');
  }
  {
    const f = fixture(); f.enable();
    f.delivery(async () => ({ ok: false, status: 422 }));
    await f.reporter.enqueue(f.entry()); await f.reporter.flush();
    assert.equal(f.store[f.KEY].pending.length, 0, 'invalid payloads do not retry forever');
    assert.equal(f.store[f.KEY].count, 0);
  }
  {
    const f = fixture(); f.enable();
    f.delivery(async () => ({ ok: false, status: 503 }));
    for (let i = 0; i < 20; i += 1) {
      await f.reporter.enqueue(f.entry({ context: `stage ${String.fromCharCode(65 + i)}` }));
      await f.reporter.flush();
    }
    assert.equal(f.store[f.KEY].pending.length, 20, 'the persisted queue is bounded');
    assert.equal(await f.reporter.enqueue(f.entry({ context: 'another ordinary fault' })), false);
    assert.equal(await f.reporter.enqueue(f.entry({ code: 'uncaught_exception' })), true, 'a new crash replaces an ordinary pending fault when full');
    await f.reporter.flush();
    assert.equal(f.store[f.KEY].pending.length, 20);
    assert.ok(f.store[f.KEY].pending.some((p) => p.payload.severity === 'critical'));
    f.advance(24 * 3600000 + 1); await f.reporter.flush();
    assert.equal(f.store[f.KEY].pending.length, 0, 'expired diagnostics are removed');
  }
  {
    const f = fixture(); f.enable();
    const raw = f.entry({ context: 'Downloading queued file 123 for game skyrim',
      technicalMessage: 'mail jane@example.com Bearer abc123 /home/jane/file https://www.nexusmods.com/mods/123?token=SECRET',
      url: 'https://www.nexusmods.com/games/skyrim/collections/secret-slug',
      stack: 'Error\n at chrome-extension://user-install-id/content/ndc.js:42:5' });
    await f.reporter.enqueue(raw); await f.reporter.flush();
    const json = JSON.stringify(f.sent[0].payload);
    assert.doesNotMatch(json, /jane|SECRET|secret-slug|user-install-id|Bearer abc123|\/mods\/123/);
    assert.equal(f.sent[0].payload.page, 'collection');
    assert.equal(f.sent[0].payload.error.frame, 'content/ndc.js:42:5');
    assert.equal(f.kit.errorReference(raw), f.kit.errorReference(f.entry({ ...raw, context: 'Downloading queued file 456 for game fallout' })), 'identifiers do not fragment the same fault');
  }
  {
    // A 503 that says when to come back pauses the queue like a 429; one that does not is retried.
    const f = fixture(); f.enable();
    f.delivery(async () => ({ ok: false, status: 503, headers: { get: (name) => (name === 'retry-after' ? '600' : null) } }));
    await f.reporter.enqueue(f.entry()); await f.reporter.flush();
    const state = f.store[f.KEY];
    assert.equal(state.pending.length, 1);
    assert.equal(state.cooldownUntil - Date.UTC(2026, 9, 14, 12), 600000, 'Retry-After on a 503 is honoured');
    // Discord throttling relayed as 429 + Retry-After pauses everything for that long.
    const g = fixture(); g.enable();
    g.delivery(async () => ({ ok: false, status: 429, headers: { get: (name) => (name === 'retry-after' ? '43' : null) } }));
    await g.reporter.enqueue(g.entry()); await g.reporter.flush();
    assert.equal(g.store[g.KEY].cooldownUntil - Date.UTC(2026, 9, 14, 12), 60000, 'never sooner than a minute');
  }
  {
    // Damaged entries in storage are dropped instead of stopping the queue.
    const f = fixture(); f.enable();
    f.store[f.KEY] = { pending: [null, 'x', { fingerprint: 'a' }, { payload: {} }] };
    await f.reporter.enqueue(f.entry()); await f.reporter.flush();
    assert.equal(f.sent.length, 1, 'the queue still delivers');
    assert.equal(f.store[f.KEY].pending.length, 0);
  }
  console.log('Auto-report tests passed: opt-in, durable retries, aggregation, caps, opt-out and redaction.');
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
