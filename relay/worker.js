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
//
// Failure policy: a report is never refused because of the relay's own bookkeeping. A KV read or
// write that fails (the free plan's daily write cap, or two writes to one key within a second) falls
// back to memory; anything else that throws still answers with CORS headers, so the extension sees a
// real status instead of "Failed to fetch". When Discord cannot take a report the incident goes to
// the Worker log (`wrangler tail`, or Workers Logs) and to e-mail when that is configured.

import { COLORS, clip, quiet, fitEmbed, postWebhook } from './discord.js';

export { fitEmbed };
export const MAX_BODY_BYTES = 64 * 1024;
export const LIMIT_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;
// The extension stops waiting for the relay after 15 s (automatic) or 20 s (manual), so Discord
// retries have to fit well inside that.
export const DELIVERY_OPTIONS = Object.freeze({ maxAttempts: 3, budgetMs: 9000, timeoutMs: 5000 });

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
  if (p.reference !== undefined && (!isStr(p.reference, 32) || (p.reference !== '' && !/^E-[a-z0-9]{7}$/.test(p.reference)))) return 'bad reference';
  if (p.kind === 'auto') {
    const e = p.error;
    if (!e || typeof e !== 'object' || !isStr(e.code, 80)) return 'bad error';
    if (e.context !== undefined && !isStr(e.context, 400)) return 'bad error context';
    if (e.causeCode !== undefined && (!isStr(e.causeCode, 80) || !/^[A-Za-z0-9_-]*$/.test(e.causeCode))) return 'bad cause code';
    if (e.message !== undefined && !isStr(e.message, 400)) return 'bad error message';
    if (e.status !== undefined && e.status !== null && (!Number.isInteger(e.status) || e.status < 100 || e.status > 599)) return 'bad error status';
    if (e.action !== undefined && !isStr(e.action, 200)) return 'bad error action';
    if (e.frame !== undefined && (!isStr(e.frame, 200) || (e.frame !== '' && !/^[\w/.-]+\.js:\d+:\d+$/.test(e.frame)))) return 'bad error frame';
    if (p.severity !== undefined && !['critical', 'error'].includes(p.severity)) return 'bad severity';
    if (p.occurrences !== undefined && (!Number.isInteger(p.occurrences) || p.occurrences < 1 || p.occurrences > 10000)) return 'bad occurrences';
    for (const key of ['firstAt', 'lastAt']) {
      if (p[key] !== undefined && (!isStr(p[key], 30) || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(p[key]) || !Number.isFinite(Date.parse(p[key])))) return 'bad timestamp';
    }
    if (p.diagnostics !== undefined) {
      const d = p.diagnostics;
      if (!d || typeof d !== 'object' || Array.isArray(d) || d.consent !== 'extended-v1') return 'bad diagnostics consent';
      if (!Array.isArray(d.logs) || d.logs.length > 20 || d.logs.some((line) => !line || typeof line !== 'object'
        || !isStr(line.at, 30) || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(line.at) || !Number.isFinite(Date.parse(line.at))
        || !['debug', 'info', 'warn', 'error'].includes(line.level)
        || !['mod', 'collection', 'nexus', 'extension'].includes(line.page) || !isStr(line.text, 400))) return 'bad diagnostics logs';
      if (d.file !== undefined && (!d.file || typeof d.file !== 'object' || Array.isArray(d.file)
        || !['expectedId', 'receivedId'].some((key) => d.file[key] !== undefined)
        || ['expectedId', 'receivedId'].some((key) => d.file[key] !== undefined
          && (!isStr(d.file[key], 16) || !/^[1-9]\d{0,15}$/.test(d.file[key]) || !Number.isSafeInteger(Number(d.file[key])))))) return 'bad diagnostics file';
    }
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

// ---- Incident log ----------------------------------------------------------------------------

// One JSON line per incident on the Worker log. Lines carry identifiers, codes and HTTP statuses,
// never report text, and every secret the Worker holds is removed from error messages first (a URL
// parse error, for one, repeats the URL it could not parse). Tests pass env.INCIDENT_LOG to capture
// the lines; a deployed Worker cannot, since bindings are never functions.
function redactSecrets(text, secrets) {
  let out = String(text ?? '');
  for (const secret of secrets) out = out.split(secret).join('[secret]');
  return out.replace(/https?:\/\/[^\s"'<>]*\/api\/webhooks\/[^\s"'<>]+/gi, '[webhook]');
}

export function incidentLogger(env) {
  let sink = (line) => console.error(line);
  let secrets = [];
  try {
    if (typeof env?.INCIDENT_LOG === 'function') sink = env.INCIDENT_LOG;
    secrets = [env?.DISCORD_WEBHOOK_URL, env?.RESEND_API_KEY]
      .filter((value) => typeof value === 'string' && value.length >= 8);
  } catch (_) { }
  return (event, details = {}) => {
    try {
      const entry = { at: new Date().toISOString(), event };
      for (const [key, value] of Object.entries(details)) {
        if (value === undefined || value === null || value === '') continue;
        if (key === 'cause') {
          entry.cause = redactSecrets(`${value?.name || 'Error'}: ${value?.message ?? value}`, secrets).slice(0, 300);
        } else {
          entry[key] = typeof value === 'number' || typeof value === 'boolean' ? value : redactSecrets(value, secrets).slice(0, 200);
        }
      }
      sink(JSON.stringify(entry));
    } catch (_) { }
  };
}

// ---- Counters and cooldown markers -------------------------------------------------------------

// KV is shared across isolates but eventually consistent, limited to one write per key per second
// and, on the free plan, capped per day. Every KV call is therefore best effort: a failure falls back
// to this isolate's memory. Memory also mirrors this isolate's own writes, which covers KV's
// propagation delay for back-to-back requests. It is bounded so rotating client IPs cannot grow it.
const MEMORY_MAX_ENTRIES = 5000;
const memory = new Map();

function memoryGet(key, now) {
  const entry = memory.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    memory.delete(key);
    return null;
  }
  return entry.value;
}

function memoryPut(key, value, ttlMs, now) {
  memory.delete(key);
  memory.set(key, { value, expiresAt: now + ttlMs });
  if (memory.size <= MEMORY_MAX_ENTRIES) return;
  for (const [candidate, entry] of memory) if (entry.expiresAt <= now) memory.delete(candidate);
  while (memory.size > MEMORY_MAX_ENTRIES) memory.delete(memory.keys().next().value);
}

const keyScope = (key) => String(key).split(':', 1)[0];

async function storeGet(env, key, now, log) {
  if (env.RATE_LIMIT) {
    try {
      const value = await env.RATE_LIMIT.get(key);
      if (value !== null && value !== undefined) return value;
    } catch (cause) {
      log('kv_read_failed', { scope: keyScope(key), cause });
    }
  }
  return memoryGet(key, now);
}

async function storePut(env, key, value, ttlMs, now, log) {
  memoryPut(key, value, ttlMs, now);
  if (!env.RATE_LIMIT) return;
  try {
    await env.RATE_LIMIT.put(key, value, { expirationTtl: Math.max(60, Math.ceil(ttlMs / 1000)) });
  } catch (cause) {
    log('kv_write_failed', { scope: keyScope(key), cause });
  }
}

const secondsUntilNextHour = (now) => Math.max(1, Math.ceil(((Math.floor(now / HOUR_MS) + 1) * HOUR_MS - now) / 1000));

async function allow(env, ip, kind, now, log) {
  const hour = Math.floor(now / HOUR_MS);
  // Automatic diagnostics must not use up the allowance for a user's manual report.
  const key = `rl:${kind}:${ip}:${hour}`;
  // A KV read can lag this isolate's own last write, so the higher count wins.
  const count = Math.max(Number(await storeGet(env, key, now, log)) || 0, Number(memoryGet(key, now)) || 0);
  if (count >= LIMIT_PER_HOUR) return false;
  await storePut(env, key, String(count + 1), secondsUntilNextHour(now) * 1000 + 100000, now, log);
  return true;
}

// Crashes and user bug reports are red and ping the owner; other automatic faults (network trouble,
// a failed queue item, Nexus changing its pages or API) are amber. GitHub automation uses the same
// palette from tools/discord-notification.mjs.
export const SEVERITY_COLORS = Object.freeze({ critical: COLORS.critical, error: COLORS.warning, report: COLORS.critical });
export function severityOf(p) {
  if (p.kind !== 'auto') return 'report';
  if (p.severity === 'critical') return 'critical';
  const status = Number(p.error?.status) || 0;
  if (status >= 500 || /crash|uncaught|fatal|unhandled/i.test(p.error?.code || '')) return 'critical';
  return 'error';
}

// Version age and fault type are independent: an older client's failure is not claimed to be fixed.
const WARNING_CODES = new Set(['nexus_page_changed', 'nexus_api_changed', 'network_error', 'timeout',
  'NETWORK_FAILED', 'NETWORK_TIMEOUT', 'NETWORK_DISCONNECTED', 'NETWORK_SERVER_DOWN',
  'server_error', 'requires_login', 'cloudflare', 'rate_limited', 'access_denied']);
function classificationOf(p, relayVersion = '') {
  if (!/^\d+\.\d+\.\d+$/.test(relayVersion)) {
    return { level: WARNING_CODES.has(p.error?.causeCode || p.error?.code) ? 'warning' : 'error', client: 'unknown' };
  }
  const parts = (version) => String(version).split('.').map(Number);
  const given = parts(p.version), current = parts(relayVersion);
  let difference = 0;
  for (let i = 0; i < 3 && !difference; i += 1) difference = given[i] - current[i];
  return {
    level: WARNING_CODES.has(p.error?.causeCode || p.error?.code) ? 'warning' : 'error',
    client: difference < 0 ? 'older' : difference > 0 ? 'newer' : 'current',
    relayVersion
  };
}

// Who needs pinging: a user's own bug report, or an automatic error from a current (or newer) client.
// A warning (connection trouble, Nexus changing a page, a transient download failure) or an older
// release's report still arrives, quietly: each new one used to ping once a day, so most pings were
// faults already fixed or nobody could act on.
export function mentionWorthy(p, relayVersion = '') {
  if (p.kind !== 'auto') return true;
  const { level, client } = classificationOf(p, relayVersion);
  return client !== 'older' && level === 'error';
}

// Never attach the raw automatic request: older clients or third parties may include unknown fields.
// Manual attachments remain the exact diagnostics their user reviewed.
function automaticAttachment(p, relayVersion) {
  const pick = (value, keys) => Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
  const out = pick(p, ['schema', 'kind', 'version', 'browser', 'page', 'reference', 'severity', 'occurrences', 'firstAt', 'lastAt']);
  out.classification = classificationOf(p, relayVersion);
  out.error = pick(p.error, ['code', 'causeCode', 'status', 'context', 'message', 'action', 'frame']);
  if (p.diagnostics) {
    out.diagnostics = { consent: 'extended-v1', logs: p.diagnostics.logs.map((line) => pick(line, ['at', 'level', 'page', 'text'])) };
    if (p.diagnostics.file) out.diagnostics.file = pick(p.diagnostics.file, ['expectedId', 'receivedId']);
  }
  return out;
}

// Old and new clients share these limits. Summaries have a separate daily mention cooldown.
export const DEDUPE_WINDOW_MS = 60 * 60 * 1000;
export const NETWORK_WINDOW_MS = 6 * DEDUPE_WINDOW_MS;
export const MENTION_WINDOW_MS = 24 * DEDUPE_WINDOW_MS;
function reportWindow(p) {
  return ['network_error', 'timeout'].includes(p.error?.causeCode || p.error?.code) ? NETWORK_WINDOW_MS : DEDUPE_WINDOW_MS;
}
export function fingerprintOf(p) {
  if (p.kind !== 'auto') return '';
  if (p.reference) return [p.version, p.reference].join('|');
  return [p.version, p.error?.code, p.error?.status || '', String(p.error?.context || '').slice(0, 80)].join('|');
}
async function hasSignal(env, scope, fp, now, log) {
  if (!fp) return false;
  return !!await storeGet(env, `${scope}:${fp}`, now, log);
}
async function rememberSignal(env, scope, fp, windowMs, now, log) {
  if (!fp) return;
  await storePut(env, `${scope}:${fp}`, '1', windowMs, now, log);
}
export async function isDuplicate(env, fp, now = Date.now()) {
  return hasSignal(env, 'fp', fp, now, incidentLogger(env));
}
// Marked only after Discord accepted the report, so a failed delivery can be retried.
export async function markSeen(env, fp, now = Date.now(), windowMs = DEDUPE_WINDOW_MS) {
  return rememberSignal(env, 'fp', fp, windowMs, now, incidentLogger(env));
}

// Keep technical identifiers in the footer; the body explains what happened in plain language.
const AUTO_ERROR_COPY = {
  uncaught_exception: ['Extension error', 'An extension script failed unexpectedly. Use the technical cause and script position below to investigate.'],
  unhandled_rejection: ['Extension promise failed', 'An extension task failed without handling its result. Use the technical cause and script position below to investigate.'],
  background_error: ['Background task failed', 'An extension background task failed. See the action and technical cause below.'],
  queue_item_failed: ['Collection download failed', 'A queued file could not finish downloading. See the technical cause and download flow below.'],
  requires_login: ['Sign in to Nexus Mods', 'Nexus Mods needs a signed-in account for this download. Sign in, return to the file or collection page, then retry.'],
  cloudflare: ['Browser verification needed', 'Open the Nexus file page and complete the browser check, then retry.'],
  rate_limited: ['Nexus requests paused', 'Nexus is receiving too many requests. Wait before retrying; a paused collection queue resumes automatically.'],
  account_suspended: ['Downloads temporarily paused by Nexus', 'Nexus has temporarily stopped further download requests. Wait before trying again; repeated attempts may extend the pause.'],
  timeout: ['Nexus took too long to respond', 'A download link did not arrive in time. Check your connection, then retry.'],
  offline: ['No internet connection', 'Reconnect to the internet, then retry.'],
  network_error: ['Nexus request could not complete', 'The browser could not complete the request or read the response. The cause may be a connection problem, a blocked request or an unreadable redirect. See the technical cause below.'],
  request_failed: ['Download request failed', 'The request could not be completed. Retry; if it keeps happening, send a bug report from Help & Bugs.'],
  server_error: ['Nexus is having trouble', 'Nexus returned a server error. Wait a little, then retry.'],
  access_denied: ['Download access denied', 'Check your Nexus account permissions and the file page before retrying.'],
  file_not_found: ['File no longer available', 'The file may have been removed or the link may be outdated. Check the mod page for another version.'],
  mod_unavailable: ['Mod no longer available', 'The mod has been hidden or removed. Check its Nexus page for details.'],
  moderation_hold: ['File awaiting Nexus review', 'Nexus is reviewing this file. It cannot be downloaded until the review is complete.'],
  missing_file: ['No file selected', 'Open the mod Files tab and choose a file to download.'],
  nexus_page_changed: ['Nexus page may have changed', 'The page no longer matches what the extension expects. Send a bug report from Help & Bugs.'],
  nexus_api_changed: ['Nexus response may have changed', 'The extension could not read the Nexus response. Send a bug report from Help & Bugs.'],
  invalid_response: ['Unexpected response from Nexus', 'Refresh the file page, then retry.'],
  no_download_url: ['No download link received', 'Nexus did not return a usable file link. Open the file page, check your sign-in, then retry.'],
  no_nmm_link: ['No Vortex link received', 'Nexus did not return a signed nxm:// link for Vortex. Check the file page and retry, or switch to browser downloads.'],
  popup_error: ['Popup action failed', 'An action in the extension popup could not complete. See the technical cause below.'],
  unsafe_download_url: ['Download link blocked for safety', 'The returned link was not a trusted download destination. Do not open it manually; send a bug report from Help & Bugs.'],
  short_file: ['Download incomplete', 'The download stopped before the whole file arrived. Retry from the file page.'],
  empty_file: ['Downloaded file is empty', 'Retry from the Nexus file page. If the file is still empty, check the mod page for another version.'],
  not_a_file: ['Nexus returned a page instead of a file', 'Open the file page, check your sign-in and any browser verification, then retry.'],
  download_not_started: ['Browser download did not start', 'Check your browser download settings and folder, then retry.']
};

function compactBrowser(value) {
  const ua = String(value || '').trim();
  // Check derivatives first: Edge and Opera user agents also contain Chrome/Safari.
  for (const [pattern, name] of [
    [/\bEdg(?:A|iOS)?\/(\d+)/i, 'Edge'],
    [/\bOPR\/(\d+)/i, 'Opera'],
    [/\b(?:Firefox|FxiOS)\/(\d+)/i, 'Firefox'],
    [/\b(?:Chrome|CriOS)\/(\d+)/i, 'Chrome'],
    [/\bVersion\/(\d+).*\bSafari\//i, 'Safari']
  ]) {
    const match = ua.match(pattern);
    if (match) return `${name} ${match[1]}`;
  }
  const short = ua.match(/^(Edge|Opera|Firefox|Chrome|Safari|Brave)\s+(\d+)/i);
  return short ? `${short[1]} ${short[2]}` : 'Unknown browser';
}

export function discordMessage(p, id, mentionUserId = '', relayVersion = '') {
  // Only trusted Worker configuration can nominate a recipient, never report input.
  const recipient = typeof mentionUserId === 'string' && /^\d{17,20}$/.test(mentionUserId) ? mentionUserId : '';
  const identity = {
    username: 'NexusMods Bypass · User reports',
    ...(recipient ? { content: `<@${recipient}>` } : {}),
    allowed_mentions: recipient ? { parse: [], users: [recipient] } : { parse: [] }
  };
  if (p.kind === 'auto') {
    const error = p.error;
    const classification = classificationOf(p, relayVersion);
    const securityBlocked = ['FILE_VIRUS_INFECTED', 'FILE_BLOCKED', 'FILE_SECURITY_CHECK_FAILED'].includes(error.causeCode)
      || /\b(?:FILE_VIRUS_INFECTED|FILE_BLOCKED|FILE_SECURITY_CHECK_FAILED)\b/.test(error.message || '');
    const [title, description] = securityBlocked
      ? ['Download blocked by security software', 'The browser or security software blocked this file. Keep the protection enabled and check the file with its author or Nexus Mods.']
      : Object.hasOwn(AUTO_ERROR_COPY, error.code)
      ? AUTO_ERROR_COPY[error.code]
      : ['Action could not complete', error.message?.trim()
        ? 'An extension action could not complete. See the technical cause below.'
        : 'Try again. If the problem continues, send a bug report from Help & Bugs.'];
    const fields = [];
    const context = [p.page, error.context?.trim().split(/\r?\n/)[0], error.action].filter(Boolean);
    if (context.length) fields.push({ name: 'Context', value: clip(quiet(context.join(' · ')), 450), inline: false });
    if (error.message?.trim()) fields.push({ name: 'Technical cause', value: clip(quiet(error.message), 300), inline: false });
    const diagnostics = [error.frame ? `Script: ${error.frame}` : '', error.causeCode ? `Cause: ${error.causeCode}` : '',
      p.occurrences ? `Occurrences: ${p.occurrences}` : ''];
    if (p.firstAt && p.lastAt) diagnostics.push(p.firstAt === p.lastAt
      ? `Observed (UTC): ${p.firstAt}` : `Observed (UTC): ${p.firstAt} → ${p.lastAt}`);
    if (diagnostics.some(Boolean)) fields.push({ name: 'Diagnostics', value: clip(quiet(diagnostics.filter(Boolean).join('\n')), 650), inline: false });
    const status = Number(error.status);
    const http = Number.isInteger(status) && status >= 100 && status <= 599 ? ` · HTTP ${status}` : '';
    return {
      ...identity,
      embeds: [fitEmbed({
        title: `Automatic ${classification.level} · ${title}`, description,
        color: classification.level === 'warning' ? COLORS.warning : COLORS.critical, fields,
        footer: { text: quiet(`v${clip(p.version, 20)} · ${compactBrowser(p.browser)} · ${clip(error.code, 80)}${http}${p.reference ? ` · ${p.reference}` : ''}${classification.client === 'older' ? ` · older client (relay baseline v${classification.relayVersion})` : ''} · id ${clip(id, 40)}`) },
        timestamp: new Date().toISOString()
      })]
    };
  }
  const fields = [
    { name: 'Version', value: clip(p.version, 40), inline: true },
    { name: 'Kind', value: p.kind, inline: true },
    { name: 'Browser', value: compactBrowser(p.browser), inline: true }
  ];
  if (p.page) fields.push({ name: 'Page', value: clip(quiet(p.page), 200), inline: true });
  if (p.category) fields.push({ name: 'Area', value: p.category, inline: true });
  if (p.currentError?.code) fields.push({ name: 'Current error', value: clip(quiet(p.currentError.code), 200) });
  if (p.reference) fields.push({ name: 'Error reference', value: p.reference, inline: true });
  if (p.steps) fields.push({ name: 'Steps to reproduce', value: clip(quiet(p.steps), 1000) });
  if (p.expected) fields.push({ name: 'Expected result', value: clip(quiet(p.expected), 1000) });
  fields.push({ name: 'Logged errors', value: String(p.errors?.length || 0), inline: true });
  fields.push({ name: 'Debug lines', value: String(p.logs?.length || 0), inline: true });
  if (p.contact) fields.push({ name: 'Contact', value: clip(quiet(p.contact), 120) });
  // The report sits in a code block, so its own fences are broken up rather than closing it early.
  const reportBlock = p.report ? `\`\`\`\n${clip(p.report, 1500).replace(/```/g, '``\u200b`')}\n\`\`\`` : '';
  return {
    ...identity,
    embeds: [fitEmbed({
      title: `Bug report · ${clip(quiet(p.summary || 'User report'), 160)}`,
      // Discord rejects an embed over 6000 characters in total; fields take at most ~2600 here.
      description: clip(quiet(p.note || reportBlock), 3000),
      color: SEVERITY_COLORS[severityOf(p)],
      fields,
      footer: { text: `id ${id}` },
      timestamp: new Date().toISOString()
    })]
  };
}

// Resend is a second destination for every report, and the copy that survives when Discord fails.
// Best effort: it never throws, and a refusal is logged rather than retried.
async function sendEmail(env, p, id, log) {
  if (!env.RESEND_API_KEY || !env.REPORT_EMAIL_TO || !env.REPORT_EMAIL_FROM) return false;
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: env.REPORT_EMAIL_FROM,
        to: env.REPORT_EMAIL_TO,
        subject: `[NexusMods Bypass] ${p.kind === 'auto' ? `auto error ${p.error.code}` : 'bug report'} ${p.version} (${id})`,
        text: JSON.stringify(p, null, 2).slice(0, 60000)
      }),
      ...(typeof globalThis.AbortSignal?.timeout === 'function' ? { signal: globalThis.AbortSignal.timeout(10000) } : {})
    });
    await response.text().catch(() => '');
    if (!response.ok) log('email_failed', { id, status: response.status });
    return response.ok;
  } catch (cause) {
    log('email_failed', { id, cause });
    return false;
  }
}

