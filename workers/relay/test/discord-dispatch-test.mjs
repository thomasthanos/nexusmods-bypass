// Offline tests for relay/discord.js: embed limits, safe clipping and the webhook dispatcher's
// rate-limit and retry behaviour. No request leaves the machine.
import assert from 'node:assert/strict';
import { DISCORD_LIMITS, COLORS, clip, quiet, fitEmbed, discordRetryAfterMs, backoffMs, postWebhook } from '../discord.js';

// clip never splits a surrogate pair and repairs lone halves.
assert.equal(clip('abc', 5), 'abc');
assert.equal(clip('abcdef', 4), 'abc…');
assert.equal(clip('ab😀cd', 4), 'ab…', 'a cut inside an emoji drops the whole emoji');
assert.equal(clip('ab😀cd', 5), 'ab😀…');
assert.equal(clip('x\ud800y', 10), 'x�y', 'a lone surrogate becomes U+FFFD');
assert.equal(clip(null, 3), '');
assert.equal(clip('abc', 0), '');
assert.equal(quiet('@everyone <@123>'), '@\u200beveryone <@\u200b123>');

// fitEmbed clamps every limit, including the 6000 total and footer/author, and drops empty keys.
const huge = fitEmbed({
  title: 't'.repeat(400), description: 'd'.repeat(5000), footer: { text: 'f'.repeat(3000) }, author: { name: 'a'.repeat(300) },
  fields: Array.from({ length: 30 }, () => ({ name: '', value: 'v'.repeat(1500) }))
});
assert.ok(huge.title.length <= DISCORD_LIMITS.title);
assert.ok(huge.description.length <= DISCORD_LIMITS.description);
assert.ok(huge.footer.text.length <= DISCORD_LIMITS.footer);
assert.ok(huge.author.name.length <= DISCORD_LIMITS.author);
assert.ok(huge.fields.length <= DISCORD_LIMITS.fields && huge.fields.every((f) => f.name === '—' && f.value.length <= DISCORD_LIMITS.fieldValue));
const total = (e) => (e.title?.length || 0) + (e.description?.length || 0) + (e.footer?.text?.length || 0) + (e.author?.name?.length || 0)
  + e.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
assert.ok(total(huge) <= DISCORD_LIMITS.total, 'the whole embed fits in 6000 characters');
const empty = fitEmbed({ title: '', description: '', fields: [] });
assert.ok(!('title' in empty) && !('description' in empty), 'Discord refuses empty strings, so they are left out');
assert.deepEqual(Object.values(COLORS).map((c) => c.toString(16)), ['57f287', '3498db', 'e8b339', 'ed4245']);

// Retry-After: body (fractional seconds), then header seconds or date, then X-RateLimit-Reset-After.
const headers = (values) => ({ get: (name) => values[name.toLowerCase()] ?? null });
assert.equal(discordRetryAfterMs(headers({ 'retry-after': '9' }), { retry_after: 0.25 }), 250);
assert.equal(discordRetryAfterMs(headers({ 'retry-after': '9' }), null), 9000);
assert.equal(discordRetryAfterMs(headers({ 'retry-after': new Date(61000).toUTCString() }), null, 1000), 60000);
assert.equal(discordRetryAfterMs(headers({ 'x-ratelimit-reset-after': '1.5' }), {}), 1500);
assert.equal(discordRetryAfterMs(headers({}), {}), null);
assert.equal(backoffMs(1, { random: () => 0 }), 250);
assert.equal(backoffMs(1, { random: () => 1 }), 500);
assert.equal(backoffMs(20, { random: () => 1 }), 8000, 'backoff is capped');

