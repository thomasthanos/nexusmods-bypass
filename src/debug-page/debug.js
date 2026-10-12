(function () {
  const NXTK = globalThis.NXTK;
  const V = globalThis.NXTK_DEBUG_VIEW;
  const $ = (id) => document.getElementById(id);
  let entries = [];
  let shown = [];

  function read() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([NXTK.DEBUG_LOG_KEY, NXTK.SETTINGS_KEY], (r) => resolve(r || {}));
      } catch (_) {
        resolve({});
      }
    });
  }

  function render() {
    shown = V.filterEntries(entries, { minLevel: $('dbLevelFilter').value, query: $('dbSearch').value });
    const log = $('dbLog');
    const frag = document.createDocumentFragment();
    for (const e of shown) {
      const row = document.createElement('div');
      row.className = `db-row db-${e.level}`;
      const time = document.createElement('time');
      time.textContent = V.formatTime(e.at);
      const level = document.createElement('span');
      level.className = 'db-level';
      level.textContent = e.level;
      const page = document.createElement('span');
      page.className = 'db-page';
      page.textContent = e.page;
      const text = document.createElement('span');
      text.className = 'db-text';
      text.textContent = e.text; // textContent only: log lines are never parsed as HTML
      row.append(time, level, page, text);
      frag.append(row);
    }
    log.replaceChildren(frag);
    $('dbEmpty').hidden = shown.length > 0;
    const c = V.countByLevel(entries);
    $('dbCount').textContent = (NXTK.t?.('dbCount', [String(shown.length), String(entries.length)]) || `${shown.length} of ${entries.length} entries`)
      + ` · error ${c.error} · warn ${c.warn}`;
    if ($('dbFollow').checked) log.scrollTop = log.scrollHeight;
  }

  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function load() {
    const r = await read();
    entries = Array.isArray(r[NXTK.DEBUG_LOG_KEY]) ? r[NXTK.DEBUG_LOG_KEY] : [];
    $('dbOff').hidden = !!r[NXTK.SETTINGS_KEY]?.DebugLogs;
    render();
  }

  document.addEventListener('DOMContentLoaded', () => {
    NXTK.applyI18nTo?.(document);
    document.documentElement.lang = chrome.i18n?.getUILanguage?.() || 'en';
    const version = chrome.runtime.getManifest().version;
    $('dbVersion').textContent = `v${version}`;
    $('dbLevelFilter').addEventListener('change', render);
    $('dbSearch').addEventListener('input', render);
    const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    $('dbExportTxt').addEventListener('click', () => download(`nexusmods-bypass-debug-${stamp()}.txt`, V.exportText(shown, { version }), 'text/plain'));
    $('dbExportJson').addEventListener('click', () => download(`nexusmods-bypass-debug-${stamp()}.json`, V.exportJson(shown, { version }), 'application/json'));
    $('dbClear').addEventListener('click', () => {
      if (!confirm(NXTK.t?.('dbClearConfirm') || 'Clear the debug log?')) return;
      chrome.runtime.sendMessage({ type: 'DEBUG_LOG_CLEAR' }, () => { void chrome.runtime.lastError; load(); });
    });
    // Live view: the background worker writes the ring buffer; re-render whenever it changes.
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area === 'local' && (changes[NXTK.DEBUG_LOG_KEY] || changes[NXTK.SETTINGS_KEY])) load();
    });
    load();
  });
})();
