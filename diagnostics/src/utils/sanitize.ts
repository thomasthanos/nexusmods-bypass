import { errorReportSchema, MAX_BODY_BYTES } from '../schemas/ingest.ts';
import type { ErrorReport } from '../schemas/ingest.ts';

export const REDACTED = '[REDACTED]';
const MAX_TEXT_LENGTH = 12_000;
const MAX_SCAN_LENGTH = 24_000;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SECRET_KEYS = new Set([
  'authorization', 'proxyauthorization', 'cookie', 'cookies', 'setcookie', 'session', 'sessionid',
  'sessiontoken', 'token', 'auth', 'authtoken', 'accesstoken', 'refreshtoken', 'idtoken', 'apikey',
  'key', 'personalkey', 'nexuskey', 'nexuspersonalkey', 'nexusapikey', 'password', 'passwd', 'pwd',
  'secret', 'secretkey', 'clientsecret', 'privatekey', 'credential', 'credentials',
  'extensionid', 'extensionuuid', 'originid', 'browserextensionid', 'jsessionid', 'phpsessid'
]);

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SECRET_KEYS.has(normalized)
    || /(?:authorization|cookies?|apikey|personalkey|token|sessionid|password|clientsecret|secretkey)$/.test(normalized)
    || /^data.*(?:token|secret|key)$/.test(normalized);
}

