// The locale gate against small source trees, each broken in one way: it has to fail with the reason
// named, and pass the tree that is not broken.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const checker = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'check-locales.mjs');

const english = {
  appName: { message: 'Test Extension' },
  appDesc: { message: 'Downloads things.' },
  greeting: { message: 'Hello $1', placeholders: { name: { content: '$1' } } },
  fileCount: { message: '$COUNT$ files in $FOLDER$', placeholders: { count: { content: '$1' }, folder: { content: '$2' } } }
};
const german = {
  appName: { message: 'Test-Erweiterung' },
  appDesc: { message: 'Lädt Dinge herunter.' },
  greeting: { message: 'Hallo $1', placeholders: { name: { content: '$1' } } },
  fileCount: { message: '$COUNT$ Dateien in $FOLDER$', placeholders: { count: { content: '$1' }, folder: { content: '$2' } } }
};
const code = "const a = NXTK.t('greeting', [n]); const b = chrome.i18n.getMessage('fileCount', [c, f]);\n";

function tree({ en = english, de = german, deText = null, source = code } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nxtk-locales-'));
  fs.mkdirSync(path.join(root, '_locales/en'), { recursive: true });
  fs.mkdirSync(path.join(root, '_locales/de'), { recursive: true });
  fs.mkdirSync(path.join(root, 'content'));
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: '__MSG_appName__', description: '__MSG_appDesc__', default_locale: 'en', version: '1.0.0'
  }));
  fs.writeFileSync(path.join(root, 'content/errors.js'), 'const DEFINITIONS = {\n  };\n');
  fs.writeFileSync(path.join(root, 'popup.js'), source);
  fs.writeFileSync(path.join(root, '_locales/en/messages.json'), JSON.stringify(en, null, 2));
  fs.writeFileSync(path.join(root, '_locales/de/messages.json'), deText ?? JSON.stringify(de, null, 2));
  return root;
}

function check(options) {
  const root = tree(options);
  try {
    const run = spawnSync(process.execPath, [checker, root], { encoding: 'utf8' });
    return { status: run.status, output: `${run.stdout}${run.stderr}` };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const clean = check();
assert.equal(clean.status, 0, `a consistent tree passes:\n${clean.output}`);

const germanText = JSON.stringify(german, null, 2);
for (const [label, options, reason] of [
  ['a key defined twice', { deText: germanText.replace('"greeting": {', '"greeting": { "message": "Hi $1" },\n  "greeting": {') }, /"greeting" is defined twice/],
  ['a trailing comma', { deText: germanText.replace(/\}\s*$/, ',}') }, /invalid JSON/],
  ['a byte-order mark', { deText: `\uFEFF${germanText}` }, /byte-order mark/],
  ['a positional placeholder dropped', { de: { ...german, greeting: { message: 'Hallo', placeholders: { name: { content: '$1' } } } } }, /"greeting" placeholders differ from en — missing \$1/],
  ['a named placeholder pointing at the wrong argument', {
    de: { ...german, fileCount: { ...german.fileCount, placeholders: { count: { content: '$2' }, folder: { content: '$1' } } } }
  }, /"fileCount" placeholder \$count\$ is "\$2" here but "\$1" in en/],
  ['a named placeholder with no definition', { de: { ...german, fileCount: { message: '$COUNT$ Dateien in $FOLDER$', placeholders: { count: { content: '$1' } } } } },
    /"fileCount" uses \$folder\$ with no placeholders entry/],
  ['two names Chrome reads as one', { en: { ...english, Greeting: { message: 'Hi' } }, source: `${code}NXTK.t('Greeting');\n` }, /"Greeting" and "greeting" are the same name to Chrome/],
  ['a name with a character Chrome refuses', { en: { ...english, 'bad-name': { message: 'x' } }, source: `${code}NXTK.t('bad-name');\n` }, /"bad-name" has a character Chrome does not allow/],
  ['a key missing from a translation', { de: { appName: german.appName, appDesc: german.appDesc, greeting: german.greeting } }, /de: missing key "fileCount"/],
  ['a key only a translation has', { de: { ...german, stray: { message: 'x' } } }, /de: extra key "stray" not in en/],
  ['a key no code uses', { en: { ...english, unusedThing: { message: 'x' } }, de: { ...german, unusedThing: { message: 'x' } } }, /"unusedThing" is not used anywhere in src/],
  ['code asking for a key that does not exist', { source: `${code}NXTK.t('missingThing');\n` }, /code references "missingThing"/],
  ['a store description over 132 characters', { de: { ...german, appDesc: { message: 'ä'.repeat(133) } } }, /"appDesc" is 133 characters; the store listing allows 132/],
  ['markup in a message', { de: { ...german, greeting: { message: 'Hallo <b>$1</b>', placeholders: { name: { content: '$1' } } } } }, /"greeting" contains HTML markup/]
]) {
  const result = check(options);
  assert.equal(result.status, 1, `${label}: the gate fails\n${result.output}`);
  assert.match(result.output, reason, `${label}: and says why`);
}
console.log('locale gate behavior OK');
