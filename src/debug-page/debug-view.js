// Pure helpers for the debug log page, kept DOM-free so tests/unit/debug-view-test.mjs can cover them.
(function (root) {
  const LEVELS = ['debug', 'info', 'warn', 'error'];
  const RANK = { debug: 0, info: 1, warn: 2, error: 3 };

  function normalize(entry) {
    const level = LEVELS.includes(entry?.level) ? entry.level : 'info';
    return { at: Number(entry?.at) || 0, level, page: String(entry?.page || ''), text: String(entry?.text || '') };
  }

  // minLevel: show this level and above ('all' = everything). query: case-insensitive substring.
  function filterEntries(entries, { minLevel = 'all', query = '' } = {}) {
    const min = minLevel === 'all' ? -1 : (RANK[minLevel] ?? -1);
    const q = String(query || '').trim().toLowerCase();
    return (Array.isArray(entries) ? entries : []).map(normalize)
      .filter((e) => RANK[e.level] >= min)
      .filter((e) => !q || e.text.toLowerCase().includes(q) || e.page.toLowerCase().includes(q));
  }

  function countByLevel(entries) {
    const counts = { debug: 0, info: 0, warn: 0, error: 0 };
    for (const e of (Array.isArray(entries) ? entries : []).map(normalize)) counts[e.level] += 1;
    return counts;
  }

  function formatTime(at) {
    const d = new Date(at);
    return Number.isNaN(d.getTime()) ? '--:--:--' : d.toISOString().slice(11, 23);
  }

  function exportText(entries, { version = '' } = {}) {
    const head = `NexusMods Bypass ${version} debug log — ${entries.length} entries`;
    return [head, ...entries.map((e) => `${new Date(e.at).toISOString()} ${e.level.toUpperCase().padEnd(5)} [${e.page || '-'}] ${e.text}`)].join('\n') + '\n';
  }

  function exportJson(entries, { version = '' } = {}) {
    return JSON.stringify({ app: 'nexusmods-bypass', version, exportedAt: new Date().toISOString(), entries: entries.map((e) => ({ ...e, at: new Date(e.at).toISOString() })) }, null, 2);
  }

  root.NXTK_DEBUG_VIEW = { LEVELS, filterEntries, countByLevel, formatTime, exportText, exportJson, normalize };
  if (typeof module !== 'undefined') module.exports = root.NXTK_DEBUG_VIEW;
})(typeof globalThis !== 'undefined' ? globalThis : this);
