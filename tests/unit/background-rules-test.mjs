// Decisions the worker makes without a running queue: download paths and folders, the retry ladder,
// redaction, response and transfer verdicts, queue ordering, settings and bundle requests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  finishCallback, messageListeners, installedListeners, context, source, retryAfterMilliseconds,
  buildDownloadPath, downloadFolderOf, NXTK, DOWNLOAD_CONFLICT_ACTION, MAX_TRACKED_FAILURES,
  recordJobFailure, jobFailureCount, classifyNexusResponse, isValidFileId, isValidHistoryId, ndcScopeKey,
  sanitizeNdcJobItem, storageSetLocal, storageGetLocal, verifyTransferSize, MAX_NDC_JOB_ITEMS
} from './helpers/background-harness.mjs';

{
  const c = context.NXTK.classifyDownloadInterrupt;
  assert.deepEqual({ ...c('NETWORK_FAILED') }, { kind: 'transient', retries: 2 }, 'a dropped connection gets two more tries');
  assert.equal(c('SERVER_FORBIDDEN').kind, 'link', 'an expired link is retried with a fresh one');
  assert.equal(c('SERVER_FORBIDDEN').retries, 1);
  assert.equal(c('FILE_NO_SPACE').retries, 0, 'a full disk is not retried');
  assert.equal(c('FILE_VIRUS_INFECTED').kind, 'blocked');
  assert.equal(c('USER_CANCELED').retries, 0, 'a cancel by the user is respected');
  assert.equal(c('short_file (12 KB of 4 MB)').kind, 'size');
  assert.deepEqual({ ...c('') }, { kind: 'unknown', retries: 1 }, 'unknown keeps the old single retry');
  // Diagnostics #20 (Firefox 159, 4.0.2–4.1.1, "CRASH [transient]"): Firefox names "CRASH" every failed
  // download that is neither a source (network) nor a target (file) failure, its own blocks included
  // (ext-downloads.js DownloadItem.error; DownloadError.becauseBlocked*). Chromium's CRASH is the browser
  // going down mid-transfer, which a retry can mend.
  assert.equal(c('CRASH', { firefox: false }).kind, 'transient', 'Chromium: a crashed browser is retried');
  assert.equal(c('CRASH', { firefox: false }).retries, 2);
  assert.deepEqual({ ...c('CRASH', { firefox: true }) }, { kind: 'blocked', retries: 0 },
    'Firefox: the same name is a failure no retry mends, mostly its own download protection');
  assert.equal(c('NETWORK_FAILED', { firefox: true }).kind, 'transient', 'Firefox\'s network failures are still retried');
}
{
  const trusted = context.isTrustedSender;
  assert.equal(trusted({ id: 'other', url: 'https://www.nexusmods.com/' }), false, 'another extension is refused');
  assert.equal(trusted({ id: 'test-extension-id', url: 'https://www.nexusmods.com/x' }), true, 'a Nexus page is trusted');
  assert.equal(trusted({ id: 'test-extension-id', url: 'https://evil.example/nexusmods.com/' }), false, 'another site is refused');
  assert.equal(trusted({ id: 'test-extension-id', url: 'chrome-extension://test-extension-id/popup/popup.html' }), true, 'the popup is trusted');
  assert.equal(trusted({ id: 'test-extension-id', tab: { id: 3 } }), false, 'a tab sender with no URL is refused');
  assert.equal(trusted({ id: 'test-extension-id' }), true, 'an extension context with no URL or tab is accepted');
}
assert.equal(retryAfterMilliseconds('', 1, () => 0), 30000, 'first strike backs off 30s');
assert.equal(retryAfterMilliseconds('', 2, () => 0), 60000, 'second strike doubles');
assert.equal(retryAfterMilliseconds('', 3, () => 0), 120000, 'third strike doubles again');
assert.equal(retryAfterMilliseconds(undefined, 4, () => 0), 240000, 'a missing header escalates like an empty one');
assert.equal(retryAfterMilliseconds('   ', 3, () => 0), 120000, 'a whitespace header counts as absent');
assert.equal(retryAfterMilliseconds('', 20, () => 0), 600000, 'the ladder is capped at 10 minutes');
{
  const jittered = retryAfterMilliseconds('', 1);
  assert.ok(jittered >= 30000 && jittered <= 36000, 'a computed backoff gets up to 20% jitter, never less');
  assert.equal(retryAfterMilliseconds('', 1, () => 1), 36000, 'and the jitter is capped at 20%');
  const d1 = context.NXTK.retryDelayMs(1, 1500, 15000, () => 0);
  const d3 = context.NXTK.retryDelayMs(3, 1500, 15000, () => 1);
  assert.equal(d1, 750, 'a first retry waits at least half the base');
  assert.equal(d3, 6000, 'retries grow exponentially');
  assert.equal(context.NXTK.retryDelayMs(10, 1500, 15000, () => 1), 15000, 'and are capped');
}
assert.equal(retryAfterMilliseconds('120', 1), 120000, 'an explicit Retry-After still wins');
assert.equal(retryAfterMilliseconds('0', 1), 30000, 'an explicit 0 still respects the alarm floor');

// Never 'overwrite': a collision must not destroy a file the user already had.
assert.equal(DOWNLOAD_CONFLICT_ACTION, 'uniquify', 'a download never overwrites what is there');
assert.equal((source.match(/conflictAction: DOWNLOAD_CONFLICT_ACTION,/g) || []).length, 1,
  'one request builder holds the value');
