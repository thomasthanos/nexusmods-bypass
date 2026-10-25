// Discord webhook formatting and delivery, shared by the report relay (worker.js) and the GitHub
// workflow notifier (tools/discord-notification.mjs). Standard Web APIs only, so the same file runs
// in a Cloudflare Worker and in Node. Nothing here logs, throws or returns a webhook URL.

// https://discord.com/developers/docs/resources/message#embed-object-embed-limits
export const DISCORD_LIMITS = Object.freeze({
  title: 256,
  description: 4096,
  fields: 25,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  author: 256,
  total: 6000
});

// One palette for every embed this project posts.
export const COLORS = Object.freeze({
  success: 0x57f287, // releases
  notice: 0x3498db, // neutral GitHub notices: an issue, a manifest edit that does not widen access
  warning: 0xe8b339, // degraded, throttled or drifting: non-crash faults, schema and access warnings
  critical: 0xed4245 // crashes, uncaught errors and user bug reports, the ones that ping the owner
});

// Server-side trouble or throttling: the request was not processed, so sending it again is safe.
// A plain 500 is left alone because Discord may already have stored the message.
const RETRY_STATUSES = new Set([429, 502, 503, 504]);

/**
 * At most `max` UTF-16 units, ending in an ellipsis when cut. Lone surrogates (possible in any JSON
 * a client sends) become U+FFFD and a cut never splits a pair: half a pair is not valid UTF-8, and
 * Discord rejects the whole message for it.
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
export function clip(value, max) {
  let text = String(value ?? '');
  if (typeof text.toWellFormed === 'function') text = text.toWellFormed();
  if (text.length <= max) return text;
  if (max <= 0) return '';
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

// allowed_mentions: { parse: [] } is what stops a ping; this also keeps @everyone from reading as one.
export const quiet = (value) => String(value ?? '').replace(/@/g, '@\u200b');

/**
 * Clamps an embed to every Discord limit, in place, and returns it. When the total is over 6000
 * characters the description gives way first, then trailing fields. Empty title and description
 * keys are dropped because Discord refuses empty strings there.
 * @param {{title?:string, description?:string, footer?:{text?:string}, author?:{name?:string},
 *   fields?:Array<{name?:string, value?:string, inline?:boolean}>}} embed
 */
export function fitEmbed(embed) {
  embed.title = clip(embed.title, DISCORD_LIMITS.title);
  embed.description = clip(embed.description, DISCORD_LIMITS.description);
  if (embed.footer) embed.footer = { ...embed.footer, text: clip(embed.footer.text, DISCORD_LIMITS.footer) };
  if (embed.author) embed.author = { ...embed.author, name: clip(embed.author.name, DISCORD_LIMITS.author) };
  embed.fields = (embed.fields || []).slice(0, DISCORD_LIMITS.fields).map((field) => ({
    ...field,
    name: clip(field.name || '—', DISCORD_LIMITS.fieldName),
    value: clip(field.value || '—', DISCORD_LIMITS.fieldValue)
  }));
  const total = () => embed.title.length + embed.description.length
    + (embed.footer?.text?.length || 0) + (embed.author?.name?.length || 0)
    + embed.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
  if (total() > DISCORD_LIMITS.total && embed.description.length > 200) {
    embed.description = clip(embed.description, Math.max(200, embed.description.length - (total() - DISCORD_LIMITS.total)));
  }
  while (total() > DISCORD_LIMITS.total && embed.fields.length) embed.fields.pop();
  if (!embed.title) delete embed.title;
  if (!embed.description) delete embed.description;
  return embed;
}

/**
 * How long Discord asked to wait, in milliseconds, or null when it did not say. The JSON body's
 * retry_after (fractional seconds) is the most precise; then Retry-After (seconds or an HTTP date);
 * then X-RateLimit-Reset-After.
 */
export function discordRetryAfterMs(headers, body, now = Date.now()) {
  const fromBody = Number(body?.retry_after);
  if (body?.retry_after !== undefined && Number.isFinite(fromBody) && fromBody >= 0) return Math.ceil(fromBody * 1000);
  const header = String(headers?.get?.('retry-after') ?? '').trim();
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  const resetAfter = String(headers?.get?.('x-ratelimit-reset-after') ?? '').trim();
  const reset = Number(resetAfter);
  return resetAfter && Number.isFinite(reset) && reset >= 0 ? Math.ceil(reset * 1000) : null;
}

