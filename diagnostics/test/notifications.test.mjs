import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestDatabase, testDatabase } from './helpers/d1.mjs';
import { errorReportSchema } from '../src/schemas/ingest.ts';
import {
  reservePushNotification, completePushNotification, releasePushNotification,
  sendIssueNotifications, sendTestNotification
} from '../src/services/notifications.ts';

const NOW = Date.UTC(2026, 9, 21, 12);
const fingerprint = 'a'.repeat(64);
const rule = { category: 'NETWORK_UNREACHABLE', fault_origin: 'client_env', suggested_action: 'Check the connection.', upstream_breaking_change: false, structural_category: null };
const uuid = (n) => `12345678-1234-4234-8234-${n.toString(16).padStart(12, '0')}`;

function database(t) {
  t.mock.method(Date, 'now', () => NOW);
  return testDatabase(t);
}

function issue(db, overrides = {}) {
  const values = {
    fingerprint, error_category: 'NETWORK', error_code: 'FETCH_FAILED', failure_stage: 'PRIMARY_API_REQUEST', normalized_top_frame: 'fetchFile@content/main.js', destination: 'browser',
    category: rule.category, fault_origin: rule.fault_origin, suggested_action: rule.suggested_action,
    first_seen_at: NOW, last_seen_at: NOW, first_seen_version: '3.2.0', last_seen_version: '3.2.0', created_at: NOW, updated_at: NOW,
    ...overrides
  };
  const keys = Object.keys(values);
  return Number(db.sqlite.prepare(`INSERT INTO issues (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(values)).lastInsertRowid);
}

function report(db, issueId, n = 1, overrides = {}, createdAt = NOW) {
  const value = errorReportSchema.parse({
    schema_version: 1, consent: 'diagnostics-v1', report_id: uuid(n), install_id: String((n % 3) + 1).repeat(64), occurred_at: new Date(NOW).toISOString(),
    version: '3.2.0', browser: 'chrome', browser_version: '144.0', os: 'windows', download_mode: 'auto', destination: 'browser', severity: 'error',
    error_category: 'NETWORK', error_code: 'FETCH_FAILED', failure_stage: 'PRIMARY_API_REQUEST', error_name: 'TypeError', error_message: 'Failed to fetch', ...overrides
  });
  db.sqlite.prepare(`INSERT INTO reports (id,issue_id,install_id,version,browser,browser_version,os,download_mode,destination,severity,error_category,error_code,failure_stage,error_name,error_message,category,fault_origin,suggested_action,occurred_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    value.report_id, issueId, value.install_id, value.version, value.browser, value.browser_version, value.os, value.download_mode, value.destination, value.severity,
    value.error_category, value.error_code, value.failure_stage, value.error_name, value.error_message, rule.category, rule.fault_origin, rule.suggested_action, NOW, createdAt
  );
  return value;
}

const claimInput = (issueId, overrides = {}) => ({ issueId, trigger: 'NEW_CRITICAL', dedupeKey: 'initial', now: NOW, cooldownMs: 1_800_000, leaseMs: 30_000, ...overrides });

test('atomic claims admit one concurrent event and block competing normal triggers', async (t) => {
  const db = database(t);
  const id = issue(db);
  const claims = await Promise.all(Array.from({ length: 8 }, () => reservePushNotification(db, claimInput(id))));
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(await reservePushNotification(db, claimInput(id, { trigger: 'SPIKE_DETECTED', dedupeKey: 'spike' })), null);
});

test('ignored and muted issues cannot reserve push delivery', async (t) => {
  const db = database(t);
  const id = issue(db, { muted: 1 });
  assert.equal(await reservePushNotification(db, claimInput(id)), null);
  db.sqlite.prepare("UPDATE issues SET muted=0,status='ignored' WHERE id=?").run(id);
  assert.equal(await reservePushNotification(db, claimInput(id)), null);
});

test('successful delivery records cooldown and delivered event identity only once', async (t) => {
  const db = database(t);
  const id = issue(db);
  const claim = await reservePushNotification(db, claimInput(id));
  assert.equal(await completePushNotification(db, claim, NOW + 1), true);
  assert.equal(db.sqlite.prepare('SELECT last_pushed_at FROM issues WHERE id=?').get(id).last_pushed_at, NOW + 1);
  assert.equal(await completePushNotification(db, claim, NOW + 2), false);
  assert.equal(await reservePushNotification(db, claimInput(id, { now: NOW + 2000, trigger: 'SPIKE_DETECTED', dedupeKey: 'later' })), null);
  assert.equal(await reservePushNotification(db, claimInput(id, { now: NOW + 1_800_002, trigger: 'NEW_CRITICAL' })), null);
});

test('failed delivery releases the lease without starting cooldown', async (t) => {
  const db = database(t);
  const id = issue(db);
  const claim = await reservePushNotification(db, claimInput(id));
  assert.equal(await releasePushNotification(db, claim), true);
  assert.equal(db.sqlite.prepare('SELECT last_pushed_at FROM issues WHERE id=?').get(id).last_pushed_at, null);
  assert.ok(await reservePushNotification(db, claimInput(id, { now: NOW + 1 })));
});

test('expired lease owners cannot complete or release a new owner reservation', async (t) => {
  const db = database(t);
  const id = issue(db);
  const old = await reservePushNotification(db, claimInput(id));
  const current = await reservePushNotification(db, claimInput(id, { now: NOW + 30_001 }));
  assert.notEqual(old.lease_token, current.lease_token);
  assert.equal(await completePushNotification(db, old, NOW + 30_002), false);
  assert.equal(await releasePushNotification(db, old), false);
  assert.equal(await completePushNotification(db, current, NOW + 30_003), true);
});

test('regression transitions bypass cooldown once but require a regressed issue', async (t) => {
  const db = database(t);
  const id = issue(db, { last_pushed_at: NOW, status: 'fixed', fixed_in_version: '3.2.0' });
  const input = claimInput(id, { trigger: 'REGRESSION', dedupeKey: uuid(9), now: NOW + 1 });
  assert.equal(await reservePushNotification(db, input), null);
  db.sqlite.prepare("UPDATE issues SET status='regressed' WHERE id=?").run(id);
  const claim = await reservePushNotification(db, input);
  assert.ok(claim);
  await completePushNotification(db, claim, NOW + 2);
  assert.equal(await reservePushNotification(db, { ...input, now: NOW + 3 }), null);
});

async function configuration(db) {
  const vapidPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const vapidPublic = await crypto.subtle.exportKey('raw', vapidPair.publicKey);
  const vapidPrivate = await crypto.subtle.exportKey('jwk', vapidPair.privateKey);
  const clientPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const clientPublic = await crypto.subtle.exportKey('raw', clientPair.publicKey);
  db.sqlite.prepare('INSERT INTO push_subscriptions (endpoint,p256dh,auth,created_at,updated_at) VALUES (?,?,?,?,?)').run(
    'https://web.push.apple.com/test-subscription', Buffer.from(clientPublic).toString('base64url'), Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url'), NOW, NOW
  );
  return { dashboardOrigin: 'https://diagnostics.example.org', discordWebhookUrl: 'https://discord.com/api/webhooks/123456789012345678/test-token-abcdefghijklmnopqrstuvwxyz', vapid: { publicKey: Buffer.from(vapidPublic).toString('base64url'), privateKey: vapidPrivate.d, subject: 'mailto:owner@example.org' } };
}

test('new critical reports relay to Discord and send encrypted push after persistence', async (t) => {
  const db = database(t);
  const id = issue(db);
  const value = report(db, id);
  const config = await configuration(db);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => { requests.push(new Request(url, init)); return new Response(null, { status: 201 }); });
  const result = await sendIssueNotifications(db, { issueId: id, report: value, rule, isNewIssue: true, now: NOW }, config);
  assert.equal(result.discord.ok, true);
  assert.equal(result.push.state, 'delivered');
  assert.equal(result.push.trigger, 'NEW_CRITICAL');
  assert.equal(result.push.delivered, 1);
  assert.equal(requests.filter((request) => new URL(request.url).hostname === 'web.push.apple.com').length, 1);
  assert.equal(db.sqlite.prepare('SELECT last_pushed_at FROM issues WHERE id=?').get(id).last_pushed_at, NOW);
});

test('out-of-order receipt timestamps cannot hide the third-install upstream alert', async (t) => {
  const db = database(t);
  const id = issue(db);
  const structural = { ...rule, category: 'DOM_SELECTOR_MISSING', structural_category: 'DOM_SELECTOR_MISSING' };
  const fields = { severity: 'warning', error_category: 'DOM_SELECTOR_MISSING', error_code: 'SELECTOR_NOT_FOUND', error_message: 'Missing collection host' };
  const config = await configuration(db);
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 201 }));
  report(db, id, 1, fields, NOW);
  const newer = report(db, id, 3, fields, NOW + 2);
  const initial = await sendIssueNotifications(db, { issueId: id, report: newer, rule: structural, isNewIssue: false, now: NOW + 2 }, config);
  assert.equal(initial.push.state, 'suppressed');
  const delayed = report(db, id, 2, fields, NOW + 1);
  const result = await sendIssueNotifications(db, { issueId: id, report: delayed, rule: structural, isNewIssue: false, now: NOW + 1 }, config);
  assert.equal(result.push.trigger, 'UPSTREAM_CHANGE');
  assert.equal(result.push.state, 'delivered');
  assert.equal(db.sqlite.prepare('SELECT last_pushed_at FROM issues WHERE id=?').get(id).last_pushed_at, NOW + 2);
});

