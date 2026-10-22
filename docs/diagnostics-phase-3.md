# Phase 3: Complete Hono API server

Complete, unabbreviated Phase 3 sources, integration changes, configuration and tests. The executable files in diagnostics/ are authoritative. The unchanged Phase 1 schema, ingest schemas, extension example, and Phase 2 sanitizer/fingerprinting modules remain required in the project. No Phase 4 PWA or remote deployment is included.

The router provides hardened public ingest/heartbeat, cryptographic Access protection for every admin and asset path, atomic D1 acceptance and regression transitions, filtered issue/release APIs, and push subscription management. The full README at the end documents setup, HTTP contracts, privacy and delivery limits.

## Source integrity

Text hashes use UTF-8 with LF line endings for portable verification.

| File | SHA-256 |
| --- | --- |
| diagnostics/package.json | 335919811876dedf64049d0b14438ace4edd3bf4d8fe21f42c8fbcf8f36de3d0 |
| diagnostics/tsconfig.json | 815ca099d1b62c7826288ce3cf24a2e436b0a18af31c51e512d77220cdfebea2 |
| diagnostics/wrangler.toml | 377f857c47100a1880c402fb39759f2c311ffbdd0aea9299f54a17a4700950e6 |
| diagnostics/public/.assetsignore | 64263feac7b00952e9ec3b6c1fd11316faa58ff673c6bd085fac9f6f8d8389f6 |
| diagnostics/src/index.ts | 8983d303d5b25b94eabb75c0674a933bb22d061f7c81e7e3179e4c5c2981f114 |
| diagnostics/src/http/types.ts | cf496f9590adc09cc7de556368544eb9b05ed432481786241b5ffaf31d7d3492 |
| diagnostics/src/http/config.ts | 872a761ca2bc25b7a29502185d59bb177a08889cf24dacb49eed885fda788825 |
| diagnostics/src/http/security.ts | 4fb748453d4cf69f12a3922fe3feff098e0881bc571634be9fde9799e26fb3a1 |
| diagnostics/src/services/ingestion.ts | 914752c9efdabe1fad495ccb47ff4f6aa925d2b843d410dd9ee0678a2d8e7ab2 |
| diagnostics/src/routes/admin.ts | f0a8cfb656896b01b9db753ea99faa5d79bb733573cdbd41f147e3d23f07e586 |
| diagnostics/src/services/ruleEngine.ts | 8335d31f8120e8ca8bbeb9cf475795a2c05e178267d6c9d58de2ad99f4ed7621 |
| diagnostics/src/services/delivery.ts | ecd9402c65b8b1093b88754d86647e08051da8f1b2b41fd5e26453d11a824c59 |
| diagnostics/src/services/notifications.ts | 6b3d582bf58df9686aeb088524c2365b77b3121ba070470301e5839296138269 |
| diagnostics/test/helpers/d1.mjs | f17ecd64c6c1990ef5ece3c49351e304051c1ed8cdd15ac64e7d381fc8b22032 |
| diagnostics/test/helpers/access.mjs | e06e6cb9fbc7c29435fb074c2bf07d7a06612ec7485e4a51a4bf36e893a75f9c |
| diagnostics/test/security.test.mjs | de4e51cdd440e2d97705ec118b38e293875b33697bff55ace57f804cea0b45a5 |
| diagnostics/test/ingestion.test.mjs | 7a617f05b03faf8a8561d284b163847623dd51e1cac51d101337c76554b139d7 |
| diagnostics/test/admin.test.mjs | b82f4a2662790e398e5cb00b4fa4182f4fb3ed31cab90a963305d868af4e73b1 |
| diagnostics/test/api.test.mjs | dc15207084321b5e564b6edf5e28e4721936d5e583d9de8146b47c7069cc8a65 |
| diagnostics/test/notifications.test.mjs | 76578f9b73186f2742586b2b18abe58bddea70293ebd6908aa40d590427adbb1 |
| diagnostics/README.md | 234fa8060cd84ab3e68a34820801b27aff91df9b582d34101418d8df4e44fd29 |

## diagnostics/package.json

````json
{
  "name": "nexusmods-diagnostics",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "Private Cloudflare diagnostics API and PWA for NexusMods Bypass.",
  "engines": { "node": ">=24.0.0" },
  "scripts": {
    "test": "node --test test/*.test.mjs",
    "typecheck": "npm run cf:types && tsc --noEmit",
    "check": "npm run typecheck && npm test",
    "cf:types": "wrangler types worker-configuration.d.ts",
    "db:init:local": "wrangler d1 execute DB --local --file=schema.sql",
    "db:init:remote": "wrangler d1 execute DB --remote --file=schema.sql",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "dependencies": {
    "@block65/webcrypto-web-push": "2.0.0",
    "@hono/cloudflare-access": "0.4.0",
    "@hono/zod-validator": "0.9.1",
    "compare-versions": "6.1.1",
    "error-stack-parser-es": "2.0.1",
    "hono": "4.13.13",
    "zod": "4.6.7"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "5.20261021.1",
    "typescript": "7.0.2",
    "wrangler": "4.151.3"
  }
}
````

## diagnostics/tsconfig.json

````json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": [],
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*.ts", "examples/**/*.ts", "worker-configuration.d.ts"]
}
````

## diagnostics/wrangler.toml

````toml
name = "nexusmods-diagnostics"
main = "src/index.ts"
compatibility_date = "2026-10-21"
workers_dev = false
preview_urls = false

# The entrypoint is delivered in Phase 3; assets are delivered in Phase 4.
# Every asset request must pass the Access-verifying Worker first.
[assets]
directory = "./public"
binding = "ASSETS"
run_worker_first = true
not_found_handling = "single-page-application"

[[d1_databases]]
binding = "DB"
database_name = "nexusmods-diagnostics"
# Wrangler provisions this database when deployed; no invented database ID.

[vars]
MAX_BODY_BYTES = "65536"
PUSH_COOLDOWN_SECONDS = "1800"
DETECTION_WINDOW_SECONDS = "900"
SPIKE_REPORT_THRESHOLD = "10"
DISTINCT_INSTALL_THRESHOLD = "3"
RATE_LIMIT_WINDOW_SECONDS = "60"
INGEST_IP_LIMIT = "60"
INGEST_INSTALL_LIMIT = "20"
HEARTBEAT_IP_LIMIT = "120"
HEARTBEAT_INSTALL_LIMIT = "10"

# Required runtime environment bindings; values are set outside version control.
# Public configuration is also bound as secrets to avoid fabricated account values.
[secrets]
required = [
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "VAPID_SUBJECT",
  "DISCORD_WEBHOOK_URL",
  "CF_ACCESS_TEAM_DOMAIN",
  "CF_ACCESS_AUD",
  "RATE_LIMIT_HASH_SECRET"
]

[observability]
enabled = true
head_sampling_rate = 1

[observability.logs]
enabled = true
invocation_logs = false
````

## diagnostics/public/.assetsignore

````text
.*
````

## diagnostics/src/index.ts

````typescript
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { errorReportSchema, heartbeatSchema } from './schemas/ingest.ts';
import { acceptErrorReport, acceptHeartbeat, IngestionConflict } from './services/ingestion.ts';
import { sendIssueNotifications } from './services/notifications.ts';
import adminRoutes from './routes/admin.ts';
import { ingestionOptions, notificationConfiguration } from './http/config.ts';
import {
  boundedJson, limitAdminPushTest, limitPublicInstall, limitPublicIp,
  publicCors, requireAccess, requireSameOrigin
} from './http/security.ts';
import type { AppEnv } from './http/types.ts';

const app = new Hono<AppEnv>();
const publicPaths = new Set(['/api/ingest', '/api/heartbeat']);

// No untrusted payload, JWT, provider body, SQL error or request URL enters logs.
function logFailure(event: string, requestId: string): void {
  console.error(JSON.stringify({ event, request_id: requestId }));
}

app.use('*', async (c, next) => {
  c.set('serverNow', Date.now());
  c.set('requestId', crypto.randomUUID());
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Frame-Options', 'DENY');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (new URL(c.req.url).protocol === 'https:') c.header('Strict-Transport-Security', 'max-age=31536000');
  if (c.req.path === '/api' || c.req.path.startsWith('/api/')) {
    c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  }
});

app.use('*', async (c, next) => {
  if (publicPaths.has(c.req.path)) return publicCors(c, next);
  return requireAccess(c, next);
});
app.use('*', async (c, next) => {
  if (publicPaths.has(c.req.path)) return next();
  return requireSameOrigin(c, next);
});

app.post('/api/ingest', limitPublicIp, boundedJson, limitPublicInstall,
  zValidator('json', errorReportSchema, (result, c) => {
    if (!result.success) return c.json({ error: 'Invalid report' }, 400);
  }), async (c) => {
    // Validate settings before committing, so a bad numeric deployment setting
    // cannot leave a stored report whose background dispatch was never scheduled.
    const config = notificationConfiguration(c.env, new URL(c.req.url).origin);
    const result = await acceptErrorReport(c.env.DB, c.req.valid('json'), c.get('serverNow'), ingestionOptions(c.env));
    if (result.accepted) {
      const requestId = c.get('requestId');
      c.executionCtx.waitUntil(sendIssueNotifications(c.env.DB, {
        issueId: result.issueId,
        report: result.report,
        rule: result.rule,
        isNewIssue: result.isNewIssue,
        ...(result.regressionEventId === undefined ? {} : { regressionEventId: result.regressionEventId }),
        now: c.get('serverNow')
      }, config).then((delivery) => {
        if (!delivery.discord.ok) logFailure('diagnostics_discord_delivery_failed', requestId);
        if (delivery.push.state === 'failed' || delivery.push.state === 'partial') {
          logFailure('diagnostics_push_delivery_failed', requestId);
        }
      }).catch(() => logFailure('diagnostics_background_delivery_failed', requestId)));
    }
    return c.json({ ok: true, report_id: result.reportId, duplicate: !result.accepted }, result.accepted ? 202 : 200);
  });

app.post('/api/heartbeat', limitPublicIp, boundedJson, limitPublicInstall,
  zValidator('json', heartbeatSchema, (result, c) => {
    if (!result.success) return c.json({ error: 'Invalid heartbeat' }, 400);
  }), async (c) => {
    const result = await acceptHeartbeat(c.env.DB, c.req.valid('json'), c.get('serverNow'));
    return c.json({ ok: true, heartbeat_id: result.heartbeatId, duplicate: !result.accepted }, result.accepted ? 202 : 200);
  });

app.use('/api/admin/push/test', limitAdminPushTest);
app.route('/api/admin', adminRoutes);

// API typos never fall through to a static application's SPA fallback.
app.all('/api', (c) => c.json({ error: 'Not found' }, 404));
app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));
app.get('*', async (c) => {
  if (!c.env.ASSETS) return c.json({ error: 'Assets unavailable' }, 503);
  const response = await c.env.ASSETS.fetch(c.req.raw);
  return new Response(response.body, response);
});
app.notFound((c) => c.json({ error: 'Not found' }, 404));
app.onError((error, c) => {
  if (error instanceof IngestionConflict) return c.json({ error: 'Request identity conflict', code: error.code }, 409);
  logFailure('diagnostics_request_failed', c.get('requestId'));
  return c.json({ error: 'Service unavailable' }, 503);
});

export { app };
export default app;
````

## diagnostics/src/http/types.ts

````typescript
import type { CloudflareAccessVariables } from '@hono/cloudflare-access';

export type AppEnv = {
  Bindings: Cloudflare.Env;
  Variables: CloudflareAccessVariables & {
    serverNow: number;
    requestId: string;
    rawJson: unknown;
  };
};
````

## diagnostics/src/http/config.ts

````typescript
import type { NotificationConfiguration } from '../services/notifications.ts';
import type { AppEnv } from './types.ts';

/** Reject malformed configuration instead of silently disabling a safeguard. */
export function integerSetting(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError('Invalid server configuration');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new RangeError('Invalid server configuration');
  return number;
}

export function ingestionOptions(env: AppEnv['Bindings']): { windowMs: number; distinctInstallThreshold: number } {
  return {
    windowMs: integerSetting(env.DETECTION_WINDOW_SECONDS, 1, 86_400) * 1000,
    distinctInstallThreshold: integerSetting(env.DISTINCT_INSTALL_THRESHOLD, 2, 1_000_000)
  };
}

export function notificationConfiguration(env: AppEnv['Bindings'], origin: string): NotificationConfiguration {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('Invalid server configuration');
  }
  return {
    dashboardOrigin: url.origin,
    discordWebhookUrl: env.DISCORD_WEBHOOK_URL,
    vapid: { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT },
    cooldownMs: integerSetting(env.PUSH_COOLDOWN_SECONDS, 1, 86_400) * 1000,
    ...ingestionOptions(env),
    spikeReportThreshold: integerSetting(env.SPIKE_REPORT_THRESHOLD, 1, 1_000_000),
    requestTimeoutMs: 5000
  };
}
````

## diagnostics/src/http/security.ts

````typescript
import { cloudflareAccess } from '@hono/cloudflare-access';
import type { Context, MiddlewareHandler } from 'hono';
import { installIdSchema } from '../schemas/ingest.ts';
import { integerSetting } from './config.ts';
import type { AppEnv } from './types.ts';

const MAX_BODY_BYTES = 65_536;
const MAX_ACCESS_TOKEN_BYTES = 8192;
const MAX_TIME = 253_402_300_799_999;
const encoder = new TextEncoder();
const publicPaths = new Set(['/api/ingest', '/api/heartbeat']);
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

function tokenClaimsValid(token: string, issuer: string, audience: string): boolean {
  if (token.length > MAX_ACCESS_TOKEN_BYTES) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return false;
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
        || !/^[A-Za-z0-9_-]{1,256}$/.test(header.kid) || !object(claims) || claims.iss !== issuer) return false;
    const aud = claims.aud;
    if (!(typeof aud === 'string' ? aud === audience : Array.isArray(aud) && aud.length > 0
      && aud.length <= 32 && aud.every((entry) => typeof entry === 'string' && entry.length > 0) && aud.includes(audience))) return false;
    const { exp, nbf, iat } = claims;
    if (typeof exp !== 'number' || typeof nbf !== 'number' || typeof iat !== 'number'
        || ![exp, nbf, iat].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIME / 1000)) return false;
    const now = Math.floor(Date.now() / 1000);
    return exp > now && nbf <= now && iat <= now && exp > nbf && exp > iat;
  } catch { return false; }
}

export const requireAccess: MiddlewareHandler<AppEnv> = async (c, next) => {
  const teamDomain = c.env.CF_ACCESS_TEAM_DOMAIN;
  const audience = c.env.CF_ACCESS_AUD;
  if (typeof teamDomain !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(teamDomain)
      || typeof audience !== 'string' || audience.length === 0 || audience.length > 256 || !/^[\x21-\x7e]+$/.test(audience)) return unavailable(c);
  const token = c.req.header('Cf-Access-Jwt-Assertion')?.trim();
  if (!token || !tokenClaimsValid(token, `https://${teamDomain}`, audience)) return unauthorized(c);
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
  } catch { return unavailable(c); }
  if (!verified) return unauthorized(c);
  await next();
};
````

## diagnostics/src/services/ingestion.ts

````typescript
import type { D1Database } from '@cloudflare/workers-types';
import { compare } from 'compare-versions';
import type { ErrorReport, Heartbeat } from '../schemas/ingest.ts';
import { fingerprintReport } from '../utils/fingerprint.ts';
import { sanitizeReport } from '../utils/sanitize.ts';
import { classifyReport, evaluateRules, UPSTREAM_BREAKING_CHANGE_ACTION } from './ruleEngine.ts';
import type { RuleEvaluation } from './ruleEngine.ts';

/** Reused client IDs never disclose the existing issue or anonymous installation. */
export class IngestionConflict extends Error {
  readonly code = 'IDENTIFIER_REUSED';

  constructor() {
    super('This identifier has already been used with different report data.');
    this.name = 'IngestionConflict';
  }
}

export interface ReportAcceptance {
  accepted: boolean;
  issueId: number;
  reportId: string;
  isNewIssue: boolean;
  regressionEventId?: string;
  report: ErrorReport;
  rule: RuleEvaluation;
}

interface IssueBaseline {
  status: string;
  fixed_in_version: string | null;
}

interface ReceiptSnapshot extends IssueBaseline {
  issue_id: number;
  receipt_install_id: string;
  fingerprint: string;
  body_id: string | null;
  [key: string]: unknown;
}

type StoredValue = string | number | null;
type StoredReport = Record<string, StoredValue>;

function validateNow(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || now > 253_402_300_799_999) {
    throw new RangeError('now must be a valid server epoch millisecond timestamp');
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function reportColumns(report: ErrorReport): StoredReport {
  return {
    id: report.report_id,
    install_id: report.install_id,
    version: report.version,
    browser: report.browser,
    browser_version: report.browser_version,
    os: report.os,
    os_version: report.os_version ?? null,
    mod_id: report.mod_id ?? null,
    collection_id: report.collection_id ?? null,
    download_mode: report.download_mode,
    destination: report.destination,
    severity: report.severity,
    error_category: report.error_category,
    error_code: report.error_code,
    failure_stage: report.failure_stage,
    error_name: report.error_name,
    error_message: report.error_message,
    stack_trace: report.stack_trace ?? null,
    breadcrumbs_json: canonicalJson(report.breadcrumbs),
    dom_state_json: report.dom_state === undefined ? null : canonicalJson(report.dom_state),
    context_json: canonicalJson(report.context),
    http_status: report.http_status ?? null,
    retry_after: report.retry_after ?? null,
    occurred_at: Date.parse(report.occurred_at),
  };
}

function newerThanFixed(version: string, baseline: IssueBaseline | null): boolean {
  return baseline?.status === 'fixed' && baseline.fixed_in_version !== null
    && compare(version, baseline.fixed_in_version, '>');
}

async function refreshIssueClassification(
  db: D1Database,
  issueId: number,
  windowMs: number,
  distinctInstallThreshold: number,
): Promise<void> {
  // Each report already stores the exact immutable base rule output. The only
  // state-dependent override is the structural canary, counted at last_seen_at.
  // Read and update in one SQLite statement: detached request snapshots cannot
  // erase a newer classification or leave every contender's stale CAS rejected.
  await db.prepare(`
    WITH current_classification AS (
      SELECT source.category, source.fault_origin, source.suggested_action,
        CASE WHEN source.category IN ('DOM_SELECTOR_MISSING', 'API_SCHEMA_MISMATCH')
          AND (
            SELECT COUNT(DISTINCT recent.install_id) FROM reports AS recent
            WHERE recent.issue_id = issues.id
              AND recent.created_at >= max(0, issues.last_seen_at - ?)
              AND recent.created_at <= issues.last_seen_at
          ) >= ? THEN 1 ELSE 0 END AS is_canary
      FROM issues
      JOIN reports AS source ON source.id = (
        SELECT latest.id FROM reports AS latest WHERE latest.issue_id = issues.id
        ORDER BY latest.created_at DESC, latest.rowid DESC LIMIT 1
      )
      WHERE issues.id = ?
    )
    UPDATE issues
    SET (category, fault_origin, suggested_action) = (
      SELECT
        CASE WHEN is_canary = 1 THEN 'UPSTREAM_BREAKING_CHANGE' ELSE category END,
        CASE WHEN is_canary = 1 THEN 'upstream_site' ELSE fault_origin END,
        CASE WHEN is_canary = 1 THEN ? ELSE suggested_action END
      FROM current_classification
    )
    WHERE id = ? AND EXISTS (SELECT 1 FROM current_classification)
  `).bind(windowMs, distinctInstallThreshold, issueId,
    UPSTREAM_BREAKING_CHANGE_ACTION, issueId).run();
}

/**
 * D1 batch is the transaction boundary. Schema triggers own immutable receipts,
 * lifetime counts and installation membership; retries never restore an expired body.
 */
export async function acceptErrorReport(
  db: D1Database,
  original: ErrorReport,
  now: number,
  options: { windowMs?: number; distinctInstallThreshold?: number } = {},
): Promise<ReportAcceptance> {
  validateNow(now);
  const windowMs = options.windowMs ?? 15 * 60 * 1000;
  const distinctInstallThreshold = options.distinctInstallThreshold ?? 3;
  if (!Number.isSafeInteger(windowMs) || windowMs < 1
    || !Number.isSafeInteger(distinctInstallThreshold) || distinctInstallThreshold < 1) {
    throw new RangeError('Rule windows and installation thresholds must be positive safe integers');
  }

  // Firefox function@relative-file stack grammar must be parsed before redaction.
  const identity = await fingerprintReport(original);
  const report = sanitizeReport(original);
  const baseRule = classifyReport(report);
  const stored = reportColumns(report);
  const columns = Object.keys(stored);
  const baseline = await db.prepare(`
    SELECT status, fixed_in_version FROM issues WHERE fingerprint = ?
  `).bind(identity.fingerprint).first<IssueBaseline>();
  const shouldRegress = newerThanFixed(report.version, baseline);

  // The receipt gate on issue creation also prevents orphan issues for UUID conflicts.
  // The third statement immediately follows the report INSERT: changes() is its
  // outer row count, restored by SQLite after the report's rollup trigger finishes.
  const results = await db.batch([
    db.prepare(`
      INSERT INTO issues (
        fingerprint, error_category, error_code, failure_stage, normalized_top_frame,
        destination, category, fault_origin, suggested_action, first_seen_at,
        last_seen_at, first_seen_version, last_seen_version, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM report_receipts WHERE id = ?)
      ON CONFLICT (fingerprint) DO NOTHING
      RETURNING id
    `).bind(
      identity.fingerprint, report.error_category, report.error_code, report.failure_stage,
      identity.normalized_top_frame, report.destination, baseRule.category,
      baseRule.fault_origin, baseRule.suggested_action, now, now, report.version,
      report.version, now, now, report.report_id,
    ),
    db.prepare(`
      INSERT INTO reports (
        issue_id, ${columns.join(', ')}, category, fault_origin, suggested_action, created_at
      )
      SELECT issues.id, ${columns.map(() => '?').join(', ')}, ?, ?, ?, ?
      FROM issues
      WHERE fingerprint = ?
        AND NOT EXISTS (SELECT 1 FROM report_receipts WHERE id = ?)
      RETURNING id
    `).bind(
      ...columns.map((column) => stored[column]!), baseRule.category, baseRule.fault_origin,
      baseRule.suggested_action, now, identity.fingerprint, report.report_id,
    ),
    db.prepare(`
      UPDATE issues SET status = 'regressed', updated_at = max(updated_at, ?)
      WHERE fingerprint = ? AND status = 'fixed' AND fixed_in_version = ?
        AND ? = 1 AND changes() = 1
      RETURNING id
    `).bind(now, identity.fingerprint, baseline?.fixed_in_version ?? null, shouldRegress ? 1 : 0),
    db.prepare(`
      SELECT receipts.issue_id, receipts.install_id AS receipt_install_id,
        issues.fingerprint, issues.status, issues.fixed_in_version,
        reports.id AS body_id,
        ${columns.map((column) => `reports.${column} AS body_${column}`).join(', ')}
      FROM report_receipts AS receipts
      JOIN issues ON issues.id = receipts.issue_id
      LEFT JOIN reports ON reports.id = receipts.id
      WHERE receipts.id = ?
    `).bind(report.report_id),
  ]);
  if (results.some((result) => !result.success)) throw new Error('Report transaction failed');

  const accepted = (results[1]?.results.length ?? 0) === 1;
  const snapshot = results[3]?.results[0] as ReceiptSnapshot | undefined;
  if (!snapshot) throw new Error('Report receipt missing after transaction');
  if (snapshot.receipt_install_id !== report.install_id || snapshot.fingerprint !== identity.fingerprint) {
    throw new IngestionConflict();
  }
  if (!accepted && snapshot.body_id !== null
    && columns.some((column) => snapshot[`body_${column}`] !== stored[column])) {
    throw new IngestionConflict();
  }

  const result: ReportAcceptance = {
    accepted,
    issueId: snapshot.issue_id,
    reportId: report.report_id,
    isNewIssue: accepted && (results[0]?.results.length ?? 0) === 1,
    report,
    rule: baseRule,
  };
  if (!accepted) return result;
  if ((results[2]?.results.length ?? 0) === 1) result.regressionEventId = report.report_id;

  // Admin may have changed the baseline while the pre-read was in flight. A
  // second compare-and-set handles that snapshot; only the transition winner
  // receives the event token. A postcommit fault must not turn a stored report
  // into an apparent failure that loses its one asynchronous delivery attempt.
  if (result.regressionEventId === undefined && newerThanFixed(report.version, snapshot)) {
    try {
      const transition = await db.prepare(`
        UPDATE issues SET status = 'regressed', updated_at = max(updated_at, ?)
        WHERE id = ? AND status = 'fixed' AND fixed_in_version = ?
        RETURNING id
      `).bind(now, snapshot.issue_id, snapshot.fixed_in_version).first<{ id: number }>();
      if (transition) result.regressionEventId = report.report_id;
    } catch {
      // The durable report and its base classification remain usable for delivery.
    }
  }
  try {
    result.rule = await evaluateRules(db, report, {
      issueId: snapshot.issue_id, now, windowMs, distinctInstallThreshold,
    });
    await refreshIssueClassification(db, snapshot.issue_id, windowMs, distinctInstallThreshold);
  } catch {
    // Canonical immutable report snapshots were already committed in the batch.
  }
  return result;
}

/** Heartbeats contain immutable deltas, keyed by installation and client UUID. */
export async function acceptHeartbeat(
  db: D1Database,
  payload: Heartbeat,
  now: number,
): Promise<{ accepted: boolean; heartbeatId: string }> {
  validateNow(now);
  const stored = {
    metric_date: payload.metric_date,
    version: payload.version,
    browser: payload.browser,
    destination: payload.destination,
    attempts_count: payload.attempts_count,
    success_count: payload.success_count,
    fallback_triggered_count: payload.fallback_triggered_count,
  };
  const results = await db.batch([
    db.prepare(`
      INSERT INTO heartbeat_receipts (
        heartbeat_id, install_id, metric_date, version, browser, destination,
        attempts_count, success_count, fallback_triggered_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (heartbeat_id, install_id) DO NOTHING
      RETURNING heartbeat_id
    `).bind(payload.heartbeat_id, payload.install_id, ...Object.values(stored), now),
    db.prepare(`
      SELECT metric_date, version, browser, destination, attempts_count,
        success_count, fallback_triggered_count
      FROM heartbeat_receipts WHERE heartbeat_id = ? AND install_id = ?
    `).bind(payload.heartbeat_id, payload.install_id),
  ]);
  if (results.some((result) => !result.success)) throw new Error('Heartbeat transaction failed');
  const receipt = results[1]?.results[0] as Record<string, unknown> | undefined;
  if (!receipt) throw new Error('Heartbeat receipt missing after transaction');
  if (Object.entries(stored).some(([key, value]) => receipt[key] !== value)) throw new IngestionConflict();
  return { accepted: (results[0]?.results.length ?? 0) === 1, heartbeatId: payload.heartbeat_id };
}
````

## diagnostics/src/routes/admin.ts

````typescript
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Context } from 'hono';
import type { AppEnv } from '../http/types.ts';
import { boundedJson } from '../http/security.ts';
import { notificationConfiguration } from '../http/config.ts';
import { browserSchema, destinationSchema, metricDateSchema, osSchema, severitySchema, versionSchema } from '../schemas/ingest.ts';
import { validateSubscription } from '../services/delivery.ts';
import { sendTestNotification } from '../services/notifications.ts';
import { sanitizeText } from '../utils/sanitize.ts';

