// Lint the current Firefox package even when dist/ also contains older release ZIPs.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'src/manifest.json'), 'utf8')).version;
const archive = join(root, 'dist', `nexus.mods.bypass-${version}-firefox.zip`);
const sourceDir = mkdtempSync(join(tmpdir(), 'nxtk-firefox-lint-'));
const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve('web-ext')), 'bin/web-ext.js');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal}).`);
}

try {
  run('unzip', ['-q', archive, '-d', sourceDir]);
  run(process.execPath, [cli, 'lint', '--source-dir', sourceDir]);
} finally {
  rmSync(sourceDir, { recursive: true, force: true });
}
