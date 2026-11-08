// Runs in the page's own world (manifest "world": "MAIN"), before Nexus's scripts.
//
// Nexus's resumable downloads (files over 500 MB, Chromium only) ask where to save with the browser's
// showSaveFilePicker. A newer Nexus file has no name in its address, only a code, and the browser then
// offered "<code>.txt": the file was saved as text, and the person had to rename it before Vortex, Mod
// Organizer 2 or an archive tool would open it. Here the picker is asked with the file's real name and
// extension instead, which the extension's content script works out (nnw.js, answerSaveName). When the
// extension could not tell the extension in time, the finished file is named after its first bytes.
//
// Nexus's own call always goes through: whatever goes wrong here, the picker is asked as Nexus asked it.
// Nothing from the page is trusted beyond a name for the picker, and nothing leaves the browser.
(() => {
  'use strict';

  const original = typeof window.showSaveFilePicker === 'function' ? window.showSaveFilePicker : null;
  if (!original || original.nxtkWrapped) return;

  const ASK_EVENT = 'nxtk-save-name';
  const ANSWER_EVENT = 'nxtk-save-name-answer';
  const DONE_EVENT = 'nxtk-save-complete';
  const RENAMED_EVENT = 'nxtk-save-renamed';
  const RENAME_EVENT = 'nxtk-save-rename';
  // The browser lets a page open the picker for five seconds after a click. Nexus has used some of that.
  const ANSWER_WAIT_MS = 3000;
  const SIGNATURES = [
    ['zip', [0x50, 0x4b, 0x03, 0x04]],
    ['7z', [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]],
    ['rar', [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]]
  ];
  const ARCHIVE_NAME = /\.(?:zip|7z|rar)$/i;

  // The files this page saved through the picker, by Nexus file id: their handle, to name them once done.
  const saved = new Map();
  let asks = 0;

  const send = (type, detail) => document.dispatchEvent(new CustomEvent(type, { detail: JSON.stringify(detail) }));
  const read = (event) => {
    try {
      const value = JSON.parse(String(event?.detail || ''));
      return value && typeof value === 'object' ? value : null;
    } catch (_) {
      return null;
    }
  };

  function askName(options) {
    const id = `${Date.now().toString(36)}-${++asks}`;
    return new Promise((resolve) => {
      const done = (value) => {
        clearTimeout(timer);
        document.removeEventListener(ANSWER_EVENT, onAnswer);
        resolve(value);
      };
      const onAnswer = (event) => {
        const answer = read(event);
        if (answer?.id === id) done(answer);
      };
      const timer = setTimeout(() => done(null), ANSWER_WAIT_MS);
      document.addEventListener(ANSWER_EVENT, onAnswer);
      send(ASK_EVENT, { id, suggestedName: String(options?.suggestedName || '') });
    });
  }

  // Nexus's options with the file's name. The file types are set to the name's own extension: a type list
  // whose first extension differs is what made the browser add ".txt".
  function namedOptions(options, name) {
    const extension = (String(name).match(/\.([a-z0-9]{1,5})$/i) || [])[1];
    const next = { ...(options && typeof options === 'object' ? options : {}), suggestedName: name };
    if (extension) {
      next.types = [{ description: extension.toUpperCase(), accept: { 'application/octet-stream': [`.${extension.toLowerCase()}`] } }];
      next.excludeAcceptAllOption = false;
    } else {
      delete next.types;
    }
    return next;
  }

  async function wrapped(options) {
    let answer = null;
    // Without the click's permission the picker fails however it is asked; it is asked as Nexus asked.
    const active = navigator.userActivation ? navigator.userActivation.isActive : true;
    if (active) {
      try { answer = await askName(options); } catch (_) { answer = null; }
    }
    const name = typeof answer?.name === 'string' ? answer.name.trim() : '';
    if (name) {
      let handle = null;
      try {
        handle = await original.call(this, namedOptions(options, name));
      } catch (cause) {
        // Cancelled by the person, or refused by the browser: asking again would not help.
        if (cause?.name !== 'TypeError') throw cause;
      }
      if (handle) {
        const fileId = /^\d{1,12}$/.test(String(answer.fileId || '')) ? String(answer.fileId) : '';
        if (fileId) saved.set(fileId, { handle, base: String(answer.base || '') });
        return handle;
      }
    }
    return original.call(this, options);
  }

  function extensionOf(bytes) {
    return (SIGNATURES.find(([, signature]) => signature.every((byte, index) => bytes[index] === byte)) || [])[0] || '';
  }

  // The finished file's name with the extension its first bytes show; '' when it already has it, or the
  // bytes are not an archive the extension knows.
  async function fixedName(entry) {
    const file = await entry.handle.getFile();
    const extension = extensionOf(new Uint8Array(await file.slice(0, 8).arrayBuffer()));
    const current = String(entry.handle.name || file.name || '');
    if (!extension || current.toLowerCase().endsWith(`.${extension}`)) return '';
    // The name the person kept or typed in the picker, only its extension changed.
    const base = current.replace(/\.(?:txt|zip|7z|rar)$/i, '') || entry.base;
    return base ? `${base}.${extension}` : '';
  }

  async function rename(fileId, entry, name) {
    try {
      await entry.handle.move(name);
      saved.delete(fileId);
      send(RENAMED_EVENT, { fileId, ok: true, name });
    } catch (cause) {
      // The browser renames a picked file only right after a click: the extension's card offers one.
      send(RENAMED_EVENT, { fileId, ok: false, name, needsClick: true, reason: String(cause?.name || 'Error') });
    }
  }

  document.addEventListener(DONE_EVENT, (event) => {
    const fileId = String(read(event)?.fileId || '');
    const entry = saved.get(fileId);
    if (!entry || entry.checking) return;
    entry.checking = true;
    fixedName(entry).then((name) => {
      if (!name) {
        saved.delete(fileId);
        return null;
      }
      entry.pending = name;
      return typeof entry.handle.move === 'function' ? rename(fileId, entry, name) : send(RENAMED_EVENT, { fileId, ok: false, name, reason: 'unsupported' });
    }).catch(() => saved.delete(fileId)).finally(() => { entry.checking = false; });
  });

  // The person's click on the card's "Fix the name" button: the rename runs inside that click.
  document.addEventListener(RENAME_EVENT, (event) => {
    const fileId = String(read(event)?.fileId || '');
    const entry = saved.get(fileId);
    if (entry?.pending && ARCHIVE_NAME.test(entry.pending)) rename(fileId, entry, entry.pending);
  });

  Object.defineProperty(wrapped, 'name', { value: 'showSaveFilePicker' });
  Object.defineProperty(wrapped, 'nxtkWrapped', { value: true });
  try {
    Object.defineProperty(window, 'showSaveFilePicker', { value: wrapped, configurable: true, writable: true });
  } catch (_) {
    window.showSaveFilePicker = wrapped;
  }
})();
