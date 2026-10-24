window.NexusExt = window.NexusExt || {};

(function () {
  'use strict';

  const DOWNLOAD_METHOD_VORTEX = 0;
  const VORTEX_CONFIRM_TIMEOUT_MS = 4000;

  // The Nexus member id of the signed-in user, when the page shows it (data attributes or a link to
  // the member's own profile by id). Null when unknown.
  function pageNexusUserId(root) {
    const tagged = root?.querySelector?.('[data-user-id], [data-member-id]');
    const fromData = tagged?.getAttribute('data-user-id') || tagged?.getAttribute('data-member-id');
    if (/^\d+$/.test(fromData || '')) return fromData;
    const link = root?.querySelector?.('a[href*="/users/"][href*="nexusmods.com"], a[href^="/users/"]');
    const match = /\/users\/(\d+)(?:[/?#]|$)/.exec(link?.getAttribute('href') || '');
    return match ? match[1] : null;
  }
  const DOWNLOAD_METHOD_BROWSER = 1;

  const STATUS_DOWNLOADING = 0;
  const STATUS_PAUSED = 1;
  const STATUS_FINISHED = 2;
  const STATUS_STOPPED = 3;

  const STATUS_TEXT = {
    [STATUS_DOWNLOADING]: 'Downloading...',
    [STATUS_PAUSED]: 'Paused',
    [STATUS_FINISHED]: 'Finished',
    [STATUS_STOPPED]: 'Stopped'
  };
  const Errors = NexusExt.Errors;
  const Auth = NexusExt.Auth;

  function makeBackgroundStartId() {
    try {
      if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
    } catch (_) { }
    return `start-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
  }

  const convertSize = (sizeInKB) => {
    const sizeInMB = sizeInKB / 1024;
    const sizeInGB = sizeInMB / 1024;
    return sizeInGB >= 1 ? `${sizeInGB.toFixed(2)} GB` : `${sizeInMB.toFixed(2)} MB`;
  };

  const formatDuration = (totalSeconds) => {
    const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
    if (seconds < 60) return `${seconds}s`;
    const pad = (value) => String(value).padStart(2, '0');
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return hours
      ? `${hours}:${pad(minutes)}:${pad(secs)}`
      : `${minutes}:${pad(secs)}`;
  };

  // The estimate lives in shared.js (NXTK.createQueueEta) so it can be tested offline.


  const escapeHtml = NXTK.escapeHtml;
  const T = (key, fallback) => NXTK.t(key, null, fallback);
  const TS = (key, subs, fallback) => NXTK.t(key, subs.map(String), fallback);
  const historyEntryId = (mod) => mod.historyId || mod.fileId || mod.file?.fileId;

  const DEFAULT_DOWNLOAD_SPEED = 3.2;
  const MAX_PAUSE_SECONDS = 10 * 60;

  const MAX_QUEUE_POLL_FAILURES = 5;

  // The worker reports a failure as a code with its measurements attached. A code that has a
  // sentence of its own is shown as that sentence; anything else is left as it came, so nothing
  // is lost. Either way the numbers are in the report.
  function queueErrorText(value) {
    const raw = String(value || '');
    const code = raw.split(' ')[0].trim();
    const known = code && Errors.normalize({ code }).code === code;
    return known
      ? Errors.toLogMessage({ code })
      : (raw || Errors.displayText({ code: 'request_failed' }).message);
  }

  // GraphQL answers a query that names a field it no longer has with a validation error, not a
  // missing field. That is Nexus changing its API, and it is named as such so a report points at it.
  const GRAPHQL_SCHEMA_ERROR = /cannot query field|unknown argument|unknown type|must have a selection|is not defined by type|cannot return null for non-nullable/i;
  // A collection Nexus is reviewing, has hidden or removed, or cannot find: the page says so, and no
  // retry or extension update changes it. It came in as "Unexpected response from Nexus".
  const GRAPHQL_COLLECTION_UNAVAILABLE = /being moderated|under moderation|awaiting moderation|\bnot found\b|does not exist|has been (?:hidden|removed|deleted)|is (?:hidden|unpublished|not published)/i;

  function graphqlFault(json, context) {
    const errors = Array.isArray(json?.errors) ? json.errors : [];
    const messages = errors.map((entry) => String(entry?.message || '').trim()).filter(Boolean);
    if (!messages.length) return null;
    const technicalMessage = `GraphQL: ${messages.slice(0, 3).join(' | ')}`.slice(0, 500);
    const code = messages.some((message) => GRAPHQL_SCHEMA_ERROR.test(message)) ? 'nexus_api_changed'
      : messages.some((message) => GRAPHQL_COLLECTION_UNAVAILABLE.test(message)) ? 'collection_unavailable'
        : 'invalid_response';
    return Errors.create(code, { context, technicalMessage });
  }

  // Why a file was skipped, as a short reason: it sits in brackets after the name, and the advice that
  // goes with an error is no use for a mod that is simply gone. 'cloudflare' reads as the check.
  function skipReasonText(reason) {
    if (reason === 'cloudflare') return T('logSkipReasonCloudflare', 'Cloudflare check on this page');
    const code = String(reason || 'mod_unavailable').split(' ')[0];
    return Errors.displayText?.({ code }).message || queueErrorText(code);
  }

  // How a background run can end, in the terms the deck has wording for.
  const DECK_OUTCOMES = new Set(['finished', 'partial', 'stopped', 'requires_login', 'blocked', 'error']);

  const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  class NDC {
    constructor(gameId, collectionId, revision = null) {
      this.gameId = gameId;
      this.collectionId = collectionId;
      this.revision = revision;

      this.mods = { all: [], mandatory: [], optional: [] };
      this.pauseBetweenDownload = 5;
      this.downloadSpeed = DEFAULT_DOWNLOAD_SPEED;
      this.downloadMethod = DOWNLOAD_METHOD_VORTEX;
      this.requestTimeout = Errors.DEFAULT_TIMEOUT_MS;
      this.showAlertsOnError = true;
      this.downloadFolder = '';
      this.lastError = null;
      this.disposed = false;
      this.initialized = false;
      this.lifecycleController = typeof AbortController === 'function' ? new AbortController() : null;
      this.downloadController = null;
      this.backgroundJobId = null;
      this.backgroundStartId = null;
      this.settleBrowserQueue = null;
      this.claimTimer = null;
      this.onSettingsChanged = null;
      this.running = false;
      this.external = false;
      this.landedIn = '';
      this.wabbajackImport = false;
      this.rateLimitStrikes = 0;
      this.rateLimitedUntil = 0;
      this.vortexRunProgress = null;

      this.runStatus = STATUS_DOWNLOADING;

      this.ui = null;
    }

    get lifecycleSignal() {
      return this.lifecycleController?.signal || null;
    }

    get downloadSignal() {
      return this.downloadController?.signal || null;
    }

    stopDownload() {
      this.running = false;
      this.runStatus = STATUS_STOPPED;
      this.stopBackgroundQueue();
      try {
        this.downloadController?.abort();
      } catch (_) { }
      this.downloadController = null;
    }

    queueTarget() {
      return {
        jobId: this.backgroundJobId || null,
        startId: this.backgroundStartId || null,
        gameId: this.gameId,
        collectionId: this.collectionId
      };
    }

    stopBackgroundQueue() {
      // Only a browser-mode run has a worker job behind it.
      if (this.downloadMethod !== DOWNLOAD_METHOD_BROWSER) {
        this.settleBrowserQueue?.('stopped');
        return;
      }
      Promise.resolve(NexusExt.Storage.sendDownloadCommand('NDC_QUEUE_STOP', this.queueTarget()))
        .then((reply) => {
          if (!reply?.ok || reply.value?.pending) this.settleBrowserQueue?.('stopped');
        })
        .catch(() => this.settleBrowserQueue?.('stopped'));
    }

    setPaused(paused) {
      if (this.downloadMethod !== DOWNLOAD_METHOD_BROWSER) return;
      NexusExt.Storage.sendDownloadCommand(
        paused ? 'NDC_QUEUE_PAUSE' : 'NDC_QUEUE_RESUME',
        this.queueTarget()
      ).catch?.(() => undefined);
    }

    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      this.running = false;
      this.runStatus = STATUS_STOPPED;
      if (this.onSettingsChanged) {
        try {
          chrome.storage.onChanged.removeListener(this.onSettingsChanged);
        } catch (_) { }
        this.onSettingsChanged = null;
      }
      this.releaseRunClaim();
      this.settleBrowserQueue?.('stopped');
      for (const controller of [this.downloadController, this.lifecycleController]) {
        try {
          controller?.abort();
        } catch (_) { }
      }
      this.downloadController = null;
    }

    // Renew the worker claim to prevent duplicate collection runs across tabs.
    async acquireRunClaim() {
      const reply = await NexusExt.Storage.sendDownloadCommand('NDC_RUN_CLAIM', {
        gameId: this.gameId,
        collectionId: this.collectionId,
        method: this.claimMethod()
      });
      if (!reply?.ok) return { granted: true };
      if (!reply.value?.granted) return { granted: false, reason: reply.value?.reason || 'lease' };

      clearInterval(this.claimTimer);
      this.claimTimer = setInterval(() => {
        NexusExt.Storage.sendDownloadCommand('NDC_RUN_CLAIM', {
          gameId: this.gameId,
          collectionId: this.collectionId,
          method: this.claimMethod()
        }).catch?.(() => undefined);
      }, 15000);
      return { granted: true };
    }

    claimMethod() {
      return this.downloadMethod === DOWNLOAD_METHOD_BROWSER ? 'browser' : 'vortex';
    }

    releaseRunClaim() {
      clearInterval(this.claimTimer);
      this.claimTimer = null;
      NexusExt.Storage.sendDownloadCommand('NDC_RUN_RELEASE', {
        gameId: this.gameId,
        collectionId: this.collectionId
      }).catch?.(() => undefined);
    }

    isStopped() {
      return this.disposed || this.runStatus === STATUS_STOPPED;
    }

    resolveDownloadSpeed() {
      const manual = Number(this.downloadSpeed);
      const isCustom = Number.isFinite(manual) && manual > 0
        && Math.abs(manual - DEFAULT_DOWNLOAD_SPEED) > 0.001;
      return isCustom
        ? { speed: manual, source: T('speedSourceCustom', 'your setting') }
        : { speed: DEFAULT_DOWNLOAD_SPEED, source: T('speedSourceDefault', 'default') };
    }

    // The settings a run reads. The download method is left to the caller: a collection uses the
    // saved one, and a modlist always downloads through the browser.
    loadRunSettings(settings) {
      this.pauseBetweenDownload = settings.NDC_pauseBetweenDownload;
      this.downloadSpeed = settings.NDC_downloadSpeed;
      this.requestTimeout = settings.RequestTimeout || Errors.DEFAULT_TIMEOUT_MS;
      this.showAlertsOnError = settings.ShowAlertsOnError !== false;
      this.downloadFolder = settings.DownloadFolder ?? '';
      this.wabbajackImport = settings.WabbajackImport === true;
      this.smallestFirst = settings.NDC_smallestFirst !== false;
      this.useOfficialApi = settings.UseOfficialApi !== false && !!NexusExt.NexusApi;
      this.followUpdatePolicy = settings.FollowUpdatePolicy === true;
      this.showModActions = settings.ShowModActions !== false;
    }

    api() {
      return this.useOfficialApi ? NexusExt.NexusApi?.shared?.() || null : null;
    }

    async init() {
      const settings = await NexusExt.Storage.getSettings();
      this.loadRunSettings(settings);
      this.downloadMethod = settings.NDC_downloadMethod;

      this.watchSettings();

      const response = await this.fetchMods();
      if (!response) return false;

      this.loadedRevision = {
        number: Number(response.revisionNumber) || Number(this.revision) || null,
        latest: response.latest ?? null
      };
      const mods = response.modFiles.sort((a, b) => nameCollator.compare(a.file.mod.name, b.file.mod.name));
      this.mods = {
        all: mods,
        mandatory: mods.filter(m => !m.optional),
        optional: mods.filter(m => m.optional)
      };
      this.initialized = true;
      return true;
    }

    watchSettings() {
      if (this.onSettingsChanged) return;
      this.onSettingsChanged = (changes, area) => {
        if (area !== 'local' || !changes?.[NXTK.SETTINGS_KEY]) return;
        this.applySettings(changes[NXTK.SETTINGS_KEY].newValue);
      };
      try {
        chrome.storage.onChanged.addListener(this.onSettingsChanged);
      } catch (_) {
        this.onSettingsChanged = null;
      }
    }

    applySettings(settings) {
      if (!settings || typeof settings !== 'object') return;
      const next = { ...(NexusExt.Storage?.DEFAULTS || {}), ...settings };
      this.loadRunSettings(next);
      NXTK.setForceEnglish(next.ForceEnglish);
    }

    async initFromMods(mods) {
      const settings = await NexusExt.Storage.getSettings();
      this.loadRunSettings(settings);
      // An imported modlist must reach the disk, so the saved collection method is not used.
      this.downloadMethod = DOWNLOAD_METHOD_BROWSER;

      this.watchSettings();

      const sorted = [...mods].sort((a, b) => nameCollator.compare(a.file.mod.name, b.file.mod.name));
      this.mods = { all: sorted, mandatory: [...sorted], optional: [] };
      this.external = true;
      this.initialized = true;
      return true;
    }

    async fetchMods(collectionId = this.collectionId, revision = this.revision) {
      const api = this.api();
      const response = api
        ? await api.collectionRevisionMods({
          slug: collectionId,
          revision: Number.isInteger(revision) ? revision : (parseInt(revision, 10) || null),
          signal: this.lifecycleSignal,
          timeoutMs: this.requestTimeout
        })
        : await this.fetchModsLegacy(collectionId, revision);
      return this.readRevisionMods(response);
    }

    fetchModsLegacy(collectionId, revision) {
      return Errors.request(NexusExt.NexusApi?.ROUTER_URL || 'https://api-router.nexusmods.com/graphql', {
        headers: { 'content-type': 'application/json' },
        referrer: document.location.href,
        referrerPolicy: 'strict-origin-when-cross-origin',
        body: JSON.stringify({
          query: NexusExt.NexusApi?.QUERIES?.CollectionRevisionModsLegacy || 'query CollectionRevisionMods ($revision: Int, $slug: String!, $viewAdultContent: Boolean) { collectionRevision (revision: $revision, slug: $slug, viewAdultContent: $viewAdultContent) { externalResources { id, name, resourceType, resourceUrl }, modFiles { fileId, optional, file { fileId, name, uri, size, version, date, mod { adult, modId, name, version, game { domainName, id } } } } } }',
          variables: { slug: collectionId, viewAdultContent: true, revision: revision },
          operationName: 'CollectionRevisionMods'
        }),
        method: 'POST',
        mode: 'cors',
        credentials: 'include'
      }, {
        timeoutMs: this.requestTimeout,
        context: 'Loading collection details',
        signal: this.lifecycleSignal
      });
    }

    readRevisionMods(response) {
      if (!response?.ok) {
        this.lastError = response?.error || Errors.create('request_failed', { context: 'Loading collection details' });
        return null;
      }

      let json;
      try {
        json = JSON.parse(response.text);
      } catch (cause) {
        this.lastError = Errors.create('invalid_response', {
          context: 'Reading collection details',
          technicalMessage: String(cause?.message || '')
        });
        return null;
      }

      if (!json?.data?.collectionRevision || !Array.isArray(json.data.collectionRevision.modFiles)) {
        this.lastError = graphqlFault(json, 'Loading collection details')
          || Errors.classifyContent(response.text, { context: 'Loading collection details' })
          || Errors.create('invalid_response', {
            context: 'Loading collection details',
            technicalMessage: 'no collectionRevision.modFiles in the answer'
          });
        return null;
      }

      json.data.collectionRevision.modFiles = json.data.collectionRevision.modFiles
        .filter((modFile) => (
          modFile?.file?.fileId
          && modFile.file.mod?.modId
          && modFile.file.mod.game?.domainName
        ))
        .map(modFile => {
          modFile.file.url = `https://www.nexusmods.com/${modFile.file.mod.game.domainName}/mods/${modFile.file.mod.modId}?tab=files&file_id=${modFile.file.fileId}`;
          return modFile;
        });

      this.lastError = null;
      return json.data.collectionRevision;
    }

    // Only a Vortex run resolves links in the page; a browser run hands its whole queue to the worker.
    // The file page is loaded as a click loads it: asked with X-Requested-With, Nexus answers with the
    // tab fragment, which has no nxm link, and getDownloadUrl below reuses this answer for its page step.
    // Nothing here is recorded: the run retries a file and waits out a lost connection, and every
    // attempt was reported on its own (mostly from tabs in the background) even when the file then
    // went through. The run records how a file ends (recordFileFailure).
    async fetchDownloadLink(mod) {
      const pageResponse = await Errors.request(this.fileLinkFor(mod), {
        credentials: 'include'
      }, {
        timeoutMs: this.requestTimeout,
        context: 'Loading Vortex download link',
        signal: this.downloadSignal,
        record: false
      });
      const text = pageResponse.text;
      const pageLoginError = Auth?.getResponseLoginError?.(pageResponse, 'Loading collection download link');
      if (pageLoginError) return { downloadUrl: '', text, rateLimit: pageResponse.rateLimit, error: pageLoginError };
      if (!pageResponse.ok) return { downloadUrl: '', text, rateLimit: pageResponse.rateLimit, error: pageResponse.error };

      const fileId = mod.fileId || mod.file.fileId;
      const extracted = NexusExt.NNW?.parseDownloadURLFromResponse?.(text, { mode: 'vortex', fileId });
      let downloadUrl = NexusExt.NNW?.parseNxmDownloadLink?.(extracted?.url, fileId)
        || NexusExt.NNW?.parseNxmDownloadLink?.(text, fileId)
        || '';

      if (!downloadUrl && NexusExt.NNW?.getDownloadUrl) {
        const resolved = await NexusExt.NNW.getDownloadUrl({
          fileId,
          gameId: mod.file.mod.game.id,
          isNMM: true,
          href: this.fileLinkFor(mod),
          prefetchedText: text,
          prefetchedFinalUrl: pageResponse.finalUrl,
          prefetchedStatus: pageResponse.status,
          signal: this.downloadSignal,
          record: false
        });
        downloadUrl = resolved?.url || '';
        if (!downloadUrl && resolved?.error) {
          return { downloadUrl: '', text, rateLimit: resolved.rateLimit || pageResponse.rateLimit, error: resolved.error };
        }
      }
      return {
        downloadUrl,
        text,
        error: downloadUrl ? null : Errors.create('no_nmm_link', { context: 'Reading collection download link', record: false })
      };
    }

    // How a file of the run ended, once: the attempts before it were not recorded.
    recordFileFailure(error) {
      if (error && error.code !== 'aborted') Errors.record?.(error);
    }

    noteRateLimited(retryAfterSeconds) {
      const explicit = Number(retryAfterSeconds);
      this.rateLimitStrikes = Math.min((this.rateLimitStrikes || 0) + 1, NXTK.RATE_LIMIT_MAX_STRIKES);
      const backoff = Number.isFinite(explicit) && explicit > 0
        ? explicit
        : NXTK.rateLimitBackoffSeconds(this.rateLimitStrikes);
      const until = Date.now() + Math.min(backoff, NXTK.RATE_LIMIT_MAX_SECONDS) * 1000;
      this.rateLimitedUntil = Math.max(this.rateLimitedUntil || 0, until);
      NexusExt.Storage.saveRateLimit?.({ until: this.rateLimitedUntil });
      return Math.round((this.rateLimitedUntil - Date.now()) / 1000);
    }

    noteRateLimitCleared() {
      this.rateLimitStrikes = 0;
    }

    async waitOutRateLimit() {
      const shared = await NexusExt.Storage.getRateLimit();
      const until = Math.max(this.rateLimitedUntil || 0, Number(shared?.until) || 0);
      let remaining = Math.round((until - Date.now()) / 1000);
      if (!(remaining > 0)) return;

      const waitingText = (left) => TS('logRateLimitWaiting', [formatDuration(left)],
        `Nexus Mods is rate limiting requests. Waiting ${formatDuration(left)}...`);
      const logRow = this.ui.logText(waitingText(remaining), 'info');
      await new Promise((resolve) => {
        const intervalId = setInterval(() => {
          if (this.isStopped()) {
            clearInterval(intervalId);
            return resolve();
          }
          const msgSpan = logRow?.querySelector('.nxtk-log-msg');
          remaining = Math.round((until - Date.now()) / 1000);

          if (this.runStatus === STATUS_PAUSED) {
            if (msgSpan) {
              msgSpan.textContent = remaining > 0
                ? TS('logPausedRateLimit', [formatDuration(remaining)],
                    `Paused. Nexus rate limit clears in ${formatDuration(remaining)}.`)
                : T('logPausedRateLimitDone', 'Paused. The rate limit has cleared — press play to continue.');
            }
            return;
          }

          if (remaining > 0) {
            if (msgSpan) msgSpan.textContent = waitingText(remaining);
            return;
          }
          clearInterval(intervalId);
          if (msgSpan) msgSpan.textContent = T('logRateLimitCleared', 'Rate limit cleared. Resuming downloads.');
          resolve();
        }, 1000);
      });
    }

    // The connection dropped while a file's link was being fetched. Every request fails the same way
    // until it is back, so the run waits on that file, counting down and ending early when the browser
    // says it is online again, instead of failing it and every file after it within seconds. False
    // once the waits have run out (the run then stops) or the run was stopped.
    async waitForConnection() {
      this.networkStrikes = (this.networkStrikes || 0) + 1;
      if (this.networkStrikes > NXTK.NETWORK_WAIT_MAX_STRIKES) return false;
      let until = Date.now() + NXTK.networkWaitMs(this.networkStrikes);
      const left = () => Math.max(0, Math.round((until - Date.now()) / 1000));
      const waitingText = () => TS('logConnectionWaiting', [formatDuration(left())],
        `Cannot reach Nexus Mods. Trying again in ${formatDuration(left())}...`);
      const logRow = this.ui.logText(waitingText(), 'info');
      const onOnline = () => { until = Math.min(until, Date.now() + 2000); };
      globalThis.addEventListener?.('online', onOnline);
      try {
        await new Promise((resolve) => {
          const intervalId = setInterval(() => {
            if (this.isStopped() || this.downloadSignal?.aborted) {
              clearInterval(intervalId);
              return resolve();
            }
            if (this.runStatus === STATUS_PAUSED) return;
            const msgSpan = logRow?.querySelector('.nxtk-log-msg');
            if (left() > 0) {
              if (msgSpan) msgSpan.textContent = waitingText();
              return;
            }
            clearInterval(intervalId);
            if (msgSpan) msgSpan.textContent = T('logConnectionRetrying', 'Trying to reach Nexus Mods again.');
            resolve();
          }, 1000);
        });
      } finally {
        globalThis.removeEventListener?.('online', onOnline);
      }
      return !this.isStopped() && !this.downloadSignal?.aborted;
    }

    delayWithPause(totalMs) {
      return new Promise((resolve) => {
        let remaining = Math.max(0, Number(totalMs) || 0);
        let lastTickAt = Date.now();
        const tick = 100;
        const timer = setInterval(() => {
          const now = Date.now();
          if (this.isStopped() || this.downloadSignal?.aborted) {
            clearInterval(timer);
            return resolve();
          }
          if (this.runStatus === STATUS_PAUSED) {
            lastTickAt = now;
            return;
          }
          remaining -= Math.max(0, now - lastTickAt);
          lastTickAt = now;
          if (remaining <= 0) {
            clearInterval(timer);
            resolve();
          }
        }, tick);
      });
    }

    resolveLinkError(result) {
      return Errors.normalize(result?.error || Errors.create('no_nmm_link', { record: false }));
    }

    async fetchDownloadLinkWithRetry(mod, { attempts = 2, delayMs = 500, onAttemptFailed = null } = {}) {
      let result;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          result = await this.fetchDownloadLink(mod);
        } catch (cause) {
          result = {
            downloadUrl: '',
            text: '',
            error: Errors.fromException(cause, { context: 'Preparing collection download' })
          };
        }

        if (result.downloadUrl) {
          this.noteRateLimitCleared();
          return result;
        }
        if (this.isStopped()) return result;

        const error = this.resolveLinkError(result);
        result.error = error;

        if (error.code === 'rate_limited') {
          // The resolve path (getDownloadUrl) passes only the error on, so Retry-After rides on it too.
          const waitSeconds = this.noteRateLimited(result.rateLimit?.retryAfterSeconds ?? error.retryAfterSeconds);
          // The shared limit is recorded either way; the next file waits it out (waitOutRateLimit) and
          // says so. "Backing off" is only logged when this attempt really is about to wait.
          if (attempt >= attempts) return result;
          this.ui.logText(TS('logBackingOff', [formatDuration(waitSeconds)],
            `Nexus Mods is rate limiting requests. Backing off ${formatDuration(waitSeconds)}.`), 'info');
          await this.waitOutRateLimit();
          if (this.isStopped()) return result;
          continue;
        }

        if (attempt >= attempts || !error.retryable || Errors.isBlocking(error)) return result;

        onAttemptFailed?.(error, attempt);
        await this.delayWithPause(delayMs);
        if (this.isStopped()) return result;
      }
      return result;
    }

    fileLinkFor(mod) {
      return `${mod.file.url}&nmm=1`;
    }

    handOffDownload(mod, downloadUrl, prefix) {
      const sizeStr = convertSize(mod.file.size);
      const fileName = escapeHtml(mod.file.name);
      const fileUrl = escapeHtml(this.fileLinkFor(mod));
      const meta = `<span style="opacity:0.6;font-size:11px">(${sizeStr})</span>`;
      const link = `<a href="${fileUrl}" target="_blank" rel="noopener noreferrer">${fileName}</a>`;

      const verdict = NXTK.validateDownloadTarget(downloadUrl, { method: DOWNLOAD_METHOD_VORTEX });
      if (!verdict.ok) {
        const error = Errors.create('unsafe_download_url', {
          context: 'Validating download target',
          technicalMessage: `rejected: ${verdict.detail} | method=vortex`
        });
        this.ui.log(`${prefix} ${escapeHtml(Errors.toLogMessage(error))} ${link}`, 'error');
        return false;
      }

      // Vortex hands a link only to the download waiting for that file: a link for another file
      // would start a separate download there and leave this one waiting.
      const Parser = globalThis.NXTKDownloadParser;
      const wanted = Parser?.normalizeFileId?.(mod.fileId || mod.file?.fileId) || '';
      const linkedFile = Parser?.nxmFileId?.(downloadUrl);
      if (wanted && linkedFile !== undefined && linkedFile !== wanted) {
        const error = Errors.create('no_nmm_link', {
          context: 'Checking the Vortex link',
          technicalMessage: 'the nxm link names another file',
          fileIdentity: { expectedId: wanted, receivedId: linkedFile }
        });
        this.ui.log(`${prefix} ${escapeHtml(Errors.toLogMessage(error))} ${link}`, 'error');
        return false;
      }

      if (NXTK.isNxmLinkExpired(downloadUrl)) {
        this.ui.log(`${prefix} ${T('logLinkExpired', 'Link expired before it could be sent to Vortex.')} ${link}`, 'error');
        return false;
      }

      this.noteVortexAccount(downloadUrl);
      this.ui.log(`${prefix} ${T('logSendingToVortex', 'Sending to Vortex:')} ${link} ${meta}`);
      document.location.href = downloadUrl;
      return true;
    }

    // Vortex refuses a link signed for another account ("Invalid download links"), and the browser
    // never hears about it. Say once per run which account the links belong to, and warn loudly when
    // that is not the account signed in on this page.
    noteVortexAccount(downloadUrl) {
      const { userId } = NXTK.nxmLinkInfo(downloadUrl);
      if (!userId || this.vortexAccountNoted === userId) return;
      this.vortexAccountNoted = userId;
      const pageUserId = pageNexusUserId(document);
      if (NXTK.isNexusUserMismatch(userId, pageUserId)) {
        this.ui.logText(TS('logVortexAccountMismatch', [userId, pageUserId],
          `These links are signed for Nexus account #${userId}, but this page is signed in as #${pageUserId}. Vortex rejects links for another account: sign Vortex and the browser into the same Nexus account.`), 'error');
        return;
      }
      this.ui.logText(TS('logVortexAccountNote', [userId],
        `Links are signed for Nexus account #${userId}. Vortex must be signed into the same account, or it rejects them as "Invalid download links".`), 'info');
    }

    // A fresh link for the mod. Vortex resolves nxm:// links on arrival, so one that has expired (or
    // is about to) is logged and fetched again once instead of being sent dead.
    async fetchFreshLink(mod, options = {}, prefix = '') {
      let result = await this.fetchDownloadLinkWithRetry(mod, options);
      if (result.downloadUrl && NXTK.isNxmLinkExpired(result.downloadUrl)) {
        const link = `<a href="${escapeHtml(this.fileLinkFor(mod))}" target="_blank" rel="noopener noreferrer">${escapeHtml(mod.file.name)}</a>`;
        this.ui.log(`${prefix} ${T('logLinkExpiredRefetch', 'Link expired, fetching a new one.')} ${link}`.trim(), 'info');
        result = await this.fetchDownloadLinkWithRetry(mod, options);
      }
      return result;
    }

    // After the first hand-off of a run: wait for the page to lose focus (the OS opening Vortex), and
    // if it does not, ask once. Returns false when the user says Vortex did not open.
    async confirmFirstVortexHandoff() {
      let reason = '';
      NXTK.noteActivity?.('info', ['Vortex hand-off: watching whether Vortex opens (collection)']);
      const picked = await NXTK.waitForProtocolHandoff({ timeoutMs: VORTEX_CONFIRM_TIMEOUT_MS, maxMs: NXTK.PROTOCOL_BLUR_OPENED_MS, onResult: (r) => { reason = r; } });
      NXTK.noteActivity?.('info', [`Vortex hand-off: ${picked ? 'Vortex opened' : 'no sign Vortex opened'} (${reason || 'unknown'})`]);
      if (picked) {
        await NXTK.recordVortexOpenEvent?.('opened');
        this.ui.logText(T('logVortexOpened', 'Vortex picked up the first link; sending the rest.'), 'info');
        return true;
      }
      // A "yes" is remembered for this browser profile; the question comes back only after a "no"
      // or a hand-off that showed no sign of Vortex.
      const memory = await NXTK.readVortexOpenState?.();
      if (memory && !NXTK.shouldAskVortexOpened(memory)) {
        this.ui.logText(T('logVortexOpenRemembered', 'Vortex was confirmed before, so not asking again.'), 'info');
        return true;
      }
      if (typeof NexusExt.UI?.showVortexOpenedModal !== 'function') return true;
      const answer = await NexusExt.UI.showVortexOpenedModal();
      const next = await NXTK.recordVortexOpenEvent?.(answer === 'yes' ? 'answeredYes' : 'answeredNo');
      if (answer === 'yes') return true;
      this.ui.logText(T('logVortexNotOpened', 'Vortex did not open, so the rest were not sent. Start Vortex (and allow nxm:// links in the browser prompt), then run again.'), 'error');
      if (next && NXTK.shouldOfferBrowserSwitch(next)) {
        NexusExt.UI?.offerBrowserSwitch?.({
          onSwitch: () => {
            this.downloadMethod = DOWNLOAD_METHOD_BROWSER;
            this.ui?.setDownloadMethod?.(DOWNLOAD_METHOD_BROWSER);
          }
        });
      }
      return false;
    }

    async retryMod(mod, { type = null, onSucceeded = null } = {}) {
      if (this.isStopped()) {
        this.ui?.logText(T('logRetryIgnored', 'Retry ignored: this collection run was stopped.'), 'info');
        return;
      }

      const result = await this.fetchFreshLink(mod, {}, 'Retry:');
      if (this.isStopped()) return;

      if (result.downloadUrl) {
        if (this.handOffDownload(mod, result.downloadUrl, 'Retry:')) {
          NXTK.bumpTotalDownloads?.();
          if (type !== null) {
            try {
              await this.recordHistoryEntry(NXTK.vortexSentType(type), historyEntryId(mod));
            } catch (_) { }
          }
          onSucceeded?.();
        }
        return;
      }

      const error = this.resolveLinkError(result);
      this.recordFileFailure(error);
      const link = `<a href="${escapeHtml(this.fileLinkFor(mod))}" target="_blank" rel="noopener noreferrer">${escapeHtml(mod.file.name)}</a>`;
      this.ui.log(`${TS('logRetryFailed', [escapeHtml(Errors.toLogMessage(error))], `Retry failed: ${escapeHtml(Errors.toLogMessage(error))}`)} ${link}`, 'error');
      if (this.showAlertsOnError && error.retryable) {
        NexusExt.UI.showError(error, {
          onRetry: () => this.retryMod(mod, { type, onSucceeded }),
          ...this.errorContextFor(mod)
        });
      }
    }

    logSkipped(name, reason) {
      this.ui.logText(TS('logSkippedItem', [name, skipReasonText(reason)],
        `Skipped: ${name} (${skipReasonText(reason)})`), 'info');
    }

    // The files a run moved past without downloading, listed once at the end so none go unnoticed.
    logSkippedSummary(skipped) {
      const entries = Array.isArray(skipped) ? skipped.filter((entry) => entry && entry.name) : [];
      if (!entries.length || !this.ui) return;
      this.ui.logText(NXTK.tPlural('logSkippedSummary', entries.length,
        `Skipped ${entries.length} mods that could not be downloaded:`), 'info');
      for (const { name, pageUrl, reason } of entries) {
        const label = escapeHtml(name);
        const target = NXTK.isSafeNexusPageUrl(pageUrl)
          ? `<a href="${escapeHtml(pageUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`
          : label;
        this.ui.log(`${escapeHtml(skipReasonText(reason))} · ${target}`, 'info');
      }
    }

    // The end-of-run card: what was sent, skipped (with reasons) and failed, with ways to act on it.
    showRunSummary({ sentMods = [], skipped = [], failedDownload = [], type = null } = {}) {
      const summary = {
        sent: sentMods.map((mod) => ({ name: mod.file.name, pageUrl: this.fileLinkFor(mod) })),
        skipped: skipped.map(({ name, pageUrl, reason }) => ({ name, pageUrl, reason })),
        failed: failedDownload.map(({ mod, error }) => ({ name: mod.file.name, pageUrl: this.fileLinkFor(mod), code: error?.code || 'unknown', mod })),
        account: this.vortexAccountNoted || ''
      };
      this.lastRunSummary = summary;
      if (!summary.sent.length && !summary.skipped.length && !summary.failed.length) return;
      if (typeof NexusExt.UI?.showRunSummary !== 'function') return;
      NexusExt.UI.showRunSummary(summary, {
        onRetryFailed: async () => {
          // The card outlives its run, and a run that ended stopped, blocked or on a sign-in leaves the
          // status at Stopped, which skipped every retry. Asking for the retries is a new start.
          if (!this.running && !this.disposed && this.runStatus === STATUS_STOPPED) this.runStatus = STATUS_DOWNLOADING;
          for (const entry of summary.failed.slice()) {
            if (this.isStopped()) break;
            await this.retryMod(entry.mod, { type });
          }
        }
      });
    }

    // The same card for a browser-download run, from what the background queue reported.
    showBrowserRunSummary(runLog, skipped = [], type = null) {
      const summary = {
        sent: runLog.sent,
        skipped: [
          ...runLog.alreadyHad,
          ...(Array.isArray(skipped) ? skipped : []).map((entry) => ({ name: entry.name, pageUrl: entry.pageUrl, reason: skipReasonText(entry.reason) }))
        ],
        failed: runLog.failed,
        account: ''
      };
      this.lastRunSummary = summary;
      if (!summary.sent.length && !summary.skipped.length && !summary.failed.length) return;
      if (typeof NexusExt.UI?.showRunSummary !== 'function') return;
      const retryable = summary.failed.map((entry) => entry.mod).filter(Boolean);
      NexusExt.UI.showRunSummary(summary, {
        onRetryFailed: retryable.length ? () => this.downloadMods(retryable, type) : null
      });
    }

    // What the error dialog's "Open file page" / "Use browser download" buttons refer to.
    errorContextFor(mod) {
      return {
        filePageUrl: NXTK.isSafeNexusPageUrl?.(this.fileLinkFor(mod)) ? this.fileLinkFor(mod) : '',
        method: this.downloadMethod === DOWNLOAD_METHOD_VORTEX ? 'vortex' : 'browser',
        onSwitchToBrowser: () => {
          this.downloadMethod = DOWNLOAD_METHOD_BROWSER;
          this.ui?.setDownloadMethod?.(DOWNLOAD_METHOD_BROWSER);
        }
      };
    }

    async recordHistoryEntry(type, fileId) {
      return NexusExt.Storage.addHistoryEntry({
        gameId: this.gameId,
        collectionId: this.collectionId,
        type,
        fileId
      });
    }

    async downloadBrowserQueue(mods, type, history, { restart = false } = {}) {
      this.ui.startDownload(mods.length);
      const alreadyDownloaded = type === null
        ? new Set()
        : new Set(history?.[this.gameId]?.[this.collectionId]?.[type] || []);
      const pending = [];
      // For the end-of-run card, collected from the worker's per-file events.
      const runLog = { sent: [], failed: [], alreadyHad: [], pending, mods, type };

      for (const mod of mods) {
        if (alreadyDownloaded.has(historyEntryId(mod))) {
          runLog.alreadyHad.push({ name: mod.file.name, pageUrl: mod.file.url, reason: T('logAlreadyDownloaded', 'Already downloaded') });
          this.ui.log(
            `${T('logAlreadyDownloaded', 'Already downloaded')} <a href="${escapeHtml(mod.file.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(mod.file.name)}</a>`
          );
          this.ui.incrementProgress();
          continue;
        }
        pending.push({
          fileId: mod.fileId || mod.file.fileId,
          historyId: historyEntryId(mod),
          gameId: mod.file.mod.game.id,
          name: mod.file.name,
          modName: mod.file.mod.name,
          modId: mod.file.mod.modId,
          version: mod.file.version,
          pageUrl: mod.file.url,
          sizeKb: mod.file.size,
          optional: mod.optional === true
        });
      }

      if (!pending.length) {
        this.downloadController = null;
        this.ui.endDownload('finished');
        this.showBrowserRunSummary(runLog, [], type);
        return;
      }

      const queueProgressBase = this.ui.progress;
      const visibleTotal = mods.length;
      const startId = makeBackgroundStartId();
      this.backgroundStartId = startId;

      await this.watchBackgroundJob({
        queueProgressBase,
        visibleTotal,
        fallbackQueueTotal: pending.length,
        sizesKb: pending.map((item) => item.sizeKb),
        runLog,
        start: () => NexusExt.Storage.sendDownloadCommand('NDC_QUEUE_START', {
          gameId: this.gameId,
          collectionId: this.collectionId,
          startId,
          label: this.displayName || this.collectionId,
          type,
          restart,
          folder: this.downloadFolder,
          requestTimeout: this.requestTimeout,
          items: pending
        })
      });
    }

    watchBackgroundJob({
      queueProgressBase = 0,
      visibleTotal = 0,
      fallbackQueueTotal = 0,
      sizesKb = [],
      start = null,
      runLog: givenRunLog = null
    } = {}) {
      // A reconnected job has no item list here; its card only shows what the worker reports.
      const runLog = givenRunLog || { sent: [], failed: [], alreadyHad: [], pending: [], mods: [], type: null };
      return new Promise((resolve) => {
        let settled = false;
        let watchdogTimer = null;
        let onVisibilityChange = null;
        let pollFailures = 0;
        let waitTimer = null;
        let waitRow = null;
        const queueTotal = sizesKb.length || fallbackQueueTotal;
        let adopted = false;
        let eta = sizesKb.length
          ? NXTK.createQueueEta(sizesKb, { fallbackMBps: this.resolveDownloadSpeed().speed })
          : null;

        const stopWaitCountdown = () => {
          clearInterval(waitTimer);
          waitTimer = null;
          waitRow = null;
        };

        // A silent pause of up to ten minutes reads as a hang, so the wait counts
        // down in place the same way the Vortex run does. The worker waits for one of two
        // reasons, a rate limit or a lost connection, and each is named as what it is.
        const startWaitCountdown = (until, reason = 'rate_limited') => {
          stopWaitCountdown();
          const network = reason === 'network';
          if (!until || until <= Date.now()) {
            if (!network) {
              this.ui.logText(T('logQueueRateLimited',
                'Nexus Mods rate limit reached. The background queue will resume automatically.'), 'info');
            }
            return;
          }
          const left = () => Math.max(0, Math.round((until - Date.now()) / 1000));
          const waiting = () => (network
            ? TS('logConnectionWaiting', [formatDuration(left())],
              `Cannot reach Nexus Mods. Trying again in ${formatDuration(left())}...`)
            : TS('logRateLimitWaiting', [formatDuration(left())],
              `Nexus Mods is rate limiting requests. Waiting ${formatDuration(left())}...`));
          const done = () => (network
            ? T('logConnectionRetrying', 'Trying to reach Nexus Mods again.')
            : T('logRateLimitCleared', 'Rate limit cleared. Resuming downloads.'));
          const text = () => (left() > 0 ? waiting() : done());

          waitRow = this.ui.logText(text(), 'info');
          waitTimer = setInterval(() => {
            const message = waitRow?.isConnected ? waitRow.querySelector('.nxtk-log-msg') : null;
            if (settled || !message) {
              stopWaitCountdown();
              return;
            }
            message.textContent = text();
            if (left() <= 0) stopWaitCountdown();
          }, 1000);
        };

        const cleanup = () => {
          try {
            chrome.runtime.onMessage.removeListener(onQueueEvent);
          } catch (_) { }
          clearInterval(watchdogTimer);
          watchdogTimer = null;
          stopWaitCountdown();
          if (onVisibilityChange) {
            document.removeEventListener('visibilitychange', onVisibilityChange);
            onVisibilityChange = null;
          }
          this.settleBrowserQueue = null;
          this.backgroundJobId = null;
          this.backgroundStartId = null;
          this.downloadController = null;
        };

        const finish = (outcome = 'error', error = '', skipped = []) => {
          if (settled) return;
          settled = true;
          cleanup();
          this.ui.setTimeLeft?.(0);
          this.logSkippedSummary(skipped);
          // A blocking verdict reaches here as the outcome of a DONE event, or as the lastError of a
          // job a status poll found in 'error'. Either way it is named and handled as blocking,
          // instead of ending on a bare "Download ended with an error".
          const known = DECK_OUTCOMES.has(outcome);
          const reason = String(error || (known ? '' : outcome || ''));
          const code = String(reason || outcome || '').split(' ')[0].trim();
          const blocking = outcome !== 'stopped' && Errors.isBlocking({ code });
          if (reason) {
            const text = queueErrorText(reason);
            this.ui.logText(TS('logBackgroundError', [text], `Background collection error: ${text}`), 'error');
          }
          if (blocking && this.showAlertsOnError) NexusExt.UI?.showError?.(Errors.normalize({ code }));
          let deckOutcome = known ? outcome : 'error';
          if (blocking) deckOutcome = code === 'requires_login' ? 'requires_login' : 'blocked';
          this.ui.endDownload(deckOutcome);
          this.showBrowserRunSummary(runLog, skipped, runLog.type);
          resolve();
        };

        this.settleBrowserQueue = (outcome = 'stopped') => finish(outcome);

        const pollQueueStatus = async () => {
          if (settled || !this.backgroundJobId) return;
          let reply;
          try {
            reply = await NexusExt.Storage.sendDownloadCommand('NDC_QUEUE_STATUS', this.queueTarget());
          } catch (_) {
            reply = null;
          }
          if (settled) return;
          if (!reply?.ok) {
            pollFailures += 1;
            if (pollFailures >= MAX_QUEUE_POLL_FAILURES) {
              finish('error', reply?.error || 'the background download job stopped responding');
            }
            return;
          }
          pollFailures = 0;

          const snapshot = reply.value;
          if (!snapshot) {
            finish('error', 'the background download job is no longer available');
            return;
          }

          const queueIndex = Math.max(0, Number(snapshot.index) || 0);
          this.ui.setProgress?.(queueProgressBase + queueIndex, visibleTotal);
          if (snapshot.status === 'paused' || snapshot.status === 'running') {
            this.ui.setDownloadStatus?.(snapshot.status);
            return;
          }
          if (DECK_OUTCOMES.has(snapshot.status)) {
            finish(snapshot.status, snapshot.lastError || '', snapshot.skipped);
          }
        };

        // The queue resolves its links in the service worker, which has no document and
        // so cannot write the Nexus ad-timer cookie. The cookie lasts five minutes, so a
        // run longer than that used to continue with it expired. This tab is open for the
        // whole run anyway, so it keeps the cookie alive on the queue's behalf. The helper
        // rate-limits itself to one write a minute, so every tick costing nothing is fine.
        const runWatchdog = () => {
          NexusExt.NNW?.refreshAdTimerCookie?.();
          pollQueueStatus().catch(() => undefined);
        };
        NexusExt.NNW?.refreshAdTimerCookie?.();
        watchdogTimer = setInterval(runWatchdog, 7000);
        onVisibilityChange = () => {
          if (!settled && !document.hidden) runWatchdog();
        };
        document.addEventListener('visibilitychange', onVisibilityChange);

        const applyEvent = (message) => {
          const queueIndex = Math.max(0, Number(message.index) || 0);
          this.ui.setProgress?.(queueProgressBase + queueIndex, visibleTotal);
          if (message.status === 'paused' || message.status === 'running') {
            this.ui.setDownloadStatus?.(message.status);
          }
          if (message.status === 'paused') eta?.spoil();
          if (message.type === 'NXT_NDC_PROGRESS') {
            stopWaitCountdown();
            const name = message.itemName || 'Nexus file';
            if (message.itemState === 'started') {
              eta?.itemStarted();
              this.ui.logText(TS('logDownloading', [name], `Downloading: ${name}`));
            } else if (message.itemState === 'complete') {
              eta?.itemCompleted(queueIndex - 1);
              this.ui.setTimeLeft?.(eta ? eta.remainingSeconds(queueIndex, queueTotal) : 0);
              // The worker names the size of the file it finished. The page's own list is only a fallback
              // for an older worker, and never for an adopted job, whose numbering is not this tab's.
              const sizeKb = Number(message.itemSizeKb)
                || (adopted ? 0 : Number(sizesKb[queueIndex - 1]) || 0);
              runLog.sent.push({ name, pageUrl: runLog.pending.find((item) => item.name === name)?.pageUrl || '' });
              this.ui.logText(sizeKb > 0
                ? TS('logCompletedSize', [name, NXTK.formatBytes(sizeKb * 1024)], `Completed: ${name} (${NXTK.formatBytes(sizeKb * 1024)})`)
                : TS('logCompleted', [name], `Completed: ${name}`), 'info');
            } else if (message.itemState === 'retrying') {
              eta?.spoil();
              this.ui.logText(TS('logRetryingInterrupted', [name], `Retrying interrupted download: ${name}`), 'info');
            } else if (message.itemState === 'skipped') {
              eta?.spoil();
              this.logSkipped(name, message.error);
            } else if (message.itemState === 'failed') {
              eta?.spoil();
              const reason = queueErrorText(message.error);
              const item = runLog.pending.find((entry) => entry.name === name);
              runLog.failed.push({ name, pageUrl: item?.pageUrl || '', code: String(message.error || 'unknown').split(' ')[0], mod: runLog.mods.find((m) => m.file.name === name) || null });
              this.ui.logText(TS('logFailedItem', [name, reason], `Failed: ${name} (${reason})`), 'error');
            }
            return;
          }
          if (message.type === 'NXT_NDC_STATE') return;
          if (message.type === 'NXT_NDC_WAITING') {
            eta?.spoil();
            startWaitCountdown(Number(message.until) || 0, String(message.reason || 'rate_limited'));
            return;
          }
          if (message.type === 'NXT_NDC_DONE') {
            stopWaitCountdown();
            if (message.folder) this.landedIn = String(message.folder);
            finish(message.outcome || 'error', message.error || '', message.skipped);
          }
        };

        // Bind progress only after the event is matched to this job.
        const onQueueEvent = (message) => {
          if (!/^NXT_NDC_/.test(String(message?.type || ''))) return false;
          if (this.backgroundJobId) {
            if (message.jobId !== this.backgroundJobId) return false;
          } else {
            // Until START answers, only the job this start created may be adopted. A job it just
            // replaced for the same collection can still be reporting, and binding to that one
            // would leave the new run showing no progress at all.
            if (!message.startId || message.startId !== this.backgroundStartId) return false;
            this.backgroundJobId = message.jobId;
          }
          applyEvent(message);
          return false;
        };

        try {
          chrome.runtime.onMessage.addListener(onQueueEvent);
        } catch (cause) {
          finish('error', String(cause?.message || cause));
          return;
        }

        if (typeof start !== 'function') {
          runWatchdog();
          return;
        }

        const requestedStartId = this.backgroundStartId;
        Promise.resolve(start()).then((reply) => {
          if (settled) {
            // Stop can be clicked while START is still writing the background job. The worker also
            // tracks startId, but this closes the loop if it restarted between those two messages.
            if (reply?.ok && reply.value?.jobId) {
              NexusExt.Storage.sendDownloadCommand('NDC_QUEUE_STOP', {
                jobId: reply.value.jobId,
                startId: requestedStartId,
                gameId: this.gameId,
                collectionId: this.collectionId
              }).catch?.(() => undefined);
            }
            return;
          }
          if (!reply?.ok || !reply.value?.jobId) {
            finish('error', reply?.error || 'background queue did not start');
            return;
          }
          this.backgroundJobId = reply.value.jobId;
          if (!reply.value.adopted) return;
          // An adopted job numbers its own item list, so this tab's sizes no longer line up: no estimate
          // is better than a wrong one.
          adopted = true;
          eta = null;
          this.ui.setTimeLeft?.(0);
          this.ui.logText(T('logReconnectedAdopted', 'Reconnected to the download already running in the background.'), 'info');
          const queueIndex = Math.min(
            Number(reply.value.index) || 0,
            Number(reply.value.total) || fallbackQueueTotal
          );
          this.ui.setProgress?.(queueProgressBase + queueIndex, visibleTotal);
          this.ui.setDownloadStatus?.(reply.value.status);
        }).catch((cause) => finish('error', String(cause?.message || cause)));
      });
    }

    async resumeBackgroundRun() {
      if (!this.ui || this.disposed) return false;
      // A Vortex run lives in this tab, not in the worker, so there is no job to attach to. A deck that
      // Nexus re-rendered mid-run is set up from the run's own count; it used to show no progress and
      // no Stop or Pause for the rest of the run.
      if (this.running && this.vortexRunProgress) {
        const { done, total } = this.vortexRunProgress;
        this.ui.startDownload(total, { resumed: true });
        this.ui.setProgress(done, total);
        if (this.runStatus === STATUS_PAUSED) this.ui.setDownloadStatus?.('paused');
        return true;
      }
      const alreadyWatching = this.running;

      let reply;
      try {
        reply = await NexusExt.Storage.sendDownloadCommand('NDC_QUEUE_ATTACH', {
          gameId: this.gameId,
          collectionId: this.collectionId
        });
      } catch (_) {
        return false;
      }
      if (!reply?.ok || !reply.value) return false;

      const snapshot = reply.value;
      if (snapshot.status !== 'running' && snapshot.status !== 'paused') return false;
      if (this.disposed || !this.ui) return false;
      if (this.running !== alreadyWatching) return false;

      const total = Math.max(1, Number(snapshot.total) || 0);
      const index = Math.min(Math.max(0, Number(snapshot.index) || 0), total);

      this.ui.startDownload(total, { resumed: true });
      this.ui.setProgress(index, total);
      this.ui.setDownloadStatus(snapshot.status);

      if (alreadyWatching) {
        this.ui.logText(T('logProgressRestored', 'Progress restored for the download still running in this tab.'), 'info');
        return true;
      }

      this.backgroundJobId = snapshot.jobId;
      this.running = true;
      try {
        this.ui.logText(T('logReconnectedBackground', 'Reconnected to a collection download still running in the background.'), 'info');
        await this.watchBackgroundJob({
          queueProgressBase: 0,
          visibleTotal: total,
          fallbackQueueTotal: total
        });
      } finally {
        this.running = false;
      }
      return true;
    }

    async downloadMods(mods, type = null) {
      if (!this.ui || this.disposed) return;
      if (!mods.length) {
        this.ui.logText(T('logNothingToDownload', 'There are no mods to download for this selection.'), 'info');
        return;
      }
      if (this.running) {
        this.ui.logText(T('logAlreadyRunning', 'A download is already running. Please wait or stop it first.'), 'info');
        return;
      }
      this.running = true;
      NXTK.setActivity?.({
        trigger: 'collection',
        method: this.downloadMethod === DOWNLOAD_METHOD_BROWSER ? 'browser' : 'vortex',
        fileId: '',
        autoClose: false,
        fallbackActive: false
      });
      this.downloadController = typeof AbortController === 'function' ? new AbortController() : null;
      try {
        const claim = await this.acquireRunClaim();
        if (!claim.granted) {
          this.ui.logText(
            claim.reason === 'background-job'
              ? T('logClaimBackground', 'A background download for this collection is still running. Open its tab and stop it there, or close that tab.')
              : T('logClaimOtherTab', 'This collection is already downloading in another tab. Stop it there first, or close that tab.'),
            'error'
          );
          return;
        }
        await this.runCollection(mods, type);
      } finally {
        this.releaseRunClaim();
        this.running = false;
      }
    }

    async runCollection(mods, type) {
      if (this.runStatus === STATUS_STOPPED) this.runStatus = STATUS_DOWNLOADING;

      const loginError = Auth?.getDocumentLoginError?.(document, 'Starting collection download');
      if (loginError) {
        const loginUrl = escapeHtml(Auth.buildLoginUrl());
        this.ui.log(
          `${T('logSignInFirst', 'Sign in to Nexus Mods before starting this collection.')} <a href="${loginUrl}" target="_self">${T('logOpenLogin', 'Open login')}</a>.`,
          'error'
        );
        if (this.showAlertsOnError) {
          NexusExt.UI.showError(loginError, { title: NXTK.t('dlgSignInRequired', null, 'Sign in required') });
        }
        return;
      }

      if (this.downloadMethod === DOWNLOAD_METHOD_VORTEX
        && typeof NexusExt.UI?.showVortexHandoffModal === 'function') {
        const choice = await NexusExt.UI.showVortexHandoffModal();
        if (choice === 'cancel') {
          this.ui.logText(T('logCanceledBeforeStart', 'Download canceled before start.'), 'info');
          return;
        }
        if (choice === 'browser') {
          this.downloadMethod = DOWNLOAD_METHOD_BROWSER;
          this.ui.setDownloadMethod?.(DOWNLOAD_METHOD_BROWSER);
          await NexusExt.Storage.patchSetting('NDC_downloadMethod', DOWNLOAD_METHOD_BROWSER);
          NXTK.setActivity?.({
            trigger: 'collection',
            method: 'browser',
            fileId: '',
            autoClose: false,
            fallbackActive: false
          });
        }
      }

      mods = await this.applyUpdatePolicy(mods);

      let history = null;
      let restart = false;
      if (type !== null) {
        history = await NexusExt.Storage.getHistory();
        history[this.gameId] = history[this.gameId] || {};
        history[this.gameId][this.collectionId] = history[this.gameId][this.collectionId] || {};
        history[this.gameId][this.collectionId][type] = history[this.gameId][this.collectionId][type] || [];

        const skipPrompt = this.skipHistoryPromptOnce === true;
        this.skipHistoryPromptOnce = false;
        if (history[this.gameId][this.collectionId][type].length && !skipPrompt) {
          const choice = await NexusExt.UI.showHistoryDecisionModal({
            downloadedCount: history[this.gameId][this.collectionId][type].length,
            totalCount: mods.length
          });

          if (choice === 'cancel') {
            this.ui.logText(T('logCanceledBeforeStart', 'Download canceled before start.'), 'info');
            return;
          }

          if (choice === 'redownload') {
            restart = true;
            await NexusExt.Storage.clearHistoryType({
              gameId: this.gameId,
              collectionId: this.collectionId,
              type: NXTK.vortexSentType(type)
            });
            history = await NexusExt.Storage.clearHistoryType({
              gameId: this.gameId,
              collectionId: this.collectionId,
              type
            });
            history[this.gameId] = history[this.gameId] || {};
            history[this.gameId][this.collectionId] = history[this.gameId][this.collectionId] || {};
          }
        }
      }

      if (this.smallestFirst) {
        mods = NXTK.orderQueueBySize(mods, (mod) => mod.file?.size);
        this.ui.logText(T('logSmallestFirst', 'Downloading the smallest files first.'), 'info');
      }

      if (this.downloadMethod === DOWNLOAD_METHOD_BROWSER) {
        await this.downloadBrowserQueue(mods, type, history, { restart });
        return;
      }

      this.ui.startDownload(mods.length);
      // The run's own count, so a deck that Nexus re-renders mid-run can be set up again from it.
      this.vortexRunProgress = { done: 0, total: mods.length };
      let outcome = 'finished';
      this.vortexAccountNoted = null;
      this.ui.logText(T('logVortexCollectionTip', 'Tip: for a whole collection, start it in Vortex ("Download collection in Vortex") so Vortex installs it with its rules; then send the files it asks for from here.'), 'info');

      try {

        const failedDownload = [];
        const skipped = [];
        let cloudflareStrikes = 0;
        let handedOffCount = 0;
        const sentMods = [];
        let forceStop = false;
        let failureAlerted = false;
        this.networkStrikes = 0;

        for (const [index, mod] of mods.entries()) {
        const modNumber = `${String(index + 1).padStart(String(mods.length).length, '0')}/${mods.length}`;
        const fileName = escapeHtml(mod.file.name);
        const fileUrl = escapeHtml(this.fileLinkFor(mod));
        let handedOff = false;

        if (this.isStopped()) {
          outcome = 'stopped';
          this.ui.logText(T('logDownloadStopped', 'Download stopped.'), 'info');
          break;
        }

        if (history?.[this.gameId]?.[this.collectionId]?.[type]?.includes(historyEntryId(mod))) {
          this.ui.log(`[${modNumber}] ${T('logAlreadyDownloaded', 'Already downloaded')} <a href="${fileUrl}" target="_blank" rel="noopener noreferrer">${fileName}</a>`);
          this.advanceVortexRun();
          continue;
        }
        if (history?.[this.gameId]?.[this.collectionId]?.[NXTK.vortexSentType(type)]?.includes(historyEntryId(mod))) {
          this.ui.log(`[${modNumber}] ${T('logResendingVortex', 'Sent to Vortex before; sending again (Vortex skips files it already has)')} <a href="${fileUrl}" target="_blank" rel="noopener noreferrer">${fileName}</a>`);
        }

        await this.waitOutRateLimit();
        // Pause holds the run here as well. After a skipped or failed file nothing else waits, so the
        // next file was looked up and sent to Vortex while the deck said "Paused".
        if (this.runStatus === STATUS_PAUSED) await this.delayWithPause(0);
        if (this.isStopped()) {
          outcome = 'stopped';
          this.ui.logText(T('logDownloadStopped', 'Download stopped.'), 'info');
          break;
        }

        let downloadResult;
        let connectionLost = false;
        for (;;) {
          downloadResult = await this.fetchFreshLink(mod, {
            onAttemptFailed: (error, attempt) => this.ui.log(
              `[${modNumber}] ${escapeHtml(TS('logRetryingAttempt', [error.code, String(attempt + 1)], `${error.code} — retrying (attempt ${attempt + 1})`))} <a href="${fileUrl}" target="_blank" rel="noopener noreferrer">${fileName}</a>`,
              'info'
            )
          }, `[${modNumber}]`);
          if (downloadResult.downloadUrl || this.isStopped()) break;
          if (!NXTK.isConnectionFailure(this.resolveLinkError(downloadResult).code)) break;
          if (!await this.waitForConnection()) {
            connectionLost = !this.isStopped();
            break;
          }
        }
        // Any answer from Nexus means the connection is back, so a later drop starts its waits afresh.
        if (!NXTK.isConnectionFailure(downloadResult.downloadUrl ? '' : this.resolveLinkError(downloadResult).code)) {
          this.networkStrikes = 0;
        }

        if (this.isStopped()) {
          outcome = 'stopped';
          this.ui.logText(T('logDownloadStopped', 'Download stopped.'), 'info');
          break;
        }

        const skipReason = downloadResult.downloadUrl
          ? ''
          : NXTK.queueSkipReason(this.resolveLinkError(downloadResult).code, cloudflareStrikes);
        cloudflareStrikes = skipReason === 'cloudflare' ? cloudflareStrikes + 1 : 0;

        if (skipReason) {
          // Gone, or one Cloudflare answer: noted and passed over, and the run goes on. A gone mod is the
          // mod's state, not a fault; a Cloudflare answer is worth a line in a bug report, as in the worker.
          if (skipReason === 'cloudflare') this.recordFileFailure(this.resolveLinkError(downloadResult));
          this.logSkipped(`[${modNumber}] ${mod.file.name}`, skipReason);
          skipped.push({ name: mod.file.name, pageUrl: mod.file.url, reason: skipReason });
          this.advanceVortexRun();
        } else if (!downloadResult.downloadUrl) {
          const downloadError = this.resolveLinkError(downloadResult);
          this.recordFileFailure(downloadError);
          this.ui.log(
            `[${modNumber}] ${escapeHtml(Errors.toLogMessage(downloadError))} <a href="${fileUrl}" target="_blank" rel="noopener noreferrer">${fileName}</a>`,
            'error'
          );
          if (Errors.isBlocking(downloadError)) {
            forceStop = true;
            outcome = downloadError.code === 'requires_login' ? 'requires_login' : 'blocked';
            if (this.showAlertsOnError) {
              NexusExt.UI.showError(downloadError, {
                title: downloadError.code === 'requires_login'
                  ? T('dlgSignInRequired', 'Sign in required')
                  : T('dlgDownloadPaused', 'Download paused')
              });
            }
          } else if (connectionLost) {
            // Nexus stayed out of reach through every wait: the run stops on this file, which is not
            // counted as failed, so starting again picks it up first.
            forceStop = true;
            outcome = 'error';
            if (this.showAlertsOnError) {
              NexusExt.UI.showError(downloadError, { title: T('dlgDownloadPaused', 'Download paused') });
            }
          } else {
            this.advanceVortexRun();
            failedDownload.push({ mod, error: downloadError });
            // One dialog per run: each failure replaced the one before, so a run with many failures
            // flashed a dialog per file and left only the last file's Retry. The rest are in the log
            // and in the summary's "Retry failed".
            if (this.showAlertsOnError && downloadError.retryable && !failureAlerted) {
              failureAlerted = true;
              NexusExt.UI.showError(downloadError, {
                ...this.errorContextFor(mod),
                onRetry: () => this.retryMod(mod, {
                  type,
                  onSucceeded: () => {
                    const failedIndex = failedDownload.findIndex((entry) => entry.mod === mod);
                    if (failedIndex !== -1) failedDownload.splice(failedIndex, 1);
                  }
                })
              });
            }
          }
        } else if (!this.handOffDownload(mod, downloadResult.downloadUrl, `[${modNumber}]`)) {
          this.advanceVortexRun();
          failedDownload.push({
            mod,
            error: Errors.create('unsafe_download_url', { context: 'Validating download target' })
          });
        } else {
          this.advanceVortexRun();
          NXTK.bumpTotalDownloads?.();
          handedOff = true;
          handedOffCount += 1;
          sentMods.push(mod);

          if (history) {
            history = await this.recordHistoryEntry(NXTK.vortexSentType(type), historyEntryId(mod));
          }
          if (handedOffCount === 1 && index < mods.length - 1 && !(await this.confirmFirstVortexHandoff())) {
            forceStop = true;
            outcome = 'stopped';
          }
        }

        if (forceStop) {
          this.ui.logText(T('logCollectionPaused', 'Collection paused. Completed files remain in history, so you can safely retry after resolving the issue.'), 'info');
          break;
        }

        if (handedOff && index < mods.length - 1) {
          const computePause = () => {
            // A short floor always stays between hand-offs, so a run never fires requests back to back.
            // After the first one it is longer: only the link that starts Vortex reaches it on the
            // command line, and one that arrives while Vortex is still loading is dropped.
            const floor = Math.max(NXTK.MIN_HANDOFF_GAP_SECONDS || 0, handedOffCount === 1 ? NXTK.VORTEX_STARTUP_GAP_SECONDS || 0 : 0);
            if (this.pauseBetweenDownload === 0) return floor;
            const { speed } = this.resolveDownloadSpeed();
            const transferSeconds = Math.round(mod.file.size / 1024 / speed);
            return Math.max(floor, Math.min(transferSeconds + this.pauseBetweenDownload, MAX_PAUSE_SECONDS));
          };
          let pause = computePause();
          if (pause > 0) {
            const sizeStr = convertSize(mod.file.size);
            const pauseMessage = (remaining) => {
              const { speed, source } = this.resolveDownloadSpeed();
              return TS('logPausing',
                [formatDuration(pause), sizeStr, speed.toFixed(1), source, formatDuration(remaining)],
                `Pausing ${formatDuration(pause)} before next download (${sizeStr} @ ${speed.toFixed(1)} MB/s ${source})... ${formatDuration(remaining)} left`);
            };
            const pauseLogRow = this.ui.logText(pauseMessage(pause), 'info');
            let activeElapsedMs = 0;
            let lastTickAt = Date.now();
            await new Promise(resolve => {
              const intervalId = setInterval(() => {
                const now = Date.now();
                const elapsedSinceTick = Math.max(0, now - lastTickAt);
                lastTickAt = now;
                if (this.isStopped()) {
                  clearInterval(intervalId);
                  return resolve();
                }
                if (this.runStatus === STATUS_PAUSED) {
                  return;
                }
                activeElapsedMs += elapsedSinceTick;
                pause = computePause();
                if (pause <= 0) {
                  clearInterval(intervalId);
                  if (pauseLogRow) {
                    const msgSpan = pauseLogRow.querySelector('.nxtk-log-msg');
                    if (msgSpan) msgSpan.textContent = TS('logPauseComplete', [formatDuration(0), sizeStr],
                      `Pause complete (${formatDuration(0)} for ${sizeStr}).`);
                  }
                  return resolve();
                }
                const elapsed = Math.floor(activeElapsedMs / 1000);
                let remainingPause = pause - elapsed;
                if (remainingPause < 0) remainingPause = 0;
                if (pauseLogRow) {
                  const msgSpan = pauseLogRow.querySelector('.nxtk-log-msg');
                  if (msgSpan) msgSpan.textContent = pauseMessage(remainingPause);
                }
                if (activeElapsedMs >= pause * 1000) {
                  clearInterval(intervalId);
                  if (pauseLogRow) {
                    const msgSpan = pauseLogRow.querySelector('.nxtk-log-msg');
                    if (msgSpan) msgSpan.textContent = TS('logPauseComplete', [formatDuration(pause), sizeStr],
                      `Pause complete (${formatDuration(pause)} for ${sizeStr}).`);
                  }
                  return resolve();
                }
              }, 100);
            });
          }
        }
      }

      if (outcome === 'finished' && this.isStopped()) outcome = 'stopped';

      if (history && outcome === 'finished' && !failedDownload.length && !skipped.length
        && this.ui.progress === this.ui.modsCount) {
        for (const listType of [type, NXTK.vortexSentType(type)]) {
          await NexusExt.Storage.clearHistoryType({
            gameId: this.gameId,
            collectionId: this.collectionId,
            type: listType
          });
        }
      }

      this.logSkippedSummary(skipped);
      if (skipped.length && outcome === 'finished') outcome = 'partial';
      // The browser cannot tell whether Vortex accepted an nxm:// link (or is installed at all), so a
      // hand-off is recorded as sent, not as downloaded. Say so, with the way to resend.
      if (handedOffCount > 0) {
        this.ui.logText(TS('logVortexHandoffSummary', [String(handedOffCount)],
          `Handed ${handedOffCount} files to Vortex. Check Vortex's Downloads tab. If any are missing, just run again: sent files are kept as "sent", not "downloaded", and Vortex skips files it already has, so only the missing ones download again.`), 'info');
      }

      if (failedDownload.length) {
        if (outcome === 'finished') outcome = 'partial';
        this.ui.logText(NXTK.tPlural('logFailedSummary', failedDownload.length,
          `Failed to download ${failedDownload.length} mods:`), 'info');
        for (const { mod, error } of failedDownload) {
          this.ui.log(
            `${escapeHtml(error.code)} · <a href="${escapeHtml(this.fileLinkFor(mod))}" target="_blank" rel="noopener noreferrer">${escapeHtml(mod.file.name)}</a>`,
            'info'
          );
        }
      }

      this.showRunSummary({ sentMods, skipped, failedDownload, type });

      } catch (cause) {
        outcome = 'error';
        const error = Errors.fromException(cause, { context: 'Running collection download' });
        this.ui.logText(TS('logRunStopped', [Errors.toLogMessage(error)],
          `Collection download stopped: ${Errors.toLogMessage(error)}`), 'error');
      } finally {
        this.vortexRunProgress = null;
        this.ui.endDownload(outcome);
      }
    }

    // One more file of the Vortex run dealt with, on the deck and in the run's own count.
    advanceVortexRun() {
      if (this.vortexRunProgress) this.vortexRunProgress.done += 1;
      this.ui.incrementProgress();
    }

    async fetchRevisions() {
      const api = this.api();
      const response = api
        ? await api.collectionRevisions({
          slug: this.collectionId,
          domainName: this.gameId,
          signal: this.lifecycleSignal,
          timeoutMs: this.requestTimeout
        })
        : await this.fetchRevisionsLegacy();
      return this.readRevisions(response);
    }

    fetchRevisionsLegacy() {
      return Errors.request(NexusExt.NexusApi?.ROUTER_URL || 'https://api-router.nexusmods.com/graphql', {
        headers: { 'content-type': 'application/json' },
        referrer: document.location.href,
        referrerPolicy: 'strict-origin-when-cross-origin',
        body: JSON.stringify({
          query: 'query CollectionRevisions ($domainName: String, $slug: String!) { collection (domainName: $domainName, slug: $slug) { revisions {adultContent, createdAt, discardedAt, id, latest, revisionNumber, revisionStatus, totalSize, modCount, collectionChangelog { description, id}, gameVersions { reference } } } }',
          variables: { domainName: this.gameId, slug: this.collectionId },
          operationName: 'CollectionRevisions'
        }),
        method: 'POST',
        mode: 'cors',
        credentials: 'include'
      }, {
        timeoutMs: this.requestTimeout,
        context: 'Loading collection revisions',
        signal: this.lifecycleSignal
      });
    }

    readRevisions(response) {
      if (!response?.ok) {
        this.lastError = response.error;
        return null;
      }

      try {
        const json = JSON.parse(response.text);
        const revisions = json?.data?.collection?.revisions || null;
        if (!revisions) {
          this.lastError = graphqlFault(json, 'Loading collection revisions')
            || Errors.classifyContent(response.text, { context: 'Loading collection revisions' })
            || Errors.create('invalid_response', {
              context: 'Loading collection revisions',
              technicalMessage: 'no collection.revisions in the answer'
            });
        }
        return revisions;
      } catch (cause) {
        this.lastError = Errors.create('invalid_response', {
          context: 'Reading collection revisions',
          technicalMessage: String(cause?.message || '')
        });
        return null;
      }
    }

    // The newest published revision when it is newer than the one on screen, else null.
    async newerRevision() {
      if (this.external || !this.api()) return null;
      const current = Number(this.loadedRevision?.number);
      if (!current) return null;
      const revisions = await this.fetchRevisions();
      if (!Array.isArray(revisions)) return null;
      const newest = revisions
        .filter((rev) => String(rev?.revisionStatus || '').toLowerCase() === 'published' && !rev.discardedAt)
        .reduce((best, rev) => (Number(rev.revisionNumber) > Number(best?.revisionNumber || 0) ? rev : best), null);
      return newest && Number(newest.revisionNumber) > current ? newest : null;
    }

    // Mod details (version, endorse/track state) for every mod in the list, batched 50 per request.
    // Stored on each entry as `mod.api`. Resolves to the number of mods described.
    ensureApiDetails() {
      const api = this.api();
      if (!api || !this.mods?.all?.length) return Promise.resolve(0);
      if (this.apiDetailsPromise) return this.apiDetailsPromise;
      const pairs = this.mods.all.map((mod) => ({
        gameDomain: mod.file?.mod?.game?.domainName,
        modId: mod.file?.mod?.modId
      }));
      this.apiDetailsPromise = api.modsByDomain(pairs, { signal: this.lifecycleSignal }).then((details) => {
        let described = 0;
        for (const mod of this.mods.all) {
          const key = `${String(mod.file?.mod?.game?.domainName || '').toLowerCase()}:${mod.file?.mod?.modId}`;
          const detail = details.get(key);
          if (!detail) continue;
          mod.api = detail;
          described++;
        }
        return described;
      }).catch(() => 0);
      return this.apiDetailsPromise;
    }

    // True when the collection allows a newer file than the listed one and Nexus has a newer version.
    static updateAvailable(mod) {
      const policy = String(mod?.updatePolicy || 'exact').toLowerCase();
      if (policy === 'exact') return false;
      const latest = String(mod?.api?.version || mod?.file?.mod?.version || '').trim();
      const listed = String(mod?.version || mod?.file?.version || '').trim();
      return !!latest && !!listed && latest !== listed;
    }

    // Swaps files the curator lets float (updatePolicy latest/prefer) for the newest file in the same
    // download group, when the setting is on. Exact pins are never touched. Returns a new array.
    async applyUpdatePolicy(mods) {
      const api = this.api();
      const NexusApi = NexusExt.NexusApi;
      if (!api || !this.followUpdatePolicy || this.external || !NexusApi) return mods;
      const out = [];
      let changed = 0;
      for (const mod of mods) {
        const policy = String(mod?.updatePolicy || 'exact').toLowerCase();
        const gameNumericId = mod?.file?.mod?.game?.id;
        if (!['latest', 'prefer'].includes(policy) || !gameNumericId || this.isStopped()) {
          out.push(mod);
          continue;
        }
        const files = await api.modFiles({ modId: mod.file.mod.modId, gameId: gameNumericId, signal: this.lifecycleSignal });
        const next = NexusApi.resolveByPolicy(policy, files, mod.file.fileId);
        if (!next) {
          out.push(mod);
          continue;
        }
        changed++;
        const domain = mod.file.mod.game.domainName;
        out.push({
          ...mod,
          fileId: next.fileId,
          historyId: mod.historyId,
          file: {
            ...mod.file,
            fileId: next.fileId,
            name: next.name || mod.file.name,
            version: next.version || mod.file.version,
            size: Number(next.size) || mod.file.size,
            uri: next.uri || mod.file.uri,
            url: `https://www.nexusmods.com/${domain}/mods/${mod.file.mod.modId}?tab=files&file_id=${next.fileId}`
          }
        });
      }
      if (changed) {
        this.ui?.logText?.(NXTK.t('logUpdatePolicyApplied', [String(changed)],
          `Using newer files for ${changed} mods the collection allows to update.`), 'info');
      }
      return out;
    }
  }

  window.NexusExt.NDC = NDC;
  window.NexusExt.NDC_HELPERS = { pageNexusUserId };
  window.NexusExt.NDC_CONSTANTS = {
    DOWNLOAD_METHOD_VORTEX,
    DOWNLOAD_METHOD_BROWSER,
    STATUS_DOWNLOADING,
    STATUS_PAUSED,
    STATUS_FINISHED,
    STATUS_STOPPED,
    STATUS_TEXT,
    convertSize,
    formatDuration
  };
})();