// The body is read in chunks and abandoned once it passes the limit, so a client that sends no
// Content-Length cannot make the Worker buffer an arbitrarily large upload. Null means too large.
async function readBodyCapped(request, maxBytes) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function handleRequest(request, env, ctx, headers, log) {
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
  const text = await readBodyCapped(request, MAX_BODY_BYTES);
  if (text === null) return json({ error: 'too large' }, 413, headers);

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (_) {
    return json({ error: 'invalid json' }, 400, headers);
  }
  const problem = validateReport(payload);
  if (problem) return json({ error: problem }, 422, headers);
  const now = Date.now();
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (!await allow(env, ip, payload.kind, now, log)) {
    return json({ error: 'rate limited' }, 429, { ...headers, 'retry-after': String(secondsUntilNextHour(now)) });
  }

  if (!env.DISCORD_WEBHOOK_URL) return json({ error: 'relay not configured' }, 503, headers);
  const fp = fingerprintOf(payload);
  if (await hasSignal(env, 'fp', fp, now, log)) return json({ ok: true, duplicate: true }, 200, headers);
  const id = crypto.randomUUID().slice(0, 8);
  const mention = mentionWorthy(payload, env.RELAY_EXTENSION_VERSION)
    && (!fp || !await hasSignal(env, 'ping', fp, now, log));
  const message = discordMessage(payload, id, mention ? env.REPORT_MENTION_USER_ID : '', env.RELAY_EXTENSION_VERSION);
  const body = new FormData();
  const attachment = payload.kind === 'manual' ? payload : automaticAttachment(payload, env.RELAY_EXTENSION_VERSION);
  const filename = payload.kind === 'manual' ? `nexusmods-report-${id}.json` : `SPOILER_nexusmods-auto-report-${id}.json`;
  if (payload.kind === 'auto') message.attachments = [{ id: 0, filename, is_spoiler: true, description: 'Technical diagnostics (JSON)' }];
  body.set('payload_json', JSON.stringify(message));
  // Spoiler-mark the automatic attachment so its JSON preview does not duplicate the compact embed.
  body.set('files[0]', new Blob([JSON.stringify(attachment, null, 2)], { type: 'application/json' }), filename);
  const delivery = await postWebhook(env.DISCORD_WEBHOOK_URL, body, DELIVERY_OPTIONS);
  const email = sendEmail(env, attachment, id, log);
  if (ctx?.waitUntil) ctx.waitUntil(email);

  if (!delivery.ok) {
    log('discord_delivery_failed', {
      id, kind: payload.kind, code: payload.error?.code, version: payload.version,
      status: delivery.status, attempts: delivery.attempts, detail: delivery.error
    });
    // Discord is throttling the webhook: tell the client how long, so its queue waits that out
    // instead of retrying into the same limit.
    if (delivery.status === 429) {
      const seconds = Math.max(1, Math.ceil((delivery.retryAfterMs ?? 60000) / 1000));
      return json({ error: 'upstream rate limited' }, 429, { ...headers, 'retry-after': String(seconds) });
    }
    return json({ error: 'upstream failed' }, 502, headers);
  }
  // Bookkeeping after delivery cannot fail the request: the report is already in Discord, and an
  // error here would make the client send it again.
  const deliveredAt = Date.now();
  await rememberSignal(env, 'fp', fp, reportWindow(payload), deliveredAt, log);
  if (message.content) await rememberSignal(env, 'ping', fp, MENTION_WINDOW_MS, deliveredAt, log);
  return json({ ok: true, id }, 200, headers);
}

export default {
  async fetch(request, env, ctx) {
    const log = incidentLogger(env);
    let headers = { ...CORS, vary: 'origin' };
    try {
      headers = corsHeaders(request, env);
      return await handleRequest(request, env, ctx, headers, log);
    } catch (cause) {
      // Left uncaught, this is Cloudflare's own 500 page without CORS headers, which the extension
      // can only read as "Failed to fetch".
      log('unhandled_error', { cause });
      return json({ error: 'internal error' }, 500, headers);
    }
  }
};