// The dispatcher, with a scripted fetch and a recorded sleep.
function harness(responses) {
  const calls = [];
  const sleeps = [];
  let clock = 0;
  const options = {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      clock += next.elapsedMs || 0;
      return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status, headers: next.headers || {} });
    },
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    random: () => 0.5,
    now: () => clock
  };
  return { calls, sleeps, options };
}
const url = 'https://discord.invalid/api/webhooks/1/token';
{
  const h = harness([{ status: 429, body: { retry_after: 1.2, global: false } }, { status: 200, body: { id: '1' } }]);
  const result = await postWebhook(url, { content: 'x' }, h.options);
  assert.deepEqual(result, { ok: true, status: 200, attempts: 2, retryAfterMs: null, error: '' });
  assert.equal(h.sleeps[0], 1200 + 125, 'waits what Discord asked, plus jitter');
  assert.equal(new URL(h.calls[0].url).searchParams.get('wait'), 'true', 'Discord confirms storage before answering');
  assert.equal(h.calls[0].init.headers['content-type'], 'application/json');
  assert.equal(JSON.parse(h.calls[0].init.body).content, 'x');
}
{
  const h = harness([{ status: 429, body: { retry_after: 60 } }]);
  const result = await postWebhook(url, {}, { ...h.options, budgetMs: 10000 });
  assert.equal(result.ok, false);
  assert.equal(result.status, 429);
  assert.equal(result.retryAfterMs, 60000, 'a wait beyond the budget is handed back');
  assert.equal(h.sleeps.length, 0);
}
{
  const h = harness([{ status: 503 }, new TypeError('fetch failed'), { status: 204 }]);
  const result = await postWebhook(url, {}, h.options);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3, 'gateway errors and network failures are retried');
  assert.deepEqual(h.sleeps, [backoffMs(1, { random: () => 0.5 }), backoffMs(2, { random: () => 0.5 })]);
}
for (const status of [400, 401, 404, 500]) {
  const h = harness([{ status, body: { message: `failed at https://discord.com/api/webhooks/1/token`, code: 10015 } }, { status: 200 }]);
  const result = await postWebhook(url, {}, h.options);
  assert.equal(result.ok, false);
  assert.equal(h.calls.length, 1, `HTTP ${status} is not retried`);
  assert.doesNotMatch(result.error, /token/, 'error text carries no URL');
  assert.match(result.error, new RegExp(`HTTP ${status} code 10015`));
}
{
  const h = harness([{ status: 502 }, { status: 502 }, { status: 502 }, { status: 200 }]);
  const result = await postWebhook(url, {}, { ...h.options, maxAttempts: 3 });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 3, 'attempts are bounded');
}
for (const bad of ['', 'not a url', 'http://discord.invalid/api/webhooks/1/token']) {
  const h = harness([]);
  const result = await postWebhook(bad, {}, h.options);
  assert.deepEqual(result, { ok: false, status: 0, attempts: 0, retryAfterMs: null, error: 'invalid webhook URL' });
  assert.equal(h.calls.length, 0, 'only https webhooks are called');
}
{
  // The second attempt has only 100 ms left, rather than a fresh full request timeout.
  const h = harness([{ status: 503, elapsedMs: 750 }, { status: 200 }]);
  const originalTimeout = globalThis.setTimeout;
  const deadlines = [];
  globalThis.setTimeout = (callback, ms, ...args) => {
    deadlines.push(ms);
    return originalTimeout(callback, ms, ...args);
  };
  try {
    const result = await postWebhook(url, {}, { ...h.options, random: () => 0, budgetMs: 1100, timeoutMs: 1000 });
    assert.equal(result.ok, true);
    assert.deepEqual(deadlines, [1000, 100], 'every attempt is bounded by the remaining delivery budget');
  } finally {
    globalThis.setTimeout = originalTimeout;
  }
}
{
  const h = harness([{ status: 503 }]);
  const result = await postWebhook(url, {}, { ...h.options, random: () => 0, budgetMs: 250 });
  assert.equal(result.status, 503);
  assert.equal(h.sleeps.length, 0, 'do not sleep until the deadline with no time left to retry');
  assert.equal(h.calls.length, 1);
}
{
  const h = harness([{ status: 503 }, { status: 200 }]);
  const result = await postWebhook(url, {}, {
    ...h.options, budgetMs: 500,
    sleep: async () => h.options.sleep(600)
  });
  assert.equal(result.status, 503);
  assert.equal(h.calls.length, 1, 'a delayed retry timer cannot start a request after the deadline');
}
{
  const form = new FormData();
  form.set('payload_json', '{}');
  const h = harness([{ status: 200 }]);
  await postWebhook(url, form, h.options);
  assert.equal(h.calls[0].init.body, form, 'FormData is sent as is, with its own content type');
  assert.equal(h.calls[0].init.headers, undefined);
}
{
  // A request that hangs is abandoned at the timeout and counted as a failed attempt.
  const result = await postWebhook(url, {}, {
    fetchImpl: (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
    timeoutMs: 1000, maxAttempts: 1
  });
  assert.equal(result.error, 'timed out');
}

console.log('Discord dispatcher OK: limits, surrogate-safe clipping, Retry-After, bounded retries, no URL leaks.');
