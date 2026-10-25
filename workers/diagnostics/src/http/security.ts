import { cloudflareAccess } from '@hono/cloudflare-access';
import type { Context, MiddlewareHandler } from 'hono';
import { installIdSchema } from '../schemas/ingest.ts';
import { integerSetting } from './config.ts';
import type { AppEnv } from './types.ts';

const MAX_BODY_BYTES = 65_536;
const MAX_ACCESS_TOKEN_BYTES = 8192;
const MAX_TIME = 253_402_300_799_999;
const encoder = new TextEncoder();
const publicPaths = new Set(['/api/ingest', '/api/ingest/automatic', '/api/heartbeat']);
const extensionOrigin = /^(?:chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function unavailable(c: Context<AppEnv>) { return c.json({ error: 'Service unavailable' }, 503); }
function unauthorized(c: Context<AppEnv>) { return c.json({ error: 'Unauthorized' }, 401); }

export const publicCors: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!publicPaths.has(c.req.path)) return next();
  const origin = c.req.header('Origin');
  if (!origin || !extensionOrigin.test(origin)) return c.json({ error: 'Origin forbidden' }, 403);
  c.header('Access-Control-Allow-Origin', origin);
  c.header('Vary', 'Origin');
  if (c.req.method === 'OPTIONS') {
    const method = c.req.header('Access-Control-Request-Method');
    const headers = c.req.header('Access-Control-Request-Headers');
    if (method !== 'POST' || !headers || headers.trim().toLowerCase() !== 'content-type') {
      return c.json({ error: 'Preflight forbidden' }, 403);
    }
    c.header('Access-Control-Allow-Methods', 'POST');
    c.header('Access-Control-Allow-Headers', 'Content-Type');
    c.header('Access-Control-Max-Age', '600');
    c.header('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
    return c.body(null, 204);
  }
  if (c.req.method !== 'POST') {
    c.header('Allow', 'POST, OPTIONS');
    return c.json({ error: 'Method not allowed' }, 405);
  }
  await next();
};

export const requireSameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.req.header('Origin') !== new URL(c.req.url).origin) {
    return c.json({ error: 'Origin forbidden' }, 403);
  }
  await next();
};

/** Read and count raw bytes before decoding/parsing; Content-Length is untrusted. */
export const boundedJson: MiddlewareHandler<AppEnv> = async (c, next) => {
  let maximum: number;
  try { maximum = integerSetting(c.env.MAX_BODY_BYTES, 1, MAX_BODY_BYTES); }
  catch { return unavailable(c); }
  const contentType = c.req.header('Content-Type') ?? '';
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(contentType)
      || c.req.header('Content-Encoding') !== undefined) {
    return c.json({ error: 'Unsupported media type' }, 415);
  }
  const reader = c.req.raw.body?.getReader();
  if (!reader) return c.json({ error: 'Invalid JSON body' }, 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum) {
        // Cancellation is advisory: an uncooperative source must not hold the
        // 413 response open. No further request bytes are read or retained.
        void reader.cancel().catch(() => {});
        return c.json({ error: 'Request body too large' }, 413);
      }
      chunks.push(chunk.value);
    }
  } catch {
    return c.json({ error: 'Invalid request body' }, 400);
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(text);
    // Hono 4.13.13's runtime caches promises; its declarations incorrectly type
    // these as resolved values. Its json() (and Zod) must reuse bounded text.
    const bodyCache: Record<string, unknown> = c.req.bodyCache;
    bodyCache.text = Promise.resolve(text);
    c.set('rawJson', parsed);
  } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
  await next();
};

function ipv4(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => /^(?:0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255);
}

/** URL's IPv6 parser also canonicalizes equivalent textual addresses. */
function canonicalIp(value: string | undefined): string | null {
  if (!value || value.length > 45) return null;
  if (ipv4(value)) return value;
  if (!value.includes(':') || !/^[0-9a-fA-F:.]+$/.test(value)) return null;
  const tail = value.slice(value.lastIndexOf(':') + 1);
  if (value.includes('.') && !ipv4(tail)) return null;
  try { return new URL(`https://[${value}]/`).hostname.slice(1, -1); }
  catch { return null; }
}

