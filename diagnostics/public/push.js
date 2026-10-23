/** Browser-only push management. Subscription credentials stay in the browser and protected API. */
export function mountPushManager(container, { request, notify = () => {} }) {
  const doc = container.ownerDocument; const win = doc.defaultView; const nav = win.navigator;
  const abort = new win.AbortController(); const signal = abort.signal;
  let disposed = false; let busy = false; let initialized = false; let registration = null;
  let local = null; let publicKey = null; let serverId = null; let devices = []; let cooldownUntil = 0;
  let refreshGeneration = 0; let message = ''; let messageKind = 'info';
  const isiOS = /iPad|iPhone|iPod/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  const standalone = nav.standalone === true || win.matchMedia?.('(display-mode: standalone)').matches === true;
  const supported = win.isSecureContext && 'serviceWorker' in nav && 'PushManager' in win && 'Notification' in win && (!isiOS || standalone);

  function element(tag, className, value) {
    const node = doc.createElement(tag); if (className) node.className = className;
    if (value !== undefined) node.textContent = value; return node;
  }
  const panel = element('section', 'panel push-panel'); panel.setAttribute('aria-labelledby', 'push-heading');
  const heading = element('h2', '', 'Notifications'); heading.id = 'push-heading';
  const description = element('p', 'muted', 'Receive critical issues, regressions and detected spikes on registered devices. Permission is requested only when you enable notifications.');
  const guidance = element('p', 'alert push-guidance');
  const status = element('p', 'push-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const actions = element('div', 'button-row push-actions'); const deviceList = element('div', 'push-devices');
  const deviceHeading = element('h4', '', 'Registered devices');
  const deviceNote = element('p', 'muted', 'The test sends to all registered devices. Provider acceptance does not confirm that a device displayed the notification.');
  const buttons = {};
  function button(action, label, className = 'button button-quiet') {
    const node = element('button', className, label); node.type = 'button'; node.dataset.pushAction = action;
    buttons[action] = node; actions.append(node); return node;
  }
  button('enable', 'Enable on this device', 'button button-primary'); button('sync', 'Sync this device', 'button');
  button('disable', 'Disable on this device', 'button button-danger'); button('rotate', 'Replace with current server key', 'button button-danger');
  button('test', 'Send test notification', 'button'); button('refresh', 'Refresh push status', 'button');
  panel.append(heading, description, guidance, status, actions, deviceHeading, deviceNote, deviceList); container.replaceChildren(panel);

  function permission() { return win.Notification?.permission ?? 'unsupported'; }
  function keyBytes(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{87}$/.test(value)) throw Error('Invalid push configuration');
    const raw = win.atob(value.replace(/-/g, '+').replace(/_/g, '/') + '=');
    const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
    if (bytes.length !== 65 || bytes[0] !== 4) throw Error('Invalid push configuration');
    return bytes;
  }
  function keyChanged() {
    const old = local?.options?.applicationServerKey;
    if (!old || !publicKey) return false;
    const actual = ArrayBuffer.isView(old) ? new Uint8Array(old.buffer, old.byteOffset, old.byteLength) : new Uint8Array(old);
    return actual.length !== publicKey.length || actual.some((byte, index) => byte !== publicKey[index]);
  }
  function expired() { return local?.expirationTime !== null && local?.expirationTime !== undefined && local.expirationTime <= Date.now(); }
  function setMessage(value, kind = 'info', announce = false) {
    if (disposed) return; message = value; messageKind = kind; render(); if (announce) notify(value, kind);
  }
  function errorMessage(error) {
    if (error?.status === 401) return 'Your Access session could not be verified. Reload and sign in, then retry. The browser subscription is preserved.';
    if (error?.status === 403) return 'The request was blocked. Your session may still be valid. Retry or check the site’s security rules. The browser subscription is preserved.';
    if (error?.status === 429) return `Please wait ${Math.max(1, Math.ceil(Number(error.retryAfter) || 60))} seconds before retrying the test.`;
    if (nav.onLine === false) return 'You are offline. Reconnect and retry; the browser subscription is preserved.';
    if (error?.name === 'NotAllowedError') return 'Notification permission was not granted. Check this app’s notification settings before trying again.';
    return 'Push setup or the protected API could not be reached. Reload your Access session and retry. Any browser subscription is kept for recovery.';
  }
  function render() {
    if (disposed) return;
    guidance.hidden = false;
    if (isiOS && !standalone) guidance.textContent = 'On iPhone or iPad, use Safari → Share → Add to Home Screen. Open the installed app before enabling notifications. iOS/iPadOS 16.4 or later is required.';
    else if (!supported) guidance.textContent = 'This browser does not expose Web Push in a secure context. Use a supported browser over HTTPS; on iOS open the installed Home Screen app.';
    else if (permission() === 'denied') guidance.textContent = 'Notifications are blocked. Allow notifications in browser or system Settings, then refresh this app. No additional permission prompt will be shown while blocked.';
    else if (keyChanged()) guidance.textContent = 'The server key changed. This subscription uses the previous key. Replacing it deliberately removes the old registration before creating a new one; a failed replacement can be retried here.';
    else if (expired()) guidance.textContent = 'This browser subscription has expired. Replace it to restore notifications.';
    else { guidance.hidden = true; guidance.textContent = ''; }
    status.textContent = message || (!initialized ? 'Checking push configuration…' : local ? serverId ? 'This device is registered for notifications.' : 'A browser subscription exists. Sync this device to verify its server registration.' : 'Notifications are not enabled on this device.');
    status.className = `push-status ${messageKind === 'error' ? 'text-danger' : local && serverId ? 'push-status-registered' : 'muted'}`;
    buttons.enable.hidden = !!local;
    buttons.enable.disabled = busy || !initialized || !supported || permission() === 'denied' || !!local;
    buttons.sync.hidden = !local; buttons.sync.disabled = busy || !initialized || !local || expired();
    buttons.disable.hidden = !local; buttons.disable.disabled = busy || !initialized || !local;
    buttons.rotate.hidden = !local || (!keyChanged() && !expired()); buttons.rotate.disabled = busy || !initialized || !supported || permission() !== 'granted';
    renderTestButton();
    buttons.refresh.disabled = busy;
    deviceList.replaceChildren();
    if (!devices.length) deviceList.append(element('p', 'empty-state', initialized ? 'No server registrations were found.' : 'Loading registered devices…'));
    for (const device of devices) {
      const row = element('div', 'push-device');
      const details = element('div', 'push-device-details');
      const label = element('p', 'push-device-name');
      label.append(doc.createTextNode(`${device.provider || 'Push'} · ${device.user_agent || 'Unknown device'}${device.id === serverId ? ' · ' : ''}`));
      if (device.id === serverId) {
        const badge = element('span', 'tag tag-success tag-this-device', 'This device');
        label.append(badge);
      }
      const detail = element('small', 'muted push-device-meta', device.expiration_time ? `Expires ${new Date(device.expiration_time).toLocaleString()}` : 'No expiration supplied by the browser');
      const remove = element('button', 'button button-danger', device.id === serverId ? 'Remove this registration' : 'Remove registration'); remove.type = 'button'; remove.disabled = busy;
      remove.setAttribute('aria-label', `Remove registration ${device.id}: ${device.provider || 'Push'}`);
      remove.addEventListener('click', () => perform(async () => {
        await api(`/push/subscriptions/${device.id}`, { method: 'DELETE' });
        if (disposed) return;
        if (device.id === serverId) serverId = null;
        devices = devices.filter((item) => item.id !== device.id);
        setMessage('Server registration removed. A subscription on this browser can be synced again.', 'info', true);
      }));
      details.append(label, detail); row.append(details, remove); deviceList.append(row);
    }
  }
  async function api(path, options = {}) { return request(path, { ...options, signal }); }
  function renderTestButton() {
    if (disposed) return;
    const seconds = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
    buttons.test.textContent = seconds ? `Test available in ${seconds}s` : 'Send test notification';
    buttons.test.disabled = busy || !initialized || seconds > 0;
  }
  async function refreshDevices(generation = null) {
    const result = await api('/push/subscriptions');
    if (disposed || (generation !== null && generation !== refreshGeneration)) return;
    if (!Array.isArray(result?.items)) throw Error('Invalid subscription list');
    devices = result.items.filter((item) => Number.isSafeInteger(item?.id) && item.id > 0).slice(0, 100);
    if (serverId && !devices.some((device) => device.id === serverId)) serverId = null;
  }
  async function sync() {
    if (!local) throw Error('No browser subscription');
    const value = local.toJSON();
    const result = await api('/push/subscriptions', { method: 'POST', body: { endpoint: local.endpoint, expirationTime: local.expirationTime ?? null, keys: value.keys } });
    if (disposed) return;
    if (!Number.isSafeInteger(result?.subscription?.id) || result.subscription.id < 1) throw Error('Invalid registration response');
    serverId = result.subscription.id;
    devices = [result.subscription, ...devices.filter((device) => device.id !== serverId)].slice(0, 100);
  }
  async function removeLocal() {
    if (!serverId && !expired()) await sync();
    if (disposed) return;
    if (serverId) {
      const id = serverId;
      try { await api(`/push/subscriptions/${id}`, { method: 'DELETE' }); }
      catch (error) { if (error?.status !== 404) throw error; }
      if (disposed) return;
      devices = devices.filter((device) => device.id !== id); serverId = null;
    }
    const removed = await local.unsubscribe();
    if (disposed) return;
    if (!removed) throw Error('Browser subscription remains active');
    local = null;
  }
  async function perform(task) {
    if (disposed || busy) return; busy = true; message = ''; render();
    try { await task(); }
    catch (error) { if (!disposed && error?.name !== 'AbortError') setMessage(errorMessage(error), 'error', true); }
    finally { if (!disposed) { busy = false; render(); } }
  }
  async function activeRegistration(candidate) {
    if (candidate.active) return candidate;
    let timer; let cancel;
    try {
      return await Promise.race([
        nav.serviceWorker.ready,
        new Promise((_, reject) => {
          timer = win.setTimeout(() => reject(Error('Service worker activation timed out')), 20_000);
          cancel = () => reject(new win.DOMException('Aborted', 'AbortError'));
          signal.addEventListener('abort', cancel, { once: true });
          if (signal.aborted) cancel();
        })
      ]);
    } finally { win.clearTimeout(timer); if (cancel) signal.removeEventListener('abort', cancel); }
  }
  async function initialize() {
    if (disposed || busy) return;
    busy = true; initialized = false; const generation = ++refreshGeneration; render();
    try {
      const [config] = await Promise.all([
        api('/push/config'), refreshDevices(generation),
        supported ? (async () => {
          const candidate = await activeRegistration(await nav.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }));
          if (disposed || generation !== refreshGeneration) return;
          const subscription = await candidate.pushManager.getSubscription();
          if (disposed || generation !== refreshGeneration) return;
          registration = candidate; local = subscription;
          serverId = null;
        })() : Promise.resolve()
      ]);
      if (disposed || generation !== refreshGeneration) return;
      publicKey = keyBytes(config?.public_key); initialized = true; message = '';
    } catch (error) { if (!disposed && error?.name !== 'AbortError') setMessage(errorMessage(error), 'error'); }
    finally { if (!disposed && generation === refreshGeneration) { busy = false; render(); } }
  }
  buttons.enable.addEventListener('click', () => {
    if (disposed || busy || !initialized || !supported || permission() === 'denied') return;
    // Safari requires this call in the original click stack, before any await.
    let granted;
    try { granted = permission() === 'granted' ? Promise.resolve('granted') : win.Notification.requestPermission(); }
    catch (error) { setMessage(errorMessage(error), 'error'); return; }
    perform(async () => {
      if (await granted !== 'granted') { setMessage('Notification permission was not granted. Enable it in Settings when you are ready.', 'info'); return; }
      if (disposed) return;
      local = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
      if (disposed) return;
      await sync(); if (!disposed) setMessage('This device is registered for notifications.', 'success', true);
    });
  });
  buttons.sync.addEventListener('click', () => perform(async () => { await sync(); if (!disposed) setMessage('This device is registered for notifications.', 'success', true); }));
  buttons.disable.addEventListener('click', () => perform(async () => { await removeLocal(); if (!disposed) setMessage('Notifications disabled on this device.', 'info', true); }));
  buttons.rotate.addEventListener('click', () => perform(async () => {
    await removeLocal(); if (disposed) return;
    local = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
    if (disposed) return;
    await sync(); if (!disposed) setMessage('This device now uses the current server key.', 'success', true);
  }));
  buttons.test.addEventListener('click', () => perform(async () => {
    try {
      const result = await api('/push/test', { method: 'POST', body: {} });
      if (disposed) return;
      cooldownUntil = Date.now() + 60_000;
      const accepted = Number.isSafeInteger(result?.delivered) && result.delivered >= 0 ? result.delivered : 0;
      const failed = Number.isSafeInteger(result?.failed) && result.failed >= 0 ? result.failed : 0;
      if (result?.state === 'no_subscriptions') setMessage('No server registrations are available. Enable or sync a device, then retry.', 'info', true);
      else if (result?.state === 'delivered' && accepted > 0 && failed === 0) setMessage(`Push providers accepted ${accepted} test notification${accepted === 1 ? '' : 's'}. Check your devices; display is not confirmed.`, 'success', true);
      else if (result?.state === 'partial' && accepted > 0) setMessage(`Partial result: ${accepted} of ${accepted + failed} accepted by push providers; ${failed} failed. Check devices and retry after a minute.`, 'error', true);
      else setMessage('No test notifications were accepted by push providers. Sync your device or replace an expired subscription, then retry.', 'error', true);
      await refreshDevices();
    } catch (error) {
      if (error?.status === 429 && !disposed) cooldownUntil = Date.now() + Math.min(86_400, Math.max(1, Number(error.retryAfter) || 60)) * 1000;
      throw error;
    }
  }));
  buttons.refresh.addEventListener('click', () => { message = ''; void initialize(); });
  const interval = win.setInterval(() => { if (cooldownUntil > 0) renderTestButton(); }, 1000);
  void initialize();
  return { dispose() { if (disposed) return; disposed = true; ++refreshGeneration; abort.abort(); win.clearInterval(interval); } };
}
