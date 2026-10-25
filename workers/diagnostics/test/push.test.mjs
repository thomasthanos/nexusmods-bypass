import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const key = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url');
const subscription = (vapid = key) => ({
  endpoint: 'https://web.push.apple.com/test', expirationTime: null,
  options: { applicationServerKey: Uint8Array.from(Buffer.from(vapid, 'base64url')).buffer },
  toJSON: () => ({ endpoint: 'https://web.push.apple.com/test', expirationTime: null, keys: { p256dh: key, auth: 'a'.repeat(22) } }),
  unsubscribe: async () => true
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function setup(t, { permission = 'default', local = null, ios = false, standalone = false, requestOverride, permissionResult = 'granted', getSubscription } = {}) {
  const dom = new JSDOM('<main id="push"></main>', { url: 'https://diagnostics.test' }); t.after(() => dom.window.close());
  const win = dom.window; const calls = []; const notifications = []; const order = []; let current = local;
  Object.defineProperty(win, 'isSecureContext', { value: true });
  Object.defineProperty(win.navigator, 'userAgent', { value: ios ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' : 'Desktop test' });
  Object.defineProperty(win.navigator, 'standalone', { value: standalone });
  win.matchMedia = () => ({ matches: standalone });
  win.PushManager = function PushManager() {};
  win.Notification = { permission, requestPermission() { order.push('permission'); win.Notification.permission = permissionResult; return Promise.resolve(permissionResult); } };
  const manager = { getSubscription: getSubscription ?? (async () => current), subscribe: async (options) => { order.push('subscribe'); assert.equal(options.userVisibleOnly, true); assert.equal(new Uint8Array(options.applicationServerKey)[0], 4); current = subscription(); return current; } };
  const registration = { active: {}, pushManager: manager };
  Object.defineProperty(win.navigator, 'serviceWorker', { value: { register: async (url, options) => { order.push('register'); assert.equal(url, '/sw.js'); assert.equal(options.scope, '/'); return registration; }, ready: Promise.resolve(registration) } });
  async function request(path, options = {}) {
    calls.push({ path, options }); order.push(path);
    if (requestOverride) { const result = await requestOverride(path, options); if (result !== undefined) return result; }
    if (path === '/push/config') return { public_key: key };
    if (path === '/push/subscriptions' && options.method === 'POST') return { subscription: { id: 11, provider: 'apple', user_agent: 'iPhone', expiration_time: null, created_at: 1, updated_at: 1 } };
    if (path === '/push/subscriptions') return { items: [{ id: 11, provider: 'apple', user_agent: 'iPhone', expiration_time: null, created_at: 1, updated_at: 1 }] };
    if (options.method === 'DELETE') return null;
    if (path === '/push/test') return { state: 'delivered', attempted: 1, delivered: 1, failed: 0, expired: 0, retryable: false };
    throw Error(`Unexpected ${path}`);
  }
  const { mountPushManager } = await import('../public/push.js');
  const container = win.document.querySelector('#push');
  const mounted = mountPushManager(container, { request, notify: (...args) => notifications.push(args) }); t.after(() => mounted.dispose());
  await tick(); await tick();
  const button = (action) => container.querySelector(`[data-push-action="${action}"]`);
  return { container, mounted, win, calls, notifications, order, button, manager };
}

test('prepares registration and public key without asking notification permission', async (t) => {
  const ui = await setup(t);
  assert.ok(ui.order.includes('register')); assert.ok(ui.order.includes('/push/config'));
  assert.equal(ui.order.includes('permission'), false); assert.equal(ui.button('enable').disabled, false);
});

test('enable requests permission in the click gesture before any asynchronous work', async (t) => {
  const ui = await setup(t); ui.order.length = 0;
  ui.button('enable').click(); assert.equal(ui.order[0], 'permission');
  await tick(); await tick();
  const save = ui.calls.find((call) => call.options.method === 'POST');
  assert.equal(save.path, '/push/subscriptions'); assert.equal(save.options.body.expirationTime, null);
  assert.match(ui.container.textContent, /enabled|registered|connected/i);
});

test('iOS browser explains Add to Home Screen and never prompts before standalone', async (t) => {
  const ui = await setup(t, { ios: true });
  assert.match(ui.container.textContent, /Add to Home Screen/i); assert.equal(ui.order.includes('register'), false);
  assert.equal(ui.button('enable').disabled, true); assert.equal(ui.order.includes('permission'), false);
});

test('denied permission explains system settings without repeatedly prompting', async (t) => {
  const ui = await setup(t, { permission: 'denied' });
  assert.match(ui.container.textContent, /settings/i); assert.equal(ui.button('enable').disabled, true);
  assert.equal(ui.order.includes('permission'), false);
});

test('existing subscription synchronizes without a new permission prompt', async (t) => {
  const ui = await setup(t, { permission: 'granted', local: subscription() }); ui.button('sync').click();
  await tick(); await tick();
  assert.equal(ui.order.includes('permission'), false); assert.equal(ui.order.includes('subscribe'), false);
  assert.ok(ui.calls.some((call) => call.options.method === 'POST'));
});

test('failed server disable preserves the browser subscription and recoverable sync controls', async (t) => {
  let unsubscribed = false; const local = subscription(); local.unsubscribe = async () => { unsubscribed = true; return true; };
  const ui = await setup(t, { permission: 'granted', local, requestOverride(path, options) { if (options.method === 'DELETE') throw Object.assign(Error('Session expired'), { status: 401 }); } });
  ui.button('disable').click(); await tick(); await tick();
  assert.equal(unsubscribed, false); assert.match(ui.container.textContent, /sign in|Access session|reload/i);
  assert.equal(ui.button('sync').disabled, false);
});

test('a blocked push mutation preserves the browser registration without claiming the session expired', async (t) => {
  let unsubscribed = false; const local = subscription(); local.unsubscribe = async () => { unsubscribed = true; return true; };
  const ui = await setup(t, { permission: 'granted', local, requestOverride(path, options) {
    if (options.method === 'DELETE') throw Object.assign(Error('private rejection details'), { status: 403 });
  } });
  ui.button('disable').click(); await tick(); await tick();
  assert.equal(unsubscribed, false);
  assert.match(ui.container.textContent, /request was blocked.*session may still be valid/i);
  assert.match(ui.container.textContent, /browser subscription is preserved/i);
  assert.doesNotMatch(ui.container.textContent, /session expired|sign in|private rejection/i);
  assert.equal(ui.button('sync').disabled, false);
});

test('VAPID changes show an explicit replacement action and do not silently unsubscribe', async (t) => {
  const oldKey = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 2)]).toString('base64url'); let removed = false;
  const local = subscription(oldKey); local.unsubscribe = async () => { removed = true; return true; };
  const ui = await setup(t, { permission: 'granted', local });
  assert.match(ui.container.textContent, /server key|key changed/i); assert.equal(removed, false);
  assert.equal(ui.button('rotate').hidden, false);
});

test('partial test delivery reports provider acceptance without claiming device receipt', async (t) => {
  const ui = await setup(t, { requestOverride(path) { if (path === '/push/test') return { state: 'partial', attempted: 2, delivered: 1, failed: 1, expired: 0, retryable: true }; } });
  ui.button('test').click(); await tick(); await tick();
  assert.match(ui.container.textContent, /1.*2|1.*accepted/i); assert.match(ui.container.textContent, /failed|partial/i);
  assert.doesNotMatch(ui.container.textContent, /successfully delivered|received on/i); assert.equal(ui.button('test').disabled, true);
});

test('429 test limit honors Retry-After', async (t) => {
  const ui = await setup(t, { requestOverride(path) { if (path === '/push/test') throw Object.assign(Error('Limited'), { status: 429, retryAfter: 61 }); } });
  ui.button('test').click(); await tick(); await tick();
  assert.match(ui.container.textContent, /61|minute|wait/i); assert.equal(ui.button('test').disabled, true);
});

test('no-subscription test result reports setup guidance without claiming acceptance', async (t) => {
  const ui = await setup(t, { requestOverride(path) { if (path === '/push/test') return { state: 'no_subscriptions', attempted: 0, delivered: 0, failed: 0, expired: 0, retryable: false }; } });
  ui.button('test').click(); await tick(); await tick();
  assert.match(ui.container.textContent, /No server registrations are available/);
  assert.equal(ui.notifications.some(([value, kind]) => kind === 'success'), false);
});

test('in-flight test result is not announced or rendered after disposal', async (t) => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const ui = await setup(t, { requestOverride(path) { if (path === '/push/test') return pending; } });
  ui.button('test').click(); ui.mounted.dispose(); const before = ui.container.innerHTML;
  resolve({ state: 'delivered', delivered: 1, failed: 0 }); await tick();
  assert.equal(ui.container.innerHTML, before); assert.equal(ui.notifications.length, 0);
});