/** Exponential backoff with equal jitter: half the step is fixed, half random. */
export function backoffMs(attempt, { baseMs = 500, maxMs = 8000, random = Math.random } = {}) {
  const ceiling = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs);
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

function describeFailure(status, body) {
  const code = Number.isInteger(body?.code) ? ` code ${body.code}` : '';
  const message = typeof body?.message === 'string'
    ? `: ${body.message.replace(/https?:\/\/\S+/gi, '[url]').slice(0, 120)}`
    : '';
  return `HTTP ${status}${code}${message}`;
}

/**
 * @typedef {object} DeliveryResult
 * @property {boolean} ok
 * @property {number} status         last HTTP status, 0 when no response arrived
 * @property {number} attempts
 * @property {number|null} retryAfterMs  what Discord asked for on a final 429
 * @property {string} error          short description, safe to log
 */

/**
 * Posts one webhook message. A plain object is sent as JSON; FormData carries attachments. Waits
 * out a 429 as long as Discord asks (plus jitter), retries 502/503/504 and network errors with
 * jittered backoff, and stops when the attempts or the time budget run out. Never throws.
 * @param {string} webhookUrl
 * @param {object|FormData} message
 * @param {{fetchImpl?: typeof fetch, sleep?: (ms:number) => Promise<void>, random?: () => number,
 *   now?: () => number, maxAttempts?: number, budgetMs?: number, timeoutMs?: number}} [options]
 * @returns {Promise<DeliveryResult>}
 */
export async function postWebhook(webhookUrl, message, {
  fetchImpl = (...args) => globalThis.fetch(...args),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
  now = () => Date.now(),
  maxAttempts = 3,
  budgetMs = 10000,
  timeoutMs = 6000
} = {}) {
  let target;
  try {
    target = new URL(String(webhookUrl || ''));
    if (target.protocol !== 'https:') throw new Error('not https');
  } catch (_) {
    return { ok: false, status: 0, attempts: 0, retryAfterMs: null, error: 'invalid webhook URL' };
  }
  // With wait=true Discord validates and stores the message before answering, so 2xx means saved.
  target.searchParams.set('wait', 'true');
  const isForm = typeof FormData === 'function' && message instanceof FormData;
  const init = {
    method: 'POST',
    body: isForm ? message : JSON.stringify(message),
    ...(isForm ? {} : { headers: { 'content-type': 'application/json' } })
  };

  const started = now();
  let result = { ok: false, status: 0, attempts: 0, retryAfterMs: null, error: 'not sent' };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = typeof globalThis.AbortController === 'function' ? new globalThis.AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), Math.max(1000, timeoutMs)) : null;
    let response = null;
    let body = null;
    let failure = '';
    try {
      response = await fetchImpl(target.href, controller ? { ...init, signal: controller.signal } : init);
      // Always drain the body: an unread response holds its connection open in a Worker.
      const text = await response.text().catch(() => '');
      try { body = text ? JSON.parse(text) : null; } catch (_) { }
    } catch (cause) {
      failure = cause?.name === 'AbortError' ? 'timed out' : 'network error';
    } finally {
      if (timer) clearTimeout(timer);
    }

    let delay;
    if (response) {
      if (response.ok) return { ok: true, status: response.status, attempts: attempt, retryAfterMs: null, error: '' };
      const retryAfterMs = response.status === 429 ? discordRetryAfterMs(response.headers, body, now()) : null;
      result = { ok: false, status: response.status, attempts: attempt, retryAfterMs, error: describeFailure(response.status, body) };
      if (!RETRY_STATUSES.has(response.status)) return result;
      delay = retryAfterMs !== null
        ? retryAfterMs + Math.round(random() * 250)
        : backoffMs(attempt, { random });
    } else {
      result = { ok: false, status: 0, attempts: attempt, retryAfterMs: null, error: failure };
      delay = backoffMs(attempt, { random });
    }
    if (attempt >= maxAttempts || now() - started + delay > budgetMs) return result;
    await sleep(delay);
  }
  return result;
}