function redactAssignments(value: string): string {
  const text = value
    .replace(/(\[\s*)(["'])([A-Za-z][A-Za-z0-9_.:-]{0,64})\2(\s*,\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g,
      (match: string, prefix: string, quote: string, key: string, separator: string) =>
        isSecretKey(key) ? `${prefix}${quote}${key}${quote}${separator}${quote}${REDACTED}${quote}` : match)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/(^|[\s{;,])((?:proxy-)?authorization|(?:set-)?cookie)\s*:\s*(?!["'])[^\r\n]*/gi,
      (_match, prefix: string, key: string) => `${prefix}${key}: ${REDACTED}`);
  const assignment = /(?<![A-Za-z0-9_.:-])(["']?)([A-Za-z][A-Za-z0-9_.:-]{0,64})(\1)(\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[REDACTED\]|[^\s,;}\])]+)/g;
  const result: string[] = [];
  let cursor = 0;
  for (let match = assignment.exec(text); match; match = assignment.exec(text)) {
    const [, opening = '', key = '', closing = '', separator = '', content = ''] = match;
    if (!isSecretKey(key)) {
      // Continue inside log containers such as headers={"Authorization":"..."}.
      assignment.lastIndex = match.index + opening.length + key.length + closing.length + separator.length;
      continue;
    }
    const quote = content.startsWith('"') || content.startsWith("'") ? content[0] : '';
    result.push(text.slice(cursor, match.index), `${opening}${key}${closing}${separator}${quote}${REDACTED}${quote}`);
    cursor = assignment.lastIndex;
  }
  result.push(text.slice(cursor));
  return result.join('');
}

function maskIdentities(value: string): string {
  return value
    .replace(/\b([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\r\n]+/gi, `$1${REDACTED}`)
    .replace(/(^|[^A-Za-z0-9_])((?:\/Users|\/home)\/)[^/\r\n]+/gi, `$1$2${REDACTED}`)
    .replace(/\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,63}\b/gi, REDACTED)
    .replace(/(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g, (candidate) =>
      candidate.split('.').every((part) => Number(part) <= 255) ? REDACTED : candidate)
    .replace(/\[[0-9A-Fa-f]*:[0-9A-Fa-f:.%]+\]/g, REDACTED)
    .replace(/(?<![\w:])(?:[0-9a-f]{0,4}:){2,}[0-9a-f:.]*(?![\w:])/gi, (candidate) => {
      try {
        new URL(`http://[${candidate}]/`);
        return REDACTED;
      } catch {
        return candidate;
      }
    })
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\b/g, REDACTED);
}

function decodePath(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function sanitizePath(value: string): string {
  return redactAssignments(maskIdentities(decodePath(value)))
    .replace(/(\/(?:token|api[-_]?key|personal[-_]?key|session(?:[-_]?token)?|secret|password)\/)[^/]+/gi, `$1${REDACTED}`);
}

/** Removes all URL queries/fragments, userinfo, extension origins and private path components. */
export function sanitizeUrl(value: string): string {
  const bounded = value.slice(0, MAX_SCAN_LENGTH).replace(/\u0000/g, '');
  try {
    const url = new URL(bounded);
    // Opaque URLs (data:, javascript:, mailto:) carry arbitrary contents rather than useful endpoints.
    if (!url.host && url.protocol !== 'file:') return REDACTED;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    if (/^(?:chrome|moz|safari-web)-extension:$/.test(url.protocol)) url.hostname = 'extension';
    else if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(url.hostname) || url.hostname.startsWith('[')) url.hostname = 'redacted.invalid';
    url.pathname = sanitizePath(url.pathname);
    return url.toString().slice(0, MAX_TEXT_LENGTH);
  } catch {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(bounded)) return REDACTED;
    return sanitizePath(bounded.split(/[?#]/, 1)[0] ?? '').slice(0, MAX_TEXT_LENGTH) || REDACTED;
  }
}

function sanitizeString(value: string): string {
  let text = value.slice(0, MAX_SCAN_LENGTH).replace(/\u0000/g, '').replace(/\\(["'])/g, '$1');
  text = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`()\]{}]+/gi, (url) => sanitizeUrl(url));
  text = text.replace(/((?:\.{0,2}\/)[^\s<>"'`?#]*)[?#][^\s<>"'`()\]{}]*/g, '$1');
  return redactAssignments(maskIdentities(text)).slice(0, MAX_TEXT_LENGTH);
}

/** Sanitizes free-form messages, including JSON/log strings and serialized HTTP headers. */
export function sanitizeText(value: string): string {
  const bounded = value.slice(0, MAX_SCAN_LENGTH);
  if (/^\s*[\[{]/.test(bounded)) {
    try {
      return JSON.stringify(sanitizeDeep(JSON.parse(bounded))).slice(0, MAX_TEXT_LENGTH);
    } catch {
      // Log fragments and CSS selectors are deliberately handled as ordinary text.
    }
  }
  return sanitizeString(bounded);
}

/** Produces bounded JSON without invoking getters or carrying prototypes/cycles into storage. */
export function sanitizeDeep(value: unknown): unknown {
  const seen = new WeakSet<object>();
  let nodesRemaining = 512;
  let charactersRemaining = 32_768;
  function walk(input: unknown, depth: number): unknown {
    nodesRemaining -= 1;
    if (nodesRemaining < 0) return REDACTED;
    if (typeof input === 'string') {
      const result = sanitizeString(input).slice(0, Math.max(0, Math.min(1024, charactersRemaining)));
      charactersRemaining -= result.length;
      return result;
    }
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number') return Number.isFinite(input) && Math.abs(input) <= Number.MAX_SAFE_INTEGER ? input : null;
    if (typeof input !== 'object') return null;
    if (depth > 2 || seen.has(input)) return REDACTED;
    seen.add(input);
    try {
      if (Array.isArray(input)) {
        const first = Object.getOwnPropertyDescriptor(input, '0');
        if (input.length === 2 && first && 'value' in first && typeof first.value === 'string' && isSecretKey(first.value)) {
          return [sanitizeString(first.value).slice(0, 1024), REDACTED];
        }
        const result: unknown[] = [];
        for (let index = 0; index < Math.min(input.length, 16); index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
          result.push(descriptor && 'value' in descriptor ? walk(descriptor.value, depth + 1) : REDACTED);
        }
        return result;
      }
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(input)) {
        if (Object.keys(result).length >= 32) break;
        if (UNSAFE_KEYS.has(key) || !/^[A-Za-z0-9_.:-]{1,48}$/.test(key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        const safeKey = schemaText(key, 48, /^[A-Za-z0-9_.:-]+$/);
        result[safeKey] = isSecretKey(key) ? REDACTED
          : descriptor && 'value' in descriptor ? walk(descriptor.value, depth + 1) : REDACTED;
      }
      return result;
    } catch {
      return REDACTED;
    }
  }
  return walk(value, 0);
}

function field(value: string, limit: number): string {
  return sanitizeText(value).slice(0, limit) || REDACTED;
}

function schemaText(value: string, limit: number, grammar: RegExp): string {
  const sanitized = sanitizeText(value);
  return sanitized.length > 0 && sanitized.length <= limit && grammar.test(sanitized) ? sanitized : 'REDACTED';
}

function identifier(value: string): string {
  return schemaText(value, 80, /^[A-Za-z][A-Za-z0-9_.:-]*$/);
}

function collectionToken(value: string): string {
  // Opaque collection slugs are retained unless they explicitly label a credential value.
  if (/^(?:bearer|basic|authorization|(?:nexus[-_]?)?(?:api[-_]?key|personal[-_]?key)|(?:access|refresh|session)[-_]?token|password|client[-_]?secret|secret[-_]?key)[-_]+/i.test(value)) return 'REDACTED';
  return schemaText(value, 64, /^[A-Za-z0-9_-]+$/);
}

/** Accepts a validated report and returns a fresh, still-valid report with private text removed. */
export function sanitizeReport(report: ErrorReport): ErrorReport {
  const sanitized: ErrorReport = {
    ...report,
    browser_version: schemaText(report.browser_version, 40, /^[A-Za-z0-9._+ -]+$/),
    error_category: identifier(report.error_category),
    error_code: identifier(report.error_code),
    failure_stage: identifier(report.failure_stage),
    error_name: field(report.error_name, 120),
    error_message: field(report.error_message, 2048),
    breadcrumbs: report.breadcrumbs.map((breadcrumb) => ({
      ...breadcrumb,
      stage: identifier(breadcrumb.stage),
      action: identifier(breadcrumb.action),
      metadata: sanitizeDeep(breadcrumb.metadata) as ErrorReport['breadcrumbs'][number]['metadata']
    })),
    context: { ...report.context }
  };
  if (report.os_version !== undefined) sanitized.os_version = schemaText(report.os_version, 40, /^[A-Za-z0-9._+ -]+$/);
  if (report.collection_id !== undefined) sanitized.collection_id = collectionToken(report.collection_id);
  if (report.stack_trace !== undefined) sanitized.stack_trace = field(report.stack_trace, 12_000);
  if (report.retry_after !== undefined) sanitized.retry_after = field(report.retry_after, 128);
  if (report.context.api_endpoint !== undefined) {
    const endpoint = sanitizeUrl(report.context.api_endpoint);
    if (endpoint.length <= 2048) sanitized.context.api_endpoint = endpoint;
    else delete sanitized.context.api_endpoint;
  }
  if (report.dom_state !== undefined) {
    sanitized.dom_state = {
      ...report.dom_state,
      selectors: report.dom_state.selectors.map((selector) => ({ ...selector, selector: field(selector.selector, 200) }))
    };
    if (report.dom_state.api_schema !== undefined) {
      sanitized.dom_state.api_schema = { ...report.dom_state.api_schema, missing_fields: report.dom_state.api_schema.missing_fields.map(identifier) };
      if (report.dom_state.api_schema.expected !== undefined) sanitized.dom_state.api_schema.expected = field(report.dom_state.api_schema.expected, 128);
      if (report.dom_state.api_schema.received !== undefined) sanitized.dom_state.api_schema.received = field(report.dom_state.api_schema.received, 128);
    }
  }
  const bytes = (): number => new TextEncoder().encode(JSON.stringify(sanitized)).byteLength;
  if (bytes() > MAX_BODY_BYTES) {
    // Redaction markers can be longer than short credentials. Retain scalar security/network evidence
    // while shedding free-form metadata before considering any chronological breadcrumbs.
    for (const breadcrumb of sanitized.breadcrumbs) {
      breadcrumb.metadata = Object.fromEntries(Object.entries(breadcrumb.metadata).filter(([, value]) => typeof value !== 'string' && (value === null || typeof value !== 'object')));
    }
    while (bytes() > MAX_BODY_BYTES && sanitized.breadcrumbs.length > 0) sanitized.breadcrumbs.pop();
  }
  return errorReportSchema.parse(sanitized);
}