assert.equal((source.match(/chrome\.downloads\.download\(plan\.request,/g) || []).length, 1,
  'one place starts every file download with it');
assert.equal((source.match(/await startPlannedDownload\(plan,/g) || []).length, 2,
  'and both download paths (a single file, a collection file) go through that place');

assert.equal(buildDownloadPath('NexusMods', 'A Mod.zip'), 'NexusMods/A Mod.zip');
assert.equal(buildDownloadPath('   ', 'A Mod.zip'), 'A Mod.zip', 'a blank folder saves to Downloads');
assert.equal(buildDownloadPath('../../etc', 'A Mod.zip'), 'etc/A Mod.zip', 'traversal is stripped');
const cappedPath = buildDownloadPath('n'.repeat(400), 'A Mod.zip');
assert.equal(cappedPath, `${'n'.repeat(100)}/A Mod.zip`,
  'an overlong folder is capped instead of failing the whole download');
assert.ok(!cappedPath.startsWith(' ') && !cappedPath.includes('  '), 'the capped folder stays clean');

// Chrome's own rule for each path segment (net::IsSafePortablePathComponent): no control, format or
// unsafe character anywhere, and no whitespace, dot or tilde at either end. A segment it refuses fails
// the download as "Invalid filename".
const chromeAcceptsSegment = (segment) => segment.length > 0
  && !/[\p{Cc}\p{Cf}"*/:<>?\\|]/u.test(segment)
  && !/^[\s.~]|[\s.~]$/u.test(segment);
for (const [folder, name] of [
  ['~Mods', '~Grass Overhaul~ 1.2.7z'],
  ['NexusMods', 'Better­Bodies.7z'],
  ['Mods​', 'Zero​Width‍.7z'],
  ['Bidi‮', '﻿BOM first.7z'],
  ['C1\u0085', 'Name\u009f.7z'],
  ['n'.repeat(99) + ' ~x', 'A Mod.zip'],
  ['Folder', `${'a'.repeat(250)} ~ tail`]
]) {
  const built = buildDownloadPath(folder, name);
  for (const segment of built.split('/')) {
    assert.ok(chromeAcceptsSegment(segment), `Chrome accepts every segment of ${JSON.stringify(built)}`);
  }
}
assert.equal(buildDownloadPath('~Mods', '~Grass Overhaul~ 1.2.7z'), 'Mods/Grass Overhaul~ 1.2.7z',
  'a tilde inside a name is kept; only the ends are tidied');
assert.equal(buildDownloadPath('NexusMods', 'clock$.7z'), 'NexusMods/_clock$.7z', 'Windows device names are escaped');

assert.equal(
  downloadFolderOf('C:\\Users\\Someone\\Downloads\\NexusMods\\A Mod.7z'),
  'C:\\Users\\Someone\\Downloads\\NexusMods',
  'the folder a file landed in is what the installer has to be pointed at'
);
assert.equal(downloadFolderOf('/home/someone/Downloads/NexusMods/A Mod.7z'), '/home/someone/Downloads/NexusMods');
assert.equal(downloadFolderOf('A Mod.7z'), '', 'a bare name has no folder to report');
assert.equal(downloadFolderOf(''), '');
assert.equal(downloadFolderOf(undefined), '');

assert.equal(NXTK.validateDownloadTarget('nxm://skyrim/mods/1/files/2?key=k&expires=1&user_id=3').ok, true);
assert.equal(NXTK.validateDownloadTarget('nxm://skyrim/mods/1/files/2').ok, false, 'unsigned nxm links are rejected');
assert.equal(NXTK.validateDownloadTarget('https://evil.example/x.zip', { method: 1 }).ok, false, 'off-host downloads are rejected');

const redact = (text) => NXTK.sanitizeDiagnosticText(text);
assert.match(redact('failed for key=abcdef123'), /key=\[redacted\]/, 'query secrets are redacted');
assert.match(redact('?code=oauth-grant-42 rejected'), /code=\[redacted\]/, 'an OAuth grant is redacted');
assert.match(redact('{"token": "abcdef"}'), /"token"\s*:\s*"\[redacted\]"/, 'JSON secrets are redacted');
assert.match(redact('{"state": "xyz"}'), /"state"\s*:\s*"\[redacted\]"/, 'a JSON OAuth state is redacted');
assert.match(redact('authorization: Bearer abcdef'), /authorization: \[redacted\]/, 'loose header secrets are redacted');
// "code" and "state" carry the diagnosis in our own log lines.
assert.equal(redact('code: no_download_url'), 'code: no_download_url', 'an error code survives redaction');
assert.equal(redact('state: interrupted'), 'state: interrupted', 'a download state survives redaction');

// The worker reads every Nexus answer through classifyNexusResponse, so its verdicts are what is pinned here.
const verdict = (response, text) => classifyNexusResponse(response, text)?.code || null;
assert.equal(verdict({}, '<title>Just a moment...</title>'), 'cloudflare');
assert.equal(verdict({}, '<div id="cf-browser-verification">'), 'cloudflare');
assert.equal(verdict({}, '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=1">'), 'cloudflare');
assert.equal(verdict({}, '<script src="/cdn-cgi/challenge-platform/h/g/orchestrate/managed/v1">'), 'cloudflare');
assert.equal(
  verdict({}, '<a href="/auth/sign_out"></a><script>a.src=\'/cdn-cgi/challenge-platform/scripts/jsd/main.js\';</script>'),
  null,
  'Cloudflare\'s passive bot-check script on an ordinary page is not a challenge (#10)'
);
assert.equal(verdict({ cfMitigated: 'challenge' }, ''), 'cloudflare',
  'the Cf-Mitigated header alone is enough');
assert.notEqual(verdict({}, '<html><body>Skyrim Special Edition</body></html>'), 'cloudflare',
  'an ordinary mod page is not a challenge');
assert.notEqual(verdict({}, ''), 'cloudflare');

assert.equal(verdict(null, 'Your account has been temporarily suspended'), 'account_suspended');
assert.equal(verdict({}, 'too many requests from your account'), 'rate_limited',
  'a rate limit is not mislabeled as an account suspension');
assert.notEqual(verdict(null, '<html>a normal page</html>'), 'account_suspended');

// Queue policy shared by the worker and the page.
const bySize = (sizes) => [...NXTK.orderQueueBySize(sizes.map((size, index) => ({ size, index })), (item) => item.size)]
  .map((item) => item.index);
assert.deepEqual(bySize([500, 20, 0, 3, null, 20, -4, '7', NaN]), [3, 7, 1, 5, 0, 2, 4, 6, 8],
  'smallest first, equal sizes keep their order, and every unknown size goes last in its original order');
assert.equal(bySize([]).length, 0);
assert.equal(NXTK.orderQueueBySize(null, () => 1).length, 0, 'a missing list is an empty queue');
for (const code of ['mod_unavailable', 'file_not_found', 'moderation_hold', 'file_flagged', 'file_not_found (HTTP 404)']) {
  assert.notEqual(NXTK.queueSkipReason(code), '', `${code} is skipped`);
}
for (const code of ['request_failed', 'page_request_failed', 'requires_login', 'rate_limited', 'cloudflare', 'cloudflare (HTTP 403)', '']) {
  assert.equal(NXTK.queueSkipReason(code), '', `${code || 'no code'} is not a skip`);
}
// After a file that was not downloaded the next waits, so a run of removed mods is not asked about
// back to back. Verification stops before this handoff gap and honours its server deadline instead.
for (const code of ['mod_unavailable', 'file_not_found (HTTP 404)', 'no_download_url', 'cloudflare', '', undefined]) {
  assert.equal(NXTK.queueItemGapMs(code), NXTK.MIN_HANDOFF_GAP_SECONDS * 1000, `${code || 'no code'}: the short gap`);
}

assert.equal(isValidFileId('42'), true);
assert.equal(isValidFileId('0'), false);
assert.equal(isValidHistoryId('1704:42'), true);
assert.equal(isValidHistoryId('0:42'), false);
assert.equal(isValidHistoryId('1704:0x2a'), false);
const queueItem = sanitizeNdcJobItem({
  fileId: 42,
  historyId: '1704:42',
  gameId: 1704,
  name: 'A mod',
  pageUrl: 'https://www.nexusmods.com/skyrimspecialedition/mods/1?file_id=42',
  sizeKb: 10
});
assert.equal(queueItem.historyId, '1704:42', 'background jobs preserve the game-aware history ID');
assert.notEqual(
  ndcScopeKey('all', [{ gameId: 110, fileId: 42 }]),
  ndcScopeKey('all', [{ gameId: 1151, fileId: 42 }]),
  'queue scopes distinguish identical file IDs from different games'
);

// A modlist the importer accepts must not be refused by the queue that runs it.
const importerCeiling = Number(
  /const MAX_ARCHIVE_ENTRIES = (\d+)/.exec(fs.readFileSync('src/content/wabbajack-importer.js', 'utf8'))?.[1]
);
assert.ok(Number.isInteger(importerCeiling) && importerCeiling > 0, 'the importer ceiling must be readable');
assert.ok(
  MAX_NDC_JOB_ITEMS >= importerCeiling,
  `the queue accepts ${MAX_NDC_JOB_ITEMS} items but the importer can produce ${importerCeiling}`
);

// Nexus's listed size and the size of the file it actually serves do not always agree. When
// they disagree the download is still finished, and treating that as a failure is what kept a
// mod out of history and made the next run fetch it all over again.
async function transferSizeVerdicts() {
  const previousDownloads = global.chrome.downloads;
  const record = (fields) => {
    global.chrome.downloads = {
      search: (_query, cb) => cb([{ filename: 'C:\\Users\\x\\Downloads\\NexusMods\\mod.zip', ...fields }]),
      download: (_options, cb) => cb(1),
      cancel: finishCallback
    };
  };
  const tenMb = { sizeKb: 10 * 1024 };

  try {
    // Everything the server promised arrived. Nexus listing it as ten times larger is a
    // fault in the listing, not in the transfer.
    record({ bytesReceived: 1048576, totalBytes: 1048576, mime: 'application/zip' });
    let verdict = await verifyTransferSize(1, tenMb);
    assert.equal(verdict.suspicious, false, 'a complete transfer is not a short one');
    assert.equal(verdict.folder, 'C:\\Users\\x\\Downloads\\NexusMods',
      'and where it landed is still reported, so the deck can name the folder');

    // The server said how big it was and stopped early. That is a real truncation.
    record({ bytesReceived: 1048576, totalBytes: 10485760, mime: 'application/zip' });
    verdict = await verifyTransferSize(1, tenMb);
    assert.equal(verdict.suspicious, true, 'stopping short of the declared size is caught');
    assert.equal(verdict.code, 'short_file');
    assert.match(verdict.detail, /got 1048576 of 10485760 declared/, 'and the numbers are recorded');

    record({ bytesReceived: 0, totalBytes: 0, mime: 'application/zip' });
    assert.equal((await verifyTransferSize(1, tenMb)).code, 'empty_file', 'an empty file is refused');

    // A page served in place of the file: complete by HTTP, but not a mod.
    record({ bytesReceived: 4096, totalBytes: 4096, mime: 'text/html' });
    verdict = await verifyTransferSize(1, tenMb);
    assert.equal(verdict.suspicious, true, 'an html page is not accepted as the mod');
    assert.equal(verdict.code, 'not_a_file');
    assert.match(verdict.detail, /text\/html/, 'and the content type is recorded');

    for (const mime of ['text/plain', 'application/json', 'application/xhtml+xml']) {
      record({ bytesReceived: 4096, totalBytes: 4096, mime });
      assert.equal((await verifyTransferSize(1, tenMb)).code, 'not_a_file', `${mime} is refused too`);
    }

    // The same shortfall, but it really is an archive: accepted, because only Nexus's number
    // disagrees and the alternative is failing a file that downloaded properly.
    record({ bytesReceived: 4096, totalBytes: 0, mime: 'application/x-7z-compressed' });
    assert.equal((await verifyTransferSize(1, tenMb)).suspicious, false,
      'an archive far smaller than the listing is still an archive');

    record({ bytesReceived: 1024, totalBytes: 0, mime: 'text/html' });
    assert.equal((await verifyTransferSize(1, { sizeKb: 32 })).suspicious, false,
      'a file below the ratio floor is left alone, as before');

    // A link the browser followed itself (the generator's, 4.0.2 reports) can end at a web page. One more
    // than twice the size Nexus lists for a small file is a page, not the file.
    record({ bytesReceived: 48000, totalBytes: 48000, mime: 'text/html; charset=utf-8' });
    assert.equal((await verifyTransferSize(1, { sizeKb: 0.8 })).code, 'not_a_file', 'a page saved in place of a small file is caught');
    record({ bytesReceived: 900, totalBytes: 900, mime: 'text/html' });
    assert.equal((await verifyTransferSize(1, { sizeKb: 0.8 })).suspicious, false, 'a small html file of about its listed size is left alone');
    record({ bytesReceived: 48000, totalBytes: 48000, mime: 'text/plain' });
    assert.equal((await verifyTransferSize(1, { sizeKb: 0.8 })).suspicious, false, 'a text file is not taken for a page');

    global.chrome.downloads = { search: (_query, cb) => cb([]), download: (_o, cb) => cb(1), cancel: finishCallback };
    assert.equal((await verifyTransferSize(1, tenMb)).suspicious, false,
      'a download that cannot be looked up is not condemned');
  } finally {
    global.chrome.downloads = previousDownloads;
  }
}

// From issue #6, on Firefox: the record behind a just-fired 'complete' still held counters
// from a tenth of the way through the transfer, so a file that was whole on disk was reported
// as "got 16103 of 166716 declared" and failed. The record has to be allowed to settle.
async function staleRecordsAreNotJudged() {
  const previousDownloads = global.chrome.downloads;
  const item = { sizeKb: 163 };

  try {
    // Exactly what Firefox reported, then the settled truth one poll later.
    let reads = 0;
    const snapshots = [
      { bytesReceived: 16103, totalBytes: 166716, fileSize: 0, mime: 'application/x-7z-compressed', filename: '/home/u/dl/B42 Inject.7z' },
      { bytesReceived: 166716, totalBytes: 166716, fileSize: 166716, mime: 'application/x-7z-compressed', filename: '/home/u/dl/B42 Inject.7z' }
    ];
    global.chrome.downloads = {
      search: (_query, cb) => { cb([snapshots[Math.min(reads++, snapshots.length - 1)]]); },
      download: (_options, cb) => cb(1),
      cancel: finishCallback
    };
    let verdict = await verifyTransferSize(1, item);
    assert.ok(reads > 1, 'the mid-transfer snapshot is not taken as final');
    assert.equal(verdict.suspicious, false, 'a file that is whole on disk is not called truncated');
    assert.match(verdict.detail, /got 166716 of 166716 declared/, 'and the settled numbers are reported');

    // The same shape for the second file in the report.
    reads = 0;
    snapshots[0] = { bytesReceived: 16111, totalBytes: 177780, fileSize: 0, mime: 'application/zip', filename: '/home/u/dl/B42 Inspect.zip' };
    snapshots[1] = { bytesReceived: 177780, totalBytes: 177780, fileSize: 177780, mime: 'application/zip', filename: '/home/u/dl/B42 Inspect.zip' };
    assert.equal((await verifyTransferSize(1, { sizeKb: 174 })).suspicious, false,
      'and for the zip that opened fine');

    // fileSize is preferred over a lagging bytesReceived.
    reads = 0;
    snapshots[0] = { bytesReceived: 16103, totalBytes: 166716, fileSize: 166716, mime: 'application/x-7z-compressed', filename: '/x/y.7z' };
    snapshots[1] = snapshots[0];
    verdict = await verifyTransferSize(1, item);
    assert.equal(reads, 1, 'a record with a final size on disk is settled at once');
    assert.equal(verdict.suspicious, false, 'and is judged by that size');

    // A transfer really cut short still fails, once the record has stopped moving.
    reads = 0;
    const stuck = { bytesReceived: 1024, totalBytes: 166716, fileSize: 1024, mime: 'application/zip', filename: '/x/y.zip' };
    snapshots[0] = stuck;
    snapshots[1] = stuck;
    verdict = await verifyTransferSize(1, item);
    assert.equal(verdict.suspicious, true, 'a genuinely truncated file is still refused');
    assert.equal(verdict.code, 'short_file');

    // A record that never settles is not waited on forever.
    reads = 0;
    const moving = { bytesReceived: 500, totalBytes: 166716, fileSize: 0, mime: 'application/zip', filename: '/x/y.zip' };
    snapshots[0] = moving;
    snapshots[1] = moving;
    await verifyTransferSize(1, item);
    assert.ok(reads <= 6, `the settle loop is bounded (${reads} reads)`);

    // A complete event can precede all counters, including totalBytes. Zero/unknown is not proof
    // of an empty file until the browser has had a chance to publish its final record.
    reads = 0;
    snapshots[0] = { state: 'complete', bytesReceived: 0, totalBytes: 0, fileSize: 0, mime: '', filename: '/x/y.7z' };
    snapshots[1] = { state: 'complete', bytesReceived: 166716, totalBytes: 166716, fileSize: 166716, mime: 'application/x-7z-compressed', filename: '/x/y.7z' };
    verdict = await verifyTransferSize(1, item);
    assert.ok(reads > 1, 'zero/unknown counters are re-read before they are called empty');
    assert.equal(verdict.suspicious, false, 'the final non-empty record wins');
  } finally {
    global.chrome.downloads = previousDownloads;
  }
}

// A queue holds up to ten thousand files, so an early fault could write ten thousand records
// into a ten megabyte store. What is kept is capped; what is counted must not be.
function failureRecordsAreCapped() {
  assert.ok(MAX_TRACKED_FAILURES > 0 && MAX_TRACKED_FAILURES <= 200,
    `the cap is a sane size (${MAX_TRACKED_FAILURES})`);

  const job = { failed: [], failedTotal: 0 };
  for (let index = 0; index < MAX_TRACKED_FAILURES + 250; index += 1) {
    recordJobFailure(job, { fileId: index, code: 'short_file' });
  }
  assert.equal(job.failed.length, MAX_TRACKED_FAILURES, 'the stored list stops at the cap');
  assert.equal(jobFailureCount(job), MAX_TRACKED_FAILURES + 250, 'but the count keeps going');
  assert.equal(job.failed[0].fileId, 0, 'and the earliest failure is the one kept');
  assert.equal(job.failed[MAX_TRACKED_FAILURES - 1].fileId, MAX_TRACKED_FAILURES - 1,
    'in the order they happened');

  // A job written by an older version has no total, so the list length still answers for it.
  assert.equal(jobFailureCount({ failed: [{ fileId: 1 }, { fileId: 2 }] }), 2,
    'a job from before the cap is counted from its list');
  assert.equal(jobFailureCount({ failed: [] }), 0, 'an empty list is no failures');
  assert.equal(jobFailureCount({}), 0, 'and neither is a job with no list at all');
  assert.equal(jobFailureCount(null), 0, 'nor no job');

  // The first failure on a fresh job has to start the count from the list it inherits.
  const inherited = { failed: [{ fileId: 9, code: 'x' }] };
  recordJobFailure(inherited, { fileId: 10, code: 'y' });
  assert.equal(jobFailureCount(inherited), 2, 'a job upgraded mid-run does not lose its earlier failures');
}

// The last check before a URL reaches chrome.downloads or Vortex. Each refusal names its reason, so a
// change that lets one through shows up as the reason it no longer gives.
function downloadTargetsAreRefused() {
  const browser = { method: 1 };
  const signed = 'nxm://skyrimspecialedition/mods/1/files/2?key=k&expires=1&user_id=3';
  const cdn = 'https://premium-files.nexus-cdn.com/1704/1/a.7z';
  for (const [url, options, detail] of [
    [cdn, browser, null],
    ['HTTPS://Premium-Files.NEXUS-CDN.com./1704/1/a.7z', browser, null],
    [signed, undefined, null],
    ['http://premium-files.nexus-cdn.com/1704/1/a.7z', browser, 'bad-protocol:http'],
    ['javascript:alert(1)//premium-files.nexus-cdn.com', browser, 'bad-protocol:javascript'],
    ['data:application/zip;base64,UEsDBA==', browser, 'bad-protocol:data'],
    ['blob:https://www.nexusmods.com/0b8f', browser, 'bad-protocol:blob'],
    ['file:///C:/Windows/System32/calc.exe', browser, 'bad-protocol:file'],
    ['ftp://premium-files.nexus-cdn.com/a.7z', browser, 'bad-protocol:ftp'],
    ['https://premium-files.nexus-cdn.com.evil.example/a.7z', browser, 'host-not-allowed:premium-files.nexus-cdn.com.evil.example'],
    ['https://evilnexus-cdn.com/a.7z', browser, 'host-not-allowed:evilnexus-cdn.com'],
    ['https://evil.example/premium-files.nexus-cdn.com/a.7z', browser, 'host-not-allowed:evil.example'],
    ['https://evil.example\\@premium-files.nexus-cdn.com/a.7z', browser, 'host-not-allowed:evil.example'],
    ['https://nexus-cdn.com@evil.example/a.7z', browser, 'embedded-credentials'],
    ['https://user:pass@premium-files.nexus-cdn.com/a.7z', browser, 'embedded-credentials'],
    [`${cdn}?${'a'.repeat(2100)}`, browser, 'too-long'],
    ['   ', browser, 'empty'],
    [null, browser, 'empty'],
    ['premium-files.nexus-cdn.com/a.7z', browser, 'not-a-url'],
    // Vortex takes only a signed nxm link, and Vortex is the default.
    [cdn, undefined, 'bad-protocol:https'],
    [cdn, { method: 0 }, 'bad-protocol:https'],
    [signed, browser, 'bad-protocol:nxm'],
    ['nxm://skyrimspecialedition/mods/1/files/2', undefined, 'missing-nxm-params:key,expires,user_id'],
    ['nxm://skyrimspecialedition/mods/1/files/2?key=&expires=1&user_id=3', undefined, 'missing-nxm-params:key'],
    ['nxm://me:pw@skyrimspecialedition/mods/1/files/2?key=k&expires=1&user_id=3', undefined, 'embedded-credentials']
  ]) {
    const verdict = NXTK.validateDownloadTarget(url, options);
    const label = `${String(url).slice(0, 72)} (${options?.method === 1 ? 'browser' : 'vortex'})`;
    if (detail === null) assert.equal(verdict.ok, true, `${label} is accepted`);
    else assert.deepEqual({ ok: verdict.ok, detail: verdict.detail }, { ok: false, detail }, `${label} is refused`);
  }
}

// What each Nexus answer means for a queued file, through the worker's own resolver. Cloudflare's
// passive bot-check script rides along on ordinary pages and is no challenge; a challenge is one
// whatever its status; and a bare status names the rest.
async function nexusAnswersAreClassified() {
  const previousFetch = context.fetch;
  const item = { fileId: 42, gameId: '1704', name: 'Wanted.7z', pageUrl: 'https://www.nexusmods.com/skyrimspecialedition/mods/42' };
  const link = 'https://premium-files.nexus-cdn.com/1/42/wanted.7z?key=k&expires=1';
  const signedIn = '<a href="/auth/sign_out">Log out</a>';
  const passive = '<script>a.src=\'/cdn-cgi/challenge-platform/scripts/jsd/main.js\';</script>';
  const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cvId:"3"};</script></body></html>';
  const removed = '<h3 id="Notice42-title">Removed by author</h3>';
  const downloadAddress = `<link rel="canonical" href="${item.pageUrl}?tab=files&amp;file_id=42&amp;nmm=1">`;
  const answer = ({ status = 200, body = '', headers = {} } = {}) => ({
    ok: status >= 200 && status < 300, status, url: '', text: async () => body,
    headers: { get: (name) => headers[name] || '' }
  });
  const generated = { body: JSON.stringify({ url: link }) };
  try {
    for (const [label, page, generator, expected] of [
      ['the passive bot check on a signed-in page', { body: signedIn + passive }, generated, { ok: true, url: link }],
      ['the passive bot check on a page with no session markers', { body: `<html><body>Skyrim</body>${passive}</html>` }, generated, { ok: true, url: link }],
      ['a _cf_chl_opt challenge answered 403', { status: 403, body: challenge }, null, { ok: false, code: 'cloudflare' }],
      ['a _cf_chl_opt challenge answered 503', { status: 503, body: challenge }, null, { ok: false, code: 'cloudflare' }],
      ['a _cf_chl_opt challenge inside a signed-in 200', { body: `${signedIn}<script>window._cf_chl_opt={}</script>` }, null, { ok: false, code: 'cloudflare' }],
      ['Cf-Mitigated on an empty 403', { status: 403, headers: { 'Cf-Mitigated': 'challenge' } }, null, { ok: false, code: 'cloudflare' }],
      ['Cf-Mitigated on the generator', { body: signedIn }, { status: 403, headers: { 'Cf-Mitigated': 'challenge' } }, { ok: false, code: 'cloudflare' }],
      ['a real Cloudflare header alongside a removal notice', { status: 403, body: removed + downloadAddress, headers: { 'Cf-Mitigated': 'challenge' } }, null, { ok: false, code: 'cloudflare' }],
      ['real challenge markup alongside a removal notice', { body: challenge + removed + downloadAddress }, null, { ok: false, code: 'cloudflare' }],
      ['a rendered mod still offering a download beside a notice', { body: signedIn + downloadAddress + removed + '<section id="section"></section>' }, generated, { ok: true, url: link }],
      ['an adult-content notice is not a removed mod', { body: signedIn + downloadAddress + '<h3 id="Notice42-title">Adult content disabled</h3>' }, generated, { ok: true, url: link }],
      ['a plain 403', { status: 403, body: '<html>Forbidden</html>' }, null, { ok: false, code: 'page_request_failed', status: 403 }],
      // Nexus down (a gateway error on the mod page itself) is waited out like a lost connection.
      ['a plain 503', { status: 503, body: '<html>Service Unavailable</html>' }, null, { ok: false, code: 'server_error', status: 503 }],
      ['a Cloudflare 522', { status: 522, body: '<html>Connection timed out</html>' }, null, { ok: false, code: 'server_error', status: 522 }],
      ['a plain 500', { status: 500, body: '<html>Error</html>' }, null, { ok: false, code: 'page_request_failed', status: 500 }],
      ['a 429 with Retry-After', { status: 429, headers: { 'Retry-After': '120' } }, null, { ok: false, code: 'rate_limited', status: 429, retryAfter: '120' }],
      ['a generator 429', { body: signedIn }, { status: 429, headers: { 'Retry-After': '30' } }, { ok: false, code: 'rate_limited', status: 429, retryAfter: '30' }],
      ['a generator sign-in error', { body: signedIn }, { status: 403, body: '{"code":"unauthenticated"}' }, { ok: false, code: 'requires_login' }],
      ['a 404 page', { status: 404 }, null, { ok: false, code: 'mod_unavailable' }],
      ['a generator 410', { body: signedIn }, { status: 410 }, { ok: false, code: 'file_not_found' }],
      ['a generator 503', { body: signedIn }, { status: 503 }, { ok: false, code: 'generate_failed', status: 503 }],
      // E-1hmdsrg (3.3.3–3.3.6): Nexus's answer on the file page, as served on 2026-11-01. A run ended these
      // as "no download link" and reported them; they are a sign-in, a file the mod no longer has, and a
      // file under moderation, and the queue treats each as such.
      ['a download card for a signed-out visitor', { body: `${signedIn}<section id="section"><mod-file-download file-id="5" user-is-premium="false" dl-gate-variant="a" download-url="#ERROR-download-location-not-found"></mod-file-download></section>` }, null, { ok: false, code: 'requires_login' }],
      ['an "Object not found." notice', { body: `${signedIn}<section id="section"><div id="Notice9003"><h3 id="Notice9003-title">Error</h3> Object not found. </div></section>` }, null, { ok: false, code: 'file_not_found' }],
      ['a moderation notice', { body: `${signedIn}<section id="section"><div id="Notice7"><h3 id="Notice7-title">File under moderation</h3> Being checked. </div></section>` }, null, { ok: false, code: 'moderation_hold' }],
      // Diagnostics #22/#23: 525 is Cloudflare failing to reach Nexus, an outage like 522.
      ['a Cloudflare 525', { status: 525, body: '<html>SSL handshake failed</html>' }, null, { ok: false, code: 'server_error', status: 525 }]
    ]) {
      const asked = [];
      context.fetch = async (url) => {
        asked.push(String(url));
        return answer(String(url).includes('GenerateDownloadUrl') ? generator : page);
      };
      const result = await context.resolveNdcBrowserUrl(item, 30000);
      const seen = Object.fromEntries(Object.keys(expected).map((key) => [key, result[key]]));
      assert.deepEqual(seen, expected, label);
      assert.equal(asked.length, generator ? 2 : 1, `${label}: ${generator ? 'the generator is asked once' : 'nothing more is asked'}`);
    }

    // Diagnostics #7 (queue): "file-safety notice; metadata only for other files" ended as no_download_url.
    // A queue item is a file page (mod.file.url), and a notice in place of its card is Nexus's answer for it.
    const fileItem = { ...item, pageUrl: 'https://www.nexusmods.com/skyrimspecialedition/mods/42?tab=files&file_id=42' };
    for (const [label, body, code] of [
      ['a virus-scan notice', `${signedIn}<section id="section"><div id="Notice8"><h3 id="Notice8-title">File quarantined</h3> Flagged by our virus scan. </div></section>`, 'file_flagged'],
      ['a removed-file notice', `${signedIn}<section id="section"><div id="Notice9"><h3 id="Notice9-title">Error</h3> This file has been removed. </div></section>`, 'file_not_found']
    ]) {
      const asked = [];
      context.fetch = async (url) => { asked.push(String(url)); return answer({ body }); };
      assert.equal((await context.resolveNdcBrowserUrl(fileItem, 30000)).code, code, label);
      assert.equal(asked.length, 1, `${label}: the generator is not asked`);
      assert.equal(NXTK.queueSkipReason(code), code, `${label}: the run skips the file and carries on`);
      context.fetch = async () => answer({ body });
      assert.notEqual((await context.resolveNdcBrowserUrl(item, 30000)).code, code, `${label}: a mod page's notice is not the file's`);
    }
  } finally {
    context.fetch = previousFetch;
  }
}

// Single mods and collections name a file the same way: the name in the link when it has a known extension.
function downloadNameFromLink() {
  const name = context.NXTK.downloadNameFromUrl;
  assert.equal(name('https://supporter-files.nexus-cdn.com/1704/12604/SkyUI_5_2_SE-12604-5-2SE.7z?token=x'), 'SkyUI_5_2_SE-12604-5-2SE.7z');
  assert.equal(name('https://cf-files.nexus-cdn.com/1704/x/Some%20Mod.zip'), 'Some Mod.zip');
  assert.equal(name('https://cf-files.nexus-cdn.com/1704/x/download'), '', 'no known extension means no name from the link');
  assert.equal(name('not a url'), '');
  const item = context.sanitizeNdcJobItem({ fileId: 12604, gameId: '1704', name: 'Main file.7z', modName: 'SkyUI', pageUrl: 'https://www.nexusmods.com/skyrimspecialedition/mods/12604' });
  assert.equal(item.modName, 'SkyUI', 'a collection item keeps its mod name for the fallback file name');
  assert.equal(item.domain, 'skyrimspecialedition', 'the game comes from the mod page address');
}

// The worker used to read a generated response with a simpler reader of its own: it ignored which
// file a link belonged to and would take a Vortex resolver page as a browser download.
async function workerResolvesTheRequestedFile() {
  const previousFetch = context.fetch;
  const item = {
    fileId: 42, gameId: '1704', name: 'Wanted.7z',
    pageUrl: 'https://www.nexusmods.com/skyrimspecialedition/mods/42'
  };
  const wanted = 'https://premium-files.nexus-cdn.com/1/42/wanted.7z?key=b&expires=1';
  const attribute = (fileId, url) => `<button main-file="${
    JSON.stringify({ fileId, downloadUrl: url }).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  }">Download</button>`;
  const serve = (generated) => {
    context.fetch = async (url) => ({
      ok: true,
      status: 200,
      url: String(url),
      text: async () => (String(url).includes('GenerateDownloadUrl')
        ? generated
        : '<a href="/auth/sign_out">Log out</a>'),
      headers: { get: () => '' }
    });
  };

  try {
    serve(attribute(43, 'https://premium-files.nexus-cdn.com/1/43/other.7z?key=a&expires=1') + attribute(42, wanted));
    let resolved = await context.resolveNdcBrowserUrl(item, 30000);
    assert.equal(resolved.ok, true, 'a files-tab response resolves in the worker');
    assert.equal(resolved.url, wanted, 'to the link of the file that was asked for, not the first one listed');

    serve(JSON.stringify({ vortexDownloadUrl: 'https://www.nexusmods.com/Core/Libs/Common/Managers/Downloads?GenerateDownloadUrl' }));
    resolved = await context.resolveNdcBrowserUrl(item, 30000);
    assert.equal(resolved.ok, false, 'a Vortex resolver page is never taken as the file');
    assert.equal(resolved.code, 'no_download_url');

    serve(JSON.stringify({ url: wanted }));
    resolved = await context.resolveNdcBrowserUrl(item, 30000);
    assert.equal(resolved.url, wanted, 'the plain generated JSON still resolves');

    // Bug report #7: a removed mod's page is one notice. A queued file of it fails as unavailable.
    const asked = [];
    context.fetch = async (url) => {
      asked.push(String(url));
      return {
        ok: true,
        status: 200,
        url: String(url),
        text: async () => '<form action="https://users.nexusmods.com/auth/sign_out"></form>'
          + '<div id="Notice3354" class="info warning clearfix site-notice "><div class="info-content">'
          + '<h3 id="Notice3354-title">Removed by author</h3>'
          + '<p id="Notice3354-paragraph"> The mod you were looking for was removed by its author </p></div></div>',
        headers: { get: () => '' }
      };
    };
    resolved = await context.resolveNdcBrowserUrl(item, 30000);
    assert.equal(resolved.code, 'mod_unavailable', 'a removed mod is named as such in the worker too');
    assert.deepEqual(asked, [item.pageUrl], 'without asking the generator for a link');

    // A redownload's URL can remain in the canonical/share link of a removed mod. Its nmm=1
    // parameter is not a download control and must not override the site's removal notice. The
    // unnecessary generator request was where this case could turn into a Cloudflare report.
    const signedIn = '<a href="/auth/sign_out">Log out</a>';
    for (const link of [
      `<link rel="canonical" href="${item.pageUrl}?tab=files&amp;file_id=42&amp;nmm=1">`,
      `<a href="${item.pageUrl}?tab=files&amp;file_id=42&amp;nmm=1">Share</a>`
    ]) {
      const requested = [];
      context.fetch = async (url) => {
        requested.push(String(url));
        const generator = String(url).includes('GenerateDownloadUrl');
        return {
          ok: !generator, status: generator ? 403 : 200, url: String(url),
          text: async () => generator ? '<title>Just a moment...</title>'
            : `${signedIn}${link}<h3 id="Notice3354-title">Removed by author</h3>`,
          headers: { get: (name) => generator && name.toLowerCase() === 'cf-mitigated' ? 'challenge' : '' }
        };
      };
      const missing = await context.resolveNdcBrowserUrl(item, 30000);
      assert.equal(missing.code, 'mod_unavailable', 'a removed mod stays unavailable when its canonical/share URL contains nmm=1');
      assert.deepEqual(requested, [item.pageUrl], 'a canonical/share download parameter cannot trigger the generator for a removed mod');
    }
  } finally {
    context.fetch = previousFetch;
  }
}

async function queuedBrowserRoutesResolveToFiles() {
  const savedFetch = context.fetch;
  const item = { fileId: 42, gameId: '1704', name: 'Wanted.7z',
    pageUrl: 'https://www.nexusmods.com/skyrimspecialedition/mods/42' };
  const route = `https://www.nexusmods.com/api/files/${1704 * 2 ** 32 + 42}/download`;
  const wanted = 'https://premium-files.nexus-cdn.com/1704/42/wanted.7z?key=k&expires=1';
  const markup = (url) => `<mod-file-download file='${JSON.stringify({ id: 42, downloadUrl: url })}'></mod-file-download>`;
  const signedIn = '<a href="/auth/sign_out">Log out</a>';
  try {
    for (const test of [
      { name: 'the empty generator falls back to the page route', finalUrl: wanted, contentType: 'application/octet-stream', binary: true, expected: { ok: true, url: wanted }, cancel: 1 },
      { name: 'the route returns JSON with the real file', body: JSON.stringify({ url: wanted }), expected: { ok: true, url: wanted } },
      { name: 'a route in generated JSON is resolved too', generated: JSON.stringify({ url: route }), finalUrl: wanted, contentType: 'application/octet-stream', binary: true, expected: { ok: true, url: wanted }, cancel: 1 },
      { name: 'a direct file on the page needs no route', page: markup(wanted), calls: 2, expected: { ok: true, url: wanted } },
      { name: 'a self-referencing HTML route is never the file', body: markup(route), expected: { ok: false, code: 'no_download_url' } },
      { name: 'another file route is not requested', page: markup(route.replace(String(1704 * 2 ** 32 + 42), String(1704 * 2 ** 32 + 43))), calls: 2, expected: { ok: false, code: 'no_download_url' } },
      { name: 'another game route is not requested', page: markup(route.replace(String(1704 * 2 ** 32 + 42), String(1151 * 2 ** 32 + 42))), calls: 2, expected: { ok: false, code: 'no_download_url' } },
      { name: 'a Vortex route is not requested for browser files', page: markup(`${route}?nmm=1`), calls: 2, expected: { ok: false, code: 'no_download_url' } },
      { name: 'an external route is not requested', page: markup(route.replace('www.nexusmods.com', 'evil.example')), calls: 2, expected: { ok: false, code: 'no_download_url' } },
      { name: 'route throttling retains its Retry-After', status: 429, retryAfter: '123', expected: { ok: false, code: 'rate_limited', status: 429, retryAfter: '123' } },
      { name: 'the route requires a login', finalUrl: 'https://users.nexusmods.com/auth/sign_in', body: '<html>Sign in</html>', contentType: 'text/html', expected: { ok: false, code: 'requires_login' } },
      { name: 'the route requires a browser check', status: 403, body: '<title>Just a moment...</title>', contentType: 'text/html', expected: { ok: false, code: 'cloudflare' } },
      { name: 'the route names a removed file', status: 404, expected: { ok: false, code: 'file_not_found', status: 404 } },
      { name: 'a redirected file page is never the archive', finalUrl: `${item.pageUrl}?file_id=42`, body: signedIn + '<html>No file</html>', contentType: 'text/html', expected: { ok: false, code: 'no_download_url' } },
      { name: 'an unsafe final file host is never accepted', finalUrl: 'https://evil.example/wanted.7z', contentType: 'application/octet-stream', binary: true, cancel: 1, expected: { ok: false, code: 'no_download_url' } },
      { name: 'an HTML response from a CDN is not an archive', finalUrl: wanted, body: '<html>No file</html>', contentType: 'text/html', expected: { ok: false, code: 'no_download_url' } },
      { name: 'an aborted route cannot become a file', abort: true, expected: { ok: false, code: 'no_download_url' } },
      { name: 'a generated Nexus page is not a file', page: signedIn, generated: JSON.stringify({ url: `${item.pageUrl}?file_id=42` }), calls: 2, expected: { ok: false, code: 'no_download_url' } },
      { name: 'a generated Nexus archive is still a file', generated: JSON.stringify({ url: 'https://files.nexusmods.com/wanted.7z' }), calls: 2, expected: { ok: true, url: 'https://files.nexusmods.com/wanted.7z' } }
    ]) {
      const asked = [];
      let canceled = 0;
      context.fetch = async (url, options) => {
        asked.push({ url: String(url), options });
        const generated = String(url).includes('GenerateDownloadUrl');
        const probing = String(url) === route;
        if (probing && test.abort) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        const status = probing ? test.status || 200 : 200;
        return {
          ok: status >= 200 && status < 300, status, url: probing ? test.finalUrl || route : String(url),
          headers: { get: (name) => probing
            ? ({ 'content-type': test.contentType || 'application/json', 'retry-after': test.retryAfter || '' })[name.toLowerCase()] || '' : '' },
          text: async () => {
            if (probing && test.binary) throw new Error('must not buffer the archive body');
            return probing ? test.body || '' : generated ? test.generated || '[]' : test.page || markup(route);
          },
          body: { cancel: async () => { canceled += 1; } }
        };
      };
      const result = await context.resolveNdcBrowserUrl(item, 30000);
      assert.deepEqual(Object.fromEntries(Object.keys(test.expected).map((key) => [key, result[key]])), test.expected, test.name);
      assert.equal(asked.length, test.calls || 3, `${test.name}: requests stay bounded`);
      assert.equal(canceled, test.cancel || 0, `${test.name}: archive bodies are canceled before download`);
      if (asked.length > 2) {
        assert.equal(asked[2].options.credentials, 'include');
        assert.equal(asked[2].options.headers?.['X-Requested-With'], undefined, 'the route is fetched as a browser click, without AJAX fragment headers');
      }
    }
  } finally {
    context.fetch = savedFetch;
  }
}

// 3.3.6 and 4.0.0 queue reports: "generator HTTP 200: JSON {url}; a usable link was in it (Nexus page) |
// page HTTP 200: … (download route) | route HTTP 200: … (download route)". The generator's link was a
// Nexus address with no file name: a single download hands it to the browser, the queue never asked it.
// In issue #41 all of them were newer files of under a kilobyte (checked on 2026-11-03).
async function queuedGeneratorNexusLinkIsFollowed() {
  const savedFetch = context.fetch;
  const item = { fileId: 42, gameId: '1704', name: 'Wanted.7z',
    pageUrl: 'https://www.nexusmods.com/skyrimspecialedition/mods/42?tab=files&file_id=42' };
  const offered = 'https://www.nexusmods.com/download/abc123';
  const stored = 'https://files.nexus-cdn.com/5f/5f2b9c0d41e7';
  const signedIn = '<a href="/auth/sign_out">Log out</a>';
  try {
    for (const test of [
      { name: 'a nameless Nexus link that serves the archive is downloaded',
        answer: { contentType: 'application/octet-stream', binary: true }, cancel: 1, expected: { ok: true, url: offered } },
      { name: 'one that sends the request on to the CDN is downloaded from there',
        answer: { finalUrl: stored, contentType: 'application/x-7z-compressed', binary: true }, cancel: 1, expected: { ok: true, url: stored } },
      { name: 'one that answers with a page is not the file, and the report says what it was',
        answer: { contentType: 'text/html', body: `<!doctype html><html><body>${signedIn}</body></html>` },
        expected: { ok: false, code: 'no_download_url' }, detail: /\| generator link HTTP 200: HTML page; no link in it$/ },
      { name: 'one that sends the request on to a sign-in asks for it',
        answer: { finalUrl: 'https://users.nexusmods.com/auth/sign_in', contentType: 'text/html', body: '<html>Sign in</html>' },
        expected: { ok: false, code: 'requires_login' } },
      { name: 'one that is throttled makes the run wait, with Nexus\'s Retry-After',
        answer: { status: 429, retryAfter: '90', contentType: 'text/html', body: '' }, expected: { ok: false, code: 'rate_limited', retryAfter: '90' } },
      { name: 'one that cannot be reached is noted, not taken for a file', calls: 4,
        answer: { failure: true }, expected: { ok: false, code: 'no_download_url' },
        detail: /\| generator link: Failed to fetch after \d+ms \| generator link without cookies: Failed to fetch after \d+ms$/ },
      // Issue #41 (Chromium, 2026-11-03): sent on with cookies to the CDN, which allows any origin, the
      // request is refused as if nothing answered. Without cookies the same signed link serves the file.
      { name: 'one refused with cookies is asked again without, and its file is taken', calls: 4,
        answer: { refusedWithCookies: true, finalUrl: stored, contentType: 'application/x-7z-compressed', binary: true },
        cancel: 1, expected: { ok: true, url: stored } },
      // 4.0.2 reports: refused with cookies, and without them the same address answers with a page. The
      // address is reachable, so the browser's own download, which sends the cookies and is not refused,
      // is given it, as a single download does.
      { name: 'without cookies a sign-in page says nothing about the visitor: the browser gets the link', calls: 4,
        answer: { refusedWithCookies: true, finalUrl: 'https://users.nexusmods.com/auth/sign_in', contentType: 'text/html', body: '<html>Sign in</html>' },
        expected: { ok: true, url: offered } },
      { name: 'nor does a page at the same address: the browser gets the link', calls: 4,
        answer: { refusedWithCookies: true, contentType: 'text/html', body: '<!doctype html><html><body>Nexus</body></html>' },
        expected: { ok: true, url: offered } },
      { name: 'a file page from the generator is still never asked', generated: `${item.pageUrl}&nmm=1`, calls: 2,
        expected: { ok: false, code: 'no_download_url' } }
    ]) {
      const asked = [];
      let canceled = 0;
      context.fetch = async (url, options) => {
        const target = String(url);
        asked.push(target);
        if (target.includes('GenerateDownloadUrl')) {
          return { ok: true, status: 200, url: target, headers: { get: () => '' },
            text: async () => JSON.stringify({ url: test.generated || offered }) };
        }
        if (target === offered) {
          const answer = test.answer;
          if (answer.failure || (answer.refusedWithCookies && options?.credentials === 'include')) throw new TypeError('Failed to fetch');
          const status = answer.status || 200;
          return {
            ok: status < 300, status, url: answer.finalUrl || offered,
            headers: { get: (name) => ({ 'content-type': answer.contentType, 'retry-after': answer.retryAfter || '' })[name.toLowerCase()] || '' },
            text: async () => {
              if (answer.binary) throw new Error('must not buffer the archive body');
              return answer.body || '';
            },
            body: { cancel: async () => { canceled += 1; } }
          };
        }
        return { ok: true, status: 200, url: target, headers: { get: () => '' }, text: async () => signedIn };
      };
      const result = await context.resolveNdcBrowserUrl(item, 30000);
      assert.deepEqual(Object.fromEntries(Object.keys(test.expected).map((key) => [key, result[key]])), test.expected, test.name);
      assert.equal(asked.length, test.calls || 3, `${test.name}: the page, the generator and its link (twice when refused) at most`);
      assert.equal(canceled, test.cancel || 0, `${test.name}: an archive body is cancelled, not buffered`);
      if (test.detail) assert.match(result.detail, test.detail, `${test.name}: detail`);
      if (result.detail) assert.doesNotMatch(result.detail, /abc123|download\/|nexus-cdn/, `${test.name}: the report names kinds, never the address`);
    }
  } finally {
    context.fetch = savedFetch;
  }
}

// Settings reach storage inside their bounds whoever writes them; a value of the wrong type is
// still refused outright.
async function settingsPatchIsNormalized() {
  const send = (type, payload) => new Promise((resolve) => {
    messageListeners[0]({ type, payload }, { id: 'test-extension-id', url: 'https://www.nexusmods.com/skyrimspecialedition/collections/abc', tab: { id: 7 } }, resolve);
  });
  const previousSettings = await context.storageGetLocal(context.NXTK.SETTINGS_KEY, null);
  const promptKey = 'nxtk_auto_report_prompt_v1';
  const previousPrompt = await context.storageGetLocal(promptKey, null);
  try {
    await context.storageSetLocal(context.NXTK.SETTINGS_KEY, { AutoErrorReports: true, AutoReportDiagnostics: true });
    await send('SETTINGS_PATCH', { patch: { AutoErrorReports: false } });
    assert.equal((await context.storageGetLocal(context.NXTK.SETTINGS_KEY)).AutoReportDiagnostics, false,
      'an older settings page revoking basic consent also revokes extra diagnostics');
    await context.storageSetLocal(context.NXTK.SETTINGS_KEY, { AutoErrorReports: false, AutoReportDiagnostics: true });
    await send('SETTINGS_PATCH', { patch: { AutoErrorReports: true } });
    assert.equal((await context.storageGetLocal(context.NXTK.SETTINGS_KEY)).AutoReportDiagnostics, false,
      'basic re-enabling cannot revive stale extra consent');
  } finally {
    await context.storageSetLocal(context.NXTK.SETTINGS_KEY, previousSettings);
    await context.storageSetLocal(promptKey, previousPrompt);
  }
  let reply = await send('SETTINGS_PATCH', { patch: { NDC_pauseBetweenDownload: -30, RequestTimeout: 1 } });
  assert.equal(reply.ok, true, 'out-of-range numbers are accepted');
  assert.equal(reply.value.NDC_pauseBetweenDownload, 0, 'but stored inside their bounds');
  assert.equal(reply.value.RequestTimeout, 15000, 'including a timeout too short to be useful');
  reply = await send('SETTINGS_PATCH', { patch: { RequestTimeout: 'soon' } });
  assert.equal(reply.ok, false, 'a value of the wrong type is still refused');
  assert.match(reply.error, /invalid-settings-value:RequestTimeout/);
  // Diagnostics #13 (4.1.1): "unknown-settings-key:[redacted]". The "key: value" shape is the one the
  // report sanitizer hides as a secret, so the report could never say which setting it was.
  await storageSetLocal(NXTK.ERROR_LOG_KEY, []);
  reply = await send('SETTINGS_PATCH', { patch: { NotARealSetting: true } });
  assert.equal(reply.ok, false, 'a setting this version does not have is still refused');
  assert.match(reply.error, /^unknown-settings-name:NotARealSetting$/);
  assert.equal(NXTK.sanitizeDiagnosticText(reply.error), 'unknown-settings-name:NotARealSetting',
    'and a report of it still names the setting');
  assert.equal(NXTK.sanitizeDiagnosticText('unknown-settings-key:NotARealSetting'), 'unknown-settings-key:[redacted]',
    'which the old wording could not');
  reply = await send('SETTINGS_PATCH', { patch: { 'odd name: <b>': true } });
  assert.equal(reply.error, 'unknown-settings-name:(not a setting name)', 'a name that is not one is not echoed');
  await new Promise((resolve) => setTimeout(resolve, 10));
  await storageSetLocal(NXTK.ERROR_LOG_KEY, []);
}

// onInstalled also fires for every update and every browser update. The old 1.5 MB/s default is
// migrated only for a copy that last ran before the migration existed; after that it is a choice.
async function speedMigrationOnlyRunsForOldCopies() {
  assert.equal(installedListeners.length, 1, 'the worker registers one install listener');
  const run = async (details, speed) => {
    await storageSetLocal(NXTK.SETTINGS_KEY, { ...NXTK.DEFAULTS, NDC_downloadSpeed: speed });
    installedListeners[0](details);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return (await storageGetLocal(NXTK.SETTINGS_KEY, {})).NDC_downloadSpeed;
  };
  assert.equal(await run({ reason: 'update', previousVersion: '2.3.9' }, 1.5), NXTK.DEFAULTS.NDC_downloadSpeed,
    'a copy from before the default changed is migrated');
  assert.equal(await run({ reason: 'update', previousVersion: '2.6.4' }, 1.5), 1.5,
    'a chosen 1.5 MB/s survives an update');
  assert.equal(await run({ reason: 'chrome_update' }, 1.5), 1.5, 'and a browser update');
  assert.equal(await run({ reason: 'update', previousVersion: '2.3.9' }, 2), 2, 'another speed is never touched');
}

// A page asks the worker for a bundle; the worker adds exactly that bundle's packaged files to the
// document that asked. A page left or reloaded before its bundle arrived is no fault and is not logged;
// any other refusal is.
async function bundleLoadsAreTargetedAndQuiet() {
  const savedScripting = global.chrome.scripting;
  const savedRecord = context.recordBackgroundError;
  const injected = [];
  const recorded = [];
  let failure = null;
  global.chrome.scripting = {
    executeScript: async (options) => {
      injected.push(JSON.parse(JSON.stringify(options)));
      if (failure) throw new Error(failure);
      return [];
    }
  };
  context.recordBackgroundError = (action, cause) => recorded.push(`${action}: ${String(cause?.message || cause)}`);
  const page = { id: 'test-extension-id', url: 'https://www.nexusmods.com/skyrimspecialedition/mods/1', tab: { id: 7 }, frameId: 0, documentId: 'DOC-1' };
  // Replies come from the worker's realm; JSON gives them this realm's prototypes for deepEqual.
  const ask = (bundle, sender = page) => new Promise((resolve) => {
    const reply = (value) => resolve(JSON.parse(JSON.stringify(value)));
    if (messageListeners[0]({ type: 'LOAD_BUNDLE', bundle }, sender, reply) !== true) resolve('no answer');
  });
  try {
    assert.deepEqual(await ask('settings'), { ok: true });
    assert.deepEqual(injected.pop(), { target: { tabId: 7, documentIds: ['DOC-1'] }, files: ['content/ui-settings.js'] },
      'the document that asked gets exactly the bundle files');
    await ask('wabbajack', { ...page, documentId: undefined, frameId: 3 });
    assert.deepEqual(injected.pop().target, { tabId: 7, frameIds: [3] }, 'without a document id, the frame that asked');

    for (const gone of ['Frame with ID 0 was removed.', 'No frame with id 3 in tab 7.', 'No document with id DOC-1 in tab 7.',
      'No tab with id: 7.', 'The tab was closed.']) {
      failure = gone;
      const reply = await ask('collection');
      assert.equal(reply.ok, false, `${gone} is answered`);
      assert.equal(reply.error, gone);
    }
    assert.deepEqual(recorded, [], 'a page that went away before its bundle arrived is not a fault');
    // 4.0.2 reports: "Could not load file: 'content/ndc.js'.", hourly from one install. Asked once more for
    // files an update is replacing; still unreadable, it is answered for the page to explain, and the worker
    // does not report the same install problem as a fault of its own.
    let refusals = 1;
    global.chrome.scripting.executeScript = async (options) => {
      injected.push(JSON.parse(JSON.stringify(options)));
      if (refusals-- > 0) throw new Error("Could not load file: 'content/ndc.js'.");
      return [];
    };
    const countBefore = injected.length;
    assert.deepEqual(await ask('collection'), { ok: true }, 'a file being replaced is read on the second try');
    assert.equal(injected.length - countBefore, 2);
    refusals = 5;
    const unreadable = await ask('collection');
    assert.equal(unreadable.ok, false);
    assert.match(unreadable.error, /Could not load file/);
    assert.equal(injected.length - countBefore, 4, 'asked twice, no more');
    assert.deepEqual(recorded, [], 'an unreadable packaged file is not a worker fault');
    global.chrome.scripting.executeScript = async (options) => {
      injected.push(JSON.parse(JSON.stringify(options)));
      if (failure) throw new Error(failure);
      return [];
    };
    failure = 'Cannot access contents of the page. Extension manifest must request permission to access the respective host.';
    assert.equal((await ask('collection')).ok, false);
    assert.equal(recorded.length, 1, 'any other refusal is recorded');
    failure = null;

    const before = injected.length;
    for (const [bundle, sender, error] of [
      ['constructor', page, 'unknown-bundle'],
      ['../manifest.json', page, 'unknown-bundle'],
      ['settings', { ...page, tab: undefined }, 'bundle-needs-a-nexus-page'],
      ['settings', { ...page, url: 'chrome-extension://test-extension-id/popup/popup.html' }, 'bundle-needs-a-nexus-page']
    ]) {
      assert.deepEqual(await ask(bundle, sender), { ok: false, error }, `${bundle} for ${sender.url}`);
    }
    assert.equal(await ask('settings', { ...page, id: 'another-extension' }), 'no answer', 'another extension is not answered');
    assert.equal(injected.length, before, 'none of those reached a page');
  } finally {
    global.chrome.scripting = savedScripting;
    context.recordBackgroundError = savedRecord;
  }
}

Promise.resolve()
  .then(queuedBrowserRoutesResolveToFiles)
  .then(queuedGeneratorNexusLinkIsFollowed)
  .then(downloadNameFromLink)
  .then(transferSizeVerdicts)
  .then(staleRecordsAreNotJudged)
  .then(settingsPatchIsNormalized)
  .then(speedMigrationOnlyRunsForOldCopies)
  .then(workerResolvesTheRequestedFile)
  .then(failureRecordsAreCapped)
  .then(downloadTargetsAreRefused)
  .then(nexusAnswersAreClassified)
  .then(bundleLoadsAreTargetedAndQuiet)
  .then(() => console.log('background.js rules behavior OK'))
  .catch((error) => { console.error(error); process.exitCode = 1; });
