// The report page: builds the exact payload, shows it, and sends it only on an explicit click. The
// relay origin is an optional host permission requested here, inside that click, the first time.
// Before sending, the relay's health is checked; any failure names its cause and offers a retry
// (when retrying can help) and a prefilled GitHub issue with the full JSON on the clipboard.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const T = (key, fallback, subs = null) => NXTK.t(key, subs, fallback);
  let payload = null;
  let rebuildTimer = null;

  const RETRYABLE = new Set(['unreachable', 'server_error', 'rate_limited']);

  function status(text, kind = '') {
    const el = $('rpStatus');
    el.textContent = text;
    el.className = `rp-status${kind ? ` is-${kind}` : ''}`;
  }

  function failureText(reason, retryAfterSeconds = 0) {
    switch (reason) {
      case 'not_configured':
        return T('rpErrNotConfigured', 'The report server is not set up yet, so reports cannot be sent from here.');
      case 'unreachable':
        return T('rpErrUnreachable', 'The report server could not be reached. Check your connection and try again.');
      case 'rate_limited': {
        const minutes = String(Math.max(1, Math.ceil((retryAfterSeconds || 3600) / 60)));
        return T('rpErrRateLimited', `Too many reports from this network. Try again in about ${minutes} minutes.`, [minutes]);
      }
      case 'permission':
        return T('rpPermissionDenied', 'Permission to reach the report server was not granted. Copy the report or open a GitHub issue instead.');
      case 'too_large':
        return T('rpErrTooLarge', 'The report is too large for the report server. Turn off debug logs and try again.');
      case 'rejected':
        return T('rpErrRejected', 'The report server did not accept this report.');
      default:
        return T('rpErrServer', 'The report server had a problem. Try again in a moment.');
    }
  }

  function showFailure(reason, retryAfterSeconds = 0) {
    status(failureText(reason, retryAfterSeconds), 'error');
    $('rpFallback').hidden = false;
    $('rpRetry').hidden = !RETRYABLE.has(reason);
  }

  function hideFailure() {
    $('rpFallback').hidden = true;
    $('rpRetry').hidden = true;
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
    if (!NXTK.RELAY_CONFIGURED) { showFailure('not_configured'); return; }
    button.disabled = true;
    $('rpRetry').disabled = true;
    hideFailure();
    try {
      // Requested first, while the click still counts as a user gesture.
      if (!await ensureRelayPermission()) { showFailure('permission'); return; }
      status(T('rpChecking', 'Checking the report server…'));
      const health = await NXTK.checkRelayHealth();
      if (!health.ok) { showFailure(health.reason); return; }
      status(T('rpSending', 'Sending…'));
      await rebuild();
      const result = await NXTK.sendReportPayload(payload);
      if (result.ok) {
        status(T('rpSent', `Report sent. Thank you! Reference: ${result.id || '—'}`, [result.id || '—']), 'ok');
      } else {
        showFailure(result.reason, result.retryAfterSeconds);
      }
    } catch (_) {
      showFailure('server_error');
    } finally {
      button.disabled = !NXTK.RELAY_CONFIGURED;
      $('rpRetry').disabled = false;
    }
  }

  async function copy() {
    await rebuild();
    const ok = await NXTK.copyText(JSON.stringify(payload, null, 2));
    status(ok ? T('rpCopied', 'Report copied to the clipboard.') : T('rpCopyFailed', 'Could not copy to the clipboard. Select the report above and copy it by hand.'), ok ? 'ok' : 'error');
  }

  // Prefilled issue (shortened to fit a URL) plus the full JSON on the clipboard to paste in.
  async function github() {
    await rebuild().catch(() => undefined);
    const copied = payload ? await NXTK.copyText(JSON.stringify(payload, null, 2)) : false;
    const result = await NXTK.buildReportIssueUrl();
    window.open(result.url, '_blank', 'noopener,noreferrer');
    if (copied) status(T('rpGithubCopied', 'GitHub opened in a new tab. The full report JSON is on your clipboard: paste it into the issue.'), 'ok');
  }

  function applyRelayState() {
    if (NXTK.RELAY_CONFIGURED) return;
    const send = $('rpSend');
    send.disabled = true;
    send.textContent = T('rpSendUnavailable', 'Sending is not available yet');
    send.title = failureText('not_configured');
    send.classList.replace('nxtk-btn-primary', 'nxtk-btn-secondary');
    $('rpGithub').classList.replace('nxtk-btn-secondary', 'nxtk-btn-primary');
    $('rpAuto').disabled = true;
    status(failureText('not_configured'));
  }

  async function initAuto() {
    const stored = await chrome.storage.local.get(NXTK.SETTINGS_KEY);
    $('rpAuto').checked = NXTK.RELAY_CONFIGURED && !!stored?.[NXTK.SETTINGS_KEY]?.AutoErrorReports;
    $('rpAuto').addEventListener('change', async (event) => {
      const enabled = event.target.checked;
      if (enabled && !await ensureRelayPermission()) {
        event.target.checked = false;
        status(failureText('permission'), 'error');
        return;
      }
      chrome.runtime.sendMessage({ type: 'SETTINGS_PATCH', payload: { patch: { AutoErrorReports: enabled } } }, () => void chrome.runtime.lastError);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    NXTK.applyI18nTo?.(document);
    applyRelayState();
    $('rpSend').addEventListener('click', () => send());
    $('rpRetry').addEventListener('click', () => send());
    $('rpCopy').addEventListener('click', () => copy().catch(() => undefined));
    $('rpFallbackCopy').addEventListener('click', () => copy().catch(() => undefined));
    $('rpGithub').addEventListener('click', () => github().catch(() => undefined));
    $('rpFallbackGithub').addEventListener('click', () => github().catch(() => undefined));
    for (const id of ['rpNote', 'rpContact']) $(id).addEventListener('input', scheduleRebuild);
    $('rpIncludeLogs').addEventListener('change', scheduleRebuild);
    initAuto().catch(() => undefined);
    rebuild().catch(() => status(failureText('server_error'), 'error'));
  });
})();
