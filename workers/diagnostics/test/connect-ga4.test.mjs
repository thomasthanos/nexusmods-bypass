import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const helper = () => import('../tools/connect-ga4.mjs');
const NOW = Date.UTC(2026, 9, 23, 12);
const REDIRECT = 'http://127.0.0.1:53682/oauth/callback';
const client = { client_id: 'diagnostics.apps.googleusercontent.com', client_secret: 'private-client-secret' };
const downloaded = () => ({ web: { ...client, redirect_uris: [REDIRECT], auth_uri: 'https://foreign.example/auth', token_uri: 'https://foreign.example/token' } });
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'diagnostics-ga4-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('importing the setup helper prints nothing and never opens a callback listener', () => {
  const url = new URL('../tools/connect-ga4.mjs', import.meta.url).href;
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`], { timeout: 2000, encoding: 'utf8' });
  assert.equal(result, '');
});

test('a dedicated web client creates readonly offline authorization with independent state and PKCE', async () => {
  const { createAuthorization } = await helper();
  const session = createAuthorization(client, { now: () => NOW });
  const url = new URL(session.url);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/analytics.readonly');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(session.verifier).digest('base64url'));
  assert.equal(url.searchParams.get('state'), session.state);
  assert.equal(session.expiresAt, NOW + 300_000);
  assert.match(session.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.notEqual(createAuthorization(client).state, session.state);
  assert.doesNotMatch(session.url, /private-client-secret|client_secret|refresh_token|code_verifier/);
});

test('callback validation rejects foreign hosts, paths, origins, methods and duplicate parameters', async () => {
  const { createAuthorization, createCallbackValidator } = await helper();
  const session = createAuthorization(client, { now: () => NOW });
  const validate = createCallbackValidator(session, { now: () => NOW });
  const valid = { method: 'GET', url: `/oauth/callback?code=private-code&state=${session.state}`, headers: { host: '127.0.0.1:53682' } };
  for (const request of [
    { ...valid, method: 'POST' },
    { ...valid, headers: { host: 'evil.example:53682' } },
    { ...valid, headers: { host: '127.0.0.1:53682', origin: 'https://evil.example' } },
    { ...valid, url: valid.url.replace('/oauth/callback', '/other') },
    { ...valid, url: `https://evil.example${valid.url}` },
    { ...valid, url: `/${valid.url}` },
    { ...valid, url: `${valid.url}&code=second-code` },
    { ...valid, url: `${valid.url}&state=second-state` },
    { ...valid, url: valid.url.replace(session.state, 'wrong-state') },
    { ...valid, url: valid.url.replace(session.state, '\u00e9'.repeat(session.state.length)) },
    { ...valid, url: `/oauth/callback?state=${session.state}&code=` }
  ]) {
    const result = validate(request);
    assert.notEqual(result.status, 200);
    assert.equal(result.code, undefined);
    assert.doesNotMatch(JSON.stringify(result), /private-code/);
  }
  assert.deepEqual(validate({ ...valid, headers: { ...valid.headers, origin: 'https://accounts.google.com' } }), { status: 200, complete: true, code: 'private-code' });
  assert.equal(validate(valid).status, 409, 'a valid callback can only be consumed once');
});

test('callback consent denial and expiration terminate the single-use session without exposing provider text', async () => {
  const { createAuthorization, createCallbackValidator } = await helper();
  const session = createAuthorization(client, { now: () => NOW });
  const denied = createCallbackValidator(session, { now: () => NOW });
  const request = { method: 'GET', headers: { host: '127.0.0.1:53682' }, url: `/oauth/callback?state=${session.state}&error=access_denied&error_description=private-provider-text` };
  const result = denied(request);
  assert.equal(result.complete, true);
  assert.equal(result.status, 400);
  assert.doesNotMatch(JSON.stringify(result), /private-provider-text|access_denied/);
  assert.equal(denied(request).status, 409);
  const expired = createCallbackValidator(session, { now: () => NOW + 300_000 });
  assert.equal(expired(request).status, 410);
});

test('downloaded client JSON is bounded and requires the fixed registered loopback URI', async (t) => {
  const { loadClientConfiguration } = await helper();
  const directory = await temporary(t);
  const path = join(directory, 'client.json');
  await writeFile(path, JSON.stringify(downloaded()));
  assert.deepEqual(await loadClientConfiguration(path), client);
  for (const content of [
    'invalid-json', JSON.stringify({ installed: downloaded().web }),
    JSON.stringify({ web: { ...downloaded().web, redirect_uris: ['http://localhost:53682/oauth/callback'] } }),
    JSON.stringify({ web: { ...downloaded().web, client_secret: '' } }),
    'x'.repeat(40_000)
  ]) {
    await writeFile(path, content);
    await assert.rejects(loadClientConfiguration(path), (error) => !/private-client-secret/.test(error.message));
  }
});