type SqlValue = string | number | null;
type IssueRow = Record<string, unknown> & {
  id: number; status: string; muted: number; fixed_in_version: string | null;
  github_issue_url: string | null; updated_at: number;
};
type ReportRow = Record<string, unknown> & {
  breadcrumbs_json: string; dom_state_json: string | null; context_json: string;
};
type Metrics = {
  attempts_count: number; success_count: number; fallback_triggered_count: number; heartbeat_count: number;
};
type SubscriptionRow = {
  id: number; endpoint: string; user_agent: string | null; expiration_time: number | null; created_at: number; updated_at: number;
};
type DateWindow = { from: string; to: string; start: number; end: number };

const DAY = 86_400_000;
const MAX_TIME = 253_402_300_799_999;
const statusSchema = z.enum(['new', 'investigating', 'fixed', 'regressed', 'ignored']);
const faultSchema = z.enum(['client_env', 'upstream_site', 'rate_limit', 'extension_bug', 'unknown']);
const categorySchema = z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_.:-]*$/);
const pageSchema = z.string().regex(/^[1-9][0-9]{0,4}$/).transform(Number).pipe(z.number().int().max(10_000)).default(1);
const limitSchema = z.string().regex(/^[1-9][0-9]{0,2}$/).transform(Number).pipe(z.number().int().max(100)).default(30);
const dateFields = { from: metricDateSchema.optional(), to: metricDateSchema.optional() };
const paginationFields = { page: pageSchema, limit: limitSchema };
const releaseFields = { ...dateFields, browser: browserSchema.optional(), destination: destinationSchema.optional() };
const issueQuerySchema = z.strictObject({
  ...dateFields, ...paginationFields, version: versionSchema.optional(), browser: browserSchema.optional(), os: osSchema.optional(),
  destination: destinationSchema.optional(), download_mode: z.enum(['manual', 'auto']).optional(), status: statusSchema.optional(),
  fault_origin: faultSchema.optional(), category: categorySchema.optional(), severity: severitySchema.optional(),
  muted: z.enum(['true', 'false']).optional(), q: z.string().trim().min(1).max(200).optional()
});
const releaseQuerySchema = z.strictObject({ ...releaseFields, ...paginationFields, version: versionSchema.optional() });
const compareQuerySchema = z.strictObject({ ...releaseFields, before: versionSchema, after: versionSchema });
const overviewQuerySchema = z.strictObject(releaseFields);
const reportQuerySchema = z.strictObject(paginationFields);

function githubIssue(value: string): boolean {
  if (!/^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]+\/issues\/[1-9][0-9]*$/.test(value)) return false;
  try {
    const url = new URL(value);
    const id = url.pathname.split('/').at(-1) ?? '';
    return url.href === value && Number.isSafeInteger(Number(id));
  } catch { return false; }
}

const issuePatchSchema = z.strictObject({
  status: statusSchema.optional(), fixed_in_version: versionSchema.nullable().optional(),
  github_issue_url: z.string().max(2048).refine(githubIssue, 'Expected a GitHub issue URL').nullable().optional(),
  muted: z.boolean().optional()
}).refine((value) => Object.keys(value).length > 0, 'At least one update is required');
const subscriptionSchema = z.strictObject({
  endpoint: z.string().min(9).max(2048),
  expirationTime: z.number().int().min(0).max(MAX_TIME).nullable(),
  keys: z.strictObject({ p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/), auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/) })
});
const testPushSchema = z.strictObject({});

function badRequest(c: Context<AppEnv>) { return c.json({ error: 'Invalid request' }, 400); }
function notFound(c: Context<AppEnv>) { return c.json({ error: 'Not found' }, 404); }
function conflict(c: Context<AppEnv>) { return c.json({ error: 'Resource changed; refresh and retry' }, 409); }
function issueValue(row: IssueRow) { return { ...row, muted: row.muted === 1 }; }
function reportValue(row: ReportRow) {
  const { breadcrumbs_json, dom_state_json, context_json, ...rest } = row;
  return { ...rest, breadcrumbs: JSON.parse(breadcrumbs_json) as unknown, dom_state: dom_state_json === null ? null : JSON.parse(dom_state_json) as unknown, context: JSON.parse(context_json) as unknown };
}
function identifier(value: string): number | null {
  if (!/^[1-9][0-9]{0,15}$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}
function query<T extends z.ZodType>(c: Context<AppEnv>, schema: T): z.output<T> | null {
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of new URL(c.req.url).searchParams) {
    if (Object.hasOwn(values, key)) return null;
    values[key] = value;
  }
  const parsed = schema.safeParse(values);
  return parsed.success ? parsed.data : null;
}
function dateWindow(input: { from?: string | undefined; to?: string | undefined }, now: number): DateWindow | null {
  const today = new Date(now).toISOString().slice(0, 10);
  const to = input.to ?? today;
  const endDay = Date.parse(`${to}T00:00:00.000Z`);
  const from = input.from ?? new Date(Math.max(0, endDay - 29 * DAY)).toISOString().slice(0, 10);
  const start = Date.parse(`${from}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(endDay) || start < 0 || endDay < start || endDay - start >= 366 * DAY) return null;
  return { from, to, start, end: Math.min(MAX_TIME, endDay + DAY - 1) };
}
function percentages(metrics: Metrics) {
  return {
    ...metrics,
    success_rate_percent: metrics.attempts_count ? metrics.success_count * 100 / metrics.attempts_count : null,
    fallback_rate_percent: metrics.attempts_count ? metrics.fallback_triggered_count * 100 / metrics.attempts_count : null
  };
}
function releaseWhere(input: { browser?: string | undefined; destination?: string | undefined }, window: DateWindow, version?: string) {
  const conditions = ['metric_date>=?', 'metric_date<=?'];
  const values: SqlValue[] = [window.from, window.to];
  for (const name of ['browser', 'destination'] as const) {
    if (input[name]) { conditions.push(`${name}=?`); values.push(input[name]); }
  }
  if (version !== undefined) { conditions.push('version=?'); values.push(version); }
  return { where: conditions.join(' AND '), values };
}
const sums = `COALESCE(SUM(attempts_count),0) AS attempts_count,COALESCE(SUM(success_count),0) AS success_count,
  COALESCE(SUM(fallback_triggered_count),0) AS fallback_triggered_count,COALESCE(SUM(heartbeat_count),0) AS heartbeat_count`;
async function aggregate(db: AppEnv['Bindings']['DB'], filter: ReturnType<typeof releaseWhere>): Promise<Metrics> {
  return await db.prepare(`SELECT ${sums} FROM release_metrics WHERE ${filter.where}`).bind(...filter.values).first<Metrics>()
    ?? { attempts_count: 0, success_count: 0, fallback_triggered_count: 0, heartbeat_count: 0 };
}
function provider(endpoint: string): string {
  const hostname = new URL(endpoint).hostname;
  if (hostname.endsWith('.push.apple.com')) return 'apple';
  if (hostname === 'fcm.googleapis.com') return 'google';
  if (hostname === 'push.services.mozilla.com' || hostname.endsWith('.push.services.mozilla.com')) return 'mozilla';
  if (hostname.endsWith('.notify.windows.com')) return 'microsoft';
  return 'unknown';
}
function subscriptionValue(row: SubscriptionRow) {
  const { endpoint, ...metadata } = row;
  return { ...metadata, provider: provider(endpoint) };
}

/** Parent Worker verifies Access and same-origin mutations before mounting. */
export const adminRoutes = new Hono<AppEnv>();

adminRoutes.get('/overview', async (c) => {
  const input = query(c, overviewQuerySchema);
  if (!input) return badRequest(c);
  const window = dateWindow(input, c.get('serverNow'));
  if (!window) return badRequest(c);
  const reportConditions = ['created_at>=?', 'created_at<=?'];
  const reportValues: SqlValue[] = [window.start, window.end];
  for (const name of ['browser', 'destination'] as const) {
    if (input[name]) { reportConditions.push(`${name}=?`); reportValues.push(input[name]); }
  }
  const reportFilter = reportConditions.join(' AND ');
  const issueFilter = input.browser || input.destination
    ? `EXISTS (SELECT 1 FROM reports WHERE issue_id=issues.id AND ${reportFilter})`
    : 'last_seen_at>=? AND last_seen_at<=?';
  const issueValues = input.browser || input.destination ? reportValues : [window.start, window.end];
  const [issues, reports, metrics] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(status='new'),0) AS new_count,COALESCE(SUM(status='investigating'),0) AS investigating_count,
      COALESCE(SUM(status='fixed'),0) AS fixed_count,COALESCE(SUM(status='regressed'),0) AS regressed_count,
      COALESCE(SUM(status='ignored'),0) AS ignored_count,COALESCE(SUM(muted=1),0) AS muted_count
      FROM issues WHERE ${issueFilter}`).bind(...issueValues).first<Record<string, number>>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS total,COUNT(DISTINCT install_id) AS distinct_installs
      FROM reports WHERE ${reportFilter}`).bind(...reportValues).first<Record<string, number>>(),
    aggregate(c.env.DB, releaseWhere(input, window))
  ]);
  return c.json({ window: { from: window.from, to: window.to }, issues, reports, releases: percentages(metrics) });
});

adminRoutes.get('/issues', async (c) => {
  const input = query(c, issueQuerySchema);
  if (!input) return badRequest(c);
  const window = dateWindow(input, c.get('serverNow'));
  if (!window) return badRequest(c);
  const conditions: string[] = [];
  const values: SqlValue[] = [];
  for (const name of ['status', 'fault_origin', 'category'] as const) {
    if (input[name]) { conditions.push(`i.${name}=?`); values.push(input[name]); }
  }
  if (input.muted !== undefined) { conditions.push('i.muted=?'); values.push(input.muted === 'true' ? 1 : 0); }
  const reportConditions = ['r.issue_id=i.id', 'r.created_at>=?', 'r.created_at<=?'];
  const reportValues: SqlValue[] = [window.start, window.end];
  let hasReportDimension = false;
  for (const name of ['version', 'browser', 'os', 'destination', 'download_mode', 'severity'] as const) {
    if (input[name]) { reportConditions.push(`r.${name}=?`); reportValues.push(input[name]); hasReportDimension = true; }
  }
  if (input.q) {
    const search = `%${input.q.replace(/[\\%_]/g, '\\$&')}%`;
    const issueSearch = `i.fingerprint LIKE ? ESCAPE '\\' OR i.category LIKE ? ESCAPE '\\'
      OR i.error_code LIKE ? ESCAPE '\\' OR i.normalized_top_frame LIKE ? ESCAPE '\\'`;
    if (hasReportDimension) {
      reportConditions.push(`(${issueSearch} OR r.error_message LIKE ? ESCAPE '\\')`);
      reportValues.push(search, search, search, search, search);
    } else {
      conditions.push(`(${issueSearch} OR EXISTS (SELECT 1 FROM reports search_report WHERE search_report.issue_id=i.id
        AND search_report.created_at>=? AND search_report.created_at<=? AND search_report.error_message LIKE ? ESCAPE '\\'))`);
      values.push(search, search, search, search, window.start, window.end, search);
    }
  }
  if (hasReportDimension) {
    conditions.push(`EXISTS (SELECT 1 FROM reports r WHERE ${reportConditions.join(' AND ')})`);
    values.push(...reportValues);
  } else {
    conditions.push('i.last_seen_at>=? AND i.last_seen_at<=?'); values.push(window.start, window.end);
  }
  const where = conditions.join(' AND ');
  const [total, items] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM issues i WHERE ${where}`).bind(...values),
    c.env.DB.prepare(`SELECT i.* FROM issues i WHERE ${where} ORDER BY i.last_seen_at DESC,i.id DESC LIMIT ? OFFSET ?`)
      .bind(...values, input.limit, (input.page - 1) * input.limit)
  ]);
  const count = total?.results[0] as { total: number } | undefined;
  return c.json({ items: (items?.results as IssueRow[] ?? []).map(issueValue), total: count?.total ?? 0, page: input.page, limit: input.limit });
});

adminRoutes.get('/issues/:id/reports', async (c) => {
  const id = identifier(c.req.param('id'));
  const input = query(c, reportQuerySchema);
  if (id === null || !input) return badRequest(c);
  const exists = await c.env.DB.prepare('SELECT id FROM issues WHERE id=?').bind(id).first<{ id: number }>();
  if (!exists) return notFound(c);
  const [count, rows] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT COUNT(*) AS total FROM reports WHERE issue_id=?').bind(id),
    c.env.DB.prepare('SELECT * FROM reports WHERE issue_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').bind(id, input.limit, (input.page - 1) * input.limit)
  ]);
  return c.json({ items: (rows?.results as ReportRow[] ?? []).map(reportValue), total: (count?.results[0] as { total: number } | undefined)?.total ?? 0, page: input.page, limit: input.limit });
});

adminRoutes.get('/issues/:id', async (c) => {
  const id = identifier(c.req.param('id'));
  if (id === null || !query(c, z.strictObject({}))) return badRequest(c);
  const [issueResult, summaryResult, latestResult] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT * FROM issues WHERE id=?').bind(id),
    c.env.DB.prepare(`SELECT COUNT(*) AS retained_report_count,COUNT(DISTINCT install_id) AS retained_distinct_installs,
      json_group_array(DISTINCT browser) AS browsers_json,
      (SELECT json_group_array(version) FROM (SELECT DISTINCT version FROM reports WHERE issue_id=? ORDER BY version LIMIT 101)) AS versions_json,
      json_group_array(DISTINCT os) AS operating_systems_json FROM reports WHERE issue_id=?`).bind(id, id),
    c.env.DB.prepare('SELECT * FROM reports WHERE issue_id=? ORDER BY created_at DESC,id DESC LIMIT 1').bind(id)
  ]);
  const issue = issueResult?.results[0] as IssueRow | undefined;
  if (!issue) return notFound(c);
  const summary = summaryResult?.results[0] as { retained_report_count: number; retained_distinct_installs: number; browsers_json: string; versions_json: string; operating_systems_json: string };
  const versions = JSON.parse(summary.versions_json) as string[];
  const latest = latestResult?.results[0] as ReportRow | undefined;
  return c.json({ issue: issueValue(issue), report_summary: {
    retained_report_count: summary.retained_report_count, retained_distinct_installs: summary.retained_distinct_installs,
    browsers: JSON.parse(summary.browsers_json) as string[], versions: versions.slice(0, 100), versions_truncated: versions.length > 100,
    operating_systems: JSON.parse(summary.operating_systems_json) as string[]
  }, latest_report: latest ? reportValue(latest) : null });
});

adminRoutes.patch('/issues/:id', boundedJson, zValidator('json', issuePatchSchema, (result, c) => {
  if (!result.success) return c.json({ error: 'Invalid request' }, 400);
}), async (c) => {
  const id = identifier(c.req.param('id'));
  if (id === null || !query(c, z.strictObject({}))) return badRequest(c);
  const input = c.req.valid('json');
  const previous = await c.env.DB.prepare('SELECT * FROM issues WHERE id=?').bind(id).first<IssueRow>();
  if (!previous) return notFound(c);
  const nextStatus = input.status ?? previous.status;
  const fixedVersion = Object.hasOwn(input, 'fixed_in_version') ? input.fixed_in_version ?? null : previous.fixed_in_version;
  const githubUrl = Object.hasOwn(input, 'github_issue_url') ? input.github_issue_url ?? null : previous.github_issue_url;
  const muted = input.muted === undefined ? previous.muted : input.muted ? 1 : 0;
  if ((nextStatus === 'fixed' || nextStatus === 'regressed') && fixedVersion === null) return badRequest(c);
  const changed = await c.env.DB.prepare(`UPDATE issues SET status=?,fixed_in_version=?,github_issue_url=?,muted=?,updated_at=max(updated_at,?)
    WHERE id=? AND status=? AND fixed_in_version IS ? AND github_issue_url IS ? AND muted=? AND updated_at=? RETURNING *`)
    .bind(nextStatus, fixedVersion, githubUrl, muted, c.get('serverNow'), id, previous.status, previous.fixed_in_version, previous.github_issue_url, previous.muted, previous.updated_at).first<IssueRow>();
  return changed ? c.json({ issue: issueValue(changed) }) : conflict(c);
});

adminRoutes.get('/releases/compare', async (c) => {
  const input = query(c, compareQuerySchema);
  if (!input) return badRequest(c);
  const window = dateWindow(input, c.get('serverNow'));
  if (!window) return badRequest(c);
  const [beforeMetrics, afterMetrics] = await Promise.all([
    aggregate(c.env.DB, releaseWhere(input, window, input.before)), aggregate(c.env.DB, releaseWhere(input, window, input.after))
  ]);
  const before = { version: input.before, ...percentages(beforeMetrics) };
  const after = { version: input.after, ...percentages(afterMetrics) };
  return c.json({ window: { from: window.from, to: window.to }, before, after,
    success_rate_delta_pp: before.success_rate_percent === null || after.success_rate_percent === null ? null : after.success_rate_percent - before.success_rate_percent,
    fallback_rate_delta_pp: before.fallback_rate_percent === null || after.fallback_rate_percent === null ? null : after.fallback_rate_percent - before.fallback_rate_percent });
});

