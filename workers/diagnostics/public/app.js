import { createApiClient, formatNumber, formatPercent, formatDate, relativeTime, buildDebugPrompt, safeGithubUrl, queryString, dateRange } from './lib.js';
import { mountPushManager } from './push.js';
import { mountGrowth } from './growth.js';
import { createUi } from './ui.js';

const STATUSES = ['new', 'investigating', 'fixed', 'regressed', 'ignored'];
const BROWSERS = ['chrome', 'edge', 'firefox', 'safari', 'opera', 'brave', 'other'];
const SYSTEMS = ['windows', 'macos', 'linux', 'android', 'ios', 'chromeos', 'other'];
const FAULTS = ['client_env', 'upstream_site', 'rate_limit', 'extension_bug', 'unknown'];
const VIEWS = ['overview', 'issues', 'settings'];
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const issueIdentifier = (value) => /^[1-9][0-9]{0,15}$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const humanize = (value) => String(value ?? 'unknown').replaceAll('_', ' ');
const categoryLabel = (value) => ({ SECURITY_BLOCK: 'Security block', EXTENSION_CONFLICT: 'Extension conflict', HANDOFF_FAILURE: 'Download handoff', API_RATE_LIMIT: 'Request limit', API_SCHEMA_MISMATCH: 'Unexpected API response', DOM_SELECTOR_MISSING: 'Page element missing', NETWORK_UNREACHABLE: 'Connection issue', UPSTREAM_BREAKING_CHANGE: 'Website changed', UNKNOWN_ERROR: 'Unclassified error' }[value] ?? humanize(value).toLowerCase().replace(/^./, (letter) => letter.toUpperCase()));
const REPORT_SETUP = 'In extension Settings → Diagnostics, enable “Send technical error reports automatically” and “Private diagnostics dashboard”. New automatic reports appear here after opt-in. Earlier Discord messages and manual reports are not imported.';
const GITHUB_ISSUES_URL = 'https://github.com/thomasthanos/nexusmods-bypass/issues';
const GITHUB_DISCUSSIONS_URL = 'https://github.com/thomasthanos/nexusmods-bypass/discussions';

