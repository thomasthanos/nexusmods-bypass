import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import { chromium, webkit } from '@playwright/test';
import { startPreviewServer } from '../helpers/preview-server.mjs';

const engineName = process.env.NXTK_DIAGNOSTICS_BROWSER ?? 'chromium';
assert.ok(['chromium', 'webkit'].includes(engineName), 'Choose a supported diagnostics browser');

test('protected mutations retain their Origin under the production no-referrer policy', { timeout: 45_000 }, async () => {
  // This exercises the real API client, RSA Access verification, same-origin
  // middleware and SQLite mutation. No external notifications are delivered.
  const preview = await startPreviewServer();
  let browser;
  try {
    browser = await ({ chromium, webkit })[engineName].launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(15_000);
    await page.route('https://cdn.jsdelivr.net/**', (route) => route.abort());
    // Load the protected document and its production response headers without
    // starting unrelated dashboard requests during this transport regression.
    await page.route('**/app.js', (route) => route.abort());
    const navigation = await page.goto(preview.origin);
    assert.equal(navigation.headers()['referrer-policy'], 'no-referrer');
    const mutations = [];
    page.on('request', (request) => { if (request.method() === 'PATCH') mutations.push(request); });
    const result = await page.evaluate(async (id) => {
      const { createApiClient } = await import('/lib.js');
      let invalidated = 0;
      const legacy = createApiClient({ onUnauthorized: () => invalidated++, fetchImpl: (url, options) => fetch(url, { ...options, mode: 'same-origin' }) });
      let former;
      try { former = { status: 200, value: await legacy(`/issues/${id}`, { method: 'PATCH', body: { muted: false } }) }; }
      catch (error) { former = { status: error.status }; }
      const fixed = createApiClient({ onUnauthorized: () => invalidated++ });
      const value = await fixed(`/issues/${id}`, { method: 'PATCH', body: { muted: true } });
      return { former, muted: value.issue.muted, invalidated };
    }, preview.ids.upstream);
    assert.equal(result.former.status, engineName === 'webkit' ? 403 : 200,
      'WebKit reproduces the former null-Origin rejection; Chromium previously hid this bug');
    assert.equal(result.muted, true);
    assert.equal(result.invalidated, 0, 'A blocked operation must not invalidate the verified Access session');
    assert.equal(mutations.length, 2);
    const [formerHeaders, fixedHeaders] = await Promise.all(mutations.map((request) => request.allHeaders()));
    assert.equal(formerHeaders.origin, engineName === 'webkit' ? 'null' : preview.origin);
    assert.equal(fixedHeaders.origin, preview.origin);
    assert.equal(fixedHeaders['x-requested-with'], 'XMLHttpRequest');
    // Invalid/missing Origins must remain forbidden even with a valid Access
    // assertion; the client fix must not relax the server's mutation guard.
    for (const origin of ['null', 'https://hostile.invalid', undefined]) {
      const status = await new Promise((resolve, reject) => {
        const request = httpRequest(`${preview.origin}/api/admin/issues/${preview.ids.upstream}`, { method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...(origin === undefined ? {} : { Origin: origin }) } }, (response) => {
          response.resume(); response.on('end', () => resolve(response.statusCode));
        });
        request.on('error', reject); request.end(JSON.stringify({ muted: false }));
      });
      assert.equal(status, 403);
    }
    assert.equal(preview.db.sqlite.prepare('SELECT muted FROM issues WHERE id=?').get(preview.ids.upstream).muted, 1);
  } finally {
    await browser?.close();
    await preview.close();
  }
});
