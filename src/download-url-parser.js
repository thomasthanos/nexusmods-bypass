// Original NexusMods Bypass code under the repository LICENSE, written separately from
// src/content/nnw.js (GPL-3.0-or-later), which calls it.
//
// Reads the download link out of a Nexus Mods response: the JSON GenerateDownloadUrl answers with, a
// files tab that carries each file's metadata in an attribute, or older page markup. The page and the
// background queue both load this file, so a download started on a page and a queued one read a
// response the same way.
//
// Which targets may be downloaded is decided by shared.js (NXTK); without it no https link is accepted.
// Nothing here touches the DOM or `location` — the service worker has neither — so a relative link is
// resolved against `baseUrl`.
(() => {
  'use strict';

  const MAX_INPUT_CHARS = 2 * 1024 * 1024;
  const MAX_URL_CHARS = 2048;
  const MAX_NESTING = 12;
  const MAX_JSON_NODES = 1000;
  const MAX_FILE_ATTRIBUTES = 1024;
  const MAX_CDN_CANDIDATES = 8;
  const CDN_CONTEXT_CHARS = 512;
  const DEFAULT_BASE_URL = 'https://www.nexusmods.com/';

  // Vortex needs the signed nxm:// handoff, or a Nexus page that yields one; a browser download needs
  // the file itself. Each list is in order of preference.
  const LINK_KEYS = Object.freeze({
    vortex: Object.freeze(['vortexDownloadUrl', 'nmmDownloadUrl', 'url', 'downloadUrl']),
    browser: Object.freeze(['downloadUrl', 'url'])
  });
  const NESTED_KEYS = Object.freeze(['data', 'html', 'links', 'downloadLinks']);
  const FILE_ID_KEYS = Object.freeze(['fileId', 'file_id', 'id']);
  const NAMED_ENTITIES = Object.freeze({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: '\u00a0' });

  const ENTITY = /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,6}));/gi;
  // Markup that names the link outright, as older Nexus pages wrote it.
  const MARKUP_LINKS = Object.freeze([
    Object.freeze(['dl_link-value', /id=["']dl_link["'][^>]*value=["']([^"']+)["']/gi]),
    Object.freeze(['data-download-url', /data-download-url=["']([^"']+)["']/gi]),
    Object.freeze(['const-downloadUrl', /const\s+downloadUrl\s*=\s*["']([^"']+)["']/gi])
  ]);
  // The files tab carries each file's metadata as JSON in a main-file="…" or file="…" attribute.
  const FILE_ATTRIBUTE = /(?:^|[\s<])(?:main-file|file)\s*=\s*(["'])([\s\S]*?)\1/gi;
  const NXM_TOKEN = /nxm:\/\/[^\s"'<>]+/gi;
  const CDN_TOKEN = /https?:\/\/[a-z0-9-]+\.nexus-cdn\.com[^\s"'<>]*/gi;
  const GAME_DOMAIN = /^[a-z0-9][a-z0-9-]{0,63}$/i;
  const NXM_FILE_PATH = /^\/mods\/\d{1,12}\/files\/\d{1,12}\/?$/i;
  const RESOLVER_PATH = /\/api\/files\/\d+|\/Core\/Libs\/Common\/Managers\/Downloads$/i;

  function toFileId(value) {
    const text = String(value ?? '').trim();
    return /^\d{1,12}$/.test(text) && Number(text) > 0 ? text : '';
  }

  // Resolved by hand rather than by an HTML parser: the text is untrusted, and only the few
  // entities a link can carry matter here. Anything unknown or out of range is left as written.
  function decodeEntities(text) {
    return text.replace(ENTITY, (entity, decimal, hex, name) => {
      if (name) {
        const key = name.toLowerCase();
        return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : entity;
      }
      const code = decimal ? Number.parseInt(decimal, 10) : Number.parseInt(hex, 16);
      if (!(code > 0 && code <= 0x10ffff)) return entity;
      try {
        return String.fromCodePoint(code);
      } catch (_) {
        return entity;
      }
    });
  }

  // Entities first, then the JSON escapes a link picks up when it sits inside an inline script.
  function decodeLinkText(value) {
    return decodeEntities(String(value ?? '').trim())
      .replace(/\\\//g, '/')
      .replace(/\\u0026/gi, '&')
      .trim();
  }

  // A link lifted out of script text can bring the closing punctuation around it along.
  function cleanCandidate(value) {
    return decodeLinkText(value).replace(/[)\]},;]+$/, '').trim();
  }

  // nxm://<game>/mods/<mod>/files/<file>?key=…&expires=…&user_id=… — Vortex refuses anything less.
  function isSignedNxm(candidate) {
    if (!/^nxm:\/\//i.test(candidate) || candidate.length > MAX_URL_CHARS) return false;
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch (_) {
      return false;
    }
    if (parsed.protocol !== 'nxm:' || parsed.username || parsed.password || parsed.hash) return false;
    if (!GAME_DOMAIN.test(parsed.hostname) || !NXM_FILE_PATH.test(parsed.pathname)) return false;
    const key = parsed.searchParams.get('key') || '';
    return key.length > 0 && key.length <= 512
      && /^\d+$/.test(parsed.searchParams.get('expires') || '')
      && /^\d+$/.test(parsed.searchParams.get('user_id') || '');
  }

  // The first signed nxm:// link anywhere in the text, or null.
  function findSignedNxmLink(text) {
    if (!text) return null;
    const decoded = decodeLinkText(String(text).slice(0, MAX_INPUT_CHARS));
    for (const match of decoded.matchAll(NXM_TOKEN)) {
      const candidate = cleanCandidate(match[0]);
      if (isSignedNxm(candidate)) return candidate;
    }
    return null;
  }

  // Whether the value, once decoded, is itself a signed nxm:// link and nothing more.
  function isSignedNxmLink(url) {
    return isSignedNxm(cleanCandidate(url));
  }

  function isSignedCdnUrl(url) {
    try {
      const params = new URL(url).searchParams;
      return params.has('expires') && (params.has('key') || params.has('md5') || params.has('user_id'));
    } catch (_) {
      return false;
    }
  }

  function readOptions(options) {
    const given = options && typeof options === 'object'
      ? options
      : { mode: options === true ? 'vortex' : 'browser' };
    let baseUrl = DEFAULT_BASE_URL;
    try {
      if (given.baseUrl) baseUrl = new URL(String(given.baseUrl)).href;
    } catch (_) {
    }
    return {
      vortex: given.mode === 'vortex' || given.isNMM === true,
      fileId: toFileId(given.fileId),
      allowBareCdn: given.allowBareCdn !== false,
      baseUrl
    };
  }

  function fileIdOf(value) {
    for (const key of FILE_ID_KEYS) {
      const id = toFileId(value?.[key]);
      if (id) return id;
    }
    return '';
  }

  // One search over one response. The node budget is shared by everything the search re-enters, so
  // a response built to nest or repeat cannot make it walk without end.
  function createSearch(settings) {
    const budget = { nodes: 0 };

    function acceptCandidate(value) {
      const candidate = cleanCandidate(value);
      if (!candidate || candidate.length > MAX_URL_CHARS) return '';
      if (/^nxm:/i.test(candidate)) return settings.vortex && isSignedNxm(candidate) ? candidate : '';

      const shared = globalThis.NXTK;
      if (typeof shared?.validateDownloadTarget !== 'function' || typeof shared.isSafeNexusPageUrl !== 'function') {
        return '';
      }
      let href;
      try {
        href = new URL(candidate, settings.baseUrl).href;
      } catch (_) {
        return '';
      }
      if (settings.vortex) {
        // For Vortex an https link is only useful as a Nexus page that resolves to the nxm:// link.
        if (!shared.isSafeNexusPageUrl(href)) return '';
        const parsed = new URL(href);
        return RESOLVER_PATH.test(parsed.pathname) || parsed.searchParams.has('file_id') ? href : '';
      }
      const verdict = shared.validateDownloadTarget(href, { method: 1 });
      return verdict?.ok ? verdict.url || href : '';
    }

    function walkJson(value, label, depth) {
      if (!value || typeof value !== 'object' || depth > MAX_NESTING) return null;
      if (budget.nodes >= MAX_JSON_NODES) return null;
      budget.nodes += 1;

      if (Array.isArray(value)) {
        const entries = settings.fileId
          ? [
            ...value.filter((entry) => fileIdOf(entry) === settings.fileId),
            ...value.filter((entry) => fileIdOf(entry) !== settings.fileId)
          ]
          : value;
        for (const entry of entries) {
          const found = walkJson(entry, label, depth + 1);
          if (found) return found;
        }
        return null;
      }

      // A link is only taken from an object that belongs to the requested file, or names no file.
      const ownId = fileIdOf(value);
      if (!settings.fileId || !ownId || ownId === settings.fileId) {
        for (const key of settings.vortex ? LINK_KEYS.vortex : LINK_KEYS.browser) {
          if (typeof value[key] !== 'string') continue;
          const url = acceptCandidate(value[key]);
          if (url) return { url, source: `${label}-${key}` };
        }
      }

      for (const key of NESTED_KEYS) {
        const nested = value[key];
        if (!nested) continue;
        if (typeof nested === 'string') {
          const found = searchText(nested, depth + 1);
          if (found) return { url: found.url, source: `${label}-${key}` };
        } else {
          const found = walkJson(nested, `${label}-${key}`, depth + 1);
          if (found) return found;
        }
      }
      return null;
    }

    function fromJson(text, depth) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (_) {
        return null;
      }
      return walkJson(parsed, 'json', depth);
    }

    function fromFileAttributes(text, depth) {
      const values = [];
      for (const match of text.matchAll(FILE_ATTRIBUTE)) {
        values.push(match[2]);
        if (values.length >= MAX_FILE_ATTRIBUTES) break;
      }
      if (!values.length) return null;

      // Metadata that mentions the requested file is read first, so a crowded files tab cannot use up
      // the budget before the right entry is reached.
      const ordered = settings.fileId
        ? [
          ...values.filter((value) => value.includes(settings.fileId)),
          ...values.filter((value) => !value.includes(settings.fileId))
        ]
        : values;
      const unscoped = new Set();
      for (const value of ordered) {
        let metadata;
        try {
          metadata = JSON.parse(decodeLinkText(value));
        } catch (_) {
          continue;
        }
        const ownId = fileIdOf(metadata);
        if (settings.fileId && ownId && ownId !== settings.fileId) continue;
        const found = walkJson(metadata, 'embedded', depth + 1);
        if (!found) continue;
        if (settings.fileId && ownId === settings.fileId) return { url: found.url, source: 'embedded-file-attr' };
        unscoped.add(found.url);
      }
      // Metadata that names no file is only trusted when every such entry points at the same link.
      return unscoped.size === 1 ? { url: unscoped.values().next().value, source: 'embedded-file-attr' } : null;
    }

    function fromMarkup(text) {
      for (const [source, pattern] of MARKUP_LINKS) {
        for (const match of text.matchAll(pattern)) {
          const url = acceptCandidate(match[1]);
          if (url) return { url, source };
        }
      }
      return null;
    }

    // A signed CDN link written into the page with nothing around it. Taken only when it is the one
    // such link, or the one link that has the requested file id near it.
    function fromBareCdn(text) {
      const nearFile = new Map();
      for (const match of text.matchAll(CDN_TOKEN)) {
        const url = acceptCandidate(match[0]);
        if (!url || !isSignedCdnUrl(url)) continue;
        const around = text.slice(Math.max(0, match.index - CDN_CONTEXT_CHARS),
          match.index + match[0].length + CDN_CONTEXT_CHARS);
        nearFile.set(url, nearFile.get(url) || (!!settings.fileId && around.includes(settings.fileId)));
        if (nearFile.size > MAX_CDN_CANDIDATES) return null;
      }
      const near = [...nearFile].filter(([, isNear]) => isNear).map(([url]) => url);
      if (near.length === 1) return { url: near[0], source: 'bare-cdn-url' };
      if (near.length > 1 || nearFile.size !== 1) return null;
      return { url: nearFile.keys().next().value, source: 'bare-cdn-url' };
    }

    function fromNxm(text) {
      const url = findSignedNxmLink(text);
      return url ? { url, source: 'nxm-url' } : null;
    }

    function runStrategies(text, depth) {
      return fromJson(text, depth)
        || fromFileAttributes(text, depth)
        || fromMarkup(text)
        || (settings.vortex ? fromNxm(text) : (settings.allowBareCdn ? fromBareCdn(text) : null));
    }

    // Read as it came first, then once more with entities and escapes resolved.
    function searchText(text, depth) {
      if (!text || depth > MAX_NESTING) return null;
      const raw = String(text).slice(0, MAX_INPUT_CHARS);
      const found = runStrategies(raw, depth);
      if (found) return found;
      const decoded = decodeLinkText(raw);
      return decoded !== raw ? runStrategies(decoded, depth + 1) : null;
    }

    return (text) => searchText(text, 0);
  }

  // Returns { url, source } for the first link that suits the mode, or null. `options` is `true` for a
  // Vortex handoff, or { mode: 'vortex' | 'browser', fileId, allowBareCdn, baseUrl }.
  function findDownloadLink(text, options = false) {
    return createSearch(readOptions(options))(text);
  }

  globalThis.NXTKDownloadParser = Object.freeze({
    MAX_INPUT_CHARS,
    decodeLinkText,
    findDownloadLink,
    findSignedNxmLink,
    isSignedNxmLink
  });
})();