adminRoutes.get('/releases', async (c) => {
  const input = query(c, releaseQuerySchema);
  if (!input) return badRequest(c);
  const window = dateWindow(input, c.get('serverNow'));
  if (!window) return badRequest(c);
  const filter = releaseWhere(input, window, input.version);
  const [count, rows] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT COUNT(DISTINCT version) AS total FROM release_metrics WHERE ${filter.where}`).bind(...filter.values),
    c.env.DB.prepare(`SELECT version,${sums} FROM release_metrics WHERE ${filter.where} GROUP BY version ORDER BY MAX(metric_date) DESC,version DESC LIMIT ? OFFSET ?`)
      .bind(...filter.values, input.limit, (input.page - 1) * input.limit)
  ]);
  return c.json({ items: (rows?.results as (Metrics & { version: string })[] ?? []).map(percentages), total: (count?.results[0] as { total: number } | undefined)?.total ?? 0, page: input.page, limit: input.limit });
});

adminRoutes.get('/push/config', (c) => {
  if (!query(c, z.strictObject({}))) return badRequest(c);
  return c.json({ public_key: c.env.VAPID_PUBLIC_KEY });
});

adminRoutes.get('/push/subscriptions', async (c) => {
  if (!query(c, z.strictObject({}))) return badRequest(c);
  const rows = await c.env.DB.prepare('SELECT id,endpoint,user_agent,expiration_time,created_at,updated_at FROM push_subscriptions ORDER BY id DESC LIMIT 100').all<SubscriptionRow>();
  return c.json({ items: rows.results.map(subscriptionValue) });
});

adminRoutes.post('/push/subscriptions', boundedJson, zValidator('json', subscriptionSchema, (result, c) => {
  if (!result.success) return c.json({ error: 'Invalid request' }, 400);
}), async (c) => {
  if (!query(c, z.strictObject({}))) return badRequest(c);
  const input = c.req.valid('json');
  const now = c.get('serverNow');
  if (input.expirationTime !== null && input.expirationTime <= now) return badRequest(c);
  let endpoint: URL;
  try { endpoint = await validateSubscription({ endpoint: input.endpoint, ...input.keys, expiration_time: input.expirationTime }, now); }
  catch { return badRequest(c); }
  const ua = c.req.header('User-Agent');
  const userAgent = ua ? Array.from(sanitizeText(ua)).slice(0, 512).join('') : null;
  const previous = await c.env.DB.prepare('SELECT id FROM push_subscriptions WHERE endpoint=?').bind(endpoint.href).first<{ id: number }>();
  const result = await c.env.DB.prepare(`INSERT INTO push_subscriptions (endpoint,p256dh,auth,user_agent,expiration_time,created_at,updated_at)
    SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM push_subscriptions)<100 OR EXISTS(SELECT 1 FROM push_subscriptions WHERE endpoint=?)
    ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth,user_agent=excluded.user_agent,
      expiration_time=excluded.expiration_time,updated_at=max(push_subscriptions.updated_at,excluded.updated_at)
    RETURNING id,endpoint,user_agent,expiration_time,created_at,updated_at`)
    .bind(endpoint.href, input.keys.p256dh, input.keys.auth, userAgent, input.expirationTime, now, now, endpoint.href).first<SubscriptionRow>();
  if (!result) return c.json({ error: 'Subscription capacity reached' }, 409);
  return c.json({ subscription: subscriptionValue(result) }, previous ? 200 : 201);
});

adminRoutes.delete('/push/subscriptions/:id', async (c) => {
  const id = identifier(c.req.param('id'));
  if (id === null || !query(c, z.strictObject({}))) return badRequest(c);
  const removed = await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE id=? RETURNING id').bind(id).first<{ id: number }>();
  return removed ? c.body(null, 204) : notFound(c);
});

adminRoutes.post('/push/test', boundedJson, zValidator('json', testPushSchema, (result, c) => {
  if (!result.success) return c.json({ error: 'Invalid request' }, 400);
}), async (c) => {
  if (!query(c, z.strictObject({}))) return badRequest(c);
  const result = await sendTestNotification(c.env.DB, notificationConfiguration(c.env, new URL(c.req.url).origin), c.get('serverNow'));
  return c.json(result);
});

adminRoutes.get('/health', async (c) => {
  if (!query(c, z.strictObject({}))) return badRequest(c);
  const result = await c.env.DB.prepare('SELECT 1 AS ready').first<{ ready: number }>();
  return result?.ready === 1 ? c.json({ ok: true }) : c.json({ error: 'Service unavailable' }, 503);
});

export default adminRoutes;
````

## diagnostics/src/services/ruleEngine.ts

````typescript
import type { D1Database } from '@cloudflare/workers-types';
import type { ErrorReport } from '../schemas/ingest.ts';

export type FaultOrigin = 'client_env' | 'upstream_site' | 'rate_limit' | 'extension_bug' | 'unknown';

export interface RuleEvaluation {
  category: string;
  fault_origin: FaultOrigin;
  suggested_action: string;
  upstream_breaking_change: boolean;
  structural_category: 'DOM_SELECTOR_MISSING' | 'API_SCHEMA_MISMATCH' | null;
}

export const UPSTREAM_BREAKING_CHANGE_ACTION = 'Έλεγχος της δομής HTML/API του Nexus και άμεση προετοιμασία hotfix· το ίδιο δομικό σφάλμα επηρεάζει πολλαπλές εγκαταστάσεις.';

function evaluation(
  category: string,
  fault_origin: FaultOrigin,
  suggested_action: string,
  structural_category: RuleEvaluation['structural_category'] = null,
): RuleEvaluation {
  return { category, fault_origin, suggested_action, upstream_breaking_change: false, structural_category };
}

function apiSchemaMismatch(): RuleEvaluation {
  // One schema mismatch can be a stale response or extension expectation; it
  // does not establish which participant is at fault without the canary.
  return evaluation('API_SCHEMA_MISMATCH', 'unknown', 'Έλεγχος των αναμενόμενων και ληφθέντων πεδίων API και του endpoint πριν χαρακτηριστεί ως αλλαγή στο Nexus.', 'API_SCHEMA_MISMATCH');
}

/** Classifies the current failure, never arbitrary stack text or recovered steps. */
export function classifyReport(report: ErrorReport): RuleEvaluation {
  const identities = [report.error_category, report.error_code, report.failure_stage]
    .map((value) => value.toUpperCase().replace(/[.:-]/g, '_'));
  const known = (...values: string[]): boolean => identities.some((value) => values.includes(value));
  const message = report.error_message.trim().replace(/^(?:Error|TypeError|NetworkError|DOMException):\s*/i, '');

  if (
    known('SECURITY_BLOCK', 'FILE_VIRUS_INFECTED', 'FILE_BLOCKED', 'FILE_SECURITY_CHECK_FAILED', 'SAFE_BROWSING_BLOCK', 'SAFEBROWSING_BLOCK', 'ANTIVIRUS_BLOCK', 'DEFENDER_BLOCK')
    || /^FILE_VIRUS_INFECTED\b/i.test(message)
    || /^(?:download|file)\b.{0,80}\bblocked\b.{0,60}\b(?:safe\s*browsing|antivirus|(?:windows\s+)?defender)\b/i.test(message)
    || /^(?:safe\s*browsing|antivirus|(?:windows\s+)?defender)\b.{0,80}\bblocked\b/i.test(message)
  ) {
    return evaluation('SECURITY_BLOCK', 'client_env', 'Καταγραφή ως αποκλεισμός ασφαλείας του browser/antivirus.');
  }

  if (
    known('EXTENSION_CONFLICT', 'DOWNLOAD_UI_CONFLICT', 'CONFLICTING_DOWNLOAD_UI', 'OTHER_EXTENSION_HIJACK', 'DOWNLOAD_UI_HIJACKED', 'CHROME_DOWNLOADS_HIJACKED')
    || /^(?:conflicting download UI|(?:another|other) extension\b.{0,80}\b(?:controls?|controlling|hijack(?:ed|s)?|owns?)\b.{0,80}\b(?:download UI|chrome\.downloads(?: API)?))\b/i.test(message)
  ) {
    return evaluation('EXTENSION_CONFLICT', 'client_env', 'Καταγραφή ως σύγκρουση επεκτάσεων — άλλη επέκταση ελέγχει το download UI ή το chrome.downloads API.');
  }

  if (
    known('HANDOFF', 'HANDOFF_FAILURE', 'HANDOFF_FAILED', 'NXM_TIMEOUT', 'NXM_PROTOCOL_ERROR', 'NO_PROTOCOL_HANDLER', 'PROTOCOL_HANDLER_ERROR', 'PROTOCOL_HANDLER_NOT_REGISTERED')
    || identities.some((value) => /(?:^|_)(?:HANDOFF|NXM|PROTOCOL_HANDLER)(?:_|$)/.test(value) && /(?:^|_)(?:FAILED|FAILURE|TIMEOUT|ERROR|UNREGISTERED)(?:_|$)/.test(value))
    || /^(?:(?:the )?(?:nxm:\/\/|vortex\b|mo2\b).{0,80}\b(?:protocol handler|handoff)\b.{0,80}\b(?:failed|error|timed out|not registered)|no protocol handler\b.{0,80}\bnxm:\/\/|(?:external manager )?handoff (?:failed|failure)\b)/i.test(message)
  ) {
    return evaluation('HANDOFF_FAILURE', 'client_env', 'Έλεγχος αν το Vortex/MO2 τρέχει και αν το nxm:// protocol είναι δηλωμένο στο OS.');
  }

  const lastStep = report.breadcrumbs.at(-1);
  const currentBreadcrumb429 = lastStep?.status === 'error'
    && lastStep.stage === report.failure_stage && lastStep.http_status === 429;
  if (
    report.http_status === 429 || currentBreadcrumb429
    || known('API_RATE_LIMIT', 'RATE_LIMIT', 'RATE_LIMITED', 'HTTP_429', 'TOO_MANY_REQUESTS')
    || /^(?:HTTP(?:\s+status)?\s*[:=]?\s*429\b|429\s+Too Many Requests\b|Too Many Requests(?:\s|$))/i.test(message)
  ) {
    return evaluation('API_RATE_LIMIT', 'rate_limit', 'Αναμονή σύμφωνα με το Retry-After header (καταγραφή τιμής Retry-After και endpoint).');
  }

  if (
    known('API_SCHEMA_MISMATCH', 'API_RESPONSE_SCHEMA_MISMATCH', 'API_SCHEMA_VALIDATION_FAILED', 'NEXUS_API_CHANGED')
    || /^API (?:response )?schema (?:mismatch|validation failed)\b/i.test(message)
  ) {
    return apiSchemaMismatch();
  }

  const dom = report.dom_state;
  const missingDomEvidence = dom !== undefined && (dom.collection_host_present === false
    || dom.selectors.some((selector) => !selector.matched || selector.match_count === 0));
  const domFailureStage = /(?:^|_)(?:DOM|SELECTOR|COLLECTION_HOST)(?:_|$)/.test(identities[2] ?? '')
    && /(?:^|_)(?:FAILED|FAILURE|ERROR|MISSING|NOT_FOUND)(?:_|$)/.test(identities[2] ?? '');
  if (
    known('DOM_SELECTOR_MISSING', 'SELECTOR_NOT_FOUND', 'COLLECTION_HOST_MISSING', 'MISSING_COLLECTION_HOST', 'NEXUS_PAGE_CHANGED')
    || /^(?:missing (?:collection host|DOM selector)|(?:DOM )?selector (?:missing|not found)|collection host (?:missing|not found))\b/i.test(message)
    || (missingDomEvidence && domFailureStage)
  ) {
    return evaluation('DOM_SELECTOR_MISSING', 'client_env', 'Έλεγχος κατάστασης φόρτωσης (document.readyState) και DOM πριν χαρακτηριστεί ως αλλαγή στη σελίδα του Nexus.', 'DOM_SELECTOR_MISSING');
  }

  if (
    known('NETWORK', 'NETWORK_UNREACHABLE', 'NETWORK_ERROR', 'ERR_NETWORK', 'FETCH_FAILED', 'FAILED_TO_FETCH', 'NETWORK_REQUEST_FAILED', 'OFFLINE')
    || /^(?:failed to fetch\b|fetch failed\b|network request failed\b|NetworkError when attempting to fetch resource\b)/i.test(message)
  ) {
    return evaluation('NETWORK_UNREACHABLE', 'client_env', 'Έλεγχος διαδρομής/σύνδεσης ή DNS/Firewall χρήστη· η αιτία παραμένει άγνωστη χωρίς επιπλέον στοιχεία δικτύου.');
  }

  // API snapshots can describe an earlier primary response before a fallback
  // failed. Use context only when the current failure is generic or schema
  // validation, after explicit terminal failure evidence has been considered.
  const api = report.dom_state?.api_schema;
  const genericFailureCode = /^(?:REQUEST_FAILED|UNEXPECTED_ERROR|UNKNOWN_ERROR|ERROR|UNKNOWN|UNCLASSIFIED)$/.test(identities[1] ?? '');
  const schemaFailureStage = /(?:^|_)(?:API_SCHEMA|SCHEMA_VALIDATION|SCHEMA_CHECK)(?:_|$)/.test(identities[2] ?? '');
  if (
    (genericFailureCode || schemaFailureStage) && api !== undefined
    && (api.missing_fields.length > 0 || (api.expected !== undefined && api.received !== undefined && api.expected !== api.received))
  ) {
    return apiSchemaMismatch();
  }

  return {
    category: 'UNKNOWN_ERROR',
    fault_origin: 'unknown',
    suggested_action: 'Έλεγχος του μηνύματος σφάλματος και του χρονολογίου εκτέλεσης για επιπλέον στοιχεία.',
    upstream_breaking_change: false,
    structural_category: null,
  };
}

/**
 * Call after storing the report, using the same server receipt timestamp as
 * reports.created_at. The current stored report participates in the count.
 * This function only reads D1: report snapshots and issue updates belong to
 * ingestion, and lifetime issue_installs membership is not a canary window.
 */
export async function evaluateRules(
  db: D1Database,
  report: ErrorReport,
  options: { issueId: number; now: number; windowMs?: number; distinctInstallThreshold?: number },
): Promise<RuleEvaluation> {
  const { issueId, now, windowMs = 15 * 60 * 1000, distinctInstallThreshold = 3 } = options;
  if (!Number.isSafeInteger(issueId) || issueId < 1) throw new RangeError('issueId must be a positive safe integer');
  if (!Number.isSafeInteger(now) || now < 0 || now > 253_402_300_799_999) throw new RangeError('now must be a valid server epoch millisecond timestamp');
  if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new RangeError('windowMs must be a positive safe integer');
  if (!Number.isSafeInteger(distinctInstallThreshold) || distinctInstallThreshold < 1) throw new RangeError('distinctInstallThreshold must be a positive safe integer');

  const result = classifyReport(report);
  if (result.structural_category === null) return result;

  const count = await db.prepare(`
    SELECT COUNT(DISTINCT install_id) AS distinct_installs
    FROM reports
    WHERE issue_id = ?1 AND created_at >= ?2 AND created_at <= ?3
  `).bind(issueId, Math.max(0, now - windowMs), now).first<{ distinct_installs: number }>();
  if ((count?.distinct_installs ?? 0) < distinctInstallThreshold) return result;

  return {
    ...result,
    category: 'UPSTREAM_BREAKING_CHANGE',
    fault_origin: 'upstream_site',
    suggested_action: UPSTREAM_BREAKING_CHANGE_ACTION,
    upstream_breaking_change: true,
  };
}
````

## diagnostics/src/services/delivery.ts

````typescript
import { buildPushPayload } from '@block65/webcrypto-web-push';
import type { ErrorReport } from '../schemas/ingest.ts';
import { sanitizeReport, sanitizeText } from '../utils/sanitize.ts';

export type DeliveryResult = {
  ok: boolean;
  status: number | null;
  retryable: boolean;
  expired: boolean;
  retry_after_ms: number | null;
  reason: 'delivered' | 'http_error' | 'network_error' | 'invalid_config' | 'invalid_subscription' | 'payload_too_large';
};

export type PushTarget = {
  endpoint: string;
  p256dh: string;
  auth: string;
  expiration_time?: number | null;
};

export type PushPayload = {
  title: string;
  body: string;
  tag: string;
  data: { url: string; issue_id: number | null; fingerprint: string | null; trigger: string };
  badge_count: number;
};

export type DiscordReportContext = {
  issueId: number;
  fingerprint: string;
  dashboardOrigin: string;
  category: string;
  faultOrigin: string;
  suggestedAction: string;
};

type DeliveryOptions = { timeoutMs?: number; now?: number };
type VapidConfig = { publicKey: string; privateKey: string; subject: string };
type DiscordEmbed = {
  title: string;
  url: string;
  description: string;
  color: number;
  fields: { name: string; value: string; inline?: boolean }[];
  footer: { text: string };
  timestamp: string;
};

const MAX_PUSH_BYTES = 3993;
const MAX_RETRY_AFTER_MS = 86_400_000;
const MAX_TIMEOUT_MS = 5000;
const encoder = new TextEncoder();

function failure(reason: DeliveryResult['reason'], expired = false): DeliveryResult {
  return { ok: false, status: null, retryable: false, expired, retry_after_ms: null, reason };
}

function secureUrl(value: string): URL {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f\\#]/.test(value)) throw new Error('Invalid HTTPS URL');
  const authority = /^https:\/\/([^/?#]*)/i.exec(value)?.[1];
  if (!authority || authority.includes('@')) throw new Error('Invalid HTTPS authority');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !url.hostname || url.hostname.endsWith('.')) throw new Error('Invalid HTTPS URL');
  return url;
}

function pushEndpoint(value: string): URL {
  const url = secureUrl(value);
  const host = url.hostname;
  // Provider-owned suffixes documented by Apple, Mozilla Autopush and Microsoft WNS.
  const known = host === 'fcm.googleapis.com'
    || host.endsWith('.push.apple.com')
    || host === 'push.services.mozilla.com'
    || host.endsWith('.push.services.mozilla.com')
    || host.endsWith('.notify.windows.com');
  if (!known || !/^[a-z0-9.-]+$/.test(host)) throw new Error('Unsupported push provider');
  return url;
}

function decodeKey(value: string, length: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length !== Math.ceil(length * 4 / 3)) throw new Error('Invalid key encoding');
  const decoded = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  const result = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  const canonical = btoa(String.fromCharCode(...result)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (result.byteLength !== length || canonical !== value) throw new Error('Invalid key length');
  return result;
}

function encodeKey(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function validateSubscription(target: PushTarget, now: number): Promise<URL> {
  const endpoint = pushEndpoint(target.endpoint);
  if (target.expiration_time !== undefined && target.expiration_time !== null && (!Number.isFinite(target.expiration_time) || target.expiration_time < 0)) throw new Error('Invalid expiration');
  if (!Number.isFinite(now) || now < 0) throw new Error('Invalid current time');
  decodeKey(target.auth, 16);
  const key = decodeKey(target.p256dh, 65);
  if (key[0] !== 4) throw new Error('Invalid public key format');
  await crypto.subtle.importKey('raw', key, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  return endpoint;
}

async function validateVapid(vapid: VapidConfig): Promise<void> {
  if (typeof vapid.subject !== 'string' || vapid.subject.length > 2048 || /[\u0000-\u0020\u007f]/.test(vapid.subject)) throw new Error('Invalid VAPID subject');
  if (vapid.subject.startsWith('mailto:')) {
    if (!/^mailto:[A-Za-z0-9.!#$%&'*+/=^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(vapid.subject) || vapid.subject.includes('?') || vapid.subject.includes('#')) throw new Error('Invalid VAPID contact');
  } else {
    secureUrl(vapid.subject);
  }
  const publicBytes = decodeKey(vapid.publicKey, 65);
  decodeKey(vapid.privateKey, 32);
  if (publicBytes[0] !== 4) throw new Error('Invalid VAPID public key');
  const algorithm = { name: 'ECDSA', namedCurve: 'P-256' };
  const publicKey = await crypto.subtle.importKey('raw', publicBytes, algorithm, false, ['verify']);
  const privateKey = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', x: encodeKey(publicBytes.slice(1, 33)), y: encodeKey(publicBytes.slice(33, 65)), d: vapid.privateKey,
  }, algorithm, false, ['sign']);
  // Importing JWKs alone need not prove that the private scalar matches x/y.
  const proof = encoder.encode('diagnostics-vapid-key-pair-check');
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, proof);
  if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, proof)) throw new Error('VAPID key pair mismatch');
}

function retryAfter(header: string | null, now: number): number | null {
  if (!header || header.length > 128) return null;
  const value = header.trim();
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const milliseconds = Number(value) * 1000;
    return Number.isFinite(milliseconds) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.ceil(milliseconds))) : null;
  }
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return null;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - now)) : null;
}

async function deliver(url: URL, init: RequestInit, options: DeliveryOptions, push: boolean): Promise<DeliveryResult> {
  const controller = new AbortController();
  const requested = options.timeoutMs ?? MAX_TIMEOUT_MS;
  const timeout = Number.isFinite(requested) ? Math.max(1, Math.min(MAX_TIMEOUT_MS, requested)) : MAX_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url.href, { ...init, redirect: 'manual', signal: controller.signal });
    const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
    const retry = retryable ? retryAfter(response.headers.get('retry-after'), options.now ?? Date.now()) : null;
    // The provider body may be unbounded and may contain subscription credentials.
    if (response.body) void response.body.cancel().catch(() => undefined);
    return { ok: response.ok, status: response.status, retryable: !response.ok && retryable, expired: push && (response.status === 404 || response.status === 410), retry_after_ms: retry, reason: response.ok ? 'delivered' : 'http_error' };
  } catch {
    return { ok: false, status: null, retryable: true, expired: false, retry_after_ms: null, reason: 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}

function checkedPayload(payload: PushPayload): PushPayload {
  if (!payload || typeof payload.title !== 'string' || typeof payload.body !== 'string' || typeof payload.tag !== 'string' || !payload.data || typeof payload.data.trigger !== 'string') throw new Error('Invalid push payload');
  if (!Number.isSafeInteger(payload.badge_count) || payload.badge_count < 0) throw new Error('Invalid badge count');
  if (payload.data.issue_id !== null && (!Number.isSafeInteger(payload.data.issue_id) || payload.data.issue_id <= 0)) throw new Error('Invalid issue ID');
  if (payload.data.fingerprint !== null && !/^[a-f0-9]{64}$/.test(payload.data.fingerprint)) throw new Error('Invalid fingerprint');
  secureUrl(payload.data.url);
  return {
    title: sanitizeText(payload.title), body: sanitizeText(payload.body), tag: payload.data.fingerprint ?? sanitizeText(payload.tag),
    data: { url: payload.data.url, issue_id: payload.data.issue_id, fingerprint: payload.data.fingerprint, trigger: sanitizeText(payload.data.trigger) }, badge_count: payload.badge_count,
  };
}

export async function sendWebPush(target: PushTarget, payload: PushPayload, vapid: VapidConfig, options: DeliveryOptions = {}): Promise<DeliveryResult> {
  let endpoint: URL;
  try {
    endpoint = await validateSubscription(target, options.now ?? Date.now());
    if (target.expiration_time !== undefined && target.expiration_time !== null && target.expiration_time <= (options.now ?? Date.now())) return failure('invalid_subscription', true);
  } catch {
    return failure('invalid_subscription');
  }
  let value: PushPayload;
  try {
    value = checkedPayload(payload);
    if (encoder.encode(JSON.stringify(value)).byteLength > MAX_PUSH_BYTES) return failure('payload_too_large');
    await validateVapid(vapid);
  } catch {
    return failure('invalid_config');
  }
  try {
    const topic = value.data.fingerprint?.slice(0, 32);
    const urgent = value.data.trigger === 'REGRESSION' || value.data.trigger === 'NEW_CRITICAL' || value.data.trigger === 'UPSTREAM_CHANGE';
    const request = await buildPushPayload({ data: { ...value }, options: { ttl: 300, urgency: urgent ? 'high' : 'normal', ...(topic ? { topic } : {}) } }, {
      endpoint: endpoint.href, expirationTime: target.expiration_time ?? null, keys: { p256dh: target.p256dh, auth: target.auth },
    }, vapid);
    return await deliver(endpoint, request, options, true);
  } catch {
    return failure('invalid_config');
  }
}

function clip(value: string, length: number): string {
  if (value.length <= length) return value;
  let clipped = value.slice(0, length - 1);
  if (/[\uD800-\uDBFF]$/.test(clipped)) clipped = clipped.slice(0, -1);
  return `${clipped}…`;
}

export function buildDiscordMessage(report: ErrorReport, context: DiscordReportContext): {
  allowed_mentions: { parse: never[]; users: never[]; roles: never[]; replied_user: false };
  embeds: DiscordEmbed[];
} {
  if (!Number.isSafeInteger(context.issueId) || context.issueId <= 0 || !/^[a-f0-9]{64}$/.test(context.fingerprint)) throw new Error('Invalid issue context');
  const origin = secureUrl(context.dashboardOrigin);
  if (origin.pathname !== '/' || origin.search) throw new Error('Invalid dashboard origin');
  const url = new URL('/', origin.origin);
  url.searchParams.set('issue', String(context.issueId));
  const sanitized = sanitizeReport(report);
  const safe = (value: string, length: number): string => clip(sanitizeText(value).split(report.install_id).join('[REDACTED]').replace(/@/g, '@\u200b').replace(/`/g, 'ˋ'), length);
  const fields: DiscordEmbed['fields'] = [
    { name: 'Classification', value: safe(`${context.category}\nFault: ${context.faultOrigin}`, 400) || 'Unknown', inline: true },
    { name: 'Environment', value: safe(`v${sanitized.version} · ${sanitized.browser} ${sanitized.browser_version} · ${sanitized.os}\n${sanitized.destination} · ${sanitized.download_mode}`, 400) || 'Unknown', inline: true },
    { name: 'Diagnostic summary', value: safe(`${sanitized.error_name}: ${sanitized.error_code}\nStage: ${sanitized.failure_stage}${sanitized.http_status ? `\nHTTP ${sanitized.http_status}` : ''}${sanitized.retry_after ? `\nRetry-After: ${sanitized.retry_after}` : ''}`, 400) || 'Unavailable' },
    { name: 'Suggested action', value: safe(context.suggestedAction, 800) || 'Review the issue diagnostics.' },
  ];
  const timeline = sanitized.breadcrumbs.slice(-20).map((item) => `${item.timestamp_offset_ms}ms ${item.status.toUpperCase()} ${item.stage} → ${item.action}${item.http_status ? ` HTTP ${item.http_status}` : ''}${item.duration_ms !== undefined ? ` (${item.duration_ms}ms)` : ''}`).join('\n');
  if (timeline) fields.push({ name: 'Timeline (last 20)', value: safe(timeline, 1000) });
  if (sanitized.stack_trace) fields.push({ name: 'Stack trace', value: safe(sanitized.stack_trace, 1024) || 'Unavailable' });
  // Fixed per-field budgets sum to <6000 UTF-16 code units, including names/footer.
  return {
    allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
    embeds: [{
      title: safe(`${sanitized.severity.toUpperCase()} · ${context.category} · #${context.issueId}`, 256),
      url: url.href, description: safe(sanitized.error_message, 1200) || 'No error message available.',
      color: sanitized.severity === 'fatal' ? 0xed4245 : 0xfaa61a,
      fields, footer: { text: `Fingerprint: ${context.fingerprint}` }, timestamp: sanitized.occurred_at,
    }],
  };
}

