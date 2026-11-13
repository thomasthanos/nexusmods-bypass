import type { D1Database } from '@cloudflare/workers-types';
import { compare, validate } from 'compare-versions';
import { ENVIRONMENT_CATEGORIES } from './ruleEngine.ts';

// Marks an issue fixed once it has stopped happening, so nobody has to. Copies that have not updated keep
// sending what they always sent (a Firefox add-on can take days to update), and an issue fixed in a
// release still looked new. An issue counts as fixed when every browser it happened on has run a newer
// version for AUTO_FIX_SETTLE_MS, seen at least AUTO_FIX_MIN_EVIDENCE times in other issues' reports and
// in heartbeats, and none of those newer copies reported it. "Fixed in" is the first newer version seen.
// A report from that version or a newer one undoes it: a newer one regresses it at ingestion as for any
// fixed issue, and this pass puts back an issue that the version it named still reports.
// An issue in an environment category (ruleEngine.ts) is left alone: it stops when the network or Nexus
// recovers, not with a release, so marking it fixed only made the next outage regress it and send a
// regression alert for nothing.
export const AUTO_FIX_SETTLE_MS = 2 * 24 * 60 * 60 * 1000;
export const AUTO_FIX_MIN_EVIDENCE = 3;

type OpenIssue = { id: number; status: 'new' | 'investigating' | 'regressed'; fixed_in_version: string | null;
  first_seen_version: string; last_seen_version: string; updated_at: number };
type Seen = { browser: string; version: string; n: number; first_at: number };
type Reported = { issue_id: number; browser: string; version: string };
type AutoFix = { issue_id: number; fixed_in_version: string; previous_status: string; previous_fixed_in_version: string | null;
  status: string; current_version: string | null; updated_at: number };

export type AutoFixResult = { fixed: { id: number; fixed_in_version: string }[]; reopened: number[] };

// Open issues a release can fix.
const FIXABLE = `status IN ('new', 'investigating', 'regressed')
  AND category NOT IN (${ENVIRONMENT_CATEGORIES.map(() => '?').join(', ')})`;

const newest = (versions: string[]) => versions.reduce((best, version) => compare(version, best, '>') ? version : best);
const oldest = (versions: string[]) => versions.reduce((best, version) => compare(version, best, '<') ? version : best);

// What each issue would be fixed in, or nothing while the evidence is not there yet.
export function autoFixVersion(reported: Reported[], seen: Seen[], issue: OpenIssue, now: number): { version: string; browsers: string[] } | null {
  const versions = [issue.first_seen_version, issue.last_seen_version, ...reported.map((row) => row.version)];
  const browsers = [...new Set(reported.map((row) => row.browser))].sort();
  // Without its reports there is no telling which browsers to watch.
  if (!browsers.length || !versions.every((version) => validate(version))) return null;
  const lastBad = newest(versions);
  const firstClean: string[] = [];
  for (const browser of browsers) {
    const newer = seen.filter((row) => row.browser === browser && validate(row.version) && compare(row.version, lastBad, '>'));
    const count = newer.reduce((sum, row) => sum + Number(row.n), 0);
    const since = Math.min(...newer.map((row) => Number(row.first_at)));
    if (count < AUTO_FIX_MIN_EVIDENCE || !(since <= now - AUTO_FIX_SETTLE_MS)) return null;
    firstClean.push(oldest(newer.map((row) => row.version)));
  }
  return { version: oldest(firstClean), browsers };
}

