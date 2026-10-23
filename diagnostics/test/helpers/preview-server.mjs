// Development-only preview: synthetic in-memory data, real Hono routes, SQLite,
// and signed Access JWTs. No runtime authentication bypass is added to the Worker.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import worker from '../../src/index.ts';
import { errorReportSchema, heartbeatSchema, relayedReportSchema, storedRelayedReport } from '../../src/schemas/ingest.ts';
import { acceptErrorReport, acceptHeartbeat } from '../../src/services/ingestion.ts';
import { bindings } from './access.mjs';
import { createTestDatabase } from './d1.mjs';

const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const install = (number) => number.toString(16).padStart(64, '0');

export async function startPreviewServer() {
  const db = createTestDatabase();
  const now = Date.now();
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const kid = crypto.randomUUID();
  const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid, alg: 'RS256', use: 'sig' };
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT', kid })}.${encode({ iss: 'https://fixture.cloudflareaccess.com', aud: ['fixture-application-audience'], sub: 'local-preview-fixture', exp: Math.floor(now / 1000) + 3600, nbf: Math.floor(now / 1000) - 10, iat: Math.floor(now / 1000) - 10 })}`;
  const token = `${unsigned}.${Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(unsigned))).toString('base64url')}`;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === 'https://fixture.cloudflareaccess.com/cdn-cgi/access/certs') return Response.json({ keys: [jwk] });
    if (url === 'https://api.github.com/repos/thomasthanos/nexusmods-bypass/issues?state=open&sort=updated&direction=desc&per_page=100&page=1') return Response.json([
      { number: 34, title: 'Changing the download folder', html_url: 'https://github.com/thomasthanos/nexusmods-bypass/issues/34', state: 'open', labels: [{ name: 'question' }], created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-22T11:00:00Z', comments: 2 }
    ]);
    if (url === 'https://github.com/thomasthanos/nexusmods-bypass/discussions.atom') return new Response('<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Discussions</title><id>https://github.com/thomasthanos/nexusmods-bypass/discussions</id><updated>2026-10-22T11:00:00Z</updated><entry><id>https://github.com/thomasthanos/nexusmods-bypass/discussions/35</id><title>Collection troubleshooting</title><link rel="alternate" href="https://github.com/thomasthanos/nexusmods-bypass/discussions/35"/><updated>2026-10-22T11:00:00Z</updated></entry></feed>', { headers: { 'content-type': 'application/atom+xml; charset=utf-8' } });
    throw new Error('External delivery is disabled in the synthetic preview');
  };
  const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const env = bindings(db, { VAPID_PUBLIC_KEY: Buffer.from(await crypto.subtle.exportKey('raw', vapid.publicKey)).toString('base64url'),
    VAPID_PRIVATE_KEY: (await crypto.subtle.exportKey('jwk', vapid.privateKey)).d,
    ASSETS: { async fetch(request) {
      const pathname = new URL(request.url).pathname;
      const name = pathname === '/' ? 'index.html' : pathname.slice(1);
      if (!/^(?:index\.html|(?:app|lib|push|growth|sw)\.js|app\.css|manifest\.json|icons\/[a-z0-9-]+\.(?:png|svg))$/.test(name)) return new Response('Not found', { status: 404 });
      try {
        let content = await readFile(new URL(`../../public/${name}`, import.meta.url));
        if (name === 'index.html') content = Buffer.from(content.toString().replace('<body>', '<body><aside style="padding:8px 20px;background:#efb768;color:#10111a;text-align:center;font:600 12px system-ui">Local preview · synthetic verification data</aside>'));
        const extension = name.split('.').at(-1);
        const type = { html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/manifest+json', svg: 'image/svg+xml', png: 'image/png' }[extension];
        return new Response(content, { headers: { 'content-type': type, 'cache-control': 'no-store' } });
      } catch { return new Response('Not found', { status: 404 }); }
    } }
  });
  const ids = {};
  async function seed(label, count, overrides) {
    for (let index = 1; index <= count; index++) {
      const payload = errorReportSchema.parse({ schema_version: 1, consent: 'diagnostics-v1', report_id: crypto.randomUUID(), install_id: install(index % 5 + 1),
        occurred_at: new Date(now - 30_000).toISOString(), version: index % 2 ? '3.2.1' : '3.2.0', browser: 'firefox', browser_version: '144.0', os: 'windows', os_version: '11',
        download_mode: 'auto', destination: 'browser', severity: 'error', error_category: 'DOM_SELECTOR_MISSING', error_code: 'COLLECTION_HOST_MISSING', failure_stage: 'COLLECTION_PAGE_READY',
        error_message: 'Missing collection host after the download panel loaded', stack_trace: 'findCollectionHost@moz-extension://fixture/content/collections.js:82:14',
        breadcrumbs: [
          { timestamp_offset_ms: 0, stage: 'UI', action: 'UI_CLICK_DOWNLOAD', status: 'ok' },
          { timestamp_offset_ms: 14, stage: 'PRIMARY_API_REQUEST', action: 'GET_DOWNLOAD_METADATA', status: 'warn', http_status: 429, duration_ms: 310, metadata: { retry_after: '3' } },
          { timestamp_offset_ms: 330, stage: 'FALLBACK_API_REQUEST', action: 'READ_ALTERNATE_API', status: 'ok', http_status: 200, duration_ms: 420 },
          { timestamp_offset_ms: 752, stage: 'DOM', action: 'FIND_COLLECTION_HOST', status: 'error', duration_ms: 5020, metadata: { selector: '.collection-download-host', matched: false } }
        ], dom_state: { document_ready_state: 'complete', page_kind: 'collection', collection_host_present: false, selectors: [{ selector: '.collection-download-host', matched: false, match_count: 0 }] }, context: { online: true }, ...overrides });
      ids[label] = (await acceptErrorReport(db, payload, now - 10_000 + index)).issueId;
    }
  }
  await seed('upstream', 13, {});
  await seed('handoff', 4, { destination: 'vortex', browser: 'chrome', error_category: 'HANDOFF_FAILURE', error_code: 'NXM_HANDOFF_TIMEOUT', failure_stage: 'VORTEX_NXM_HANDOFF_FAILED', error_message: 'Vortex protocol handler did not respond within 5000 ms' });
  db.sqlite.prepare("UPDATE issues SET status='regressed',fixed_in_version='3.2.0' WHERE id=?").run(ids.handoff);
  // Two copies the relay made of the same fault from the Discord path: no installation or OS.
  for (const index of [1, 2]) {
    await acceptErrorReport(db, storedRelayedReport(relayedReportSchema.parse({ schema_version: 1, consent: 'automatic-v1', report_id: crypto.randomUUID(),
      occurred_at: new Date(now - 20_000).toISOString(), version: '3.2.1', browser: 'opera', browser_version: '124', download_mode: 'auto',
      destination: 'vortex', severity: 'error', error_category: 'HANDOFF_FAILURE', error_code: 'NXM_HANDOFF_TIMEOUT', failure_stage: 'VORTEX_NXM_HANDOFF_FAILED',
      error_message: 'Vortex protocol handler did not respond within 5000 ms', stack_trace: 'findCollectionHost@moz-extension://fixture/content/collections.js:82:14' })), now - 5_000 + index);
  }
  await seed('network', 2, { error_category: 'NETWORK', error_code: 'FETCH_FAILED', failure_stage: 'PRIMARY_API_REQUEST', error_message: 'Failed to fetch <img src=x onerror=window.__diagnosticsXss=true>', severity: 'warning', dom_state: undefined });
  await seed('fixed', 1, { error_category: 'EXTENSION_CONFLICT', error_code: 'DOWNLOAD_UI_HIJACKED', failure_stage: 'UI_BINDING', error_message: 'Another extension owns the download button' });
  db.sqlite.prepare("UPDATE issues SET status='fixed',fixed_in_version='3.2.1' WHERE id=?").run(ids.fixed);
  const metricDate = new Date(now).toISOString().slice(0, 10);
  for (const [version, attempts_count, success_count, fallback_triggered_count] of [['3.1.9', 10000, 9700, 1230], ['3.2.0', 12000, 11820, 1068], ['3.2.1', 10000, 9910, 840]]) {
    await acceptHeartbeat(db, heartbeatSchema.parse({ schema_version: 1, consent: 'telemetry-v1', heartbeat_id: crypto.randomUUID(), install_id: install(1), metric_date: metricDate, version, browser: 'firefox', destination: 'browser', attempts_count, success_count, fallback_triggered_count }), now);
  }
  let authenticated = true;
  let accessRedirect = false;
  const pending = new Set();
  const server = createServer(async (incoming, outgoing) => {
    try {
      if (accessRedirect && new URL(incoming.url, 'http://preview.invalid').pathname.startsWith('/api/admin/')) {
        outgoing.writeHead(302, { location: '/cdn-cgi/access/login', 'cache-control': 'no-store' });
        outgoing.end();
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      if (authenticated) headers.set('Cf-Access-Jwt-Assertion', token);
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const url = `http://127.0.0.1:${server.address().port}${incoming.url}`;
      const request = new Request(url, { method: incoming.method, headers, ...(body.length ? { body } : {}) });
      const path = new URL(url).pathname;
      // Browser fixtures never call Google Analytics or the public store. The
      // real Worker still verifies Access for the page and every other route.
      let response;
      if (authenticated && request.method === 'GET' && path === '/api/admin/analytics') response = Response.json({ property_id: '547084285', source: 'ga4_store_listing', state: 'not_configured', fetched_at: null, online_30m: null, weekly_active: null, previous_weekly_active: null, weekly_change_percent: null, history_total_users: null, history_start_date: null, time_zone: null, quality: { subject_to_thresholding: false, sampled: false, data_loss: false }, message: null });
      else if (authenticated && request.method === 'GET' && path === '/api/admin/store') response = Response.json({ state: 'ready', snapshot: { extension_id: 'chfghiknjhpcncpcjopglefnckckdlpj', store_url: 'https://chromewebstore.google.com/detail/nexusmods-bypass/chfghiknjhpcncpcjopglefnckckdlpj', version: '3.2.1', users: 4321, rating_average: 4.5, rating_count: 12, written_review_count: 0, latest_release_version: '3.2.1', latest_release_url: 'https://github.com/thomasthanos/nexusmods-bypass/releases/tag/v3.2.1', version_status: 'up_to_date', fetched_at: now, reviews_complete: true }, reviews: [], new_review_count: 0, last_checked_at: now, sync_interval_seconds: 900, stale: false, message: null });
      else if (authenticated && request.method === 'POST' && path === '/api/admin/store/reviews/ack') response = Response.json({ ok: true });
      else response = await worker.fetch(request, env, { waitUntil(promise) { pending.add(promise); promise.finally(() => pending.delete(promise)); }, passThroughOnException() {}, props: {} });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch { outgoing.writeHead(500, { 'content-type': 'text/plain' }); outgoing.end('Preview error'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, ids, db,
    setAuthenticated(value) { authenticated = value; },
    setAccessRedirect(value) { accessRedirect = value; },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await Promise.allSettled([...pending]);
      db.close();
      globalThis.fetch = nativeFetch;
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const preview = await startPreviewServer();
  console.log(`Synthetic diagnostics preview: ${preview.origin}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await preview.close(); process.exit(0); });
}
