import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { errorReportSchema, heartbeatSchema } from './schemas/ingest.ts';
import { acceptErrorReport, acceptHeartbeat, IngestionConflict } from './services/ingestion.ts';
import { sendIssueNotifications } from './services/notifications.ts';
import adminRoutes from './routes/admin.ts';
import { ingestionOptions, notificationConfiguration } from './http/config.ts';
import {
  boundedJson, limitAdminPushTest, limitPublicInstall, limitPublicIp,
  publicCors, requireAccess, requireSameOrigin
} from './http/security.ts';
import type { AppEnv } from './http/types.ts';

const app = new Hono<AppEnv>();
const publicPaths = new Set(['/api/ingest', '/api/heartbeat']);

// No untrusted payload, JWT, provider body, SQL error or request URL enters logs.
function logFailure(event: string, requestId: string): void {
  console.error(JSON.stringify({ event, request_id: requestId }));
}

app.use('*', async (c, next) => {
  c.set('serverNow', Date.now());
  c.set('requestId', crypto.randomUUID());
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Frame-Options', 'DENY');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
  if (new URL(c.req.url).protocol === 'https:') c.header('Strict-Transport-Security', 'max-age=31536000');
  if (c.req.path === '/api' || c.req.path.startsWith('/api/')) {
    c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  } else {
    c.header('Content-Security-Policy', "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    if (c.req.path === '/sw.js') c.header('Service-Worker-Allowed', '/');
  }
});

app.use('*', async (c, next) => {
  if (publicPaths.has(c.req.path)) return publicCors(c, next);
  return requireAccess(c, next);
});
app.use('*', async (c, next) => {
  if (publicPaths.has(c.req.path)) return next();
  return requireSameOrigin(c, next);
});

app.post('/api/ingest', limitPublicIp, boundedJson, limitPublicInstall,
  zValidator('json', errorReportSchema, (result, c) => {
    if (!result.success) return c.json({ error: 'Invalid report' }, 400);
  }), async (c) => {
    // Validate settings before committing, so a bad numeric deployment setting
    // cannot leave a stored report whose background dispatch was never scheduled.
    const config = notificationConfiguration(c.env, new URL(c.req.url).origin);
    const result = await acceptErrorReport(c.env.DB, c.req.valid('json'), c.get('serverNow'), ingestionOptions(c.env));
    if (result.accepted) {
      const requestId = c.get('requestId');
      c.executionCtx.waitUntil(sendIssueNotifications(c.env.DB, {
        issueId: result.issueId,
        report: result.report,
        rule: result.rule,
        isNewIssue: result.isNewIssue,
        ...(result.regressionEventId === undefined ? {} : { regressionEventId: result.regressionEventId }),
        now: c.get('serverNow')
      }, config).then((delivery) => {
        if (!delivery.discord.ok) logFailure('diagnostics_discord_delivery_failed', requestId);
        if (delivery.push.state === 'failed' || delivery.push.state === 'partial') {
          logFailure('diagnostics_push_delivery_failed', requestId);
        }
      }).catch(() => logFailure('diagnostics_background_delivery_failed', requestId)));
    }
    return c.json({ ok: true, report_id: result.reportId, duplicate: !result.accepted }, result.accepted ? 202 : 200);
  });

app.post('/api/heartbeat', limitPublicIp, boundedJson, limitPublicInstall,
  zValidator('json', heartbeatSchema, (result, c) => {
    if (!result.success) return c.json({ error: 'Invalid heartbeat' }, 400);
  }), async (c) => {
    const result = await acceptHeartbeat(c.env.DB, c.req.valid('json'), c.get('serverNow'));
    return c.json({ ok: true, heartbeat_id: result.heartbeatId, duplicate: !result.accepted }, result.accepted ? 202 : 200);
  });

app.use('/api/admin/push/test', limitAdminPushTest);
app.route('/api/admin', adminRoutes);

// API typos never fall through to a static application's SPA fallback.
app.all('/api', (c) => c.json({ error: 'Not found' }, 404));
app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));
app.get('*', async (c) => {
  if (!c.env.ASSETS) return c.json({ error: 'Assets unavailable' }, 503);
  const response = await c.env.ASSETS.fetch(c.req.raw);
  return new Response(response.body, response);
});
app.notFound((c) => c.json({ error: 'Not found' }, 404));
app.onError((error, c) => {
  if (error instanceof IngestionConflict) return c.json({ error: 'Request identity conflict', code: error.code }, 409);
  logFailure('diagnostics_request_failed', c.get('requestId'));
  return c.json({ error: 'Service unavailable' }, 503);
});

export { app };
export default app;
