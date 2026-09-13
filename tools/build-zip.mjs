#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = join(root, 'src');

const ALLOWLIST = [
  { path: 'manifest.json' },
  { path: 'LICENSE-GPL-3.0-or-later.txt' },
  { path: 'background.js' },
  { path: 'response-classifier.js' },
  { path: 'download-url-parser.js' },
  { path: 'shared.js' },
  { path: 'report.js' },
  { path: 'content', ext: ['.js', '.css'] },
  { path: 'popup', ext: ['.js', '.css', '.html'] },
  { path: 'onboarding', ext: ['.js', '.css', '.html'] },
  { path: 'icons', ext: ['.png'] },
  { path: '_locales', ext: ['.json'] }
];

const FORBIDDEN = [
  /^tools\//, /^internal\//, /^dist\//, /^\.claude\//,
  /\.md$/i, /\.zip$/i, /\.aep$/i, /\.mp4$/i, /(^|\/)\.[^/]/
];

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};

// The release gate: nothing is packaged unless every check passes.
for (const check of [
  'check-locales.mjs',
  'vortex-preflight-test.cjs',
  'nnw-parser-test.cjs',
  'download-parser-test.cjs',
  'background-units-test.cjs',
  'wabbajack-importer-test.cjs',
  'content-helpers-test.cjs',
  'report-builder-test.cjs'
]) {
  const run = spawnSync(process.execPath, [join(root, 'tools', check)], { cwd: root, stdio: 'inherit' });
  if (run.status !== 0) fail(`${check} did not pass — package not built.`);
}

function walk(absolute, prefix, allowedExt) {
  const found = [];
  for (const name of readdirSync(absolute).sort()) {
    const child = join(absolute, name);
    const entryName = prefix ? `${prefix}/${name}` : name;
    if (statSync(child).isDirectory()) {
      found.push(...walk(child, entryName, allowedExt));
    } else if (!allowedExt || allowedExt.includes(extname(name).toLowerCase())) {
      found.push(entryName);
    }
  }
  return found;
}

const entryNames = [];
for (const rule of ALLOWLIST) {
  const absolute = join(pkg, rule.path);
  if (!existsSync(absolute)) fail(`allowlisted path is missing: ${rule.path}`);
  if (statSync(absolute).isDirectory()) {
    entryNames.push(...walk(absolute, rule.path, rule.ext));
  } else {
    entryNames.push(rule.path);
  }
}
entryNames.sort();

for (const name of entryNames.filter((entry) => entry.endsWith('.js'))) {
  const syntax = spawnSync(process.execPath, ['--check', join(pkg, name)], {
    cwd: root,
    encoding: 'utf8'
  });
  if (syntax.status !== 0) {
    fail(`${name} does not parse as JavaScript:\n${String(syntax.stderr || syntax.stdout || '').trim()}`);
  }
}

for (const name of entryNames) {
  const hit = FORBIDDEN.find((pattern) => pattern.test(name));
  if (hit) fail(`${name} matched a forbidden pattern (${hit}) — check ALLOWLIST.`);
  if (!/^[\x20-\x7E]+$/.test(name)) fail(`entry name is not plain ASCII: ${name}`);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(join(pkg, 'manifest.json'), 'utf8'));
} catch (cause) {
  fail(`manifest.json is not valid JSON — ${cause.message}`);
}

const version = String(manifest.version || '');
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`manifest version is not x.y.z: "${version}"`);

for (const name of entryNames.filter((n) => n.startsWith('_locales/'))) {
  try {
    JSON.parse(readFileSync(join(pkg, name), 'utf8'));
  } catch (cause) {
    fail(`${name} is not valid JSON — ${cause.message}`);
  }
}

function collectReferenced(source) {
  const referenced = new Set();
  for (const script of source.content_scripts || []) {
    for (const file of [...(script.js || []), ...(script.css || [])]) referenced.add(file);
  }
  if (source.background?.service_worker) referenced.add(source.background.service_worker);
  for (const file of source.background?.scripts || []) referenced.add(file);
  if (source.action?.default_popup) referenced.add(source.action.default_popup);
  for (const icons of [source.icons, source.action?.default_icon]) {
    for (const path of Object.values(icons || {})) referenced.add(path);
  }
  return referenced;
}

const packaged = new Set(entryNames);

function assertReferencesArePackaged(source, label) {
  const missing = [...collectReferenced(source)].filter((file) => !packaged.has(file));
  if (missing.length) {
    fail(`the ${label} manifest references files the package does not include:\n  ${missing.join('\n  ')}`);
  }
}

assertReferencesArePackaged(manifest, 'Chrome');

