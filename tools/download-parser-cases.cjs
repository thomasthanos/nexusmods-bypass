const assert = require('node:assert/strict');

const MANUAL_URL = 'https://premium-files.nexus-cdn.com/100/200/manual.zip?key=a&expires=2';
const SECOND_MANUAL_URL = 'https://premium-files.nexus-cdn.com/100/201/second.zip?key=b&expires=3';
const VORTEX_URL = 'nxm://newvegas/mods/100/files/200?key=secret&expires=2000000000&user_id=7';

function embeddedFileAttribute({
  manual = MANUAL_URL,
  vortex = VORTEX_URL,
  quote = '"',
  fileId = null
} = {}) {
  const metadata = {};
  if (fileId !== null) metadata.fileId = fileId;
  if (manual !== null) metadata.downloadUrl = manual;
  if (vortex !== null) metadata.vortexDownloadUrl = vortex;
  const encoded = JSON.stringify(metadata)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
  return `<button main-file=${quote}${encoded}${quote}>Download</button>`;
}

function metadataAttribute(metadata, attributeName = 'main-file') {
  const encoded = JSON.stringify(metadata)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
  return `<button ${attributeName}="${encoded}">Download</button>`;
}

// What every reader of a Nexus response relies on. The same cases run against the page wrapper in
// nnw.js and against the parser loaded the way the service worker loads it, so the two cannot drift.
function runParserCases({ parse, parseNxmDownloadLink, label }) {
  const say = (message) => `${label}: ${message}`;

  assert.deepEqual(
    JSON.parse(JSON.stringify(parse(JSON.stringify({ downloadUrl: MANUAL_URL }), false))),
    { url: MANUAL_URL, source: 'json-downloadUrl' },
    say('a generated JSON link is found and labelled')
  );
  assert.equal(
    parse(JSON.stringify({ downloadUrl: MANUAL_URL, vortexDownloadUrl: VORTEX_URL }), false)?.url,
    MANUAL_URL,
    say('manual parsing must prefer downloadUrl')
  );
  assert.equal(
    parse(JSON.stringify({ downloadUrl: MANUAL_URL, vortexDownloadUrl: VORTEX_URL }), true)?.url,
    VORTEX_URL,
    say('Vortex parsing must prefer vortexDownloadUrl')
  );

  assert.equal(
    parse(embeddedFileAttribute({ vortex: null }), false)?.url,
    MANUAL_URL,
    say('manual metadata attributes must decode HTML entities')
  );
  assert.equal(
    parse(embeddedFileAttribute({ manual: null }), true)?.url,
    VORTEX_URL,
    say('Vortex-only metadata must produce a clean NXM URL')
  );
  assert.equal(
    parse(embeddedFileAttribute(), false)?.url,
    MANUAL_URL,
    say('manual mode must not be hijacked by an NXM URL later in the same attribute')
  );
  assert.equal(
    parse(embeddedFileAttribute({ quote: "'" }), true)?.url,
    VORTEX_URL,
    say('single-quoted metadata attributes must be supported')
  );

  const malformedThenValid = '<div main-file="{not-json}"></div>'
    + embeddedFileAttribute({ manual: SECOND_MANUAL_URL, vortex: null });
  assert.equal(
    parse(malformedThenValid, false)?.url,
    SECOND_MANUAL_URL,
    say('one malformed attribute must not hide a later valid one')
  );

  const profilePayload = embeddedFileAttribute({ vortex: null })
    .replace('main-file=', 'profile=');
  assert.equal(
    parse(profilePayload, { mode: 'browser', allowBareCdn: false }),
    null,
    say('profile= must not be mistaken for a file= metadata attribute')
  );

  const invalidThenValid = `<a data-download-url="http://premium-files.nexus-cdn.com/unsafe.zip"></a>`
    + `<a data-download-url="${MANUAL_URL.replace(/&/g, '&amp;')}"></a>`;
  assert.equal(
    parse(invalidThenValid, { mode: 'browser', allowBareCdn: false })?.url,
    MANUAL_URL,
    say('an invalid early candidate must not hide a later valid one')
  );

  assert.equal(
    parse(JSON.stringify({ downloadUrl: 'https://evil.example/payload.zip' }), false),
    null,
    say('off-domain download candidates must be rejected')
  );
  assert.equal(
    parse(JSON.stringify({ downloadUrl: 'http://premium-files.nexus-cdn.com/unsafe.zip' }), false),
    null,
    say('insecure CDN candidates must be rejected')
  );

  const fileScopedAttributes = embeddedFileAttribute({
    fileId: 201,
    manual: SECOND_MANUAL_URL,
    vortex: null
  }) + embeddedFileAttribute({
    fileId: 200,
    manual: MANUAL_URL,
    vortex: null
  });
  assert.equal(
    parse(fileScopedAttributes, { mode: 'browser', fileId: '200', allowBareCdn: false })?.url,
    MANUAL_URL,
    say('file-scoped metadata must select the requested file ID')
  );

  // A nested string sends the parser back through the attribute scanner. The scan must not lose its
  // place, or the decoy is re-read until the node budget is gone and the real link is never reached.
  const decoyWithNestedPayload = metadataAttribute({ html: '<div>no link in here</div>' })
    + embeddedFileAttribute({ fileId: 200, manual: MANUAL_URL, vortex: null });
  const afterDecoy = parse(decoyWithNestedPayload, {
    mode: 'browser',
    fileId: '200',
    allowBareCdn: false
  });
  assert.equal(
    afterDecoy?.url,
    MANUAL_URL,
    say('an attribute whose nested payload re-enters the parser must not starve later attributes')
  );
  assert.equal(afterDecoy?.source, 'embedded-file-attr', say('and it is labelled as file metadata'));

  const crowdedFilesTab = Array.from({ length: 40 }, (_, index) => (
    metadataAttribute({ html: `<div>row ${index}</div>` })
  )).join('')
    + embeddedFileAttribute({ fileId: 200, manual: MANUAL_URL, vortex: null });
  assert.equal(
    parse(crowdedFilesTab, { mode: 'browser', fileId: '200', allowBareCdn: false })?.url,
    MANUAL_URL,
    say('a files tab full of unrelated metadata must not hide the requested file')
  );

  assert.equal(
    parse(
      embeddedFileAttribute({ fileId: 201, manual: SECOND_MANUAL_URL, vortex: null }),
      { mode: 'browser', fileId: '200', allowBareCdn: false }
    ),
    null,
    say('metadata for a different file ID must not be used')
  );

  const nested = JSON.stringify({
    data: JSON.stringify({ downloadUrl: MANUAL_URL, vortexDownloadUrl: VORTEX_URL })
  });
  assert.equal(parse(nested, false)?.url, MANUAL_URL, say('JSON inside a JSON string is read'));
  assert.equal(parse(nested, true)?.url, VORTEX_URL, say('and honours Vortex mode'));

  const arrayPayload = JSON.stringify([
    { ignored: true },
    { downloadUrl: MANUAL_URL, vortexDownloadUrl: VORTEX_URL }
  ]);
  assert.equal(parse(arrayPayload, false)?.url, MANUAL_URL, say('JSON response arrays must be searched'));
  assert.equal(parse(arrayPayload, true)?.url, VORTEX_URL, say('JSON response arrays must honor Vortex mode'));

  assert.equal(
    parse(`download = (${MANUAL_URL});`, false)?.url,
    MANUAL_URL,
    say('bare CDN extraction must remove JavaScript punctuation')
  );
  assert.equal(
    parse(MANUAL_URL.replace('&', '&amp;'), false)?.url,
    MANUAL_URL,
    say('bare CDN query strings must decode HTML entities')
  );
  assert.equal(
    parse(MANUAL_URL.replace('&', '&#38;'), false)?.url,
    MANUAL_URL,
    say('decimal character references must decode')
  );
  assert.equal(
    parse(MANUAL_URL.replace('&', '&#x0026;'), false)?.url,
    MANUAL_URL,
    say('hexadecimal character references must decode')
  );
  assert.equal(parse(MANUAL_URL, true), null, say('Vortex mode must not fall back to a browser CDN URL'));
  assert.equal(
    parse(`first=${MANUAL_URL} second=${SECOND_MANUAL_URL}`, false),
    null,
    say('ambiguous bare CDN candidates must not select an arbitrary file')
  );

  assert.equal(parseNxmDownloadLink(VORTEX_URL), VORTEX_URL, say('a signed nxm link is found'));
  assert.equal(
    parseNxmDownloadLink(VORTEX_URL.replace(/&/g, '&amp;')),
    VORTEX_URL,
    say('encoded NXM query separators must decode cleanly')
  );
  assert.equal(
    parseNxmDownloadLink(VORTEX_URL.replace(/&/g, '&#x26;')),
    VORTEX_URL,
    say('numeric NXM query separators must decode cleanly')
  );
  assert.equal(
    parseNxmDownloadLink(`</textarea><b>x</b> ${VORTEX_URL}`),
    VORTEX_URL,
    say('markup in the response must not cut the value short')
  );
  assert.equal(
    parseNxmDownloadLink('nxm://newvegas/mods/100/files/200?key=secret&expires=1'),
    null,
    say('unsigned/incomplete NXM URLs must be rejected')
  );
}

module.exports = {
  MANUAL_URL,
  SECOND_MANUAL_URL,
  VORTEX_URL,
  runParserCases
};
