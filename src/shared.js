(function () {
  'use strict';

  const SETTINGS_KEY = 'nxtk_settings';
  const ERROR_LOG_KEY = 'nxtk_error_log';
  const MAX_LOGGED_ERRORS = 50;
  const TOTAL_DOWNLOADS_KEY = 'nxtk_total_downloads';
  const RATING_PROMPT_KEY = 'nxtk_rating_prompted';
  const RATING_STATE_KEY = 'nxtk_rating_state';
  const GITHUB_REPO_URL = 'https://github.com/thomasthanos/nexusmods-bypass';
  const ISSUE_NEW_URL = `${GITHUB_REPO_URL}/issues/new`;
  const REPORT_ISSUE_URL = `${GITHUB_REPO_URL}/issues/new/choose`;
  const TROUBLESHOOTING_URL = `${GITHUB_REPO_URL}#-troubleshooting`;
  // Each store issues its own extension id, so the id is what says where a copy came from —
  // and that is the only listing where its rating can be left. The browser running it says
  // nothing: Edge installs from the Chrome Web Store just as happily as from its own.
  const STORE_LISTINGS = {
    chrome: {
      id: 'chfghiknjhpcncpcjopglefnckckdlpj',
      name: 'Chrome Web Store',
      reviewUrl: 'https://chromewebstore.google.com/detail/nexusmods-bypass/chfghiknjhpcncpcjopglefnckckdlpj/reviews'
    },
    edge: {
      id: 'hcjpcnajmkanhodhpkoinodjbkeolgaa',
      name: 'Edge Add-ons',
      reviewUrl: 'https://microsoftedge.microsoft.com/addons/detail/hcjpcnajmkanhodhpkoinodjbkeolgaa'
    },
    firefox: {
      id: '',
      name: 'Firefox Add-ons',
      reviewUrl: 'https://addons.mozilla.org/en-US/firefox/addon/nexusmods-bypass/reviews/'
    }
  };

  function getStoreListing() {
    try {
      // The Firefox package is built with this marker; no other package carries it.
      if (chrome.runtime.getManifest().browser_specific_settings?.gecko) return STORE_LISTINGS.firefox;
      const id = chrome.runtime.id;
      for (const listing of Object.values(STORE_LISTINGS)) {
        if (listing.id && listing.id === id) return listing;
      }
    } catch (_) {
    }
    // An unpacked or sideloaded copy has an id of its own, which belongs to no listing.
    return STORE_LISTINGS.chrome;
  }

  function getStoreReviewUrl() {
    return getStoreListing().reviewUrl;
  }

  // Asked at download milestones rather than once and never again, because someone who has
  // used this a thousand times has more reason to say something than someone who has used it
  // twenty-five times. The gaps widen so it never becomes a nag, a dismissal only clears the
  // milestone it was shown for, and following either link ends it for good.
  const RATING_MILESTONES = [25, 120, 500, 1500];
  const RATING_MIN_GAP_MS = 21 * 24 * 60 * 60 * 1000;

  function readRatingState() {
    return new Promise((resolve) => {
      // Anything unreadable resolves as settled, so a storage fault can never nag.
      const settled = { done: true, cleared: 0, askedAt: 0 };
      try {
        if (!chrome?.runtime?.id) {
          resolve(settled);
          return;
        }
        chrome.storage.local.get([RATING_STATE_KEY, RATING_PROMPT_KEY], (result) => {
          if (chrome.runtime.lastError) {
            resolve(settled);
            return;
          }
          const state = result?.[RATING_STATE_KEY];
          if (state && typeof state === 'object') {
            resolve({
              done: state.done === true,
              cleared: Number(state.cleared) || 0,
              askedAt: Number(state.askedAt) || 0,
              snoozeUntil: Number(state.snoozeUntil) || 0,
              runAsked: state.runAsked === true
            });
            return;
          }
          // Already asked once under the old rule. That counts as the first milestone, and
          // the gap runs from now, so an upgrade never produces an ask straight away.
          if (result?.[RATING_PROMPT_KEY]) {
            resolve({ done: false, cleared: RATING_MILESTONES[0], askedAt: Date.now() });
            return;
          }
          resolve({ done: false, cleared: 0, askedAt: 0 });
        });
      } catch (_) {
        resolve(settled);
      }
    });
  }

  function writeRatingState(state) {
    try {
      if (!chrome?.runtime?.id) return;
      chrome.storage.local.set({ [RATING_STATE_KEY]: state }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_) {
    }
  }

  // The milestone that has come due, or 0 when there is nothing to ask about.
  function ratingMilestoneDue(total, state) {
    if (!state || state.done) return 0;
    if (state.snoozeUntil && Date.now() < state.snoozeUntil) return 0;
    const count = Number(total) || 0;
    let due = 0;
    for (const milestone of RATING_MILESTONES) {
      if (count >= milestone && milestone > state.cleared) due = milestone;
    }
    if (!due) return 0;
    if (state.askedAt && Date.now() - state.askedAt < RATING_MIN_GAP_MS) return 0;
    return due;
  }

  function dueRatingMilestone(total) {
    return readRatingState().then((state) => ratingMilestoneDue(total, state));
  }

  function markRatingAsked(milestone) {
    readRatingState().then((state) => {
      writeRatingState({
        ...state,
        done: state.done,
        cleared: Math.max(state.cleared, Number(milestone) || 0),
        askedAt: Date.now()
      });
    });
  }

  function markRatingSettled() {
    readRatingState().then((state) => {
      writeRatingState({ ...state, done: true, cleared: state.cleared, askedAt: Date.now() });
    });
  }

  // A second, gentler trigger: after a few whole collection runs finish cleanly, ask once. "Later"
  // snoozes every ask for two weeks; closing it or following a link ends the run-based ask for good.
  const RUNS_FINISHED_KEY = 'nxtk_runs_finished';
  const RATING_RUN_THRESHOLD = 5;
  const RATING_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

  function readRunsFinished() {
    return new Promise((resolve) => {
      try {
        if (!chrome?.runtime?.id) return resolve(0);
        chrome.storage.local.get(RUNS_FINISHED_KEY, (result) => {
          void chrome.runtime.lastError;
          resolve(Number(result?.[RUNS_FINISHED_KEY]) || 0);
        });
      } catch (_) {
        resolve(0);
      }
    });
  }

  async function recordFinishedRun() {
    const next = (await readRunsFinished()) + 1;
    try {
      if (chrome?.runtime?.id) chrome.storage.local.set({ [RUNS_FINISHED_KEY]: next }, () => void chrome.runtime.lastError);
    } catch (_) {
    }
    return next;
  }

  function runPromptDue(runs, state) {
    if (!state || state.done || state.runAsked) return false;
    if (state.snoozeUntil && Date.now() < state.snoozeUntil) return false;
    return (Number(runs) || 0) >= RATING_RUN_THRESHOLD;
  }

  function snoozeRatingPrompt() {
    readRatingState().then((state) => {
      writeRatingState({ ...state, snoozeUntil: Date.now() + RATING_SNOOZE_MS });
    });
  }

  function markRunPromptAnswered() {
    readRatingState().then((state) => writeRatingState({ ...state, runAsked: true }));
  }

  const RATING_STAR_PATH = 'M12 2.6l2.94 5.96 6.58.96-4.76 4.64 1.12 6.55L12 17.7l-5.88 3.01 '
    + '1.12-6.55L2.48 9.52l6.58-.96z';

  // Decoration only: the caller marks the container aria-hidden, and the link text names the store.
  function ratingStarsMarkup(size) {
    const px = Number(size) > 0 ? Math.round(Number(size)) : 14;
    return Array.from({ length: 5 }, () =>
      `<svg viewBox="0 0 24 24" width="${px}" height="${px}"><path d="${RATING_STAR_PATH}"/></svg>`).join('');
  }

  // The popup and the deck ask in the same words, at the same milestones, for the same listing.
  async function prepareRatingPrompt({ includeRuns = false } = {}) {
    const total = await readTotalDownloads();
    const milestone = await dueRatingMilestone(total);
    const listing = getStoreListing();
    if (!milestone) {
      if (!includeRuns) return null;
      const runs = await readRunsFinished();
      if (!runPromptDue(runs, await readRatingState())) return null;
      return {
        milestone: 0,
        kind: 'runs',
        listing,
        copy: t('ratingPromptRuns', [String(runs)],
          `${runs} collections downloaded. If it saved you time, a short review or a GitHub star helps a lot.`),
        reviewText: t('ratingCta', [listing.name], `Rate on ${listing.name}`),
        starText: t('ratingStarCta', null, 'Star on GitHub'),
        laterText: t('ratingLater', null, 'Later'),
        starUrl: GITHUB_REPO_URL
      };
    }
    return {
      kind: 'downloads',
      laterText: t('ratingLater', null, 'Later'),
      milestone,
      listing,
      copy: t('ratingPromptCount', [String(milestone)],
        `${milestone} files downloaded. A short review helps other modders find this.`),
      reviewText: t('ratingCta', [listing.name], `Rate on ${listing.name}`),
      starText: t('ratingStarCta', null, 'Star on GitHub'),
      starUrl: GITHUB_REPO_URL
    };
  }

  const DEFAULTS = {
    AutoStartDownload: true,
    AutoCloseTab: true,
    SkipRequirements: true,
    ShowAlertsOnError: true,
    HandleArchivedFiles: true,
    CloudflareFallback: true,
    HidePremiumUpsells: true,
    DebugLogs: false,
    AutoErrorReports: false,
    DownloadFolder: 'NexusMods',
    CloseTabDelay: 3000,
    RequestTimeout: 30000,
    NDC_pauseBetweenDownload: 5,
    NDC_downloadSpeed: 3.2,
    ForceEnglish: false,
    NDC_downloadMethod: 0,
    NDC_smallestFirst: true,
    HideDownloadPopup: true,
    WabbajackImport: false,
    // Official-API migration flags (docs/nexus-site-map.md). Off restores the pre-2.10 behaviour.
    UseOfficialApi: true,
    FollowUpdatePolicy: false,
    ShowModActions: true
  };

  // Bounds every writer applies, so a value typed into a field never reaches storage out of range.
  const SETTING_LIMITS = Object.freeze({
    CloseTabDelay: Object.freeze({ min: 0, max: 60000, integer: true }),
    RequestTimeout: Object.freeze({ min: 5000, max: 120000, integer: true }),
    NDC_pauseBetweenDownload: Object.freeze({ min: 0, max: 600, integer: true }),
    NDC_downloadSpeed: Object.freeze({ min: 0.1, max: 1000 }),
    NDC_downloadMethod: Object.freeze({ min: 0, max: 1, integer: true }),
    DownloadFolder: Object.freeze({ maxLength: 100 })
  });

  // The stored form of a setting, or undefined when the value cannot be stored at all.
  function normalizeSetting(key, value) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) return undefined;
    if (typeof value !== typeof DEFAULTS[key]) return undefined;
    const limits = SETTING_LIMITS[key];
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return undefined;
      if (!limits) return value;
      const rounded = limits.integer ? Math.round(value) : value;
      return Math.min(Math.max(rounded, limits.min), limits.max);
    }
    if (typeof value === 'string' && limits?.maxLength) return value.slice(0, limits.maxLength);
    return value;
  }

  const ARCHIVE_FILE_EXTENSIONS = Object.freeze([
    'zip', '7z', 'rar', '001', 'tar', 'gz', 'tgz', 'bz2', 'tbz2', 'xz', 'txz', 'lzma',
    'exe', 'msi', 'jar', 'fomod', 'omod', 'esp', 'esm', 'esl', 'dll'
  ]);
  const DOWNLOAD_FILE_EXTENSIONS = Object.freeze([
    ...ARCHIVE_FILE_EXTENSIONS,
    'txt', 'pdf', 'json', 'xml', 'ini', 'cfg'
  ]);

  const RATE_LIMIT_BASE_SECONDS = 30;
  const RATE_LIMIT_MAX_SECONDS = 10 * 60;
  const RATE_LIMIT_MAX_STRIKES = 6;

  // Seconds a Retry-After header asks for, or null when there is no usable header.
  function parseRetryAfterSeconds(raw) {
    const header = String(raw ?? '').trim();
    if (!header) return null;
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds);
    const asDate = Date.parse(header);
    return Number.isNaN(asDate) ? null : Math.max(0, Math.round((asDate - Date.now()) / 1000));
  }

  const MIN_HANDOFF_GAP_SECONDS = 2;

  // ---- Friendlier setup (3.1.0) ----

  // Presets set a few behaviour switches at once. They never touch pacing (download speed, pause
  // between mods), timeouts, or the ad/Premium panel setting.
  const SETTING_PRESETS = Object.freeze({
    vortex: Object.freeze({
      NDC_downloadMethod: 0, AutoStartDownload: true, AutoCloseTab: true, SkipRequirements: true, HideDownloadPopup: true
    }),
    browser: Object.freeze({
      NDC_downloadMethod: 1, AutoStartDownload: true, AutoCloseTab: false, SkipRequirements: true, HideDownloadPopup: true
    }),
    minimal: Object.freeze({
      AutoStartDownload: false, AutoCloseTab: false, SkipRequirements: false, HandleArchivedFiles: false,
      ShowModActions: false, WabbajackImport: false
    })
  });
  const PRESET_PROTECTED_KEYS = Object.freeze(['NDC_downloadSpeed', 'NDC_pauseBetweenDownload', 'RequestTimeout', 'CloseTabDelay', 'HidePremiumUpsells']);

  // The settings with a preset's values applied (normalized; unknown names change nothing).
  function applyPreset(settings, name) {
    const preset = SETTING_PRESETS[name];
    const next = { ...(settings || {}) };
    if (!preset) return next;
    for (const [key, value] of Object.entries(preset)) {
      if (PRESET_PROTECTED_KEYS.includes(key)) continue;
      const normalized = normalizeSetting(key, value);
      if (normalized !== undefined) next[key] = normalized;
    }
    return next;
  }

  // The preset the settings currently match exactly, or null ("Custom").
  function matchingPreset(settings) {
    for (const [name, preset] of Object.entries(SETTING_PRESETS)) {
      if (Object.entries(preset).every(([key, value]) => (settings?.[key] ?? DEFAULTS[key]) === value)) return name;
    }
    return null;
  }

  // Technical settings shown only under "Advanced".
  const ADVANCED_SETTING_KEYS = Object.freeze([
    'RequestTimeout', 'CloseTabDelay', 'NDC_downloadSpeed', 'NDC_pauseBetweenDownload', 'UseOfficialApi', 'CloudflareFallback'
  ]);

  // Which action buttons an error dialog offers, from the error and what the caller can do.
  // Returns ids in display order: signIn, retryIn, retry, openFilePage, switchToBrowser.
  const FILE_PAGE_ERROR_CODES = new Set(['no_download_url', 'no_nmm_link', 'unsafe_download_url', 'file_not_found',
    'access_denied', 'moderation_hold', 'cloudflare', 'mod_unavailable', 'short_file', 'empty_file', 'not_a_file']);
  function errorActionsFor(error, { canRetry = false, filePageUrl = '', method = '', canSwitchToBrowser = false } = {}) {
    const code = error?.code || '';
    const actions = [];
    if (code === 'requires_login') return ['signIn'];
    const wait = Number(error?.retryAfterSeconds) || 0;
    if (canRetry && code === 'rate_limited' && wait > 0) actions.push('retryIn');
    else if (canRetry) actions.push('retry');
    if (filePageUrl && FILE_PAGE_ERROR_CODES.has(code)) actions.push('openFilePage');
    if (canSwitchToBrowser && method === 'vortex' && code !== 'rate_limited' && code !== 'account_suspended') actions.push('switchToBrowser');
    return actions;
  }

  // "1:05" style countdown text for a number of seconds.
  function formatCountdown(seconds) {
    const total = Math.max(0, Math.ceil(Number(seconds) || 0));
    const m = Math.floor(total / 60);
    const sec = String(total % 60).padStart(2, '0');
    return `${m}:${sec}`;
  }

  // Whether Vortex opens for this browser profile, as far as the extension has seen.
  //   confirmed: the user said "yes" (or Vortex visibly took over) and nothing failed since
  //   failStreak: hand-offs in a row with no sign of Vortex (a "no", or nothing happening)
  const VORTEX_OPEN_KEY = 'nxtk_vortex_open';
  const VORTEX_SWITCH_OFFER_STREAK = 2;
  function vortexOpenNext(state, event) {
    const current = { confirmed: !!state?.confirmed, failStreak: Math.max(0, Number(state?.failStreak) || 0) };
    switch (event) {
      case 'opened':
      case 'answeredYes':
        return { confirmed: true, failStreak: 0 };
      case 'answeredNo':
      case 'notDetected':
        return { confirmed: false, failStreak: current.failStreak + 1 };
      case 'reset':
        return { confirmed: false, failStreak: 0 };
      default:
        return current;
    }
  }
  const shouldAskVortexOpened = (state) => !state?.confirmed;
  const shouldOfferBrowserSwitch = (state) => (Number(state?.failStreak) || 0) >= VORTEX_SWITCH_OFFER_STREAK;
  const VORTEX_INSTALL_GUIDE_URL = 'https://www.nexusmods.com/about/vortex/';

  function readVortexOpenState() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(VORTEX_OPEN_KEY, (result) => {
          if (chrome.runtime.lastError) return resolve(vortexOpenNext(null));
          resolve(vortexOpenNext(result?.[VORTEX_OPEN_KEY]));
        });
      } catch (_) {
        resolve(vortexOpenNext(null));
      }
    });
  }

  async function recordVortexOpenEvent(event) {
    const next = vortexOpenNext(await readVortexOpenState(), event);
    await new Promise((resolve) => {
      try {
        chrome.storage.local.set({ [VORTEX_OPEN_KEY]: next }, () => { void chrome.runtime.lastError; resolve(); });
      } catch (_) {
        resolve();
      }
    });
    return next;
  }

  // A link Vortex treats as harmless: "re-read the membership". It opens (or focuses) Vortex and
  // changes nothing, so it can test the nxm:// handler.
  const VORTEX_TEST_LINK = 'nxm://premium';

  // Plain text for "Copy list" on the end-of-run summary.
  function formatRunSummaryText({ sent = [], skipped = [], failed = [], account = '' } = {}, t = (k, f) => f) {
    const lines = [];
    const section = (title, items, render) => {
      if (!items.length) return;
      lines.push(`${title} (${items.length})`);
      for (const item of items) lines.push(`- ${render(item)}`);
      lines.push('');
    };
    section(t('summarySent', 'Sent'), sent, (i) => i.name);
    section(t('summarySkipped', 'Skipped'), skipped, (i) => `${i.name} (${i.reason})${i.pageUrl ? ` ${i.pageUrl}` : ''}`);
    section(t('summaryFailed', 'Failed'), failed, (i) => `${i.name} (${i.code})${i.pageUrl ? ` ${i.pageUrl}` : ''}`);
    if (account) lines.push(`${t('summaryAccount', 'Nexus account')}: #${account}`);
    return lines.join('\n').trim();
  }

  // Sent/downloaded counts for one collection's history, for the history view.
  function summarizeCollectionHistory(collection, type, allIds = []) {
    const downloaded = new Set(Array.isArray(collection?.[type]) ? collection[type] : []);
    const sent = new Set(Array.isArray(collection?.[vortexSentType(type)]) ? collection[vortexSentType(type)] : []);
    for (const id of downloaded) sent.delete(id);
    const missing = allIds.filter((id) => !downloaded.has(id));
    return { downloaded: downloaded.size, sent: sent.size, missing, total: allIds.length };
  }

  // Vortex hand-offs are recorded apart from real downloads: the browser cannot see whether Vortex
  // received a link, so a "sent" file is never skipped on a later run (Vortex itself skips files it
  // already has, so re-sending is harmless). One list per history type.
  const VORTEX_SENT_PREFIX = 'vortexSent_';
  const vortexSentType = (type) => `${VORTEX_SENT_PREFIX}${type}`;

  // An nxm:// link is resolved by Vortex the moment it arrives, so it only has to be valid then.
  // Treat a link as expired a little early so it never dies in transit.
  const NXM_EXPIRY_MARGIN_MS = 30 * 1000;

  // The `expires` (unix seconds) and `user_id` query values of an nxm:// link, split by hand (URL
  // parsing of custom schemes differs across Chromium versions). Missing values come back as null.
  function nxmLinkInfo(link) {
    const match = /^nxm:\/\/[^?#]*\?([^#]*)/i.exec(String(link || ''));
    if (!match) return { expiresAt: null, userId: null };
    const params = new URLSearchParams(match[1]);
    const expires = params.get('expires') || '';
    const userId = params.get('user_id') || '';
    return {
      expiresAt: /^\d+$/.test(expires) ? Number(expires) * 1000 : null,
      userId: /^\d+$/.test(userId) ? userId : null
    };
  }

  function isNxmLinkExpired(link, now = Date.now(), marginMs = NXM_EXPIRY_MARGIN_MS) {
    const { expiresAt } = nxmLinkInfo(link);
    return expiresAt !== null && expiresAt - marginMs <= now;
  }

  // Whether a link was signed for a different Nexus account than the one signed in on the page.
  // Unknown on either side is not a mismatch.
  function isNexusUserMismatch(linkUserId, pageUserId) {
    if (!linkUserId || !pageUserId) return false;
    return String(linkUserId) !== String(pageUserId);
  }

  // Whether the first nxm:// hand-off visibly reached another program. Chrome's own "Open xdg-open?"
  // / "Open Vortex?" prompt also blurs the page, and both answers give the focus back, so a blur alone
  // proves nothing: cancelling the prompt must not read as "Vortex opened".
  //   - the page going hidden (another window took over the screen) -> true
  //   - the page losing focus and staying unfocused for maxMs (Vortex holds the focus) -> true
  //   - focus coming back after a blur (prompt answered either way, or dismissed) -> false
  //   - nothing within timeoutMs -> false
  // false means "unknown", and the caller asks the user once. Targets are injectable for tests.
  // Watches whether a nxm:// navigation handed the page over to another app.
  //   - page hidden                         -> opened
  //   - blur with no focus return for maxMs (20 s) -> opened (another window kept focus)
  //   - blur, then focus back within maxMs  -> NOT opened, even after a long-open browser dialog (Chrome's "Open Vortex?" dialog was
  //     cancelled, or dismissed). Chrome does not always fire window 'focus' when its own
  //     external-protocol dialog closes, so document.hasFocus() is polled too.
  //   - nothing within timeoutMs            -> NOT opened
  // onResult(reason) names which rule decided, for the debug log.
  // Page hidden = opened at once; otherwise focus must stay away this long (no return) to count as opened.
  const PROTOCOL_BLUR_OPENED_MS = 20000;

  function waitForProtocolHandoff({
    win = globalThis.window,
    doc = globalThis.document,
    timeoutMs = 4000,
    maxMs = PROTOCOL_BLUR_OPENED_MS,
    pollMs = 250,
    onResult = null
  } = {}) {
    return new Promise((resolve) => {
      let done = false;
      let blurTimer = null;
      let pollTimer = null;
      let blurred = false;
      const finish = (value, reason) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(blurTimer);
        clearInterval(pollTimer);
        win?.removeEventListener?.('blur', onBlur);
        win?.removeEventListener?.('focus', onFocus);
        doc?.removeEventListener?.('visibilitychange', onVisibility);
        doc?.removeEventListener?.('pointerdown', onInteract, true);
        doc?.removeEventListener?.('keydown', onInteract, true);
        try { onResult?.(reason); } catch (_) { }
        resolve(value);
      };
      const hasFocus = () => {
        try { return typeof doc?.hasFocus === 'function' ? doc.hasFocus() : null; } catch (_) { return null; }
      };
      const onBlur = () => {
        if (blurred) return;
        blurred = true;
        clearTimeout(timer);
        blurTimer = setTimeout(() => finish(true, 'blur-persisted'), Math.max(0, maxMs));
        if (pollMs > 0) {
          pollTimer = setInterval(() => {
            if (doc?.visibilityState === 'hidden') return finish(true, 'hidden');
            if (hasFocus() === true) finish(false, 'focus-returned');
          }, pollMs);
        }
      };
      const onFocus = () => { if (blurred) finish(false, 'focus-returned'); };
      // Clicking or typing in the page after the blur means the user is back here, not in Vortex.
      const onInteract = () => { if (blurred) finish(false, 'user-back'); };
      const onVisibility = () => { if (doc?.visibilityState === 'hidden') finish(true, 'hidden'); };
      const timer = setTimeout(() => finish(false, 'no-signal'), timeoutMs);
      win?.addEventListener?.('blur', onBlur);
      win?.addEventListener?.('focus', onFocus);
      doc?.addEventListener?.('visibilitychange', onVisibility);
      doc?.addEventListener?.('pointerdown', onInteract, true);
      doc?.addEventListener?.('keydown', onInteract, true);
      // A dialog may already have taken focus before the watcher started.
      if (hasFocus() === false) onBlur();
    });
  }


  // What a browser-download interrupt reason means for a retry. chrome.downloads names the reason
  // (InterruptReason); Firefox uses the same strings. Transient network/server hiccups are retried
  // (with backoff, one file at a time, through Nexus's normal link); problems a retry cannot fix
  // (disk full, access denied, blocked by the browser, the user cancelling) are not.
  const DOWNLOAD_INTERRUPTS = Object.freeze({
    transient: ['NETWORK_FAILED', 'NETWORK_TIMEOUT', 'NETWORK_DISCONNECTED', 'NETWORK_SERVER_DOWN',
      'NETWORK_INVALID_REQUEST', 'SERVER_FAILED', 'SERVER_NO_RANGE', 'SERVER_CONTENT_LENGTH_MISMATCH',
      'SERVER_CROSS_ORIGIN_REDIRECT', 'FILE_FAILED', 'FILE_TRANSIENT_ERROR', 'FILE_HASH_MISMATCH', 'CRASH'],
    // A signed link that expired or was refused: worth one more try with a freshly requested link.
    link: ['SERVER_FORBIDDEN', 'SERVER_UNAUTHORIZED', 'SERVER_CERT_PROBLEM', 'SERVER_BAD_CONTENT'],
    disk: ['FILE_NO_SPACE', 'FILE_ACCESS_DENIED', 'FILE_NAME_TOO_LONG', 'FILE_TOO_LARGE', 'FILE_TOO_SHORT'],
    blocked: ['FILE_VIRUS_INFECTED', 'FILE_BLOCKED', 'FILE_SECURITY_CHECK_FAILED'],
    user: ['USER_CANCELED', 'USER_SHUTDOWN']
  });
  const DOWNLOAD_RETRY_LIMITS = Object.freeze({ transient: 2, link: 1, unknown: 1, disk: 0, blocked: 0, user: 0, size: 1 });

  function classifyDownloadInterrupt(error) {
    const text = String(error || '').toUpperCase();
    if (/\bEMPTY_FILE|SHORT_FILE|NOT_A_FILE|SIZE_MISMATCH/.test(text)) return { kind: 'size', retries: DOWNLOAD_RETRY_LIMITS.size };
    for (const [kind, reasons] of Object.entries(DOWNLOAD_INTERRUPTS)) {
      if (reasons.some((reason) => text.includes(reason))) return { kind, retries: DOWNLOAD_RETRY_LIMITS[kind] };
    }
    return { kind: 'unknown', retries: DOWNLOAD_RETRY_LIMITS.unknown };
  }

  // Log lines carry a little markup (links to mods, emphasis). Rather than trust every caller to have
  // escaped its input before innerHTML, the markup is parsed inertly and rebuilt from an allowlist:
  // anything else becomes text, and links must point at http(s).
  const SAFE_TAGS = new Set(['A', 'SPAN', 'STRONG', 'B', 'EM', 'I', 'CODE', 'BR', 'SMALL']);
  const SAFE_ATTRS = new Set(['class', 'title', 'target', 'rel', 'href']);

  function setSafeHtml(target, markup) {
    const doc = target?.ownerDocument;
    if (!doc) return;
    const source = doc.createElement('template');
    source.innerHTML = String(markup ?? '');
    const copy = (node, parent) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) {
          parent.appendChild(doc.createTextNode(child.nodeValue));
        } else if (child.nodeType === 1) {
          if (!SAFE_TAGS.has(child.tagName)) {
            copy(child, parent);
            continue;
          }
          const el = doc.createElement(child.tagName.toLowerCase());
          for (const attr of Array.from(child.attributes)) {
            const name = attr.name.toLowerCase();
            if (!SAFE_ATTRS.has(name)) continue;
            if (name === 'href' && !/^https?:\/\//i.test(attr.value.trim())) continue;
            el.setAttribute(name, attr.value);
          }
          if (el.tagName === 'A') el.setAttribute('rel', 'noopener noreferrer');
          copy(child, el);
          parent.appendChild(el);
        }
      }
    };
    target.replaceChildren();
    copy(source.content, target);
  }

  // Exponential backoff with "equal jitter": half the step is fixed, half is random, so several tabs
  // or a restarted worker that failed together do not retry in lockstep.
  function retryDelayMs(attempt, baseMs = 1500, maxMs = 30000, random = Math.random) {
    const step = Math.max(0, (Number(attempt) || 1) - 1);
    const ceiling = Math.min(baseMs * Math.pow(2, step), maxMs);
    return Math.round(ceiling / 2 + random() * (ceiling / 2));
  }

  // Up to +20% on a computed rate-limit wait; never shortens what Nexus asked for.
  function withJitter(ms, random = Math.random) {
    return Math.round(ms * (1 + 0.2 * random()));
  }

  function rateLimitBackoffSeconds(strike) {
    const step = Math.max(0, (Number(strike) || 1) - 1);
    return Math.min(RATE_LIMIT_BASE_SECONDS * Math.pow(2, step), RATE_LIMIT_MAX_SECONDS);
  }

  // How a collection run treats a file it could not get a link for. A mod that is gone is skipped at
  // once: asking again cannot bring it back. A single Cloudflare answer is skipped too, since it can
  // be one page Cloudflare is fussy about, but the same answer this many times in a row means the
  // whole site is behind a check, and the run stops so it can be completed.
  const QUEUE_UNAVAILABLE_CODES = new Set(['mod_unavailable', 'file_not_found', 'moderation_hold']);
  const CLOUDFLARE_SKIP_LIMIT = 3;
  const MAX_TRACKED_SKIPS = 200;

  function queueSkipReason(code, cloudflareStrikes = 0) {
    const root = String(code || '').split(/[\s(]/, 1)[0];
    if (QUEUE_UNAVAILABLE_CODES.has(root)) return root;
    if (root === 'cloudflare' && Number(cloudflareStrikes) < CLOUDFLARE_SKIP_LIMIT) return root;
    return '';
  }

  // A size in KB as Nexus lists it, or 0 when there is none worth ordering by.
  function queueSizeKb(value) {
    const size = Number(value);
    return Number.isFinite(size) && size > 0 ? size : 0;
  }

  // Smallest first. Files with no known size go last, in the order they came, so an unknown size never
  // lands in front of a small file or scatters through the queue.
  function orderQueueBySize(items, sizeOf) {
    return (Array.isArray(items) ? items : [])
      .map((item, index) => ({ item, index, size: queueSizeKb(sizeOf(item)) }))
      .sort((a, b) => {
        if (!a.size !== !b.size) return a.size ? -1 : 1;
        return (a.size - b.size) || (a.index - b.index);
      })
      .map(({ item }) => item);
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const SENSITIVE_PARAM_NAMES = [
    'key',
    'expires',
    'user_id',
    'token',
    'access_token',
    'refresh_token',
    'auth',
    'authorization',
    'session',
    'session_id',
    'signature',
    'api_key',
    'download_key',
    'code',
    'state',
    'password',
    'cookie',
  ];
  const REDACTED = '[redacted]';
  const SENSITIVE_NAME_GROUP = SENSITIVE_PARAM_NAMES
    .slice()
    .sort((a, b) => b.length - a.length)
    .join('|');

  // "code" and "state" are ordinary words in a log line; as keys the stricter rules still redact them.
  const AMBIGUOUS_PARAM_NAMES = new Set(['code', 'state']);
  const LOOSE_SENSITIVE_NAME_GROUP = SENSITIVE_PARAM_NAMES
    .filter((name) => !AMBIGUOUS_PARAM_NAMES.has(name))
    .sort((a, b) => b.length - a.length)
    .join('|');

  const SENSITIVE_PATTERNS = [
    new RegExp('\\b(' + SENSITIVE_NAME_GROUP + ')(=|%3D)([^&\\s"\'<>]+)', 'gi'),
    new RegExp('(["\'])(' + SENSITIVE_NAME_GROUP + ')\\1(\\s*:\\s*)(["\'])([^"\']*)\\4', 'gi'),
    new RegExp('\\b(' + LOOSE_SENSITIVE_NAME_GROUP + ')(\\s*:\\s*)([^,;}"\'<>\\r\\n]+)', 'gi'),
  ];

  function redactSensitiveValues(value) {
    let text = String(value ?? '');
    if (!text) return text;
    text = text.replace(SENSITIVE_PATTERNS[0], (_m, name, sep) => name + sep + REDACTED);
    text = text.replace(SENSITIVE_PATTERNS[1], (_m, q1, name, sep, q2) => q1 + name + q1 + sep + q2 + REDACTED + q2);
    text = text.replace(SENSITIVE_PATTERNS[2], (_m, name, sep) => name + sep + REDACTED);
    return text;
  }

  const URL_SHAPE = /^[a-z][a-z0-9+.-]*:\/\//i;
  const EXTENSION_ORIGIN_PATTERN = /(?:chrome|moz|safari-web|ms-browser)-extension:\/\/[a-z0-9._-]+\//gi;

  // The game and path of an nxm:// link, without credentials or a port. Read by hand: Chromium before
  // 130 parsed a URL of a scheme it did not know as an opaque path, with an empty hostname.
  const NXM_HOST_AND_PATH = /^nxm:\/\/(?:[^/?#]*@)?([^/?#:]*)(?::[^/?#]*)?([^?#]*)/i;

  function nxmHostAndPath(raw) {
    const parts = NXM_HOST_AND_PATH.exec(raw);
    return parts ? { hostname: normalizeHostname(parts[1]), pathname: parts[2] } : null;
  }

  function sanitizeUrlForReport(url) {
    const raw = String(url ?? '').trim();
    if (!raw) return '';
    if (!URL_SHAPE.test(raw)) return redactSensitiveValues(raw.split(/[?#]/)[0]).slice(0, 160);
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === 'nxm:') {
        const nxm = nxmHostAndPath(raw) || parsed;
        return 'nxm://' + nxm.hostname + nxm.pathname + ' (query removed)';
      }
      const fileId = parsed.searchParams.get('file_id');
      const base = parsed.protocol + '//' + parsed.host + parsed.pathname;
      return base + (fileId && /^\d{1,12}$/.test(fileId) ? '?file_id=' + fileId : '');
    } catch (_) {
      return redactSensitiveValues(raw.split(/[?#]/)[0]).slice(0, 160);
    }
  }

  // Remove credentials and query secrets before diagnostics are shared.
  // Personal data a log line can carry even after URL and key=value redaction: e-mail addresses,
  // home-directory paths (which name the OS user), Nexus profile names, cookies, bearer/JWT tokens
  // and long opaque secrets. Applied to everything that reaches a report.
  const PERSONAL_PATTERNS = [
    [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]'],
    [/\b[A-Z]:\\(?:Users|Documents and Settings)\\[^\\\s"'<>]+/gi, '[home]'],
    [/(?:\/Users|\/home)\/[^/\s"'<>]+/g, '[home]'],
    [/(\/users\/)(?!\d+\b)[A-Za-z0-9_.-]+/g, '$1[user]'],
    [/\b(Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi, '$1: [redacted]'],
    [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[jwt]'],
    [/\b[A-Fa-f0-9]{32,}\b/g, '[token]'],
    [/\b[A-Za-z0-9_-]{40,}\b/g, '[token]']
  ];

  function redactPersonalData(value) {
    let text = String(value ?? '');
    for (const [pattern, replacement] of PERSONAL_PATTERNS) text = text.replace(pattern, replacement);
    return text;
  }

  function sanitizeDiagnosticText(value, maxLength = 1500) {
    let text = String(value ?? '');
    if (!text) return text;
    text = text.replace(EXTENSION_ORIGIN_PATTERN, 'ext://');
    text = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, (match) => sanitizeUrlForReport(match));
    text = redactSensitiveValues(text);
    text = redactPersonalData(text);
    return text.slice(0, maxLength);
  }

  // Used by both manual and automatic reports; send only a redacted Nexus path, without queries.
  function reportPagePath(url) {
    try {
      const parsed = new URL(String(url || ''));
      if (!/(^|\.)nexusmods\.com$/i.test(parsed.hostname)) return '';
      return sanitizeDiagnosticText(parsed.pathname, 200).replace(/[?#].*$/, '');
    } catch (_) {
      return '';
    }
  }

  // Human-readable durations and sizes for the collection deck. Units come from Intl, so every UI
  // language gets its own short forms ("7d 8h", "7 T. 8 Std.") without extra catalogue strings.
  function uiLocale() {
    try {
      if (forceEnglish) return 'en';
      return chrome?.i18n?.getUILanguage?.() || 'en';
    } catch (_) {
      return 'en';
    }
  }

  function formatUnit(value, unit, locale) {
    try {
      return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'narrow', maximumFractionDigits: 0 }).format(value);
    } catch (_) {
      return `${value}${{ day: 'd', hour: 'h', minute: 'm', second: 's' }[unit]}`;
    }
  }

  // Two largest non-zero units: "7d 8h", "3h 12m", "45m", "30s".
  function formatEta(totalSeconds, locale = uiLocale()) {
    let rest = Math.max(0, Math.round(Number(totalSeconds) || 0));
    const parts = [];
    for (const [unit, size] of [['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]]) {
      const amount = Math.floor(rest / size);
      rest -= amount * size;
      if (amount || (parts.length && parts.length < 2)) parts.push([unit, amount]);
      if (parts.length === 2) break;
    }
    if (!parts.length) parts.push(['second', 0]);
    // "45m 0s" reads as noise; drop a trailing zero.
    if (parts.length === 2 && parts[1][1] === 0) parts.pop();
    return parts.map(([unit, amount]) => formatUnit(amount, unit, locale)).join(' ');
  }

  function formatBytes(bytes, locale = uiLocale()) {
    let value = Math.max(0, Number(bytes) || 0);
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
    const digits = index === 0 || value >= 100 ? 0 : 1;
    let number;
    try {
      number = new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
    } catch (_) {
      number = value.toFixed(digits);
    }
    return `${number} ${units[index]}`;
  }

  // Remaining-time estimate for a collection queue. The old figure divided all bytes by all
  // transfer time; with smallest-first ordering the first files are tiny and latency-bound, so the
  // measured "speed" was a fraction of the real one and the estimate ran to years. Here each file
  // costs a fixed latency (measured on small files) plus bytes over a throughput measured only on
  // files large enough to show it, both smoothed (EMA). Until such a file has finished, the
  // configured download speed stands in. Samples across pauses or rate-limit waits are discarded.
  const ETA_LARGE_BYTES = 1024 * 1024;
  function createQueueEta(sizesKb, { fallbackMBps = 3.2, now = () => Date.now(), alpha = 0.25 } = {}) {
    const sizes = (Array.isArray(sizesKb) ? sizesKb : []).map((value) => (Number(value) > 0 ? Number(value) * 1024 : 0));
    const known = sizes.filter((value) => value > 0);
    const averageBytes = known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : 0;
    const sizeOf = (index) => (sizes[index] > 0 ? sizes[index] : averageBytes);
    const ema = (previous, sample) => (previous === null ? sample : previous + alpha * (sample - previous));

    let latency = null;
    let rate = null;
    let gap = null;
    let startedAt = null;
    let completedAt = null;
    let spoiled = false;
    let samples = 0;

    return {
      itemStarted() {
        const at = now();
        if (completedAt !== null && !spoiled) gap = ema(gap, (at - completedAt) / 1000);
        startedAt = at;
        completedAt = null;
        spoiled = false;
      },
      itemCompleted(index) {
        const at = now();
        if (startedAt !== null && !spoiled) {
          const seconds = Math.max(0.001, (at - startedAt) / 1000);
          const size = sizeOf(index);
          if (size >= ETA_LARGE_BYTES) {
            const transfer = Math.max(seconds - (latency || 0), seconds * 0.25);
            rate = ema(rate, size / transfer);
          } else {
            latency = ema(latency, seconds);
          }
          samples += 1;
        }
        startedAt = null;
        completedAt = at;
      },
      spoil() {
        spoiled = true;
      },
      // Zero means there is nothing honest to say yet.
      remainingSeconds(index, total) {
        if (!samples || !known.length) return 0;
        const throughput = rate || Math.max(0.1, Number(fallbackMBps) || 3.2) * 1024 * 1024;
        let seconds = 0;
        for (let cursor = Math.max(0, index); cursor < total; cursor += 1) {
          const size = sizeOf(cursor);
          seconds += (latency || 0) + (size >= ETA_LARGE_BYTES || latency === null ? size / throughput : 0) + (gap || 0);
        }
        return seconds;
      },
      get state() {
        return { latency, rate, gap, samples };
      }
    };
  }

  // Page settings deep link: any Nexus page with this hash opens the in-page settings once it loads.
  const PAGE_SETTINGS_HASH = '#nxtk-settings';
  function isNexusPageUrl(value) {
    try {
      const url = new URL(String(value || ''));
      const host = url.hostname.toLowerCase();
      // The content scripts run on www.nexusmods.com only (manifest content_scripts.matches).
      return url.protocol === 'https:' && host === 'www.nexusmods.com';
    } catch (_) {
      return false;
    }
  }
  function pageSettingsUrl(value) {
    const base = isNexusPageUrl(value) ? new URL(String(value)) : new URL('https://www.nexusmods.com/');
    base.hash = PAGE_SETTINGS_HASH;
    return base.href;
  }

  // Bug-report relay (relay/ in the repository). The extension holds no secret: the relay owns the
  // Discord webhook. Its origin is an optional host permission, asked for the first time a report is
  // sent, so installing this version adds no permission warning. Change RELAY_ORIGIN together with
  // optional_host_permissions in manifest.json when the Worker is deployed elsewhere.
  const RELAY_ORIGIN = 'https://nexusmods-bypass-relay.mariosthanos3.workers.dev';
  // The deployed Worker is configured and has passed the live health and report-delivery checks.
  // Builds can override this with NXTK_RELAY_CONFIGURED=1/0 (tools/build-zip.mjs). While false,
  // Send shows as unavailable and the report page offers the GitHub issue route instead.
  const RELAY_CONFIGURED = true;
  const RELAY_REPORT_URL = `${RELAY_ORIGIN}/v1/report`;
  const RELAY_HEALTH_URL = `${RELAY_ORIGIN}/v1/health`;
  const RELAY_PERMISSION = Object.freeze({ origins: [`${RELAY_ORIGIN}/*`] });
  const REPORT_SCHEMA_VERSION = 1;
  const MAX_REPORT_BYTES = 60 * 1024;

  // Opt-in debug log: when "Debug logs" is on, every Logger line also goes to a ring buffer kept by
  // the background worker (DEBUG_LOG_KEY), so a report can include what led up to a problem across
  // page loads. Off by default; nothing is kept while it is off.
  const DEBUG_LOG_KEY = 'nxtk_debug_log';
  const MAX_DEBUG_ENTRIES = 400;
  let debugPersist = false;
  let debugPending = [];
  let debugFlushTimer = null;

  function setDebugLogging(enabled) {
    debugPersist = !!enabled;
    if (!debugPersist) debugPending = [];
  }

  function debugPageType() {
    try {
      const path = typeof location !== 'undefined' ? location.pathname || '' : '';
      if (/\/collections\//.test(path)) return 'collection';
      if (/\/mods\/\d+/.test(path)) return /file_id=/.test(location.search) ? 'mod-file' : 'mod';
      if (typeof location !== 'undefined' && /^(chrome|moz)-extension:/.test(location.protocol)) return 'extension';
      return path ? 'other' : 'worker';
    } catch (_) {
      return 'unknown';
    }
  }

  function flushDebugLog() {
    clearTimeout(debugFlushTimer);
    debugFlushTimer = null;
    const entries = debugPending;
    debugPending = [];
    try {
      if (!chrome?.runtime?.id || !entries.length) return;
      chrome.runtime.sendMessage({ type: 'DEBUG_LOG_APPEND', payload: { entries } }, () => void chrome.runtime.lastError);
    } catch (_) {
    }
  }

  // Lines worth not losing to a tab that closes or navigates inside the 2 s batching window.
  const DEBUG_FLUSH_NOW_PATTERN = /^Vortex hand-off/;

  function queueDebugEntry(level, text) {
    if (!debugPersist || !text) return;
    debugPending.push({ at: Date.now(), level: String(level || 'info'), page: debugPageType(), text });
    if (debugPending.length > 100) debugPending.splice(0, debugPending.length - 100);
    if (level === 'error' || DEBUG_FLUSH_NOW_PATTERN.test(text)) return flushDebugLog();
    if (debugFlushTimer) return;
    debugFlushTimer = setTimeout(flushDebugLog, 2000);
  }

  // A closing tab (auto-close after a Vortex send) must not drop the batch.
  try {
    globalThis.addEventListener?.('pagehide', flushDebugLog);
    globalThis.document?.addEventListener?.('visibilitychange', () => {
      if (globalThis.document.visibilityState === 'hidden') flushDebugLog();
    });
  } catch (_) {
  }

  const DOWNLOAD_METHOD_VORTEX = 0;
  const MAX_DOWNLOAD_URL_CHARS = 2048;
  const NEXUS_SITE_HOSTS = ['nexusmods.com'];
  const NEXUS_FILE_HOSTS = ['nexusmods.com', 'nexus-cdn.com'];

  function normalizeHostname(hostname) {
    const host = String(hostname || '').toLowerCase();
    return host.endsWith('.') ? host.slice(0, -1) : host;
  }

  function hostMatches(hostname, apexList) {
    const host = normalizeHostname(hostname);
    return apexList.some((apex) => host === apex || host.endsWith('.' + apex));
  }

  function validateDownloadTarget(url, { method = DOWNLOAD_METHOD_VORTEX } = {}) {
    const raw = String(url ?? '').trim();
    if (!raw) return { ok: false, detail: 'empty' };
    if (raw.length > MAX_DOWNLOAD_URL_CHARS) return { ok: false, detail: 'too-long' };

    let parsed;
    try {
      parsed = new URL(raw);
    } catch (_) {
      return { ok: false, detail: 'not-a-url' };
    }

    if (parsed.username || parsed.password) return { ok: false, detail: 'embedded-credentials' };

    if (method === DOWNLOAD_METHOD_VORTEX) {
      if (parsed.protocol !== 'nxm:') return { ok: false, detail: 'bad-protocol:' + parsed.protocol.replace(':', '') };
      const missing = ['key', 'expires', 'user_id'].filter((name) => !parsed.searchParams.get(name));
      if (missing.length) return { ok: false, detail: 'missing-nxm-params:' + missing.join(',') };
      return { ok: true, url: raw, hostname: normalizeHostname((nxmHostAndPath(raw) || parsed).hostname) };
    }

    if (parsed.protocol !== 'https:') return { ok: false, detail: 'bad-protocol:' + parsed.protocol.replace(':', '') };
    if (!hostMatches(parsed.hostname, NEXUS_FILE_HOSTS)) {
      return { ok: false, detail: 'host-not-allowed:' + normalizeHostname(parsed.hostname) };
    }
    return { ok: true, url: raw, hostname: normalizeHostname(parsed.hostname) };
  }

  function isSafeNexusPageUrl(url) {
    const raw = String(url ?? '').trim();
    if (!raw || raw.length > MAX_DOWNLOAD_URL_CHARS) return false;
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'https:') return false;
      if (parsed.username || parsed.password) return false;
      return hostMatches(parsed.hostname, NEXUS_SITE_HOSTS);
    } catch (_) {
      return false;
    }
  }

  const TRIGGER_LABELS = {
    manual: 'manual (you clicked a download button)',
    automatic: 'automatic (started by the extension)',
    collection: 'collection run (queued by the download deck)',
    fallback: 'Cloudflare fallback (handed back to the native Nexus button)',
    popup: 'popup action'
  };

  const METHOD_LABELS = {
    vortex: 'Vortex handoff (nxm:)',
    browser: 'browser download',
    native: 'native Nexus control'
  };

  let activity = {};

  const MAX_TRAIL_ENTRIES = 8;
  const MAX_TRAIL_CHARS = 90;
  const activityTrail = [];

  function trailText(args) {
    const parts = (Array.isArray(args) ? args : [args]).map((value) => {
      if (typeof value === 'string') return value;
      if (value instanceof Error) return value.message;
      if (value && typeof value === 'object') return String(value.code || value.message || '');
      return String(value ?? '');
    });
    return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  // The console setting never reaches the person reading a report; this does.
  function noteActivity(level, args) {
    const text = sanitizeDiagnosticText(trailText(args), MAX_TRAIL_CHARS);
    if (!text) return;
    queueDebugEntry(level, text);
    activityTrail.push({ at: Date.now(), level: String(level || 'info'), text });
    while (activityTrail.length > MAX_TRAIL_ENTRIES) activityTrail.shift();
  }

  function describeActivityTrail() {
    if (!activityTrail.length) return [];
    const lines = ['──────── Leading up to it ────────'];
    for (const entry of activityTrail) {
      const time = new Date(entry.at).toLocaleTimeString('en-GB');
      lines.push(`${time} ${entry.level.padEnd(5)} ${entry.text}`);
    }
    return lines;
  }

  function setActivity(patch) {
    if (!patch || typeof patch !== 'object') return;
    activity = { ...activity, ...patch, at: Date.now() };
  }

  function describeActivity(source = activity) {
    if (!source || !source.trigger) return '';
    const parts = [TRIGGER_LABELS[source.trigger] || String(source.trigger)];
    if (source.method) parts.push(METHOD_LABELS[source.method] || String(source.method));
    if (source.fileId) parts.push('file ' + String(source.fileId).slice(0, 12));
    if (source.attempt) parts.push('attempt ' + source.attempt);
    // Closing the tab is only ever a Vortex step, so reporting its state next to a browser
    // download reads as a setting being off when the setting does not apply at all.
    if (source.method === 'vortex') {
      if (source.autoClose === true) parts.push('tab auto-close armed');
      if (source.autoClose === false) parts.push('tab auto-close off');
    }
    if (source.fallbackActive) parts.push('after a Cloudflare fallback');
    return parts.join(' · ');
  }

  // One shape for every log entry, whichever context writes it, with every free-text field redacted.
  function buildErrorEntry(error, fallbackCode = 'request_failed') {
    return {
      at: Date.now(),
      code: String(error?.code || fallbackCode),
      status: Number.isInteger(error?.status) ? error.status : null,
      context: sanitizeDiagnosticText(error?.context, 300),
      action: sanitizeDiagnosticText(error?.action, 200),
      userMessage: String(error?.userMessage || ''),
      technicalMessage: sanitizeDiagnosticText(error?.technicalMessage, 600),
      stack: sanitizeDiagnosticText(error?.stack, 1500),
      url: sanitizeUrlForReport(error?.url)
    };
  }

  function recordError(error) {
    const entry = buildErrorEntry({
      ...error,
      action: describeActivity(),
      url: typeof location !== 'undefined' && location?.href ? location.href : ''
    });
    try {
      if (!chrome?.runtime?.id) return;
      chrome.runtime.sendMessage({ type: 'ERROR_LOG_APPEND', payload: { entry } }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_) {
    }
  }

  function readTotalDownloads() {
    return new Promise((resolve) => {
      try {
        if (!chrome?.runtime?.id) {
          resolve(null);
          return;
        }
        chrome.storage.local.get(TOTAL_DOWNLOADS_KEY, (result) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          const value = Number(result?.[TOTAL_DOWNLOADS_KEY]);
          resolve(Number.isFinite(value) ? value : 0);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  function bumpTotalDownloads() {
    try {
      if (!chrome?.runtime?.id) return;
      chrome.runtime.sendMessage({ type: 'TOTAL_DOWNLOADS_INCREMENT', payload: {} }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_) { }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
    }
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const copied = document.execCommand('copy');
      textarea.remove();
      return copied;
    } catch (_) {
      return false;
    }
  }

  let forceEnglish = false;

  function setForceEnglish(value) {
    forceEnglish = !!value;
  }

  try {
    if (chrome?.runtime?.id) {
      chrome.storage.local.get(SETTINGS_KEY, (result) => {
        if (chrome.runtime.lastError) return;
        const stored = result?.[SETTINGS_KEY];
        if (stored && 'ForceEnglish' in stored) setForceEnglish(stored.ForceEnglish);
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes?.[SETTINGS_KEY]) return;
        const next = changes[SETTINGS_KEY].newValue;
        setForceEnglish(next ? next.ForceEnglish : DEFAULTS.ForceEnglish);
      });
    }
  } catch (_) {
  }

  function t(key, substitutions = null, fallback = '') {
    if (forceEnglish) return fallback;
    try {
      const message = chrome.i18n.getMessage(key, substitutions || undefined);
      if (message) return message;
    } catch (_) {
    }
    return fallback;
  }

  function tPlural(baseKey, count, fallback = '', substitutions = null) {
    const n = Number(count) || 0;
    const args = substitutions || [String(n)];
    let category = 'other';
    try {
      const locale = chrome.i18n.getUILanguage ? chrome.i18n.getUILanguage() : 'en';
      category = new Intl.PluralRules(locale).select(n);
    } catch (_) {
      category = 'other';
    }
    return t(`${baseKey}_${category}`, args, '')
      || t(`${baseKey}_other`, args, '')
      || fallback;
  }

  const I18N_ATTRIBUTES = [
    ['[data-i18n-title]', 'i18nTitle', 'title'],
    ['[data-i18n-aria-label]', 'i18nAriaLabel', 'aria-label'],
    ['[data-i18n-placeholder]', 'i18nPlaceholder', 'placeholder']
  ];

  const bakedText = new WeakMap();
  const bakedAttrs = new WeakMap();

  function applyI18nTo(root = document) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    try {
      root.querySelectorAll('[data-i18n]').forEach((el) => {
        if (!bakedText.has(el)) bakedText.set(el, el.textContent);
        if (forceEnglish) {
          el.textContent = bakedText.get(el);
          return;
        }
        const message = t(el.dataset.i18n);
        if (message) el.textContent = message;
      });
      for (const [selector, datasetKey, attribute] of I18N_ATTRIBUTES) {
        root.querySelectorAll(selector).forEach((el) => {
          let saved = bakedAttrs.get(el);
          if (!saved) bakedAttrs.set(el, (saved = {}));
          if (!(attribute in saved)) saved[attribute] = el.getAttribute(attribute);
          if (forceEnglish) {
            if (saved[attribute] != null) el.setAttribute(attribute, saved[attribute]);
            return;
          }
          const message = t(el.dataset[datasetKey]);
          if (message) el.setAttribute(attribute, message);
        });
      }
    } catch (_) {
    }
  }

  globalThis.NXTK = {
    SETTINGS_KEY,
    ERROR_LOG_KEY,
    MAX_LOGGED_ERRORS,
    TOTAL_DOWNLOADS_KEY,
    RATING_PROMPT_KEY,
    GITHUB_REPO_URL,
    ISSUE_NEW_URL,
    REPORT_ISSUE_URL,
    TROUBLESHOOTING_URL,
    getStoreReviewUrl,
    getStoreListing,
    dueRatingMilestone,
    ratingMilestoneDue,
    markRatingAsked,
    markRatingSettled,
    RATING_MILESTONES,
    prepareRatingPrompt,
    recordFinishedRun,
    readRunsFinished,
    runPromptDue,
    snoozeRatingPrompt,
    markRunPromptAnswered,
    RATING_RUN_THRESHOLD,
    ratingStarsMarkup,
    DEFAULTS,
    normalizeSetting,
    ARCHIVE_FILE_EXTENSIONS,
    DOWNLOAD_FILE_EXTENSIONS,
    RATE_LIMIT_MAX_SECONDS,
    RATE_LIMIT_MAX_STRIKES,
    parseRetryAfterSeconds,
    rateLimitBackoffSeconds,
    retryDelayMs,
    withJitter,
    setSafeHtml,
    classifyDownloadInterrupt,
    MIN_HANDOFF_GAP_SECONDS,
    SETTING_PRESETS,
    applyPreset,
    matchingPreset,
    ADVANCED_SETTING_KEYS,
    errorActionsFor,
    formatCountdown,
    VORTEX_OPEN_KEY,
    vortexOpenNext,
    shouldAskVortexOpened,
    shouldOfferBrowserSwitch,
    VORTEX_INSTALL_GUIDE_URL,
    readVortexOpenState,
    recordVortexOpenEvent,
    VORTEX_TEST_LINK,
    formatRunSummaryText,
    summarizeCollectionHistory,
    VORTEX_SENT_PREFIX,
    vortexSentType,
    NXM_EXPIRY_MARGIN_MS,
    nxmLinkInfo,
    isNxmLinkExpired,
    isNexusUserMismatch,
    waitForProtocolHandoff,
    CLOUDFLARE_SKIP_LIMIT,
    MAX_TRACKED_SKIPS,
    queueSkipReason,
    queueSizeKb,
    orderQueueBySize,
    escapeHtml,
    sanitizeUrlForReport,
    sanitizeDiagnosticText,
    reportPagePath,
    formatEta,
    uiLocale,
    PAGE_SETTINGS_HASH,
    isNexusPageUrl,
    pageSettingsUrl,
    formatBytes,
    createQueueEta,
    redactPersonalData,
    RELAY_ORIGIN,
    RELAY_CONFIGURED,
    RELAY_HEALTH_URL,
    RELAY_REPORT_URL,
    RELAY_PERMISSION,
    REPORT_SCHEMA_VERSION,
    MAX_REPORT_BYTES,
    DEBUG_LOG_KEY,
    MAX_DEBUG_ENTRIES,
    setDebugLogging,
    validateDownloadTarget,
    isSafeNexusPageUrl,
    buildErrorEntry,
    recordError,
    setActivity,
    noteActivity,
    flushDebugLog,
    PROTOCOL_BLUR_OPENED_MS,
    describeActivity,
    describeActivityTrail,
    bumpTotalDownloads,
    readTotalDownloads,
    copyText,
    t,
    tPlural,
    setForceEnglish,
    applyI18nTo
  };
})();
