const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture({ privateReports = false } = {}) {
  const context = vm.createContext({ URL, Date, console, setTimeout, clearTimeout, AbortController, structuredClone,
    crypto: require('node:crypto').webcrypto, TextEncoder,
    navigator: { userAgent: 'Mozilla/5.0 Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0' } });
  for (const name of ['shared.js', 'auto-reports.js']) vm.runInContext(fs.readFileSync(`src/${name}`, 'utf8'), context);
  const kit = context.NXTK;
  const { Reporter, DiagnosticsReporter, KEY: LEGACY_KEY, DIAGNOSTICS_KEY, WINDOW, NETWORK_WINDOW } = context.NXTKAutoReports;
  const SelectedReporter = privateReports ? DiagnosticsReporter : Reporter;
  const KEY = privateReports ? DIAGNOSTICS_KEY : LEGACY_KEY;
  const store = { [kit.SETTINGS_KEY]: { AutoErrorReports: false } };
  let now = Date.UTC(2026, 9, 14, 12);
  let delivery = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
  const sent = [];
  const alarms = [];
  const readErrors = new Map();
  const deps = {
    kit, read: async (key, fallback, { strict = false } = {}) => {
      const failure = readErrors.get(key);
      if (failure && failure.skip-- <= 0) {
        readErrors.delete(key);
        if (strict) throw new Error('storage read failed');
        return fallback;
      }
      return structuredClone(store[key] ?? fallback);
    },
    write: async (key, value) => { store[key] = structuredClone(value); }, clock: () => now,
    api: {
      runtime: { getManifest: () => ({ version: '3.1.1' }) },
      alarms: { create: async (name, value) => { alarms.push({ name, ...value }); }, clear: async () => {} }
    },
    fetchImpl: async (url, init) => { sent.push({ url, payload: JSON.parse(init.body), init }); return delivery(url, init); }
  };
  let reporter = new SelectedReporter(deps);
  return {
    kit, KEY, WINDOW, NETWORK_WINDOW, store, sent, alarms, get reporter() { return reporter; },
    enable: () => { store[kit.SETTINGS_KEY].AutoErrorReports = true; },
    enablePrivate: () => { store[kit.SETTINGS_KEY].AutoErrorReports = true; store[kit.SETTINGS_KEY].PrivateDiagnostics = true; },
    disable: () => { store[kit.SETTINGS_KEY].AutoErrorReports = false; },
    advance: (ms) => { now += ms; }, delivery: (fn) => { delivery = fn; }, restart: () => { reporter = new SelectedReporter(deps); },
    failReadOnce: (key, skip = 0) => { readErrors.set(key, { skip }); },
    entry: (overrides = {}) => kit.buildErrorEntry({ code: 'nexus_api_changed', context: 'Reading collection response', ...overrides })
  };
}