function discordWebhook(value: string): URL {
  const url = secureUrl(value);
  if (!['discord.com', 'discordapp.com', 'canary.discord.com'].includes(url.hostname) || url.search || !/^\/api\/(?:v10\/)?webhooks\/[0-9]{1,32}\/[A-Za-z0-9_-]{20,200}$/.test(url.pathname)) throw new Error('Invalid Discord webhook');
  url.searchParams.set('wait', 'true');
  return url;
}

export async function sendDiscordReport(webhookUrl: string, report: ErrorReport, context: DiscordReportContext, options: DeliveryOptions = {}): Promise<DeliveryResult> {
  let url: URL;
  let body: string;
  try {
    url = discordWebhook(webhookUrl);
    body = JSON.stringify(buildDiscordMessage(report, context));
  } catch {
    return failure('invalid_config');
  }
  return deliver(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }, options, false);
}
````

## diagnostics/src/services/notifications.ts

````typescript
import type { D1Database } from '@cloudflare/workers-types';
import { compare } from 'compare-versions';
import { versionSchema } from '../schemas/ingest.ts';
import type { ErrorReport } from '../schemas/ingest.ts';
import { sanitizeReport, sanitizeText } from '../utils/sanitize.ts';
import { sendDiscordReport, sendWebPush } from './delivery.ts';
import type { DeliveryResult, PushPayload, PushTarget } from './delivery.ts';
import type { RuleEvaluation } from './ruleEngine.ts';

export type NotificationTrigger = 'NEW_CRITICAL' | 'REGRESSION' | 'SPIKE_DETECTED' | 'UPSTREAM_CHANGE';
export type NotificationConfiguration = {
  dashboardOrigin: string;
  discordWebhookUrl: string;
  vapid: { publicKey: string; privateKey: string; subject: string };
  cooldownMs?: number;
  windowMs?: number;
  spikeReportThreshold?: number;
  distinctInstallThreshold?: number;
  requestTimeoutMs?: number;
};

export type NotificationInput = {
  issueId: number;
  report: ErrorReport;
  rule: RuleEvaluation;
  isNewIssue: boolean;
  // Identity of the one committed fixed -> regressed transition, supplied by
  // the future ingestion transaction, never simply the current issue status.
  regressionEventId?: string;
  now?: number;
};

export type PushClaim = {
  issue_id: number;
  event_type: NotificationTrigger;
  dedupe_key: string;
  lease_token: string;
  lease_expires_at: number;
};

export type PushSummary = {
  state: 'suppressed' | 'already_claimed' | 'no_subscriptions' | 'delivered' | 'partial' | 'failed';
  trigger: NotificationTrigger | null;
  attempted: number;
  delivered: number;
  expired: number;
  failed: number;
  retryable: boolean;
};

type IssueState = {
  id: number;
  fingerprint: string;
  status: 'new' | 'investigating' | 'fixed' | 'regressed' | 'ignored';
  muted: number;
  fixed_in_version: string | null;
  last_pushed_at: number | null;
  last_seen_at: number;
};
type SubscriptionRow = PushTarget & { id: number };
type WindowCounts = { report_count: number; distinct_installs: number };

const MAX_TIME = 253_402_300_799_999;
const LEASE_MS = 30_000;
const DELIVERY_BUDGET_MS = 18_000;
const MAX_SUBSCRIPTIONS_PER_DISPATCH = 100;
const PUSH_CONCURRENCY = 4;
const triggers: readonly NotificationTrigger[] = ['NEW_CRITICAL', 'REGRESSION', 'SPIKE_DETECTED', 'UPSTREAM_CHANGE'];

function integer(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`Invalid ${label}`);
  return value;
}

function timestamp(value: number): number {
  return integer(value, 0, MAX_TIME - LEASE_MS, 'server timestamp');
}

function settings(config: NotificationConfiguration) {
  const origin = new URL(config.dashboardOrigin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new TypeError('Dashboard must be an HTTPS origin');
  }
  return {
    origin: origin.origin,
    cooldownMs: integer(config.cooldownMs ?? 1_800_000, 1000, 86_400_000, 'push cooldown'),
    windowMs: integer(config.windowMs ?? 900_000, 1000, 86_400_000, 'detection window'),
    spikeReportThreshold: integer(config.spikeReportThreshold ?? 10, 1, 1_000_000, 'spike threshold'),
    distinctInstallThreshold: integer(config.distinctInstallThreshold ?? 3, 2, 1_000_000, 'installation threshold'),
    requestTimeoutMs: integer(config.requestTimeoutMs ?? 5000, 1, 5000, 'request timeout')
  };
}

function summary(state: PushSummary['state'], trigger: NotificationTrigger | null): PushSummary {
  return { state, trigger, attempted: 0, delivered: 0, expired: 0, failed: 0, retryable: false };
}

/** Atomically reserve a single event while enforcing issue-wide cooldown/leases. */
export async function reservePushNotification(db: D1Database, input: {
  issueId: number; trigger: NotificationTrigger; dedupeKey: string; now: number; cooldownMs?: number; leaseMs?: number;
}): Promise<PushClaim | null> {
  integer(input.issueId, 1, Number.MAX_SAFE_INTEGER, 'issue ID');
  const now = timestamp(input.now);
  const cooldown = integer(input.cooldownMs ?? 1_800_000, 1000, 86_400_000, 'push cooldown');
  const lease = integer(input.leaseMs ?? LEASE_MS, 1, LEASE_MS, 'lease duration');
  if (!triggers.includes(input.trigger) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.dedupeKey)) throw new TypeError('Invalid notification event identity');
  const token = crypto.randomUUID();
  return db.prepare(`
    INSERT INTO notification_claims (issue_id,event_type,dedupe_key,lease_token,lease_expires_at,created_at)
    SELECT i.id, ?, ?, ?, ?, ? FROM issues i
    WHERE i.id = ? AND i.muted = 0 AND i.status <> 'ignored'
      AND (? <> 'REGRESSION' OR i.status = 'regressed')
      AND (? = 'REGRESSION' OR i.last_pushed_at IS NULL OR i.last_pushed_at <= ?)
      AND (? = 'REGRESSION' OR NOT EXISTS (
        SELECT 1 FROM notification_claims active
        WHERE active.issue_id = i.id AND active.delivered_at IS NULL AND active.lease_expires_at > ?
      ))
    ON CONFLICT (issue_id,event_type,dedupe_key) DO UPDATE SET
      lease_token=excluded.lease_token, lease_expires_at=excluded.lease_expires_at
    WHERE notification_claims.delivered_at IS NULL
      AND (notification_claims.lease_expires_at IS NULL OR notification_claims.lease_expires_at <= ?)
    RETURNING issue_id,event_type,dedupe_key,lease_token,lease_expires_at
  `).bind(
    input.trigger, input.dedupeKey, token, now + lease, now, input.issueId,
    input.trigger, input.trigger, now - cooldown, input.trigger, now, now
  ).first<PushClaim>();
}

/** Complete only the currently owned lease; stale workers cannot start cooldown. */
export async function completePushNotification(db: D1Database, claim: PushClaim, completedAt: number): Promise<boolean> {
  timestamp(completedAt);
  const results = await db.batch([
    db.prepare(`UPDATE notification_claims SET delivered_at=?
      WHERE issue_id=? AND event_type=? AND dedupe_key=? AND lease_token=? AND delivered_at IS NULL
      RETURNING issue_id`).bind(completedAt, claim.issue_id, claim.event_type, claim.dedupe_key, claim.lease_token),
    db.prepare(`UPDATE issues SET last_pushed_at=CASE
        WHEN last_pushed_at IS NULL OR last_pushed_at < ? THEN ? ELSE last_pushed_at END,
        updated_at=max(updated_at,?)
      WHERE id=? AND EXISTS (SELECT 1 FROM notification_claims
        WHERE issue_id=? AND event_type=? AND dedupe_key=? AND lease_token=? AND delivered_at=?)`
    ).bind(completedAt, completedAt, completedAt, claim.issue_id, claim.issue_id, claim.event_type, claim.dedupe_key, claim.lease_token, completedAt)
  ]);
  return (results[0]?.results.length ?? 0) === 1;
}

export async function releasePushNotification(db: D1Database, claim: PushClaim): Promise<boolean> {
  const result = await db.prepare(`UPDATE notification_claims SET lease_token=NULL,lease_expires_at=NULL
    WHERE issue_id=? AND event_type=? AND dedupe_key=? AND lease_token=? AND delivered_at IS NULL`
  ).bind(claim.issue_id, claim.event_type, claim.dedupe_key, claim.lease_token).run();
  return result.meta.changes === 1;
}

async function subscriptionRows(db: D1Database): Promise<{ total: number; rows: SubscriptionRow[] }> {
  const [count, subscriptions] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS total FROM push_subscriptions').first<{ total: number }>(),
    db.prepare('SELECT id,endpoint,p256dh,auth,expiration_time FROM push_subscriptions ORDER BY id LIMIT ?')
      .bind(MAX_SUBSCRIPTIONS_PER_DISPATCH).all<SubscriptionRow>()
  ]);
  return { total: count?.total ?? 0, rows: subscriptions.results };
}

async function dispatchPush(db: D1Database, targets: { total: number; rows: SubscriptionRow[] }, payload: PushPayload,
  config: NotificationConfiguration, now: number, timeoutMs: number): Promise<PushSummary> {
  const result = summary(targets.total ? 'failed' : 'no_subscriptions', payload.data.trigger === 'TEST' ? null : payload.data.trigger as NotificationTrigger);
  if (!targets.total) return result;
  const deadline = performance.now() + DELIVERY_BUDGET_MS;
  let next = 0;
  async function worker(): Promise<void> {
    while (next < targets.rows.length && performance.now() < deadline) {
      const target = targets.rows[next++];
      if (!target) return;
      const remaining = Math.floor(deadline - performance.now());
      if (remaining < 1) return;
      result.attempted += 1;
      const delivery = await sendWebPush(target, payload, config.vapid, { timeoutMs: Math.min(timeoutMs, remaining), now });
      if (delivery.ok) result.delivered += 1;
      else {
        result.failed += 1;
        result.retryable ||= delivery.retryable;
        if (delivery.expired) {
          result.expired += 1;
          // A subscription may have rotated while delivery was in flight.
          try {
            await db.prepare('DELETE FROM push_subscriptions WHERE id=? AND endpoint=? AND p256dh=? AND auth=?')
              .bind(target.id, target.endpoint, target.p256dh, target.auth).run();
          } catch {
            // Cleanup is best effort. It must not release the issue claim while
            // another worker is still delivering or erase accepted deliveries.
            result.retryable = true;
          }
        }
      }
    }
  }
  const workers = await Promise.allSettled(Array.from({ length: Math.min(PUSH_CONCURRENCY, targets.rows.length) }, () => worker()));
  result.retryable ||= workers.some((workerResult) => workerResult.status === 'rejected');
  const unattempted = Math.max(0, targets.total - result.attempted);
  result.failed += unattempted;
  result.failed = Math.max(result.failed, targets.total - result.delivered);
  result.retryable ||= unattempted > 0;
  result.state = result.delivered ? (result.failed ? 'partial' : 'delivered') : 'failed';
  return result;
}

function chooseTrigger(issue: IssueState, input: NotificationInput, counts: WindowCounts, config: ReturnType<typeof settings>): NotificationTrigger | null {
  if (issue.status === 'ignored' || issue.muted) return null;
  if (input.regressionEventId && issue.status === 'regressed' && issue.fixed_in_version
    && versionSchema.safeParse(issue.fixed_in_version).success && compare(input.report.version, issue.fixed_in_version, '>')) return 'REGRESSION';
  if (input.rule.structural_category !== null && counts.distinct_installs >= config.distinctInstallThreshold) return 'UPSTREAM_CHANGE';
  if (input.isNewIssue && (input.report.severity === 'error' || input.report.severity === 'fatal')) return 'NEW_CRITICAL';
  if (!input.isNewIssue && counts.report_count >= config.spikeReportThreshold && counts.distinct_installs >= config.distinctInstallThreshold) return 'SPIKE_DETECTED';
  return null;
}

function eventKey(trigger: NotificationTrigger, input: NotificationInput, now: number, cooldown: number): string {
  if (trigger === 'REGRESSION') return input.regressionEventId ?? input.report.report_id;
  if (trigger === 'NEW_CRITICAL') return 'initial';
  return `${trigger.toLowerCase()}:${Math.floor(now / cooldown)}`;
}

function pushPayload(trigger: NotificationTrigger, issue: IssueState, input: NotificationInput, origin: string, badgeCount: number): PushPayload {
  const title: Record<NotificationTrigger, string> = {
    NEW_CRITICAL: 'New critical issue', REGRESSION: 'Regression detected',
    SPIKE_DETECTED: 'Issue spike detected', UPSTREAM_CHANGE: 'Upstream change detected'
  };
  return {
    title: title[trigger],
    body: Array.from(sanitizeText(`${input.rule.category}: ${input.report.error_message}`)).slice(0, 240).join(''),
    tag: issue.fingerprint,
    data: { url: new URL(`/?issue=${issue.id}`, origin).href, issue_id: issue.id, fingerprint: issue.fingerprint, trigger },
    badge_count: badgeCount
  };
}

async function issuePush(db: D1Database, issue: IssueState, input: NotificationInput,
  config: NotificationConfiguration, resolved: ReturnType<typeof settings>, now: number): Promise<PushSummary> {
  const counts = await db.prepare(`SELECT COUNT(*) AS report_count,COUNT(DISTINCT install_id) AS distinct_installs
    FROM reports WHERE issue_id=? AND created_at>=? AND created_at<=?`
  ).bind(issue.id, Math.max(0, now - resolved.windowMs), now).first<WindowCounts>();
  const trigger = chooseTrigger(issue, input, counts ?? { report_count: 0, distinct_installs: 0 }, resolved);
  if (!trigger) return summary('suppressed', null);
  const targets = await subscriptionRows(db);
  if (!targets.total) return summary('no_subscriptions', trigger);
  const claim = await reservePushNotification(db, {
    issueId: issue.id, trigger, dedupeKey: eventKey(trigger, input, now, resolved.cooldownMs), now, cooldownMs: resolved.cooldownMs
  });
  if (!claim) return summary('already_claimed', trigger);
  try {
    const badge = await db.prepare("SELECT COUNT(*) AS count FROM issues WHERE status IN ('new','investigating','regressed') AND muted=0").first<{ count: number }>();
    const result = await dispatchPush(db, targets, pushPayload(trigger, issue, input, resolved.origin, Math.min(9999, badge?.count ?? 0)), config, now, resolved.requestTimeoutMs);
    if (result.delivered) await completePushNotification(db, claim, Math.max(now, Date.now()));
    else await releasePushNotification(db, claim);
    return result;
  } catch (error) {
    await releasePushNotification(db, claim);
    throw error;
  }
}

/** Call after a newly accepted report is committed, from ctx.waitUntil(). */
export async function sendIssueNotifications(db: D1Database, input: NotificationInput, config: NotificationConfiguration): Promise<{ discord: DeliveryResult; push: PushSummary }> {
  const resolved = settings(config);
  const now = timestamp(input.now ?? Date.now());
  const report = sanitizeReport(input.report);
  const issue = await db.prepare(`SELECT i.id,i.fingerprint,i.status,i.muted,i.fixed_in_version,i.last_pushed_at,i.last_seen_at
    FROM issues i JOIN report_receipts receipt ON receipt.issue_id=i.id
    WHERE i.id=? AND receipt.id=? AND receipt.install_id=?`
  ).bind(input.issueId, report.report_id, report.install_id).first<IssueState>();
  if (!issue) throw new Error('Report must be persisted for the selected issue before delivery');
  const sanitizedInput = { ...input, report };
  // Request clocks can be ordered differently from D1 commits. Include the
  // latest known receipt when detecting current canaries/spikes and claiming
  // their delivery, while Discord retains this report's diagnostic context.
  const pushNow = timestamp(Math.max(now, issue.last_seen_at));
  // Discord is independent of push mute/cooldown and receives every newly
  // accepted report. The ingestion transaction must not schedule report retries.
  const [discord, push] = await Promise.allSettled([
    sendDiscordReport(config.discordWebhookUrl, report, {
      issueId: issue.id, fingerprint: issue.fingerprint, dashboardOrigin: resolved.origin,
      category: input.rule.category, faultOrigin: input.rule.fault_origin, suggestedAction: input.rule.suggested_action
    }, { timeoutMs: resolved.requestTimeoutMs, now }),
    issuePush(db, issue, sanitizedInput, config, resolved, pushNow)
  ]);
  const failedPush = summary('failed', null);
  failedPush.retryable = true;
  return {
    discord: discord.status === 'fulfilled' ? discord.value : {
      ok: false, status: null, retryable: true, expired: false, retry_after_ms: null, reason: 'network_error'
    },
    push: push.status === 'fulfilled' ? push.value : failedPush
  };
}

/** Future protected admin endpoint: test delivery without issue/cooldown changes. */
export async function sendTestNotification(db: D1Database, config: NotificationConfiguration, now = Date.now()): Promise<PushSummary> {
  const resolved = settings(config);
  timestamp(now);
  return dispatchPush(db, await subscriptionRows(db), {
    title: 'Diagnostics test', body: 'Web Push is connected.', tag: 'diagnostics-test',
    data: { url: new URL('/', resolved.origin).href, issue_id: null, fingerprint: null, trigger: 'TEST' }, badge_count: 0
  }, config, now, resolved.requestTimeoutMs);
}
````

## diagnostics/test/helpers/d1.mjs

````javascript
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// Exercise production SQL against SQLite; only the D1 method boundary is adapted.
export function createTestDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8'));

  function prepare(sql, values = []) {
    function execute() {
      const results = sqlite.prepare(sql).all(...values).map((row) => ({ ...row }));
      const meta = sqlite.prepare('SELECT changes() AS changes, last_insert_rowid() AS last_row_id').get();
      return { success: true, results, meta: { ...meta, duration: 0, rows_read: results.length, rows_written: meta.changes } };
    }
    return {
      bind(...nextValues) { return prepare(sql, nextValues); },
      async first(column) {
        const row = execute().results[0] ?? null;
        return column && row ? row[column] : row;
      },
      async all() { return execute(); },
      async run() { return execute(); },
      async raw() { return execute().results.map((row) => Object.values(row)); },
      execute
    };
  }

  return {
    sqlite,
    prepare,
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    close() { sqlite.close(); }
  };
}
````

## diagnostics/test/helpers/access.mjs

````javascript
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
````

## diagnostics/test/security.test.mjs

````javascript
import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { publicCors, requireAccess, requireSameOrigin, boundedJson, limitPublicIp, limitPublicInstall, limitAdminPushTest } from '../src/http/security.ts';
import { notificationConfiguration, ingestionOptions } from '../src/http/config.ts';
import { createTestDatabase } from './helpers/d1.mjs';
import { bindings, createAccessFixture } from './helpers/access.mjs';

const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const INSTALL = 'a'.repeat(64);
const NOW = 1_792_604_800_000;
function appWith(...middleware) {
  const app = new Hono();
  app.use('*', (c, next) => { c.set('serverNow', NOW); return next(); });
  app.use('*', ...middleware);
  app.all('*', async (c) => c.json({ accepted: true, body: c.get('rawJson') }));
  return app;
}
function request(path = '/api/ingest', options = {}) {
  return new Request(`https://diagnostics.example.com${path}`, { method: 'POST', ...options,
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.8', ...options.headers } });
}
function database(t) { const db = createTestDatabase(); t.after(() => db.close()); return db; }

test('CORS accepts exact extension origins and retains headers on downstream failures', async () => {
  const app = appWith(publicCors, boundedJson);
  for (const origin of [ORIGIN, 'moz-extension://3761cb55-49b3-4f63-bbad-74c5cc586528']) {
    const response = await app.fetch(request('/api/ingest', { headers: { Origin: origin }, body: '{' }), bindings());
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.match(response.headers.get('vary'), /Origin/);
  }
  for (const origin of ['', 'null', 'https://example.com', `${ORIGIN}/`, `${ORIGIN}:80`, 'chrome-extension://abc', 'moz-extension://bad']) {
    const response = await app.fetch(request('/api/heartbeat', { headers: { Origin: origin }, body: '{}' }), bindings());
    assert.equal(response.status, 403, origin);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  const response = await app.fetch(request('/api/admin/issues', { body: '{}' }), bindings());
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('CORS restricts preflight to POST and content-type and rejects unsupported methods', async () => {
  const app = appWith(publicCors);
  const preflight = { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type' } };
  const valid = await app.fetch(request('/api/ingest', preflight), bindings());
  assert.equal(valid.status, 204);
  assert.equal(valid.headers.get('access-control-allow-methods'), 'POST');
  assert.equal(valid.headers.get('access-control-allow-headers'), 'Content-Type');
  for (const headers of [{ 'Access-Control-Request-Method': 'DELETE' }, { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' }, {}]) {
    assert.equal((await app.fetch(request('/api/ingest', { method: 'OPTIONS', headers }), bindings())).status, 403);
  }
  assert.equal((await app.fetch(request('/api/ingest', { method: 'GET' }), bindings())).status, 405);
});

test('body limit counts actual streamed UTF-8 bytes despite absent or false Content-Length', async () => {
  const app = appWith(publicCors, boundedJson);
  const large = `${' '.repeat(65_537)}{}`;
  for (const headers of [{}, { 'Content-Length': '1' }]) {
    const response = await app.fetch(request('/api/ingest', { body: large, headers }), bindings());
    assert.equal(response.status, 413);
    assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  }
  let cancelled = false;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(16_384)); }, cancel() { cancelled = true; } });
  assert.equal((await app.fetch(request('/api/ingest', { body: stream, duplex: 'half' }), bindings())).status, 413);
  assert.equal(cancelled, true);
  assert.equal((await app.fetch(request('/api/ingest', { body: JSON.stringify({ value: 'é'.repeat(33_000) }) }), bindings())).status, 413);
});

test('oversized stream returns 413 even when its cancellation never settles', async () => {
  const app = appWith(boundedJson);
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(65_537)); },
    cancel() { cancelled = true; return new Promise(() => {}); }
  });
  let timeout;
  try {
    const response = await Promise.race([
      app.fetch(request('/api/ingest', { body: stream, duplex: 'half' }), bindings()),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Body rejection waited for cancellation')), 500); })
    ]);
    assert.equal(response.status, 413);
    assert.equal(cancelled, true);
  } finally { clearTimeout(timeout); }
});

test('bounded JSON rejects compressed/non-JSON/invalid UTF-8 and caches bounded text for Zod', async () => {
  const app = appWith(boundedJson);
  for (const [body, headers, status] of [['{}', { 'Content-Type': 'text/plain' }, 415], ['{}', { 'Content-Encoding': 'gzip' }, 415], ['secret-invalid-input', {}, 400], [new Uint8Array([0xff, 0x22]), {}, 400]]) {
    const response = await app.fetch(request('/api/ingest', { body, headers }), bindings());
    assert.equal(response.status, status);
    assert.doesNotMatch(await response.text(), /secret-invalid-input|SyntaxError|Unexpected/);
  }
  const validated = new Hono();
  validated.post('/api/ingest', boundedJson, zValidator('json', z.object({ value: z.string() })), (c) => c.json(c.req.valid('json')));
  const response = await validated.fetch(request('/api/ingest', { body: '{"value":"works"}' }), bindings());
  assert.deepEqual(await response.json(), { value: 'works' });
  assert.equal((await app.fetch(request('/api/ingest', { body: '{}', headers: { 'Content-Type': 'application/json; charset=utf-8' } }), bindings())).status, 200);
});

test('same-origin middleware allows safe methods and rejects missing or foreign mutation Origin', async () => {
  const app = appWith(requireSameOrigin);
  for (const method of ['GET', 'HEAD', 'OPTIONS']) assert.equal((await app.fetch(request('/', { method }), bindings())).status, 200);
  for (const origin of ['', 'null', 'https://evil.example', 'https://diagnostics.example.com/', 'https://diagnostics.example.com.evil.example']) {
    assert.equal((await app.fetch(request('/', { headers: { Origin: origin } }), bindings())).status, 403);
  }
  assert.equal((await app.fetch(request('/', { headers: { Origin: 'https://diagnostics.example.com' } }), bindings())).status, 200);
});