async function consumeRate(c: Context<AppEnv>, scope: 'ip' | 'install', subject: string,
  policy?: { limit: number; windowMs: number }): Promise<Response | null> {
  try {
    const secret = c.env.RATE_LIMIT_HASH_SECRET;
    if (typeof secret !== 'string' || secret.length < 32 || secret.length > 4096) return unavailable(c);
    const windowMs = policy?.windowMs ?? integerSetting(c.env.RATE_LIMIT_WINDOW_SECONDS, 1, 86_400) * 1000;
    const now = c.get('serverNow');
    if (!Number.isSafeInteger(now) || now < 0 || now > MAX_TIME - 2 * windowMs) return unavailable(c);
    const heartbeat = c.req.path === '/api/heartbeat';
    const limit = policy?.limit ?? integerSetting(scope === 'ip'
      ? (heartbeat ? c.env.HEARTBEAT_IP_LIMIT : c.env.INGEST_IP_LIMIT)
      : (heartbeat ? c.env.HEARTBEAT_INSTALL_LIMIT : c.env.INGEST_INSTALL_LIMIT), 1, 1_000_000);
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const hash = await crypto.subtle.sign('HMAC', key, encoder.encode(JSON.stringify([c.req.path, scope, subject])));
    const keyHash = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const start = Math.floor(now / windowMs) * windowMs;
    const accepted = await c.env.DB.prepare(`
      INSERT INTO rate_limit_buckets (scope,key_hash,window_started_at,window_duration_ms,request_count,expires_at)
      VALUES (?,?,?,?,1,?)
      ON CONFLICT (scope,key_hash,window_started_at,window_duration_ms) DO UPDATE
        SET request_count=rate_limit_buckets.request_count+1
        WHERE rate_limit_buckets.request_count < ?
      RETURNING request_count
    `).bind(scope, keyHash, start, windowMs, start + 2 * windowMs, limit).first<{ request_count: number }>();
    if (accepted) {
      if (accepted.request_count === 1) {
        // Keep expiry maintenance bounded and independent of admission. The
        // existing expiry index bounds the oldest-row scan to 100 records.
        await c.env.DB.prepare(`DELETE FROM rate_limit_buckets
          WHERE (scope,key_hash,window_started_at,window_duration_ms) IN (
            SELECT scope,key_hash,window_started_at,window_duration_ms
            FROM rate_limit_buckets WHERE expires_at<=? ORDER BY expires_at LIMIT 100
          )`).bind(now).run().catch(() => {});
      }
      return null;
    }
    c.header('Retry-After', String(Math.max(1, Math.ceil((start + windowMs - now) / 1000))));
    return c.json({ error: 'Rate limit exceeded' }, 429);
  } catch { return unavailable(c); }
}

export const limitPublicIp: MiddlewareHandler<AppEnv> = async (c, next) => {
  const subject = canonicalIp(c.req.header('CF-Connecting-IP'));
  if (!subject) return c.json({ error: 'Client address unavailable' }, 403);
  const response = await consumeRate(c, 'ip', subject);
  if (response) return response;
  await next();
};

export const limitPublicInstall: MiddlewareHandler<AppEnv> = async (c, next) => {
  const raw = c.get('rawJson');
  const parsed = installIdSchema.safeParse(raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>).install_id : undefined);
  if (!parsed.success) return c.json({ error: 'Invalid installation identifier' }, 400);
  const response = await consumeRate(c, 'install', parsed.data);
  if (response) return response;
  await next();
};

/** Register after requireAccess so the identity is cryptographically verified. */
export const limitAdminPushTest: MiddlewareHandler<AppEnv> = async (c, next) => {
  const payload = c.get('accessPayload');
  const identity = payload?.sub || payload?.email;
  if (typeof identity !== 'string' || identity.length === 0 || identity.length > 4096) return unauthorized(c);
  const response = await consumeRate(c, 'install', identity, { limit: 1, windowMs: 60_000 });
  if (response) return response;
  await next();
};

// Only trusted deployment configuration and the vendor's public JWKS cache are
// retained. Never retain requests, contexts, bearer tokens, or decoded claims.
const accessVerifiers = new Map<string, ReturnType<typeof cloudflareAccess>>();

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

type ClaimsFailure = 'malformed_assertion' | 'issuer_mismatch' | 'audience_mismatch'
  | 'invalid_claims' | 'expired_or_not_yet_valid';
