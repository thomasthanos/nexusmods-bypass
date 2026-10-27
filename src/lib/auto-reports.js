// Durable, opt-in technical reports. Recent redacted logs and public file IDs require a second opt-in.
// No secrets, page content, history or settings leave the device.
(function () {
  'use strict';
  const KEY = 'nxtk_auto_report_queue';
  const ALARM = 'nxtk-auto-reports';
  const WINDOW = 60 * 60 * 1000;
  const NETWORK_WINDOW = 6 * WINDOW;
  const DAY = 24 * 60 * 60 * 1000;
  const MAX_PENDING = 20;
  const DAILY_MAX = 10;
  const LOCAL_ONLY = new Set(['offline', 'aborted', 'context_invalid', 'requires_login', 'cloudflare',
    'rate_limited', 'account_suspended', 'access_denied', 'file_not_found', 'mod_unavailable',
    'collection_unavailable', 'moderation_hold', 'missing_file', 'save_failed', 'USER_CANCELED', 'USER_SHUTDOWN']);

  const repeatWindow = (payload) => ['network_error', 'timeout'].includes(payload.error?.causeCode || payload.error?.code)
    ? NETWORK_WINDOW : WINDOW;

  class Reporter {
    constructor({ kit, read, write, api, fetchImpl = (...args) => globalThis.fetch(...args), clock = () => Date.now() }) {
      Object.assign(this, { kit, read, write, api, fetchImpl, clock });
      this.key = KEY;
      this.alarm = ALARM;
      this.url = kit.RELAY_REPORT_URL;
      this.tail = Promise.resolve();
      this.controller = null;
      this.running = null;
      this.generation = 0;
    }

    serial(task) {
      const next = this.tail.then(task, task);
      this.tail = next.catch(() => undefined);
      return next;
    }

    async enabled() {
      if (!this.kit.RELAY_CONFIGURED) return false;
      const settings = await this.read(this.kit.SETTINGS_KEY, null, { strict: true });
      return settings?.AutoErrorReports === true && settings?.PrivateDiagnostics !== true;
    }

    async prepareDelivery(item) { return item.payload; }
    deliveryAllowed() { return true; }
    deliveryAccepted(result) { return result?.ok === true; }

    async state() {
      const now = this.clock();
      // A transient storage failure must not replace durable reports with an empty queue.
      const saved = await this.read(this.key, null, { strict: true }) || {};
      const day = new Date(now).toISOString().slice(0, 10);
      return {
        day, count: saved.day === day ? Number(saved.count) || 0 : 0,
        attempts: saved.day === day ? Number(saved.attempts) || 0 : 0,
        cooldownUntil: Number(saved.cooldownUntil) || 0,
        sent: Object.fromEntries(Object.entries(saved.sent || {}).filter(([, at]) => now - at < DAY)),
        // A damaged entry (an older build, a storage fault) is dropped instead of stopping the queue.
        pending: (Array.isArray(saved.pending) ? saved.pending : [])
          .filter((p) => p && typeof p === 'object' && p.payload && typeof p.payload === 'object'
            && typeof p.fingerprint === 'string' && now - p.createdAt < DAY)
          .slice(0, MAX_PENDING)
          .map((p) => ({ ...p, nextAt: Math.max(p.nextAt, (saved.sent?.[p.fingerprint] || 0) + repeatWindow(p.payload)) }))
      };
    }

    async schedule(state) {
      if (!state.pending.length) {
        await this.api.alarms.clear(this.alarm);
        return;
      }
      let when = Math.max(this.clock() + 60000, state.cooldownUntil,
        Math.min(...state.pending.map((p) => p.nextAt)));
      if (state.count >= DAILY_MAX || state.attempts >= 30) {
        when = Math.max(when, Date.parse(`${state.day}T00:00:00Z`) + DAY);
      }
      await this.api.alarms.create(this.alarm, { when });
    }

    async enqueue(entry) {
      const accepted = await this.serial(async () => {
        if (!await this.enabled() || LOCAL_ONLY.has(entry.causeCode || entry.code)) return false;
        const details = this.kit.autoReportDetails(entry);
        const version = this.api.runtime.getManifest().version;
        const fingerprint = `${version}|${details.reference}`;
        const state = await this.state();
        const now = this.clock();
        const observedAt = Number.isFinite(entry.at) && entry.at > 0 ? Math.min(entry.at, now) : now;
        const settings = await this.read(this.kit.SETTINGS_KEY, null, { strict: true });
        const diagnostics = settings?.AutoReportDiagnostics === true
          ? this.kit.autoReportDiagnostics(entry, await this.read(this.kit.DEBUG_LOG_KEY, []), now) : null;
        let pending = state.pending.find((p) => p.fingerprint === fingerprint);
        if (pending) {
          if (this.inFlight === fingerprint && !pending.extraFirstAt) pending.extraFirstAt = new Date(observedAt).toISOString();
          pending.payload.occurrences = Math.min(10000, pending.payload.occurrences + 1);
          pending.payload.firstAt = new Date(Math.min(Date.parse(pending.payload.firstAt) || observedAt, observedAt)).toISOString();
          pending.payload.lastAt = new Date(Math.max(Date.parse(pending.payload.lastAt) || observedAt, observedAt)).toISOString();
          // Keep the latest incident snapshot, never collect unrelated logs at delivery time.
          if (diagnostics) pending.payload.diagnostics = diagnostics;
          else delete pending.payload.diagnostics;
        } else {
          if (state.pending.length >= MAX_PENDING) {
            const replace = details.severity === 'critical'
              ? state.pending.findIndex((p) => p.payload.severity !== 'critical' && p.fingerprint !== this.inFlight) : -1;
            if (replace < 0) return false;
            state.pending.splice(replace, 1);
          }
          pending = {
            fingerprint, createdAt: now, attempts: 0,
            nextAt: Math.max(now, (state.sent[fingerprint] || 0) + repeatWindow(details)),
            payload: {
              schema: this.kit.REPORT_SCHEMA_VERSION, kind: 'auto', version,
              browser: this.kit.reportBrowserName(globalThis.navigator?.userAgent),
              ...details, occurrences: 1,
              ...(diagnostics ? { diagnostics } : {}),
              firstAt: new Date(observedAt).toISOString(), lastAt: new Date(observedAt).toISOString()
            }
          };
          state.pending.push(pending);
        }
        await this.write(this.key, state);
        // Arm before attempting delivery: terminating a MV3 worker must not lose a report.
        await this.schedule(state);
        return true;
      });
      if (accepted) this.flush().catch(() => undefined);
      return accepted;
    }

    flush() {
      if (this.running) return this.running;
      const generation = this.generation;
      const run = (async () => {
        while (generation === this.generation) {
          const attempt = await this.serial(async () => {
            if (!await this.enabled()) {
              await this.clearPending();
              return null;
            }
            const state = await this.state();
            const now = this.clock();
            state.pending.sort((a, b) => Number(b.payload.severity === 'critical') - Number(a.payload.severity === 'critical') || a.nextAt - b.nextAt);
            const item = state.pending.find((p) => p.nextAt <= now);
            if (!item || state.count >= DAILY_MAX || state.attempts >= 30 || state.cooldownUntil > now) {
              await this.write(this.key, state);
              await this.schedule(state);
              return null;
            }
            item.attempts += 1;
            state.attempts += 1;
            item.nextAt = now + Math.min(3600000, 60000 * 2 ** (item.attempts - 1));
            const settings = await this.read(this.kit.SETTINGS_KEY, null, { strict: true });
            if (settings?.AutoReportDiagnostics !== true) delete item.payload.diagnostics;
            if (!this.deliveryAllowed(item, settings)) {
              state.pending = state.pending.filter((pending) => pending !== item);
              await this.write(this.key, state);
              await this.schedule(state);
              return null;
            }
            const body = await this.prepareDelivery(item);
            await this.write(this.key, state);
            await this.schedule(state);
            this.inFlight = item.fingerprint;
            return { fingerprint: item.fingerprint, payload: structuredClone(item.payload), body: structuredClone(body) };
          });
          if (!attempt || generation !== this.generation) return;
          // Storage transactions remain available while the network is slow. New occurrences are
          // added to the same item and subtracted only when this particular snapshot is delivered.
          this.controller = new AbortController();
          const controller = this.controller;
          const timer = setTimeout(() => controller.abort(), 15000);
          let response;
          let result;
          try {
            response = await this.fetchImpl(this.url, {
              method: 'POST', mode: 'cors', headers: { 'content-type': 'application/json' },
              body: JSON.stringify(attempt.body), credentials: 'omit', redirect: 'error', signal: controller.signal
            });
            if (response?.ok) result = await response.json();
          } catch (_) {
            // Reporting failures never create another report.
          } finally {
            clearTimeout(timer);
            if (this.controller === controller) this.controller = null;
          }
          await this.serial(async () => {
            this.inFlight = null;
            if (generation !== this.generation) return;
            if (!await this.enabled()) {
              await this.clearPending();
              return;
            }
            const state = await this.state();
            const item = state.pending.find((p) => p.fingerprint === attempt.fingerprint);
            if (!item) return;
            if (response?.ok && this.deliveryAccepted(result, attempt.body)) {
              state.sent[item.fingerprint] = this.clock();
              state.count += 1;
              const remaining = item.payload.occurrences - attempt.payload.occurrences;
              if (remaining > 0) {
                item.payload.occurrences = remaining;
                item.payload.firstAt = item.extraFirstAt || item.payload.lastAt;
                delete item.extraFirstAt;
                delete item.deliveryPayload;
                item.nextAt = this.clock() + repeatWindow(item.payload);
                item.attempts = 0;
              } else state.pending = state.pending.filter((p) => p !== item);
            } else {
              if ([400, 409, 413, 415, 422].includes(response?.status) || item.attempts >= 6) {
                state.pending = state.pending.filter((p) => p !== item);
              }
              // A final attempt can still announce a server-wide cooldown. Drop the exhausted
              // item without letting the next distinct fault retry into that same rate limit.
              if (response?.status === 429
                || (response?.status === 503 && response.headers?.get?.('retry-after'))) {
                // The relay's own allowance, Discord throttling the relay, or a Worker that said when to
                // come back: the whole queue waits, since every report would meet the same answer.
                const raw = response.headers?.get?.('retry-after');
                const seconds = Number(raw);
                const wait = raw && Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - this.clock();
                state.cooldownUntil = this.clock() + Math.min(DAY, Math.max(60000, wait || 3600000));
                item.nextAt = state.cooldownUntil;
              }
            }
            await this.write(this.key, state);
            await this.schedule(state);
          });
        }
      })().catch(async (cause) => {
        // Alarm events consume a one-shot alarm. A transient storage error before schedule()
        // must leave another wakeup, without trying to read that same unavailable storage.
        // Serialize with stop(): if it starts during alarm creation, its clear runs afterwards.
        await this.serial(async () => {
          if (generation === this.generation) {
            await this.api.alarms.create(this.alarm, { when: this.clock() + 60000 });
          }
        }).catch(() => undefined);
        throw cause;
      });
      this.running = run;
      const clear = () => { if (this.running === run) this.running = null; };
      run.then(clear, clear);
      return run;
    }

    stop() {
      this.generation += 1;
      this.controller?.abort();
      return this.serial(() => this.clearPending());
    }

    async clearPending() {
      // Revocation removes private payloads, not the allowance/cooldowns already consumed.
      const state = await this.state();
      state.pending = [];
      await this.write(this.key, state);
      await this.api.alarms.clear(this.alarm);
    }
  }

  const DIAGNOSTICS_KEY = 'nxtk_private_diagnostics_queue_v1';
  const DIAGNOSTICS_ALARM = 'nxtk-private-diagnostics';
  const INSTALL_SEED_KEY = 'nxtk_private_diagnostics_seed_v1';

  function reportEnvironment(browserName, ua = '') {
    const browser = /^Opera\b/i.test(browserName) ? 'opera'
      : /^Edge\b/i.test(browserName) ? 'edge' : /^Firefox\b/i.test(browserName) ? 'firefox'
        : /^Brave\b/i.test(browserName) ? 'brave' : /^Chrome\b/i.test(browserName) ? 'chrome'
          : /^Safari\b/i.test(browserName) ? 'safari' : 'other';
    const browser_version = String(browserName).match(/\b\d+(?:\.\d+)*\b/)?.[0] || 'unknown';
    const os = /CrOS/i.test(ua) ? 'chromeos' : /Android/i.test(ua) ? 'android'
      : /iPhone|iPad|iPod/i.test(ua) ? 'ios' : /Windows/i.test(ua) ? 'windows'
        : /Macintosh|Mac OS X/i.test(ua) ? 'macos' : /Linux/i.test(ua) ? 'linux' : 'other';
    return { browser, browser_version, os };
  }

  // A separate opt-in authorizes the new installation hash and OS field. The legacy preference
  // alone never creates an identifier or sends to the private dashboard. This queue uses exactly
  // the same bounded retries and sampling policy as legacy automatic reporting.
  class DiagnosticsReporter extends Reporter {
    constructor(deps) {
      super(deps);
      this.key = DIAGNOSTICS_KEY;
      this.alarm = DIAGNOSTICS_ALARM;
      this.url = `${deps.kit.RELAY_ORIGIN}/v1/diagnostics`;
    }

    async enabled() {
      if (!this.kit.RELAY_CONFIGURED) return false;
      const settings = await this.read(this.kit.SETTINGS_KEY, null, { strict: true });
      return settings?.AutoErrorReports === true && settings?.PrivateDiagnostics === true;
    }

    deliveryAllowed(item, settings) {
      // A worker may have been asleep when extended consent was revoked. Do not retry a frozen
      // body containing logs, or rewrite the same UUID with a different body after an uncertain send.
      return settings?.AutoReportDiagnostics === true || !item.deliveryPayload?.breadcrumbs?.length;
    }

    deliveryAccepted(result, body) {
      return result?.ok === true && typeof result.report_id === 'string'
        && result.report_id.toLowerCase() === body.report_id;
    }

    async prepareDelivery(item) {
      // A response may be lost after persistence at the server. Reusing both UUID and exact body
      // makes every retry idempotent, including after the MV3 worker has been suspended.
      if (item.deliveryPayload) return item.deliveryPayload;
      let seed = await this.read(INSTALL_SEED_KEY, null, { strict: true });
      if (typeof seed !== 'string' || !/^[0-9a-f-]{36}$/.test(seed)) {
        seed = globalThis.crypto.randomUUID();
        await this.write(INSTALL_SEED_KEY, seed);
      }
      const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
      const install_id = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      const source = item.payload;
      const error = source.error;
      const flow = `${error.action || ''} ${error.context || ''}`;
      const identifier = (value, fallback) => {
        const clean = String(value || '').replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80);
        return /^[A-Za-z]/.test(clean) ? clean : fallback;
      };
      const code = identifier(error.causeCode || error.code, 'REQUEST_FAILED');
      const category = error.code === 'nexus_page_changed' ? 'DOM_SELECTOR_MISSING'
        : error.code === 'nexus_api_changed' ? 'API_SCHEMA_MISMATCH' : identifier(error.code, 'UNKNOWN_ERROR');
      const logs = (source.diagnostics?.consent === 'extended-v1' ? source.diagnostics.logs || [] : [])
        .filter((line) => Number.isFinite(Date.parse(line?.at))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      const firstAt = logs[0]?.at ? Date.parse(logs[0].at) : Date.parse(source.firstAt);
      item.deliveryPayload = {
        schema_version: 1, consent: 'diagnostics-v1', report_id: globalThis.crypto.randomUUID(), install_id,
        occurred_at: source.firstAt, version: source.version,
        ...reportEnvironment(source.browser, globalThis.navigator?.userAgent || ''),
        download_mode: /automatic|collection run|queued/i.test(flow) ? 'auto' : 'manual',
        destination: /vortex|nxm:/i.test(flow) ? 'vortex' : 'browser',
        severity: source.severity === 'critical' ? 'fatal' : 'error',
        error_category: category, error_code: code, failure_stage: category,
        error_name: 'ExtensionError',
        error_message: this.kit.sanitizeDiagnosticText(error.message || error.context || error.code || 'Extension error', 2048),
        // "fn@script:line:col" becomes "fn@ext://script:line:col", a stack line the dashboard's parser reads.
        ...(error.frame ? { stack_trace: error.frame.includes('@') ? error.frame.replace('@', '@ext://') : `ext://${error.frame}` } : {}),
        ...(Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? { http_status: error.status } : {}),
        breadcrumbs: logs.map((line) => ({
          timestamp_offset_ms: Math.max(0, Math.min(86400000, Date.parse(line.at) - firstAt)),
          stage: 'extension', action: 'debug_log', status: line.level === 'error' ? 'error' : line.level === 'warn' ? 'warn' : 'ok',
          metadata: { detail: this.kit.sanitizeDiagnosticText(line.text, 400) }
        })),
        context: {}
      };
      return item.deliveryPayload;
    }
  }

  globalThis.NXTKAutoReports = { Reporter, DiagnosticsReporter, KEY, ALARM, DIAGNOSTICS_KEY, DIAGNOSTICS_ALARM, INSTALL_SEED_KEY, reportEnvironment, WINDOW, NETWORK_WINDOW, DAILY_MAX };
})();
