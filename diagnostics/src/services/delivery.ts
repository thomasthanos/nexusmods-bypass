import { buildPushPayload } from '@block65/webcrypto-web-push';
import type { ErrorReport } from '../schemas/ingest.ts';
import { sanitizeReport, sanitizeText } from '../utils/sanitize.ts';

export type DeliveryResult = {
  ok: boolean;
  status: number | null;
  retryable: boolean;
  expired: boolean;
  retry_after_ms: number | null;
  reason: 'delivered' | 'already_posted' | 'http_error' | 'network_error' | 'invalid_config' | 'invalid_subscription' | 'payload_too_large';
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
