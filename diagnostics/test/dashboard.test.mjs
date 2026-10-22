import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createDashboard } from '../public/app.js';

const now = Date.UTC(2026, 9, 22, 12);
const issue = (id = 1) => ({ id, fingerprint: 'a'.repeat(64), category: 'NETWORK_UNREACHABLE', error_code: 'FETCH_FAILED', fault_origin: 'client_env', suggested_action: 'Check connection.', status: 'new', muted: false, total_occurrences: 12, affected_installs_count: 3, first_seen_at: now, last_seen_at: now, first_seen_version: '3.1.0', last_seen_version: '3.2.0', fixed_in_version: null, github_issue_url: null, updated_at: now });
const report = { id: 'report-one', version: '3.2.0', browser: 'chrome', browser_version: '144', os: 'windows', destination: 'vortex', download_mode: 'manual', severity: 'error', category: 'NETWORK_UNREACHABLE', fault_origin: 'client_env', suggested_action: 'Check connection.', error_message: '<img src=x onerror=alert(1)>', stack_trace: 'TypeError\n at file.js:42', created_at: now, occurred_at: now, breadcrumbs: [{ timestamp_offset_ms: 0, stage: 'PRIMARY_API_REQUEST', action: 'GET', status: 'warn', http_status: 429, duration_ms: 310, metadata: { endpoint: 'https://example.org/api' } }], dom_state: { document_ready_state: 'complete', selectors: [{ selector: '#host', matched: false }] }, context: { online: true } };
const overview = { window: { from: '2026-09-23', to: '2026-10-22' }, issues: { total: 1, new_count: 1, regressed_count: 0, investigating_count: 0, muted_count: 0 }, reports: { total: 12, distinct_installs: 3 }, releases: { attempts_count: 1000, success_count: 910, fallback_triggered_count: 80, heartbeat_count: 3, success_rate_percent: 91, fallback_rate_percent: 8 }, alerts: { window_seconds: 900, spikes: [{ issue_id: 1, category: 'NETWORK_UNREACHABLE', status: 'new', report_count: 12, distinct_installs: 3, last_seen_at: now }] } };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }

