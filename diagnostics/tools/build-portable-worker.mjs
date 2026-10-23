// Alternate deployment artifact for clients that cannot upload Workers Assets.
// The same authenticated Worker serves the same public files; no secrets are bundled.
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

export async function readPublicAssets(directory = join(root, 'public')) {
  const assets = {};
  for (const name of (await readdir(directory, { recursive: true })).sort()) {
    if (name.split(/[\\/]/).some((part) => part.startsWith('.'))) continue;
    const type = types[extname(name)];
    if (!type) continue;
    const bytes = await readFile(join(directory, name));
    assets['/' + name.replaceAll('\\', '/')] = { type, base64: bytes.toString('base64') };
  }
  if (!assets['/index.html'] || !assets['/app.js'] || !assets['/sw.js']) throw new Error('Incomplete public assets');
  return assets;
}

export function portableModules(workerSource, assets) {
  return {
    'index.js': `import worker from './worker.js';\nimport { createAssets } from './assets.js';\nconst assets = createAssets();\nexport default { fetch(request, env, context) {\n  return worker.fetch(request, { ...env, ASSETS: assets }, context);\n} };\n`,
    'worker.js': workerSource.replace(/\n\/\/# sourceMappingURL=.*$/m, ''),
    'assets.js': `const files = ${JSON.stringify(assets)};\nexport function createAssets() {\n  return { async fetch(input, init) {\n    const request = input instanceof Request ? input : new Request(input, init);\n    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });\n    const path = new URL(request.url).pathname;\n    const file = files[path === '/' ? '/index.html' : path] || (request.headers.get('accept')?.includes('text/html') ? files['/index.html'] : null);\n    if (!file) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });\n    const bytes = Uint8Array.from(atob(file.base64), (character) => character.charCodeAt(0));\n    return new Response(request.method === 'HEAD' ? null : bytes, { headers: { 'Content-Type': file.type, 'Content-Length': String(bytes.length), 'Cache-Control': 'no-store' } });\n  } };\n}\n`
  };
}

export async function buildPortableWorker({ source = join(root, '.wrangler/release-dry-run/index.js'), outdir = join(root, '.wrangler/portable') } = {}) {
  const modules = portableModules(await readFile(source, 'utf8'), await readPublicAssets());
  await mkdir(outdir, { recursive: true });
  for (const [name, content] of Object.entries(modules)) await writeFile(join(outdir, name), content);
  return modules;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const modules = await buildPortableWorker({ ...(process.argv[2] ? { source: resolve(process.argv[2]) } : {}) });
  console.log(`Portable Worker built: ${Object.keys(modules).length} modules; private routes still use the original Access middleware.`);
}
