#!/usr/bin/env node
// Locale gate: every catalogue parses, has the English keys and no others, keeps each placeholder the
// English text has (positional $1 and named $NAME$, with the same content), and holds nothing the code
// does not use. Exits 1 on any error, so the release gate (tools/build-zip.mjs) stops on it.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// The source tree to check; tests/unit/check-locales-test.mjs points it at small fixture trees.
const pkg = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const localesDir = join(pkg, '_locales');
const MASTER = 'en';
// Chrome Web Store limits for what the manifest shows in the listing.
const STORE_LIMITS = { appName: 75, appDesc: 132 };
// Keys the code builds at run time in a way the scan below cannot see. Each entry says where.
const ALLOW_UNREFERENCED = new Set([]);

const errors = [];
const warnings = [];

// JSON.parse keeps the last of two equal keys, so a pasted-in second copy of a message silently
// replaces the first. Run on text that already parsed.
function duplicateKeys(text) {
  const duplicates = [];
  const frames = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const frame = frames[frames.length - 1];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      if (frame?.object && frame.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1));
        if (frame.keys.has(key)) duplicates.push([...frame.path, key].join('.'));
        frame.keys.add(key);
        frame.lastKey = key;
        frame.expectKey = false;
      }
      i = j;
    } else if (ch === '{' || ch === '[') {
      const path = frame ? [...frame.path, frame.object ? frame.lastKey : '[]'] : [];
      frames.push({ object: ch === '{', keys: new Set(), expectKey: ch === '{', path });
    } else if (ch === '}' || ch === ']') {
      frames.pop();
    } else if (ch === ',' && frame?.object) {
      frame.expectKey = true;
    }
  }
  return duplicates;
}

function readCatalogue(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    errors.push(`${path}: unreadable — ${cause.message}`);
    return null;
  }
  if (text.charCodeAt(0) === 0xfeff) {
    errors.push(`${path}: starts with a byte-order mark; save it as UTF-8 without BOM`);
    text = text.slice(1);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (cause) {
    errors.push(`${path}: invalid JSON — ${cause.message}`);
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    errors.push(`${path}: the catalogue must be a JSON object`);
    return null;
  }
  for (const key of duplicateKeys(text)) errors.push(`${path}: "${key}" is defined twice; the first is ignored`);
  return data;
}

function placeholderNames(entry) {
  return new Set([...String(entry?.message || '').matchAll(/\$([A-Za-z0-9_]+)\$/g)].map((m) => m[1].toLowerCase()));
}
function placeholderSignature(entry) {
  const positional = [...String(entry?.message || '').matchAll(/\$([1-9])(?!\$)/g)].map((m) => `$${m[1]}`);
  const named = [...placeholderNames(entry)].map((name) => `$${name}$`);
  return [...new Set([...positional, ...named])].sort();
}
// What each named placeholder stands for. A $COUNT$ that is $1 in English and $2 here shows the
// wrong argument, which the message text alone does not reveal.
function placeholderContents(entry) {
  return new Map(Object.entries(entry?.placeholders || {}).map(([name, definition]) => [name.toLowerCase(), definition?.content]));
}

const locales = readdirSync(localesDir).filter((dir) => existsSync(join(localesDir, dir, 'messages.json')));
if (!locales.includes(MASTER)) {
  console.error(`FAIL: no ${MASTER} master catalogue in _locales/`);
  process.exit(1);
}
const master = readCatalogue(join(localesDir, MASTER, 'messages.json'));
if (!master) {
  errors.forEach((e) => console.error(`  FAIL: ${e}`));
  process.exit(1);
}
const masterKeys = new Set(Object.keys(master));

let manifest = null;
try {
  manifest = JSON.parse(readFileSync(join(pkg, 'manifest.json'), 'utf8'));
} catch (cause) {
  errors.push(`manifest.json: invalid JSON — ${cause.message}`);
}
if (manifest && !locales.includes(manifest.default_locale)) {
  errors.push(`manifest.json: default_locale "${manifest.default_locale}" has no _locales/${manifest.default_locale}/messages.json`);
}

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
const pluralBases = new Set([...masterKeys].filter((k) => PLURAL_SUFFIX.test(k)).map((k) => k.replace(PLURAL_SUFFIX, '')));

