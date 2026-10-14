// Durable, opt-in technical reports. No secrets, page content, history or settings leave the device.
(function () {
  'use strict';
  const KEY = 'nxtk_auto_report_queue';
  const ALARM = 'nxtk-auto-reports';
  const WINDOW = 10 * 60 * 1000;
  const DAY = 24 * 60 * 60 * 1000;
  const MAX_PENDING = 20;
  const DAILY_MAX = 10;
  const LOCAL_ONLY = new Set(['offline', 'aborted', 'context_invalid', 'requires_login', 'cloudflare',
    'rate_limited', 'account_suspended', 'access_denied', 'file_not_found', 'mod_unavailable',
    'moderation_hold', 'missing_file', 'USER_CANCELED', 'USER_SHUTDOWN']);

  class Reporter {
    constructor({ kit, read, write, api, fetchImpl = (...args) => globalThis.fetch(...args), clock = () => Date.now() }) {
      Object.assign(this, { kit, read, write, api, fetchImpl, clock });
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
      const settings = await this.read(this.kit.SETTINGS_KEY, null);
      return settings?.AutoErrorReports === true;
    }

    async state() {
      const now = this.clock();
      const saved = await this.read(KEY, null) || {};
      const day = new Date(now).toISOString().slice(0, 10);
      return {
        day, count: saved.day === day ? Number(saved.count) || 0 : 0,
        attempts: saved.day === day ? Number(saved.attempts) || 0 : 0,
        cooldownUntil: Number(saved.cooldownUntil) || 0,
        sent: Object.fromEntries(Object.entries(saved.sent || {}).filter(([, at]) => now - at < DAY)),
        pending: (Array.isArray(saved.pending) ? saved.pending : []).filter((p) => now - p.createdAt < DAY).slice(0, MAX_PENDING)
      };
    }

    async schedule(state) {
      if (!state.pending.length) {
        await this.api.alarms.clear(ALARM);
        return;
      }
      let when = Math.max(this.clock() + 60000, state.cooldownUntil,
        Math.min(...state.pending.map((p) => p.nextAt)));
      if (state.count >= DAILY_MAX || state.attempts >= 30) {
        when = Math.max(when, Date.parse(`${state.day}T00:00:00Z`) + DAY);
      }
      await this.api.alarms.create(ALARM, { when });
    }

    async enqueue(entry) {
      const accepted = await this.serial(async () => {
        if (!await this.enabled() || LOCAL_ONLY.has(entry.causeCode || entry.code)) return false;
        const details = this.kit.autoReportDetails(entry);
        const version = this.api.runtime.getManifest().version;
        const fingerprint = `${version}|${details.reference}`;
        const state = await this.state();
        const now = this.clock();
        let pending = state.pending.find((p) => p.fingerprint === fingerprint);
        if (pending) {
          if (this.inFlight === fingerprint && !pending.extraFirstAt) pending.extraFirstAt = new Date(now).toISOString();
          pending.payload.occurrences = Math.min(10000, pending.payload.occurrences + 1);
          pending.payload.lastAt = new Date(now).toISOString();
        } else {
          if (state.pending.length >= MAX_PENDING) {
            const replace = details.severity === 'critical'
              ? state.pending.findIndex((p) => p.payload.severity !== 'critical' && p.fingerprint !== this.inFlight) : -1;
            if (replace < 0) return false;
            state.pending.splice(replace, 1);
          }
          pending = {
            fingerprint, createdAt: now, attempts: 0,
            nextAt: Math.max(now, (state.sent[fingerprint] || 0) + WINDOW),
            payload: {
              schema: this.kit.REPORT_SCHEMA_VERSION, kind: 'auto', version,
              browser: this.kit.reportBrowserName(globalThis.navigator?.userAgent),
              ...details, occurrences: 1,
              firstAt: new Date(now).toISOString(), lastAt: new Date(now).toISOString()
            }
          };
          state.pending.push(pending);
        }
        await this.write(KEY, state);
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
              await this.write(KEY, {});
              await this.api.alarms.clear(ALARM);
              return null;
            }
            const state = await this.state();
            const now = this.clock();
            state.pending.sort((a, b) => Number(b.payload.severity === 'critical') - Number(a.payload.severity === 'critical') || a.nextAt - b.nextAt);
            const item = state.pending.find((p) => p.nextAt <= now);
            if (!item || state.count >= DAILY_MAX || state.attempts >= 30 || state.cooldownUntil > now) {
              await this.write(KEY, state);
              await this.schedule(state);
              return null;
            }
            item.attempts += 1;
            state.attempts += 1;
            item.nextAt = now + Math.min(3600000, 60000 * 2 ** (item.attempts - 1));
            await this.write(KEY, state);
            await this.schedule(state);
            this.inFlight = item.fingerprint;
            return { fingerprint: item.fingerprint, payload: structuredClone(item.payload) };
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
            response = await this.fetchImpl(this.kit.RELAY_REPORT_URL, {
              method: 'POST', mode: 'cors', headers: { 'content-type': 'application/json' },
              body: JSON.stringify(attempt.payload), credentials: 'omit', signal: controller.signal
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
              await this.write(KEY, {});
              await this.api.alarms.clear(ALARM);
              return;
            }
            const state = await this.state();
            const item = state.pending.find((p) => p.fingerprint === attempt.fingerprint);
            if (!item) return;
            if (response?.ok && result?.ok === true) {
              state.sent[item.fingerprint] = this.clock();
              state.count += 1;
              const remaining = item.payload.occurrences - attempt.payload.occurrences;
              if (remaining > 0) {
                item.payload.occurrences = remaining;
                item.payload.firstAt = item.extraFirstAt || item.payload.lastAt;
                delete item.extraFirstAt;
                item.nextAt = this.clock() + WINDOW;
                item.attempts = 0;
              } else state.pending = state.pending.filter((p) => p !== item);
            } else if ([400, 413, 415, 422].includes(response?.status) || item.attempts >= 6) {
              state.pending = state.pending.filter((p) => p !== item);
            } else if (response?.status === 429) {
              const raw = response.headers?.get?.('retry-after');
              const seconds = Number(raw);
              const wait = raw && Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - this.clock();
              state.cooldownUntil = this.clock() + Math.min(DAY, Math.max(60000, wait || 3600000));
              item.nextAt = state.cooldownUntil;
            }
            await this.write(KEY, state);
            await this.schedule(state);
          });
        }
      })();
      this.running = run;
      const clear = () => { if (this.running === run) this.running = null; };
      run.then(clear, clear);
      return run;
    }

    stop() {
      this.generation += 1;
      this.controller?.abort();
      return this.serial(async () => {
        await this.write(KEY, {});
        await this.api.alarms.clear(ALARM);
      });
    }
  }

  globalThis.NXTKAutoReports = { Reporter, KEY, ALARM, WINDOW, DAILY_MAX };
})();