async function run() {
  for (const privateReports of [false, true]) {
    for (const failedRead of ['queue', 'settings', 'delivery-settings']) {
      const f = fixture({ privateReports });
      if (privateReports) f.enablePrivate(); else f.enable();
      f.store[f.kit.SETTINGS_KEY].AutoReportDiagnostics = true;
      f.store[f.kit.DEBUG_LOG_KEY] = [{ at: Date.UTC(2026, 9, 14, 12) - 1000,
        page: 'extension', text: 'Before the failed request' }];
      f.delivery(async () => { throw new TypeError('connection lost'); });
      await f.reporter.enqueue(f.entry()); await f.reporter.flush();
      const saved = structuredClone(f.store[f.KEY]);
      const original = f.sent[0].payload;
      f.restart(); f.advance(60000);
      f.alarms.length = 0; // The one-shot alarm was consumed before its listener called flush().
      f.failReadOnce(failedRead === 'queue' ? f.KEY : f.kit.SETTINGS_KEY,
        failedRead === 'delivery-settings' ? 1 : 0);
      await assert.rejects(f.reporter.flush(), /storage read failed/,
        `${failedRead}: unreadable storage must not be treated as an empty queue or revoked consent`);
      assert.deepEqual(f.store[f.KEY], saved, `${failedRead}: a failed read preserves the durable report`);
      assert.equal(f.sent.length, 1, `${failedRead}: no delivery is attempted without readable consent and state`);
      assert.equal(f.alarms.length, 1, `${failedRead}: a consumed alarm is replaced after the transient failure`);
      assert.equal(f.alarms[0].name, f.reporter.alarm);
      assert.equal(f.alarms[0].when, Date.UTC(2026, 9, 14, 12) + 120000, 'storage recovery is retried in one minute');
      f.delivery(async (_url, init) => ({ ok: true, json: async () => ({ ok: true,
        ...(privateReports ? { report_id: JSON.parse(init.body).report_id } : {}) }) }));
      await f.reporter.flush();
      assert.deepEqual(f.sent[1].payload, original, `${failedRead}: recovery retries the original report`);
      assert.equal(f.store[f.KEY].pending.length, 0, `${failedRead}: recovered storage permits delivery`);
    }
    {
      const f = fixture({ privateReports });
      if (privateReports) f.enablePrivate(); else f.enable();
      f.delivery(async () => { throw new TypeError('connection lost'); });
      await f.reporter.enqueue(f.entry()); await f.reporter.flush();
      f.alarms.length = 0;
      f.disable(); await f.reporter.flush();
      assert.equal(f.alarms.length, 0, 'explicitly revoked consent does not arm a recovery alarm');
      assert.equal(f.store[f.KEY].pending.length, 0);
    }
    {
      const f = fixture({ privateReports });
      if (privateReports) f.enablePrivate(); else f.enable();
      f.delivery(async () => { throw new TypeError('connection lost'); });
      await f.reporter.enqueue(f.entry()); await f.reporter.flush();
      f.alarms.length = 0;
      const read = f.reporter.read;
      let stopped;
      f.reporter.read = async () => {
        f.reporter.read = read;
        stopped = f.reporter.stop();
        throw new Error('storage read failed');
      };
      await assert.rejects(f.reporter.flush(), /storage read failed/);
      await stopped;
      assert.equal(f.alarms.length, 0, 'stopping a failed flush does not resurrect its retry alarm');
      assert.equal(f.store[f.KEY].pending.length, 0);
    }
  }
  {
    const f = fixture({ privateReports: true });
    f.enable();
    assert.equal(await f.reporter.enqueue(f.entry()), false, 'legacy basic consent never creates private diagnostics');
    f.store[f.kit.SETTINGS_KEY].AutoReportDiagnostics = true;
    assert.equal(await f.reporter.enqueue(f.entry()), false, 'legacy extended consent is not diagnostics-v1 consent');
    assert.equal(f.sent.length, 0);
    f.enablePrivate();
    f.delivery(async () => { throw new TypeError('connection lost after server acceptance'); });
    await f.reporter.enqueue(f.entry({ code: 'nexus_api_changed', technicalMessage: 'jane@example.com token=SECRET https://example.com/?key=PRIVATE' }));
    await f.reporter.flush();
    assert.equal(f.sent.length, 1);
    const body = f.sent[0].payload;
    assert.equal(f.sent[0].url, f.kit.RELAY_ORIGIN + '/v1/diagnostics');
    assert.equal(f.sent[0].init.credentials, 'omit');
    assert.equal(f.sent[0].init.redirect, 'error');
    assert.equal(body.consent, 'diagnostics-v1');
    assert.equal(body.browser, 'edge');
    assert.equal(body.browser_version, '155');
    assert.equal(body.error_category, 'API_SCHEMA_MISMATCH');
    assert.match(body.report_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(body.install_id, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(JSON.stringify(body), /jane|SECRET|PRIVATE/);
    f.restart(); f.advance(60000);
    f.delivery(async (_url, init) => ({ ok: true, json: async () => ({ ok: true, report_id: JSON.parse(init.body).report_id, duplicate: true }) }));
    await f.reporter.flush();
    assert.deepEqual(f.sent[1].payload, body, 'restarted retries preserve exact UUID and sanitized body');
    assert.equal(f.store[f.KEY].pending.length, 0);
    await f.reporter.enqueue(f.entry({ code: 'background_error', technicalMessage: 'new incident' }));
    await f.reporter.flush();
    assert.equal(f.sent[2].payload.install_id, body.install_id, 'installation identity survives distinct reports');
    assert.notEqual(f.sent[2].payload.report_id, body.report_id, 'distinct reports have distinct UUIDs');
    assert.equal(f.store[f.KEY].pending.length, 0, 'each distinct report requires its own acknowledgement');
  }
  {
    const f = fixture(); f.enablePrivate();
    assert.equal(await f.reporter.enqueue(f.entry()), false, 'private reporting never duplicates a legacy Discord delivery');
    const d = fixture({ privateReports: true }); d.enablePrivate();
    d.delivery(async () => { throw new TypeError('offline'); });
    await d.reporter.enqueue(d.entry()); await d.reporter.flush();
    assert.equal(d.store[d.KEY].pending.length, 1);
    d.store[d.kit.SETTINGS_KEY].PrivateDiagnostics = false;
    d.advance(60000); await d.reporter.flush();
    assert.equal(d.store[d.KEY].pending.length, 0, 'revocation removes private queued payloads before retry');
    assert.equal(d.sent.length, 1, 'revoked consent never falls back to another destination');
  }
  {
    const f = fixture(); f.enable();
    for (const context of 'ABCDEFGHIJ') { await f.reporter.enqueue(f.entry({ context })); await f.reporter.flush(); }
    assert.equal(f.sent.length, 10);
    await f.reporter.stop();
    assert.equal(f.store[f.KEY].count, 10, 'revoking consent must not reset the daily delivery budget');
    await f.reporter.enqueue(f.entry({ context: 'K' })); await f.reporter.flush();
    assert.equal(f.sent.length, 10, 'the eleventh report still waits until tomorrow');
  }
  {
    const f = fixture(); f.enable();
    const at = Date.UTC(2026, 9, 14, 12);
    f.store[f.kit.DEBUG_LOG_KEY] = [
      { at: at - 180000, level: 'info', page: 'mod', text: 'too old' },
      { at: at - 1000, level: 'info', page: 'collection', text: 'another page type' },
      { at: at - 1000, level: 'debug', page: 'mod', text: 'Generating link jane@example.com token=SECRET https://example.com/?key=PRIVATE' }
    ];
    const entry = f.entry({ code: 'no_nmm_link', at, url: 'https://www.nexusmods.com/skyrimspecialedition/mods/194279',
      fileIdentity: { expectedId: '7318625091714', receivedId: '819330', unexpected: 'SECRET' } });
    await f.reporter.enqueue(entry); await f.reporter.flush();
    assert.equal(f.sent[0].payload.diagnostics, undefined, 'existing basic consent never expands into logs or file IDs');
    f.store[f.kit.SETTINGS_KEY].AutoReportDiagnostics = true;
    await f.reporter.enqueue(entry); f.advance(f.WINDOW); await f.reporter.flush();
    const details = f.sent[1].payload.diagnostics;
    assert.equal(details.consent, 'extended-v1');
    assert.equal(details.file.expectedId, '7318625091714');
    assert.equal(details.file.receivedId, '819330');
    assert.equal(details.logs.length, 1, 'only recent lines of the same page type are captured at the incident');
    assert.doesNotMatch(JSON.stringify(details), /jane|SECRET|PRIVATE|too old|another page type|unexpected/);
    await f.reporter.enqueue(entry); await f.reporter.flush();
    f.store[f.kit.SETTINGS_KEY].AutoReportDiagnostics = false;
    f.advance(f.WINDOW); await f.reporter.flush();
    assert.equal(f.sent.at(-1).payload.diagnostics, undefined, 'revoking extended consent strips previously queued diagnostics');
    f.disable(); await f.reporter.enqueue(entry); await f.reporter.flush();
    assert.equal(f.sent.length, 3, 'No still means no basic or extended report');
  }
  {
    const f = fixture(); f.enable();
    f.store[f.kit.SETTINGS_KEY].AutoReportDiagnostics = true;
    const at = Date.UTC(2026, 9, 14, 12);
    f.store[f.kit.DEBUG_LOG_KEY] = [
      { at: at - 1000, page: 'mod', text: 'before incident' },
      { at: at + 1000, page: 'mod', text: 'after incident' }
    ];
    f.advance(90000);
    await f.reporter.enqueue(f.entry({ at, url: 'https://www.nexusmods.com/x/mods/1' })); await f.reporter.flush();
    assert.equal(f.sent[0].payload.diagnostics.logs.length, 1);
    assert.equal(f.sent[0].payload.diagnostics.logs[0].text, 'before incident', 'snapshot is anchored to the incident, not delayed processing');
  }
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
    assert.equal(f.store[f.KEY].pending.length, 0, 'opt-out aborts and discards pending data');
    assert.equal(f.store[f.KEY].attempts, 1, 'delivery bookkeeping survives revocation');
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
    assert.equal(f.store[f.KEY].pending.length, 0, 'opt-out discards pending reports');
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
    // Discord: "Loading mod files" and "Loading collection details" both arrived as "... [id]".
    const words = f.kit.autoReportDetails(f.entry({ context: 'Loading mod files', technicalMessage: 'links only for other files; the nxm link names another file' }));
    assert.equal(words.error.context, 'Loading mod files', 'a word the extension wrote is not an identifier');
    assert.equal(words.error.message, 'links only for other files; the nxm link names another file');
    assert.equal(f.kit.autoReportDetails(f.entry({ context: 'Loading collection details' })).error.context, 'Loading collection details');
    assert.equal(f.kit.autoReportDetails(f.entry({ context: 'Loading collection qlplbx' })).error.context, 'Loading collection [id]', 'a slug is');
    assert.equal(f.kit.autoReportDetails(f.entry({ context: 'Loading Mod 2394' })).error.context, 'Loading Mod [id]');
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
