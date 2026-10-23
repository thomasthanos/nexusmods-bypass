import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { access, mkdir, open, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT = fileURLToPath(new URL('..', import.meta.url));
const REDIRECT = 'http://127.0.0.1:53682/oauth/callback';
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const TOKEN = 'https://oauth2.googleapis.com/token';
const REALTIME = 'https://analyticsdata.googleapis.com/v1beta/properties/547084285:runRealtimeReport';
const MAX_JSON_BYTES = 65_536;
const SESSION_MS = 300_000;

// Only these locally authored messages are safe to print. Never print external error objects.
class SetupError extends Error {}
const failure = () => new SetupError('Google Analytics connection failed. Check consent, API access, and client configuration, then retry.');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
function secret(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value)) throw failure();
  return value;
}

export function parseArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]; const value = args[index + 1];
    const field = name === '--client' ? 'clientPath' : name === '--output' ? 'outputPath' : null;
    if (!field || Object.hasOwn(result, field) || !value || value.startsWith('--')) throw new SetupError('Use --client <downloaded-web-client.json> and optionally --output <.wrangler/file.json>.');
    result[field] = value;
  }
  if (!result.clientPath) throw new SetupError('A downloaded Web application OAuth client is required: --client <file.json>.');
  return result;
}

export async function loadClientConfiguration(path) {
  let file;
  try {
    file = await open(path, 'r');
    const buffer = Buffer.alloc(32_769);
    let size = 0;
    while (size < buffer.length) {
      const read = await file.read(buffer, size, buffer.length - size, size);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    if (size > 32_768) throw failure();
    const source = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size))));
    const web = object(source?.web);
    if (!web || !Array.isArray(web.redirect_uris) || !web.redirect_uris.includes(REDIRECT)) throw failure();
    return { client_id: secret(web.client_id), client_secret: secret(web.client_secret) };
  } catch { throw new SetupError('Read a valid Web application OAuth client JSON with the registered redirect http://127.0.0.1:53682/oauth/callback.'); }
  finally { await file?.close(); }
}

export function createAuthorization(client, options = {}) {
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: secret(client.client_id), redirect_uri: REDIRECT, response_type: 'code',
    scope: SCOPE, access_type: 'offline', prompt: 'consent', state,
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
  return { url: url.href, state, verifier, expiresAt: (options.now ?? Date.now)() + SESSION_MS };
}

export function createCallbackValidator(session, options = {}) {
  let consumed = false;
  return (request) => {
    if (consumed) return { status: 409, complete: false };
    if ((options.now ?? Date.now)() >= session.expiresAt) return { status: 410, complete: true };
    if (request.method !== 'GET' || request.headers?.host !== '127.0.0.1:53682'
      || (request.headers.origin !== undefined && request.headers.origin !== 'https://accounts.google.com')
      || typeof request.url !== 'string' || request.url.length > 8192
      || !request.url.startsWith('/') || request.url.startsWith('//')) return { status: 400, complete: false };
    let url;
    try { url = new URL(request.url, REDIRECT); } catch { return { status: 400, complete: false }; }
    if (url.origin !== new URL(REDIRECT).origin || url.pathname !== '/oauth/callback' || url.hash) return { status: 400, complete: false };
    const states = url.searchParams.getAll('state');
    const state = states[0];
    if (states.length !== 1 || typeof state !== 'string' || !/^[A-Za-z0-9_-]+$/.test(state) || state.length !== session.state.length
      || !timingSafeEqual(Buffer.from(state), Buffer.from(session.state))) return { status: 400, complete: false };
    if (url.searchParams.has('error')) { consumed = true; return { status: 400, complete: true }; }
    const codes = url.searchParams.getAll('code');
    const code = codes[0];
    if (codes.length !== 1 || typeof code !== 'string' || code.length < 1 || code.length > 4096 || /[\u0000-\u0020\u007f]/.test(code)) return { status: 400, complete: false };
    consumed = true;
    return { status: 200, complete: true, code };
  };
}

/** Start only when called by the CLI; importing this file performs no I/O. */
export async function waitForCallback(session, onListening = () => {}) {
  const validate = createCallbackValidator(session);
  return new Promise((resolveCode, reject) => {
    let timer;
    let finished = false;
    const server = createServer((request, response) => {
      const result = validate(request);
      response.writeHead(result.status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', Pragma: 'no-cache',
        'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' });
      response.end(result.status === 200 ? 'Authorization received. You can close this tab and return to the terminal.' : 'Authorization callback rejected. Return to the terminal.');
      if (result.complete) finish(result.code);
    });
    const interrupt = () => finish();
    const finish = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      process.removeListener('SIGINT', interrupt);
      server.close();
      if (code) resolveCode(code); else reject(new SetupError('Authorization expired, was canceled, or was denied. Run the helper again.'));
    };
    server.on('error', () => finish());
    process.once('SIGINT', interrupt);
    timer = setTimeout(() => finish(), Math.max(0, session.expiresAt - Date.now()));
    server.listen(53682, '127.0.0.1', () => {
      if (!finished) {
        try { onListening(); } catch { finish(); }
      }
    });
  });
}

