const encode = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

export function bindings(db, overrides = {}) {
  return {
    DB: db,
    MAX_BODY_BYTES: '65536',
    PUSH_COOLDOWN_SECONDS: '1800',
    DETECTION_WINDOW_SECONDS: '900',
    SPIKE_REPORT_THRESHOLD: '10',
    DISTINCT_INSTALL_THRESHOLD: '3',
    RATE_LIMIT_WINDOW_SECONDS: '60',
    INGEST_IP_LIMIT: '60',
    INGEST_INSTALL_LIMIT: '20',
    HEARTBEAT_IP_LIMIT: '120',
    HEARTBEAT_INSTALL_LIMIT: '10',
    RATE_LIMIT_HASH_SECRET: 'test-only-rate-hash-secret-32-characters',
    CF_ACCESS_TEAM_DOMAIN: 'fixture.cloudflareaccess.com',
    CF_ACCESS_AUD: 'fixture-application-audience',
    VAPID_PUBLIC_KEY: '',
    VAPID_PRIVATE_KEY: '',
    VAPID_SUBJECT: 'mailto:owner@example.com',
    DISCORD_WEBHOOK_URL: '',
    ...overrides
  };
}

/** Real RSA signatures; only the exact configured Access JWKS URL is mocked. */
export async function createAccessFixture(t) {
  const teamDomain = 'fixture.cloudflareaccess.com';
  const audience = 'fixture-application-audience';
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: crypto.randomUUID(), alg: 'RS256', use: 'sig' };
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push(url);
    if (url !== `https://${teamDomain}/cdn-cgi/access/certs`) throw new Error('Unexpected network request in Access fixture');
    return Response.json({ keys: [jwk] });
  });
  async function token(overrides = {}) {
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: `https://${teamDomain}`, aud: [audience], exp: now + 3600,
      nbf: now - 5, iat: now - 5, sub: 'fixture-user', email: 'owner@example.com', ...overrides };
    const signingInput = `${encode({ alg: 'RS256', typ: 'JWT', kid: jwk.kid })}.${encode(claims)}`;
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(signingInput));
    return `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
  }
  async function headers(overrides = {}) {
    return { 'Cf-Access-Jwt-Assertion': await token(), ...overrides };
  }
  return { teamDomain, audience, token, headers, requests };
}
