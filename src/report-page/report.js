// The report page: builds the exact payload, shows it, and sends it only on an explicit click. The
// relay accepts standard CORS requests, so sending needs no additional host permission.
// Before sending, the relay's health is checked; any failure names its cause and offers a retry
// (when retrying can help) and a prefilled GitHub issue with the full JSON on the clipboard.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const T = (key, fallback, subs = null) => NXTK.t(key, subs, fallback);
  let payload = null;
  let selectedError = null;
  try {
    if (location.hash.length > 1 && location.hash.length < 16000) {
      const decoded = JSON.parse(decodeURIComponent(location.hash.slice(1)));
      if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) selectedError = NXTK.buildErrorEntry(decoded);
      history.replaceState(null, '', location.pathname);
    }
  } catch (_) { }

  let rebuildTimer = null;
  let rebuildSequence = 0;
  let sending = false;
  let sent = false;
  let payloadInputSignature = '';

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
    const sequence = ++rebuildSequence;
    const options = {
      note: $('rpNote').value,
      contact: $('rpContact').value.trim(),
      includeDebug: $('rpIncludeLogs').checked,
      summary: $('rpSummary').value,
      category: document.querySelector('input[name="category"]:checked')?.value || 'other',
      steps: $('rpSteps').value,
      expected: $('rpExpected').value
    };
    const signature = JSON.stringify(options);
    // Copy, save and send use the exact reviewed snapshot until a form field changes.
    if (payload && payloadInputSignature === signature) return;
    const next = await NXTK.buildReportPayload(selectedError, options);
    if (sequence !== rebuildSequence) return;
    payload = next;
    payloadInputSignature = signature;
    const json = JSON.stringify(payload, null, 2);
    $('rpPreview').textContent = json;
    $('rpSize').textContent = `${(new TextEncoder().encode(JSON.stringify(payload)).length / 1024).toFixed(1)} KB`;
    $('rpEnvironmentVersion').textContent = `v${payload.version}`;
    $('rpEnvironmentBrowser').textContent = payload.browser;
    $('rpErrorCount').textContent = payload.errors.length;
    $('rpLogCount').textContent = payload.logs.length;
    const error = payload.currentError;
    $('rpErrorContext').hidden = !error;
    $('rpNoErrors').hidden = !!error;
    $('rpErrorCode').textContent = error ? `${payload.reference} · ${error.code}` : '';
    $('rpErrorMessage').textContent = error?.userMessage || '';
    $('rpErrorUrl').textContent = error?.url || '';
    $('rpNotePreview').hidden = !payload.summary && !payload.note;
    $('rpSummaryPreview').textContent = payload.summary;
    $('rpDescriptionPreview').textContent = payload.note;
    $('rpNoteCount').textContent = `${$('rpNote').value.length.toLocaleString()} / 2,000`;
  }

  function scheduleRebuild() {
    ++rebuildSequence;
    clearTimeout(rebuildTimer);
    sent = false;
    $('rpSuccess').hidden = true;
    $('rpSend').disabled = !NXTK.RELAY_CONFIGURED || sending;
    $('rpSendLabel').textContent = T('rpSend', 'Send report');
    if (['rpNote', 'rpSummary', 'rpContact'].some(id => $(id).getAttribute('aria-invalid') === 'true')) status('');
    for (const id of ['rpNote', 'rpSummary', 'rpContact']) $(id).removeAttribute('aria-invalid');
    rebuildTimer = setTimeout(() => rebuild().catch(() => undefined), 250);
  }

  function setBusy(busy) {
    sending = busy;
    $('rpSend').setAttribute('aria-busy', String(busy));
    $('rpSend').disabled = busy || sent || !NXTK.RELAY_CONFIGURED;
    $('rpRetry').disabled = busy;
    for (const input of document.querySelectorAll('#rpForm input, #rpForm textarea, #rpIncludeLogs')) input.disabled = busy;
    for (const id of ['rpCopy', 'rpSave', 'rpGithub', 'rpFallbackCopy', 'rpFallbackGithub']) $(id).disabled = busy;
  }

  function validate() {
    if (!$('rpSummary').value.trim() && !$('rpNote').value.trim()) {
      $('rpSummary').setAttribute('aria-invalid', 'true');
      status(T('rpDescribeRequired', 'Add a summary or describe the problem before sending.'), 'error');
      $('rpSummary').focus();
      return false;
    }
    if (!$('rpContact').checkValidity()) {
      $('rpContact').setAttribute('aria-invalid', 'true');
      status(T('rpEmailInvalid', 'Enter a valid e-mail address or leave the field empty.'), 'error');
      $('rpContact').focus();
      return false;
    }
    return true;
  }

  function send() {
    if (sending || sent || !validate()) return undefined;
    if (!NXTK.RELAY_CONFIGURED) { showFailure('not_configured'); return undefined; }
    return deliver();
  }

  async function deliver() {
    clearTimeout(rebuildTimer);
    setBusy(true);
    hideFailure();
    try {
      status(T('rpChecking', 'Checking the report server…'));
      const health = await NXTK.checkRelayHealth();
      if (!health.ok) { showFailure(health.reason); return; }
      status(T('rpSending', 'Sending…'));
      await rebuild();
      const result = await NXTK.sendReportPayload(payload);
      if (result.ok) {
        sent = true;
        $('rpSuccess').hidden = false;
        $('rpReference').textContent = result.id || '—';
        $('rpSendLabel').textContent = T('rpSentButton', 'Report sent');
        status(T('rpSent', `Report sent. Thank you! Reference: ${result.id || '—'}`, [result.id || '—']), 'ok');
      } else {
        showFailure(result.reason, result.retryAfterSeconds);
      }
    } catch (_) {
      showFailure('server_error');
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    await rebuild();
    const ok = await NXTK.copyText(JSON.stringify(payload, null, 2));
    if (!ok) {
      selectTab(true);
      $('rpPreview').focus();
    }
    status(ok ? T('rpCopied', 'Report copied to the clipboard.') : T('rpCopyFailed', 'Could not copy to the clipboard. Select the report above and copy it by hand.'), ok ? 'ok' : 'error');
  }

  // Prefilled issue (shortened to fit a URL) plus the full JSON on the clipboard to paste in.
  async function github() {
    // Open synchronously while the browser still has the user gesture; build the contents locally.
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    try {
      await rebuild();
      const publicPayload = { ...payload, contact: '' };
      const copied = await NXTK.copyText(JSON.stringify(publicPayload, null, 2));
      const result = NXTK.buildPayloadIssueUrl(publicPayload);
      if (tab) tab.location.replace(result.url);
      else chrome.tabs.create({ url: result.url });
      if (copied) status(T('rpGithubCopied', 'GitHub opened in a new tab. The full report JSON is on your clipboard: paste it into the issue.'), 'ok');
    } catch (cause) {
      tab?.close();
      status(failureText('server_error'), 'error');
    }
  }

  async function save() {
    await rebuild();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `nexusmods-report-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function selectTab(json, focus = false) {
    $('rpOverview').hidden = json;
    $('rpJsonPanel').hidden = !json;
    for (const [id, active] of [['rpSummaryTab', !json], ['rpJsonTab', json]]) {
      $(id).setAttribute('aria-selected', String(active));
      $(id).tabIndex = active ? 0 : -1;
      if (focus && active) $(id).focus();
    }
  }

  function applyRelayState() {
    if (NXTK.RELAY_CONFIGURED) return;
    const send = $('rpSend');
    send.disabled = true;
    $('rpSendLabel').textContent = T('rpSendUnavailable', 'Sending is not available yet');
    send.title = failureText('not_configured');
    send.classList.replace('rp-primary', 'rp-secondary');
    $('rpGithub').classList.add('rp-primary');
    $('rpAuto').disabled = true;
    $('rpAutoDetails').disabled = true;
    status(failureText('not_configured'));
  }

  async function initAuto() {
    const stored = await chrome.storage.local.get(NXTK.SETTINGS_KEY);
    $('rpAuto').checked = NXTK.RELAY_CONFIGURED && !!stored?.[NXTK.SETTINGS_KEY]?.AutoErrorReports;
    $('rpAutoDetails').checked = $('rpAuto').checked && stored?.[NXTK.SETTINGS_KEY]?.AutoReportDiagnostics === true;
    const refresh = () => {
      $('rpAuto').disabled = !NXTK.RELAY_CONFIGURED;
      $('rpAutoDetails').disabled = !NXTK.RELAY_CONFIGURED || !$('rpAuto').checked;
    };
    refresh();
    for (const [id, key] of [['rpAuto', 'AutoErrorReports'], ['rpAutoDetails', 'AutoReportDiagnostics']]) {
      $(id).addEventListener('change', async (event) => {
        const enabled = event.target.checked;
        const previousDetails = $('rpAutoDetails').checked;
        $('rpAuto').disabled = $('rpAutoDetails').disabled = true;
        const patch = { [key]: enabled };
        if (key === 'AutoErrorReports' && !enabled) {
          patch.AutoReportDiagnostics = false;
          $('rpAutoDetails').checked = false;
        }
        try {
          const reply = await chrome.runtime.sendMessage({ type: 'SETTINGS_PATCH', payload: { patch } });
          if (!reply?.ok) throw new Error('settings-write-failed');
        } catch (_) {
          event.target.checked = !enabled;
          if (key === 'AutoErrorReports') $('rpAutoDetails').checked = previousDetails;
          status(T('rpSettingFailed', 'The setting could not be saved. Try again.'), 'error');
        } finally {
          refresh();
        }
      });
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    NXTK.applyI18nTo?.(document);
    document.documentElement.lang = chrome.i18n.getUILanguage();
    $('rpVersion').textContent = `v${chrome.runtime.getManifest().version}`;
    applyRelayState();
    $('rpForm').addEventListener('submit', (event) => { event.preventDefault(); send(); });
    $('rpRetry').addEventListener('click', () => send());
    $('rpCopy').addEventListener('click', () => copy().catch(() => undefined));
    $('rpSave').addEventListener('click', () => save().catch(() => status(failureText('server_error'), 'error')));
    $('rpFallbackCopy').addEventListener('click', () => copy().catch(() => undefined));
    $('rpGithub').addEventListener('click', () => github().catch(() => undefined));
    $('rpFallbackGithub').addEventListener('click', () => github().catch(() => undefined));
    for (const id of ['rpNote', 'rpContact', 'rpSummary', 'rpSteps', 'rpExpected']) $(id).addEventListener('input', scheduleRebuild);
    for (const input of document.querySelectorAll('input[name="category"]')) input.addEventListener('change', scheduleRebuild);
    $('rpIncludeLogs').addEventListener('change', scheduleRebuild);
    $('rpSummaryTab').addEventListener('click', () => selectTab(false));
    $('rpJsonTab').addEventListener('click', () => selectTab(true));
    document.querySelector('.rp-tabs').addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const json = event.key === 'End' || (event.key !== 'Home' && $('rpJsonTab').getAttribute('aria-selected') !== 'true');
      selectTab(json, true);
    });
    initAuto().catch(() => undefined);
    rebuild().catch(() => status(failureText('server_error'), 'error'));
  });
})();
