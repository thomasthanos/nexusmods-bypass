import type { D1Database } from '@cloudflare/workers-types';
import { compare } from 'compare-versions';
import type { ErrorReport, Heartbeat } from '../schemas/ingest.ts';
import { fingerprintReport } from '../utils/fingerprint.ts';
import { countedInstall } from '../utils/installs.ts';
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
            SELECT COUNT(DISTINCT ${countedInstall('recent.install_id')}) FROM reports AS recent
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
