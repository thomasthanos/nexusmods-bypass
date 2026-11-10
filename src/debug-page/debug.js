(function () {
  const NXTK = globalThis.NXTK;
  const V = globalThis.NXTK_DEBUG_VIEW;
  const $ = (id) => document.getElementById(id);

  let entries = [];
  let shown = [];
  let isPaused = false;
  let toastTimer = null;

  function showToast(message) {
    const toast = $('dbToast');
    if (!toast) return;
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 2200);
  }

  function read() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([NXTK.DEBUG_LOG_KEY, NXTK.SETTINGS_KEY], (r) => resolve(r || {}));
      } catch (_) {
        resolve({});
      }
    });
  }

  function appendHighlighted(parent, text, query) {
    if (!query) {
      parent.textContent = text;
      return;
    }
    const q = query.toLowerCase();
    const lower = text.toLowerCase();
    let start = 0;
    let idx = lower.indexOf(q, start);
    if (idx === -1) {
      parent.textContent = text;
      return;
    }
    while (idx !== -1) {
      if (idx > start) {
        parent.appendChild(document.createTextNode(text.slice(start, idx)));
      }
      const mark = document.createElement('mark');
      mark.className = 'db-highlight';
      mark.textContent = text.slice(idx, idx + q.length);
      parent.appendChild(mark);
      start = idx + q.length;
      idx = lower.indexOf(q, start);
    }
    if (start < text.length) {
      parent.appendChild(document.createTextNode(text.slice(start)));
    }
  }

  function syncComponentOptions() {
    const select = $('dbPageFilter');
    if (!select) return;
    const current = select.value || 'all';
    const components = V.getComponents ? V.getComponents(entries) : [];
    const frag = document.createDocumentFragment();

    const optAll = document.createElement('option');
    optAll.value = 'all';
    optAll.textContent = 'All components';
    frag.appendChild(optAll);

    for (const comp of components) {
      const opt = document.createElement('option');
      opt.value = comp.toLowerCase();
      opt.textContent = comp;
      frag.appendChild(opt);
    }

    select.replaceChildren(frag);
    if (components.map((c) => c.toLowerCase()).includes(current)) {
      select.value = current;
    } else {
      select.value = 'all';
    }
  }

  function syncStatPills(counts, total) {
    if ($('badgeAll')) $('badgeAll').textContent = String(total);
    if ($('badgeError')) $('badgeError').textContent = String(counts.error || 0);
    if ($('badgeWarn')) $('badgeWarn').textContent = String(counts.warn || 0);
    if ($('badgeInfo')) $('badgeInfo').textContent = String(counts.info || 0);
    if ($('badgeDebug')) $('badgeDebug').textContent = String(counts.debug || 0);

    const level = $('dbLevelFilter')?.value || 'all';
    document.querySelectorAll('.db-stat-pill').forEach((pill) => {
      const pLevel = pill.dataset.level;
      pill.classList.toggle('is-active', pLevel === level);
    });
  }

  function render() {
    const minLevel = $('dbLevelFilter')?.value || 'all';
    const query = $('dbSearch')?.value || '';
    const page = $('dbPageFilter')?.value || 'all';

    shown = V.filterEntries(entries, { minLevel, query, page });

    const log = $('dbLog');
    const frag = document.createDocumentFragment();

    for (const e of shown) {
      const row = document.createElement('div');
      row.className = `db-row db-${e.level}`;
      row.tabIndex = 0;

      const time = document.createElement('time');
      time.textContent = V.formatTime(e.at);
      time.title = new Date(e.at).toISOString();

      const level = document.createElement('span');
      level.className = 'db-level';
      level.textContent = e.level;

      const pageEl = document.createElement('span');
      pageEl.className = 'db-page';
      appendHighlighted(pageEl, e.page || '-', query);

      const text = document.createElement('span');
      text.className = 'db-text';
      appendHighlighted(text, e.text, query);

      const actions = document.createElement('div');
      actions.className = 'db-row-actions';
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'db-row-copy';
      copyBtn.title = 'Copy entry';
      copyBtn.setAttribute('aria-label', 'Copy entry');
      copyBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 8V3H3v13h5" fill="none" stroke="currentColor" stroke-width="2"/></svg>';

      const lineText = `${new Date(e.at).toISOString()} ${e.level.toUpperCase()} [${e.page || '-'}] ${e.text}`;
      copyBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        // A refused copy (no clipboard permission, page not focused) says so, as Copy all does.
        Promise.resolve(navigator.clipboard?.writeText(lineText))
          .then(() => showToast(navigator.clipboard ? 'Log entry copied!' : 'Could not copy to clipboard'))
          .catch(() => showToast('Could not copy to clipboard'));
      });

      actions.appendChild(copyBtn);
      row.append(time, level, pageEl, text, actions);
      frag.appendChild(row);
    }

    log.replaceChildren(frag);
    $('dbEmpty').hidden = shown.length > 0;

    const c = V.countByLevel(entries);
    syncStatPills(c, entries.length);

    $('dbCount').textContent = (NXTK.t?.('dbCount', [String(shown.length), String(entries.length)]) || `${shown.length} of ${entries.length} entries`)
      + ` · error ${c.error} · warn ${c.warn}`;

    if ($('dbFollow')?.checked && !isPaused) {
      log.scrollTop = log.scrollHeight;
    }

    if ($('dbSearchClear')) {
      $('dbSearchClear').hidden = !query;
    }
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
    syncComponentOptions();
    render();
  }

  document.addEventListener('DOMContentLoaded', () => {
    NXTK.applyI18nTo?.(document);
    document.documentElement.lang = chrome.i18n?.getUILanguage?.() || 'en';
    const version = chrome.runtime.getManifest().version;
    $('dbVersion').textContent = `v${version}`;

    $('dbEnable').addEventListener('click', async () => {
      $('dbEnable').disabled = true;
      try {
        const reply = await chrome.runtime.sendMessage({ type: 'SETTINGS_PATCH', payload: { patch: { DebugLogs: true } } });
        if (!reply?.ok) throw new Error('settings-write-failed');
      } catch (_) {
        $('dbEnable').disabled = false;
      }
      load();
    });

    $('dbLevelFilter').addEventListener('change', render);
    $('dbPageFilter')?.addEventListener('change', render);

    document.querySelectorAll('.db-stat-pill').forEach((pill) => {
      pill.addEventListener('click', () => {
        const lvl = pill.dataset.level || 'all';
        $('dbLevelFilter').value = lvl;
        render();
      });
    });

    $('dbSearch').addEventListener('input', render);
    $('dbSearchClear')?.addEventListener('click', () => {
      $('dbSearch').value = '';
      render();
      $('dbSearch').focus();
    });

    $('dbPauseFeed')?.addEventListener('click', () => {
      isPaused = !isPaused;
      const btn = $('dbPauseFeed');
      const live = $('dbLive');
      btn.classList.toggle('is-paused', isPaused);
      btn.setAttribute('aria-pressed', String(isPaused));
      live.classList.toggle('is-paused', isPaused);
      $('dbPauseLabel').textContent = isPaused ? 'Resume feed' : 'Pause feed';
      showToast(isPaused ? 'Feed paused' : 'Feed resumed');
      if (!isPaused && $('dbFollow')?.checked) {
        $('dbLog').scrollTop = $('dbLog').scrollHeight;
      }
    });

    $('dbCopyLogs')?.addEventListener('click', async () => {
      if (shown.length === 0) {
        showToast('No entries to copy');
        return;
      }
      const text = V.exportText(shown, { version });
      try {
        await navigator.clipboard.writeText(text);
        showToast(`Copied ${shown.length} entries to clipboard!`);
      } catch (_) {
        showToast('Could not copy to clipboard');
      }
    });

    const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    $('dbExportTxt').addEventListener('click', () => download(`nexusmods-bypass-debug-${stamp()}.txt`, V.exportText(shown, { version }), 'text/plain'));
    $('dbExportJson').addEventListener('click', () => download(`nexusmods-bypass-debug-${stamp()}.json`, V.exportJson(shown, { version }), 'application/json'));

    $('dbClear').addEventListener('click', () => {
      if (!confirm(NXTK.t?.('dbClearConfirm') || 'Clear the debug log?')) return;
      chrome.runtime.sendMessage({ type: 'DEBUG_LOG_CLEAR' }, () => { void chrome.runtime.lastError; load(); });
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== $('dbSearch') && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        $('dbSearch').focus();
        $('dbSearch').select();
      } else if (e.key === 'Escape' && document.activeElement === $('dbSearch')) {
        if ($('dbSearch').value) {
          $('dbSearch').value = '';
          render();
        } else {
          $('dbSearch').blur();
        }
      }
    });

    // Live view: the background worker writes the ring buffer; re-render whenever it changes unless paused.
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area === 'local' && (changes[NXTK.DEBUG_LOG_KEY] || changes[NXTK.SETTINGS_KEY])) {
        if (!isPaused) load();
      }
    });

    load();
  });
})();