test('code exchange proves the exact property before returning refresh credentials and ignores downloaded endpoint URLs', async () => {
  const { createAuthorization, exchangeAndVerify } = await helper();
  const session = createAuthorization(client, { now: () => NOW });
  const calls = [];
  const credentials = await exchangeAndVerify({ client, session, code: 'private-code', fetch: async (input, init) => {
    const url = String(input); calls.push({ url, init });
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'private-access-token', refresh_token: 'private-refresh-token', token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/analytics.readonly', expires_in: 3600 });
    assert.equal(url, 'https://analyticsdata.googleapis.com/v1beta/properties/547084285:runRealtimeReport');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer private-access-token');
    assert.deepEqual(JSON.parse(init.body), { metrics: [{ name: 'activeUsers' }], minuteRanges: [{ startMinutesAgo: 29, endMinutesAgo: 0 }] });
    return Response.json({ metricHeaders: [{ name: 'activeUsers', type: 'TYPE_INTEGER' }], rowCount: 0 });
  } });
  assert.deepEqual(credentials, { ...client, refresh_token: 'private-refresh-token' });
  const form = Object.fromEntries(new URLSearchParams(calls[0].init.body));
  assert.deepEqual(form, { grant_type: 'authorization_code', client_id: client.client_id, client_secret: client.client_secret, code: 'private-code', code_verifier: session.verifier, redirect_uri: REDIRECT });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ init }) => init.redirect === 'manual' && init.signal instanceof AbortSignal));
});

test('failed, redirected, malformed and wrong-scope OAuth responses never yield credentials', async () => {
  const { createAuthorization, exchangeAndVerify } = await helper();
  const session = createAuthorization(client);
  for (const response of [
    () => Response.json({ error: 'private-provider-text' }, { status: 400 }),
    () => new Response('', { status: 302, headers: { location: 'https://evil.example' } }),
    () => Response.json({ access_token: 'private-access-token', token_type: 'Bearer' }),
    () => Response.json({ access_token: 'private-access-token', refresh_token: 'private-refresh-token', token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/analytics' }),
    () => new Response('x'.repeat(70_000))
  ]) {
    await assert.rejects(exchangeAndVerify({ client, session, code: 'private-code', fetch: async () => response() }), (error) => !/private-|<|provider/.test(error.message));
  }
  await assert.rejects(exchangeAndVerify({ client, session, code: 'private-code', fetch: async (input) => String(input).endsWith('/token')
    ? Response.json({ access_token: 'private-access-token', refresh_token: 'private-refresh-token', token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/analytics.readonly' })
    : Response.json({ error: 'private-provider-text' }, { status: 403 }) }), (error) => !/private-/.test(error.message));
});

test('credentials can only be written inside the ignored folder and never overwrite an existing file', async (t) => {
  const { validateOutputPath, writeCredentials } = await helper();
  const directory = await temporary(t);
  const output = join(directory, '.wrangler', 'ga4-credentials.json');
  assert.equal(validateOutputPath(output, directory), output);
  for (const path of [join(directory, 'credentials.json'), join(directory, '.wrangler', '..', 'tracked.json'), join(directory, '.wrangler')]) assert.throws(() => validateOutputPath(path, directory));
  await writeCredentials(output, { ...client, refresh_token: 'private-refresh-token' });
  const result = JSON.parse(await readFile(output, 'utf8'));
  assert.deepEqual(Object.keys(result), ['GA4_OAUTH_CREDENTIALS']);
  assert.deepEqual(JSON.parse(result.GA4_OAUTH_CREDENTIALS), { ...client, refresh_token: 'private-refresh-token' });
  await assert.rejects(writeCredentials(output, { ...client, refresh_token: 'different-token' }));
  assert.match(await readFile(output, 'utf8'), /private-refresh-token/);
});

test('CLI option parsing requires a client file and rejects unknown or missing arguments', async () => {
  const { parseArguments } = await helper();
  assert.deepEqual(parseArguments(['--client', 'client.json', '--output', '.wrangler/ga4-credentials.json']), { clientPath: 'client.json', outputPath: '.wrangler/ga4-credentials.json' });
  assert.equal(parseArguments(['--help']).help, true);
  for (const args of [[], ['--client'], ['--client', 'file', '--unknown'], ['--client', 'one', '--client', 'two'], ['--client', 'file', '--output']]) assert.throws(() => parseArguments(args));
});