test('IP and installation limits are atomic, independent per route, HMAC hashed and reset per window', async (t) => {
  const db = database(t);
  const env = bindings(db, { INGEST_IP_LIMIT: '3', INGEST_INSTALL_LIMIT: '2' });
  const app = appWith(publicCors, limitPublicIp, boundedJson, limitPublicInstall);
  const send = (path = '/api/ingest', install = INSTALL) => app.fetch(request(path, { body: JSON.stringify({ install_id: install }) }), env);
  const responses = await Promise.all([send(), send(), send(), send()]);
  assert.equal(responses.filter((response) => response.status === 200).length, 2);
  assert.equal(responses.filter((response) => response.status === 429).length, 2);
  assert.ok(responses.find((response) => response.status === 429).headers.get('retry-after'));
  assert.equal((await send('/api/heartbeat')).status, 200);
  const rows = db.sqlite.prepare('SELECT * FROM rate_limit_buckets').all();
  assert.ok(rows.every((row) => /^[a-f0-9]{64}$/.test(row.key_hash)));
  assert.ok(rows.every((row) => row.request_count <= (row.scope === 'ip' ? 3 : 2)));
  assert.doesNotMatch(JSON.stringify(rows), /203\.0\.113\.8/);
  assert.ok(!rows.some((row) => row.key_hash === INSTALL));
  const expectedKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.RATE_LIMIT_HASH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expectedHash = Buffer.from(await crypto.subtle.sign('HMAC', expectedKey, new TextEncoder().encode(JSON.stringify(['/api/ingest', 'ip', '203.0.113.8'])))).toString('hex');
  assert.ok(rows.some((row) => row.key_hash === expectedHash));
  const nextWindow = new Hono();
  nextWindow.use('*', (c, next) => { c.set('serverNow', NOW + 60_000); return next(); });
  nextWindow.use('*', limitPublicIp, boundedJson, limitPublicInstall);
  nextWindow.post('*', (c) => c.json({ accepted: true }));
  assert.equal((await nextWindow.fetch(request('/api/ingest', { body: JSON.stringify({ install_id: INSTALL }) }), env)).status, 200);
});

test('trusted IP validation, invalid installs and unavailable rate storage fail closed before processing', async (t) => {
  const db = database(t);
  const app = appWith(limitPublicIp, boundedJson, limitPublicInstall);
  for (const ip of ['', 'garbage', '1.2.3.999', '1.2.3.4, 5.6.7.8', '[::1]', 'fe80::1%eth0', '1.2.3.04']) {
    assert.equal((await app.fetch(request('/api/ingest', { headers: { 'CF-Connecting-IP': ip }, body: '{}' }), bindings(db))).status, 403, ip);
  }
  for (const ip of ['::1', '2001:db8::1', '::ffff:192.0.2.1']) {
    assert.equal((await app.fetch(request('/api/ingest', { headers: { 'CF-Connecting-IP': ip }, body: JSON.stringify({ install_id: INSTALL }) }), bindings(db))).status, 200, ip);
  }
  assert.equal((await app.fetch(request('/api/ingest', { body: '{"install_id":"bad"}' }), bindings(db))).status, 400);
  assert.equal((await app.fetch(request('/api/ingest', { body: '{}' }), bindings(db, { RATE_LIMIT_HASH_SECRET: 'short' }))).status, 503);
  const broken = { prepare() { throw new Error('database-secret-error'); } };
  const response = await app.fetch(request('/api/ingest', { body: '{}' }), bindings(broken));
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /database-secret-error/);
});

test('new buckets purge at most 100 expired rows while preserving active buckets', async (t) => {
  const db = database(t);
  const insert = db.sqlite.prepare(`INSERT INTO rate_limit_buckets
    (scope,key_hash,window_started_at,window_duration_ms,request_count,expires_at) VALUES ('ip',?,0,60000,1,120000)`);
  for (let index = 0; index < 140; index++) insert.run(index.toString(16).padStart(64, '0'));
  const app = appWith(limitPublicIp);
  assert.equal((await app.fetch(request(), bindings(db))).status, 200);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS total FROM rate_limit_buckets WHERE expires_at<=?').get(NOW).total, 40);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS total FROM rate_limit_buckets WHERE expires_at>?').get(NOW).total, 1);
  assert.equal((await app.fetch(request(), bindings(db))).status, 200);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS total FROM rate_limit_buckets WHERE expires_at<=?').get(NOW).total, 40);
});

test('admin push-test rate is one per minute per verified identity with no raw identity in storage', async (t) => {
  const db = database(t);
  const env = bindings(db, { RATE_LIMIT_WINDOW_SECONDS: '1', INGEST_INSTALL_LIMIT: '1000' });
  const app = new Hono();
  app.use('*', (c, next) => {
    c.set('serverNow', Number(c.req.header('X-Test-Time') ?? NOW));
    c.set('accessPayload', { sub: c.req.header('X-Test-Sub') ?? 'verified-subject', email: 'owner@example.com' });
    return next();
  });
  app.post('/api/admin/push/test', limitAdminPushTest, (c) => c.json({ accepted: true }));
  const send = (headers = {}) => app.fetch(request('/api/admin/push/test', { body: '{}', headers }), env);
  const responses = await Promise.all([send(), send()]);
  assert.equal(responses.filter((response) => response.status === 200).length, 1);
  assert.equal(responses.filter((response) => response.status === 429).length, 1);
  assert.ok(Number(responses.find((response) => response.status === 429).headers.get('retry-after')) > 0);
  assert.equal((await send({ 'X-Test-Time': String(NOW + 2000) })).status, 429);
  assert.equal((await send({ 'X-Test-Sub': 'another-verified-subject' })).status, 200);
  assert.equal((await send({ 'X-Test-Time': String(NOW + 60_000) })).status, 200);
  const rows = db.sqlite.prepare('SELECT * FROM rate_limit_buckets').all();
  assert.ok(rows.every((row) => row.window_duration_ms === 60_000 && row.request_count === 1));
  assert.doesNotMatch(JSON.stringify(rows), /verified-subject|owner@example\.com/);
  const missingIdentity = appWith(limitAdminPushTest);
  assert.equal((await missingIdentity.fetch(request('/api/admin/push/test', { body: '{}' }), env)).status, 401);
  const fallback = new Hono();
  fallback.use('*', (c, next) => { c.set('serverNow', NOW); c.set('accessPayload', { email: 'owner@example.com' }); return next(); });
  fallback.post('*', limitAdminPushTest, (c) => c.json({ accepted: true }));
  assert.equal((await fallback.fetch(request('/api/admin/push/test', { body: '{}' }), env)).status, 200);
  assert.equal((await fallback.fetch(request('/api/admin/push/test', { body: '{}' }), env)).status, 429);
});

test('Access requires a genuine RSA signature and exact issuer/audience in the assertion header', async (t) => {
  const fixture = await createAccessFixture(t);
  const app = appWith(requireAccess);
  const env = bindings(undefined, { CF_ACCESS_TEAM_DOMAIN: fixture.teamDomain, CF_ACCESS_AUD: fixture.audience });
  const good = await fixture.token();
  assert.equal((await app.fetch(request('/', { headers: { 'Cf-Access-Jwt-Assertion': good } }), env)).status, 200);
  assert.equal((await app.fetch(request('/', { headers: { Cookie: `CF_Authorization=${good}` } }), env)).status, 401);
  for (const overrides of [{ aud: ['wrong'] }, { iss: 'https://attacker.cloudflareaccess.com' }, { exp: 1 }, { nbf: Math.floor(Date.now() / 1000) + 120 }, { iat: Math.floor(Date.now() / 1000) + 120 }, { exp: null }, { iat: null }, { nbf: null }, { exp: undefined }, { iat: undefined }, { nbf: undefined }, { aud: undefined }, { iss: undefined }, { exp: 1e300 }, { aud: [] }]) {
    const response = await app.fetch(request('/', { headers: { 'Cf-Access-Jwt-Assertion': await fixture.token(overrides) } }), env);
    assert.equal(response.status, 401, JSON.stringify(overrides));
    assert.deepEqual(await response.json(), { error: 'Unauthorized' });
  }
  const pieces = good.split('.');
  pieces[1] = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(pieces[1], 'base64url')), email: 'tampered@example.com' })).toString('base64url');
  assert.equal((await app.fetch(request('/', { headers: { 'Cf-Access-Jwt-Assertion': pieces.join('.') } }), env)).status, 401);
  for (const overrides of [{ CF_ACCESS_TEAM_DOMAIN: 'https://fixture.cloudflareaccess.com/path' }, { CF_ACCESS_TEAM_DOMAIN: 'fixture.evil.example' }, { CF_ACCESS_AUD: '' }]) {
    assert.equal((await app.fetch(request('/', { headers: { 'Cf-Access-Jwt-Assertion': good } }), { ...env, ...overrides })).status, 503);
  }
});

test('configuration parses bounded integer settings and refuses invalid deployment values', () => {
  const env = bindings();
  assert.deepEqual(ingestionOptions(env), { windowMs: 900_000, distinctInstallThreshold: 3 });
  const config = notificationConfiguration(env, 'https://diagnostics.example.com');
  assert.equal(config.cooldownMs, 1_800_000);
  assert.equal(config.spikeReportThreshold, 10);
  for (const value of ['', '1e3', '-1', '1.2', '99999999999999999999']) assert.throws(() => ingestionOptions({ ...env, DETECTION_WINDOW_SECONDS: value }));
});
````

## diagnostics/test/ingestion.test.mjs

````javascript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorReportSchema, heartbeatSchema } from '../src/schemas/ingest.ts';
import { createTestDatabase } from './helpers/d1.mjs';

const NOW = 1_792_604_800_000;
const uuid = (number) => `12345678-1234-4234-8234-${number.toString(16).padStart(12, '0')}`;
const install = (number) => number.toString(16).padStart(64, '0');
let service;
try {
  service = await import('../src/services/ingestion.ts');
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  service = {};
}
const { acceptErrorReport, acceptHeartbeat, IngestionConflict } = service;

function report(overrides = {}) {
  return errorReportSchema.parse({
    schema_version: 1, consent: 'diagnostics-v1', report_id: uuid(1), install_id: install(1),
    occurred_at: new Date(NOW).toISOString(), version: '3.2.0', browser: 'chrome', browser_version: '142.0',
    os: 'windows', download_mode: 'manual', destination: 'browser', severity: 'error',
    error_category: 'DOWNLOAD_ERROR', error_code: 'REQUEST_FAILED', failure_stage: 'PRIMARY_API_REQUEST',
    error_message: 'Something unexpected happened', ...overrides,
  });
}

function heartbeat(overrides = {}) {
  return heartbeatSchema.parse({
    schema_version: 1, consent: 'telemetry-v1', heartbeat_id: uuid(1), install_id: install(1),
    metric_date: '2026-10-21', version: '3.2.0', browser: 'chrome', destination: 'browser',
    attempts_count: 10, success_count: 8, fallback_triggered_count: 3, ...overrides,
  });
}

test('persists one report and counts its anonymous installation exactly once', async (t) => {
  assert.equal(typeof acceptErrorReport, 'function', 'report ingestion service must exist');
  const db = createTestDatabase(); t.after(() => db.close());
  const result = await acceptErrorReport(db, report(), NOW);
  assert.equal(result.accepted, true);
  assert.equal(result.isNewIssue, true);
  assert.equal(result.reportId, uuid(1));
  assert.equal(result.rule.category, 'UNKNOWN_ERROR');
  assert.equal(result.regressionEventId, undefined);
  const issue = db.sqlite.prepare('SELECT * FROM issues').get();
  assert.equal(result.issueId, issue.id);
  assert.equal(issue.total_occurrences, 1);
  assert.equal(issue.affected_installs_count, 1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM report_receipts').get().n, 1);
});

test('serializes concurrent first reports and replays without duplicate counts or new issue events', async (t) => {
  const db = createTestDatabase(); t.after(() => db.close());
  const input = report();
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => acceptErrorReport(db, input, NOW + index)));
  assert.equal(results.filter((result) => result.accepted).length, 1);
  assert.equal(results.filter((result) => result.isNewIssue).length, 1);
  const second = await acceptErrorReport(db, report({ report_id: uuid(2), install_id: install(2), version: '3.2.1' }), NOW + 20);
  assert.equal(second.isNewIssue, false);
  const before = db.sqlite.prepare('SELECT * FROM issues').get();
  await acceptErrorReport(db, input, NOW + 30);
  assert.deepEqual(db.sqlite.prepare('SELECT * FROM issues').get(), before);
  assert.equal(before.total_occurrences, 2);
  assert.equal(before.affected_installs_count, 2);
  assert.equal(before.last_seen_version, '3.2.1');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM issues').get().n, 1);
});

test('concurrent distinct reports track counts without confusing issue creation with postinsert totals', async (t) => {
  const db = createTestDatabase(); t.after(() => db.close());
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => acceptErrorReport(db,
    report({ report_id: uuid(index + 1), install_id: install(index % 4) }), NOW + index)));
  assert.equal(results.filter((result) => result.isNewIssue).length, 1);
  assert.equal(results.filter((result) => result.accepted).length, 12);
  const issue = db.sqlite.prepare('SELECT * FROM issues').get();
  assert.equal(issue.total_occurrences, 12);
  assert.equal(issue.affected_installs_count, 4);
});

test('retention replays preserve receipts without recreating a body or activity', async (t) => {
  const db = createTestDatabase(); t.after(() => db.close());
  await acceptErrorReport(db, report(), NOW);
  db.sqlite.prepare('DELETE FROM reports').run();
  const before = db.sqlite.prepare('SELECT * FROM issues').get();
  const replay = await acceptErrorReport(db, report({ error_message: 'Retained body is no longer available' }), NOW + 50);
  assert.equal(replay.accepted, false);
  assert.equal(replay.isNewIssue, false);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM reports').get().n, 0);
  assert.deepEqual(db.sqlite.prepare('SELECT * FROM issues').get(), before);
});

test('rejects a report UUID belonging to a different installation or fingerprint without leaking its issue', async (t) => {
  const db = createTestDatabase(); t.after(() => db.close());
  await acceptErrorReport(db, report(), NOW);
  const before = db.sqlite.prepare('SELECT * FROM issues').all();
  for (const overrides of [{ install_id: install(2) }, { destination: 'vortex' }, { error_code: 'DIFFERENT_ERROR' }]) {
    await assert.rejects(acceptErrorReport(db, report(overrides), NOW + 10), (error) => {
      assert.ok(error instanceof IngestionConflict);
      assert.equal(typeof error.code, 'string');
      assert.equal('issueId' in error, false);
      assert.equal(error.message.includes(install(1)), false);
      return true;
    });
  }
  assert.deepEqual(db.sqlite.prepare('SELECT * FROM issues').all(), before);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM reports').get().n, 1);
});

test('rejects altered retained report bodies but accepts semantically identical metadata order', async (t) => {
  const db = createTestDatabase(); t.after(() => db.close());
  const breadcrumbs = [{ timestamp_offset_ms: 0, stage: 'API', action: 'REQUEST', status: 'error', metadata: { a: 1, b: 2 } }];
  await acceptErrorReport(db, report({ breadcrumbs }), NOW);
  await assert.rejects(acceptErrorReport(db, report({ breadcrumbs, error_message: 'Changed body' }), NOW + 1), IngestionConflict);
  const replay = await acceptErrorReport(db, report({ breadcrumbs: [{ ...breadcrumbs[0], metadata: { b: 2, a: 1 } }] }), NOW + 2);
  assert.equal(replay.accepted, false);
});

test('one conflicting concurrent UUID wins and leaves no orphan issue', async (t) => {
  const db = createTestDatabase(); t.after(() => db.close());
  const results = await Promise.allSettled([
    acceptErrorReport(db, report(), NOW),
    acceptErrorReport(db, report({ install_id: install(2), destination: 'mo2' }), NOW),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const failure = results.find((result) => result.status === 'rejected');
  assert.ok(failure.reason instanceof IngestionConflict);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM issues').get().n, 1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM report_receipts').get().n, 1);
});

test('database failures roll back the issue, report, receipt and trigger totals together', async (t) => {
  const db = createTestDatabase(); t.after(() => db.close());
  db.sqlite.exec("CREATE TRIGGER reject_reports BEFORE INSERT ON reports BEGIN SELECT RAISE(ABORT, 'injected report failure'); END;");
  await assert.rejects(acceptErrorReport(db, report(), NOW), /injected report failure/);
  for (const table of ['issues', 'reports', 'report_receipts', 'issue_installs']) {
    assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  }
});

test('sanitizes every free-form persisted report field and normalizes raw Firefox stacks for grouping', async (t) => {
  const db = createTestDatabase(); t.after(() => db.close());
  const result = await acceptErrorReport(db, report({
    error_message: 'Failure Authorization: Bearer private-secret',
    stack_trace: 'download@chrome-extension://private-extension-id/background.js?token=private-token:7:8',
    os_version: '192.168.1.10', collection_id: 'api-key-private-secret',
    breadcrumbs: [{ timestamp_offset_ms: 0, stage: 'API', action: 'REQUEST', status: 'error', metadata: { authorization: 'private-secret', path: 'C:\\Users\\Alice\\game.zip', url: 'https://example.test/api?token=private-token' } }],
    dom_state: { document_ready_state: 'complete', page_kind: 'mod', selectors: [{ selector: 'alice@example.com', matched: false }] },
  }), NOW);
  assert.equal(result.accepted, true);
  const persisted = JSON.stringify({ issue: db.sqlite.prepare('SELECT * FROM issues').get(), report: db.sqlite.prepare('SELECT * FROM reports').get() });
  for (const secret of ['private-secret', 'private-token', 'private-extension-id', 'alice@example.com', 'Alice']) assert.equal(persisted.includes(secret), false, secret);
  assert.equal(db.sqlite.prepare('SELECT normalized_top_frame FROM issues').get().normalized_top_frame, 'download@extension:///background.js');
  assert.ok(persisted.includes('REDACTED'));
});

test('stores immutable base classifications while updating current canary classification using receipt time', async (t) => {
  const db = createTestDatabase(); t.after(() => db.close());
  const common = { error_category: 'DOM_SELECTOR_MISSING', error_code: 'SELECTOR_NOT_FOUND', error_message: 'Missing collection host', occurred_at: '1970-01-01T00:00:00.000Z' };
  let result;
  for (let index = 1; index <= 3; index++) result = await acceptErrorReport(db, report({ ...common, report_id: uuid(index), install_id: install(index) }), NOW + index);
  assert.equal(result.rule.category, 'UPSTREAM_BREAKING_CHANGE');
  assert.equal(db.sqlite.prepare('SELECT category FROM issues').get().category, 'UPSTREAM_BREAKING_CHANGE');
  assert.deepEqual(db.sqlite.prepare('SELECT DISTINCT category, fault_origin FROM reports').all().map((row) => ({ ...row })), [{ category: 'DOM_SELECTOR_MISSING', fault_origin: 'client_env' }]);
  const later = await acceptErrorReport(db, report({ ...common, report_id: uuid(4), install_id: install(4) }), NOW + 16 * 60 * 1000);
  assert.equal(later.rule.category, 'DOM_SELECTOR_MISSING');
});

test('groups reports independently of versions while separating target destinations', async (t) => {
  const db = createTestDatabase(); t.after(() => db.close());
  const first = await acceptErrorReport(db, report(), NOW);
  const version = await acceptErrorReport(db, report({ report_id: uuid(2), version: '4.0.0' }), NOW + 1);
  const target = await acceptErrorReport(db, report({ report_id: uuid(3), destination: 'vortex' }), NOW + 2);
  assert.equal(first.issueId, version.issueId);
  assert.notEqual(first.issueId, target.issueId);
});

test('regresses only newly accepted versions above the fixed SemVer baseline with one transition event', async (t) => {
  const db = createTestDatabase(); t.after(() => db.close());
  const original = await acceptErrorReport(db, report({ version: '3.1.0' }), NOW);
  db.sqlite.prepare("UPDATE issues SET status = 'fixed', fixed_in_version = '3.2.0' WHERE id = ?").run(original.issueId);
  for (const [index, version] of ['3.1.9', '3.2.0-alpha.2', '3.2.0', '3.2.0+build.4'].entries()) {
    const result = await acceptErrorReport(db, report({ report_id: uuid(index + 2), version }), NOW + index + 1);
    assert.equal(result.regressionEventId, undefined);
  }
  assert.equal(db.sqlite.prepare('SELECT status FROM issues').get().status, 'fixed');
  const newer = await Promise.all(Array.from({ length: 4 }, (_, index) => acceptErrorReport(db,
    report({ report_id: uuid(index + 10), version: '3.2.1' }), NOW + index + 10)));
  assert.equal(newer.filter((result) => result.regressionEventId !== undefined).length, 1);
  const transition = newer.find((result) => result.regressionEventId !== undefined);
  assert.equal(transition.regressionEventId, transition.reportId);
  assert.equal(db.sqlite.prepare('SELECT status FROM issues').get().status, 'regressed');
  db.sqlite.prepare("UPDATE issues SET status = 'fixed', fixed_in_version = '3.1.0'").run();
  const replay = await acceptErrorReport(db, report({ report_id: uuid(10), version: '3.2.1' }), NOW + 50);
  assert.equal(replay.regressionEventId, undefined);
  assert.equal(db.sqlite.prepare('SELECT status FROM issues').get().status, 'fixed');
});

test('heartbeat receipts aggregate immutable deltas per version/date/browser/destination and exact replays do nothing', async (t) => {
  const db = createTestDatabase(); t.after(() => db.close());
  const input = heartbeat();
  const results = await Promise.all(Array.from({ length: 5 }, (_, index) => acceptHeartbeat(db, input, NOW + index)));
  assert.equal(results.filter((result) => result.accepted).length, 1);
  assert.equal(results[0].heartbeatId, input.heartbeat_id);
  await acceptHeartbeat(db, heartbeat({ heartbeat_id: uuid(2), install_id: install(2), attempts_count: 5, success_count: 5, fallback_triggered_count: 1 }), NOW + 10);
  await acceptHeartbeat(db, heartbeat({ heartbeat_id: uuid(3), destination: 'vortex' }), NOW + 11);
  await acceptHeartbeat(db, heartbeat({ heartbeat_id: uuid(4), version: '3.3.0' }), NOW + 12);
  const metrics = db.sqlite.prepare("SELECT * FROM release_metrics WHERE version = '3.2.0' AND destination = 'browser'").get();
  assert.equal(metrics.attempts_count, 15);
  assert.equal(metrics.success_count, 13);
  assert.equal(metrics.fallback_triggered_count, 4);
  assert.equal(metrics.heartbeat_count, 2);
  const before = db.sqlite.prepare('SELECT * FROM release_metrics').all();
  assert.equal((await acceptHeartbeat(db, input, NOW + 100)).accepted, false);
  assert.deepEqual(db.sqlite.prepare('SELECT * FROM release_metrics').all(), before);
  assert.equal(before.length, 3);
});

test('changed heartbeat identities conflict including concurrent inserts without inflating metrics', async (t) => {
  const db = createTestDatabase(); t.after(() => db.close());
  await acceptHeartbeat(db, heartbeat(), NOW);
  for (const change of [{ metric_date: '2026-10-20' }, { version: '3.2.1' }, { browser: 'firefox' }, { destination: 'mo2' }, { attempts_count: 12 }, { success_count: 7 }, { fallback_triggered_count: 4 }]) {
    await assert.rejects(acceptHeartbeat(db, heartbeat(change), NOW + 1), IngestionConflict);
  }
  const race = await Promise.allSettled([
    acceptHeartbeat(db, heartbeat({ heartbeat_id: uuid(2) }), NOW + 2),
    acceptHeartbeat(db, heartbeat({ heartbeat_id: uuid(2), success_count: 7 }), NOW + 2),
  ]);
  assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1);
  assert.ok(race.find((result) => result.status === 'rejected').reason instanceof IngestionConflict);
  assert.equal(db.sqlite.prepare('SELECT heartbeat_count FROM release_metrics').get().heartbeat_count, 2);
  assert.equal((await acceptHeartbeat(db, heartbeat({ install_id: install(2) }), NOW + 3)).accepted, true);
});

