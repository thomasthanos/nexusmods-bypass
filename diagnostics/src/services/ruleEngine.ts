import type { D1Database } from '@cloudflare/workers-types';
import type { ErrorReport } from '../schemas/ingest.ts';
import { countedInstall } from '../utils/installs.ts';

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
    SELECT COUNT(DISTINCT ${countedInstall('install_id')}) AS distinct_installs
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
