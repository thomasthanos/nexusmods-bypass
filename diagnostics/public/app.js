import { createApiClient, formatNumber, formatPercent, formatDate, relativeTime, buildDebugPrompt, safeGithubUrl, queryString, dateRange } from './lib.js';
import { mountPushManager } from './push.js';

const STATUSES = ['new', 'investigating', 'fixed', 'regressed', 'ignored'];
const BROWSERS = ['chrome', 'edge', 'firefox', 'safari', 'opera', 'brave', 'other'];
const SYSTEMS = ['windows', 'macos', 'linux', 'android', 'ios', 'chromeos', 'other'];
const FAULTS = ['client_env', 'upstream_site', 'rate_limit', 'extension_bug', 'unknown'];
const VIEWS = ['overview', 'issues', 'settings'];
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const issueIdentifier = (value) => /^[1-9][0-9]{0,15}$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const humanize = (value) => String(value ?? 'unknown').replaceAll('_', ' ');
const REPORT_SETUP = 'In the updated extension, open Settings → Diagnostics and enable “Send technical error reports automatically” and “Private diagnostics dashboard”. New automatic reports appear here after opt-in. Earlier Discord messages and manual reports are not imported.';
const GITHUB_ISSUES_URL = 'https://github.com/thomasthanos/nexusmods-bypass/issues';
const GITHUB_DISCUSSIONS_URL = 'https://github.com/thomasthanos/nexusmods-bypass/discussions';

