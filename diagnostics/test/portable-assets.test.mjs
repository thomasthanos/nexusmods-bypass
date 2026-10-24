import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPublicAssets, portableModules } from '../tools/build-portable-worker.mjs';
import { bindings, createAccessFixture } from './helpers/access.mjs';
import { createTestDatabase } from './helpers/d1.mjs';

async function fixture(t, source) {
  const directory = await mkdtemp(join(tmpdir(), 'nxtk-portable-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const backend = source ?? `export { default } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)};`;
  const files = await readPublicAssets();
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  for (const [name, content] of Object.entries(portableModules(backend, files))) await writeFile(join(directory, name), content);
  const { createAssets } = await import(pathToFileURL(join(directory, 'assets.js')).href);
  const { default: worker } = await import(pathToFileURL(join(directory, 'index.js')).href);
  return { assets: createAssets(), worker, files };
}

test('portable files exactly match the public text and binary assets without private caches', async (t) => {
  const f = await fixture(t);
  assert.equal(Object.keys(f.files).length, 17);
  assert.ok(f.files['/growth.js']);
  assert.ok(f.files['/ui.js']);
  assert.ok(f.files['/ui-icons.js']);
  assert.ok(!Object.keys(f.files).some((name) => name.includes('.assetsignore')));
  for (const path of Object.keys(f.files)) {
    const response = await f.assets.fetch(new Request('https://diagnostics.example' + path));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(new URL('../public' + path, import.meta.url)));
  }
  assert.equal(await (await f.assets.fetch(new Request('https://diagnostics.example/'))).text(), await readFile(new URL('../public/index.html', import.meta.url), 'utf8'));
});

test('portable asset routing preserves HEAD, navigation fallback and missing-resource responses', async (t) => {
  const { assets } = await fixture(t);
  const head = await assets.fetch(new Request('https://diagnostics.example/app.js', { method: 'HEAD' }));
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.ok(Number(head.headers.get('content-length')) > 0);
  assert.equal((await assets.fetch(new Request('https://diagnostics.example/missing.js'))).status, 404);
  assert.equal((await assets.fetch(new Request('https://diagnostics.example/issues', { headers: { Accept: 'text/html' } }))).status, 200);
  assert.equal((await assets.fetch(new Request('https://diagnostics.example/app.js', { method: 'POST' }))).status, 405);
});

test('portable deployment still requires the real Access verifier before serving every private asset', async (t) => {
  const { worker } = await fixture(t);
  const db = createTestDatabase(); t.after(() => db.close());
  const env = bindings(db);
  for (const path of ['/', '/app.js', '/sw.js', '/manifest.json', '/api/admin/overview']) {
    const response = await worker.fetch(new Request('https://diagnostics.example' + path), env, { waitUntil() {}, passThroughOnException() {}, props: {} });
    assert.equal(response.status, 401, path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(await response.text(), /createDashboard|DOCTYPE|pushsubscriptionchange/);
  }
});

test('portable deployment serves the current dashboard and real API after a verified Access login', async (t) => {
  const { worker } = await fixture(t);
  const access = await createAccessFixture(t);
  const db = createTestDatabase(); t.after(() => db.close());
  const env = bindings(db);
  const headers = await access.headers();
  const context = { waitUntil() {}, passThroughOnException() {}, props: {} };
  const page = await worker.fetch(new Request('https://diagnostics.example/app.js', { headers }), env, context);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), await readFile(new URL('../public/app.js', import.meta.url), 'utf8'));
  const api = await worker.fetch(new Request('https://diagnostics.example/api/admin/overview', { headers }), env, context);
  assert.equal(api.status, 200);
  assert.equal((await api.json()).reports.total, 0);
  assert.ok(access.requests.every((url) => url === 'https://fixture.cloudflareaccess.com/cdn-cgi/access/certs'));
});

test('portable entrypoint forwards cron events and their environment to the monitoring Worker', async (t) => {
  const { worker } = await fixture(t, `export default { scheduled(event, env, context) {
    context.waitUntil(Promise.resolve().then(() => { env.events.push(event.cron); }));
  } };`);
  const env = { events: [] }; const pending = [];
  await worker.scheduled({ cron: '*/15 * * * *' }, env, { waitUntil(promise) { pending.push(promise); } });
  await Promise.all(pending); assert.deepEqual(env.events, ['*/15 * * * *']);
});