test('subscription list renders device labels as inert text', async (t) => {
  const ui = await setup(t, { requestOverride(path, options) {
    if (path === '/push/subscriptions' && !options.method) return { items: [{ id: 91, provider: 'apple', user_agent: '<img src=x onerror=alert(1)>', expiration_time: null }] };
  } });
  assert.match(ui.container.textContent, /<img src=x/); assert.equal(ui.container.querySelector('img'), null);
  assert.equal(ui.container.querySelector('[onerror]'), null);
});

test('disposing aborts pending work and prevents stale DOM writes', async (t) => {
  let resolve; const pending = new Promise((done) => { resolve = done; });
  const ui = await setup(t, { requestOverride(path) { if (path === '/push/config') return pending; } });
  ui.mounted.dispose(); const before = ui.container.innerHTML;
  resolve({ public_key: key }); await tick(); await tick();
  assert.equal(ui.container.innerHTML, before); assert.ok(ui.calls.every((call) => call.options.signal.aborted));
});

test('retrying initialization cannot replace a fresh browser subscription with a stale result', async (t) => {
  let resolveOld; let reads = 0; let configs = 0;
  const pending = new Promise((resolve) => { resolveOld = resolve; });
  const fresh = subscription(); fresh.endpoint = 'https://web.push.apple.com/fresh';
  const stale = subscription(); stale.endpoint = 'https://web.push.apple.com/stale';
  const ui = await setup(t, { permission: 'granted', getSubscription: () => ++reads === 1 ? pending : Promise.resolve(fresh),
    requestOverride(path) { if (path === '/push/config' && ++configs === 1) throw Error('Offline'); } });
  ui.button('refresh').click(); await tick(); await tick();
  resolveOld(stale); await tick();
  ui.button('sync').click(); await tick(); await tick();
  const save = ui.calls.find((call) => call.options.method === 'POST');
  assert.equal(save.options.body.endpoint, 'https://web.push.apple.com/fresh');
});

