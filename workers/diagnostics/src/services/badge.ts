import type { D1Database } from '@cloudflare/workers-types';

/** Every notification carries the same outstanding issue and unread-review total. */
export async function appBadgeCount(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT (SELECT COUNT(*) FROM store_reviews WHERE acknowledged_at IS NULL)
    +(SELECT COUNT(*) FROM issues WHERE status IN ('new','investigating','regressed') AND muted=0) AS count`)
    .first<{ count: number }>();
  return Math.min(9999, row?.count ?? 0);
}