for (const locale of locales) {
  const path = join(localesDir, locale, 'messages.json');
  const data = readCatalogue(path);
  if (!data) continue;
  const keys = new Set(Object.keys(data));

  // Chrome reads message names case-insensitively and only from [A-Za-z0-9_@]; "@@" names are its own.
  const byLowerCase = new Map();
  for (const key of keys) {
    if (!/^[A-Za-z0-9_@]+$/.test(key)) errors.push(`${locale}: "${key}" has a character Chrome does not allow in a message name`);
    if (key.startsWith('@@')) errors.push(`${locale}: "${key}" uses the reserved @@ prefix`);
    const lower = key.toLowerCase();
    if (byLowerCase.has(lower)) errors.push(`${locale}: "${key}" and "${byLowerCase.get(lower)}" are the same name to Chrome`);
    byLowerCase.set(lower, key);
  }

  for (const k of masterKeys) {
    if (keys.has(k)) continue;
    if (PLURAL_SUFFIX.test(k) && keys.has(`${k.replace(PLURAL_SUFFIX, '')}_other`)) continue;
    errors.push(`${locale}: missing key "${k}"`);
  }
  for (const k of keys) {
    if (masterKeys.has(k)) continue;
    if (PLURAL_SUFFIX.test(k) && pluralBases.has(k.replace(PLURAL_SUFFIX, ''))) continue;
    errors.push(`${locale}: extra key "${k}" not in ${MASTER}`);
  }
  for (const base of pluralBases) {
    if (!keys.has(`${base}_other`)) errors.push(`${locale}: plural "${base}" has no _other form`);
  }

  for (const [key, entry] of Object.entries(data)) {
    if (!entry || typeof entry.message !== 'string' || !entry.message.trim()) {
      errors.push(`${locale}: "${key}" has an empty message`);
      continue;
    }
    if (/<[a-z][\s\S]*>/i.test(entry.message)) errors.push(`${locale}: "${key}" contains HTML markup`);
    const limit = STORE_LIMITS[key];
    if (limit && [...entry.message].length > limit) {
      errors.push(`${locale}: "${key}" is ${[...entry.message].length} characters; the store listing allows ${limit}`);
    }

    // Most messages use $1 directly and declare their placeholders only as notes for translators; the
    // ones a message names ($NAME$) are the ones the browser substitutes.
    const declared = placeholderContents(entry);
    const used = placeholderNames(entry);
    for (const name of used) {
      if (!declared.has(name)) errors.push(`${locale}: "${key}" uses $${name}$ with no placeholders entry`);
      else if (typeof declared.get(name) !== 'string' || !declared.get(name)) errors.push(`${locale}: "${key}" placeholder $${name}$ has no content`);
    }
    if (!masterKeys.has(key)) continue;

    const mine = placeholderSignature(entry);
    const theirs = placeholderSignature(master[key]);
    const missing = theirs.filter((name) => !mine.includes(name));
    const extra = mine.filter((name) => !theirs.includes(name));
    if (missing.length || extra.length) {
      const detail = [
        missing.length ? `missing ${missing.join(', ')}` : '',
        extra.length ? `unexpected ${extra.join(', ')}` : ''
      ].filter(Boolean).join('; ');
      errors.push(`${locale}: "${key}" placeholders differ from ${MASTER} — ${detail}`);
    }
    const masterContents = placeholderContents(master[key]);
    for (const name of used) {
      if (masterContents.has(name) && declared.has(name) && masterContents.get(name) !== declared.get(name)) {
        errors.push(`${locale}: "${key}" placeholder $${name}$ is "${declared.get(name)}" here but "${masterContents.get(name)}" in ${MASTER}`);
      }
    }
  }
}

// What the code asks for. Everything under src/ except the catalogues themselves is read: the worker
// and the shared files ask for messages too.
const referenced = new Set();
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (full === localesDir) continue;
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(js|html|json)$/.test(name)) continue;
    const src = readFileSync(full, 'utf8');
    for (const m of src.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) referenced.add(m[1]);
    for (const m of src.matchAll(/\b(?:NXTK\.)?(?:t|tPlural|T|TS|L|getMessage)\(\s*['"`]([A-Za-z0-9_@]+)['"`]/g)) referenced.add(m[1]);
    for (const m of src.matchAll(/__MSG_(\w+)__/g)) referenced.add(m[1]);
    for (const m of src.matchAll(/['"`]([A-Za-z][A-Za-z0-9_]{4,})['"`]/g)) {
      if (masterKeys.has(m[1])) referenced.add(m[1]);
    }
  }
}
walk(pkg);

const errorKeys = new Set();
try {
  const src = readFileSync(join(pkg, 'content', 'errors.js'), 'utf8');
  const block = src.slice(src.indexOf('const DEFINITIONS'), src.indexOf('\n  };', src.indexOf('const DEFINITIONS')));
  for (const m of block.matchAll(/^\s{4}(\w+):\s*\{/gm)) {
    const camel = m[1].split('_')
      .map((p, i) => (i === 0 ? p : p[0].toUpperCase() + p.slice(1))).join('');
    const base = `err${camel[0].toUpperCase()}${camel.slice(1)}`;
    errorKeys.add(`${base}Msg`);
    if (!/recovery:\s*''/.test(block.slice(m.index, block.indexOf('\n    }', m.index)))) {
      errorKeys.add(`${base}Fix`);
    }
  }
  for (const k of errorKeys) {
    if (!masterKeys.has(k)) errors.push(`errors.js expects "${k}" but ${MASTER} does not define it`);
  }
} catch (cause) {
  errors.push(`could not cross-check errors.js: ${cause.message}`);
}

for (const key of masterKeys) {
  const base = key.replace(PLURAL_SUFFIX, '');
  if (referenced.has(key) || referenced.has(base) || errorKeys.has(key) || ALLOW_UNREFERENCED.has(key)) continue;
  if (/^err[A-Z].*(Msg|Fix)$/.test(key)) {
    errors.push(`"${key}" looks like an error key but matches no code in errors.js`);
    continue;
  }
  errors.push(`"${key}" is not used anywhere in src/ (remove it from every catalogue, or list it in ALLOW_UNREFERENCED with where it is built)`);
}
for (const key of referenced) {
  if (masterKeys.has(key)) continue;
  const plural = [...masterKeys].some((k) => k.startsWith(`${key}_`));
  if (!plural) errors.push(`code references "${key}" which ${MASTER} does not define`);
}

console.log(`Checked ${locales.length} locales (${masterKeys.size} keys): ${locales.join(', ')}`);
warnings.forEach((w) => console.log(`  warn: ${w}`));
if (errors.length) {
  errors.forEach((e) => console.error(`  FAIL: ${e.replace(pkg, relative(process.cwd(), pkg))}`));
  console.error(`\n${errors.length} error(s).`);
  process.exit(1);
}
console.log(`OK — ${warnings.length} warning(s), 0 errors.`);
