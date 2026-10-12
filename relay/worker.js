// NexusMods Bypass bug-report relay (Cloudflare Worker).
//
// POST /v1/report  with the JSON the extension's report page shows the user. The Worker validates
// the shape and size, rate-limits per client IP, and forwards a summary to Discord (secret
// DISCORD_WEBHOOK_URL) and, if configured, by e-mail through Resend (secrets RESEND_API_KEY,
// REPORT_EMAIL_TO, REPORT_EMAIL_FROM). The extension holds no secrets; this Worker does.
//
// Rate limiting: with a KV namespace bound as RATE_LIMIT, counters are kept in KV per IP and hour
// (eventually consistent, good enough for abuse control). Without it, an in-memory Map per isolate
// is used, which only limits bursts hitting the same isolate. Cloudflare's own Rate Limiting rules
// can be added in front for a hard limit; no Durable Object is needed.

export const MAX_BODY_BYTES = 64 * 1024;
export const LIMIT_PER_HOUR = 10;
const memoryBuckets = new Map();

const CORS = {
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400'
};

function corsHeaders(request, env) {
  const origin = request.headers.get('origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || 'chrome-extension://,moz-extension://,extension://')
    .split(',').map((s) => s.trim()).filter(Boolean);
  // Only a well-formed extension origin (scheme://id, nothing after it) is echoed back.
  const ok = /^[a-z-]+:\/\/[A-Za-z0-9._-]+$/.test(origin) && allowed.some((prefix) => origin.startsWith(prefix));
  return ok ? { ...CORS, 'access-control-allow-origin': origin, vary: 'origin' } : { ...CORS, vary: 'origin' };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const isStr = (v, max) => typeof v === 'string' && v.length <= max;

// Returns an error string, or '' when the payload is acceptable.
export function validateReport(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'not an object';
  if (p.schema !== 1) return 'unsupported schema';
  if (!['manual', 'auto'].includes(p.kind)) return 'bad kind';
  if (!isStr(p.version, 20) || !/^\d+\.\d+\.\d+$/.test(p.version)) return 'bad version';
  if (p.browser !== undefined && !isStr(p.browser, 200)) return 'bad browser';
  if (p.page !== undefined && (!isStr(p.page, 200) || /[?#]/.test(p.page))) return 'bad page';
  if (p.kind === 'auto') {
    const e = p.error;
    if (!e || typeof e !== 'object' || !isStr(e.code, 80)) return 'bad error';
    if (e.context !== undefined && !isStr(e.context, 400)) return 'bad error context';
    if (e.message !== undefined && !isStr(e.message, 400)) return 'bad error message';
    return '';
  }
  if (p.note !== undefined && !isStr(p.note, 2000)) return 'bad note';
  if (p.summary !== undefined && !isStr(p.summary, 160)) return 'bad summary';
  if (p.category !== undefined && !['download', 'collection', 'vortex', 'interface', 'other'].includes(p.category)) return 'bad category';
  if (p.steps !== undefined && !isStr(p.steps, 1000)) return 'bad steps';
  if (p.expected !== undefined && !isStr(p.expected, 1000)) return 'bad expected result';
  if (p.contact !== undefined && !isStr(p.contact, 120)) return 'bad contact';
  if (p.report !== undefined && !isStr(p.report, 12000)) return 'bad report';
  if (p.errors !== undefined && (!Array.isArray(p.errors) || p.errors.length > 50)) return 'bad errors';
  if (p.logs !== undefined && (!Array.isArray(p.logs) || p.logs.length > 400)) return 'bad logs';
  if (p.settings !== undefined && (typeof p.settings !== 'object' || Array.isArray(p.settings))) return 'bad settings';
  return '';
}

async function allow(env, ip, now = Date.now()) {
  const hour = Math.floor(now / 3600000);
  const key = `rl:${ip}:${hour}`;
  if (env.RATE_LIMIT) {
    const count = Number(await env.RATE_LIMIT.get(key)) || 0;
    if (count >= LIMIT_PER_HOUR) return false;
    await env.RATE_LIMIT.put(key, String(count + 1), { expirationTtl: 3700 });
    return true;
  }
  for (const [k, v] of memoryBuckets) if (v.hour !== hour) memoryBuckets.delete(k);
  const bucket = memoryBuckets.get(key) || { hour, count: 0 };
  if (bucket.count >= LIMIT_PER_HOUR) return false;
  bucket.count += 1;
  memoryBuckets.set(key, bucket);
  return true;
}

const clip = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ''));
// Discord would otherwise turn @everyone or <@id> in user text into pings.
const quiet = (s) => String(s ?? '').replace(/@/g, '@\u200b');

// Embed colour by severity: red for crashes/server errors, amber for other auto errors, and a
// per-area colour for manual reports so a channel skims at a glance.
export const SEVERITY_COLORS = { critical: 0xd9433b, error: 0xe8b339, report: 0x5b8def };
export function severityOf(p) {
  if (p.kind !== 'auto') return 'report';
  const status = Number(p.error?.status) || 0;
  if (status >= 500 || /crash|uncaught|fatal|unhandled/i.test(p.error?.code || '')) return 'critical';
  return 'error';
}

// Discord limits: title 256, description 4096, field value 1024, 25 fields, 6000 total.
export function fitEmbed(embed) {
  embed.title = clip(embed.title, 256);
  embed.description = clip(embed.description, 4096);
  embed.fields = (embed.fields || []).slice(0, 25).map((f) => ({ ...f, name: clip(f.name, 256), value: clip(f.value || '—', 1024) }));
  const total = () => embed.title.length + embed.description.length + (embed.footer?.text?.length || 0)
    + embed.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
  while (total() > 6000 && embed.description.length > 200) embed.description = clip(embed.description, Math.max(200, embed.description.length - (total() - 6000) - 10));
  while (total() > 6000 && embed.fields.length) embed.fields.pop();
  return embed;
}

// Auto errors from many users hit the same bug; forward one per fingerprint per window.
export const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const recentFingerprints = new Map();
export function fingerprintOf(p) {
  if (p.kind !== 'auto') return '';
  return [p.version, p.error?.code, p.error?.status || '', String(p.error?.context || '').slice(0, 80)].join('|');
}
export async function isDuplicate(env, fp, now = Date.now()) {
  if (!fp) return false;
  const key = `fp:${fp}`;
  if (env.RATE_LIMIT) return !!await env.RATE_LIMIT.get(key);
  for (const [k, at] of recentFingerprints) if (now - at > DEDUPE_WINDOW_MS) recentFingerprints.delete(k);
  return recentFingerprints.has(key);
}
// Marked only after Discord accepted the report, so a failed delivery can be retried.
export async function markSeen(env, fp, now = Date.now()) {
  if (!fp) return;
  const key = `fp:${fp}`;
  if (env.RATE_LIMIT) await env.RATE_LIMIT.put(key, '1', { expirationTtl: Math.ceil(DEDUPE_WINDOW_MS / 1000) });
  else recentFingerprints.set(key, now);
}

export function discordMessage(p, id) {
  const fields = [
    { name: 'Version', value: clip(p.version, 40), inline: true },
    { name: 'Kind', value: p.kind, inline: true },
    { name: 'Browser', value: clip(quiet(p.browser) || '—', 200), inline: true }
  ];
  if (p.page) fields.push({ name: 'Page', value: clip(quiet(p.page), 200), inline: true });
  if (p.kind === 'auto') {
    fields.push({ name: 'Error', value: clip(quiet(`${p.error.code}${p.error.status ? ` (${p.error.status})` : ''}`), 200) });
    if (p.error.context) fields.push({ name: 'Context', value: clip(quiet(p.error.context), 900) });
    if (p.error.message) fields.push({ name: 'Message', value: clip(quiet(p.error.message), 900) });
  } else {
    if (p.category) fields.push({ name: 'Area', value: p.category, inline: true });
    if (p.currentError?.code) fields.push({ name: 'Current error', value: clip(quiet(p.currentError.code), 200) });
    fields.push({ name: 'Logged errors', value: String(p.errors?.length || 0), inline: true });
    fields.push({ name: 'Debug lines', value: String(p.logs?.length || 0), inline: true });
    if (p.contact) fields.push({ name: 'Contact', value: clip(quiet(p.contact), 120) });
  }
  return {
    username: 'NexusMods Bypass reports',
    allowed_mentions: { parse: [] },
    embeds: [fitEmbed({
      title: p.kind === 'auto' ? `Auto error: ${clip(quiet(p.error.code), 80)}` : clip(quiet(p.summary || 'Bug report'), 160),
      // Discord rejects an embed over 6000 characters in total; fields take at most ~2600 here.
      description: clip(quiet(p.note || (p.report ? `\`\`\`\n${clip(p.report, 1500)}\n\`\`\`` : '')), 3000),
      color: SEVERITY_COLORS[severityOf(p)],
      fields,
      footer: { text: `id ${id}` },
      timestamp: new Date().toISOString()
    })]
  };
}

async function sendEmail(env, p, id) {
  if (!env.RESEND_API_KEY || !env.REPORT_EMAIL_TO || !env.REPORT_EMAIL_FROM) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: env.REPORT_EMAIL_FROM,
      to: env.REPORT_EMAIL_TO,
      subject: `[NexusMods Bypass] ${p.kind === 'auto' ? `auto error ${p.error.code}` : 'bug report'} ${p.version} (${id})`,
      text: JSON.stringify(p, null, 2).slice(0, 60000)
    })
  });
}