export async function autoFixIssues(db: D1Database, now = Date.now()): Promise<AutoFixResult> {
  const result: AutoFixResult = { fixed: [], reopened: [] };

  // An issue this pass fixed and the version it named still reports goes back as it was; one that has
  // been changed since (by hand, or regressed by a newer version) is no longer this pass's to undo.
  const autoFixed = (await db.prepare(`SELECT a.issue_id, a.fixed_in_version, a.previous_status, a.previous_fixed_in_version,
      i.status, i.fixed_in_version AS current_version, i.updated_at
    FROM issue_auto_fixes a JOIN issues i ON i.id = a.issue_id`).all<AutoFix>()).results ?? [];
  for (const row of autoFixed) {
    const forget = db.prepare('DELETE FROM issue_auto_fixes WHERE issue_id=? AND fixed_in_version=?').bind(row.issue_id, row.fixed_in_version);
    if (row.status !== 'fixed' || row.current_version !== row.fixed_in_version) {
      await forget.run();
      continue;
    }
    const versions = (await db.prepare('SELECT DISTINCT version FROM reports WHERE issue_id=?').bind(row.issue_id).all<{ version: string }>()).results ?? [];
    if (!versions.some(({ version }) => validate(version) && compare(version, row.fixed_in_version, '>='))) continue;
    const [restored] = await db.batch([
      db.prepare(`UPDATE issues SET status=?, fixed_in_version=?, updated_at=max(updated_at, ?)
        WHERE id=? AND status='fixed' AND fixed_in_version=? AND updated_at=? RETURNING id`)
        .bind(row.previous_status, row.previous_fixed_in_version, now, row.issue_id, row.fixed_in_version, row.updated_at),
      forget
    ]);
    if (restored?.results?.length) result.reopened.push(row.issue_id);
  }

  const open = (await db.prepare(`SELECT id, status, fixed_in_version, first_seen_version, last_seen_version, updated_at
    FROM issues WHERE ${FIXABLE}`).bind(...ENVIRONMENT_CATEGORIES).all<OpenIssue>()).results ?? [];
  if (!open.length) return result;
  // Every version each browser has been seen running: any issue's reports (relayed copies included) and
  // the heartbeats of private diagnostics.
  const seen = (await db.prepare(`SELECT browser, version, SUM(n) AS n, MIN(first_at) AS first_at FROM (
      SELECT browser, version, COUNT(*) AS n, MIN(created_at) AS first_at FROM reports GROUP BY browser, version
      UNION ALL
      SELECT browser, version, COUNT(*) AS n, MIN(created_at) AS first_at FROM heartbeat_receipts GROUP BY browser, version
    ) GROUP BY browser, version`).all<Seen>()).results ?? [];
  const reported = (await db.prepare(`SELECT issue_id, browser, version FROM reports
    WHERE issue_id IN (SELECT id FROM issues WHERE ${FIXABLE})
    GROUP BY issue_id, browser, version`).bind(...ENVIRONMENT_CATEGORIES).all<Reported>()).results ?? [];

  for (const issue of open) {
    const fix = autoFixVersion(reported.filter((row) => row.issue_id === issue.id), seen, issue, now);
    if (!fix) continue;
    // Both or neither: the record is written only if the issue was still as read (a report arriving in
    // between moves updated_at, and the next pass decides again).
    const [changed] = await db.batch([
      db.prepare(`UPDATE issues SET status='fixed', fixed_in_version=?, updated_at=max(updated_at, ?)
        WHERE id=? AND status=? AND fixed_in_version IS ? AND updated_at=? RETURNING id`)
        .bind(fix.version, now, issue.id, issue.status, issue.fixed_in_version, issue.updated_at),
      db.prepare(`INSERT OR REPLACE INTO issue_auto_fixes (issue_id, fixed_in_version, previous_status, previous_fixed_in_version, browsers_json, fixed_at)
        SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM issues WHERE id=? AND status='fixed' AND fixed_in_version=? AND updated_at=max(?, ?))`)
        .bind(issue.id, fix.version, issue.status, issue.fixed_in_version, JSON.stringify(fix.browsers), now,
          issue.id, fix.version, issue.updated_at, now)
    ]);
    if (changed?.results?.length) result.fixed.push({ id: issue.id, fixed_in_version: fix.version });
  }
  return result;
}

// The record of an issue this pass fixed, while the issue still is as it left it.
export async function autoFixOf(db: D1Database, issueId: number): Promise<{ fixed_in_version: string; fixed_at: number; browsers: string[] } | null> {
  const row = await db.prepare(`SELECT a.fixed_in_version, a.fixed_at, a.browsers_json FROM issue_auto_fixes a JOIN issues i ON i.id = a.issue_id
    WHERE a.issue_id=? AND i.status='fixed' AND i.fixed_in_version = a.fixed_in_version`).bind(issueId)
    .first<{ fixed_in_version: string; fixed_at: number; browsers_json: string }>();
  return row ? { fixed_in_version: row.fixed_in_version, fixed_at: row.fixed_at, browsers: JSON.parse(row.browsers_json) as string[] } : null;
}