type AccessFailure = ClaimsFailure | 'missing_assertion' | 'invalid_signature'
  | 'verifier_unavailable' | 'configuration_invalid';

/** Fixed categories only: assertions, identities and provider errors never enter logs. */
function accessRejected(c: Context<AppEnv>, reason: AccessFailure, status: 401 | 503 = 401) {
  const requestId = c.get('requestId');
  const validRequestId = typeof requestId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId);
  c.header('X-Diagnostics-Auth', reason);
  if (validRequestId) c.header('X-Request-ID', requestId);
  console.error(JSON.stringify({
    event: 'diagnostics_access_rejected', reason,
    target: c.req.path === '/api/admin' || c.req.path.startsWith('/api/admin/') ? 'admin_api' : 'private_asset',
    ...(validRequestId ? { request_id: requestId } : {})
  }));
  return status === 503 ? unavailable(c) : unauthorized(c);
}

function tokenClaimsFailure(token: string, issuer: string, audience: string): ClaimsFailure | null {
  if (token.length > MAX_ACCESS_TOKEN_BYTES) return 'malformed_assertion';
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return 'malformed_assertion';
  function decode(part: string): unknown {
    const encoded = part.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(encoded + '='.repeat((4 - encoded.length % 4) % 4)), (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  }
  try {
    const header = decode(parts[0]!);
    const claims = decode(parts[1]!);
    if (!object(header) || header.alg !== 'RS256' || Object.hasOwn(header, 'crit')
        || (header.typ !== undefined && header.typ !== 'JWT') || typeof header.kid !== 'string'
        || !/^[A-Za-z0-9_-]{1,256}$/.test(header.kid) || !object(claims)) return 'malformed_assertion';
    if (claims.iss !== issuer) return 'issuer_mismatch';
    const aud = claims.aud;
    if (!(typeof aud === 'string' ? aud === audience : Array.isArray(aud) && aud.length > 0
      && aud.length <= 32 && aud.every((entry) => typeof entry === 'string' && entry.length > 0) && aud.includes(audience))) return 'audience_mismatch';
    const { exp, nbf, iat } = claims;
    if (typeof exp !== 'number' || typeof nbf !== 'number' || typeof iat !== 'number'
        || ![exp, nbf, iat].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIME / 1000)) return 'invalid_claims';
    const now = Math.floor(Date.now() / 1000);
    return exp > now && nbf <= now && iat <= now && exp > nbf && exp > iat ? null : 'expired_or_not_yet_valid';
  } catch { return 'malformed_assertion'; }
}

export const requireAccess: MiddlewareHandler<AppEnv> = async (c, next) => {
  const teamDomain = c.env.CF_ACCESS_TEAM_DOMAIN;
  const audience = c.env.CF_ACCESS_AUD;
  if (typeof teamDomain !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(teamDomain)
      || typeof audience !== 'string' || audience.length === 0 || audience.length > 256 || !/^[\x21-\x7e]+$/.test(audience)) return accessRejected(c, 'configuration_invalid', 503);
  const token = c.req.header('Cf-Access-Jwt-Assertion')?.trim();
  if (!token) return accessRejected(c, 'missing_assertion');
  const claimsFailure = tokenClaimsFailure(token, `https://${teamDomain}`, audience);
  if (claimsFailure) return accessRejected(c, claimsFailure);
  const cacheKey = JSON.stringify([teamDomain, audience]);
  let verifier = accessVerifiers.get(cacheKey);
  if (!verifier) {
    verifier = cloudflareAccess(teamDomain.slice(0, -'.cloudflareaccess.com'.length), audience);
    if (accessVerifiers.size >= 4) accessVerifiers.delete(accessVerifiers.keys().next().value!);
    accessVerifiers.set(cacheKey, verifier);
  }
  // Version 0.4.0 owns its trusted JWKS fetch and exposes no fetch/signal hook.
  // Do not race this middleware: a late next() could mutate after a 503 response.
  let verified = false;
  try {
    await verifier(c, async () => { verified = true; });
  } catch { return accessRejected(c, 'verifier_unavailable', 503); }
  if (!verified) return accessRejected(c, 'invalid_signature');
  await next();
};
