import { Hono } from 'hono';
import { z } from 'zod';
import { cachedAnalytics } from '../services/analytics-cache.ts';
import { syncStore, getStoreDashboard, acknowledgeReviews } from '../services/store-monitor.ts';
import { boundedJson } from '../http/security.ts';
import type { AppEnv } from '../http/types.ts';

const growthRoutes = new Hono<AppEnv>();
const acknowledgement = z.object({ ids: z.array(z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)).min(1).max(100) }).strict();

growthRoutes.get('/analytics', async (c) => c.json(await cachedAnalytics(c.env.DB, {
  ...(c.env.GA4_OAUTH_CREDENTIALS ? { credentials: c.env.GA4_OAUTH_CREDENTIALS } : {}), now: c.get('serverNow')
})));

growthRoutes.get('/store', async (c) => {
  const now = c.get('serverNow');
  const previous = await getStoreDashboard(c.env.DB, now);
  if (previous.last_checked_at === null || now - previous.last_checked_at >= 900_000) {
    // The first private read seeds history. A per-database lease also covers cron.
    // Dispatch is scheduled separately so a GET never sends notifications.
    await syncStore(c.env.DB, { now });
    return c.json(await getStoreDashboard(c.env.DB, Date.now()));
  }
  return c.json(previous);
});

growthRoutes.post('/store/reviews/ack', boundedJson, async (c) => {
  const parsed = acknowledgement.safeParse(c.get('rawJson'));
  if (!parsed.success) return c.json({ error: 'Invalid review acknowledgement' }, 400);
  await acknowledgeReviews(c.env.DB, [...new Set(parsed.data.ids)], c.get('serverNow'));
  return c.json({ ok: true });
});

export default growthRoutes;
