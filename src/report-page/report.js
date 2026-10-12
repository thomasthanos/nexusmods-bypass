// The report page: builds the exact payload, shows it, and sends it only on an explicit click. The
// relay origin is an optional host permission requested here, inside that click, the first time.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const T = (key, fallback, subs = null) => NXTK.t(key, subs, fallback);
  let payload = null;
  let rebuildTimer = null;

  function status(text, kind = '') {
    const el = $('rpStatus');
    el.textContent = text;
    el.className = `rp-status${kind ? ` is-${kind}` : ''}`;
  }

  async function rebuild() {
    payload = await NXTK.buildReportPayload(null, {
      note: $('rpNote').value,
      contact: $('rpContact').value.trim(),
      includeDebug: $('rpIncludeLogs').checked
    });
    $('rpPreview').textContent = JSON.stringify(payload, null, 2);
  }

  function scheduleRebuild() {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => rebuild().catch(() => undefined), 250);
  }

  async function ensureRelayPermission() {
    try {
      if (await chrome.permissions.contains(NXTK.RELAY_PERMISSION)) return true;
      return await chrome.permissions.request(NXTK.RELAY_PERMISSION);
    } catch (_) {
      return false;
    }
  }

  async function send() {
    const button = $('rpSend');
    button.disabled = true;
    try {
      // Requested first, while the click still counts as a user gesture.
      if (!await ensureRelayPermission()) {
        status(T('rpPermissionDenied', 'Permission to reach the report server was not granted. Copy the report or open a GitHub issue instead.'), 'error');
        return;
      }
      await rebuild();
      const result = await NXTK.sendReportPayload(payload);
      if (result.ok) {
        status(T('rpSent', `Report sent. Thank you! Reference: ${result.id || '—'}`, [result.id || '—']), 'ok');
      } else {
        status(T('rpSendFailed', 'The report could not be sent. Copy it or open a GitHub issue instead.'), 'error');
      }
    } catch (_) {
      status(T('rpSendFailed', 'The report could not be sent. Copy it or open a GitHub issue instead.'), 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function copy() {
    await rebuild();
    const ok = await NXTK.copyText(JSON.stringify(payload, null, 2));
    status(ok ? T('rpCopied', 'Report copied to the clipboard.') : T('rpSendFailed', 'The report could not be sent. Copy it or open a GitHub issue instead.'), ok ? 'ok' : 'error');
  }

  async function github() {
    const result = await NXTK.buildReportIssueUrl();
    if (!result.complete && result.report) await NXTK.copyText(result.report);
    window.open(result.url, '_blank', 'noopener,noreferrer');
  }

  async function initAuto() {
    const stored = await chrome.storage.local.get(NXTK.SETTINGS_KEY);
    $('rpAuto').checked = !!stored?.[NXTK.SETTINGS_KEY]?.AutoErrorReports;
    $('rpAuto').addEventListener('change', async (event) => {
      const enabled = event.target.checked;
      if (enabled && !await ensureRelayPermission()) {
        event.target.checked = false;
        status(T('rpPermissionDenied', 'Permission to reach the report server was not granted. Copy the report or open a GitHub issue instead.'), 'error');
        return;
      }
      chrome.runtime.sendMessage({ type: 'SETTINGS_PATCH', payload: { patch: { AutoErrorReports: enabled } } }, () => void chrome.runtime.lastError);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    NXTK.applyI18nTo?.(document);
    $('rpSend').addEventListener('click', () => send());
    $('rpCopy').addEventListener('click', () => copy().catch(() => undefined));
    $('rpGithub').addEventListener('click', () => github().catch(() => undefined));
    for (const id of ['rpNote', 'rpContact']) $(id).addEventListener('input', scheduleRebuild);
    $('rpIncludeLogs').addEventListener('change', scheduleRebuild);
    initAuto().catch(() => undefined);
    rebuild().catch(() => status(T('rpSendFailed', 'The report could not be sent. Copy it or open a GitHub issue instead.'), 'error'));
  });
})();