export default {
  async fetch(request, env, ctx) {
    const headers = corsHeaders(request, env);
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    // Health check the extension makes before sending: reachable, and whether a destination is set.
    if (url.pathname === '/v1/health' && (request.method === 'GET' || request.method === 'HEAD')) {
      return json({ ok: true, configured: !!env.DISCORD_WEBHOOK_URL, maxBytes: MAX_BODY_BYTES }, 200, headers);
    }
    if (url.pathname !== '/v1/report') return json({ error: 'not found' }, 404, headers);
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, headers);
    if (!/^application\/json\b/i.test((request.headers.get('content-type') || '').trim())) return json({ error: 'expected json' }, 415, headers);
    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > MAX_BODY_BYTES) return json({ error: 'too large' }, 413, headers);
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return json({ error: 'too large' }, 413, headers);

    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    if (!await allow(env, ip)) return json({ error: 'rate limited' }, 429, { ...headers, 'retry-after': '3600' });

    let payload;
    try {
      payload = JSON.parse(text);
    } catch (_) {
      return json({ error: 'invalid json' }, 400, headers);
    }
    const problem = validateReport(payload);
    if (problem) return json({ error: problem }, 422, headers);

    if (!env.DISCORD_WEBHOOK_URL) return json({ error: 'relay not configured' }, 503, headers);
    const fp = fingerprintOf(payload);
    if (await isDuplicate(env, fp)) return json({ ok: true, duplicate: true }, 200, headers);
    const id = crypto.randomUUID().slice(0, 8);
    let discord;
    try {
      const message = discordMessage(payload, id);
      const body = new FormData();
      body.set('payload_json', JSON.stringify(message));
      // Discord embeds are summaries. The attachment preserves the exact report, including the
      // reproduction steps, diagnostics and opted-in logs the reporter reviewed before sending.
      body.set('files[0]', new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `nexusmods-report-${id}.json`);
      const webhook = new URL(env.DISCORD_WEBHOOK_URL);
      webhook.searchParams.set('wait', 'true');
      discord = await fetch(webhook.href, {
        method: 'POST',
        body
      });
    } catch (_) {
      // An uncaught throw would be a 500 without CORS headers, which the extension sees as "Failed to fetch".
      return json({ error: 'upstream failed' }, 502, headers);
    }
    const email = sendEmail(env, payload, id).catch(() => undefined);
    if (ctx?.waitUntil) ctx.waitUntil(email);
    if (!discord.ok) return json({ error: 'upstream failed' }, 502, headers);
    await markSeen(env, fp);
    return json({ ok: true, id }, 200, headers);
  }
};
