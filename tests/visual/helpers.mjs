// Shared harness for the Playwright suites. The browser is offline by construction: every request is
// answered by a route here or in the test, a catch-all route refuses the rest, and the host resolver
// knows no name but loopback, so a request no route answers fails at once instead of reaching the
// internet. Nothing is timed with a fixed sleep; each wait names the state it waits for.
import { chromium, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const extensionDir = path.join(root, 'src');
export const fixture = (name) => fs.readFileSync(path.join(root, 'tests/fixtures', name), 'utf8');

const OFFLINE_RESOLVER = '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost';
const isOurWorker = (worker) => /^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(worker.url());
const isInstallTab = (page) => page.url().includes('/onboarding/welcome.html');

const state = new WeakMap(); // context -> { profile, ownsProfile, id, blocked }

export function collectionAnswer() {
  const modFiles = Array.from({ length: 40 }, (_, i) => ({
    fileId: 1000 + i,
    optional: i % 5 === 0,
    file: {
      fileId: 1000 + i, name: `Example file with a fairly long name number ${i + 1}.7z`, uri: `f${i}.7z`,
      size: 1024 * (i + 1) * 37, version: '1.0', date: 1700000000,
      mod: { adult: false, modId: 500 + i, name: `Example Mod ${i + 1} — Extended Edition`, version: '1.0', game: { domainName: 'skyrimspecialedition', id: 1704 } }
    },
    updatePolicy: i % 3 === 0 ? 'latest' : 'exact',
    version: '1.0'
  }));
  return { data: { collectionRevision: { revisionNumber: 3, revisionStatus: 'published', latest: false, externalResources: [], modFiles } } };
}

// The official v2 API (src/content/nexus-api.js), answered per operation.
export function officialAnswer(body) {
  const op = body?.operationName;
  if (op === 'CollectionRevisionMods') return collectionAnswer();
  if (op === 'CollectionRevisions') {
    return { data: { collection: { revisions: [3, 4].map((n) => ({ revisionNumber: n, revisionStatus: 'published', latest: n === 4, totalSize: 1, modCount: 40, createdAt: '2026-01-01T00:00:00Z' })) } } };
  }
  if (op === 'ModsByDomain') {
    return { data: { legacyModsByDomain: { nodes: (body.variables.ids || []).map(({ modId }) => ({
      uid: String(7000000 + modId), modId, name: 'x', version: '2.0', viewerEndorsed: modId % 2 === 0, viewerTracked: false,
      game: { domainName: 'skyrimspecialedition', id: 1704 }
    })) } } };
  }
  if (op === 'GameId') return { data: { game: { id: 1704, domainName: 'skyrimspecialedition' } } };
  if (op === 'ModFiles') return { data: { modFiles: [] } };
  return { data: null, errors: [{ message: `unexpected ${op}` }] };
}

// Nexus as the content scripts see it: fixture documents, canned API answers, nothing else.
export async function routeNexus(ctx) {
  await ctx.route('https://www.nexusmods.com/**', (route) => {
    const url = new URL(route.request().url());
    if (route.request().resourceType() !== 'document') return route.fulfill({ status: 204, body: '' });
    const html = url.pathname.includes('/collections/') ? fixture('visual-collection-page.html') : fixture('visual-mod-page.html');
    return route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });
  await ctx.route('https://api-router.nexusmods.com/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(collectionAnswer()),
    headers: { 'access-control-allow-origin': 'https://www.nexusmods.com', 'access-control-allow-credentials': 'true' }
  }));
  await ctx.route('https://api.nexusmods.com/v2/graphql', (route) => {
    const cors = { 'access-control-allow-origin': 'https://www.nexusmods.com', 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'content-type' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors, body: '' });
    let body = null;
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) { body = null; }
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(officialAnswer(body)) });
  });
}

