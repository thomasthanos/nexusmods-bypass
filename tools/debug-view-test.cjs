// Offline tests for src/debug-page/debug-view.js (filtering, counts, export).
const assert = require('node:assert/strict');
const V = require('../src/debug-page/debug-view.js');

const log = [
  { at: Date.UTC(2026, 9, 12, 16, 0, 0, 5), level: 'debug', page: 'mod', text: 'page check ok' },
  { at: Date.UTC(2026, 9, 12, 16, 0, 1), level: 'info', page: 'collection', text: 'queue started' },
  { at: Date.UTC(2026, 9, 12, 16, 0, 2), level: 'warn', page: 'mod-file', text: 'Slow API reply' },
  { at: Date.UTC(2026, 9, 12, 16, 0, 3), level: 'error', page: 'worker', text: 'request_failed 503' },
  { at: 'bad', level: 'nonsense', text: 42 }
];
assert.equal(V.filterEntries(log).length, 5, 'all by default');
assert.deepEqual(V.filterEntries(log, { minLevel: 'warn' }).map((e) => e.level), ['warn', 'error'], 'level filter is a minimum');
assert.deepEqual(V.filterEntries(log, { minLevel: 'error' }).map((e) => e.text), ['request_failed 503']);
assert.equal(V.filterEntries(log, { minLevel: 'info' }).length, 4, 'unknown level is treated as info');
assert.deepEqual(V.filterEntries(log, { query: 'SLOW' }).map((e) => e.level), ['warn'], 'search is case-insensitive');
assert.deepEqual(V.filterEntries(log, { query: 'collection' }).map((e) => e.text), ['queue started'], 'search matches page type');
assert.equal(V.filterEntries(null).length, 0);
assert.deepEqual(V.countByLevel(log), { debug: 1, info: 2, warn: 1, error: 1 });
assert.equal(V.formatTime(log[0].at), '16:00:00.005');
assert.equal(V.formatTime(NaN), '--:--:--');
const shown = V.filterEntries(log, { minLevel: 'warn' });
const txt = V.exportText(shown, { version: '2.10.2' });
assert.match(txt, /^NexusMods Bypass 2\.10\.2 debug log — 2 entries\n/);
assert.match(txt, /2026-10-12T16:00:03\.000Z ERROR \[worker\] request_failed 503/);
const json = JSON.parse(V.exportJson(shown, { version: '2.10.2' }));
assert.equal(json.app, 'nexusmods-bypass');
assert.equal(json.entries.length, 2);
assert.equal(json.entries[1].at, '2026-10-12T16:00:03.000Z');
console.log('debug view behavior OK');