test('an older same-millisecond rule evaluation cannot replace a newer canary result', async (t) => {
  const db = createTestDatabase(); t.after(() => db.close());
  const common = { error_category: 'DOM_SELECTOR_MISSING', error_code: 'SELECTOR_NOT_FOUND', error_message: 'Missing collection host' };
  await acceptErrorReport(db, report(common), NOW);
  let resume;
  const gate = new Promise((resolve) => { resume = resolve; });
  let ready;
  const reachedQuery = new Promise((resolve) => { ready = resolve; });
  const pausedDb = {
    ...db,
    prepare(sql) {
      function wrap(statement) {
        return {
          ...statement,
          bind(...values) { return wrap(statement.bind(...values)); },
          async first(...args) {
            const result = await statement.first(...args);
            if (sql.includes('COUNT(DISTINCT install_id)')) { ready(); await gate; }
            return result;
          },
        };
      }
      return wrap(db.prepare(sql));
    },
  };
  const second = acceptErrorReport(pausedDb, report({ ...common, report_id: uuid(2), install_id: install(2) }), NOW);
  await reachedQuery;
  const third = await acceptErrorReport(db, report({ ...common, report_id: uuid(3), install_id: install(3) }), NOW);
  assert.equal(third.rule.category, 'UPSTREAM_BREAKING_CHANGE');
  resume();
  await second;
  assert.equal(db.sqlite.prepare('SELECT category FROM issues').get().category, 'UPSTREAM_BREAKING_CHANGE');
});

test('out-of-order batch completions refresh the current issue at its newest receipt window', async (t) => {
  const db = createTestDatabase(); t.after(() => db.close());
  const common = { error_category: 'DOM_SELECTOR_MISSING', error_code: 'SELECTOR_NOT_FOUND', error_message: 'Missing collection host' };
  await acceptErrorReport(db, report(common), NOW);
  let resume;
  const gate = new Promise((resolve) => { resume = resolve; });
  let ready;
  const committed = new Promise((resolve) => { ready = resolve; });
  const delayedDb = {
    ...db,
    async batch(statements) {
      const result = await db.batch(statements);
      ready();
      await gate;
      return result;
    },
  };
  const latest = acceptErrorReport(delayedDb, report({ ...common, report_id: uuid(3), install_id: install(3) }), NOW + 2);
  await committed;
  const older = await acceptErrorReport(db, report({ ...common, report_id: uuid(2), install_id: install(2) }), NOW + 1);
  assert.equal(older.rule.category, 'DOM_SELECTOR_MISSING');
  resume();
  assert.equal((await latest).rule.category, 'UPSTREAM_BREAKING_CHANGE');
  assert.equal(db.sqlite.prepare('SELECT category FROM issues').get().category, 'UPSTREAM_BREAKING_CHANGE');
});

test('refreshes use the newest retained report classification instead of an older report sharing its fingerprint', async (t) => {
  const db = createTestDatabase(); t.after(() => db.close());
  await acceptErrorReport(db, report(), NOW);
  let resume;
  const gate = new Promise((resolve) => { resume = resolve; });
  let ready;
  const committed = new Promise((resolve) => { ready = resolve; });
  const delayedDb = {
    ...db,
    async batch(statements) {
      const result = await db.batch(statements);
      ready();
      await gate;
      return result;
    },
  };
  const latest = acceptErrorReport(delayedDb, report({ report_id: uuid(3), install_id: install(3), error_message: 'Failed to fetch' }), NOW + 2);
  await committed;
  const older = await acceptErrorReport(db, report({ report_id: uuid(2), install_id: install(2), error_message: 'Missing collection host' }), NOW + 1);
  assert.equal(older.rule.category, 'DOM_SELECTOR_MISSING');
  const intermediate = db.sqlite.prepare('SELECT category, fault_origin FROM issues').get();
  resume();
  await latest;
  assert.equal(intermediate.category, 'NETWORK_UNREACHABLE');
  assert.equal(intermediate.fault_origin, 'client_env');
  assert.equal(db.sqlite.prepare('SELECT category FROM issues').get().category, 'NETWORK_UNREACHABLE');
});

test('accepted reports survive postcommit classification faults with their base delivery context', async (t) => {
  const db = createTestDatabase(); t.after(() => db.close());
  const input = report({ error_category: 'DOM_SELECTOR_MISSING', error_code: 'SELECTOR_NOT_FOUND', error_message: 'Missing collection host' });
  const faultyDb = {
    ...db,
    prepare(sql) {
      if (sql.includes('COUNT(DISTINCT install_id)')) throw new Error('injected postcommit classification failure');
      return db.prepare(sql);
    },
  };
  const result = await acceptErrorReport(faultyDb, input, NOW);
  assert.equal(result.accepted, true);
  assert.equal(result.rule.category, 'DOM_SELECTOR_MISSING');
  assert.equal(result.report.report_id, input.report_id);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM reports').get().n, 1);
});

test('a fixed baseline changed during ingestion is compared again before regression', async (t) => {
  const db = createTestDatabase(); t.after(() => db.close());
  await acceptErrorReport(db, report(), NOW);
  db.sqlite.prepare("UPDATE issues SET status = 'fixed', fixed_in_version = '4.0.0'").run();
  const changingDb = {
    ...db,
    async batch(statements) {
      db.sqlite.prepare("UPDATE issues SET fixed_in_version = '3.1.0'").run();
      return db.batch(statements);
    },
  };
  const result = await acceptErrorReport(changingDb, report({ report_id: uuid(2), version: '3.2.1' }), NOW + 1);
  assert.equal(result.accepted, true);
  assert.equal(result.regressionEventId, uuid(2));
  assert.equal(db.sqlite.prepare('SELECT status FROM issues').get().status, 'regressed');
});

test('heartbeat failures roll back receipts and release totals together', async (t) => {
  const db = createTestDatabase(); t.after(() => db.close());
  db.sqlite.exec("CREATE TRIGGER reject_metrics BEFORE INSERT ON release_metrics BEGIN SELECT RAISE(ABORT, 'injected metrics failure'); END;");
  await assert.rejects(acceptHeartbeat(db, heartbeat(), NOW), /injected metrics failure/);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM heartbeat_receipts').get().n, 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM release_metrics').get().n, 0);
});
````

## diagnostics/test/admin.test.mjs

````javascript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import adminRoutes from '../src/routes/admin.ts';
import { createTestDatabase } from './helpers/d1.mjs';

const NOW = Date.UTC(2026, 9, 21, 12);
const uuid = (n) => `12345678-1234-4234-8234-${n.toString(16).padStart(12, '0')}`;

function fixture(t) {
  const db = createTestDatabase();
  t.after(() => db.close());
  const env = { DB: db, MAX_BODY_BYTES: '65536', VAPID_PUBLIC_KEY: 'public-only', VAPID_PRIVATE_KEY: 'never-disclose', VAPID_SUBJECT: 'mailto:owner@example.org',
    DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwx', PUSH_COOLDOWN_SECONDS: '1800', DETECTION_WINDOW_SECONDS: '900', SPIKE_REPORT_THRESHOLD: '10', DISTINCT_INSTALL_THRESHOLD: '3' };
  const app = new Hono();
  // Authentication is a production parent responsibility. This parent supplies
  // only the trusted server clock; it never introduces a runtime auth bypass.
  app.use('*', async (c, next) => { c.set('serverNow', NOW); await next(); });
  app.route('/api/admin', adminRoutes);
  const request = (path, options = {}) => app.request(`https://diagnostics.example.org/api/admin${path}`, options, env);
  const json = (path, body, method = 'PATCH', headers = {}) => request(path, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { db, env, request, json };
}

function issue(db, overrides = {}) {
  const values = { fingerprint: 'a'.repeat(64), error_category: 'NETWORK', error_code: 'FETCH_FAILED', failure_stage: 'PRIMARY_API_REQUEST', normalized_top_frame: 'fetchFile@main.js', destination: 'browser', category: 'NETWORK_UNREACHABLE', fault_origin: 'client_env', suggested_action: 'Check connection.', first_seen_at: NOW, last_seen_at: NOW, first_seen_version: '3.2.0', last_seen_version: '3.2.0', created_at: NOW, updated_at: NOW, ...overrides };
  const columns = Object.keys(values);
  return Number(db.sqlite.prepare(`INSERT INTO issues (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(values)).lastInsertRowid);
}

function report(db, id, n, overrides = {}) {
  const values = { id: uuid(n), issue_id: id, install_id: (n % 10).toString().repeat(64), version: '3.2.0', browser: 'chrome', browser_version: '144', os: 'windows', download_mode: 'manual', destination: 'browser', severity: 'error', error_category: 'NETWORK', error_code: 'FETCH_FAILED', failure_stage: 'PRIMARY_API_REQUEST', error_name: 'TypeError', error_message: 'Failed to fetch', category: 'NETWORK_UNREACHABLE', fault_origin: 'client_env', suggested_action: 'Check connection.', occurred_at: NOW, created_at: NOW, ...overrides };
  const columns = Object.keys(values);
  db.sqlite.prepare(`INSERT INTO reports (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(values));
}

async function subscription() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return { endpoint: 'https://web.push.apple.com/a-private-subscription-token', expirationTime: null, keys: { p256dh: Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url'), auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url') } };
}

test('empty overview and release comparison use null percentages instead of NaN', async (t) => {
  const { request } = fixture(t);
  const overview = await (await request('/overview')).json();
  assert.equal(overview.issues.total, 0);
  assert.equal(overview.releases.success_rate_percent, null);
  const response = await request('/releases/compare?before=3.1.0&after=3.2.0');
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.before.attempts_count, 0);
  assert.equal(value.before.success_rate_percent, null);
  assert.equal(value.success_rate_delta_pp, null);
});

test('issue report dimensions must match the same report and never multiply issue counts', async (t) => {
  const { db, request } = fixture(t);
  const id = issue(db);
  report(db, id, 1, { version: '3.1.0', browser: 'chrome' });
  report(db, id, 2, { version: '3.2.0', browser: 'firefox', error_message: 'Firefox unique failure' });
  assert.equal((await (await request('/issues?version=3.1.0&browser=firefox')).json()).total, 0);
  assert.equal((await (await request('/issues?browser=chrome&q=Firefox')).json()).total, 0);
  assert.equal((await (await request('/issues?browser=firefox&q=Firefox')).json()).total, 1);
  const value = await (await request('/issues?browser=chrome')).json();
  assert.equal(value.total, 1);
  assert.equal(value.items[0].total_occurrences, 2);
  assert.equal(typeof value.items[0].id, 'number');
});

test('overview applies report dimensions consistently to issues, reports and release metrics', async (t) => {
  const { db, request } = fixture(t);
  const first = issue(db); report(db, first, 1, { browser: 'chrome' });
  const second = issue(db, { fingerprint: 'b'.repeat(64), destination: 'vortex' });
  report(db, second, 2, { browser: 'firefox', destination: 'vortex' });
  const overview = await (await request('/overview?browser=firefox&destination=vortex')).json();
  assert.equal(overview.issues.total, 1);
  assert.equal(overview.reports.total, 1);
});

test('issue queries reject duplicate, unknown, oversized and invalid date parameters and bind SQL search', async (t) => {
  const { db, request } = fixture(t);
  const id = issue(db); report(db, id, 1);
  for (const query of ['page=10001', 'limit=101', 'page=0', 'browser=chrome&browser=firefox', 'sort=anything', 'from=2026-02-30', 'from=2024-01-01&to=2026-01-01', 'from=2026-10-22&to=2026-10-21']) {
    assert.equal((await request(`/issues?${query}`)).status, 400, query);
  }
  const result = await (await request(`/issues?q=${encodeURIComponent("' OR 1=1 --")}`)).json();
  assert.equal(result.total, 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM issues').get().n, 1);
});

test('detail and report pagination expose parsed diagnostic JSON and handle missing numeric IDs', async (t) => {
  const { db, request } = fixture(t);
  const id = issue(db);
  report(db, id, 1, { breadcrumbs_json: '[{"stage":"FETCH","action":"GET","status":"error","timestamp_offset_ms":0}]', dom_state_json: '{"document_ready_state":"complete"}' });
  const detail = await (await request(`/issues/${id}`)).json();
  assert.equal(detail.issue.id, id);
  assert.equal(detail.latest_report.breadcrumbs[0].action, 'GET');
  assert.equal(detail.latest_report.dom_state.document_ready_state, 'complete');
  assert.equal('breadcrumbs_json' in detail.latest_report, false);
  const reports = await (await request(`/issues/${id}/reports?page=2&limit=1`)).json();
  assert.deepEqual(reports, { items: [], total: 1, page: 2, limit: 1 });
  assert.equal((await request('/issues/9999')).status, 404);
  assert.equal((await request('/issues/abc')).status, 400);
});

test('issue lifecycle enforces fixed versions and actual GitHub issue URLs', async (t) => {
  const { db, request, json } = fixture(t);
  const id = issue(db); report(db, id, 1);
  for (const body of [{}, { status: 'fixed' }, { status: 'regressed', fixed_in_version: null }, { fixed_in_version: '3.01.0' }, { extra: true }, { github_issue_url: 'https://github.com.evil.test/owner/repo/issues/1' }, { github_issue_url: 'https://github.com/owner/issues/1' }, { github_issue_url: 'https://github.com/owner/repo/issues/not-a-number' }, { github_issue_url: 'https://github.com/owner/repo/issues/1?token=secret' }]) {
    assert.equal((await json(`/issues/${id}`, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await json(`/issues/${id}`, { status: 'investigating' })).status, 200);
  const response = await json(`/issues/${id}`, { status: 'fixed', fixed_in_version: '3.2.0', muted: true, github_issue_url: 'https://github.com/owner/repo/issues/42' });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.issue.status, 'fixed');
  assert.equal(result.issue.muted, true);
  assert.equal(result.issue.fixed_in_version, '3.2.0');
  assert.equal((await json(`/issues/${id}`, { fixed_in_version: null })).status, 400);
  assert.equal((await request(`/issues/${id}`)).status, 200);
});

test('concurrent lifecycle changes cannot silently overwrite each other', async (t) => {
  const { db, json } = fixture(t);
  const id = issue(db); report(db, id, 1);
  const responses = await Promise.all([
    json(`/issues/${id}`, { status: 'fixed', fixed_in_version: '3.2.0' }),
    json(`/issues/${id}`, { status: 'ignored' })
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
});

test('releases aggregate each version and compare independent filtered percentages', async (t) => {
  const { db, request } = fixture(t);
  const insert = db.sqlite.prepare('INSERT INTO release_metrics (version,metric_date,browser,destination,attempts_count,success_count,fallback_triggered_count,heartbeat_count,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  insert.run('3.1.0', '2026-10-20', 'chrome', 'browser', 100, 80, 20, 1, NOW, NOW);
  insert.run('3.2.0', '2026-10-21', 'chrome', 'browser', 200, 190, 10, 2, NOW, NOW);
  insert.run('3.2.0', '2026-10-21', 'firefox', 'vortex', 10, 0, 0, 1, NOW, NOW);
  const releases = await (await request('/releases?browser=chrome&destination=browser')).json();
  assert.equal(releases.total, 2);
  assert.equal(releases.items.find((item) => item.version === '3.2.0').attempts_count, 200);
  const comparison = await (await request('/releases/compare?before=3.1.0&after=3.2.0&browser=chrome&destination=browser')).json();
  assert.equal(comparison.before.success_rate_percent, 80);
  assert.equal(comparison.after.success_rate_percent, 95);
  assert.equal(comparison.success_rate_delta_pp, 15);
  assert.equal(comparison.fallback_rate_delta_pp, -15);
});

test('push registration validates provider and actual P-256 curve points before writing', async (t) => {
  const { db, json } = fixture(t);
  const input = await subscription();
  for (const invalid of [
    { ...input, endpoint: 'https://push.apple.com.evil.test/key' },
    { ...input, endpoint: 'https://127.0.0.1/key' },
    { ...input, keys: { ...input.keys, p256dh: Buffer.from(new Uint8Array(65).fill(4)).toString('base64url') } },
    { ...input, keys: { ...input.keys, auth: input.keys.auth + '=' } },
    { ...input, expirationTime: NOW - 1 },
    { ...input, unexpected: true }
  ]) assert.equal((await json('/push/subscriptions', invalid, 'POST')).status, 400);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 0);
});

test('push registration upserts and lists only non-secret metadata and public VAPID key', async (t) => {
  const { db, request, json } = fixture(t);
  const input = await subscription();
  const response = await json('/push/subscriptions', input, 'POST', { 'user-agent': 'Browser Authorization=secret owner@example.org C:\\Users\\Thomas\\private' });
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(typeof result.subscription.id, 'number');
  assert.equal(result.subscription.provider, 'apple');
  assert.equal((await json('/push/subscriptions', input, 'POST')).status, 200);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 1);
  const listingResponse = await request('/push/subscriptions');
  const listing = await listingResponse.text();
  for (const secret of [input.endpoint, input.keys.auth, input.keys.p256dh, 'Thomas', 'owner@example.org', 'never-disclose']) assert.equal(listing.includes(secret), false, secret);
  assert.deepEqual(await (await request('/push/config')).json(), { public_key: 'public-only' });
  assert.equal((await request(`/push/subscriptions/${result.subscription.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await request(`/push/subscriptions/${result.subscription.id}`, { method: 'DELETE' })).status, 404);
});

test('subscription capacity is atomic and existing endpoints may rotate at capacity', async (t) => {
  const { db, json } = fixture(t);
  const input = await subscription();
  const insert = db.sqlite.prepare('INSERT INTO push_subscriptions (endpoint,p256dh,auth,created_at,updated_at) VALUES (?,?,?,?,?)');
  for (let n = 0; n < 99; n++) insert.run(`https://web.push.apple.com/${n}`, input.keys.p256dh, input.keys.auth, NOW, NOW);
  const results = await Promise.all([json('/push/subscriptions', { ...input, endpoint: 'https://web.push.apple.com/100' }, 'POST'), json('/push/subscriptions', { ...input, endpoint: 'https://web.push.apple.com/101' }, 'POST')]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 100);
  assert.equal((await json('/push/subscriptions', { ...input, endpoint: 'https://web.push.apple.com/1' }, 'POST')).status, 200);
});

test('test notification reports delivery results through the real encryption and sender', async (t) => {
  const { env, json } = fixture(t);
  const input = await subscription();
  const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  env.VAPID_PUBLIC_KEY = Buffer.from(await crypto.subtle.exportKey('raw', vapid.publicKey)).toString('base64url');
  env.VAPID_PRIVATE_KEY = (await crypto.subtle.exportKey('jwk', vapid.privateKey)).d;
  assert.equal((await json('/push/subscriptions', input, 'POST')).status, 201);
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 201 }));
  const response = await json('/push/test', {}, 'POST');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.state, 'delivered');
  assert.equal(result.delivered, 1);
  assert.equal(result.attempted, 1);
});
````

## diagnostics/test/api.test.mjs

````javascript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/index.ts';
import { bindings, createAccessFixture } from './helpers/access.mjs';
import { createTestDatabase } from './helpers/d1.mjs';

const ORIGIN = 'https://diagnostics.test';
const EXTENSION = `chrome-extension://${'a'.repeat(32)}`;
const uuid = (n) => `12345678-1234-4234-8234-${n.toString(16).padStart(12, '0')}`;
function report(overrides = {}) {
  return { schema_version: 1, consent: 'diagnostics-v1', report_id: uuid(1), install_id: 'a'.repeat(64),
    occurred_at: '2026-10-21T12:00:00.000Z', version: '3.2.0', browser: 'chrome', browser_version: '144',
    os: 'windows', download_mode: 'manual', destination: 'browser', severity: 'error',
    error_category: 'NETWORK', error_code: 'FETCH_FAILED', failure_stage: 'PRIMARY_API_REQUEST',
    error_message: 'Failed to fetch', ...overrides };
}
function heartbeat(overrides = {}) {
  return { schema_version: 1, consent: 'telemetry-v1', heartbeat_id: uuid(1), install_id: 'a'.repeat(64),
    metric_date: '2026-10-21', version: '3.2.0', browser: 'chrome', destination: 'browser',
    attempts_count: 10, success_count: 8, fallback_triggered_count: 3, ...overrides };
}
function fixture(t, overrides = {}) {
  const db = createTestDatabase();
  const pending = [];
  let assetCalls = 0;
  const env = bindings(db, { ASSETS: { async fetch() { assetCalls++; return new Response('private asset', { headers: { 'cache-control': 'public, max-age=3600' } }); } }, ...overrides });
  const context = { waitUntil(promise) { pending.push(promise); }, passThroughOnException() {}, props: {} };
  t.after(async () => { await Promise.allSettled(pending); db.close(); });
  const request = (path, init = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init), env, context);
  const post = (path, value, headers = {}) => request(path, { method: 'POST', headers: {
    origin: EXTENSION, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.10', ...headers
  }, body: JSON.stringify(value) });
  return { db, env, pending, request, post, assetCalls: () => assetCalls };
}

test('public ingest sanitizes before storage and schedules delivery exactly once for retries', async (t) => {
  const { db, pending, post } = fixture(t);
  const input = report({ error_message: 'Failed to fetch Authorization: Bearer private-token',
    stack_trace: 'download@chrome-extension://private-extension/background.js?key=secret:10:20' });
  const accepted = await post('/api/ingest', input);
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { ok: true, report_id: uuid(1), duplicate: false });
  assert.equal(accepted.headers.get('access-control-allow-origin'), EXTENSION);
  assert.equal(pending.length, 1);
  await Promise.all(pending);
  const retry = await post('/api/ingest', input);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).duplicate, true);
  assert.equal(pending.length, 1);
  assert.equal(db.sqlite.prepare('SELECT total_occurrences FROM issues').get().total_occurrences, 1);
  const persisted = JSON.stringify(db.sqlite.prepare('SELECT * FROM reports').all());
  assert.equal(persisted.includes('private-token'), false);
  assert.equal(persisted.includes('private-extension'), false);
  assert.equal(persisted.includes('?key=secret'), false);
});

test('heartbeat accepts one immutable delta and conflicts on altered identity without scheduling delivery', async (t) => {
  const { db, pending, post } = fixture(t);
  assert.equal((await post('/api/heartbeat', heartbeat())).status, 202);
  const replay = await post('/api/heartbeat', heartbeat());
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { ok: true, heartbeat_id: uuid(1), duplicate: true });
  assert.equal((await post('/api/heartbeat', heartbeat({ success_count: 7 }))).status, 409);
  assert.equal(db.sqlite.prepare('SELECT attempts_count FROM release_metrics').get().attempts_count, 10);
  assert.equal(pending.length, 0);
});

test('extension origins, preflight and exact route boundaries are enforced before database writes', async (t) => {
  const { db, request, post } = fixture(t);
  for (const origin of ['', 'null', 'https://www.nexusmods.com', `${EXTENSION}.evil.test`]) {
    assert.equal((await post('/api/ingest', report(), { origin })).status, 403, origin);
  }
  const preflight = await request('/api/ingest', { method: 'OPTIONS', headers: { origin: EXTENSION,
    'access-control-request-method': 'POST', 'access-control-request-headers': 'Content-Type' } });
  assert.equal(preflight.status, 204);
  assert.equal((await request('/api/ingest', { headers: { origin: EXTENSION } })).status, 405);
  assert.equal((await post('/api/ingest/extra', report())).status, 401);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM reports').get().n, 0);
});