// Starts Chromium with the given unpacked extensions. A fresh profile is an install, so the welcome tab
// it opens is waited for and closed; a profile passed in is a restart, which opens no tab.
export async function launchExtension({
  extensions = [extensionDir],
  userDataDir = null,
  routes = routeNexus
} = {}) {
  const ownsProfile = !userDataDir;
  const profile = userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'nxtk-pw-'));
  const list = extensions.join(',');
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(profile, {
      channel: process.env.NXTK_PLAYWRIGHT_CHANNEL || 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${list}`, `--load-extension=${list}`, OFFLINE_RESOLVER]
    });
  } catch (error) {
    if (ownsProfile) fs.rmSync(profile, { recursive: true, force: true });
    throw error;
  }
  const blocked = [];
  state.set(ctx, { profile, ownsProfile, id: null, blocked });
  // Registered first, so it runs last: whatever no later route answers is refused and noted.
  await ctx.route(/^(?:https?|wss?):\/\//, (route) => {
    blocked.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  if (routes) await routes(ctx);
  await extensionId(ctx);
  if (ownsProfile && extensions.includes(extensionDir)) {
    await expect.poll(() => ctx.pages().some(isInstallTab), { message: 'the install tab never opened', timeout: 20000 }).toBe(true);
    await Promise.all(ctx.pages().filter(isInstallTab).map((page) => page.close()));
  }
  return ctx;
}

// keepProfile leaves the profile for a second launch (a browser restart); its caller removes it.
export async function closeExtension(ctx, { keepProfile = false } = {}) {
  const entry = ctx && state.get(ctx);
  try {
    await ctx?.close();
  } finally {
    if (entry?.ownsProfile && !keepProfile) fs.rmSync(entry.profile, { recursive: true, force: true });
  }
}

export function profileOf(ctx) {
  return state.get(ctx)?.profile;
}

// Requests the catch-all refused, for tests that pin down what a page may ask for.
export function blockedRequests(ctx) {
  return [...(state.get(ctx)?.blocked || [])];
}

export async function extensionId(ctx) {
  const entry = state.get(ctx);
  if (entry?.id) return entry.id;
  const worker = ctx.serviceWorkers().find(isOurWorker)
    || await ctx.waitForEvent('serviceworker', { predicate: isOurWorker, timeout: 30000 });
  const id = new URL(worker.url()).host;
  if (entry) entry.id = id;
  return id;
}

// MV3 stops an idle worker, and a stopped worker is gone from context.serviceWorkers() until an
// extension event starts it again; waiting for 'serviceworker' alone then waits for the test timeout.
// A runtime message from an extension page is such an event.
export async function serviceWorker(ctx) {
  const live = ctx.serviceWorkers().find(isOurWorker);
  if (live) return live;
  const id = await extensionId(ctx);
  const started = ctx.waitForEvent('serviceworker', { predicate: isOurWorker, timeout: 15000 });
  const page = await ctx.newPage();
  try {
    await page.goto(`chrome-extension://${id}/debug-page/debug.html`);
    await page.evaluate(() => globalThis.chrome.runtime.sendMessage({ type: 'NXTK_WAKE' }).catch(() => undefined));
    return ctx.serviceWorkers().find(isOurWorker) || await started;
  } finally {
    await page.close();
  }
}

export async function extensionPage(ctx, pagePath) {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${await extensionId(ctx)}/${pagePath}`);
  return page;
}

// Storage as a fresh install has it, plus what the test names. In-memory state in the worker follows
// through storage.onChanged, as it does for any other writer.
export async function resetStorage(ctx, items = {}) {
  const worker = await serviceWorker(ctx);
  await worker.evaluate(async (seed) => {
    await globalThis.chrome.storage.local.clear();
    if (Object.keys(seed).length) await globalThis.chrome.storage.local.set(seed);
  }, items);
}

export async function readStorage(ctx, key) {
  const worker = await serviceWorker(ctx);
  return worker.evaluate(async (name) => (await globalThis.chrome.storage.local.get(name))[name], key);
}

// What "the layout is final" means for a measurement: fonts loaded, no finite animation or transition
// still running, and two frames painted after that. Infinite animations (spinners) never settle and
// are left out.
export async function settle(page, { timeout = 5000 } = {}) {
  await page.evaluate(() => globalThis.document.fonts?.ready);
  await page.waitForFunction(() => globalThis.document.getAnimations().every((animation) => (
    animation.playState !== 'running' || animation.effect?.getComputedTiming?.().iterations === Infinity
  )), null, { timeout });
  await page.evaluate(() => new Promise((resolve) => {
    globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve));
  }));
}

// A ZIP of stored entries: enough for a .wabbajack, which the importer reads by slicing, not inflating.
export function storedZip(entries) {
  const table = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (bytes) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const nameBytes = Buffer.from(name, 'utf8');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc32(body), 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE(crc32(body), 16);
    record.writeUInt32LE(body.length, 20);
    record.writeUInt32LE(body.length, 24);
    record.writeUInt16LE(nameBytes.length, 28);
    record.writeUInt32LE(offset, 42);
    local.push(header, nameBytes, body);
    central.push(record, nameBytes);
    offset += header.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