// The packaged files the worker imports, in the order it imports them.
function workerImports() {
  const worker = String(manifest.background?.service_worker || '');
  if (!worker) return [];
  const source = readFileSync(join(pkg, worker), 'utf8');
  const baseDir = worker.includes('/') ? worker.slice(0, worker.lastIndexOf('/')) : '';
  const targets = [];
  for (const call of source.matchAll(/\bimportScripts\s*\(([^)]*)\)/g)) {
    const references = [...call[1].matchAll(/(['"])([^'"]+)\1/g)].map((match) => match[2]);
    if (!references.length) fail(`${worker}: importScripts must use packaged literal paths`);
    for (const reference of references) {
      targets.push(relative(pkg, join(pkg, baseDir, reference)).replace(/\\/g, '/'));
    }
  }
  return targets;
}

function assertWorkerImportsArePackaged() {
  const missing = workerImports().filter((target) => !packaged.has(target));
  if (missing.length) fail(`service-worker imports are not packaged:\n  ${missing.join('\n  ')}`);
}

assertWorkerImportsArePackaged();

for (const [index, script] of (manifest.content_scripts || []).entries()) {
  const files = script.js || [];
  const errorsIndex = files.indexOf('content/errors.js');
  const classifierIndex = files.indexOf('response-classifier.js');
  if (errorsIndex !== -1 && (classifierIndex === -1 || classifierIndex > errorsIndex)) {
    fail(`content_scripts[${index}] must load response-classifier.js before content/errors.js`);
  }
  const nnwIndex = files.indexOf('content/nnw.js');
  const sharedIndex = files.indexOf('shared.js');
  const parserIndex = files.indexOf('download-url-parser.js');
  if (nnwIndex !== -1 && (sharedIndex === -1 || parserIndex === -1 || sharedIndex > parserIndex || parserIndex > nnwIndex)) {
    fail(`content_scripts[${index}] must load shared.js, then download-url-parser.js, before content/nnw.js`);
  }
}

const HTML_REFERENCE = /<(?:script|link|img)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
const EXTERNAL_REFERENCE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

function assertHtmlReferencesArePackaged() {
  const problems = [];
  for (const name of entryNames.filter((n) => n.endsWith('.html'))) {
    const source = readFileSync(join(pkg, name), 'utf8');
    const baseDir = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '';
    for (const [, reference] of source.matchAll(HTML_REFERENCE)) {
      if (EXTERNAL_REFERENCE.test(reference)) continue;
      if (reference.startsWith('/')) {
        problems.push(`${name}: "${reference}" is an absolute path — nothing resolves it inside the package`);
        continue;
      }
      const target = relative(pkg, join(pkg, baseDir, reference.split(/[?#]/)[0])).replace(/\\/g, '/');
      if (!packaged.has(target)) problems.push(`${name}: "${reference}" resolves to ${target}, which is not packaged`);
    }
  }
  if (problems.length) fail(`packaged HTML references files the package does not include:\n  ${problems.join('\n  ')}`);
}

assertHtmlReferencesArePackaged();

// The worker loads shared.js rather than carrying copies of its defaults, redaction rules and
// download-target checks, so a copy creeping back in is the drift this build refuses.
function assertWorkerUsesShared() {
  const imports = workerImports();
  for (const required of ['shared.js', 'download-url-parser.js']) {
    if (!imports.includes(required)) fail(`background.js must importScripts ${required}`);
  }
  if (imports.indexOf('shared.js') > imports.indexOf('download-url-parser.js')) {
    fail('background.js must import shared.js before download-url-parser.js');
  }
  const worker = readFileSync(join(pkg, 'background.js'), 'utf8');
  for (const needle of ['DEFAULTS = {', 'SENSITIVE_PARAM_NAMES = ', 'function validateDownloadTarget(']) {
    if (worker.includes(needle)) fail(`background.js carries its own ${needle.trim()} — use shared.js instead`);
  }
}

assertWorkerUsesShared();

// The worker adds these files to a page the first time it needs them (loadBundle in content/ui.js). Each has
// to be packaged, must not also be a manifest content script — a second copy would run over the first —
// and comes after the files it builds on. The page and the worker have to agree on which bundles exist.
function assertContentBundles() {
  const bundles = readLiteralAfter(readFileSync(join(pkg, 'background.js'), 'utf8'),
    'const CONTENT_BUNDLES = ', '{', '}', 'background.js');
  const asked = readLiteralAfter(readFileSync(join(pkg, 'content/ui.js'), 'utf8'),
    'const BUNDLES = ', '{', '}', 'content/ui.js');
  const declared = new Set((manifest.content_scripts || []).flatMap((script) => script.js || []));
  const problems = [];
  for (const [name, files] of Object.entries(bundles)) {
    if (!Array.isArray(files) || !files.length) {
      problems.push(`${name} lists no files`);
      continue;
    }
    for (const file of files) {
      if (!packaged.has(file)) problems.push(`${name}: ${file} is not packaged`);
      if (declared.has(file)) problems.push(`${name}: ${file} is also a manifest content script`);
    }
  }
  for (const [name, first, then] of [
    ['collection', 'content/ndc.js', 'content/ui-collection.js'],
    ['wabbajack', 'content/zip-reader.js', 'content/wabbajack-importer.js'],
    ['wabbajack', 'content/wabbajack-importer.js', 'content/ui-wabbajack.js']
  ]) {
    const files = Array.isArray(bundles[name]) ? bundles[name] : [];
    const at = files.indexOf(first);
    if (at === -1 || at > files.indexOf(then)) problems.push(`${name} must list ${first} before ${then}`);
  }
  const workerNames = Object.keys(bundles).sort().join(', ');
  const pageNames = Object.keys(asked).sort().join(', ');
  if (workerNames !== pageNames) problems.push(`content/ui.js asks for ${pageNames}; the worker has ${workerNames}`);
  if (problems.length) fail(`CONTENT_BUNDLES in background.js:\n  ${problems.join('\n  ')}`);
}

assertContentBundles();

// The popup builds bug reports with report.js, which extends what shared.js defines.
function assertPopupLoadsReport() {
  const popup = readFileSync(join(pkg, 'popup/popup.html'), 'utf8');
  const at = ['../shared.js', '../report.js', 'popup.js'].map((file) => popup.indexOf(`<script src="${file}"></script>`));
  if (at.includes(-1) || at[0] > at[1] || at[1] > at[2]) {
    fail('popup/popup.html must load ../shared.js, then ../report.js, before popup.js');
  }
}

assertPopupLoadsReport();

function readLiteralAfter(source, needle, openChar, closeChar, file) {
  const start = source.indexOf(needle);
  if (start === -1) fail(`${file}: no ${needle.trim()} literal found`);
  const open = source.indexOf(openChar, start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === openChar) depth += 1;
    else if (source[i] === closeChar) {
      depth -= 1;
      if (depth === 0) {
        try {
          return new Function(`return ${source.slice(open, i + 1)}`)();
        } catch (cause) {
          fail(`${file}: ${needle.trim()} is not a plain literal — ${cause.message}`);
        }
      }
    }
  }
  return fail(`${file}: ${needle.trim()} is unterminated`);
}

function assertRedactionIsConsistent() {
  const source = readFileSync(join(pkg, 'shared.js'), 'utf8');
  const sensitive = readLiteralAfter(source, 'SENSITIVE_PARAM_NAMES = ', '[', ']', 'shared.js');
  const ambiguous = [...readLiteralAfter(source, 'AMBIGUOUS_PARAM_NAMES = new Set(', '[', ']', 'shared.js')];
  for (const name of ambiguous) {
    if (!sensitive.includes(name)) {
      fail(`shared.js: "${name}" is exempt from the loose redaction rule but is not a sensitive name`);
    }
  }
}

assertRedactionIsConsistent();

const GECKO_ID = 'nexus-mods-bypass@thomasthanos.github.io';

const GECKO_MIN_VERSION = '140.0';

// Every permission the package asks for, each one explained in README.md, PRIVACY.md and the store
// listing. A new permission that shows a warning stops an update until the user accepts it, so one is
// never added without changing this list on purpose.
const EXPECTED_PERMISSIONS = ['storage', 'downloads', 'scripting', 'alarms'];
const EXPECTED_HOST_PERMISSIONS = ['https://www.nexusmods.com/*'];

function assertPermissions(source) {
  const same = (actual, expected) => JSON.stringify([...(actual || [])].sort()) === JSON.stringify([...expected].sort());
  if (!same(source.permissions, EXPECTED_PERMISSIONS)) {
    fail(`manifest permissions are ${JSON.stringify(source.permissions || [])}, expected ${JSON.stringify(EXPECTED_PERMISSIONS)}`);
  }
  if (!same(source.host_permissions, EXPECTED_HOST_PERMISSIONS)) {
    fail(`manifest host_permissions are ${JSON.stringify(source.host_permissions || [])}, expected ${JSON.stringify(EXPECTED_HOST_PERMISSIONS)}`);
  }
  if (source.optional_permissions?.length || source.optional_host_permissions?.length) {
    fail('manifest declares optional permissions that nothing documents');
  }
}

assertPermissions(manifest);

function toFirefoxManifest(source) {
  const firefox = JSON.parse(JSON.stringify(source));

  firefox.browser_specific_settings = {
    gecko: {
      id: GECKO_ID,
      strict_min_version: GECKO_MIN_VERSION,
      data_collection_permissions: { required: ['none'] }
    }
  };

  const worker = source.background?.service_worker;
  if (!worker) fail('manifest.json has no background.service_worker to map onto Firefox.');
  // A Firefox background page has no importScripts, so the worker's imports load before it,
  // in the order the worker imports them.
  firefox.background = { scripts: [...workerImports(), worker] };

  return firefox;
}

const firefoxManifest = toFirefoxManifest(manifest);
assertReferencesArePackaged(firefoxManifest, 'Firefox');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

const DOS_TIME = 0;
const DOS_DATE = 0x0021;

// Fixed timestamps make identical sources produce identical archives.
function buildArchive(names, replacements = new Map(), { verbose = false } = {}) {
  const chunks = [];
  const directory = [];
  let offset = 0;

  for (const name of names) {
    const raw = replacements.get(name) ?? readFileSync(join(pkg, name));
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const nameBytes = Buffer.from(name, 'ascii');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034B50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014B50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    chunks.push(local, nameBytes, body);
    directory.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;

    if (verbose) {
      console.log(`  ${String(raw.length).padStart(7)} -> ${String(body.length).padStart(7)}  ${name}`);
    }
  }

  const centralBuffer = Buffer.concat(directory);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054B50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuffer, eocd]);
}

// A description in messages.json is a note for translators that no browser ever shows, and most of the
// English catalogue is those notes. The package carries each catalogue without them and compacted, with
// every key, message and placeholder exactly as written — checked here before any archive is built.
function packagedLocale(name) {
  const source = JSON.parse(readFileSync(join(pkg, name), 'utf8'));
  const kept = {};
  for (const [key, entry] of Object.entries(source)) {
    if (!entry || typeof entry.message !== 'string') fail(`${name}: "${key}" has no message`);
    const { description, ...rest } = entry;
    if (rest.placeholders) {
      rest.placeholders = Object.fromEntries(Object.entries(rest.placeholders)
        .map(([placeholder, { example, ...definition }]) => [placeholder, definition]));
    }
    kept[key] = rest;
  }

  const text = JSON.stringify(kept);
  const packaged = JSON.parse(text);
  if (Object.keys(packaged).join('\n') !== Object.keys(source).join('\n')) {
    fail(`${name}: packaging changed the keys`);
  }
  const placeholderContent = (entry) => JSON.stringify(Object.entries(entry.placeholders || {})
    .map(([placeholder, definition]) => [placeholder, definition?.content]));
  for (const [key, entry] of Object.entries(source)) {
    if (packaged[key].message !== entry.message) fail(`${name}: packaging changed the message of "${key}"`);
    if (placeholderContent(packaged[key]) !== placeholderContent(entry)) {
      fail(`${name}: packaging changed the placeholders of "${key}"`);
    }
  }
  return Buffer.from(text, 'utf8');
}

const localeReplacements = new Map(entryNames
  .filter((name) => name.startsWith('_locales/'))
  .map((name) => [name, packagedLocale(name)]));

const outDir = join(root, 'dist');
mkdirSync(outDir, { recursive: true });

const written = [];
function emit(fileName, archive) {
  const outPath = join(outDir, fileName);
  writeFileSync(outPath, archive);
  if (!readFileSync(outPath).equals(archive)) {
    fail(`${fileName} does not match the archive assembled from the current source tree`);
  }
  const shown = relative(process.cwd(), outPath).replace(/\\/g, '/');
  written.push(`${shown}  (${(archive.length / 1024).toFixed(1)} KB)`);
}

emit(`nexus.mods.bypass-${version}.zip`, buildArchive(entryNames, localeReplacements, { verbose: true }));

const firefoxOverride = new Map([
  ...localeReplacements,
  ['manifest.json', Buffer.from(`${JSON.stringify(firefoxManifest, null, 2)}\n`, 'utf8')]
]);
emit(`nexus.mods.bypass-${version}-firefox.zip`, buildArchive(entryNames, firefoxOverride));

console.log(`\nv${version} — ${entryNames.length} files`);
console.log(`Chrome/Edge:  ${written[0]}`);
console.log(`Firefox/AMO:  ${written[1]}`);
console.log(`              id ${GECKO_ID}, Firefox ${GECKO_MIN_VERSION}+`);