test('invalid JSON/schema and raw body overflow return safe readable public errors', async (t) => {
  const { request, post, db } = fixture(t);
  assert.equal((await post('/api/ingest', { ...report(), consent: undefined })).status, 400);
  const headers = { origin: EXTENSION, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.11' };
  assert.equal((await request('/api/ingest', { method: 'POST', headers, body: '{broken' })).status, 400);
  const large = await request('/api/ingest', { method: 'POST', headers: { ...headers, 'content-length': '2' }, body: `${' '.repeat(65536)}{}` });
  assert.equal(large.status, 413);
  assert.equal(large.headers.get('access-control-allow-origin'), EXTENSION);
  assert.equal((await request('/api/heartbeat', { method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM reports').get().n, 0);
});

test('public install limits return Retry-After and store HMAC subjects without raw IPs', async (t) => {
  const { post, db } = fixture(t, { INGEST_INSTALL_LIMIT: '1' });
  assert.equal((await post('/api/ingest', report())).status, 202);
  const limited = await post('/api/ingest', report({ report_id: uuid(2) }));
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  const buckets = JSON.stringify(db.sqlite.prepare('SELECT * FROM rate_limit_buckets').all());
  assert.equal(buckets.includes('203.0.113.10'), false);
  assert.equal(buckets.includes('a'.repeat(64)), false);
});

test('all admin, unknown API and static paths require genuine signed Access assertions', async (t) => {
  const access = await createAccessFixture(t);
  const { request, assetCalls } = fixture(t);
  for (const path of ['/', '/app.js', '/sw.js', '/api/admin/overview', '/api/unknown']) {
    assert.equal((await request(path)).status, 401, path);
  }
  assert.equal(assetCalls(), 0);
  const headers = await access.headers();
  assert.equal((await request('/api/admin/overview', { headers })).status, 200);
  const asset = await request('/', { headers });
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), 'private asset');
  assert.equal(asset.headers.get('cache-control'), 'no-store');
  assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await request('/api/unknown', { headers })).status, 404);
  assert.equal(assetCalls(), 1);
});

test('forged, expired, wrong-audience and cookie-only assertions fail closed', async (t) => {
  const access = await createAccessFixture(t);
  const { request } = fixture(t);
  const signed = await access.token();
  const forgedParts = signed.split('.');
  const claims = JSON.parse(Buffer.from(forgedParts[1], 'base64url').toString());
  forgedParts[1] = Buffer.from(JSON.stringify({ ...claims, sub: 'forged-user' })).toString('base64url');
  for (const token of [forgedParts.join('.'), await access.token({ exp: 1 }), await access.token({ aud: ['wrong-audience'] })]) {
    assert.equal((await request('/api/admin/overview', { headers: { 'cf-access-jwt-assertion': token } })).status, 401);
  }
  assert.equal((await request('/', { headers: { cookie: `CF_Authorization=${signed}` } })).status, 401);
});

test('protected mutations require same Origin and push tests are capped per verified identity', async (t) => {
  const access = await createAccessFixture(t);
  const { request } = fixture(t);
  const headers = await access.headers({ 'content-type': 'application/json' });
  for (const origin of [undefined, 'https://attacker.test']) {
    const supplied = origin ? { ...headers, origin } : headers;
    assert.equal((await request('/api/admin/push/test', { method: 'POST', headers: supplied, body: '{}' })).status, 403);
  }
  const sameOrigin = { ...headers, origin: ORIGIN };
  assert.equal((await request('/api/admin/push/test', { method: 'POST', headers: sameOrigin, body: '{}' })).status, 200);
  const limited = await request('/api/admin/push/test', { method: 'POST', headers: sameOrigin, body: '{}' });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

test('accepted response does not await Discord HTTP and provider failure cannot undo persistence', async (t) => {
  let finish;
  const blocked = new Promise((resolve) => { finish = resolve; });
  t.after(() => finish());
  t.mock.method(globalThis, 'fetch', async () => { await blocked; return new Response(null, { status: 503 }); });
  const { post, pending, db } = fixture(t, { DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwx' });
  const response = await post('/api/ingest', report());
  assert.equal(response.status, 202);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM reports').get().n, 1);
  assert.equal(pending.length, 1);
  finish();
  await Promise.all(pending);
  assert.equal(db.sqlite.prepare('SELECT total_occurrences FROM issues').get().total_occurrences, 1);
});

test('persistence failure returns generic service error without logging SQL or unsanitized report text', async (t) => {
  const { post, db, pending } = fixture(t);
  const logs = [];
  t.mock.method(console, 'error', (...values) => logs.push(values));
  db.sqlite.exec("CREATE TRIGGER reject_api_report BEFORE INSERT ON reports BEGIN SELECT RAISE(ABORT, 'private-SQL-failure'); END;");
  const response = await post('/api/ingest', report({ error_message: 'Authorization: Bearer private-report-secret' }));
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.equal(text.includes('private-'), false);
  assert.equal(JSON.stringify(logs).includes('private-'), false);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM issues').get().n, 0);
  assert.equal(pending.length, 0);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
````

## diagnostics/test/notifications.test.mjs

````javascript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestDatabase } from './helpers/d1.mjs';
import { errorReportSchema } from '../src/schemas/ingest.ts';
import {
  reservePushNotification, completePushNotification, releasePushNotification,
  sendIssueNotifications, sendTestNotification
} from '../src/services/notifications.ts';

const NOW = Date.UTC(2026, 9, 21, 12);
const fingerprint = 'a'.repeat(64);
const rule = { category: 'NETWORK_UNREACHABLE', fault_origin: 'client_env', suggested_action: 'Check the connection.', upstream_breaking_change: false, structural_category: null };
const uuid = (n) => `12345678-1234-4234-8234-${n.toString(16).padStart(12, '0')}`;

function database(t) {
  t.mock.method(Date, 'now', () => NOW);
  const db = createTestDatabase();
  t.after(() => db.close());
  return db;
}

function issue(db, overrides = {}) {
  const values = {
    fingerprint, error_category: 'NETWORK', error_code: 'FETCH_FAILED', failure_stage: 'PRIMARY_API_REQUEST', normalized_top_frame: 'fetchFile@content/main.js', destination: 'browser',
    category: rule.category, fault_origin: rule.fault_origin, suggested_action: rule.suggested_action,
    first_seen_at: NOW, last_seen_at: NOW, first_seen_version: '3.2.0', last_seen_version: '3.2.0', created_at: NOW, updated_at: NOW,
    ...overrides
  };
  const keys = Object.keys(values);
  return Number(db.sqlite.prepare(`INSERT INTO issues (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(values)).lastInsertRowid);
}

function report(db, issueId, n = 1, overrides = {}, createdAt = NOW) {
  const value = errorReportSchema.parse({
    schema_version: 1, consent: 'diagnostics-v1', report_id: uuid(n), install_id: String((n % 3) + 1).repeat(64), occurred_at: new Date(NOW).toISOString(),
    version: '3.2.0', browser: 'chrome', browser_version: '144.0', os: 'windows', download_mode: 'auto', destination: 'browser', severity: 'error',
    error_category: 'NETWORK', error_code: 'FETCH_FAILED', failure_stage: 'PRIMARY_API_REQUEST', error_name: 'TypeError', error_message: 'Failed to fetch', ...overrides
  });
  db.sqlite.prepare(`INSERT INTO reports (id,issue_id,install_id,version,browser,browser_version,os,download_mode,destination,severity,error_category,error_code,failure_stage,error_name,error_message,category,fault_origin,suggested_action,occurred_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    value.report_id, issueId, value.install_id, value.version, value.browser, value.browser_version, value.os, value.download_mode, value.destination, value.severity,
    value.error_category, value.error_code, value.failure_stage, value.error_name, value.error_message, rule.category, rule.fault_origin, rule.suggested_action, NOW, createdAt
  );
  return value;
}

const claimInput = (issueId, overrides = {}) => ({ issueId, trigger: 'NEW_CRITICAL', dedupeKey: 'initial', now: NOW, cooldownMs: 1_800_000, leaseMs: 30_000, ...overrides });

test('atomic claims admit one concurrent event and block competing normal triggers', async (t) => {
  const db = database(t);
  const id = issue(db);
  const claims = await Promise.all(Array.from({ length: 8 }, () => reservePushNotification(db, claimInput(id))));
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(await reservePushNotification(db, claimInput(id, { trigger: 'SPIKE_DETECTED', dedupeKey: 'spike' })), null);
});

test('ignored and muted issues cannot reserve push delivery', async (t) => {
  const db = database(t);
  const id = issue(db, { muted: 1 });
  assert.equal(await reservePushNotification(db, claimInput(id)), null);
  db.sqlite.prepare("UPDATE issues SET muted=0,status='ignored' WHERE id=?").run(id);
  assert.equal(await reservePushNotification(db, claimInput(id)), null);
});

test('successful delivery records cooldown and delivered event identity only once', async (t) => {
  const db = database(t);
  const id = issue(db);
  const claim = await reservePushNotification(db, claimInput(id));
  assert.equal(await completePushNotification(db, claim, NOW + 1), true);
  assert.equal(db.sqlite.prepare('SELECT last_pushed_at FROM issues WHERE id=?').get(id).last_pushed_at, NOW + 1);
  assert.equal(await completePushNotification(db, claim, NOW + 2), false);
  assert.equal(await reservePushNotification(db, claimInput(id, { now: NOW + 2000, trigger: 'SPIKE_DETECTED', dedupeKey: 'later' })), null);
  assert.equal(await reservePushNotification(db, claimInput(id, { now: NOW + 1_800_002, trigger: 'NEW_CRITICAL' })), null);
});

test('failed delivery releases the lease without starting cooldown', async (t) => {
  const db = database(t);
  const id = issue(db);
  const claim = await reservePushNotification(db, claimInput(id));
  assert.equal(await releasePushNotification(db, claim), true);
  assert.equal(db.sqlite.prepare('SELECT last_pushed_at FROM issues WHERE id=?').get(id).last_pushed_at, null);
  assert.ok(await reservePushNotification(db, claimInput(id, { now: NOW + 1 })));
});

test('expired lease owners cannot complete or release a new owner reservation', async (t) => {
  const db = database(t);
  const id = issue(db);
  const old = await reservePushNotification(db, claimInput(id));
  const current = await reservePushNotification(db, claimInput(id, { now: NOW + 30_001 }));
  assert.notEqual(old.lease_token, current.lease_token);
  assert.equal(await completePushNotification(db, old, NOW + 30_002), false);
  assert.equal(await releasePushNotification(db, old), false);
  assert.equal(await completePushNotification(db, current, NOW + 30_003), true);
});

test('regression transitions bypass cooldown once but require a regressed issue', async (t) => {
  const db = database(t);
  const id = issue(db, { last_pushed_at: NOW, status: 'fixed', fixed_in_version: '3.2.0' });
  const input = claimInput(id, { trigger: 'REGRESSION', dedupeKey: uuid(9), now: NOW + 1 });
  assert.equal(await reservePushNotification(db, input), null);
  db.sqlite.prepare("UPDATE issues SET status='regressed' WHERE id=?").run(id);
  const claim = await reservePushNotification(db, input);
  assert.ok(claim);
  await completePushNotification(db, claim, NOW + 2);
  assert.equal(await reservePushNotification(db, { ...input, now: NOW + 3 }), null);
});

async function configuration(db) {
  const vapidPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const vapidPublic = await crypto.subtle.exportKey('raw', vapidPair.publicKey);
  const vapidPrivate = await crypto.subtle.exportKey('jwk', vapidPair.privateKey);
  const clientPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const clientPublic = await crypto.subtle.exportKey('raw', clientPair.publicKey);
  db.sqlite.prepare('INSERT INTO push_subscriptions (endpoint,p256dh,auth,created_at,updated_at) VALUES (?,?,?,?,?)').run(
    'https://web.push.apple.com/test-subscription', Buffer.from(clientPublic).toString('base64url'), Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url'), NOW, NOW
  );
  return { dashboardOrigin: 'https://diagnostics.example.org', discordWebhookUrl: 'https://discord.com/api/webhooks/123456789012345678/test-token-abcdefghijklmnopqrstuvwxyz', vapid: { publicKey: Buffer.from(vapidPublic).toString('base64url'), privateKey: vapidPrivate.d, subject: 'mailto:owner@example.org' } };
}

test('new critical reports relay to Discord and send encrypted push after persistence', async (t) => {
  const db = database(t);
  const id = issue(db);
  const value = report(db, id);
  const config = await configuration(db);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => { requests.push(new Request(url, init)); return new Response(null, { status: 201 }); });
  const result = await sendIssueNotifications(db, { issueId: id, report: value, rule, isNewIssue: true, now: NOW }, config);
  assert.equal(result.discord.ok, true);
  assert.equal(result.push.state, 'delivered');
  assert.equal(result.push.trigger, 'NEW_CRITICAL');
  assert.equal(result.push.delivered, 1);
  assert.equal(requests.filter((request) => new URL(request.url).hostname === 'web.push.apple.com').length, 1);
  assert.equal(db.sqlite.prepare('SELECT last_pushed_at FROM issues WHERE id=?').get(id).last_pushed_at, NOW);
});

test('out-of-order receipt timestamps cannot hide the third-install upstream alert', async (t) => {
  const db = database(t);
  const id = issue(db);
  const structural = { ...rule, category: 'DOM_SELECTOR_MISSING', structural_category: 'DOM_SELECTOR_MISSING' };
  const fields = { severity: 'warning', error_category: 'DOM_SELECTOR_MISSING', error_code: 'SELECTOR_NOT_FOUND', error_message: 'Missing collection host' };
  const config = await configuration(db);
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 201 }));
  report(db, id, 1, fields, NOW);
  const newer = report(db, id, 3, fields, NOW + 2);
  const initial = await sendIssueNotifications(db, { issueId: id, report: newer, rule: structural, isNewIssue: false, now: NOW + 2 }, config);
  assert.equal(initial.push.state, 'suppressed');
  const delayed = report(db, id, 2, fields, NOW + 1);
  const result = await sendIssueNotifications(db, { issueId: id, report: delayed, rule: structural, isNewIssue: false, now: NOW + 1 }, config);
  assert.equal(result.push.trigger, 'UPSTREAM_CHANGE');
  assert.equal(result.push.state, 'delivered');
  assert.equal(db.sqlite.prepare('SELECT last_pushed_at FROM issues WHERE id=?').get(id).last_pushed_at, NOW + 2);
});

test('spikes require ten recent server receipts across three distinct installations', async (t) => {
  const db = database(t);
  const id = issue(db);
  let value;
  for (let i = 1; i <= 10; i++) value = report(db, id, i);
  const config = await configuration(db);
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 201 }));
  const result = await sendIssueNotifications(db, { issueId: id, report: value, rule, isNewIssue: false, now: NOW }, config);
  assert.equal(result.push.trigger, 'SPIKE_DETECTED');
  assert.equal(result.push.state, 'delivered');
});

test('old receipts and repeated installations cannot manufacture a spike', async (t) => {
  const db = database(t);
  const id = issue(db);
  let value;
  for (let i = 1; i <= 12; i++) value = report(db, id, i, { install_id: '1'.repeat(64) }, i <= 5 ? NOW - 900_001 : NOW);
  const config = await configuration(db);
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 201 }));
  const result = await sendIssueNotifications(db, { issueId: id, report: value, rule, isNewIssue: false, now: NOW }, config);
  assert.equal(result.push.trigger, null);
  assert.equal(result.push.state, 'suppressed');
  assert.equal(result.discord.ok, true);
});

test('regression sends high priority only for a newer release and an explicit transition identity', async (t) => {
  const db = database(t);
  const id = issue(db, { status: 'regressed', fixed_in_version: '3.2.0', last_pushed_at: NOW });
  const value = report(db, id, 1, { version: '3.2.1' });
  const config = await configuration(db);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => { requests.push(new Request(url, init)); return new Response(null, { status: 201 }); });
  const result = await sendIssueNotifications(db, { issueId: id, report: value, rule, isNewIssue: false, regressionEventId: value.report_id, now: NOW + 1 }, config);
  assert.equal(result.push.trigger, 'REGRESSION');
  assert.equal(requests.find((request) => new URL(request.url).hostname === 'web.push.apple.com').headers.get('urgency'), 'high');
});

test('provider expiry deletes only the rejected subscription and leaves push cooldown untouched', async (t) => {
  const db = database(t);
  const id = issue(db);
  const value = report(db, id);
  const config = await configuration(db);
  t.mock.method(globalThis, 'fetch', async (url) => new Response(null, { status: new URL(url).hostname === 'web.push.apple.com' ? 410 : 201 }));
  const result = await sendIssueNotifications(db, { issueId: id, report: value, rule, isNewIssue: true, now: NOW }, config);
  assert.equal(result.push.expired, 1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 0);
  assert.equal(db.sqlite.prepare('SELECT last_pushed_at FROM issues WHERE id=?').get(id).last_pushed_at, null);
});

test('test notifications reach subscriptions without creating issues, claims, or Discord messages', async (t) => {
  const db = database(t);
  const config = await configuration(db);
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => { urls.push(String(url)); return new Response(null, { status: 201 }); });
  const result = await sendTestNotification(db, config, NOW);
  assert.equal(result.delivered, 1);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^https:\/\/web\.push\.apple\.com\//);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM issues').get().n, 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM notification_claims').get().n, 0);
});

test('push bookkeeping failure does not reject or abandon the Discord delivery promise', async (t) => {
  const db = database(t);
  const id = issue(db);
  const value = report(db, id);
  const config = await configuration(db);
  const originalPrepare = db.prepare.bind(db);
  t.mock.method(db, 'prepare', (sql) => {
    if (sql.includes('COUNT(DISTINCT install_id)')) throw new Error('D1 temporarily unavailable');
    return originalPrepare(sql);
  });
  let discordCompleted = false;
  t.mock.method(globalThis, 'fetch', async () => {
    await new Promise((resolve) => setImmediate(resolve));
    discordCompleted = true;
    return new Response(null, { status: 201 });
  });
  const result = await sendIssueNotifications(db, { issueId: id, report: value, rule, isNewIssue: true, now: NOW }, config);
  assert.equal(discordCompleted, true);
  assert.equal(result.discord.ok, true);
  assert.equal(result.push.state, 'failed');
  assert.equal(result.push.retryable, true);
});

test('all failed push requests release the event while preserving Discord success', async (t) => {
  const db = database(t);
  const id = issue(db);
  const value = report(db, id);
  const config = await configuration(db);
  t.mock.method(globalThis, 'fetch', async (url) => new Response(null, { status: new URL(url).hostname === 'web.push.apple.com' ? 503 : 201, headers: { 'Retry-After': '10' } }));
  const result = await sendIssueNotifications(db, { issueId: id, report: value, rule, isNewIssue: true, now: NOW }, config);
  assert.equal(result.discord.ok, true);
  assert.equal(result.push.state, 'failed');
  assert.equal(result.push.retryable, true);
  assert.equal(db.sqlite.prepare('SELECT last_pushed_at FROM issues WHERE id=?').get(id).last_pushed_at, null);
  assert.equal(db.sqlite.prepare('SELECT lease_token FROM notification_claims WHERE issue_id=?').get(id).lease_token, null);
});

test('structural canaries require three current installations and obey issue muting', async (t) => {
  const db = database(t);
  const id = issue(db);
  let value;
  for (let i = 1; i <= 3; i++) value = report(db, id, i);
  const config = await configuration(db);
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 201 }));
  const structural = { ...rule, category: 'UPSTREAM_BREAKING_CHANGE', fault_origin: 'upstream_site', structural_category: 'DOM_SELECTOR_MISSING', upstream_breaking_change: true };
  const result = await sendIssueNotifications(db, { issueId: id, report: value, rule: structural, isNewIssue: false, now: NOW }, config);
  assert.equal(result.push.trigger, 'UPSTREAM_CHANGE');
  assert.equal(result.push.delivered, 1);
  db.sqlite.prepare('UPDATE issues SET muted=1 WHERE id=?').run(id);
  const muted = await sendIssueNotifications(db, { issueId: id, report: value, rule: structural, isNewIssue: false, now: NOW }, config);
  assert.equal(muted.push.state, 'suppressed');
  assert.equal(muted.discord.ok, true);
});

test('nine reports or only two distinct installations remain below the spike threshold', async (t) => {
  for (const [count, distinct] of [[9, 3], [10, 2]]) {
    const db = createTestDatabase();
    try {
      const id = issue(db);
      let value;
      for (let i = 1; i <= count; i++) value = report(db, id, i, { install_id: String((i % distinct) + 1).repeat(64) });
      const config = await configuration(db);
      t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 201 }));
      const result = await sendIssueNotifications(db, { issueId: id, report: value, rule, isNewIssue: false, now: NOW }, config);
      assert.equal(result.push.state, 'suppressed');
      assert.equal(result.push.trigger, null);
    } finally { db.close(); }
  }
});

test('subscription cleanup errors cannot orphan in-flight sends or discard partial-delivery cooldown', async (t) => {
  const db = database(t);
  const id = issue(db);
  const value = report(db, id);
  const config = await configuration(db);
  db.sqlite.exec("INSERT INTO push_subscriptions (endpoint,p256dh,auth,created_at,updated_at) SELECT endpoint || '-other',p256dh,auth,created_at,updated_at FROM push_subscriptions");
  const originalPrepare = db.prepare.bind(db);
  t.mock.method(db, 'prepare', (sql) => {
    if (sql.startsWith('DELETE FROM push_subscriptions')) throw new Error('Cleanup temporarily unavailable');
    return originalPrepare(sql);
  });
  let accepted = false;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (new URL(url).hostname === 'discord.com') return new Response(null, { status: 201 });
    if (String(url).endsWith('-other')) {
      await new Promise((resolve) => setImmediate(resolve));
      accepted = true;
      return new Response(null, { status: 201 });
    }
    return new Response(null, { status: 410 });
  });
  const result = await sendIssueNotifications(db, { issueId: id, report: value, rule, isNewIssue: true, now: NOW }, config);
  assert.equal(accepted, true);
  assert.equal(result.push.state, 'partial');
  assert.equal(result.push.delivered, 1);
  assert.equal(result.push.expired, 1);
  assert.equal(db.sqlite.prepare('SELECT last_pushed_at FROM issues WHERE id=?').get(id).last_pushed_at, NOW);
  assert.equal(db.sqlite.prepare('SELECT delivered_at FROM notification_claims WHERE issue_id=?').get(id).delivered_at, NOW);
});
````

## diagnostics/README.md

````markdown
# Diagnostics system: Phases 1–3

This independent package contains the configuration, schema, privacy and delivery services, and the Phase 3 Hono API server for the private diagnostics system. The existing extension and deployed `../relay/` keep their current contracts.

The Worker API is implemented. The PWA belongs to Phase 4 and has not been added. Deployment requires your real domain, Cloudflare Access application, D1 database, and secret bindings; no remote deployment has been performed.

## Directory structure

```text
diagnostics/
  .gitignore
  README.md
  package.json
  package-lock.json
  tsconfig.json
  wrangler.toml
  schema.sql
  examples/
    send-report.ts
  public/
    .assetsignore
  src/
    index.ts
    http/
      types.ts
      config.ts
      security.ts
    routes/
      admin.ts
    schemas/
      ingest.ts
    utils/
      sanitize.ts
      fingerprint.ts
    services/
      ruleEngine.ts
      delivery.ts
      notifications.ts
      ingestion.ts
  test/
    helpers/
      d1.mjs
      access.mjs
    admin.test.mjs
    api.test.mjs
    delivery.test.mjs
    example.test.mjs
    fingerprint.test.mjs
    ingest.test.mjs
    ingestion.test.mjs
    notifications.test.mjs
    ruleEngine.test.mjs
    sanitize.test.mjs
    schema.test.mjs
    security.test.mjs
```

`npm run cf:types` generates the ignored `worker-configuration.d.ts`. Dependencies and local database state live in ignored `node_modules/` and `.wrangler/` directories.

The remaining requested files will be added only in their authorized phase:

```text
diagnostics/
  public/
    index.html                    Phase 4
    app.js                        Phase 4
    sw.js                         Phase 4
    manifest.json                 Phase 4
```

## Installation and local verification

Use Node.js 24 or newer. The tests use Node's built-in test runner, native TypeScript stripping, and SQLite; these development APIs are never imported into the Worker. The runtime schemas and extension example use the requested libraries and standard Web APIs.

Run from this directory:

```powershell
npm ci
npm run check
npm run cf:types
npm run db:init:local
```