/** The dashboard keeps private diagnostics in memory and renders data only as text. */
export function createDashboard({ document: doc = globalThis.document, window: win = globalThis.window, request: suppliedRequest, mountPush = mountPushManager } = {}) {
  const elements = Object.fromEntries(['connection-status', 'refresh-button', 'app-message', 'issue-dialog', 'issue-detail', 'close-issue', 'toast', ...VIEWS.map((name) => `view-${name}`)].map((id) => [id, doc.getElementById(id)]));
  if (Object.values(elements).some((value) => !value)) throw new Error('The dashboard shell is incomplete.');
  const ui = createUi(doc);
  const { el: node, button } = ui;
  const tag = (text, kind = '') => ui.tag(humanize(text), kind);
  const slots = new Map();
  const listeners = [];
  const disclosureState = new Map();
  const growthUiState = {};
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
  let growthManager = null;
  let toastTimer;
  let recoveryController = null;
  let recoveryPending = null;
  let wasBackgrounded = false;
  let lastResumeAt = 0;
  let compareVersions = { before: '', after: '' };
  const api = suppliedRequest ?? createApiClient({ onUnauthorized: invalidateSession });

  function listen(target, event, callback, options) {
    target.addEventListener(event, callback, options);
    listeners.push(() => target.removeEventListener(event, callback, options));
  }
  function field(label, name, value = '', choices) {
    const wrapper = node('label', 'field');
    wrapper.append(node('span', 'field-label', label));
    const input = node(choices ? 'select' : 'input', choices ? 'select' : 'input');
    input.name = name;
    if (choices) {
      const all = node('option', '', 'All'); all.value = ''; input.append(all);
      for (const choice of choices) { const option = node('option', '', name === 'muted' ? choice === 'true' ? 'Muted' : 'Not muted' : humanize(choice)); option.value = choice; input.append(option); }
    } else { input.type = name === 'from' || name === 'to' ? 'date' : 'text'; input.autocomplete = 'off'; }
    input.value = value ?? '';
    wrapper.append(input);
    return wrapper;
  }
  function pageHeader(title) { const wrapper = node('div', 'page-header'); wrapper.append(node('h1', '', title)); return wrapper; }
  function section(title, description, iconName = '') { return ui.panel(title, { description, icon: iconName, className: 'detail-section' }); }
  function disclosure(title, key, className = '') {
    const wrapper = node('details', `disclosure ${className}`.trim());
    wrapper.dataset.disclosureKey = key;
    wrapper.open = disclosureState.get(key) === true;
    const summary = node('summary'); summary.append(node('span', 'summary-text', title)); wrapper.append(summary);
    wrapper.addEventListener('toggle', () => { if (wrapper.isConnected) disclosureState.set(key, wrapper.open); });
    return wrapper;
  }
  function rememberDisclosures() {
    for (const wrapper of doc.querySelectorAll('details[data-disclosure-key]')) disclosureState.set(wrapper.dataset.disclosureKey, wrapper.open);
  }
  function compactFeed(target, rows, key) {
    const list = node('div', 'issue-list'); list.append(...rows.slice(0, 3)); target.append(list);
    if (rows.length <= 3) return;
    const more = disclosure(`Show ${formatNumber(rows.length - 3)} more`, key, 'feed-more');
    const rest = node('div', 'issue-list disclosure-content'); rest.append(...rows.slice(3)); more.append(rest); target.append(more);
  }
  const STATUS_TONES = { regressed: 'danger', fixed: 'success', new: 'info', investigating: 'warning' };
  function statusTag(status) { return tag(status, STATUS_TONES[status] ?? ''); }
  function metric(label, value, note, tone = '') { return ui.stat({ label, value, note, tone }); }
  function rateTone(value, good = 90, fair = 70) { return typeof value === 'number' && Number.isFinite(value) ? value >= good ? 'success' : value >= fair ? 'warning' : 'danger' : ''; }
  function empty(target, title, description, kind = '') { target.append(ui.emptyState(title, description, kind)); }
  function loading(target, message = 'Loading diagnostics…') { target.replaceChildren(ui.loadingState(message)); target.setAttribute('aria-busy', 'true'); }
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
    if (retry) box.append(button('Retry', retry, 'button button-small'));
    target.replaceChildren(box);
  }
  function connectionState() { return invalidated ? ['error', 'Sign in required'] : win.navigator.onLine === false ? ['offline', 'Offline'] : ['online', 'Connected']; }
  function updateConnection() {
    const [state, text] = connectionState();
    for (const status of [elements['connection-status'], ...doc.querySelectorAll('[data-connection-detail]')]) {
      const dot = node('span', 'status-dot'); dot.setAttribute('aria-hidden', 'true');
      status.replaceChildren(dot, node('span', 'status-text', text));
      status.dataset.state = state;
    }
  }
  function invalidateSession(info) {
    if (invalidated || destroyed) return;
    invalidated = true; viewGeneration++; detailGeneration++; abortAll();
    pushManager?.dispose(); pushManager = null; growthManager?.dispose(); growthManager = null; detail = null; selectedReport = null; historyData = null;
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
    const main = doc.getElementById('main-content'); if (main) main.scrollTop = 0;
  }
  function validDates(from, to) {
    const start = Date.parse(`${from}T00:00:00.000Z`); const end = Date.parse(`${to}T00:00:00.000Z`);
    return /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start && end - start < 366 * 86_400_000;
  }
  function filtersFrom(form, fields) { return Object.fromEntries(Object.keys(fields).map((key) => [key, String(form.elements.namedItem(key)?.value ?? '').trim()])); }
  function dateError(form) { let message = form.querySelector('[data-validation]'); if (!message) { message = node('p', 'inline-message', 'Choose a valid UTC date range of at most 366 days.'); message.dataset.validation = ''; message.setAttribute('role', 'alert'); form.append(message); } }
  function pagination(target, value, onPage, history = false) {
    const page = Number(value.page) || 1; const limit = Number(value.limit) || 20; const total = Math.max(0, Number(value.total) || 0);
    const pages = Math.max(1, Math.ceil(total / limit));
    // A single page needs no controls; the count stays visible as plain metadata.
    if (pages <= 1 && page <= 1) { target.append(node('p', 'muted list-count', `${formatNumber(total)} ${history ? 'reports' : 'results'}`)); return; }
    const wrapper = node('div', 'pagination');
    const previous = button('Previous', () => onPage(page - 1), 'button button-small'); previous.disabled = page <= 1;
    const next = button('Next', () => onPage(page + 1), 'button button-small'); next.disabled = page >= pages || page >= 10_000;
    if (history) { previous.dataset.historyPrevious = ''; next.dataset.historyNext = ''; }
    wrapper.append(previous, node('span', 'muted', `Page ${formatNumber(page)} of ${formatNumber(pages)} · ${formatNumber(total)} ${history ? 'reports' : 'results'}`), next); target.append(wrapper);
  }
  /** Shared list row: leading status dot, title line, metadata line, optional trailing figure and chevron. */
  function listRow(element, { title, badges = [], meta = [], figure = null, tone = '' }) {
    element.classList.add('issue-row');
    if (tone) element.dataset.tone = tone;
    const dot = node('span', 'row-dot'); dot.setAttribute('aria-hidden', 'true');
    const main = node('span', 'issue-main');
    const top = node('span', 'issue-row-heading'); top.append(node('strong', 'issue-row-title', title), ...badges);
    const metadata = node('span', 'issue-row-meta'); metadata.append(...meta.map((item) => typeof item === 'string' ? node('span', '', item) : item));
    main.append(top, metadata);
    const chevron = node('span', 'issue-chevron'); chevron.setAttribute('aria-hidden', 'true'); chevron.append(ui.icon('chevron'));
    element.append(dot, main);
    if (figure) element.append(figure);
    element.append(chevron);
    return element;
  }
  function issueRow(value) {
    const badges = [statusTag(value.status)]; if (value.muted) badges.push(tag('muted'));
    const counts = node('span', 'issue-count'); counts.append(node('strong', '', formatNumber(value.total_occurrences)), node('span', 'muted', 'reports'));
    const meta = [`#${value.id} · ${value.error_code ?? 'Unknown error'}`, `${value.last_seen_version ?? 'Unknown version'} · ${relativeTime(value.last_seen_at)}`, `${formatNumber(value.affected_installs_count)} installs`];
    if (value.relayed_report_count > 0) meta.push(`${formatNumber(value.relayed_report_count)} via Discord`);
    return listRow(button('', () => { void openIssue(value.id); }, ''), { title: categoryLabel(value.category ?? value.error_code ?? 'Unknown issue'), badges, meta, figure: counts, tone: STATUS_TONES[value.status] ?? '' });
  }
  function filterSummary(filters) {
    const range = `${filters.from} – ${filters.to}`;
    const scope = [filters.browser ? humanize(filters.browser) : 'All browsers', filters.destination ? humanize(filters.destination) : 'all destinations'].join(' · ');
    return `${range} · ${scope}`;
  }

  async function loadOverview() {
    rememberDisclosures();
    if (automaticOverviewDates) Object.assign(overviewFilters, dateRange(30));
    const generation = ++viewGeneration; abortAll('view:');
    growthManager?.dispose(); growthManager = null;
    const root = elements['view-overview']; root.replaceChildren(pageHeader('Overview'));
    const growth = node('div'); growth.dataset.growth = '';
    const target = node('div', 'stack overview-health'); target.dataset.overviewDiagnostics = ''; root.append(growth, target); loading(target, 'Loading download health…');
    growthManager = mountGrowth(growth, { document: doc, window: win, notify, uiState: growthUiState,
      request: (path, options) => request(`view:growth:${path}:${options?.body?.ids?.join(',') ?? ''}`, path, options) });
    try {
      const filters = { ...overviewFilters };
      const [summary, releases] = await Promise.all([
        request('view:overview', `/overview${queryString(filters)}`),
        request('view:releases', `/releases${queryString({ ...filters, page: releasePage, limit: 10 })}`)
      ]);
      if (!isCurrent(generation)) return;
      target.replaceChildren(); settled(target);
      const spikes = summary.alerts?.spikes;
      const minutes = Number.isFinite(summary.alerts?.window_seconds) ? formatNumber(summary.alerts.window_seconds / 60) : '—';
      // Active spikes are the most urgent signal, so they lead; a healthy window is a single line.
      if (Array.isArray(spikes) && spikes.length) {
        const alerts = ui.panel('Live alerts', { icon: 'issues', description: `Last ${minutes} minutes, independent of date filters.`, className: 'alerts-panel' });
        const list = node('div', 'issue-list');
        for (const spike of spikes) {
          list.append(listRow(button('', () => { void openIssue(spike.issue_id); }, ''), { title: `${categoryLabel(spike.category)} · #${spike.issue_id}`, badges: [statusTag(spike.status)], meta: [`${formatNumber(spike.report_count)} reports across ${formatNumber(spike.distinct_installs)} installs · ${relativeTime(spike.last_seen_at)}`], tone: 'danger' }));
        }
        alerts.append(list); target.append(alerts);
      }
      const health = ui.panel('Download health', { icon: 'health', className: 'health-panel' });
      const filterDisclosure = disclosure(filterSummary(filters), 'overview-filters', 'filter-disclosure');
      filterDisclosure.querySelector('summary').prepend(ui.icon('sliders'));
      filterDisclosure.querySelector('summary').setAttribute('aria-label', `Filter download health: ${filterSummary(filters)}`);
      const form = node('form', 'filter-form overview-filters'); form.dataset.form = 'overview';
      form.append(field('From', 'from', filters.from), field('To', 'to', filters.to), field('Browser', 'browser', filters.browser, BROWSERS), field('Destination', 'destination', filters.destination, ['browser', 'vortex', 'mo2']));
      const apply = node('button', 'button button-primary', 'Apply filters'); apply.type = 'submit'; form.append(apply);
      form.addEventListener('submit', (event) => { event.preventDefault(); const next = filtersFrom(form, overviewFilters); if (!validDates(next.from, next.to)) return dateError(form); if (next.from !== overviewFilters.from || next.to !== overviewFilters.to) automaticOverviewDates = false; Object.assign(overviewFilters, next); releasePage = 1; void loadOverview(); });
      filterDisclosure.append(form); health.append(filterDisclosure);
      const metrics = summary.releases ?? {};
      const issueTone = (summary.issues?.regressed_count ?? 0) > 0 ? 'danger' : (summary.issues?.new_count ?? 0) > 0 ? 'warning' : '';
      health.append(ui.stats([
        metric('Download success', formatPercent(metrics.success_rate_percent), `${formatNumber(metrics.success_count)} of ${formatNumber(metrics.attempts_count)} attempts`, rateTone(metrics.success_rate_percent)),
        metric('Fallback used', formatPercent(metrics.fallback_rate_percent), `${formatNumber(metrics.fallback_triggered_count)} attempts`, metrics.fallback_rate_percent != null && metrics.fallback_rate_percent > 10 ? 'warning' : ''),
        metric('Issues', formatNumber(summary.issues?.total), `${formatNumber(summary.issues?.regressed_count)} regressed · ${formatNumber(summary.issues?.new_count)} new`, issueTone),
        metric('Error reports', formatNumber(summary.reports?.total), `${formatNumber(summary.reports?.distinct_installs)} anonymous installs`)
      ], 'stats-4'));
      if (metrics.attempts_count === 0) health.append(node('p', 'inline-message', 'No download-attempt telemetry was received in this window. Error reports can populate Issues, but do not provide success or fallback rates.'));
      if (!Array.isArray(spikes) || !spikes.length) {
        const line = spikes ? ui.statusLine(`No active spikes · last ${minutes} minutes`, 'success') : ui.statusLine('Live detection is unavailable. Refresh to try again.', 'warning');
        line.dataset.liveAlerts = ''; health.append(line);
      }
      const explanation = disclosure('About these numbers', 'health-explanation', 'info-disclosure');
      explanation.querySelector('summary').prepend(ui.icon('info'));
      explanation.append(node('p', 'muted disclosure-content', 'Rates are weighted by attempts. Success and fallback can overlap. Error reports alone do not measure download success. Audience and store totals use separate time windows. Live alerts cover a short recent window and ignore the date filters.'));
      if (summary.reports?.total === 0) explanation.append(node('p', 'muted disclosure-content', REPORT_SETUP));
      health.append(explanation);
      target.append(health);
      const releasePanel = ui.panel('By release', { icon: 'release', className: 'release-panel' });
      if (!releases.items?.length) empty(releasePanel, 'No release telemetry', 'Try a wider date range or a different browser and destination.');
      else releasePanel.append(releaseList(releases.items));
      if (releases.total > 0 || releases.page > 1) pagination(releasePanel, releases, (page) => { releasePage = page; void loadOverview(); });
      renderComparison(releasePanel, releases.items ?? [], generation);
      target.append(releasePanel);
    } catch (error) { if (isCurrent(generation)) showError(target, error, () => { void loadOverview(); }); }
  }
  /**
   * Releases render as a list rather than a five-column table so phones keep every value readable.
   * Each row keeps its own labelled values; the first row's labels double as visible column headings.
   */
  function releaseList(items) {
    const list = node('ol', 'release-list'); list.dataset.releaseList = ''; list.setAttribute('aria-label', 'Download health by release');
    for (const release of items) {
      const row = node('li', 'release-row');
      const values = node('dl', 'release-stats');
      for (const [label, value, tone] of [['Attempts', formatNumber(release.attempts_count)], ['Success', formatPercent(release.success_rate_percent), rateTone(release.success_rate_percent)], ['Fallback', formatPercent(release.fallback_rate_percent), release.fallback_rate_percent > 10 ? 'warning' : ''], ['Heartbeats', formatNumber(release.heartbeat_count)]]) {
        const pair = node('div'); const dd = node('dd', '', value); if (tone) dd.dataset.tone = tone;
        pair.append(node('dt', '', label), dd); values.append(pair);
      }
      row.append(node('strong', 'release-version', String(release.version ?? '—')), values); list.append(row);
    }
    return list;
  }
  function renderComparison(target, releases, generation) {
    const wrapper = disclosure('Compare releases', 'compare-releases', 'compare-disclosure');
    wrapper.querySelector('summary').prepend(ui.icon('sync'));
    const form = node('form', 'filter-form comparison-toolbar'); form.dataset.form = 'comparison';
    if (!compareVersions.after && releases[0]) compareVersions.after = releases[0].version;
    if (!compareVersions.before && releases[1]) compareVersions.before = releases[1].version;
    form.append(field('Before', 'before', compareVersions.before), field('After', 'after', compareVersions.after));
    for (const input of form.querySelectorAll('input')) { input.required = true; input.maxLength = 64; input.placeholder = '3.2.0'; input.inputMode = 'decimal'; }
    const submit = node('button', 'button button-primary', 'Compare releases'); submit.type = 'submit'; form.append(submit);
    const result = node('div', 'comparison-result'); result.dataset.comparisonResult = ''; result.setAttribute('aria-live', 'polite');
    let comparisonGeneration = 0;
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); compareVersions = { before: form.elements.namedItem('before').value.trim(), after: form.elements.namedItem('after').value.trim() };
      const comparisonRequest = ++comparisonGeneration;
      if (!SEMVER.test(compareVersions.before) || !SEMVER.test(compareVersions.after)) { result.replaceChildren(node('p', 'inline-message', 'Enter full release versions, such as 3.2.0.')); return; }
      submit.disabled = true; loading(result, 'Comparing release telemetry…');
      try {
        const comparison = await request('view:compare', `/releases/compare${queryString({ ...overviewFilters, ...compareVersions })}`);
        if (!isCurrent(generation) || comparisonRequest !== comparisonGeneration) return;
        result.replaceChildren(); settled(result);
        const columns = [['Before', comparison.before], ['After', comparison.after]].map(([label, release]) => metric(`${label} · ${release.version}`, `${formatPercent(release.success_rate_percent)} success`,
          release.attempts_count ? `${formatPercent(release.fallback_rate_percent)} fallback · ${formatNumber(release.attempts_count)} attempts` : 'No attempts recorded.'));
        result.append(ui.stats(columns, 'comparison-grid'));
        const delta = (value) => typeof value === 'number' && Number.isFinite(value) ? `${value > 0 ? '+' : ''}${value.toFixed(1)} pp` : '—';
        result.append(node('p', 'muted comparison-delta', `Change: ${delta(comparison.success_rate_delta_pp)} success · ${delta(comparison.fallback_rate_delta_pp)} fallback. Percentage points, after minus before, using the download health filters.`));
      } catch (error) { if (isCurrent(generation) && comparisonRequest === comparisonGeneration) showError(result, error, () => { form.requestSubmit(); }); }
      finally { if (isCurrent(generation) && comparisonRequest === comparisonGeneration) submit.disabled = false; }
    });
    wrapper.append(form, result); target.append(wrapper);
  }

  /** Public GitHub issues and discussions share one loader; only validation and row metadata differ. */
  const FEEDS = {
    issues: { slot: 'view:github', path: '/github-issues', loadingText: 'Loading open GitHub issues…', base: GITHUB_ISSUES_URL, key: 'github-issues',
      staleText: 'GitHub is temporarily unavailable. Showing cached issues. Refresh to retry.', emptyText: ['No open GitHub issues', 'New public reports will appear here after the next refresh.'],
      filteredText: ['No open GitHub issues', 'Open GitHub to check the latest public reports.'], errorText: 'GitHub issues are temporarily unavailable. Refresh or open GitHub.', checked: 'Checked',
      valid: (item) => item.state === 'open' && safeGithubUrl(item.url) === `${GITHUB_ISSUES_URL}/${item.number}`,
      meta: (item) => [`#${item.number} · Updated ${relativeTime(item.updated_at)}`, ...(Array.isArray(item.labels) ? item.labels.filter((label) => typeof label === 'string').map((label) => tag(label)) : []),
        ...(Number.isSafeInteger(item.comments) && item.comments >= 0 ? [`${formatNumber(item.comments)} comments`] : [])] },
    discussions: { slot: 'view:github-discussions', path: '/github-discussions', loadingText: 'Loading recent GitHub discussions…', base: GITHUB_DISCUSSIONS_URL, key: 'github-discussions',
      staleText: 'GitHub discussions are temporarily unavailable. Showing the cached feed. Refresh to retry.', emptyText: ['No recent GitHub discussions', 'Open GitHub to browse discussions.'],
      filteredText: ['No recent GitHub discussions', 'Open GitHub to browse discussions.'], errorText: 'GitHub discussions are temporarily unavailable. Refresh or open GitHub.', checked: 'Recent feed checked',
      valid: (item) => item.url === `${GITHUB_DISCUSSIONS_URL}/${item.number}`,
      meta: (item) => [`#${item.number} · Updated ${relativeTime(item.updated_at)}`] }
  };
  async function loadFeed(kind, target, generation) {
    const feed = FEEDS[kind];
    loading(target, feed.loadingText);
    try {
      const data = await request(feed.slot, feed.path);
      if (!isCurrent(generation)) return;
      if (!Array.isArray(data?.items)) throw new Error('Invalid GitHub response');
      target.replaceChildren(); settled(target);
      if (data.stale) target.append(node('p', 'inline-message', feed.staleText));
      if (!data.items.length && kind === 'issues') empty(target, ...feed.emptyText);
      else {
        const rows = [];
        for (const item of [...data.items].sort((a, b) => (Date.parse(b?.updated_at) || 0) - (Date.parse(a?.updated_at) || 0))) {
          if (!Number.isSafeInteger(item?.number) || item.number < 1 || typeof item.title !== 'string' || !feed.valid(item)) continue;
          const row = node('a'); row.href = `${feed.base}/${item.number}`; row.target = '_blank'; row.rel = 'noopener noreferrer';
          rows.push(listRow(row, { title: item.title, meta: feed.meta(item) }));
        }
        if (rows.length) compactFeed(target, rows, feed.key);
        else empty(target, ...feed.filteredText);
      }
      if (kind === 'issues' && data.truncated) target.append(node('p', 'muted source-note', 'More issues are available on GitHub.'));
      target.append(node('p', 'muted source-note', `${feed.checked} ${formatDate(data.fetched_at)}.`));
    } catch (error) {
      if (!isCurrent(generation) || error?.name === 'AbortError') return;
      settled(target); target.replaceChildren(node('p', 'inline-message', feed.errorText));
    }
  }
  function resetIssueFilters() {
    automaticIssueDates = true;
    issueFilters = { ...Object.fromEntries(Object.keys(issueFilters).map((key) => [key, ''])), ...dateRange(30) };
    issuePage = 1; void loadIssues();
  }
  function issueFilterForm() {
    const form = node('form', 'issues-filter'); form.dataset.form = 'issues';
    const searchField = field('Search', 'q', issueFilters.q); searchField.classList.add('search-field');
    searchField.querySelector('.field-label').classList.add('sr-only'); searchField.prepend(ui.icon('search'));
    const search = searchField.querySelector('input'); search.type = 'search'; search.maxLength = 200; search.placeholder = 'Search issues, errors or reports'; search.enterKeyHint = 'search';
    const primary = node('div', 'issues-primary-toolbar');
    const version = field('Version', 'version', issueFilters.version); version.querySelector('input').maxLength = 64; version.querySelector('input').placeholder = 'All'; version.querySelector('input').inputMode = 'decimal';
    primary.append(field('Status', 'status', issueFilters.status, STATUSES), version);
    form.append(searchField, primary);
    const advancedCount = Object.entries(issueFilters).filter(([key, value]) => !['q', 'status', 'version', 'from', 'to'].includes(key) && value).length;
    const moreFilters = disclosure(`More filters${advancedCount ? ` (${advancedCount})` : ''}`, 'issue-filters', 'issues-disclosure');
    const summary = moreFilters.querySelector('summary'); summary.prepend(ui.icon('sliders'));
    summary.append(node('span', 'summary-detail', `${issueFilters.from} – ${issueFilters.to}`));
    moreFilters.open ||= advancedCount > 0;
    const advanced = node('div', 'filter-form filter-grid');
    for (const [label, name, choices] of [['Browser', 'browser', BROWSERS], ['OS', 'os', SYSTEMS], ['Destination', 'destination', ['browser', 'vortex', 'mo2']], ['Mode', 'download_mode', ['manual', 'auto']], ['Fault origin', 'fault_origin', FAULTS], ['Severity', 'severity', ['debug', 'info', 'warning', 'error', 'fatal']], ['Muted', 'muted', ['true', 'false']]]) advanced.append(field(label, name, issueFilters[name], choices));
    advanced.append(field('Category', 'category', issueFilters.category), field('From', 'from', issueFilters.from), field('To', 'to', issueFilters.to)); advanced.querySelector('[name="category"]').maxLength = 80;
    moreFilters.append(advanced); form.append(moreFilters);
    const actions = node('div', 'filter-actions');
    const reset = button('Reset', resetIssueFilters, 'button button-quiet');
    reset.append(node('span', 'sr-only', ' filters'));
    const apply = node('button', 'button button-primary', 'Apply filters'); apply.type = 'submit';
    actions.append(reset, apply); form.append(actions);
    form.addEventListener('submit', (event) => {
      event.preventDefault(); const next = filtersFrom(form, issueFilters); if (!validDates(next.from, next.to)) return dateError(form);
      if ((next.version && !SEMVER.test(next.version)) || (next.category && !/^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(next.category))) {
        form.querySelector('[data-validation]')?.remove(); const validation = node('p', 'inline-message', 'Enter a complete release version and a category identifier, such as DOM_SELECTOR_MISSING.'); validation.dataset.validation = ''; validation.setAttribute('role', 'alert'); form.append(validation); return;
      }
      if (next.from !== issueFilters.from || next.to !== issueFilters.to) automaticIssueDates = false;
      issueFilters = next; issuePage = 1; void loadIssues();
    });
    return form;
  }
  async function loadIssues() {
    rememberDisclosures();
    if (automaticIssueDates) Object.assign(issueFilters, dateRange(30));
    const generation = ++viewGeneration; abortAll('view:'); const view = elements['view-issues']; view.replaceChildren(); settled(view);
    view.append(pageHeader('Issues'));
    // Private extension diagnostics lead; the public GitHub feeds follow as a separate group.
    const target = node('section', 'stack diagnostic-issues'); target.dataset.diagnosticIssues = ''; target.setAttribute('aria-label', 'Automatic extension diagnostics');
    const community = node('div', 'community-grid');
    const feedPanel = (kind, title, iconName, label, ariaLabel) => {
      const panel = ui.panel(title, { icon: iconName, accessories: [ui.externalLink(label, FEEDS[kind].base, { ariaLabel })] });
      panel.dataset[kind === 'issues' ? 'githubIssues' : 'githubDiscussions'] = '';
      const content = node('div', 'feed-content'); panel.append(content); community.append(panel); return content;
    };
    const githubContent = feedPanel('issues', 'Open GitHub issues', 'github', 'All', 'Open all issues on GitHub');
    const discussionsContent = feedPanel('discussions', 'Recent GitHub discussions', 'chat', 'All', 'Open all discussions on GitHub');
    view.append(target, community);
    const githubPending = Promise.all([loadFeed('issues', githubContent, generation), loadFeed('discussions', discussionsContent, generation)]);
    loading(target, 'Loading extension diagnostics…');
    try {
      const data = await request('view:issues', `/issues${queryString({ ...issueFilters, page: issuePage, limit: 20 })}`);
      if (!isCurrent(generation)) return;
      target.replaceChildren(); settled(target);
      target.append(ui.panelHeading('Extension diagnostics', { icon: 'health', description: 'Opt-in error reports. Filters apply here only; dates use UTC.' }), issueFilterForm());
      const list = node('div', 'issue-list issue-card'); list.setAttribute('aria-label', 'Filtered issues');
      if (data.items?.length) for (const value of data.items) list.append(issueRow(value));
      else empty(list, 'No matching issues', 'Change the filters or expand the UTC date range.'); target.append(list);
      pagination(target, data, (page) => { issuePage = page; void loadIssues(); });
    } catch (error) {
      if (isCurrent(generation)) {
        showError(target, error, () => { void loadIssues(); });
        if (!invalidated && error?.name !== 'AbortError') target.firstElementChild?.append(button('Reset filters', resetIssueFilters, 'button button-small button-quiet'));
      }
    }
    await githubPending;
  }

  /** iOS-style grouped settings: a group title, then one card of rows. */
  function settingsGroup(title, { footer, className = '' } = {}) {
    const group = node('section', `settings-group ${className}`.trim());
    const heading = node('h2', 'group-title', title); group.append(heading);
    const body = node('div', 'group'); group.append(body);
    if (footer) group.append(node('p', 'group-footer', footer));
    return { group, body };
  }
  function settingsRow(label, value) {
    const row = node('div', 'settings-row'); row.append(node('span', 'row-label', label));
    if (value !== undefined) row.append(typeof value === 'string' ? node('span', 'row-value', value) : value);
    return row;
  }
  async function loadSettings() {
    rememberDisclosures();
    const generation = ++viewGeneration; abortAll('view:'); const target = elements['view-settings'];
    pushManager?.dispose(); pushManager = null; target.replaceChildren(); settled(target);
    target.append(pageHeader('Settings'));
    const mount = node('div', 'settings-push-wrapper'); target.append(mount);
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
    catch { const { group, body } = settingsGroup('Notifications'); body.append(node('p', 'settings-note', 'Push controls could not be initialized. Refresh to retry.')); mount.replaceChildren(group); }
    const muted = settingsGroup('Muted issues', { footer: 'Active in the last 30 UTC days. Open an issue to unmute it. Ignored issues also stay quiet.', className: 'muted-issues-section' });
    const list = node('div', 'issue-list'); loading(list, 'Loading mute rules…'); muted.body.append(list); target.append(muted.group);
    const privacy = settingsGroup('Reports & privacy', { footer: 'Reports require opt-in in the extension. Private data stays in memory and is unavailable offline.', className: 'privacy-section' });
    const setup = disclosure('Set up automatic reports', 'report-setup', 'settings-information');
    setup.append(node('p', 'muted disclosure-content', REPORT_SETUP));
    const security = disclosure('Session protection', 'session-protection', 'settings-information');
    security.append(node('p', 'muted disclosure-content', 'Cloudflare Access protects this dashboard and its API. Private responses are not cached. Sign in again when your session expires.'));
    privacy.body.append(settingsRow('Telemetry', 'Opt-in only'), setup, security);
    target.append(privacy.group);
    const connection = settingsGroup('Connection', { className: 'connection-section' });
    const status = node('span', 'row-value connection-detail'); status.dataset.connectionDetail = ''; status.setAttribute('role', 'status');
    connection.body.append(settingsRow('Status', status), settingsRow('Sign-in', 'Cloudflare Access'), settingsRow('Offline data', 'Not stored on this device'));
    target.append(connection.group); updateConnection();
    try {
      const data = await request('view:muted', `/issues${queryString({ ...dateRange(30), muted: 'true', page: mutedPage, limit: 10 })}`);
      if (!isCurrent(generation)) return;
      settled(list); list.replaceChildren();
      if (data.items?.length) for (const value of data.items) list.append(issueRow(value)); else empty(list, 'No muted issues', 'Open an issue and turn on “Mute this issue” to quiet its alerts.', 'quiet');
      if (data.total > 0 && data.items?.length) {
        pagination(muted.body, data, (page) => { mutedPage = page; void loadSettings(); });
      }
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
  function classification(title, value, { inline = false } = {}) {
    const box = inline ? node('div', 'classification') : section(title);
    const labels = node('div', 'tag-row'); labels.append(tag(categoryLabel(value.category)), tag(value.fault_origin ?? 'unknown'));
    box.append(labels, node('p', 'suggested-action', value.suggested_action ?? 'No suggested action was recorded.')); return box;
  }
  function renderReport(target, report) {
    rememberDisclosures();
    target.replaceChildren();
    if (!report) { empty(target, 'Report bodies are no longer retained', 'Lifetime issue counts and grouping remain available. New reports will appear here.'); return; }
    const environment = section('Selected report', `Received ${formatDate(report.created_at)}`);
    environment.append(evidence('Error message', report.error_message ?? 'No message retained.'));
    environment.append(keyValues([['Version', report.version], ['Browser', `${report.browser ?? '—'} ${report.browser_version ?? ''}`.trim()], ['OS', report.source === 'relay' ? 'Not reported' : `${report.os ?? '—'} ${report.os_version ?? ''}`.trim()], ['Destination / mode', `${report.destination ?? '—'} / ${report.download_mode ?? '—'}`], ['Severity', report.severity], ['Occurred', formatDate(report.occurred_at)]]));
    const metadata = disclosure('Report metadata', 'report-metadata');
    metadata.append(keyValues([['Report ID', report.id], ['Source', report.source === 'relay' ? 'Automatic report via the Discord relay' : 'Private diagnostics'], ['Category', report.category], ['Failure stage', report.failure_stage], ['HTTP / Retry-After', `${report.http_status ?? '—'} / ${report.retry_after ?? '—'}`], ['Mod / collection', `${report.mod_id ?? '—'} / ${report.collection_id ?? '—'}`]]));
    environment.append(metadata); target.append(environment);
    const reportClassification = disclosure('Report classification', 'report-classification');
    reportClassification.append(node('p', 'muted disclosure-content', 'Classified when received.'), classification('Classified when received', report, { inline: true })); target.append(reportClassification);
    const timeline = disclosure('Execution timeline', 'execution-timeline');
    timeline.append(node('p', 'muted', 'Extension timings on a shared elapsed-time scale.'));
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
        if (crumb.metadata && Object.keys(crumb.metadata).length) { const metadata = node('details', 'disclosure step-metadata'); const stepSummary = node('summary'); stepSummary.append(node('span', 'summary-text', 'Step metadata')); metadata.append(stepSummary, evidence('Metadata', crumb.metadata)); content.append(metadata); } row.append(content); list.append(row);
      }
      timeline.append(list, node('p', 'muted', `Reported timeline: ${formatNumber(total)} ms.`));
    }
    target.append(timeline);
    const diagnostic = disclosure('DOM & API evidence', 'dom-evidence');
    if (report.dom_state) diagnostic.append(evidence('Document, selectors & API schema', report.dom_state)); else diagnostic.append(node('p', 'muted', 'No DOM state was included.'));
    if (report.context && Object.keys(report.context).length) diagnostic.append(evidence('Request context', report.context)); target.append(diagnostic);
    const stack = disclosure('Stack trace', 'stack-trace'); stack.append(evidence('Sanitized stack', report.stack_trace || 'No stack trace retained.')); target.append(stack);
  }
  function renderLifecycle(target, value, generation) {
    target.replaceChildren(); target.append(ui.panelHeading('Manage issue', { icon: 'settings', description: 'Fixed and regressed statuses need a release version. Muted and ignored issues suppress alerts.' }));
    const form = node('form', 'filter-form lifecycle-form'); form.dataset.form = 'lifecycle';
    const status = field('Status', 'status', value.status, STATUSES); status.querySelector('option[value=""]')?.remove();
    form.append(status, field('Fixed in version', 'fixed_in_version', value.fixed_in_version ?? ''), field('GitHub issue URL', 'github_issue_url', value.github_issue_url ?? ''));
    form.elements.namedItem('fixed_in_version').maxLength = 64; form.elements.namedItem('fixed_in_version').placeholder = '3.2.1'; form.elements.namedItem('github_issue_url').maxLength = 2048; form.elements.namedItem('github_issue_url').type = 'url'; form.elements.namedItem('github_issue_url').placeholder = 'https://github.com/owner/repo/issues/42';
    const mute = node('label', 'field lifecycle-toggle'); const check = node('input', 'switch'); check.type = 'checkbox'; check.name = 'muted'; check.checked = Boolean(value.muted); mute.append(node('span', 'toggle-label', 'Mute this issue'), check); form.append(mute);
    const submit = node('button', 'button button-primary', 'Save changes'); submit.type = 'submit'; form.append(submit);
    const feedback = node('p', 'inline-message'); feedback.dataset.lifecycleFeedback = ''; feedback.setAttribute('role', 'status'); feedback.hidden = true; form.append(feedback);
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); if (submit.disabled) return;
      feedback.hidden = false;
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
        const savedFeedback = elements['issue-detail'].querySelector('[data-lifecycle-feedback]'); savedFeedback.hidden = false; savedFeedback.textContent = 'Issue updated.';
      } catch (error) { if (isDetailCurrent(generation) && error?.name !== 'AbortError') { feedback.textContent = errorMessage(error); if (error?.status === 409) feedback.append(button('Refresh details', () => { void openIssue(value.id, { replace: true }); }, 'button button-small')); } }
      finally { if (isDetailCurrent(generation)) submit.disabled = false; }
    });
    target.append(form); const github = safeGithubUrl(value.github_issue_url);
    if (github) target.append(ui.externalLink('Open GitHub issue', github, { className: 'button button-small button-quiet' }));
  }
  function renderHistory(target, generation) {
    target.replaceChildren(); target.append(node('p', 'muted history-hint', 'Select a report to view its evidence.'));
    if (!historyData?.items?.length) empty(target, 'No retained report bodies', 'Issue counters survive report retention.');
    else {
      const list = node('div', 'issue-list');
      for (const report of historyData.items) {
        const item = button(`${report.version} · ${report.browser} / ${report.os ?? 'OS not reported'} · ${formatDate(report.created_at)}`, () => {
          if (!isDetailCurrent(generation)) return; selectedReport = report;
          renderReport(elements['issue-detail'].querySelector('[data-selected-report]'), selectedReport); renderHistory(target, generation);
          elements['issue-detail'].querySelector('[data-manual-copy-section]')?.remove();
        }, 'history-row'); item.dataset.reportId = report.id; item.setAttribute('aria-pressed', String(selectedReport?.id === report.id)); list.append(item);
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
      if (error?.name !== 'AbortError' && isDetailCurrent(generation) && historyPage === page && historyRequest === historyGeneration) {
        const activeTarget = elements['issue-detail'].querySelector('[data-report-history]');
        const historyDisclosure = activeTarget.closest('[data-disclosure-key="report-history"]');
        if (historyDisclosure) { historyDisclosure.open = true; disclosureState.set('report-history', true); }
        showError(activeTarget, error, () => { void loadHistory(page, generation, activeTarget); });
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
    rememberDisclosures();
    const target = elements['issue-detail']; target.replaceChildren(); settled(target); const value = detail.issue;
    const title = node('h2', '', `Issue #${value.id}`); title.id = 'issue-title';
    const header = node('div', 'detail-heading'); const titleGroup = node('div', 'detail-title'); titleGroup.append(title, node('p', 'muted detail-code', value.error_code ?? 'Unknown error'));
    const copy = button('Copy debug context', () => { void copyContext(generation, copy); }, 'button button-small'); copy.dataset.action = 'copy-context';
    header.append(titleGroup, copy); target.append(header);
    const labels = node('div', 'tag-row'); labels.append(statusTag(value.status), tag(categoryLabel(value.category)), tag(value.fault_origin)); if (value.muted) labels.append(tag('muted')); target.append(labels);
    target.append(ui.stats([
      metric('Lifetime reports', formatNumber(value.total_occurrences)),
      metric('Affected installs', formatNumber(value.affected_installs_count), value.relayed_report_count > 0 ? `and ${formatNumber(value.relayed_report_count)} reports via Discord without an installation ID` : undefined),
      metric('First seen', formatDate(value.first_seen_at), value.first_seen_version),
      metric('Last seen', formatDate(value.last_seen_at), value.last_seen_version)
    ], 'stats-4 detail-summary'));
    const feedback = node('p', 'inline-message'); feedback.dataset.dialogStatus = ''; feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite'); feedback.hidden = true; target.append(feedback);
    target.append(classification('Suggested next step', value));
    const lifecycle = node('section', 'panel detail-section'); renderLifecycle(lifecycle, value, generation); target.append(lifecycle);
    const report = node('div'); report.dataset.selectedReport = ''; renderReport(report, selectedReport); target.append(report);
    const historyDisclosure = disclosure('Report history', 'report-history');
    const history = node('div', 'disclosure-content'); history.dataset.reportHistory = ''; renderHistory(history, generation); historyDisclosure.append(history); target.append(historyDisclosure);
    const grouping = disclosure('Grouping & affected environments', 'issue-grouping'); grouping.append(keyValues([['Category', value.category], ['Fingerprint', value.fingerprint], ['Original category', value.error_category], ['Failure stage', value.failure_stage], ['Destination', value.destination], ['Normalized top frame', value.normalized_top_frame], ['Retained reports', formatNumber(detail.report_summary?.retained_report_count)], ['Browsers', detail.report_summary?.browsers?.join(', ')], ['Versions', `${detail.report_summary?.versions?.join(', ') ?? ''}${detail.report_summary?.versions_truncated ? ' (first 100)' : ''}`], ['Operating systems', detail.report_summary?.operating_systems?.join(', ')]])); target.append(grouping);
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
  function resetViewScroll() {
    const main = doc.getElementById('main-content');
    if (main) { main.scrollTop = 0; main.scrollLeft = 0; }
    win.scrollTo(0, 0);
  }
  async function navigate(view) {
    if (!VIEWS.includes(view) || invalidated || destroyed) return;
    currentView = view; viewGeneration++; abortAll('view:'); pushManager?.dispose(); pushManager = null; growthManager?.dispose(); growthManager = null;
    for (const name of VIEWS) { const target = elements[`view-${name}`]; target.hidden = name !== view; if (name !== view) target.replaceChildren(); }
    for (const item of doc.querySelectorAll('[data-view]')) { const active = item.dataset.view === view; item.setAttribute('aria-current', active ? 'page' : 'false'); item.classList.toggle('is-active', active); }
    resetViewScroll();
    if (view === 'overview') await loadOverview(); else if (view === 'issues') await loadIssues(); else await loadSettings();
  }
  async function refresh() {
    if (invalidated || destroyed) return;
    const control = elements['refresh-button'];
    control.classList.add('is-refreshing');
    const pending = navigate(currentView);
    const id = detail?.issue.id ?? issueIdentifier(new URL(win.location.href).searchParams.get('issue'));
    if (elements['issue-dialog'].open && id !== null) void openIssue(id, { replace: true });
    try { await pending; } finally { control.classList.remove('is-refreshing'); }
  }
  async function recoverSession() {
    if (destroyed || recoveryPending || win.navigator.onLine === false) return recoveryPending;
    if (!invalidated) { void refresh(); return; }
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
        updateConnection(); void refresh();
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
  listen(elements['refresh-button'], 'click', () => { void refresh(); });
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
  return { navigate, openIssue, invalidateSession, destroy() { if (destroyed) return; destroyed = true; recoveryController?.abort(); viewGeneration++; detailGeneration++; abortAll(); pushManager?.dispose(); pushManager = null; growthManager?.dispose(); growthManager = null; detail = null; selectedReport = null; historyData = null; win.clearTimeout(toastTimer); for (const remove of listeners) remove(); for (const view of VIEWS) elements[`view-${view}`].replaceChildren(); elements['issue-detail'].replaceChildren(); } };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined' && document.getElementById('main-content')) createDashboard();