test('spikes require ten recent server receipts across three distinct installations', async (t) => {
  const db = database(t);
  const id = issue(db);
  let value;
  for (let i = 1; i <= 10; i++) value = report(db, id, i);
  const config = await configuration(db);
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 201 }));
  const result = await sendIssueNotifications(db, { issueId: id, report: value, rule, isNewIssue: false, now: NOW }, config);
  assert.equal(result.push.trigger, 'SPIKE_DETECTED');
  assert.equal(result.push.state, 'delivered');
});

test('old receipts and repeated installations cannot manufacture a spike', async (t) => {
  const db = database(t);
  const id = issue(db);
  let value;
  for (let i = 1; i <= 12; i++) value = report(db, id, i, { install_id: '1'.repeat(64) }, i <= 5 ? NOW - 900_001 : NOW);
  const config = await configuration(db);
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 201 }));
  const result = await sendIssueNotifications(db, { issueId: id, report: value, rule, isNewIssue: false, now: NOW }, config);
  assert.equal(result.push.trigger, null);
  assert.equal(result.push.state, 'suppressed');
  assert.equal(result.discord.ok, true);
});

test('regression sends high priority only for a newer release and an explicit transition identity', async (t) => {
  const db = database(t);
  const id = issue(db, { status: 'regressed', fixed_in_version: '3.2.0', last_pushed_at: NOW });
  const value = report(db, id, 1, { version: '3.2.1' });
  const config = await configuration(db);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => { requests.push(new Request(url, init)); return new Response(null, { status: 201 }); });
  const result = await sendIssueNotifications(db, { issueId: id, report: value, rule, isNewIssue: false, regressionEventId: value.report_id, now: NOW + 1 }, config);
  assert.equal(result.push.trigger, 'REGRESSION');
  assert.equal(requests.find((request) => new URL(request.url).hostname === 'web.push.apple.com').headers.get('urgency'), 'high');
});

