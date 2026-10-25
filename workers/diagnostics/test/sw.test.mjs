import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function worker({ windows = [], badgeFails = false } = {}) {
  const handlers = new Map();
  const shown = []; const badges = []; const opened = [];
  const self = {
    location: { origin: 'https://diagnostics.test' },
    addEventListener: (name, handler) => handlers.set(name, handler),
    registration: { showNotification: async (title, options) => { shown.push({ title, options }); } },
    navigator: {
      setAppBadge: async (value) => { badges.push(value); if (badgeFails) throw Error('Unavailable'); },
      clearAppBadge: async () => { badges.push(0); if (badgeFails) throw Error('Unavailable'); }
    },
    clients: { matchAll: async () => windows, openWindow: async (url) => { opened.push(url); } }
  };
  vm.runInNewContext(await readFile(new URL('../public/sw.js', import.meta.url), 'utf8'), { self, URL, Number, Object, Array, Set, Promise });
  async function emit(name, event) {
    let pending;
    handlers.get(name)({ ...event, waitUntil: (promise) => { pending = promise; } });
    await pending;
  }
  return { shown, badges, opened, handlers, emit };
}
const fingerprint = 'a'.repeat(64);
const payload = () => ({ title: 'Regression detected', body: 'DOM selector changed', tag: fingerprint,
  data: { url: 'https://diagnostics.test/?issue=7', issue_id: 7, fingerprint, trigger: 'REGRESSION' }, badge_count: 3 });

test('valid push displays bounded content, full fingerprint tag and validated issue deep link', async () => {
  const sw = await worker(); const data = payload(); data.body = '😀'.repeat(400); data.badge_count = 100_000;
  await sw.emit('push', { data: { json: () => data } });
  assert.equal(sw.shown.length, 1); assert.equal(sw.shown[0].options.tag, fingerprint);
  assert.equal(Array.from(sw.shown[0].options.body).length, 240);
  assert.equal(sw.shown[0].options.data.url, 'https://diagnostics.test/?issue=7');
  assert.deepEqual(sw.badges, [9999]);
});

test('missing or malformed push still displays a safe visible fallback', async () => {
  for (const data of [null, { json() { throw Error('Malformed'); } }, { json: () => null }, { json: () => ['not', 'object'] }]) {
    const sw = await worker(); await sw.emit('push', { data });
    assert.equal(sw.shown.length, 1); assert.match(sw.shown[0].title, /diagnostics/i);
    assert.equal(sw.shown[0].options.data.url, 'https://diagnostics.test/');
  }
});

test('push rejects external, credentialed, mismatched or noncanonical issue routes', async () => {
  for (const url of ['https://evil.test/?issue=7', 'https://user@diagnostics.test/?issue=7',
    'https://diagnostics.test/?issue=8', 'https://diagnostics.test/?issue=07',
    'https://diagnostics.test/?issue=7&next=https://evil.test', 'https://diagnostics.test/?issue=7#bad',
    'https://diagnostics.test/api/admin/issues/7', 'javascript:alert(1)']) {
    const sw = await worker(); const data = payload(); data.data.url = url;
    await sw.emit('push', { data: { json: () => data } });
    assert.equal(sw.shown[0].options.data.url, 'https://diagnostics.test/');
    assert.notEqual(sw.shown[0].title, data.title);
  }
});

test('badge failures cannot suppress a visible notification, including test pushes', async () => {
  const sw = await worker({ badgeFails: true }); const data = payload();
  data.data = { url: 'https://diagnostics.test/', issue_id: null, fingerprint: null, trigger: 'TEST' }; data.tag = 'diagnostics-test'; data.badge_count = 0;
  await sw.emit('push', { data: { json: () => data } });
  assert.equal(sw.shown.length, 1); assert.deepEqual(sw.badges, [0]);
  assert.equal(sw.shown[0].options.data.url, 'https://diagnostics.test/');
});

test('notification click focuses and navigates an existing same-origin window', async () => {
  const visits = []; let closed = false;
  const client = { url: 'https://diagnostics.test/', navigate: async (url) => { visits.push(url); return client; }, focus: async () => { visits.push('focus'); return client; } };
  const sw = await worker({ windows: [client] });
  await sw.emit('notificationclick', { action: 'open', notification: { data: payload().data, close: () => { closed = true; } } });
  assert.equal(closed, true); assert.deepEqual(visits, ['https://diagnostics.test/?issue=7', 'focus']); assert.deepEqual(sw.opened, []);
});

test('close action never opens a window; tampered click data opens safe root only', async () => {
  const sw = await worker();
  await sw.emit('notificationclick', { action: 'close', notification: { data: payload().data, close() {} } });
  assert.deepEqual(sw.opened, []);
  await sw.emit('notificationclick', { action: '', notification: { data: { ...payload().data, url: 'https://evil.test/' }, close() {} } });
  assert.deepEqual(sw.opened, ['https://diagnostics.test/']);
});

test('worker does not register a fetch handler or intercept private responses', async () => {
  const sw = await worker(); assert.equal(sw.handlers.has('fetch'), false);
});

const reviewId = 'b1fd5094-3ecb-48d1-9540-fb21b9e40b66';
const reviewPayload = () => ({ title: 'New Chrome Web Store review · 5★', body: 'Public reviewer: Great extension',
  tag: `store-review:${reviewId}`, data: { url: `https://diagnostics.test/?review=${reviewId}`,
    issue_id: null, fingerprint: null, review_id: reviewId, trigger: 'NEW_REVIEW' }, badge_count: 1 });

test('new review notifications preserve their canonical review link, ID and stable tag', async () => {
  const sw = await worker(); const input = reviewPayload();
  await sw.emit('push', { data: { json: () => input } });
  assert.equal(sw.shown[0].title, input.title); assert.equal(sw.shown[0].options.tag, input.tag);
  assert.equal(sw.shown[0].options.data.review_id, reviewId);
  await sw.emit('notificationclick', { notification: { data: sw.shown[0].options.data, close() {} } });
  assert.deepEqual(sw.opened, [input.data.url]);
});

test('review pushes reject mismatched IDs, tags and links, including extra query parameters', async () => {
  const other = '00000000-0000-4000-8000-000000000001';
  for (const changes of [
    { tag: 'wrong' }, { data: { review_id: other } }, { data: { review_id: undefined } },
    { data: { issue_id: 1 } }, { data: { fingerprint } },
    { data: { url: `https://evil.test/?review=${reviewId}` } },
    { data: { url: `https://diagnostics.test/?review=${reviewId}&issue=7` } },
    { data: { url: `https://diagnostics.test/?review=${reviewId.toUpperCase()}` } }
  ]) {
    const sw = await worker(); const input = reviewPayload();
    Object.assign(input, { ...changes, data: { ...input.data, ...changes.data } });
    await sw.emit('push', { data: { json: () => input } });
    assert.equal(sw.shown[0].options.data.url, 'https://diagnostics.test/');
    assert.notEqual(sw.shown[0].title, input.title);
  }
});