function setup(t, handler, url = 'https://diagnostics.test/') {
  const dom = new JSDOM('<button id="refresh-button">Refresh</button><span id="connection-status"></span><div id="app-message" hidden></div><main id="main-content"><section id="view-overview"></section><section id="view-issues" hidden></section><section id="view-settings" hidden></section></main><button data-view="overview"></button><button data-view="issues"></button><button data-view="settings"></button><dialog id="issue-dialog"><button id="close-issue">Close</button><div id="issue-detail"></div></dialog><div id="toast" hidden></div>', { url });
  const dialog = dom.window.document.getElementById('issue-dialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new dom.window.Event('close')); };
  const calls = [];
  const request = async (path, options = {}) => {
    calls.push({ path, options });
    if (handler) { const response = handler(path, options); if (response !== undefined) return response; }
    if (path.startsWith('/overview')) return overview;
    if (path.startsWith('/releases/compare')) return { before: { version: '3.1.0', attempts_count: 0, success_rate_percent: null, fallback_rate_percent: null }, after: { version: '3.2.0', attempts_count: 0, success_rate_percent: null, fallback_rate_percent: null }, success_rate_delta_pp: null, fallback_rate_delta_pp: null };
    if (path.startsWith('/releases')) return { items: [{ version: '3.2.0', ...overview.releases }], total: 1, page: 1, limit: 10 };
    if (/^\/issues\/\d+\/reports/.test(path)) return { items: [report], total: 1, page: 1, limit: 5 };
    if (/^\/issues\/\d+$/.test(path)) { const id = Number(path.split('/')[2]); return { issue: issue(id), latest_report: report, report_summary: { retained_report_count: 1, browsers: ['chrome'], versions: ['3.2.0'], operating_systems: ['windows'] } }; }
    if (path.startsWith('/issues')) return { items: [issue()], total: 1, page: 1, limit: 20 };
    throw new Error(`Unexpected request: ${path}`);
  };
  let disposed = 0;
  const app = createDashboard({ document: dom.window.document, window: dom.window, request, mountPush: (container) => { container.textContent = 'Push controls'; return { dispose: () => { disposed++; } }; } });
  t.after(() => { app.destroy(); dom.window.close(); });
  return { app, dom, document: dom.window.document, calls, disposed: () => disposed };
}

test('overview uses weighted server totals, live-window alerts and null-safe release comparison', async (t) => {
  const { document, calls } = setup(t);
  await tick();
  assert.match(document.querySelector('#view-overview').textContent, /91\.0%/);
  assert.match(document.querySelector('#view-overview').textContent, /15.minute|15 min/i);
  assert.match(document.querySelector('#view-overview').textContent, /12 reports/);
  document.querySelector('[name="before"]').value = '3.1.0';
  document.querySelector('[name="after"]').value = '3.2.0';
  document.querySelector('[data-form="comparison"]').dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  assert.ok(calls.some(({ path }) => path.startsWith('/releases/compare?') && path.includes('before=3.1.0')));
  assert.match(document.querySelector('[data-comparison-result]').textContent, /No attempts|No telemetry/i);
  assert.doesNotMatch(document.querySelector('[data-comparison-result]').textContent, /NaN|Infinity/);
});

test('issue filters send every dimension together and reset pagination', async (t) => {
  const { app, document, calls } = setup(t);
  await app.navigate('issues');
  const form = document.querySelector('[data-form="issues"]');
  const values = { q: 'Failed', version: '3.2.0', browser: 'firefox', os: 'linux', destination: 'mo2', download_mode: 'auto', status: 'regressed', fault_origin: 'upstream_site', category: 'DOM_SELECTOR_MISSING', severity: 'fatal', muted: 'true' };
  for (const [name, value] of Object.entries(values)) form.elements.namedItem(name).value = value;
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  const path = calls.filter((call) => call.path.startsWith('/issues?')).at(-1).path;
  const query = new URL(path, 'https://example.test').searchParams;
  for (const [name, value] of Object.entries(values)) assert.equal(query.get(name), value);
  assert.equal(query.get('page'), '1');
});

test('detail renders hostile evidence as text, a measured HTTP waterfall and a lifecycle PATCH', async (t) => {
  const { app, document, calls } = setup(t, (path, options) => options.method === 'PATCH' ? { issue: { ...issue(), ...options.body } } : undefined);
  await app.openIssue(1);
  const detail = document.querySelector('#issue-detail');
  assert.equal(detail.querySelector('img'), null);
  assert.match(detail.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match(detail.textContent, /HTTP 429/);
  assert.match(detail.textContent, /310 ms/);
  assert.match(detail.textContent, /#host/);
  const form = detail.querySelector('[data-form="lifecycle"]');
  form.elements.namedItem('status').value = 'fixed';
  form.elements.namedItem('fixed_in_version').value = '3.2.1';
  form.elements.namedItem('muted').checked = true;
  form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  const patch = calls.find(({ options }) => options.method === 'PATCH');
  assert.equal(patch.path, '/issues/1');
  assert.equal(patch.options.body.fixed_in_version, '3.2.1');
  assert.equal(patch.options.body.muted, true);
  assert.deepEqual(patch.options.body.expected, { status: 'new', fixed_in_version: null, github_issue_url: null, muted: false, updated_at: now });
  assert.match(detail.textContent, /fixed/);
  assert.match(detail.querySelector('[data-lifecycle-feedback]').textContent, /Issue updated/);
});

test('rapid issue selection and closure reject late private responses even when fetch ignores abort', async (t) => {
  const slow = deferred();
  const { app, document } = setup(t, (path) => path === '/issues/1' ? slow.promise : undefined);
  const first = app.openIssue(1);
  await app.openIssue(2);
  slow.resolve({ issue: issue(1), latest_report: { ...report, error_message: 'STALE PRIVATE REPORT' }, report_summary: {} });
  await first;
  assert.match(document.querySelector('#issue-title').textContent, /#2/);
  assert.doesNotMatch(document.querySelector('#issue-detail').textContent, /STALE PRIVATE/);
  document.querySelector('#close-issue').click();
  assert.equal(document.querySelector('#issue-detail').textContent, '');
});

test('expired Access aborts active work, clears every private view and disposes push', async (t) => {
  const { app, document, disposed } = setup(t);
  await app.navigate('settings');
  await app.openIssue(1);
  app.invalidateSession();
  assert.equal(disposed(), 1);
  for (const id of ['view-overview', 'view-issues', 'view-settings', 'issue-detail']) assert.equal(document.getElementById(id).textContent, '');
  assert.match(document.querySelector('#app-message').textContent, /sign in|Access session/i);
  assert.equal(document.querySelector('#issue-dialog').open, false);
});

test('clipboard rejection provides a selected manual-copy context for the selected report', async (t) => {
  const { app, document, dom } = setup(t);
  Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async () => { throw new Error('denied'); } } });
  await app.openIssue(1);
  document.querySelector('[data-action="copy-context"]').click();
  await tick();
  const textarea = document.querySelector('[data-manual-copy]');
  assert.ok(textarea);
  assert.match(textarea.value, /TypeError/);
  assert.match(textarea.value, /PRIMARY_API_REQUEST/);
  assert.equal(textarea.readOnly, true);
});

test('history pagination selects an older report without replacing the issue', async (t) => {
  const old = { ...report, id: 'older-report', version: '3.1.0', error_message: 'Older report evidence' };
  const { app, document } = setup(t, (path) => path.includes('/reports?') ? { items: path.includes('page=2') ? [old] : [report], total: 6, page: path.includes('page=2') ? 2 : 1, limit: 5 } : undefined);
  await app.openIssue(1);
  document.querySelector('[data-history-next]').click();
  await tick();
  document.querySelector('[data-report-id="older-report"]').click();
  assert.match(document.querySelector('[data-selected-report]').textContent, /Older report evidence/);
  assert.match(document.querySelector('#issue-title').textContent, /#1/);
});

test('newer comparison wins when a prior request resolves after abort', async (t) => {
  const slow = deferred();
  let comparisons = 0;
  const { document } = setup(t, (path) => {
    if (!path.startsWith('/releases/compare')) return undefined;
    if (++comparisons === 1) return slow.promise;
    return { before: { version: '3.1.0', attempts_count: 100, success_rate_percent: 90, fallback_rate_percent: 10 }, after: { version: '3.3.0', attempts_count: 100, success_rate_percent: 99, fallback_rate_percent: 2 }, success_rate_delta_pp: 9, fallback_rate_delta_pp: -8 };
  });
  await tick();
  const form = document.querySelector('[data-form="comparison"]');
  form.elements.namedItem('before').value = '3.1.0'; form.elements.namedItem('after').value = '3.2.0';
  form.dispatchEvent(new document.defaultView.Event('submit', { cancelable: true }));
  form.elements.namedItem('after').value = '3.3.0';
  form.dispatchEvent(new document.defaultView.Event('submit', { cancelable: true }));
  await tick();
  slow.resolve({ before: { version: '3.1.0', attempts_count: 100 }, after: { version: '3.2.0', attempts_count: 100 }, success_rate_delta_pp: -50 });
  await tick();
  const text = document.querySelector('[data-comparison-result]').textContent;
  assert.match(text, /3\.3\.0/); assert.doesNotMatch(text, /3\.2\.0/); assert.match(text, /\+9\.0 pp/);
});

test('an API authentication failure clears diagnostics and rejects late view responses', async (t) => {
  const slow = deferred();
  const { app, document } = setup(t, (path) => {
    if (path.startsWith('/overview')) return slow.promise;
    if (path.startsWith('/issues?')) return Promise.reject(Object.assign(new Error('unauthorized'), { status: 401 }));
    return undefined;
  });
  await app.navigate('issues');
  slow.resolve(overview); await tick();
  for (const id of ['view-overview', 'view-issues', 'view-settings', 'issue-detail']) assert.equal(document.getElementById(id).textContent, '');
  assert.match(document.querySelector('#app-message').textContent, /Sign in again/);
});

test('invalid release and category filters stay editable without a doomed API request', async (t) => {
  const { app, document, calls } = setup(t); await app.navigate('issues');
  const form = document.querySelector('[data-form="issues"]'); const initial = calls.length;
  form.elements.namedItem('version').value = 'incorrect';
  form.dispatchEvent(new document.defaultView.Event('submit', { cancelable: true })); await tick();
  assert.equal(calls.length, initial); assert.ok(form.isConnected); assert.match(form.textContent, /complete release version/);
});

test('back navigation opens the requested issue and clears evidence when leaving the deep link', async (t) => {
  const { app, document, dom } = setup(t); await app.openIssue(1);
  dom.window.history.replaceState({}, '', '/?issue=2'); dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate')); await tick();
  assert.match(document.querySelector('#issue-title').textContent, /#2/);
  dom.window.history.replaceState({}, '', '/'); dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
  assert.equal(document.querySelector('#issue-dialog').open, false); assert.equal(document.querySelector('#issue-detail').textContent, '');
});

test('offline errors are visible and retry after connectivity returns is successful', async (t) => {
  let fail = true;
  const { app, document, dom } = setup(t, (path) => path.startsWith('/issues?') && fail ? Promise.reject(new TypeError('network')) : undefined);
  Object.defineProperty(dom.window.navigator, 'onLine', { value: false, configurable: true });
  await app.navigate('issues'); assert.match(document.querySelector('#view-issues').textContent, /offline/i);
  fail = false; Object.defineProperty(dom.window.navigator, 'onLine', { value: true, configurable: true }); dom.window.dispatchEvent(new dom.window.Event('online'));
  [...document.querySelectorAll('#view-issues button')].find((element) => element.textContent === 'Retry').click(); await tick();
  assert.ok(document.querySelector('[data-form="issues"]')); assert.equal(document.querySelector('#connection-status').textContent, 'Connected');
});

test('a mute-only edit sends only that field and the original lifecycle snapshot', async (t) => {
  const fixed = { ...issue(), status: 'fixed', fixed_in_version: '3.2.0' };
  const { app, document, calls } = setup(t, (path, options) => {
    if (options.method === 'PATCH') return { issue: { ...fixed, muted: true } };
    if (path === '/issues/1') return { issue: fixed, latest_report: report, report_summary: {} };
    return undefined;
  });
  await app.openIssue(1);
  const form = document.querySelector('[data-form="lifecycle"]');
  form.elements.namedItem('muted').checked = true;
  form.dispatchEvent(new document.defaultView.Event('submit', { cancelable: true })); await tick();
  const patch = calls.find(({ options }) => options.method === 'PATCH');
  assert.deepEqual(patch.options.body, { muted: true, expected: { status: 'fixed', fixed_in_version: '3.2.0', github_issue_url: null, muted: false, updated_at: now } });
});

test('saving an unchanged lifecycle stays local and reports that no changes were made', async (t) => {
  const { app, document, calls } = setup(t); await app.openIssue(1);
  document.querySelector('[data-form="lifecycle"]').dispatchEvent(new document.defaultView.Event('submit', { cancelable: true })); await tick();
  assert.equal(calls.filter(({ options }) => options.method === 'PATCH').length, 0);
  assert.match(document.querySelector('[data-lifecycle-feedback]').textContent, /No changes/);
});

test('a stale fixed issue cannot overwrite a regression and offers a detail refresh', async (t) => {
  const { app, document } = setup(t, (path, options) => {
    if (options.method === 'PATCH') return Promise.reject(Object.assign(new Error('conflict'), { status: 409 }));
    if (path === '/issues/1') return { issue: { ...issue(), status: 'fixed', fixed_in_version: '3.2.0' }, latest_report: report, report_summary: {} };
    return undefined;
  });
  await app.openIssue(1);
  const form = document.querySelector('[data-form="lifecycle"]'); form.elements.namedItem('muted').checked = true;
  form.dispatchEvent(new document.defaultView.Event('submit', { cancelable: true })); await tick();
  const feedback = document.querySelector('[data-lifecycle-feedback]');
  assert.match(feedback.textContent, /changed while saving/); assert.match(feedback.textContent, /Refresh details/);
  assert.doesNotMatch(document.querySelector('#issue-detail').textContent, /Issue updated/);
});

test('successful copy reports its outcome inside the open modal', async (t) => {
  const { app, document, dom } = setup(t);
  let copied = '';
  Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async (text) => { copied = text; } } });
  await app.openIssue(1); document.querySelector('[data-action="copy-context"]').click(); await tick();
  assert.match(copied, /PRIMARY_API_REQUEST/);
  const feedback = document.querySelector('#issue-detail [data-dialog-status]');
  assert.equal(feedback.getAttribute('role'), 'status'); assert.equal(feedback.hidden, false); assert.match(feedback.textContent, /context copied/);
  assert.equal(document.querySelector('#toast').hidden, true);
});