/** The dashboard keeps private diagnostics in memory and renders data only as text. */
export function createDashboard({ document: doc = globalThis.document, window: win = globalThis.window, request: suppliedRequest, mountPush = mountPushManager } = {}) {
  const elements = Object.fromEntries(['connection-status', 'refresh-button', 'app-message', 'issue-dialog', 'issue-detail', 'close-issue', 'toast', ...VIEWS.map((name) => `view-${name}`)].map((id) => [id, doc.getElementById(id)]));
  if (Object.values(elements).some((value) => !value)) throw new Error('The dashboard shell is incomplete.');
  const slots = new Map();
  const listeners = [];
  const overviewFilters = { ...dateRange(30), browser: '', destination: '' };
  let issueFilters = { ...dateRange(30), q: '', version: '', browser: '', os: '', destination: '', download_mode: '', status: '', fault_origin: '', category: '', severity: '', muted: '' };
  let automaticOverviewDates = true;
  let automaticIssueDates = true;
  let currentView = 'overview';
  let viewGeneration = 0;
  let detailGeneration = 0;
  let invalidated = false;
  let destroyed = false;
  let issuePage = 1;
  let releasePage = 1;
  let mutedPage = 1;
  let detail = null;
  let selectedReport = null;
  let historyPage = 1;
  let historyGeneration = 0;
  let historyData = null;
  let pushManager = null;
  let toastTimer;
  let recoveryController = null;
  let recoveryPending = null;
  let wasBackgrounded = false;
  let lastResumeAt = 0;
  let compareVersions = { before: '', after: '' };
  const api = suppliedRequest ?? createApiClient({ onUnauthorized: invalidateSession });

  function node(tag, className = '', text) {
    const element = doc.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }
  function listen(target, event, callback, options) {
    target.addEventListener(event, callback, options);
    listeners.push(() => target.removeEventListener(event, callback, options));
  }
  function button(label, action, className = 'button') {
    const element = node('button', className, label);
    element.type = 'button';
    element.addEventListener('click', action);
    return element;
  }
  function field(label, name, value = '', choices) {
    const wrapper = node('label', 'field');
    wrapper.append(node('span', 'field-label', label));
    const input = node(choices ? 'select' : 'input', choices ? 'select' : 'input');
    input.name = name;
    if (choices) {
      const all = node('option', '', 'All'); all.value = ''; input.append(all);
      for (const choice of choices) { const option = node('option', '', humanize(choice)); option.value = choice; input.append(option); }
    } else { input.type = name === 'from' || name === 'to' ? 'date' : 'text'; input.autocomplete = 'off'; }
    input.value = value ?? '';
    wrapper.append(input);
    return wrapper;
  }
  function heading(title, description, level = 2) {
    const wrapper = node('div', level === 1 ? 'page-header' : 'panel-heading');
    const text = node('div'); text.append(node(`h${level}`, '', title));
    if (description) text.append(node('p', 'muted', description));
    wrapper.append(text); return wrapper;
  }
  function section(title, description) {
    const wrapper = node('section', 'panel detail-section');
    wrapper.append(heading(title, description)); return wrapper;
  }
  function tag(text, kind = '') { return node('span', `tag ${kind ? `tag-${kind}` : ''}`.trim(), humanize(text)); }
  function statusTag(status) { return tag(status, status === 'regressed' ? 'danger' : status === 'fixed' ? 'success' : status === 'investigating' ? 'warning' : ''); }
  function metric(label, value, note, className = '') {
    const card = node('div', `metric-card ${className}`.trim()); card.append(node('div', 'metric-label', label), node('div', 'metric-value', value));
    if (note) card.append(node('div', 'metric-note', note)); return card;
  }
  function empty(target, title, description) { const box = node('div', 'empty-state'); box.append(node('h3', '', title), node('p', 'muted', description)); target.append(box); }
  function loading(target, message = 'Loading diagnostics…') { target.replaceChildren(node('div', 'loading-state', message)); target.setAttribute('aria-busy', 'true'); }
  function settled(target) { target.removeAttribute('aria-busy'); }
  function isCurrent(generation) { return !destroyed && !invalidated && generation === viewGeneration; }
  function isDetailCurrent(generation) { return !destroyed && !invalidated && generation === detailGeneration && elements['issue-dialog'].open; }
  function abortSlot(name) { const controller = slots.get(name); controller?.abort(); slots.delete(name); }
  function abortAll(prefix = '') { for (const name of [...slots.keys()]) if (name.startsWith(prefix)) abortSlot(name); }
  async function request(name, path, options = {}) {
    abortSlot(name);
    if (invalidated || destroyed) throw new DOMException('Session unavailable', 'AbortError');
    const controller = new AbortController(); slots.set(name, controller);
    try {
      const result = await api(path, { ...options, signal: controller.signal });
      if (controller.signal.aborted) throw new DOMException('Request cancelled', 'AbortError');
      return result;
    }
    catch (error) {
      if (controller.signal.aborted) throw new DOMException('Request cancelled', 'AbortError');
      if (error?.status === 401) invalidateSession(error.authInfo); throw error;
    }
    finally { if (slots.get(name) === controller) slots.delete(name); }
  }
  function notify(message, kind = 'info') {
    if (invalidated || destroyed) return;
    win.clearTimeout(toastTimer);
    if (elements['issue-dialog'].open) {
      elements.toast.hidden = true; elements.toast.textContent = '';
      let feedback = elements['issue-detail'].querySelector('[data-dialog-status]');
      if (!feedback) { feedback = node('p', 'inline-message'); feedback.dataset.dialogStatus = ''; feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite'); elements['issue-detail'].append(feedback); }
      feedback.textContent = message; feedback.hidden = false; feedback.dataset.kind = kind;
      return;
    }
    const toast = elements.toast; toast.hidden = false; toast.dataset.kind = kind; toast.textContent = message;
    toastTimer = win.setTimeout(() => { toast.hidden = true; toast.textContent = ''; }, 6500);
  }
  function errorMessage(error) {
    if (win.navigator.onLine === false) return 'You are offline. Reconnect and retry; diagnostics are not stored on this device.';
    if (error?.status === 429) return `Too many requests. Retry${Number.isFinite(error.retryAfter) ? ` in ${Math.ceil(error.retryAfter)} seconds` : ' shortly'}.`;
    if (error?.status === 404) return 'This issue is unavailable or has been removed.';
    if (error?.status === 409) return 'The issue changed while saving. Refresh its details and retry.';
    if (error?.status === 403) return 'The request was blocked. Your session may still be valid. Retry or check the site’s security rules.';
    if (error?.status === 400) return 'These filters or values are invalid. Check the dates, release versions and GitHub issue URL.';
    return 'Diagnostics could not be loaded. Check your connection and retry.';
  }
  function showError(target, error, retry) {
    if (error?.name === 'AbortError' || invalidated || destroyed) return;
    settled(target); const box = node('div', 'error-state'); box.setAttribute('role', 'alert');
    box.append(node('p', '', errorMessage(error)));
    if (retry) box.append(button('Retry', retry));
    target.replaceChildren(box);
  }
  function updateConnection() {
    const status = elements['connection-status'];
    status.textContent = invalidated ? 'Sign in required' : win.navigator.onLine === false ? 'Offline' : 'Connected';
    status.dataset.state = invalidated ? 'error' : win.navigator.onLine === false ? 'offline' : 'online';
  }
  function invalidateSession(info) {
    if (invalidated || destroyed) return;
    invalidated = true; viewGeneration++; detailGeneration++; abortAll();
    pushManager?.dispose(); pushManager = null; detail = null; selectedReport = null; historyData = null;
    for (const view of VIEWS) elements[`view-${view}`].replaceChildren();
    elements['issue-detail'].replaceChildren();
    if (elements['issue-dialog'].open) elements['issue-dialog'].close();
    elements.toast.hidden = true; elements.toast.textContent = ''; win.clearTimeout(toastTimer);
    const message = elements['app-message']; message.hidden = false;
    const link = node('a', 'button button-primary', 'Sign in again'); link.href = `${win.location.pathname}${win.location.search}`;
    const actions = node('div', 'button-row'); actions.append(link, button('Check session', () => { void recoverSession(); }, 'button button-quiet'));
    message.replaceChildren(node('h2', '', 'Sign in to continue'), node('p', '', 'Your private logs are protected. Sign in again, or check your session if you already signed in.'), actions);
    // Only fixed rejection codes and request metadata are shown. Never display
    // provider HTML, token claims, response bodies, or URL search parameters.
    const reasonLabels = { missing_assertion: 'Cloudflare did not forward a sign-in token.', malformed_assertion: 'The sign-in token was malformed.',
      issuer_mismatch: 'The sign-in token belongs to a different Access team.', audience_mismatch: 'The sign-in token belongs to a different application.',
      invalid_claims: 'The sign-in token contains invalid claims.', expired_or_not_yet_valid: 'The sign-in token is outside its valid time window.',
      invalid_signature: 'The sign-in token signature could not be verified.', verifier_unavailable: 'The sign-in verifier is temporarily unavailable.',
      configuration_invalid: 'The dashboard’s Access configuration needs attention.' };
    const sourceLabels = { redirect: 'Cloudflare requested a sign-in redirect.', html: 'Cloudflare returned a sign-in page.', http_401: 'The server could not verify this session.' };
    const explanation = Object.hasOwn(reasonLabels, info?.reason) ? reasonLabels[info.reason] : Object.hasOwn(sourceLabels, info?.source) ? sourceLabels[info.source] : null;
    if (explanation) {
      const feedback = node('div', 'muted'); feedback.dataset.authDiagnostics = ''; feedback.append(node('p', '', explanation));
      const parts = [];
      if (Number.isInteger(info?.status) && info.status >= 0 && info.status <= 599) parts.push(`HTTP ${info.status}`);
      if (typeof info?.endpoint === 'string' && /^\/api\/admin\/[a-z0-9/_-]{1,128}$/i.test(info.endpoint)) parts.push(info.endpoint);
      if (parts.length) feedback.append(node('p', '', parts.join(' · ')));
      if (typeof info?.requestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(info.requestId)) feedback.append(node('p', '', `Request ${info.requestId}`));
      message.append(feedback);
    }
    for (const control of doc.querySelectorAll('[data-view], #refresh-button')) control.disabled = true;
    updateConnection();
  }
  function validDates(from, to) {
    const start = Date.parse(`${from}T00:00:00.000Z`); const end = Date.parse(`${to}T00:00:00.000Z`);
    return /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start && end - start < 366 * 86_400_000;
  }
  function filtersFrom(form, fields) { return Object.fromEntries(Object.keys(fields).map((key) => [key, String(form.elements.namedItem(key)?.value ?? '').trim()])); }
  function dateError(form) { let message = form.querySelector('[data-validation]'); if (!message) { message = node('p', 'inline-message', 'Choose a valid UTC date range of at most 366 days.'); message.dataset.validation = ''; message.setAttribute('role', 'alert'); form.append(message); } }
  function pagination(target, value, onPage, history = false) {
    const page = Number(value.page) || 1; const limit = Number(value.limit) || 20; const total = Math.max(0, Number(value.total) || 0);
    const pages = Math.max(1, Math.ceil(total / limit)); const wrapper = node('div', 'pagination');
    const previous = button('Previous', () => onPage(page - 1), 'button button-small'); previous.disabled = page <= 1;
    const next = button('Next', () => onPage(page + 1), 'button button-small'); next.disabled = page >= pages || page >= 10_000;
    if (history) { previous.dataset.historyPrevious = ''; next.dataset.historyNext = ''; }
    wrapper.append(previous, node('span', 'muted', `Page ${formatNumber(page)} of ${formatNumber(pages)} · ${formatNumber(total)} ${history ? 'reports' : 'results'}`), next); target.append(wrapper);
  }
  function issueRow(value) {
    const row = button('', () => { void openIssue(value.id); }, 'issue-row');
    const main = node('span', 'issue-main');
    const top = node('span', 'issue-row-heading'); top.append(node('strong', '', value.category ?? value.error_code ?? 'Unknown issue'), statusTag(value.status));
    if (value.muted) top.append(tag('muted'));
    const metadata = node('span', 'issue-row-meta');
    metadata.append(node('span', '', `#${value.id} · ${value.error_code ?? 'Unknown error'}`), node('span', '', `${value.last_seen_version ?? 'Unknown version'} · ${relativeTime(value.last_seen_at)}`));
    const counts = node('span', 'issue-count'); counts.append(node('strong', '', formatNumber(value.total_occurrences)), node('span', 'muted', `reports · ${formatNumber(value.affected_installs_count)} installs`));
    main.append(top, metadata); row.append(main, counts); return row;
  }

  async function loadOverview() {
    if (automaticOverviewDates) Object.assign(overviewFilters, dateRange(30));
    const generation = ++viewGeneration; abortAll('view:');
    const target = elements['view-overview']; loading(target);
    try {
      const filters = { ...overviewFilters };
      const [summary, releases] = await Promise.all([
        request('view:overview', `/overview${queryString(filters)}`),
        request('view:releases', `/releases${queryString({ ...filters, page: releasePage, limit: 10 })}`)
      ]);
      if (!isCurrent(generation)) return;
      target.replaceChildren(); settled(target);
      target.append(heading('Overview', 'Release health from opt-in session telemetry. Date filters use UTC.', 1));
      const form = node('form', 'toolbar'); form.dataset.form = 'overview';
      form.append(field('From', 'from', filters.from), field('To', 'to', filters.to), field('Browser', 'browser', filters.browser, BROWSERS), field('Destination', 'destination', filters.destination, ['browser', 'vortex', 'mo2']));
      const apply = node('button', 'button button-primary', 'Apply'); apply.type = 'submit'; form.append(apply);
      form.addEventListener('submit', (event) => { event.preventDefault(); const next = filtersFrom(form, overviewFilters); if (!validDates(next.from, next.to)) return dateError(form); if (next.from !== overviewFilters.from || next.to !== overviewFilters.to) automaticOverviewDates = false; Object.assign(overviewFilters, next); releasePage = 1; void loadOverview(); }); target.append(form);
      const metrics = summary.releases ?? {};
      const grid = node('div', 'metric-grid');
      grid.append(metric('Real success rate', formatPercent(metrics.success_rate_percent), `${formatNumber(metrics.success_count)} / ${formatNumber(metrics.attempts_count)} attempts`), metric('Fallback usage', formatPercent(metrics.fallback_rate_percent), `${formatNumber(metrics.fallback_triggered_count)} attempts used fallback`), metric('Issues in window', formatNumber(summary.issues?.total), `${formatNumber(summary.issues?.regressed_count)} regressed · ${formatNumber(summary.issues?.new_count)} new`), metric('Retained reports', formatNumber(summary.reports?.total), `${formatNumber(summary.reports?.distinct_installs)} anonymous installs`));
      target.append(grid);
      if (metrics.attempts_count === 0) target.append(node('p', 'inline-message', 'No download-attempt telemetry was received in this window. Error reports can populate Issues, but do not provide success or fallback rates.'));
      if (summary.reports?.total === 0) {
        const setup = section('How reports arrive'); setup.append(node('p', 'muted', REPORT_SETUP)); target.append(setup);
      }
      target.append(node('p', 'muted', 'Rates are weighted by attempts. Successes and fallback usage can overlap; error reports alone do not measure download success.'));
      const alerts = section('Live detection window', `The most recent ${Number.isFinite(summary.alerts?.window_seconds) ? formatNumber(summary.alerts.window_seconds / 60) : '—'} minutes; independent of the UTC date filter.`);
      const spikes = summary.alerts?.spikes;
      if (Array.isArray(spikes) && spikes.length) for (const spike of spikes) {
        const alert = button('', () => { void openIssue(spike.issue_id); }, 'issue-row');
        const main = node('span', 'issue-row-main');
        main.append(node('strong', 'issue-row-heading', `${spike.category} · #${spike.issue_id}`), node('span', 'issue-row-meta', `${formatNumber(spike.report_count)} reports across ${formatNumber(spike.distinct_installs)} installs · ${relativeTime(spike.last_seen_at)}`));
        alert.append(main, statusTag(spike.status)); alerts.append(alert);
      } else empty(alerts, spikes ? 'No active report spikes' : 'Live detection is unavailable', spikes ? 'No issue currently meets the configured report and distinct-install thresholds.' : 'Refresh after the API becomes available.');
      target.append(alerts);
      const health = section('Release health', 'Daily opt-in counters aggregated for the selected window.');
      if (!releases.items?.length) empty(health, 'No release telemetry', 'Try a wider date range or a different browser and destination.');
      else {
        const scroll = node('div', 'table-scroll'); const table = node('table', 'release-table'); const head = node('thead'); const header = node('tr');
        for (const label of ['Release', 'Attempts', 'Success', 'Fallback', 'Heartbeats']) header.append(node('th', '', label)); head.append(header); table.append(head);
        const body = node('tbody');
        for (const release of releases.items) { const row = node('tr'); for (const value of [release.version, formatNumber(release.attempts_count), formatPercent(release.success_rate_percent), formatPercent(release.fallback_rate_percent), formatNumber(release.heartbeat_count)]) row.append(node('td', '', value)); body.append(row); }
        table.append(body); scroll.append(table); health.append(scroll);
      }
      pagination(health, releases, (page) => { releasePage = page; void loadOverview(); }); target.append(health);
      renderComparison(target, releases.items ?? [], generation);
    } catch (error) { if (isCurrent(generation)) showError(target, error, () => { void loadOverview(); }); }
  }
  function renderComparison(target, releases, generation) {
    const wrapper = section('Before / after a release', 'Compare two releases using the same UTC dates, browser and destination above.');
    const form = node('form', 'toolbar'); form.dataset.form = 'comparison';
    if (!compareVersions.after && releases[0]) compareVersions.after = releases[0].version;
    if (!compareVersions.before && releases[1]) compareVersions.before = releases[1].version;
    form.append(field('Before release', 'before', compareVersions.before), field('After release', 'after', compareVersions.after));
    for (const input of form.querySelectorAll('input')) { input.required = true; input.maxLength = 64; input.placeholder = '3.2.0'; }
    const submit = node('button', 'button button-primary', 'Compare releases'); submit.type = 'submit'; form.append(submit);
    const result = node('div'); result.dataset.comparisonResult = ''; result.setAttribute('aria-live', 'polite');
    let comparisonGeneration = 0;
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); compareVersions = { before: form.elements.namedItem('before').value.trim(), after: form.elements.namedItem('after').value.trim() };
      const comparisonRequest = ++comparisonGeneration;
      if (!SEMVER.test(compareVersions.before) || !SEMVER.test(compareVersions.after)) { result.replaceChildren(node('p', 'inline-message', 'Enter full release versions, such as 3.2.0.')); return; }
      submit.disabled = true; loading(result, 'Comparing release telemetry…');
      try {
        const comparison = await request('view:compare', `/releases/compare${queryString({ ...overviewFilters, ...compareVersions })}`);
        if (!isCurrent(generation) || comparisonRequest !== comparisonGeneration) return;
        result.replaceChildren(); settled(result); const grid = node('div', 'comparison-grid');
        for (const [label, release] of [['Before', comparison.before], ['After', comparison.after]]) {
          const card = node('div', 'metric-card'); card.append(node('h3', '', `${label} · ${release.version}`), node('p', '', `${formatPercent(release.success_rate_percent)} success · ${formatPercent(release.fallback_rate_percent)} fallback`), node('p', 'muted', `${formatNumber(release.attempts_count)} attempts`));
          if (!release.attempts_count) card.append(node('p', 'muted', 'No attempts recorded.')); grid.append(card);
        }
        result.append(grid);
        const delta = (value) => typeof value === 'number' && Number.isFinite(value) ? `${value > 0 ? '+' : ''}${value.toFixed(1)} pp` : '—';
        result.append(node('p', 'inline-message', `Change: ${delta(comparison.success_rate_delta_pp)} success · ${delta(comparison.fallback_rate_delta_pp)} fallback. Percentage points, after minus before.`));
      } catch (error) { if (isCurrent(generation) && comparisonRequest === comparisonGeneration) showError(result, error, () => { form.requestSubmit(); }); }
      finally { if (isCurrent(generation) && comparisonRequest === comparisonGeneration) submit.disabled = false; }
    });
    wrapper.append(form, result); target.append(wrapper);
  }

  async function loadGithubIssues(target, generation) {
    loading(target, 'Loading open GitHub issues…');
    try {
      const data = await request('view:github', '/github-issues');
      if (!isCurrent(generation)) return;
      if (!Array.isArray(data?.items)) throw new Error('Invalid GitHub response');
      target.replaceChildren(); settled(target);
      if (data.stale) target.append(node('p', 'inline-message', 'GitHub is temporarily unavailable. Showing the last cached list; use Refresh to retry.'));
      if (!data.items.length) empty(target, 'No open GitHub issues', 'New public reports will appear here after the next refresh.');
      else {
        const list = node('div', 'issue-list');
        for (const issue of data.items) {
          const url = safeGithubUrl(issue?.url);
          if (!Number.isSafeInteger(issue?.number) || issue.number < 1 || issue.state !== 'open' || typeof issue.title !== 'string' || url !== `${GITHUB_ISSUES_URL}/${issue.number}`) continue;
          const row = node('a', 'issue-row'); row.href = url; row.target = '_blank'; row.rel = 'noopener noreferrer';
          const main = node('span', 'issue-main');
          const title = node('span', 'issue-row-heading'); title.append(node('strong', '', issue.title), tag('GitHub'), tag('open', 'success'));
          const metadata = node('span', 'issue-row-meta'); metadata.append(node('span', '', `#${issue.number} · Updated ${relativeTime(issue.updated_at)}`));
          if (Array.isArray(issue.labels)) for (const label of issue.labels) if (typeof label === 'string') metadata.append(tag(label));
          if (Number.isSafeInteger(issue.comments) && issue.comments >= 0) metadata.append(node('span', '', `${formatNumber(issue.comments)} comments`));
          main.append(title, metadata); row.append(main); list.append(row);
        }
        target.append(list);
      }
      if (data.truncated) target.append(node('p', 'muted source-note', 'More open issues are available in the complete GitHub list.'));
      target.append(node('p', 'muted source-note', `GitHub last checked ${formatDate(data.fetched_at)}.`));
    } catch (error) {
      if (!isCurrent(generation) || error?.name === 'AbortError') return;
      settled(target); target.replaceChildren(node('p', 'inline-message', 'GitHub issues are temporarily unavailable. Use Refresh to retry, or open the repository on GitHub.'));
    }
  }
  async function loadGithubDiscussions(target, generation) {
    loading(target, 'Loading recent GitHub discussions…');
    try {
      const data = await request('view:github-discussions', '/github-discussions');
      if (!isCurrent(generation)) return;
      if (!Array.isArray(data?.items)) throw new Error('Invalid GitHub response');
      target.replaceChildren(); settled(target);
      if (data.stale) target.append(node('p', 'inline-message', 'GitHub discussions are temporarily unavailable. Showing the last cached feed; use Refresh to retry.'));
      const list = node('div', 'issue-list');
      for (const discussion of data.items) {
        if (!Number.isSafeInteger(discussion?.number) || discussion.number < 1 || typeof discussion.title !== 'string'
          || discussion.url !== `${GITHUB_DISCUSSIONS_URL}/${discussion.number}`) continue;
        const row = node('a', 'issue-row'); row.href = discussion.url; row.target = '_blank'; row.rel = 'noopener noreferrer';
        const main = node('span', 'issue-main');
        const title = node('span', 'issue-row-heading'); title.append(node('strong', '', discussion.title), tag('Discussion'));
        main.append(title, node('span', 'issue-row-meta', `#${discussion.number} · Updated ${relativeTime(discussion.updated_at)}`));
        row.append(main); list.append(row);
      }
      if (list.childElementCount) target.append(list);
      else empty(target, 'No recent GitHub discussions', 'The public feed has no recent discussions. Open GitHub to browse the complete discussion list.');
      target.append(node('p', 'muted source-note', `Recent discussion feed last checked ${formatDate(data.fetched_at)}.`));
    } catch (error) {
      if (!isCurrent(generation) || error?.name === 'AbortError') return;
      settled(target); target.replaceChildren(node('p', 'inline-message', 'GitHub discussions are temporarily unavailable. Use Refresh to retry, or open discussions on GitHub.'));
    }
  }
  function resetIssueFilters() {
    automaticIssueDates = true;
    issueFilters = { ...Object.fromEntries(Object.keys(issueFilters).map((key) => [key, ''])), ...dateRange(30) };
    issuePage = 1; void loadIssues();
  }
  async function loadIssues() {
    if (automaticIssueDates) Object.assign(issueFilters, dateRange(30));
    const generation = ++viewGeneration; abortAll('view:'); const view = elements['view-issues']; view.replaceChildren(); settled(view);
    view.append(heading('Issues', 'Public GitHub issues, recent discussions and automatic extension diagnostics.', 1));
    const github = section('Open GitHub issues', 'Public reports from thomasthanos/nexusmods-bypass. Diagnostic date, status and environment filters apply below.'); github.dataset.githubIssues = '';
    const repository = node('a', 'button button-quiet button-small', 'Open GitHub issues ↗'); repository.href = GITHUB_ISSUES_URL; repository.target = '_blank'; repository.rel = 'noopener noreferrer'; github.firstElementChild.append(repository);
    const githubContent = node('div'); github.append(githubContent); view.append(github);
    const discussions = section('Recent GitHub discussions', 'Recent entries from the public repository feed. Diagnostic filters apply to extension reports below.'); discussions.dataset.githubDiscussions = '';
    const discussionRepository = node('a', 'button button-quiet button-small', 'Open GitHub discussions ↗'); discussionRepository.href = GITHUB_DISCUSSIONS_URL; discussionRepository.target = '_blank'; discussionRepository.rel = 'noopener noreferrer'; discussions.firstElementChild.append(discussionRepository);
    const discussionsContent = node('div'); discussions.append(discussionsContent); view.append(discussions);
    const target = node('section', 'stack'); target.dataset.diagnosticIssues = ''; target.setAttribute('aria-label', 'Automatic extension diagnostics'); view.append(target);
    const githubPending = Promise.all([loadGithubIssues(githubContent, generation), loadGithubDiscussions(discussionsContent, generation)]);
    loading(target, 'Loading extension diagnostics…');
    try {
      const data = await request('view:issues', `/issues${queryString({ ...issueFilters, page: issuePage, limit: 20 })}`);
      if (!isCurrent(generation)) return;
      target.replaceChildren(); settled(target); target.append(heading('Extension diagnostics', 'Grouped opt-in error reports. Search failures, then inspect their evidence. Dates use UTC.'));
      const form = node('form', 'panel'); form.dataset.form = 'issues';
      const primary = node('div', 'toolbar'); primary.append(field('Search', 'q', issueFilters.q), field('Status', 'status', issueFilters.status, STATUSES), field('Version', 'version', issueFilters.version));
      primary.querySelector('[name="q"]').maxLength = 200; primary.querySelector('[name="version"]').maxLength = 64;
      const apply = node('button', 'button button-primary', 'Apply filters'); apply.type = 'submit'; primary.append(apply); form.append(primary);
      const disclosure = node('details', 'disclosure'); disclosure.open = Object.entries(issueFilters).some(([key, value]) => !['q', 'status', 'version', 'from', 'to'].includes(key) && value);
      disclosure.append(node('summary', '', 'Environment, classification & dates'));
      const advanced = node('div', 'filter-grid');
      for (const [label, name, choices] of [['Browser', 'browser', BROWSERS], ['OS', 'os', SYSTEMS], ['Destination', 'destination', ['browser', 'vortex', 'mo2']], ['Mode', 'download_mode', ['manual', 'auto']], ['Fault origin', 'fault_origin', FAULTS], ['Severity', 'severity', ['debug', 'info', 'warning', 'error', 'fatal']], ['Muted', 'muted', ['true', 'false']]]) advanced.append(field(label, name, issueFilters[name], choices));
      advanced.append(field('Category', 'category', issueFilters.category), field('From', 'from', issueFilters.from), field('To', 'to', issueFilters.to)); advanced.querySelector('[name="category"]').maxLength = 80;
      disclosure.append(advanced); form.append(disclosure);
      form.append(button('Reset filters', resetIssueFilters, 'button button-quiet button-small'));
      form.addEventListener('submit', (event) => {
        event.preventDefault(); const next = filtersFrom(form, issueFilters); if (!validDates(next.from, next.to)) return dateError(form);
        if ((next.version && !SEMVER.test(next.version)) || (next.category && !/^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(next.category))) {
          form.querySelector('[data-validation]')?.remove(); const validation = node('p', 'inline-message', 'Enter a complete release version and a category identifier, such as DOM_SELECTOR_MISSING.'); validation.dataset.validation = ''; validation.setAttribute('role', 'alert'); form.append(validation); return;
        }
        if (next.from !== issueFilters.from || next.to !== issueFilters.to) automaticIssueDates = false;
        issueFilters = next; issuePage = 1; void loadIssues();
      }); target.append(form);
      const list = node('div', 'issue-list'); list.setAttribute('aria-label', 'Filtered issues');
      if (data.items?.length) for (const value of data.items) list.append(issueRow(value));
      else empty(list, 'No matching issues', 'Change the filters or expand the UTC date range.'); target.append(list);
      pagination(target, data, (page) => { issuePage = page; void loadIssues(); });
    } catch (error) {
      if (isCurrent(generation)) {
        showError(target, error, () => { void loadIssues(); });
        if (!invalidated && error?.name !== 'AbortError') target.append(button('Reset filters', resetIssueFilters, 'button button-quiet'));
      }
    }
    await githubPending;
  }

  async function loadSettings() {
    const generation = ++viewGeneration; abortAll('view:'); const target = elements['view-settings'];
    pushManager?.dispose(); pushManager = null; target.replaceChildren(); settled(target);
    target.append(heading('Settings', 'Manage this device’s notifications and quiet recurring issues.', 1));
    const push = section('Push manager'); const mount = node('div'); push.append(mount); target.append(push);
    try { pushManager = mountPush(mount, { request: async (path, options) => {
      try {
        if (invalidated || destroyed) throw new DOMException('Session unavailable', 'AbortError');
        const result = await api(path, options);
        if (invalidated || destroyed) throw new DOMException('Session unavailable', 'AbortError');
        return result;
      } catch (error) {
        if (options?.signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
        if (error?.status === 401) invalidateSession(error.authInfo); throw error;
      }
    }, notify }); }
    catch { mount.replaceChildren(node('p', 'error-state', 'Push controls could not be initialized. Refresh to retry.')); }
    const rules = section('Muted issues', 'Issues active in the last 30 UTC days. Open an issue to change its mute or lifecycle rule. Ignored issues also suppress push alerts.');
    const list = node('div', 'issue-list'); loading(list, 'Loading mute rules…'); rules.append(list); target.append(rules);
    const privacy = section('Private by design'); privacy.append(node('p', 'muted', REPORT_SETUP), node('p', 'muted', 'Cloudflare Access protects this dashboard and its API. Reports stay in memory while this page is open. Private responses are not cached for offline access. Sign in again when your Access session expires.')); target.append(privacy);
    try {
      const data = await request('view:muted', `/issues${queryString({ ...dateRange(30), muted: 'true', page: mutedPage, limit: 10 })}`);
      if (!isCurrent(generation)) return;
      settled(list); list.replaceChildren();
      if (data.items?.length) for (const value of data.items) list.append(issueRow(value)); else empty(list, 'No muted issues in this window', 'Mute an issue from its detail sheet to quiet its notifications.');
      pagination(rules, data, (page) => { mutedPage = page; void loadSettings(); });
    } catch (error) { if (isCurrent(generation)) showError(list, error, () => { void loadSettings(); }); }
  }

  function evidence(title, value) {
    const wrapper = node('section', 'evidence-block'); wrapper.append(node('h4', '', title));
    wrapper.append(node('pre', 'code-block', typeof value === 'string' ? value : JSON.stringify(value, null, 2))); return wrapper;
  }
  function keyValues(pairs) {
    const list = node('dl', 'metadata-grid');
    for (const [key, value] of pairs) { const entry = node('div'); entry.append(node('dt', 'muted', key), node('dd', '', value === null || value === undefined || value === '' ? '—' : value)); list.append(entry); } return list;
  }
  function classification(title, value) {
    const box = section(title); const labels = node('div', 'toolbar'); labels.append(tag(value.category ?? 'unknown'), tag(value.fault_origin ?? 'unknown')); box.append(labels, node('p', '', value.suggested_action ?? 'No suggested action was recorded.')); return box;
  }
  function renderReport(target, report) {
    target.replaceChildren();
    if (!report) { empty(target, 'Report bodies are no longer retained', 'Lifetime issue counts and grouping remain available. New reports will appear here.'); return; }
    const environment = section('Selected report', `${report.id} · received ${formatDate(report.created_at)}`);
    environment.append(keyValues([['Version', report.version], ['Browser', `${report.browser ?? '—'} ${report.browser_version ?? ''}`.trim()], ['OS', `${report.os ?? '—'} ${report.os_version ?? ''}`.trim()], ['Destination / mode', `${report.destination ?? '—'} / ${report.download_mode ?? '—'}`], ['Severity', report.severity], ['Occurred', formatDate(report.occurred_at)], ['Failure stage', report.failure_stage], ['HTTP / Retry-After', `${report.http_status ?? '—'} / ${report.retry_after ?? '—'}`], ['Mod / collection', `${report.mod_id ?? '—'} / ${report.collection_id ?? '—'}`]]));
    environment.append(evidence('Error message', report.error_message ?? 'No message retained.')); target.append(environment, classification('Rule Engine · this report at ingestion', report));
    const timeline = section('Execution timeline', 'Offsets and durations are reported by the extension. Bars share the same elapsed-time scale.');
    const breadcrumbs = Array.isArray(report.breadcrumbs) ? report.breadcrumbs : [];
    if (!breadcrumbs.length) empty(timeline, 'No breadcrumbs recorded', 'This report did not include an execution timeline.');
    else {
      const total = Math.max(1, ...breadcrumbs.map((crumb) => Math.max(0, Number(crumb.timestamp_offset_ms) || 0) + Math.max(0, Number(crumb.duration_ms) || 0)));
      const list = node('ol', 'timeline');
      for (const crumb of breadcrumbs) {
        const row = node('li', 'timeline-row'); row.dataset.status = crumb.status;
        const content = node('div', 'timeline-content'); const title = node('div', 'timeline-heading'); title.append(node('strong', '', `${crumb.stage} → ${crumb.action}`), tag(crumb.status, crumb.status === 'error' ? 'danger' : crumb.status === 'warn' ? 'warning' : 'success'));
        const offset = Math.max(0, Number(crumb.timestamp_offset_ms) || 0); const duration = Number.isFinite(crumb.duration_ms) ? Math.max(0, crumb.duration_ms) : null;
        row.append(node('div', 'timeline-time', `+${formatNumber(offset)} ms`));
        content.append(title, node('p', 'muted', `${duration === null ? 'Duration not recorded' : `${formatNumber(duration)} ms`}${crumb.http_status ? ` · HTTP ${crumb.http_status}` : ''}`));
        const track = node('div', 'timeline-track'); track.setAttribute('aria-hidden', 'true'); const bar = node('span', `timeline-bar timeline-bar-${crumb.status}`); bar.style.marginLeft = `${Math.min(100, offset * 100 / total)}%`; bar.style.width = `${Math.max(0.5, Math.min(100 - offset * 100 / total, (duration ?? 0) * 100 / total))}%`; track.append(bar); content.append(track);
        if (crumb.metadata && Object.keys(crumb.metadata).length) content.append(evidence('Step metadata', crumb.metadata)); row.append(content); list.append(row);
      }
      timeline.append(list, node('p', 'muted', `Reported timeline: ${formatNumber(total)} ms.`));
    }
    target.append(timeline);
    const diagnostic = section('DOM & API evidence');
    if (report.dom_state) diagnostic.append(evidence('Document, selectors & API schema', report.dom_state)); else diagnostic.append(node('p', 'muted', 'No DOM state was included.'));
    if (report.context && Object.keys(report.context).length) diagnostic.append(evidence('Request context', report.context)); target.append(diagnostic);
    const stack = section('Stack trace'); stack.append(evidence('Sanitized stack', report.stack_trace || 'No stack trace retained.')); target.append(stack);
  }
  function renderLifecycle(target, value, generation) {
    target.replaceChildren(); target.append(heading('Issue lifecycle', 'A fixed or regressed issue needs a release baseline. Muted and ignored issues suppress push notifications.'));
    const form = node('form', 'filter-grid'); form.dataset.form = 'lifecycle';
    const status = field('Status', 'status', value.status, STATUSES); status.querySelector('option[value=""]')?.remove();
    form.append(status, field('Fixed in version', 'fixed_in_version', value.fixed_in_version ?? ''), field('GitHub issue URL', 'github_issue_url', value.github_issue_url ?? ''));
    form.elements.namedItem('fixed_in_version').maxLength = 64; form.elements.namedItem('fixed_in_version').placeholder = '3.2.1'; form.elements.namedItem('github_issue_url').maxLength = 2048; form.elements.namedItem('github_issue_url').type = 'url'; form.elements.namedItem('github_issue_url').placeholder = 'https://github.com/owner/repo/issues/42';
    const mute = node('label', 'field'); const check = node('input'); check.type = 'checkbox'; check.name = 'muted'; check.checked = Boolean(value.muted); mute.append(check, node('span', '', 'Mute this issue')); form.append(mute);
    const submit = node('button', 'button button-primary', 'Save changes'); submit.type = 'submit'; form.append(submit);
    const feedback = node('p', 'inline-message'); feedback.dataset.lifecycleFeedback = ''; feedback.setAttribute('role', 'status'); form.append(feedback);
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); if (submit.disabled) return;
      const nextStatus = form.elements.namedItem('status').value; const fixed = form.elements.namedItem('fixed_in_version').value.trim(); const github = form.elements.namedItem('github_issue_url').value.trim();
      if ((['fixed', 'regressed'].includes(nextStatus) && !fixed) || (fixed && !SEMVER.test(fixed))) { feedback.textContent = 'Enter a valid fixed release version before saving this status.'; return; }
      if (github && !safeGithubUrl(github)) { feedback.textContent = 'Use a complete HTTPS github.com issue URL, without query parameters.'; return; }
      const patch = {};
      if (nextStatus !== value.status) patch.status = nextStatus;
      if ((fixed || null) !== (value.fixed_in_version ?? null)) patch.fixed_in_version = fixed || null;
      if ((github || null) !== (value.github_issue_url ?? null)) patch.github_issue_url = github || null;
      if (check.checked !== Boolean(value.muted)) patch.muted = check.checked;
      if (!Object.keys(patch).length) { feedback.textContent = 'No changes to save.'; return; }
      patch.expected = { status: value.status, fixed_in_version: value.fixed_in_version ?? null, github_issue_url: value.github_issue_url ?? null, muted: Boolean(value.muted), updated_at: value.updated_at };
      submit.disabled = true; feedback.textContent = 'Saving…';
      try {
        const response = await request('detail:mutation', `/issues/${value.id}`, { method: 'PATCH', body: patch });
        if (!isDetailCurrent(generation)) return;
        detail.issue = response.issue; renderDetail(generation); notify('Issue updated.', 'success');
        elements['issue-detail'].querySelector('[data-lifecycle-feedback]').textContent = 'Issue updated.';
      } catch (error) { if (isDetailCurrent(generation) && error?.name !== 'AbortError') { feedback.textContent = errorMessage(error); if (error?.status === 409) feedback.append(button('Refresh details', () => { void openIssue(value.id, { replace: true }); }, 'button button-small')); } }
      finally { if (isDetailCurrent(generation)) submit.disabled = false; }
    });
    target.append(form); const github = safeGithubUrl(value.github_issue_url);
    if (github) { const link = node('a', 'button button-quiet', 'Open GitHub issue ↗'); link.href = github; link.target = '_blank'; link.rel = 'noopener noreferrer'; target.append(link); }
  }
  function renderHistory(target, generation) {
    target.replaceChildren(); target.append(heading('Report history', 'Select a retained report to inspect its environment and evidence.'));
    if (!historyData?.items?.length) empty(target, 'No retained report bodies', 'Issue counters survive report retention.');
    else {
      const list = node('div', 'issue-list');
      for (const report of historyData.items) {
        const item = button(`${report.version} · ${report.browser} / ${report.os} · ${formatDate(report.created_at)}`, () => {
          if (!isDetailCurrent(generation)) return; selectedReport = report;
          renderReport(elements['issue-detail'].querySelector('[data-selected-report]'), selectedReport); renderHistory(target, generation);
          elements['issue-detail'].querySelector('[data-manual-copy-section]')?.remove();
        }, 'issue-row'); item.dataset.reportId = report.id; item.setAttribute('aria-pressed', String(selectedReport?.id === report.id)); list.append(item);
      }
      target.append(list);
    }
    if (historyData) pagination(target, historyData, (page) => { void loadHistory(page, generation, target); }, true);
  }
  async function loadHistory(page, generation, target) {
    if (!detail || !isDetailCurrent(generation)) return;
    const historyRequest = ++historyGeneration;
    historyPage = page; loading(target, 'Loading report history…');
    try {
      const data = await request('detail:history', `/issues/${detail.issue.id}/reports${queryString({ page, limit: 5 })}`);
      if (!isDetailCurrent(generation) || historyPage !== page || historyRequest !== historyGeneration) return;
      historyData = data; const activeTarget = elements['issue-detail'].querySelector('[data-report-history]'); settled(activeTarget); renderHistory(activeTarget, generation);
    } catch (error) {
      if (isDetailCurrent(generation) && historyPage === page && historyRequest === historyGeneration) {
        const activeTarget = elements['issue-detail'].querySelector('[data-report-history]'); showError(activeTarget, error, () => { void loadHistory(page, generation, activeTarget); });
      }
    }
  }
  async function copyContext(generation, copyButton) {
    if (!detail || !isDetailCurrent(generation)) return;
    const copiedReport = selectedReport;
    const context = buildDebugPrompt(detail, selectedReport); copyButton.disabled = true;
    try {
      if (!win.navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await win.navigator.clipboard.writeText(context);
      if (isDetailCurrent(generation) && copiedReport === selectedReport) notify('AI debug context copied.', 'success');
    } catch {
      if (!isDetailCurrent(generation) || copiedReport !== selectedReport) return;
      const target = elements['issue-detail']; target.querySelector('[data-manual-copy-section]')?.remove();
      const manual = section('Copy context manually', 'Clipboard access is unavailable. Select and copy the complete Markdown below.'); manual.dataset.manualCopySection = '';
      const text = node('textarea', 'input code-block'); text.dataset.manualCopy = ''; text.readOnly = true; text.rows = 12; text.value = context; text.setAttribute('aria-label', 'Complete AI debug context');
      manual.append(text, button('Select all context', () => { text.focus(); text.select(); }, 'button button-small')); target.append(manual); text.focus(); text.select(); notify('Select and copy the context below.', 'info');
    } finally { if (isDetailCurrent(generation)) copyButton.disabled = false; }
  }
  function renderDetail(generation) {
    if (!detail || !isDetailCurrent(generation)) return;
    const target = elements['issue-detail']; target.replaceChildren(); settled(target); const value = detail.issue;
    const title = node('h2', '', `Issue #${value.id}`); title.id = 'issue-title'; target.append(title, node('p', 'muted', value.error_code ?? 'Unknown error'));
    const labels = node('div', 'toolbar'); labels.append(statusTag(value.status), tag(value.category), tag(value.fault_origin)); if (value.muted) labels.append(tag('muted')); target.append(labels);
    const summary = node('div', 'metric-grid');
    summary.append(metric('Lifetime reports', formatNumber(value.total_occurrences)), metric('Affected installs', formatNumber(value.affected_installs_count)),
      metric('First seen', formatDate(value.first_seen_at), value.first_seen_version, 'metric-date'), metric('Last seen', formatDate(value.last_seen_at), value.last_seen_version, 'metric-date'));
    target.append(summary);
    const copy = button('Copy AI Debug Context', () => { void copyContext(generation, copy); }, 'button button-primary'); copy.dataset.action = 'copy-context'; target.append(copy);
    const feedback = node('p', 'inline-message'); feedback.dataset.dialogStatus = ''; feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite'); feedback.hidden = true; target.append(feedback);
    target.append(classification('Rule Engine · current issue', value));
    const grouping = section('Grouping & affected environments'); grouping.append(keyValues([['Fingerprint', value.fingerprint], ['Original category', value.error_category], ['Failure stage', value.failure_stage], ['Destination', value.destination], ['Normalized top frame', value.normalized_top_frame], ['Retained reports', formatNumber(detail.report_summary?.retained_report_count)], ['Browsers', detail.report_summary?.browsers?.join(', ')], ['Versions', `${detail.report_summary?.versions?.join(', ') ?? ''}${detail.report_summary?.versions_truncated ? ' (first 100)' : ''}`], ['Operating systems', detail.report_summary?.operating_systems?.join(', ')]])); target.append(grouping);
    const lifecycle = node('section', 'panel detail-section'); renderLifecycle(lifecycle, value, generation); target.append(lifecycle);
    const history = node('section', 'panel detail-section'); history.dataset.reportHistory = ''; renderHistory(history, generation); target.append(history);
    const report = node('div'); report.dataset.selectedReport = ''; renderReport(report, selectedReport); target.append(report);
  }
  function setIssueUrl(id, replace = false) {
    const url = new URL(win.location.href); if (id === null) url.searchParams.delete('issue'); else url.searchParams.set('issue', String(id));
    if (url.href !== win.location.href) win.history[replace ? 'replaceState' : 'pushState']({}, '', url);
  }
  async function openIssue(value, { replace = false, updateUrl = true } = {}) {
    const id = issueIdentifier(value); if (id === null || invalidated || destroyed) return;
    const generation = ++detailGeneration; abortAll('detail:'); detail = null; selectedReport = null; historyData = null; historyPage = 1;
    const dialog = elements['issue-dialog']; if (!dialog.open) dialog.showModal();
    if (updateUrl) setIssueUrl(id, replace);
    loading(elements['issue-detail'], `Loading issue #${id}…`); const title = node('h2', '', `Issue #${id}`); title.id = 'issue-title'; elements['issue-detail'].prepend(title);
    try {
      const result = await request('detail:issue', `/issues/${id}`);
      if (!isDetailCurrent(generation)) return; detail = result; selectedReport = result.latest_report ?? null; renderDetail(generation);
      await loadHistory(1, generation, elements['issue-detail'].querySelector('[data-report-history]'));
    } catch (error) {
      if (!isDetailCurrent(generation) || error?.name === 'AbortError') return;
      showError(elements['issue-detail'], error, () => { void openIssue(id, { replace: true }); });
      const title = node('h2', '', `Issue #${id}`); title.id = 'issue-title'; elements['issue-detail'].prepend(title);
    }
  }
  function clearIssue(updateUrl = true) {
    detailGeneration++; abortAll('detail:'); detail = null; selectedReport = null; historyData = null; elements['issue-detail'].replaceChildren();
    if (updateUrl && !invalidated && !destroyed) setIssueUrl(null, true);
  }
  async function navigate(view) {
    if (!VIEWS.includes(view) || invalidated || destroyed) return;
    currentView = view; viewGeneration++; abortAll('view:'); pushManager?.dispose(); pushManager = null;
    for (const name of VIEWS) { const target = elements[`view-${name}`]; target.hidden = name !== view; if (name !== view) target.replaceChildren(); }
    for (const item of doc.querySelectorAll('[data-view]')) { const active = item.dataset.view === view; item.setAttribute('aria-current', active ? 'page' : 'false'); item.classList.toggle('is-active', active); }
    if (view === 'overview') await loadOverview(); else if (view === 'issues') await loadIssues(); else await loadSettings();
  }
  function refresh() {
    if (invalidated || destroyed) return;
    void navigate(currentView);
    const id = detail?.issue.id ?? issueIdentifier(new URL(win.location.href).searchParams.get('issue'));
    if (elements['issue-dialog'].open && id !== null) void openIssue(id, { replace: true });
  }
  async function recoverSession() {
    if (destroyed || recoveryPending || win.navigator.onLine === false) return recoveryPending;
    if (!invalidated) { refresh(); return; }
    // The Home Screen app can be resumed after Access was renewed in a browser.
    // Only a fresh, authenticated server response may unlock private views.
    const controller = new AbortController(); recoveryController = controller;
    const check = elements['app-message'].querySelector('button');
    if (check) { check.disabled = true; check.textContent = 'Checking…'; }
    recoveryPending = (async () => {
      try {
        const result = await api('/health', { signal: controller.signal });
        if (destroyed || controller.signal.aborted || result?.ok !== true) return;
        invalidated = false;
        elements['app-message'].replaceChildren(); elements['app-message'].hidden = true;
        for (const control of doc.querySelectorAll('[data-view], #refresh-button')) control.disabled = false;
        updateConnection(); refresh();
        const id = issueIdentifier(new URL(win.location.href).searchParams.get('issue'));
        if (id !== null && !elements['issue-dialog'].open) void openIssue(id, { replace: true });
      } catch (error) {
        if (!destroyed && !controller.signal.aborted && error?.status !== 401) {
          let feedback = elements['app-message'].querySelector('[data-session-feedback]');
          if (!feedback) { feedback = node('p', 'muted'); feedback.dataset.sessionFeedback = ''; feedback.setAttribute('role', 'status'); elements['app-message'].append(feedback); }
          feedback.textContent = error?.status === 403 ? 'The session check was blocked. Your session may still be valid. Retry or check the site’s security rules.' : 'Could not check your session. Reconnect and try again.';
        }
      } finally {
        if (recoveryController === controller) recoveryController = null;
        recoveryPending = null;
        if (check?.isConnected) { check.disabled = false; check.textContent = 'Check session'; }
      }
    })();
    return recoveryPending;
  }
  function resume() {
    if (destroyed || doc.visibilityState === 'hidden' || win.navigator.onLine === false || Date.now() - lastResumeAt < 1000) return;
    lastResumeAt = Date.now(); void recoverSession();
  }
  function onVisibilityChange() {
    if (doc.visibilityState === 'hidden') { wasBackgrounded = true; return; }
    if (wasBackgrounded) { wasBackgrounded = false; resume(); }
  }
  function onPopState() {
    const id = issueIdentifier(new URL(win.location.href).searchParams.get('issue'));
    if (id !== null) void openIssue(id, { updateUrl: false });
    else { clearIssue(false); if (elements['issue-dialog'].open) elements['issue-dialog'].close(); }
  }
  for (const control of doc.querySelectorAll('[data-view]')) listen(control, 'click', () => { void navigate(control.dataset.view); });
  listen(elements['refresh-button'], 'click', refresh);
  listen(elements['close-issue'], 'click', () => { clearIssue(); if (elements['issue-dialog'].open) elements['issue-dialog'].close(); });
  listen(elements['issue-dialog'], 'close', () => { clearIssue(); });
  listen(elements['issue-dialog'], 'cancel', () => { clearIssue(); });
  listen(win, 'popstate', onPopState);
  listen(win, 'online', () => { updateConnection(); resume(); }); listen(win, 'offline', updateConnection);
  listen(doc, 'visibilitychange', onVisibilityChange);
  listen(win, 'pageshow', (event) => { if (event.persisted) resume(); });
  updateConnection(); void navigate('overview');
  const initial = issueIdentifier(new URL(win.location.href).searchParams.get('issue'));
  if (initial !== null) void openIssue(initial, { replace: true });
  return { navigate, openIssue, invalidateSession, destroy() { if (destroyed) return; destroyed = true; recoveryController?.abort(); viewGeneration++; detailGeneration++; abortAll(); pushManager?.dispose(); pushManager = null; detail = null; selectedReport = null; historyData = null; win.clearTimeout(toastTimer); for (const remove of listeners) remove(); for (const view of VIEWS) elements[`view-${view}`].replaceChildren(); elements['issue-detail'].replaceChildren(); } };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined' && document.getElementById('main-content')) createDashboard();
