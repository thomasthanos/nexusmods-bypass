# Phase 2: Complete core relay engine

Complete, unabbreviated Phase 2 runtime sources. Phase 1 contracts and database schema remain in diagnostics/. No Phase 3 server or Phase 4 PWA is included. The executable source files are authoritative.

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

Push payloads contain the full fingerprint as `tag`, a provider `Topic` of at most 32 characters, an HTTPS `/?issue=<id>` deep link, badge count, trigger, and issue identity. Regression, new critical, and upstream alerts use high urgency. `sendTestNotification` delivers a test push without creating an issue, sending Discord, or changing issue cooldowns; its protected admin endpoint belongs to Phase 3 and its service-worker display belongs to Phase 4.

### Delivery outcomes and bounds

Both senders return `DeliveryResult` with `ok`, HTTP `status`, `retryable`, `expired`, bounded `retry_after_ms`, and a safe `reason`. Secrets and provider bodies never appear in the result. A successful result means provider acceptance; lock-screen display and user acknowledgement cannot be verified by the sender.

Push endpoints are restricted to HTTPS Apple `*.push.apple.com`, Google `fcm.googleapis.com`, Mozilla `push.services.mozilla.com` and its subdomains, and Microsoft `*.notify.windows.com`. Other providers require an intentional allowlist extension. The service validates canonical base64url key sizes/curve points, matching VAPID keys and contact subject, encrypted plaintext size, URL authorities, and expiration. It does not follow redirects. HTTP 404/410 subscriptions are removed only when their stored endpoint and keys still match the attempted values, protecting concurrent key rotation. Cleanup failures do not abort other sends or discard accepted-delivery cooldowns.

Discord accepts validated Discord-owned incoming webhook URLs, uses `wait=true`, disables all mentions, and clips Unicode safely within Discord embed limits. It includes a selected diagnostic summary, environment, suggested action, recent timeline, bounded stack, fingerprint, and issue link; installation IDs stay out of embeds.

HTTP attempts time out within five seconds and do not read unbounded response bodies. Retryable provider responses include a bounded `Retry-After` duration of at most 24 hours. The transports do not sleep or automatically retry; callers receive the outcome. Push fan-out uses four workers, an eighteen-second work budget, and at most 100 subscriptions per dispatch. Unattempted/failed deliveries are reported; partial acceptance starts cooldown to avoid resending successful devices. Every started worker settles before a claim is completed or released, and Discord's promise settles independently of push bookkeeping failures.

Delivery uses `waitUntil` best effort rather than a durable queue. Failed all-device sends release the claim and remain eligible for a later explicit retry, but this phase creates no background retry scheduler. Discord has no persisted channel-specific delivery receipt; the ingestion transaction must invoke it once per newly accepted report. An interrupted request/provider timeout can still have an uncertain delivery outcome. Durable exactly-once external delivery is not claimed.

## diagnostics/src/utils/sanitize.ts

```typescript
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
```

## diagnostics/src/utils/fingerprint.ts

```typescript
import { parse } from 'error-stack-parser-es';
import type { ErrorReport } from '../schemas/ingest.ts';
import { sanitizeReport, sanitizeText, sanitizeUrl } from './sanitize.ts';

const UNKNOWN_FRAME = '<unknown>';

function recognizableFile(value: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:\/\/|[A-Za-z]:[\\/]|\/|\.{1,2}\/)/i.test(value)
    || /(?:^|[\\/])[^@:\s]+\.(?:[cm]?[jt]sx?|html?|wasm)(?::\d+)*$/i.test(value);
}

/** All source positions are removed: extension bundles do not reliably identify minified frames. */
export function normalizeStack(stack: string | undefined): string {
  if (!stack?.trim()) return UNKNOWN_FRAME;
  // Parse the stack grammar before sanitizing each emitted component: Firefox's relative
  // function@file.js syntax can otherwise be mistaken for a private email address.
  const parserStack = stack.slice(0, 12_000).split('\n').slice(0, 80).map((line) => {
    // URL query removal can also consume a trailing stack position. The parser needs a position
    // to recognize V8 frames, so supply a synthetic one; no positions enter normalized output.
    if (/^\s*at\s+/.test(line) && !/:\d+(?::\d+)?\)?$/.test(line)) {
      return line.endsWith(')') ? `${line.slice(0, -1)}:0:0)` : `${line}:0:0`;
    }
    return line;
  }).join('\n');
  try {
    const error = new Error();
    error.stack = parserStack;
    const frames = parse(error).flatMap((frame) => {
      if (!frame.fileName || !recognizableFile(frame.fileName)) return [];
      if (frame.lineNumber === undefined && !/^(?:[a-z][a-z0-9+.-]*:\/\/|[A-Za-z]:[\\/]|\/)/i.test(frame.fileName)) return [];
      let file = sanitizeUrl(frame.fileName).replace(/:\d+(?::\d+)?$/, '');
      file = file.replace(/^(?:chrome|moz|safari-web)-extension:\/\/[^/]*\//i, 'extension:///');
      const name = sanitizeText(frame.functionName ?? '<anonymous>').replace(/\([^)]*\)/g, '').replace(/[\r\n]/g, ' ').trim().slice(0, 120) || '<anonymous>';
      return [`${name}@${file.slice(0, 512)}`];
    }).slice(0, 20);
    return frames.length > 0 ? frames.join('\n').slice(0, 12_000) : UNKNOWN_FRAME;
  } catch {
    return UNKNOWN_FRAME;
  }
}

export function normalizedTopFrame(stack: string | undefined): string {
  return normalizeStack(stack).split('\n')[0] ?? UNKNOWN_FRAME;
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function fingerprintReport(report: ErrorReport): Promise<{
  fingerprint: string;
  normalized_top_frame: string;
  normalized_stack: string;
}> {
  const safeReport = sanitizeReport(report);
  const normalized_stack = normalizeStack(report.stack_trace);
  const normalized_top_frame = normalized_stack.split('\n')[0] ?? UNKNOWN_FRAME;
  const fingerprint = await sha256(JSON.stringify([
    safeReport.error_category, safeReport.error_code, safeReport.failure_stage, normalized_top_frame, safeReport.destination
  ]));
  return { fingerprint, normalized_top_frame, normalized_stack };
}
```