`schema.sql` is the canonical initial schema. It uses idempotent creation statements and can initialize an empty local D1 database. Later schema changes require explicit migrations; reapplying this file does not modify existing table definitions. Do not wrap it in `BEGIN`/`COMMIT`: D1 manages its own transactions.

## Configuration and secrets

All seven runtime dependencies requested in the brief are pinned in `package.json`, with a committed npm lockfile. `wrangler.toml` declares `DB` and `ASSETS`, uses the current compatibility date, and enables `run_worker_first = true` for every static asset. No Node compatibility flag is enabled.

`workers_dev = false` and `preview_urls = false` avoid alternative public URLs. Configure the real custom domain and Access application before publishing the server/dashboard in their later phases. No domain, account ID, database UUID, webhook, or VAPID key is invented here. D1's ID is omitted using Wrangler's supported automatic provisioning; the resource is created only when an authorized deployment actually runs. To use a pre-created database instead, set the real `database_id` returned by Cloudflare under `[[d1_databases]]`.

The following runtime environment names are declared in `[secrets].required`; their values stay outside source control. Account-specific public settings also use secret bindings so that configuration has no fake values:

| Binding | Value |
| --- | --- |
| `VAPID_PUBLIC_KEY` | Base64url P-256 application-server public key |
| `VAPID_PRIVATE_KEY` | Matching base64url P-256 private key |
| `VAPID_SUBJECT` | Your actual `mailto:` contact or HTTPS contact URL |
| `DISCORD_WEBHOOK_URL` | Your private Discord incoming webhook URL |
| `CF_ACCESS_TEAM_DOMAIN` | Your actual team hostname ending in `.cloudflareaccess.com`; Phase 3 extracts the team name expected by the middleware |
| `CF_ACCESS_AUD` | The audience tag for the private Access application |
| `RATE_LIMIT_HASH_SECRET` | A separately generated random secret for HMAC hashing IP rate-limit subjects |

For local development, put the real values in an ignored `.dev.vars` file beside `wrangler.toml`. Before a later deployment, set the same names through Cloudflare's encrypted secret configuration. For example, Wrangler's interactive commands are:

```powershell
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT
npx wrangler secret put DISCORD_WEBHOOK_URL
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN
npx wrangler secret put CF_ACCESS_AUD
npx wrangler secret put RATE_LIMIT_HASH_SECRET
```

These commands are setup instructions for a later deployment; none were run during Phase 1. `secret put` can create/deploy a Worker version, so use the dashboard or the appropriate version workflow when coordinating an existing deployment. Never paste secret values into shell command arguments or commit `.dev.vars`.

The Access application must protect the dashboard and `/api/admin/*`; only the exact public ingest and heartbeat paths may bypass the edge login challenge. The Worker verifies the Access JWT's signature, issuer, audience, expiry, not-before and issued-at claims using `@hono/cloudflare-access` before serving protected APIs or assets. Configure Access to forward `Cf-Access-Jwt-Assertion`; a `CF_Authorization` cookie alone is rejected. Configure the permitted owner identity and required MFA/passkey policy in Access. Extension-origin CORS is a browser boundary, not client authentication.

## Payload contract

`src/schemas/ingest.ts` exports `errorReportSchema`, `heartbeatSchema`, their input/output types, reusable dimension schemas, and the fixed `MAX_BODY_BYTES = 65_536` limit. Objects reject unknown properties. No numeric coercion is used.

Error reports require explicit `consent: "diagnostics-v1"`; heartbeats require separate `consent: "telemetry-v1"`. These declarations are an ingestion contract, not proof of consent: the extension must read its actual opt-in setting before preparing, queuing, and sending data. The legacy automatic-error-report preference does not automatically authorize heartbeat telemetry.

Create a cryptographically random installation seed in extension-local storage only after consent. Send only its lowercase SHA-256 digest as `install_id`. Never hash an email, account ID, username, Nexus API key, or hardware/browser fingerprint. This pseudonymous identifier counts installations, not people. Clear queued data on opt-out and delete the seed when resetting diagnostics identity; keep it stable across ordinary retries and extension updates.

Versions use full SemVer, including valid prereleases/build metadata, with safe numeric precedence components. Client `occurred_at` values must be real UTC dates on or after the Unix epoch in the canonical `YYYY-MM-DDTHH:mm:ss.sssZ` format. Daily `metric_date` values use actual UTC calendar dates. These client timestamps never determine spike or canary windows.

Browser families are `chrome`, `edge`, `firefox`, `safari`, `opera`, `brave`, or `other`. Operating systems are `windows`, `macos`, `linux`, `android`, `ios`, `chromeos`, or `other`. Destinations are `browser`, `vortex`, or `mo2`; download modes are `manual` or `auto`. Browser/OS versions are separate bounded fields rather than full user agents.

Reports carry original `error_category`, `error_code`, and `failure_stage`. The server computes normalized frames, fingerprints, derived classification, and suggested actions. Clients cannot supply issue status, fault origin, fingerprint, classification, server timestamps, or notification decisions.

Breadcrumbs are nondecreasing offsets from the start of the operation, with at most 80 entries. Optional durations are elapsed milliseconds. HTTP statuses must be integers from 100 through 599. Metadata allows finite JSON values with at most three container levels including the root record, 32 keys per object, 16 items per array, 48 characters per key, and 1,024 characters per string. Dangerous prototype keys are rejected before record parsing. DOM state contains readiness, selector match summaries, and optional API schema field summaries; it cannot contain arbitrary HTML or headers.

The explicit `context.api_endpoint` must be HTTPS and contain no credentials, query string, or fragment. All validated strings and metadata remain untrusted: call the Phase 2 sanitizer before persistence, logging, or forwarding. Fingerprinting also sanitizes its emitted frames and grouping dimensions. Schema validation alone does not sanitize diagnostic text.

The schema checks UTF-8 bytes of the parsed representation. The API also counts the actual request stream before JSON parsing, capped at 65,536 bytes without trusting `Content-Length`. This catches oversized whitespace and chunked payloads. It accepts UTF-8 `application/json` and rejects content encodings. Valid client event dates can be backfilled; server receipt time alone drives rate, spike and canary decisions. Heartbeat receipts must be retained while their historical aggregates are retained.

## Database write contract

All SQL timestamps use integer UTC epoch milliseconds. The Worker supplies `created_at` from its own clock and converts validated `occurred_at` to epoch milliseconds. Spike queries use server `created_at`. Rule classification snapshots belong on reports; issue classification is the current summary. Original fingerprint inputs remain separate when an upstream canary changes the derived category.

Map payload `report_id` to `reports.id`. The schemas normalize UUIDs to lowercase before persistence so casing cannot create a second retry identity. Store the sanitized breadcrumbs, DOM state, and context as JSON strings; omit optional scalar fields as SQL `NULL`. Issue IDs are database-generated integers. Use bound parameters for every user value and atomic D1 batches for related writes.

Use targeted conflict handling for immutable request identities. `ON CONFLICT(id) DO NOTHING` is suitable for a report retry; broad `INSERT OR IGNORE` can hide unrelated constraint failures. Never `INSERT OR REPLACE` an issue, since replacement can cascade-delete its children. The insertion triggers, not application-side read/increment sequences, own occurrence counts, distinct installation membership, observation times, and release rollups.

`total_occurrences` and `affected_installs_count` are lifetime counters. Detailed reports can be purged without reducing these counters. Retain issue memberships and report receipt tombstones for the issue's lifetime so replaying an old report cannot inflate them. Deleting an issue intentionally deletes its associated data and deduplication history.

Heartbeat counters are immutable **deltas**, grouped by UTC date, version, browser, and destination. One logical batch gets one `heartbeat_id`, retained with its exact body for retries. Never resend daily cumulative totals as fresh batches. `success_count` and `fallback_triggered_count` must each be at most `attempts_count`; they can overlap because a successful attempt can use a fallback. `heartbeat_receipts` preserve retry identities and atomically roll up each accepted delta once. Keep receipts for the lifetime of the aggregate until a bounded historical acceptance policy is implemented. The API must reject reuse of an ID with altered contents.

`status` is one of `new`, `investigating`, `fixed`, `regressed`, or `ignored`. Independent `muted` state suppresses notifications without losing workflow state. Fixed and regressed issues require `fixed_in_version`; chronological first/last observed versions must never be calculated using SQL text `MIN`/`MAX`. Phase 3 uses `compare-versions` for regression decisions.

Rate-limit buckets store HMAC subject hashes, scope, window, count, and expiry; no raw IP column exists. Include the exact route and scope in the HMAC input, encoded as an unambiguous tuple, to keep ingest and heartbeat limits separate. Notification claims support unique event identities and bounded delivery leases so concurrent ingests can reserve delivery atomically. `last_pushed_at` describes successful delivery, not merely a reservation. Push endpoints and subscription keys are private credentials accessible only through protected admin paths.

## Extension example

`examples/send-report.ts` contains complete `prepareExampleReport()` and `sendPreparedReport()` functions. The caller supplies its real relay origin, persisted random installation seed, release/browser/OS values, and current consent. Preparing generates one report identity and a SHA-256 installation hash; the returned immutable object is reused for retries. Sending checks current consent, omits credentials, rejects redirects, and applies a ten-second timeout. It holds no webhook, Access token, or VAPID private key.

The example is TypeScript intended for the extension's build/background context and imports the shared Zod schema. It is not injected into the existing dependency-free extension in this phase. A later integration must add the actual relay origin to extension host permissions and map real events to the schema. Run network delivery from the extension context rather than the Nexus page's origin.

## Phase boundary and operational limits

No remote resources, secrets, extension preferences, or Access policies were created or changed. Delivery tests use generated local keys and mocked HTTP boundaries. The server is implemented through Phase 3; dashboard HTML, JavaScript, service worker and manifest await Phase 4. The tracked `.assetsignore` excludes hidden files and lets Wrangler package the currently empty assets directory.

The requested sub-50 ms ingest response is a performance target to measure after the complete D1 path exists, not a guarantee Phase 1 can establish. `waitUntil()` moves delivery out of the response path but is not a durable delivery queue; later delivery code must describe and handle its failure semantics.

## Phase 2 service contracts

| Module | Exports and behavior |
| --- | --- |
| `src/utils/sanitize.ts` | `sanitizeText`, `sanitizeUrl`, `sanitizeDeep`, `sanitizeReport`, and `REDACTED`. Non-mutating bounded redaction; returned reports still satisfy the ingest schema. |
| `src/utils/fingerprint.ts` | `normalizeStack`, `normalizedTopFrame`, `sha256`, `fingerprintReport`. Parses Chrome/Firefox/Safari stacks with `error-stack-parser-es`; returns the normalized stack/top frame and lowercase SHA-256 digest. |
| `src/services/ruleEngine.ts` | `classifyReport` and `evaluateRules`, with `RuleEvaluation`/`FaultOrigin` types. Pure terminal-error classification and read-only D1 canary evaluation. |
| `src/services/delivery.ts` | `buildDiscordMessage`, `sendDiscordReport`, `sendWebPush`, and transport types. Complete RFC 8291 encryption/VAPID implementation through `@block65/webcrypto-web-push`; bounded HTTPS delivery and rich sanitized Discord embeds. |
| `src/services/notifications.ts` | `sendIssueNotifications`, `sendTestNotification`, `reservePushNotification`, `completePushNotification`, `releasePushNotification`, and configuration/result types. Trigger selection, SQL claims, cooldown, bounded fan-out, and expired-subscription cleanup. |

Sanitization covers nested sensitive keys, quoted/escaped JSON and log assignments, header tuples, Authorization/Bearer/Basic values, API/personal keys, session aliases including `X-Session-Id`, `JSESSIONID`, and `PHPSESSID`, URL credentials/query strings/fragments, extension origin IDs, email/IP strings, and Windows/macOS/Linux home-directory usernames including spaces and encoded URL components. Metadata keys and all permitted diagnostic text/identifier fields are checked too. If redacting an identifier or browser/OS version would violate its schema grammar, its replacement is the literal `REDACTED` token. Safe IDs and versions retain their existing values. The anonymous installation hash and immutable request identities remain intact for grouping and replay protection.

The stack parser consumes the original validated stack in memory before sanitizing emitted frame components. This preserves Firefox `function@relative-file.js` syntax that could otherwise resemble an email address. It never returns the raw stack. Extension origins normalize to `extension:///`; query strings and all line/column positions are removed consistently because bundled extensions do not reliably identify which frames are minified. Up to twenty recognizable frames are retained; missing/unparseable stacks use `<unknown>`. Fingerprints hash the JSON tuple `[sanitized original error_category, sanitized original error_code, sanitized original failure_stage, normalized_top_frame, destination]`, excluding derived rule categories and error message text.

The six core classifications preserve the exact Greek suggested actions from the brief. Explicit terminal security/conflict/handoff/rate-limit/structural/network evidence takes precedence over historical context. A recovered primary 429 or old API schema mismatch cannot override a failed fallback handoff/fetch. Isolated API schema mismatches remain `unknown` fault origin; DOM failures remain `client_env` until enough stored installations support the canary. The canary counts distinct installations for the same issue between inclusive server receipt bounds; it returns `UPSTREAM_BREAKING_CHANGE`/`upstream_site` at the configured threshold without modifying stored report snapshots.

### Integration sequence for Phase 3

1. Enforce request-stream size, content type, origin, rate limits, and opt-in payload validation.
2. Compute `fingerprintReport(originalValidatedReport)` while the original stack is available only in memory; create `sanitizeReport(originalValidatedReport)` for persistence and delivery. Never persist or log the original object.
3. Use `classifyReport(sanitizedReport)` for the immutable report's base classification. Atomically create/find the issue and insert the report using the Phase 1 write contract. Only a newly accepted report may schedule delivery.
4. Call `evaluateRules(DB, sanitizedReport, { issueId, now })` after the report is stored, with `now` equal to its server `created_at`. Apply the returned current classification to the issue summary; retained report snapshots keep their base classification at persistence. The current issue evaluation records any later multi-install canary decision.
5. Detect the one `fixed → regressed` transition atomically in the ingestion transaction using SemVer. Pass that transition's immutable event ID as `regressionEventId`; ordinary reports for an already-regressed issue must omit it.
6. Pass the `sendIssueNotifications(...)` promise to `c.executionCtx.waitUntil(...)`. Supply the sanitized report, current rule evaluation, issue ID, new-issue flag, transition ID when applicable, and server decision time. Do not schedule delivery for an idempotent report retry.

`NotificationConfiguration` accepts `dashboardOrigin`, `discordWebhookUrl`, and `vapid: { publicKey, privateKey, subject }`. Optional numeric settings are `cooldownMs` (default 1,800,000), `windowMs` (900,000), `spikeReportThreshold` (10), `distinctInstallThreshold` (3), and `requestTimeoutMs` (5,000 maximum). Convert the matching Wrangler seconds variables to milliseconds when constructing this configuration. Bind the actual secret values at the router boundary; do not store them in report data.

Push priority is regression, upstream change, new critical issue, then spike. A new critical event requires `error`/`fatal` severity; a spike requires ten stored reports and three distinct installations in the detection window. Muted/ignored issues suppress push; Discord still receives each newly accepted report. The service independently verifies report receipt ownership before delivery and verifies that regression reports are newer than the fixed version.

Claims use a random ownership token, a thirty-second lease, a unique event identity, and an atomic conditional SQL insert/update. Normal events share the issue cooldown and active-lease gate. A genuine regression bypasses cooldown; a delivered transition cannot send twice. Completion is an atomic D1 batch guarded by ownership; failure releases only the current owner's lease. An expired worker cannot complete or release its successor's claim. `last_pushed_at` changes only after at least one push provider accepts a message.

Push payloads contain the full fingerprint as `tag`, a provider `Topic` of at most 32 characters, an HTTPS `/?issue=<id>` deep link, badge count, trigger, and issue identity. Regression, new critical, and upstream alerts use high urgency. `sendTestNotification` delivers a test push without creating an issue, sending Discord, or changing issue cooldowns; its protected admin endpoint is implemented, and service-worker display belongs to Phase 4.

### Delivery outcomes and bounds

Both senders return `DeliveryResult` with `ok`, HTTP `status`, `retryable`, `expired`, bounded `retry_after_ms`, and a safe `reason`. Secrets and provider bodies never appear in the result. A successful result means provider acceptance; lock-screen display and user acknowledgement cannot be verified by the sender.

Push endpoints are restricted to HTTPS Apple `*.push.apple.com`, Google `fcm.googleapis.com`, Mozilla `push.services.mozilla.com` and its subdomains, and Microsoft `*.notify.windows.com`. Other providers require an intentional allowlist extension. The service validates canonical base64url key sizes/curve points, matching VAPID keys and contact subject, encrypted plaintext size, URL authorities, and expiration. It does not follow redirects. HTTP 404/410 subscriptions are removed only when their stored endpoint and keys still match the attempted values, protecting concurrent key rotation. Cleanup failures do not abort other sends or discard accepted-delivery cooldowns.

Discord accepts validated Discord-owned incoming webhook URLs, uses `wait=true`, disables all mentions, and clips Unicode safely within Discord embed limits. It includes a selected diagnostic summary, environment, suggested action, recent timeline, bounded stack, fingerprint, and issue link; installation IDs stay out of embeds.

HTTP attempts time out within five seconds and do not read unbounded response bodies. Retryable provider responses include a bounded `Retry-After` duration of at most 24 hours. The transports do not sleep or automatically retry; callers receive the outcome. Push fan-out uses four workers, an eighteen-second work budget, and at most 100 subscriptions per dispatch. Unattempted/failed deliveries are reported; partial acceptance starts cooldown to avoid resending successful devices. Every started worker settles before a claim is completed or released, and Discord's promise settles independently of push bookkeeping failures.

Delivery uses `waitUntil` best effort rather than a durable queue. Failed all-device sends release the claim and remain eligible for a later explicit retry, but this phase creates no background retry scheduler. Discord has no persisted channel-specific delivery receipt; the ingestion transaction must invoke it once per newly accepted report. An interrupted request/provider timeout can still have an uncertain delivery outcome. Durable exactly-once external delivery is not claimed.

## Phase 3 HTTP API

Only exact `/api/ingest` and `/api/heartbeat` paths are public. They require a canonical Chrome extension origin or Firefox UUID extension origin, even for non-browser clients. Preflight permits only POST with `Content-Type`; credentials are not allowed. Chrome content scripts must send through the extension background context. Both routes return HTTP 202 for a newly stored payload and HTTP 200 with `duplicate: true` for an identical retry. Reusing a retained identity with different data returns HTTP 409. Responses include only the submitted report/heartbeat ID, success flag and duplicate flag.

The public middleware consumes the trusted Cloudflare `CF-Connecting-IP` budget before body parsing and the validated installation budget before full payload validation. Missing or malformed connecting IP is rejected. Default per-minute limits are 60 IP / 20 installation reports and 120 IP / 10 installation heartbeats. Atomic fixed-window D1 buckets contain HMAC-SHA-256 hashes of `[route, scope, subject]`; raw IPs and admin identities are never stored in buckets. Denials return HTTP 429 with `Retry-After`. New buckets perform bounded expired-bucket cleanup. Fixed windows permit bursts across a window boundary; origin checking does not authenticate an extension installation.

Every other path, including unknown APIs and static assets, requires the signed Access assertion. Protected mutations also require an `Origin` equal to the request's HTTPS origin. Responses are `Cache-Control: no-store` with content-type sniffing, framing and referrer restrictions. Unknown API paths return JSON 404 instead of a SPA response. Access verification uses a bounded cache of vendor middleware instances; the pinned middleware owns its trusted JWKS request and exposes no timeout or response-size hook. A JWKS outage fails authentication closed; it can delay the request until the platform network limit.

| Method and protected path | Contract |
| --- | --- |
| `GET /api/admin/overview` | Issue totals and aggregate release health |
| `GET /api/admin/issues` | `{items,total,page,limit}`; filters `version`, `browser`, `os`, `destination`, `download_mode`, `status`, `fault_origin`, `category`, `severity`, `muted`, `q`, `from`, `to` |
| `GET /api/admin/issues/:id` | `{issue,report_summary,latest_report}`; JSON diagnostic fields are parsed |
| `GET /api/admin/issues/:id/reports` | Bounded report pagination |
| `PATCH /api/admin/issues/:id` | Nonempty partial update of `status`, `fixed_in_version`, `github_issue_url`, `muted`; conflicting concurrent updates return 409 |
| `GET /api/admin/releases` | Aggregated release counters and nullable percentages, with version/date/browser/destination filters |
| `GET /api/admin/releases/compare?before=3.1.0&after=3.2.0` | Before/after aggregates and percentage-point deltas, with date/browser/destination filters |
| `GET /api/admin/push/config` | `{public_key}`; never returns private VAPID material |
| `GET /api/admin/push/subscriptions` | Subscription metadata; endpoints and key material remain private |
| `POST /api/admin/push/subscriptions` | Native PushSubscription JSON `{endpoint,expirationTime,keys:{p256dh,auth}}`; returns metadata, 201 new / 200 updated |
| `DELETE /api/admin/push/subscriptions/:id` | HTTP 204 on deletion, 404 when absent |
| `POST /api/admin/push/test` | Strict empty JSON object; delivery summary; one request per minute per verified identity |
| `GET /api/admin/health` | Protected D1 readiness check |

Issue dimensions must match the same retained report. Lists default to page 1 / limit 30 and allow at most 100 rows per page and page 10,000. Date filters use real UTC calendar dates, default to the last 30 days, and permit a maximum 366-day inclusive range. Unknown or duplicate query keys are rejected. Text search escapes SQL LIKE wildcard characters and uses bound parameters. Release percentages and deltas are `null` when their denominator is zero.

Fixed or regressed issues require a valid SemVer baseline. GitHub links must be HTTPS `github.com/<owner>/<repo>/issues/<positive number>` with no credentials, query, or fragment. The independent mute flag suppresses push. Push registration verifies an allowed provider URL and actual P-256 curve point before writing, sanitizes the user-agent, caps the database at 100 subscriptions atomically, and permits existing endpoint key rotation at capacity.

Report creation, immutable retry receipt, distinct installation membership and lifetime counters commit as one D1 batch. Heartbeat receipt insertion and release rollup also commit atomically. Replay bodies are never inserted, so retention cannot restore deleted details or inflate counters. When report details still exist, canonical sanitized bodies must match; after body retention, installation and fingerprint still guard the receipt identity. Only a newly accepted version strictly above a fixed SemVer baseline can atomically create a regression event. Classification enrichment after the transaction is best effort: a failure retains the stored classification and successful acceptance. The issue summary refresh reads the latest retained report's immutable base classification and counts the current receipt window in one atomic SQL statement, so delayed requests cannot overwrite newer evidence or leave a canary undetected.

Discord and eligible push delivery are scheduled through `waitUntil()` only for newly accepted reports. Push window and claim decisions use the later of this request's receipt clock and the issue's latest receipt clock; out-of-order commits cannot hide the third installation's canary or a current spike. Discord retains this report's own sanitized context. Notification failures cannot roll back persistence or change an accepted HTTP response. Logs contain fixed event names and random request IDs, without payloads, tokens, SQL errors, provider bodies or URLs. Response latency still includes body validation, HMAC rate checks and D1 writes; the requested 50 ms target needs measurement on the deployed domain and region. No durable queue or automatic retry worker has been introduced.

Local builds can be checked without deployment:

```powershell
npm run check
npx wrangler deploy --dry-run --outdir .wrangler/phase3-dry-run
npm run db:init:local
```

`npm run typecheck` first regenerates the binding types. A dry run bundles the Worker but does not verify your real Access policy, secrets, Discord delivery or device push display.

For local ingest, run `npx wrangler dev --local-protocol https` with the real ignored development bindings. Notification links require HTTPS, including in local requests. The PWA assets directory is currently empty, so an authenticated asset request can return 404 until Phase 4.

## Official references

- [Wrangler configuration: automatic provisioning and required secrets](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Worker-first static asset routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)
- [D1 foreign-key enforcement](https://developers.cloudflare.com/d1/sql-api/foreign-keys/)
- [D1 database API and atomic batches](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Zod schema APIs](https://zod.dev/api)
- [WebCrypto Web Push](https://github.com/block65/webcrypto-web-push)
````
