import { formatNumber } from './lib.js';
import { createIcon } from './ui-icons.js';

const STORE_URL = 'https://chromewebstore.google.com/detail/nexusmods-bypass/chfghiknjhpcncpcjopglefnckckdlpj';
const RELEASE_PREFIX = 'https://github.com/thomasthanos/nexusmods-bypass/releases/tag/';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? formatNumber(value) : '—';
const text = (value, length) => typeof value === 'string' ? value.slice(0, length) : '';

/** Independent listing and store sources; all private state stays in this mount. */
export function mountGrowth(container, { request, notify = () => {}, document: doc = container.ownerDocument, window: win = doc.defaultView, uiState = {} } = {}) {
  let disposed = false;
  let analytics = null;
  let store = null;
  let renderedStoreFresh = null;
  let focusedReview = null;
  let reviewHistoryOpen = uiState.reviewHistoryOpen === true;
  let reviewAckGeneration = 0;
  const controllers = new Map();
  const listeners = [];
  const analyticsPanel = element('section', 'panel growth-panel'); analyticsPanel.dataset.growthAnalytics = '';
  const storePanel = element('section', 'panel growth-panel'); storePanel.dataset.growthStore = '';
  const reviewsPanel = element('section', 'panel growth-panel'); reviewsPanel.dataset.growthReviews = '';
  container.classList.add('growth-overview'); container.replaceChildren(analyticsPanel, storePanel, reviewsPanel);

  function element(tag, className = '', value) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = String(value);
    return node;
  }
  function button(label, action, actionName) {
    const node = element('button', 'button button-small button-quiet', label); node.type = 'button';
    if (actionName) node.dataset.action = actionName;
    node.addEventListener('click', action); return node;
  }
  function listen(target, event, action) {
    target.addEventListener(event, action); listeners.push(() => target.removeEventListener(event, action));
  }
  function heading(panel, title, description, iconName = { 'Listing visitors': 'audience', 'Chrome Web Store': 'store', Reviews: 'reviews' }[title]) {
    rememberDisclosures(panel);
    panel.replaceChildren(); panel.removeAttribute('aria-busy');
    const top = element('div', 'panel-heading');
    if (iconName) {
      const badge = createIcon(doc, iconName, { tile: true }); badge.classList.add('panel-icon-badge');
      top.append(badge);
    }
    const copy = element('div');
    copy.append(element('h2', '', title)); if (description) copy.append(element('p', 'muted', description));
    top.append(copy); panel.append(top); return top;
  }
  function rememberDisclosures(panel) {
    for (const detail of panel.querySelectorAll('[data-growth-details]')) uiState[detail.dataset.growthDetails] = detail.open;
    const history = panel.querySelector('[data-review-history]');
    if (history) uiState.reviewHistoryOpen = reviewHistoryOpen = history.open;
  }
  function sourceDetails(panel, key, explanation) {
    const details = element('details', 'growth-details'); details.dataset.growthDetails = key; details.open = uiState[key] === true;
    const body = element('div', 'growth-details-body');
    if (explanation) body.append(element('p', 'muted', explanation));
    const summary = element('summary');
    const summaryRow = element('span', 'growth-details-summary-content');
    summaryRow.append(createIcon(doc, 'clock'), doc.createTextNode(' Source & timing'));
    summary.append(summaryRow);
    details.append(summary, body);
    details.addEventListener('toggle', () => { if (!disposed) uiState[key] = details.open; });
    panel.append(details); return body;
  }
  function metric(label, value, note, key) {
    const card = element('div', 'growth-metric'); if (key) card.dataset.metric = key;
    const labelNode = element('div', 'growth-label');
    const icon = { online: 'clock', weekly: 'audience', history: 'users', users: 'users', rating: 'rating', reviews: 'reviews' }[key];
    if (icon) labelNode.append(createIcon(doc, icon), doc.createTextNode(' '));
    labelNode.append(doc.createTextNode(label));
    card.append(labelNode, element('div', 'growth-value', value));
    if (note) {
      const noteEl = element('p', 'growth-note');
      if (key === 'users' && note.includes('Public user badge')) {
        const shieldBadge = element('span', 'badge-shield');
        shieldBadge.append(createIcon(doc, 'shield'), doc.createTextNode(' Public user badge'));
        noteEl.append(shieldBadge);
      } else {
        noteEl.textContent = note;
      }
      card.append(noteEl);
    }
    return card;
  }
  function fetched(panel, source, timestamp, stale = false) {
    const note = element('p', 'muted source-note growth-source');
    note.append(element('span', '', source));
    if (typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0) {
      const time = element('time', '', new Date(timestamp).toLocaleString()); time.dateTime = new Date(timestamp).toISOString();
      note.append(element('span', 'growth-fetched-label', stale ? ' · Saved data from ' : ' · Fetched '), time);
    } else note.append(doc.createTextNode(' · No data fetched yet'));
    panel.append(note);
  }
  function loading(panel, title, description) {
    heading(panel, title, description); panel.setAttribute('aria-busy', 'true');
    panel.append(element('p', 'muted', 'Loading…'));
  }
  function isFresh(value) {
    return value?.state === 'ready' && value.stale !== true && typeof value.fetched_at === 'number'
      && Number.isFinite(value.fetched_at) && Date.now() - value.fetched_at <= 120000 && value.fetched_at <= Date.now() + 60000;
  }
  function availableToPoll() { return !disposed && doc.visibilityState !== 'hidden' && win.navigator.onLine !== false; }
  function isStoreFresh() {
    const timestamp = store?.snapshot?.fetched_at;
    const cadence = Number.isFinite(store?.sync_interval_seconds) && store.sync_interval_seconds >= 60 ? store.sync_interval_seconds : 900;
    return win.navigator.onLine !== false && store?.state === 'ready' && store.stale !== true
      && typeof timestamp === 'number' && Number.isFinite(timestamp)
      && Date.now() - timestamp <= cadence * 2000 && timestamp <= Date.now() + 60000;
  }
  function applyStoreFreshness(panel, reviews = false) {
    if (!store?.snapshot) return;
    const fresh = isStoreFresh();
    const source = panel.querySelector('.growth-source');
    const previous = panel.querySelector('[data-store-freshness]');
    if (fresh) previous?.remove();
    else if (!previous) {
      const warning = element('div', 'growth-state growth-freshness-banner');
      warning.append(createIcon(doc, 'sync'), doc.createTextNode(reviews ? ' Saved reviews. Refresh for updates.' : ' Saved store data. Refresh for updates.'));
      warning.dataset.storeFreshness = ''; panel.insertBefore(warning, source?.closest('.growth-details') ?? source);
    }
    const label = source?.querySelector('.growth-fetched-label');
    if (label) label.textContent = fresh ? ' · Fetched ' : ' · Saved data from ';
  }
  function updateStoreFreshness() {
    const fresh = isStoreFresh();
    if (renderedStoreFresh === fresh) return;
    renderedStoreFresh = fresh;
    // Updating only the source status preserves focused review actions.
    applyStoreFreshness(storePanel); applyStoreFreshness(reviewsPanel, true);
  }
  function renderAnalytics() {
    if (disposed) return;
    const top = heading(analyticsPanel, 'Listing visitors', 'Chrome Web Store listing', 'audience');

    const ready = analytics?.state === 'ready';
    if (isFresh(analytics) && availableToPoll() && Number.isSafeInteger(analytics.online_30m) && analytics.online_30m >= 0) {
      const live = element('span', 'growth-live', 'Live'); live.dataset.live = 'true'; top.append(live);
    }
    if (!ready) {
      const configured = analytics?.state === 'not_configured';
      analyticsPanel.append(element('p', 'growth-state', configured ? 'Analytics not configured.' : 'Analytics temporarily unavailable.'));
      analyticsPanel.append(button('Retry analytics', () => { void loadAnalytics(); }));
    }
    const grid = element('div', 'growth-metrics');
    const trend = ready && Number.isFinite(analytics.weekly_change_percent) && analytics.previous_weekly_active > 0
      ? `${analytics.weekly_change_percent > 0 ? '+' : ''}${analytics.weekly_change_percent.toFixed(1)}% vs prior week`
      : ready && analytics.previous_weekly_active === 0 ? 'No previous-week baseline' : 'Previous-week comparison unavailable';
    const online = metric('Online · 30 min', ready ? count(analytics.online_30m) : '—', '', 'online');
    const weekly = metric('Last 7 days', ready ? count(analytics.weekly_active) : '—', '', 'weekly');
    const change = element('p', 'growth-trend', trend);
    if (ready && Number.isFinite(analytics.weekly_change_percent) && analytics.previous_weekly_active > 0) change.dataset.direction = analytics.weekly_change_percent > 0 ? 'up' : analytics.weekly_change_percent < 0 ? 'down' : 'flat';
    weekly.append(change);
    const historyDate = /^\d{4}-\d{2}-\d{2}$/.test(analytics?.history_start_date ?? '') ? analytics.history_start_date : null;
    grid.append(online, weekly, metric('Unique visitors', ready ? count(analytics.history_total_users) : '—', historyDate ? `Since ${historyDate}` : 'Start date unavailable', 'history'));
    analyticsPanel.append(grid);
    if (ready && !isFresh(analytics)) analyticsPanel.append(element('p', 'growth-state', 'Saved listing data. Refresh for updates.'));
    if (analytics?.message) analyticsPanel.append(element('p', 'growth-state', text(analytics.message, 500)));
    const quality = analytics?.quality;
    const limitations = [quality?.subject_to_thresholding && 'Google thresholding applies', quality?.sampled && 'Sampled data', quality?.data_loss && 'Google reports data loss'].filter(Boolean);
    if (limitations.length) analyticsPanel.append(element('p', 'growth-state', limitations.join(' · ')));
    const source = sourceDetails(analyticsPanel, 'analyticsDetailsOpen', 'Google Analytics (GA4) measures store listing visitors. Online covers the last 30 minutes. Weekly users cover the last 7 complete days.');
    if (analytics?.state === 'not_configured') source.append(element('p', 'muted', 'Connect Google Analytics and grant access to the listing property.'));
    const zone = text(analytics?.time_zone, 80);
    fetched(source, `Google Analytics${zone ? ` · ${zone}` : ''}`, analytics?.fetched_at, ready && !isFresh(analytics));
  }
  function externalLink(label, href) {
    const link = element('a', 'button button-small button-quiet', label); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.append(doc.createTextNode(' '), createIcon(doc, 'external'));
    return link;
  }
  function releaseUrl(value) {
    if (typeof value !== 'string' || !value.startsWith(RELEASE_PREFIX)) return null;
    const tag = value.slice(RELEASE_PREFIX.length);
    return /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/.test(tag) ? value : null;
  }
  function renderStore() {
    if (disposed) return;
    const snapshot = store?.snapshot;
    const top = heading(storePanel, 'Chrome Web Store', null, 'store');
    top.append(externalLink('View listing', STORE_URL));
    if (!snapshot) {
      storePanel.append(element('p', 'growth-state', 'Store data is temporarily unavailable.'), button('Retry store', () => { void loadStore(); }));
      fetched(sourceDetails(storePanel, 'storeDetailsOpen'), 'Chrome Web Store', store?.last_checked_at); return;
    }
    const grid = element('div', 'growth-metrics');
    const rating = typeof snapshot.rating_average === 'number' && Number.isFinite(snapshot.rating_average) && snapshot.rating_average >= 0 && snapshot.rating_average <= 5 ? snapshot.rating_average.toFixed(2) : '—';
    const ratingCard = metric('Rating', rating, `${count(snapshot.rating_count)} ratings`, 'rating');
    const star = element('span', 'growth-star', '★'); star.setAttribute('aria-hidden', 'true'); ratingCard.querySelector('.growth-value').prepend(star, doc.createTextNode(' '));
    grid.append(metric('Store users', count(snapshot.users), 'Public user badge', 'users'), ratingCard, metric('Written reviews', count(snapshot.written_review_count), '', 'reviews'));
    storePanel.append(grid);
    const version = element('div', 'growth-version');
    const versionLeft = element('div', 'growth-version-info');
    versionLeft.append(createIcon(doc, 'chrome'));
    const versions = element('div');
    versions.append(element('strong', '', `Store ${text(snapshot.version, 64) || 'version unavailable'}`));
    versions.append(element('span', 'muted', `Release ${text(snapshot.latest_release_version, 64) || 'unavailable'}`));
    versionLeft.append(versions);
    const labels = { up_to_date: 'Up to date', store_behind: 'Update pending', store_ahead: 'Store ahead', unknown: 'Comparison unavailable' };
    const status = element('span', 'tag tag-version', '');
    if (snapshot.version_status === 'up_to_date') status.append(createIcon(doc, 'check'), doc.createTextNode(' '));
    status.append(doc.createTextNode(labels[snapshot.version_status] ?? labels.unknown));
    status.dataset.versionStatus = snapshot.version_status;
    const versionRight = element('div', 'growth-version-action');
    versionRight.append(status);
    const release = releaseUrl(snapshot.latest_release_url);
    if (release) versionRight.append(externalLink('Release', release));
    version.append(versionLeft, versionRight);
    storePanel.append(version);
    const storeStale = !isStoreFresh();
    renderedStoreFresh = !storeStale;
    if (store?.message) storePanel.append(element('p', 'growth-state', text(store.message, 500)));
    const source = sourceDetails(storePanel, 'storeDetailsOpen', 'Users is the public Chrome Web Store badge. Ratings include scores without text; written reviews count feedback with text.');
    fetched(source, 'Chrome Web Store', snapshot.fetched_at, storeStale);
    applyStoreFreshness(storePanel);
  }
  function reviewDate(value) {
    if (!Number.isFinite(value) || value <= 0) return null;
    const time = element('time', '', new Date(value).toLocaleDateString()); time.dateTime = new Date(value).toISOString(); return time;
  }
  function focusReviewCard(id, scroll = false) {
    const card = [...reviewsPanel.querySelectorAll('[data-review-id]')].find((item) => item.dataset.reviewId.toLowerCase() === id.toLowerCase());
    if (!card) return false;
    const history = card.closest('[data-review-history]');
    if (history) { history.open = true; uiState.reviewHistoryOpen = reviewHistoryOpen = true; }
    if (scroll) card.scrollIntoView?.({ block: 'center', behavior: 'auto' });
    card.focus({ preventScroll: true }); return true;
  }
  function renderReviews() {
    if (disposed) return;
    const previousHistory = reviewsPanel.querySelector('[data-review-history]');
    if (previousHistory) reviewHistoryOpen = previousHistory.open;
    const top = heading(reviewsPanel, 'Reviews', null, 'reviews');
    const reviews = Array.isArray(store?.reviews) ? store.reviews.filter((item, index, list) => typeof item?.id === 'string' && UUID.test(item.id) && list.findIndex((other) => typeof other?.id === 'string' && other.id.toLowerCase() === item.id.toLowerCase()) === index).slice(0, 100)
      .sort((a, b) => (Number.isFinite(b.created_at) ? b.created_at : 0) - (Number.isFinite(a.created_at) ? a.created_at : 0) || a.id.localeCompare(b.id)) : [];
    const newCount = Number.isSafeInteger(store?.new_review_count) && store.new_review_count > 0 ? store.new_review_count : 0;
    if (newCount) top.append(element('span', 'tag tag-warning', `${count(newCount)} new`));
    if (!reviews.length) reviewsPanel.append(element('p', 'muted', store?.snapshot ? 'No written reviews have been fetched yet.' : 'Reviews are temporarily unavailable.'));
    const list = element('div', 'growth-review-list'); list.dataset.reviewPreview = '';
    const olderList = element('div', 'growth-review-list');
    const latestIds = new Set(reviews.slice(0, 3).map((review) => review.id));
    let hiddenUnread = 0;
    for (const review of reviews) {
      const card = element('article', 'growth-review'); card.dataset.reviewId = review.id; card.dataset.new = String(review.is_new === true); card.tabIndex = -1;
      const header = element('div', 'growth-review-heading'); const author = element('h3', '', text(review.author, 160) || 'Store reviewer');
      const rating = Number.isInteger(review.rating) && review.rating >= 1 && review.rating <= 5 ? review.rating : null;
      header.append(author, element('span', 'growth-review-rating', rating ? `★ ${rating}/5` : 'Rating unavailable'));
      if (review.is_new === true) header.append(element('span', 'tag tag-warning', 'New'));
      const metadata = element('div', 'growth-review-meta muted'); const created = reviewDate(review.created_at); if (created) metadata.append(created);
      if (review.version) metadata.append(element('span', '', `v${text(review.version, 64)}`));
      card.append(header, metadata);
      const body = text(review.body, 10000) || 'No written text.';
      if (body.length > 320) {
        const content = element('details', 'growth-review-text'); const summary = element('summary');
        const label = element('span', 'growth-review-expand', 'Read full review');
        summary.append(element('span', 'growth-review-excerpt', `${body.slice(0, 240).trimEnd()}…`), label);
        content.addEventListener('toggle', () => { label.textContent = content.open ? 'Show less' : 'Read full review'; });
        content.append(summary, element('p', 'growth-review-body', body)); card.append(content);
      } else card.append(element('p', 'growth-review-body', body));
      if (review.is_new === true) card.append(button('Mark as read', (event) => { void acknowledge(review.id, event.currentTarget); }, 'ack-review'));
      const latest = latestIds.has(review.id);
      if (!latest && review.is_new === true) hiddenUnread++;
      (latest ? list : olderList).append(card);
    }
    reviewsPanel.append(list);
    if (olderList.children.length) {
      const history = element('details', 'growth-review-history'); history.dataset.reviewHistory = ''; history.open = reviewHistoryOpen;
      const label = `${count(olderList.children.length)} older ${olderList.children.length === 1 ? 'review' : 'reviews'}${hiddenUnread ? ` · ${count(hiddenUnread)} unread` : ''}`;
      history.append(element('summary', '', label), olderList);
      history.addEventListener('toggle', () => { if (!disposed) uiState.reviewHistoryOpen = reviewHistoryOpen = history.open; });
      reviewsPanel.append(history);
    }
    const storeStale = !isStoreFresh();
    if (store?.snapshot?.reviews_complete === false) reviewsPanel.append(element('p', 'growth-state', 'Partial review history. More may be available in the store.'));
    if (store?.message) reviewsPanel.append(element('p', 'growth-state', text(store.message, 1600)));
    const source = sourceDetails(reviewsPanel, 'reviewDetailsOpen', 'Written feedback from the Chrome Web Store. Only Mark as read clears a new review.');
    fetched(source, 'Chrome Web Store', store?.snapshot?.fetched_at, storeStale);
    applyStoreFreshness(reviewsPanel, true);
    if (typeof store?.last_checked_at === 'number' && Number.isFinite(store.last_checked_at) && store.last_checked_at > 0) {
      const check = element('p', 'muted source-note');
      check.dataset.lastCheck = '';
      check.append(doc.createTextNode('Last checked '));
      const checkTime = element('time', '', new Date(store.last_checked_at).toLocaleString());
      checkTime.dateTime = new Date(store.last_checked_at).toISOString();
      check.append(checkTime);
      const interval = Number.isFinite(store?.sync_interval_seconds) && store.sync_interval_seconds >= 60 ? ` · Checks every ${Math.round(store.sync_interval_seconds / 60)} minutes` : '';
      if (interval) check.append(doc.createTextNode(interval));
      source.append(check);
    }
    const targetId = new URL(win.location.href).searchParams.get('review');
    if (targetId && UUID.test(targetId) && targetId.toLowerCase() !== focusedReview) {
      if (focusReviewCard(targetId, true)) focusedReview = targetId.toLowerCase();
    } else if (!targetId || !UUID.test(targetId)) focusedReview = null;
  }
  async function run(name, path, options = {}) {
    controllers.get(name)?.abort();
    const controller = new AbortController(); controllers.set(name, controller);
    try {
      const result = await request(path, { ...options, signal: controller.signal });
      if (disposed || controller.signal.aborted) throw new DOMException('Request cancelled', 'AbortError');
      return result;
    } catch (error) {
      if (disposed || controller.signal.aborted) throw new DOMException('Request cancelled', 'AbortError');
      throw error;
    } finally { if (controllers.get(name) === controller) controllers.delete(name); }
  }
  async function loadAnalytics() {
    if (disposed) return;
    try { analytics = await run('analytics', '/analytics'); renderAnalytics(); }
    catch (error) { if (!disposed && error?.name !== 'AbortError') { analytics = analytics ? { ...analytics, stale: true } : { state: 'unavailable' }; renderAnalytics(); } }
  }
  let lastStorePoll = Date.now();
  async function loadStore() {
    if (disposed) return;
    lastStorePoll = Date.now();
    const ackGeneration = reviewAckGeneration;
    try {
      const latest = await run('store', '/store');
      // A poll begun before a confirmed write may contain its old unread state.
      // Read again after that write rather than applying the outdated response.
      if (ackGeneration !== reviewAckGeneration) return loadStore();
      store = latest; renderStore(); renderReviews();
    } catch (error) {
      if (!disposed && error?.name !== 'AbortError') {
        if (ackGeneration !== reviewAckGeneration) return loadStore();
        store = store ? { ...store, stale: true } : null; renderStore(); renderReviews();
      }
    }
  }
  async function acknowledge(id, control) {
    if (disposed || control.disabled) return;
    control.disabled = true; control.textContent = 'Saving…';
    try {
      await run(`ack:${id}`, '/store/reviews/ack', { method: 'POST', body: { ids: [id] } });
      if (disposed) return;
      reviewAckGeneration++;
      store = { ...store, new_review_count: Math.max(0, (store.new_review_count ?? 0) - 1), reviews: store.reviews.map((item) => item.id === id ? { ...item, is_new: false } : item) };
      renderReviews(); focusReviewCard(id); notify('Review marked as read.', 'success');
    } catch (error) { if (!disposed && error?.name !== 'AbortError') { control.disabled = false; control.textContent = 'Mark as read'; notify('Could not mark the review as read. Retry when connected.', 'error'); } }
  }

  function checkStorePoll() {
    if (!availableToPoll()) return;
    const storeInterval = (Number.isFinite(store?.sync_interval_seconds) && store.sync_interval_seconds >= 60 ? store.sync_interval_seconds : 900) * 1000;
    if (Date.now() - lastStorePoll >= storeInterval && !controllers.has('store')) {
      void loadStore();
    }
  }

  loading(analyticsPanel, 'Listing visitors', 'Chrome Web Store listing');
  loading(storePanel, 'Chrome Web Store');
  loading(reviewsPanel, 'Reviews');
  void loadAnalytics(); void loadStore();
  const timer = win.setInterval(() => {
    updateStoreFreshness();
    if (!availableToPoll()) return;
    renderAnalytics();
    if (!controllers.has('analytics')) void loadAnalytics();
    checkStorePoll();
  }, 60000);
  listen(doc, 'visibilitychange', () => {
    updateStoreFreshness();
    if (analytics) renderAnalytics();
    checkStorePoll();
  });
  listen(win, 'offline', () => { updateStoreFreshness(); if (analytics) renderAnalytics(); });
  listen(win, 'online', () => {
    updateStoreFreshness();
    if (availableToPoll()) {
      if (!controllers.has('analytics')) void loadAnalytics();
      checkStorePoll();
    }
  });
  listen(win, 'popstate', () => { if (store) renderReviews(); });
  return { dispose() { if (disposed) return; for (const panel of [analyticsPanel, storePanel, reviewsPanel]) rememberDisclosures(panel); disposed = true; win.clearInterval(timer); for (const controller of controllers.values()) controller.abort(); controllers.clear(); for (const remove of listeners) remove(); analytics = null; store = null; } };
}