test('provider expiry deletes only the rejected subscription and leaves push cooldown untouched', async (t) => {
  const db = database(t);
  const id = issue(db);
  const value = report(db, id);
  const config = await configuration(db);
  t.mock.method(globalThis, 'fetch', async (url) => new Response(null, { status: new URL(url).hostname === 'web.push.apple.com' ? 410 : 201 }));
  const result = await sendIssueNotifications(db, { issueId: id, report: value, rule, isNewIssue: true, now: NOW }, config);
  assert.equal(result.push.expired, 1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 0);
  assert.equal(db.sqlite.prepare('SELECT last_pushed_at FROM issues WHERE id=?').get(id).last_pushed_at, null);
});

test('test notifications reach subscriptions without creating issues, claims, or Discord messages', async (t) => {
  const db = database(t);
  const config = await configuration(db);
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => { urls.push(String(url)); return new Response(null, { status: 201 }); });
  const result = await sendTestNotification(db, config, NOW);
  assert.equal(result.delivered, 1);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^https:\/\/web\.push\.apple\.com\//);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM issues').get().n, 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM notification_claims').get().n, 0);
});

test('push bookkeeping failure does not reject or abandon the Discord delivery promise', async (t) => {
  const db = database(t);
  const id = issue(db);
  const value = report(db, id);
  const config = await configuration(db);
  const originalPrepare = db.prepare.bind(db);
  t.mock.method(db, 'prepare', (sql) => {
    if (sql.includes('COUNT(DISTINCT NULLIF(install_id,')) throw new Error('D1 temporarily unavailable');
    return originalPrepare(sql);
  });
  let discordCompleted = false;
  t.mock.method(globalThis, 'fetch', async () => {
    await new Promise((resolve) => setImmediate(resolve));
    discordCompleted = true;
    return new Response(null, { status: 201 });
  });
  const result = await sendIssueNotifications(db, { issueId: id, report: value, rule, isNewIssue: true, now: NOW }, config);
  assert.equal(discordCompleted, true);
  assert.equal(result.discord.ok, true);
  assert.equal(result.push.state, 'failed');
  assert.equal(result.push.retryable, true);
});