async function jsonRequest(fetcher, url, init) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(failure()); }, 10_000);
  });
  const operation = async () => {
    const response = await fetcher(url, { ...init, redirect: 'manual', signal: controller.signal });
    if (!response.ok || controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw failure(); }
    const reader = response.body?.getReader();
    if (!reader) throw failure();
    const cancel = () => { void reader.cancel().catch(() => {}); };
    controller.signal.addEventListener('abort', cancel, { once: true });
    const chunks = []; let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (controller.signal.aborted) throw failure();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_JSON_BYTES) { cancel(); throw failure(); }
        chunks.push(chunk.value);
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
    } finally {
      controller.signal.removeEventListener('abort', cancel);
      reader.releaseLock();
    }
  };
  try { return await Promise.race([operation(), deadline]); }
  catch { throw failure(); }
  finally { clearTimeout(timer); }
}

export async function exchangeAndVerify(options) {
  const fetcher = options.fetch ?? fetch;
  const token = object(await jsonRequest(fetcher, TOKEN, { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: options.client.client_id,
      client_secret: options.client.client_secret, code: options.code, code_verifier: options.session.verifier, redirect_uri: REDIRECT }).toString() }));
  const accessToken = secret(token?.access_token);
  const refreshToken = secret(token?.refresh_token);
  if (token?.token_type !== 'Bearer' || token.scope !== SCOPE) throw failure();
  const proof = object(await jsonRequest(fetcher, REALTIME, { method: 'POST', headers: {
    Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json'
  }, body: JSON.stringify({ metrics: [{ name: 'activeUsers' }], minuteRanges: [{ startMinutesAgo: 29, endMinutesAgo: 0 }] }) }));
  if (!proof || !Array.isArray(proof.metricHeaders) || proof.metricHeaders.length !== 1
    || proof.metricHeaders[0]?.name !== 'activeUsers' || proof.metricHeaders[0]?.type !== 'TYPE_INTEGER'
    || (proof.metadata?.emptyReason && typeof proof.metadata.emptyReason === 'string')) throw failure();
  const rows = proof.rows ?? [];
  if (!Array.isArray(rows) || rows.length > 1 || (proof.rowCount !== undefined && proof.rowCount !== rows.length)) throw failure();
  for (const row of rows) {
    const value = row?.metricValues?.[0]?.value;
    if (!Array.isArray(row?.metricValues) || row.metricValues.length !== 1 || typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw failure();
  }
  return { client_id: options.client.client_id, client_secret: options.client.client_secret, refresh_token: refreshToken };
}

export function validateOutputPath(path, project = PROJECT) {
  const output = resolve(path);
  const child = relative(resolve(project, '.wrangler'), output);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new SetupError('Write credentials only inside the diagnostics .wrangler folder, which Git ignores.');
  return output;
}

export async function writeCredentials(path, credentials) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ GA4_OAUTH_CREDENTIALS: JSON.stringify(credentials) }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  if (options.help) {
    process.stdout.write('Usage: node tools/connect-ga4.mjs --client <downloaded-web-client.json> [--output .wrangler/ga4-credentials.json]\n');
    return;
  }
  const client = await loadClientConfiguration(options.clientPath);
  const output = validateOutputPath(options.outputPath ?? resolve(PROJECT, '.wrangler', 'ga4-credentials.json'));
  try { await access(output); throw new SetupError('The output file already exists. Choose a new filename inside .wrangler or remove the old file before retrying.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const session = createAuthorization(client);
  const code = await waitForCallback(session, () => {
    process.stdout.write('Open this URL in your browser and authorize the Google account that can read property 547084285. This link expires in five minutes.\n');
    process.stdout.write(`${session.url}\n`);
  });
  const credentials = await exchangeAndVerify({ client, session, code });
  await writeCredentials(output, credentials);
  process.stdout.write('Verified read access to property 547084285. Credentials saved in the ignored .wrangler folder.\n');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof SetupError ? error.message : failure().message}\n`);
    process.exitCode = 1;
  });
}
