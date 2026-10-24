import { formatNumber } from './lib.js';

const STORE_URL = 'https://chromewebstore.google.com/detail/nexusmods-bypass/chfghiknjhpcncpcjopglefnckckdlpj';
const RELEASE_PREFIX = 'https://github.com/thomasthanos/nexusmods-bypass/releases/tag/';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? formatNumber(value) : '—';
const text = (value, length) => typeof value === 'string' ? value.slice(0, length) : '';

/** Independent listing and store sources; all private state stays in this mount. */
export function mountGrowth(container, { request, notify = () => {}, document: doc = container.ownerDocument, window: win = doc.defaultView } = {}) {
  let disposed = false;
  let analytics = null;
  let store = null;
  let renderedStoreFresh = null;
  let focusedReview = null;
  let reviewHistoryOpen = false;
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
  function heading(panel, title, description) {
    panel.replaceChildren(); panel.removeAttribute('aria-busy');
    const top = element('div', 'panel-heading'); const copy = element('div');
    copy.append(element('h2', '', title)); if (description) copy.append(element('p', 'muted', description));
    top.append(copy); panel.append(top); return top;
  }
  function metric(label, value, note, key) {
    const card = element('div', 'growth-metric'); if (key) card.dataset.metric = key;
    card.append(element('div', 'growth-label', label), element('div', 'growth-value', value));
    if (note) card.append(element('p', 'growth-note', note)); return card;
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
      const warning = element('p', 'growth-state', reviews ? 'Saved reviews. Refresh to check the latest store data.' : 'Saved store data. Refresh to check the latest listing.');
      warning.dataset.storeFreshness = ''; panel.insertBefore(warning, source);
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
    const top = heading(analyticsPanel, 'Listing audience', 'Chrome Web Store listing visitors, measured by Google Analytics.');
    const ready = analytics?.state === 'ready';
    if (isFresh(analytics) && availableToPoll() && Number.isSafeInteger(analytics.online_30m) && analytics.online_30m >= 0) {
      const live = element('span', 'growth-live', 'Live'); live.dataset.live = 'true'; top.append(live);
    }
    if (!ready) {
      const configured = analytics?.state === 'not_configured';
      analyticsPanel.append(element('p', 'growth-state', configured ? 'Listing analytics is not configured.' : 'Listing analytics is temporarily unavailable.'));
      analyticsPanel.append(element('p', 'muted', configured ? 'Connect Google Analytics and grant access to the listing property to see audience metrics.' : 'Use Refresh or retry when Google Analytics is available.'));
      analyticsPanel.append(button('Retry analytics', () => { void loadAnalytics(); }));
    }
    const grid = element('div', 'growth-metrics');
    const trend = ready && Number.isFinite(analytics.weekly_change_percent) && analytics.previous_weekly_active > 0
      ? `${analytics.weekly_change_percent > 0 ? '+' : ''}${analytics.weekly_change_percent.toFixed(1)}% vs previous 7 days`
      : ready && analytics.previous_weekly_active === 0 ? 'No previous-week baseline' : 'Previous-week comparison unavailable';
    const online = metric('Listing active users · last 30 min', ready ? count(analytics.online_30m) : '—', 'Visitors to the store listing', 'online');
    const weekly = metric('Weekly listing users', ready ? count(analytics.weekly_active) : '—', 'Last 7 complete days', 'weekly');
    const change = element('p', 'growth-trend', trend);
    if (ready && Number.isFinite(analytics.weekly_change_percent) && analytics.previous_weekly_active > 0) change.dataset.direction = analytics.weekly_change_percent > 0 ? 'up' : analytics.weekly_change_percent < 0 ? 'down' : 'flat';
    weekly.append(change);
    const historyDate = /^\d{4}-\d{2}-\d{2}$/.test(analytics?.history_start_date ?? '') ? analytics.history_start_date : null;
    grid.append(online, weekly, metric('Listing unique visitors', ready ? count(analytics.history_total_users) : '—', historyDate ? `Since ${historyDate}` : 'History start date unavailable', 'history'));
    analyticsPanel.append(grid);
    if (ready && !isFresh(analytics)) analyticsPanel.append(element('p', 'growth-state', 'Saved listing data. Refresh to check the latest audience.'));
    if (analytics?.message) analyticsPanel.append(element('p', 'growth-state', text(analytics.message, 500)));
    const quality = analytics?.quality;
    const limitations = [quality?.subject_to_thresholding && 'Google thresholding applies', quality?.sampled && 'Sampled data', quality?.data_loss && 'Google reports data loss'].filter(Boolean);
    if (limitations.length) analyticsPanel.append(element('p', 'growth-state', limitations.join(' · ')));
    const zone = text(analytics?.time_zone, 80);
    fetched(analyticsPanel, `Google Analytics · store listing${zone ? ` · ${zone}` : ''}`, analytics?.fetched_at, ready && !isFresh(analytics));
  }
  function externalLink(label, href) {
    const link = element('a', 'button button-small button-quiet', label); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; return link;
  }
  function releaseUrl(value) {
    if (typeof value !== 'string' || !value.startsWith(RELEASE_PREFIX)) return null;
    const tag = value.slice(RELEASE_PREFIX.length);
    return /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/.test(tag) ? value : null;
  }
  function renderStore() {
    if (disposed) return;
    const snapshot = store?.snapshot;
    const top = heading(storePanel, 'Chrome Web Store', 'Public listing totals and release status.');
    top.append(externalLink('Open store', STORE_URL));
    if (!snapshot) {
      storePanel.append(element('p', 'growth-state', 'Store data is temporarily unavailable.'), button('Retry store', () => { void loadStore(); }));
      fetched(storePanel, 'Chrome Web Store', store?.last_checked_at); return;
    }
    const grid = element('div', 'growth-metrics');
    const rating = typeof snapshot.rating_average === 'number' && Number.isFinite(snapshot.rating_average) && snapshot.rating_average >= 0 && snapshot.rating_average <= 5 ? snapshot.rating_average.toFixed(2) : '—';
    const ratingCard = metric('Store rating', rating, `${count(snapshot.rating_count)} ratings`, 'rating');
    const star = element('span', 'growth-star', '★'); star.setAttribute('aria-hidden', 'true'); ratingCard.querySelector('.growth-value').prepend(star, doc.createTextNode(' '));
    grid.append(metric('Store users', count(snapshot.users), 'Public user badge', 'users'), ratingCard, metric('Written reviews', count(snapshot.written_review_count), 'Reviews with written feedback', 'reviews'));
    storePanel.append(grid);
    const version = element('div', 'growth-version');
    const versions = element('div'); versions.append(element('strong', '', `Store ${text(snapshot.version, 64) || 'version unavailable'}`));
    versions.append(element('span', 'muted', `Latest release ${text(snapshot.latest_release_version, 64) || 'unavailable'}`));
    const labels = { up_to_date: 'Up to date', store_behind: 'Store update pending', store_ahead: 'Store version ahead', unknown: 'Version comparison unavailable' };
    const status = element('span', 'tag', labels[snapshot.version_status] ?? labels.unknown); status.dataset.versionStatus = snapshot.version_status;
    version.append(versions, status);
    const release = releaseUrl(snapshot.latest_release_url); if (release) version.append(externalLink('View latest release', release));
    storePanel.append(version);
    const storeStale = !isStoreFresh();
    renderedStoreFresh = !storeStale;
    if (store?.message) storePanel.append(element('p', 'growth-state', text(store.message, 500)));
    fetched(storePanel, 'Chrome Web Store', snapshot.fetched_at, storeStale);
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
    if (history) { history.open = true; reviewHistoryOpen = true; }
    if (scroll) card.scrollIntoView?.({ block: 'center', behavior: 'auto' });
    card.focus({ preventScroll: true }); return true;
  }
  function renderReviews() {
    if (disposed) return;
    const previousHistory = reviewsPanel.querySelector('[data-review-history]');
    if (previousHistory) reviewHistoryOpen = previousHistory.open;
    const top = heading(reviewsPanel, 'Store reviews', 'Written feedback from the Chrome Web Store.');
    const reviews = Array.isArray(store?.reviews) ? store.reviews.filter((item, index, list) => typeof item?.id === 'string' && UUID.test(item.id) && list.findIndex((other) => typeof other?.id === 'string' && other.id.toLowerCase() === item.id.toLowerCase()) === index).slice(0, 100)
      .sort((a, b) => (Number.isFinite(b.created_at) ? b.created_at : 0) - (Number.isFinite(a.created_at) ? a.created_at : 0) || a.id.localeCompare(b.id)) : [];
    const newCount = Number.isSafeInteger(store?.new_review_count) && store.new_review_count > 0 ? store.new_review_count : 0;
    if (newCount) top.append(element('span', 'tag tag-warning', `${count(newCount)} new`));
    if (!reviews.length) reviewsPanel.append(element('p', 'muted', store?.snapshot ? 'No written reviews have been fetched yet.' : 'Reviews are temporarily unavailable.'));
    const list = element('div', 'growth-review-list'); list.dataset.reviewPreview = '';
    const olderList = element('div', 'growth-review-list');
    const latestIds = new Set(reviews.slice(0, 3).map((review) => review.id));
    for (const review of reviews) {
      const card = element('article', 'growth-review'); card.dataset.reviewId = review.id; card.dataset.new = String(review.is_new === true); card.tabIndex = -1;
      const header = element('div', 'growth-review-heading'); const author = element('h3', '', text(review.author, 160) || 'Store reviewer');
      const rating = Number.isInteger(review.rating) && review.rating >= 1 && review.rating <= 5 ? review.rating : null;
      header.append(author, element('span', 'growth-review-rating', rating ? `★ ${rating}/5` : 'Rating unavailable'));
      if (review.is_new === true) header.append(element('span', 'tag tag-warning', 'New review'));
      const metadata = element('div', 'growth-review-meta muted'); const created = reviewDate(review.created_at); if (created) metadata.append(created);
      if (review.version) metadata.append(element('span', '', `Version ${text(review.version, 64)}`));
      card.append(header, metadata, element('p', 'growth-review-body', text(review.body, 10000) || 'No written text.'));
      if (review.is_new === true) card.append(button('Mark as read', (event) => { void acknowledge(review.id, event.currentTarget); }, 'ack-review'));
      (review.is_new === true || latestIds.has(review.id) ? list : olderList).append(card);
    }
    reviewsPanel.append(list);
    if (olderList.children.length) {
      const history = element('details', 'growth-review-history'); history.dataset.reviewHistory = ''; history.open = reviewHistoryOpen;
      history.append(element('summary', '', `Show ${count(olderList.children.length)} older ${olderList.children.length === 1 ? 'review' : 'reviews'}`), olderList);
      reviewsPanel.append(history);
    }
    const storeStale = !isStoreFresh();
    if (store?.snapshot?.reviews_complete === false) reviewsPanel.append(element('p', 'growth-state', 'Showing the written reviews available from the latest store check. The store may contain more reviews.'));
    if (store?.message) reviewsPanel.append(element('p', 'growth-state', text(store.message, 1600)));
    fetched(reviewsPanel, 'Chrome Web Store', store?.snapshot?.fetched_at, storeStale);
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
      reviewsPanel.append(check);
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

  loading(analyticsPanel, 'Listing audience', 'Chrome Web Store listing visitors, measured by Google Analytics.');
  loading(storePanel, 'Chrome Web Store', 'Public listing totals and release status.');
  loading(reviewsPanel, 'Store reviews', 'Written feedback from the Chrome Web Store.');
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
  return { dispose() { if (disposed) return; disposed = true; win.clearInterval(timer); for (const controller of controllers.values()) controller.abort(); controllers.clear(); for (const remove of listeners) remove(); analytics = null; store = null; } };
}