test('all failed push requests release the event while preserving Discord success', async (t) => {
  const db = database(t);
  const id = issue(db);
  const value = report(db, id);
  const config = await configuration(db);
  t.mock.method(globalThis, 'fetch', async (url) => new Response(null, { status: new URL(url).hostname === 'web.push.apple.com' ? 503 : 201, headers: { 'Retry-After': '10' } }));
  const result = await sendIssueNotifications(db, { issueId: id, report: value, rule, isNewIssue: true, now: NOW }, config);
  assert.equal(result.discord.ok, true);
  assert.equal(result.push.state, 'failed');
  assert.equal(result.push.retryable, true);
  assert.equal(db.sqlite.prepare('SELECT last_pushed_at FROM issues WHERE id=?').get(id).last_pushed_at, null);
  assert.equal(db.sqlite.prepare('SELECT lease_token FROM notification_claims WHERE issue_id=?').get(id).lease_token, null);
});

test('structural canaries require three current installations and obey issue muting', async (t) => {
  const db = database(t);
  const id = issue(db);
  let value;
  for (let i = 1; i <= 3; i++) value = report(db, id, i);
  const config = await configuration(db);
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 201 }));
  const structural = { ...rule, category: 'UPSTREAM_BREAKING_CHANGE', fault_origin: 'upstream_site', structural_category: 'DOM_SELECTOR_MISSING', upstream_breaking_change: true };
  const result = await sendIssueNotifications(db, { issueId: id, report: value, rule: structural, isNewIssue: false, now: NOW }, config);
  assert.equal(result.push.trigger, 'UPSTREAM_CHANGE');
  assert.equal(result.push.delivered, 1);
  db.sqlite.prepare('UPDATE issues SET muted=1 WHERE id=?').run(id);
  const muted = await sendIssueNotifications(db, { issueId: id, report: value, rule: structural, isNewIssue: false, now: NOW }, config);
  assert.equal(muted.push.state, 'suppressed');
  assert.equal(muted.discord.ok, true);
});

test('nine reports or only two distinct installations remain below the spike threshold', async (t) => {
  for (const [count, distinct] of [[9, 3], [10, 2]]) {
    const db = createTestDatabase();
    try {
      const id = issue(db);
      let value;
      for (let i = 1; i <= count; i++) value = report(db, id, i, { install_id: String((i % distinct) + 1).repeat(64) });
      const config = await configuration(db);
      t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 201 }));
      const result = await sendIssueNotifications(db, { issueId: id, report: value, rule, isNewIssue: false, now: NOW }, config);
      assert.equal(result.push.state, 'suppressed');
      assert.equal(result.push.trigger, null);
    } finally { db.close(); }
  }
});

test('subscription cleanup errors cannot orphan in-flight sends or discard partial-delivery cooldown', async (t) => {
  const db = database(t);
  const id = issue(db);
  const value = report(db, id);
  const config = await configuration(db);
  db.sqlite.exec("INSERT INTO push_subscriptions (endpoint,p256dh,auth,created_at,updated_at) SELECT endpoint || '-other',p256dh,auth,created_at,updated_at FROM push_subscriptions");
  const originalPrepare = db.prepare.bind(db);
  t.mock.method(db, 'prepare', (sql) => {
    if (sql.startsWith('DELETE FROM push_subscriptions')) throw new Error('Cleanup temporarily unavailable');
    return originalPrepare(sql);
  });
  let accepted = false;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (new URL(url).hostname === 'discord.com') return new Response(null, { status: 201 });
    if (String(url).endsWith('-other')) {
      await new Promise((resolve) => setImmediate(resolve));
      accepted = true;
      return new Response(null, { status: 201 });
    }
    return new Response(null, { status: 410 });
  });
  const result = await sendIssueNotifications(db, { issueId: id, report: value, rule, isNewIssue: true, now: NOW }, config);
  assert.equal(accepted, true);
  assert.equal(result.push.state, 'partial');
  assert.equal(result.push.delivered, 1);
  assert.equal(result.push.expired, 1);
  assert.equal(db.sqlite.prepare('SELECT last_pushed_at FROM issues WHERE id=?').get(id).last_pushed_at, NOW);
  assert.equal(db.sqlite.prepare('SELECT delivered_at FROM notification_claims WHERE issue_id=?').get(id).delivered_at, NOW);
});