test('device summaries stay short while raw browser details and all-device test scope remain available', async (t) => {
  const userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
  const ui = await setup(t, { requestOverride(path, options) {
    if (path === '/push/subscriptions' && !options.method) return { items: [{ id: 91, provider: 'apple', user_agent: userAgent, expiration_time: null }] };
  } });
  assert.equal(ui.container.querySelector('.push-device-name').textContent, 'iPhone · Safari');
  assert.equal(ui.container.querySelector('.push-device-metadata').open, false);
  assert.equal(ui.container.querySelector('.push-device-agent').textContent, userAgent);
  assert.equal(ui.container.querySelector('.push-maintenance').open, false);
  assert.match(ui.container.querySelector('.push-maintenance > summary').textContent, /1/);
  const testNote = ui.container.querySelector('.push-test-note');
  assert.match(testNote.textContent, /all registered devices/); assert.match(testNote.textContent, /does not confirm display/);
  assert.equal(testNote.closest('details'), null, 'test scope is visible beside the main actions');
  assert.equal(ui.button('test').textContent, 'Test all devices');
  assert.equal(ui.container.querySelector('.push-local-options').hidden, true);
});

test('unknown device agents do not acquire a guessed browser or operating system', async (t) => {
  const userAgent = 'Unrecognized test agent';
  const ui = await setup(t, { requestOverride(path, options) {
    if (path === '/push/subscriptions' && !options.method) return { items: [{ id: 91, provider: 'other', user_agent: userAgent, expiration_time: null }] };
  } });
  assert.equal(ui.container.querySelector('.push-device-name').textContent, 'Unknown device');
  assert.equal(ui.container.querySelector('.push-device-agent').textContent, userAgent);
});

test('this-device controls and the all-devices test are separate groups', async (t) => {
  const ui = await setup(t, { permission: 'granted', local: subscription() });
  const local = ui.container.querySelector('[aria-labelledby="push-heading"], .push-panel');
  const all = ui.container.querySelector('.push-all-devices');
  assert.match(local.textContent, /this device/i);
  assert.ok(all.contains(ui.button('test')), 'the test notification lives in the All devices group');
  assert.equal(local.contains(ui.button('test')), false);
  assert.ok(local.contains(ui.button('sync') ?? ui.button('enable')));
});

test('removing a server registration needs a second explicit tap', async (t) => {
  const ui = await setup(t, { permission: 'granted', local: subscription() });
  const remove = () => ui.container.querySelector('.push-device button.button-danger');
  remove().click(); await tick();
  assert.equal(ui.calls.some((call) => call.options.method === 'DELETE'), false);
  assert.equal(remove().dataset.confirm, 'true'); assert.match(remove().getAttribute('aria-label'), /^Confirm removing registration 11/);
  remove().click(); await tick(); await tick();
  assert.ok(ui.calls.some((call) => call.options.method === 'DELETE' && call.path === '/push/subscriptions/11'));
});