## diagnostics/src/services/ruleEngine.ts

```typescript
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
    suggested_action: 'Έλεγχος της δομής HTML/API του Nexus και άμεση προετοιμασία hotfix· το ίδιο δομικό σφάλμα επηρεάζει πολλαπλές εγκαταστάσεις.',
    upstream_breaking_change: true,
  };
}
```

## diagnostics/src/services/delivery.ts

```typescript
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

async function validateSubscription(target: PushTarget, now: number): Promise<URL> {
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
```

## diagnostics/src/services/notifications.ts

```typescript
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
  const issue = await db.prepare(`SELECT i.id,i.fingerprint,i.status,i.muted,i.fixed_in_version,i.last_pushed_at
    FROM issues i JOIN report_receipts receipt ON receipt.issue_id=i.id
    WHERE i.id=? AND receipt.id=? AND receipt.install_id=?`
  ).bind(input.issueId, report.report_id, report.install_id).first<IssueState>();
  if (!issue) throw new Error('Report must be persisted for the selected issue before delivery');
  const sanitizedInput = { ...input, report };
  // Discord is independent of push mute/cooldown and receives every newly
  // accepted report. The ingestion transaction must not schedule report retries.
  const [discord, push] = await Promise.allSettled([
    sendDiscordReport(config.discordWebhookUrl, report, {
      issueId: issue.id, fingerprint: issue.fingerprint, dashboardOrigin: resolved.origin,
      category: input.rule.category, faultOrigin: input.rule.fault_origin, suggestedAction: input.rule.suggested_action
    }, { timeoutMs: resolved.requestTimeoutMs, now }),
    issuePush(db, issue, sanitizedInput, config, resolved, now)
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
```

## Verification

Verified on 2026-10-21: all 115 diagnostics tests pass; TypeScript checking passes; all five runtime modules bundle for browser/Web API execution with no external runtime imports; existing extension tests and repository lint pass. Independent review findings were reproduced and fixed with regression tests. Web Push tests decrypt the actual RFC 8291 ciphertext and verify VAPID signatures. HTTP boundaries are mocked; no live subscription, iPhone display, or deployment is claimed.

Tests: <a href="../diagnostics/test/sanitize.test.mjs"><kbd>sanitize</kbd></a>, <a href="../diagnostics/test/fingerprint.test.mjs"><kbd>fingerprints</kbd></a>, <a href="../diagnostics/test/ruleEngine.test.mjs"><kbd>rules</kbd></a>, <a href="../diagnostics/test/delivery.test.mjs"><kbd>delivery</kbd></a>, <a href="../diagnostics/test/notifications.test.mjs"><kbd>orchestration</kbd></a>, and the <a href="../diagnostics/test/helpers/d1.mjs"><kbd>SQLite D1 adapter</kbd></a>. Setup and full integration contracts: <a href="../diagnostics/README.md"><kbd>README</kbd></a>. Phase 1 sources: <a href="diagnostics-phase-1.md"><kbd>complete delivery</kbd></a>.
