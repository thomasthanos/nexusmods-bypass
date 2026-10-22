/* Push only: authenticated documents and API responses are never cached. */
'use strict';

const ROOT = `${self.location.origin}/`;
const ISSUE_TRIGGERS = new Set(['NEW_CRITICAL', 'REGRESSION', 'SPIKE_DETECTED', 'UPSTREAM_CHANGE']);

function notificationUrl(data) {
  if (!data || typeof data !== 'object' || typeof data.url !== 'string' || data.url.length > 2048) return ROOT;
  try {
    const url = new URL(data.url);
    if (url.origin !== self.location.origin || url.username || url.password || url.hash || url.pathname !== '/') return ROOT;
    if (data.trigger === 'TEST' && data.issue_id === null && data.fingerprint === null && !url.search) return ROOT;
    if (!ISSUE_TRIGGERS.has(data.trigger) || !Number.isSafeInteger(data.issue_id) || data.issue_id < 1
      || !/^[a-f0-9]{64}$/.test(data.fingerprint) || url.search !== `?issue=${data.issue_id}`) return ROOT;
    return url.href;
  } catch { return ROOT; }
}

function text(value, limit) {
  return Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim()).slice(0, limit).join('');
}

function notificationPayload(event) {
  const fallback = { title: 'Diagnostics update', body: 'Open the dashboard to review diagnostics.',
    tag: 'diagnostics-update', data: { url: ROOT, trigger: 'FALLBACK' }, badge: null };
  try {
    const input = event.data?.json();
    if (!input || Array.isArray(input) || typeof input !== 'object' || typeof input.title !== 'string'
      || typeof input.body !== 'string' || input.title.length > 4096 || input.body.length > 16384) return fallback;
    const url = notificationUrl(input.data);
    const isTest = input.data?.trigger === 'TEST' && input.data?.issue_id === null && input.data?.fingerprint === null
      && input.data?.url === ROOT && input.tag === 'diagnostics-test';
    if ((!isTest && url === ROOT) || (!isTest && input.tag !== input.data.fingerprint)) return fallback;
    const title = text(input.title, 80); const body = text(input.body, 240);
    if (!title || !body) return fallback;
    return { title, body, tag: isTest ? 'diagnostics-test' : input.data.fingerprint,
      data: { url, issue_id: input.data.issue_id, fingerprint: input.data.fingerprint, trigger: input.data.trigger },
      badge: typeof input.badge_count === 'number' && Number.isFinite(input.badge_count) ? Math.min(9999, Math.max(0, Math.floor(input.badge_count))) : null };
  } catch { return fallback; }
}

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    const payload = notificationPayload(event);
    await self.registration.showNotification(payload.title, {
      body: payload.body, tag: payload.tag, data: payload.data,
      icon: '/icons/icon-192.png', badge: '/icons/badge-96.png',
      actions: [{ action: 'open', title: 'Open issue' }, { action: 'close', title: 'Close' }]
    });
    try {
      if (payload.badge === 0) await self.navigator.clearAppBadge?.();
      else if (payload.badge !== null) await self.navigator.setAppBadge?.(payload.badge);
    } catch { /* Badging support must not prevent the visible notification. */ }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'close') return;
  event.waitUntil((async () => {
    const url = notificationUrl(event.notification.data);
    let windows = [];
    try { windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true }); } catch { /* Open a fresh window below. */ }
    for (const client of windows) {
      try {
        if (new URL(client.url).origin !== self.location.origin) continue;
        const destination = client.url === url ? client : await client.navigate(url);
        if (destination) { await destination.focus(); return; }
      } catch { /* A closed or inaccessible client does not prevent opening the dashboard. */ }
    }
    try { await self.clients.openWindow(url); } catch { /* The platform may decline window creation. */ }
  })());
});
