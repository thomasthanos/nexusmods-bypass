(function () {
  'use strict';

  const NexusExt = window.NexusExt = window.NexusExt || {};
  const MAX_MODLIST_BYTES = 256 * 1024 * 1024;
  const MAX_ARCHIVES_JSON_BYTES = 32 * 1024 * 1024;
  const MAX_ARCHIVE_ENTRIES = 10000;

  class WabbajackImportError extends Error {
    constructor(code, message, cause = null) {
      super(message || code);
      this.name = 'WabbajackImportError';
      this.code = code;
      if (cause) this.cause = cause;
    }
  }

  const game = (domain, id) => Object.freeze({ domain, id });

  // Keep this mapping aligned with Wabbajack's current game registry.
  const GAMES = Object.freeze({
    Morrowind: game('morrowind', 100),
    Oblivion: game('oblivion', 101),
    Fallout3: game('fallout3', 120),
    FalloutNewVegas: game('newvegas', 130),
    Skyrim: game('skyrim', 110),
    Enderal: game('enderal', 2736),
    SkyrimSpecialEdition: game('skyrimspecialedition', 1704),
    Fallout4: game('fallout4', 1151),
    SkyrimVR: game('skyrimspecialedition', 1704),
    Fallout4VR: game('fallout4', 1151),
    DarkestDungeon: game('darkestdungeon', 804),
    Dishonored: game('dishonored', 802),
    Witcher: game('witcher', 150),
    Witcher3: game('witcher3', 952),
    StardewValley: game('stardewvalley', 1303),
    KingdomComeDeliverance: game('kingdomcomedeliverance', 2298),
    MechWarrior5Mercenaries: game('mechwarrior5mercenaries', 3099),
    NoMansSky: game('nomanssky', 1634),
    DragonAgeOrigins: game('dragonage', 140),
    DragonAge2: game('dragonage2', 141),
    DragonAgeInquisition: game('dragonageinquisition', 728),
    KerbalSpaceProgram: game('kerbalspaceprogram', 272),
    EnderalSpecialEdition: game('enderalspecialedition', 3685),
    Terraria: game('terraria', 549),
    Cyberpunk2077: game('cyberpunk2077', 3333),
    Sims4: game('thesims4', 641),
    DragonsDogma: game('dragonsdogma', 1249),
    KarrynsPrison: null,
    MountAndBlade2Bannerlord: game('mountandblade2bannerlord', 3174),
    Valheim: game('valheim', 3667),
    ModdingTools: game('site', 2295),
    FinalFantasy7Remake: game('finalfantasy7remake', 4202),
    BaldursGate3: game('baldursgate3', 3474),
    Starfield: game('starfield', 4187),
    Stalker2: game('stalker2heartofchornobyl', 6944),
    SevenDaysToDie: game('7daystodie', 1059),
    OblivionRemastered: game('oblivionremastered', 7587),
    Fallout76: game('fallout76', 2590),
    Fallout4London: game('fallout4london', 6332),
    Warhammer40kDarktide: game('warhammer40kdarktide', 4943),
    Kotor2: game('kotor2', 198),
    VtMB: game('vampirebloodlines', 437),
    KingdomComeDeliverance2: game('kingdomcomedeliverance2', 7286),
    DragonsDogma2: game('dragonsdogma2', 6234),
    NieRAutomata: game('nierautomata', 1950)
  });

  // Wabbajack writes its Game enum names, but a hand-edited or older modlist can differ in case.
  const GAME_NAMES_BY_LOWER_CASE = new Map(Object.keys(GAMES).map((name) => [name.toLowerCase(), name]));

  const GAME_IDS = Object.freeze(Object.fromEntries(
    Object.entries(GAMES).map(([name, metadata]) => [name, metadata?.id ?? null])
  ));

  // Wabbajack's Nexus DTO declares both the legacy NexusDownloader name and the Nexus alias.
  const NEXUS_STATE_TYPE = /(?:^|\.)Nexus(?:Downloader(?:\+State)?)?$/i;
  const DOWNLOADER_LABEL_PATTERN = /^[A-Za-z0-9]{1,40}$/;

  function cleanText(value, maxLength = 300) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
  }

  function positiveInteger(value) {
    if (typeof value === 'number') {
      return Number.isSafeInteger(value) && value > 0 && value < 1e12 ? value : null;
    }
    if (typeof value !== 'string' || !/^\d{1,12}$/.test(value)) return null;
    const number = Number(value);
    return number > 0 && number < 1e12 ? number : null;
  }

  function isNexusArchive(archive) {
    const state = archive?.State;
    if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
    const type = cleanText(state.$type, 200);
    // Duck typing is reserved for old manifests that have no declared downloader.
    if (type) return NEXUS_STATE_TYPE.test(type.split(',', 1)[0].trim());
    return state.GameName !== undefined && state.ModID !== undefined && state.FileID !== undefined;
  }

  function downloaderLabel(state) {
    const type = cleanText(state?.$type, 200);
    if (!type) return '';
    const declared = type.split(',', 1)[0].trim().split('.').pop() || '';
    const label = declared.replace(/\+State$/i, '').replace(/Downloader$/i, '');
    return DOWNLOADER_LABEL_PATTERN.test(label) ? label : '';
  }

  function analyzeManifest(manifest) {
    const archives = Array.isArray(manifest?.Archives) ? manifest.Archives : [];
    const items = [];
    const skipped = [];
    const seen = new Set();
    const skip = (name, reason) => skipped.push({ name: name || '(unnamed archive)', reason });

    for (const archive of archives) {
      const name = cleanText(archive?.Name);
      if (!isNexusArchive(archive)) {
        const label = downloaderLabel(archive?.State);
        skip(name, label ? `not-on-nexus:${label}` : 'not-on-nexus');
        continue;
      }

      const state = archive.State;
      const modId = positiveInteger(state.ModID);
      const fileId = positiveInteger(state.FileID);
      const declaredGame = cleanText(state.GameName, 100);
      if (!modId || !fileId || !declaredGame) {
        skip(name, 'incomplete-entry');
        continue;
      }
      const gameName = GAME_NAMES_BY_LOWER_CASE.get(declaredGame.toLowerCase());
      if (!gameName) {
        skip(name, `unknown-game:${declaredGame}`);
        continue;
      }

      const metadata = GAMES[gameName];
      if (!metadata) {
        skip(name, `unsupported-game:${gameName}`);
        continue;
      }

      // File IDs can repeat across Nexus games, so both values form the identity.
      const identity = `${metadata.id}:${fileId}`;
      if (seen.has(identity)) {
        skip(name, 'duplicate-entry');
        continue;
      }
      seen.add(identity);

      const sizeBytes = Number(archive.Size);
      items.push({
        gameName,
        gameDomain: metadata.domain,
        gameId: metadata.id,
        modId,
        fileId,
        name: name || `${gameName} ${modId}/${fileId}`,
        modName: cleanText(state.Name),
        sizeKb: Number.isFinite(sizeBytes) && sizeBytes > 0
          ? Math.min(Math.round(sizeBytes / 1024), Number.MAX_SAFE_INTEGER)
          : 0
      });
    }

    return { items, skipped, total: archives.length };
  }

  const MANIFEST_SCALAR_KEYS = new Set(['Name', 'Author', 'Version', 'GameType']);
  const QUOTE = 34;
  const BACKSLASH = 92;
  const COLON = 58;
  const OPEN_BRACE = 123;
  const CLOSE_BRACE = 125;
  const OPEN_BRACKET = 91;
  const CLOSE_BRACKET = 93;

  function skipJsonString(text, from) {
    let index = from + 1;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === BACKSLASH) {
        index += 2;
        continue;
      }
      if (code === QUOTE) return index + 1;
      index += 1;
    }
    return text.length;
  }

  // A modlist runs to hundreds of megabytes of text, read on the Nexus page itself: the scans below give
  // the page its turn every SCAN_YIELD_CHARS characters, so it never freezes while a list is read.
  const SCAN_YIELD_CHARS = 1024 * 1024;
  const yieldToPage = () => new Promise((resolve) => setTimeout(resolve, 0));

  async function sliceBalanced(text, open) {
    let depth = 0;
    let index = open;
    let nextYield = open + SCAN_YIELD_CHARS;
    while (index < text.length) {
      if (index >= nextYield) {
        await yieldToPage();
        nextYield = index + SCAN_YIELD_CHARS;
      }
      const code = text.charCodeAt(index);
      if (code === QUOTE) {
        index = skipJsonString(text, index);
        continue;
      }
      if (code === OPEN_BRACKET || code === OPEN_BRACE) depth += 1;
      else if (code === CLOSE_BRACKET || code === CLOSE_BRACE) {
        depth -= 1;
        if (depth === 0) return text.slice(open, index + 1);
      }
      index += 1;
    }
    return text.slice(open);
  }

  // A label is a JSON string, escapes and all ("Caf\u00e9"); one that is not valid JSON is kept as written.
  function decodeJsonString(quoted) {
    try {
      const value = JSON.parse(quoted);
      if (typeof value === 'string') return value;
    } catch (_) { }
    return quoted.slice(1, -1);
  }

  // Only the Archives array is parsed; Directives can be hundreds of megabytes.
  async function scanManifest(text) {
    const scalars = {};
    let archivesJson = '';
    let depth = 0;
    let index = 0;
    let nextYield = SCAN_YIELD_CHARS;

    while (index < text.length) {
      if (index >= nextYield) {
        await yieldToPage();
        nextYield = index + SCAN_YIELD_CHARS;
      }
      const code = text.charCodeAt(index);
      if (code !== QUOTE) {
        if (code === OPEN_BRACE || code === OPEN_BRACKET) depth += 1;
        else if (code === CLOSE_BRACE || code === CLOSE_BRACKET) depth -= 1;
        index += 1;
        continue;
      }

      const keyStart = index;
      const afterKey = skipJsonString(text, index);
      index = afterKey;
      if (depth !== 1) continue;

      let cursor = afterKey;
      while (cursor < text.length && text.charCodeAt(cursor) <= 32) cursor += 1;
      if (text.charCodeAt(cursor) !== COLON) continue;
      cursor += 1;
      while (cursor < text.length && text.charCodeAt(cursor) <= 32) cursor += 1;

      // JSON permits the same escapes in property names as in values ("\\u0041rchives").
      const key = decodeJsonString(text.slice(keyStart, afterKey));
      if (key === 'Archives' && !archivesJson && text.charCodeAt(cursor) === OPEN_BRACKET) {
        archivesJson = await sliceBalanced(text, cursor);
        index = cursor + archivesJson.length;
        continue;
      }
      if (MANIFEST_SCALAR_KEYS.has(key) && text.charCodeAt(cursor) === QUOTE) {
        const end = skipJsonString(text, cursor);
        scalars[key] = decodeJsonString(text.slice(cursor, end));
        index = end;
      }
    }

    return { archivesJson, scalars };
  }

  function decodeManifestText(bytes) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (cause) {
      throw new WabbajackImportError('bad-encoding', 'The modlist is not valid UTF-8.', cause);
    }
  }

  async function parseManifest(text) {
    const { archivesJson, scalars } = await scanManifest(text);
    if (!archivesJson) {
      throw new WabbajackImportError('bad-modlist', 'The modlist has no Archives list.');
    }
    if (archivesJson.length > MAX_ARCHIVES_JSON_BYTES) {
      throw new WabbajackImportError('too-many-entries', 'The modlist archive list is too large to read safely.');
    }

    let archives;
    try {
      archives = JSON.parse(archivesJson);
    } catch (cause) {
      throw new WabbajackImportError('bad-modlist', `The modlist is not valid JSON — ${cause.message}`, cause);
    }
    if (!Array.isArray(archives)) {
      throw new WabbajackImportError('bad-modlist', 'The modlist has no Archives list.');
    }
    if (archives.length > MAX_ARCHIVE_ENTRIES) {
      throw new WabbajackImportError('too-many-entries', 'The modlist contains too many archive entries.');
    }
    return { ...scalars, Archives: archives };
  }

  // A modlist is usually downloaded as a plain archive holding the .wabbajack and its
  // .meta.json, so the file the user picks is often the container rather than the modlist.
  const MODLIST_SUFFIX = '.wabbajack';
  const UNREADABLE_CONTAINERS = [
    { label: 'RAR', bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07] },
    { label: '7z', bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] }
  ];

  async function describeUnreadableContainer(file) {
    if (file.size < 8) return '';
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    const match = UNREADABLE_CONTAINERS.find(({ bytes }) => bytes.every((byte, index) => head[index] === byte));
    return match ? match.label : '';
  }

  async function readModlistBytes(file) {
    const direct = await NexusExt.ZipReader.readEntry(file, 'modlist', { maxBytes: MAX_MODLIST_BYTES });
    if (direct) return direct;

    // No "modlist" entry, so this is not a .wabbajack. It may be the archive one came in.
    const inner = await NexusExt.ZipReader.sliceStoredEntry(file, MODLIST_SUFFIX);
    if (!inner) return null;
    return NexusExt.ZipReader.readEntry(inner.blob, 'modlist', { maxBytes: MAX_MODLIST_BYTES });
  }

  async function importFile(file) {
    if (!file || typeof file.slice !== 'function') {
      throw new WabbajackImportError('no-file', 'No .wabbajack file was provided.');
    }
    if (!NexusExt.ZipReader?.readEntry) {
      throw new WabbajackImportError('reader-unavailable', 'The ZIP reader is unavailable.');
    }

    const unreadable = await describeUnreadableContainer(file);
    if (unreadable) {
      const error = new WabbajackImportError('needs-extracting',
        `This is a ${unreadable} archive, which cannot be opened here.`
        + ' Extract it and pick the .wabbajack file inside.');
      // Named separately so the dialog can say which format without parsing the message.
      error.format = unreadable;
      throw error;
    }

    let bytes;
    try {
      bytes = await readModlistBytes(file);
    } catch (cause) {
      if (cause instanceof NexusExt.ZipReader.ZipReaderError) {
        throw new WabbajackImportError(cause.code, cause.message, cause);
      }
      throw cause;
    }
    if (!bytes) {
      throw new WabbajackImportError('no-modlist',
        'This file is not a modlist and holds no .wabbajack file — pick the .wabbajack itself,'
        + ' or the archive you downloaded it in.');
    }

    let text = decodeManifestText(bytes);
    bytes = null;
    const manifest = await parseManifest(text);
    text = null;
    const analyzed = analyzeManifest(manifest);
    return {
      name: cleanText(manifest.Name),
      author: cleanText(manifest.Author),
      version: cleanText(manifest.Version, 100),
      gameName: cleanText(manifest.GameType, 100),
      ...analyzed
    };
  }

  // Ordinary ASCII names retain their existing history id. A Unicode title can lose its entire
  // identity except a year, and truncation can lose the distinguishing part of a long title, so
  // those names keep a hash too. Canonical Unicode spellings describe the same list.
  const MODLIST_ID_UNSAFE = /[^A-Za-z0-9._-]+/g;

  function modlistId(list) {
    const name = String(list?.name || '').normalize('NFC');
    const base = name.replace(MODLIST_ID_UNSAFE, '-').replace(/^-+|-+$/g, '');
    if (base && base.length <= 125 && !/[^\p{ASCII}]/u.test(name)) return `wj-${base}`;
    const identity = [name, list?.author, list?.version].map((value) => String(value ?? '').normalize('NFC')).join('\n');
    if (!identity.trim()) return 'wj-modlist';
    let hash = 0x811c9dc5;
    for (let index = 0; index < identity.length; index += 1) {
      hash = Math.imul(hash ^ identity.charCodeAt(index), 0x01000193) >>> 0;
    }
    const suffix = hash.toString(36).padStart(7, '0');
    return base ? `wj-${base.slice(0, 128 - 4 - suffix.length)}-${suffix}` : `wj-${suffix}`;
  }

  function toQueueMods(result) {
    const items = Array.isArray(result?.items) ? result.items : [];
    return items.map((item) => ({
      fileId: item.fileId,
      historyId: `${item.gameId}:${item.fileId}`,
      optional: false,
      file: {
        fileId: item.fileId,
        name: item.name,
        size: item.sizeKb,
        url: `https://www.nexusmods.com/${item.gameDomain}/mods/${item.modId}?tab=files&file_id=${item.fileId}`,
        mod: {
          name: item.modName || item.name,
          modId: item.modId,
          game: { domainName: item.gameDomain, id: item.gameId }
        }
      }
    }));
  }


  // Incremental MD5 (RFC 1321) so a local archive of any size can be hashed in chunks. Used only to
  // look a file up with the official API's fileHash query; Wabbajack's own hashes are xxHash64 and
  // cannot be looked up there.
  const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

  function createMd5() {
    const state = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
    const buffer = new Uint8Array(64);
    const words = new Uint32Array(16);
    let buffered = 0;
    let length = 0;

    function block(bytes, offset) {
      for (let i = 0; i < 16; i++) {
        const j = offset + i * 4;
        words[i] = bytes[j] | (bytes[j + 1] << 8) | (bytes[j + 2] << 16) | (bytes[j + 3] << 24);
      }
      let [a, b, c, d] = state;
      for (let i = 0; i < 64; i++) {
        let f;
        let g;
        if (i < 16) { f = (b & c) | (~b & d); g = i; } else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; } else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; } else { f = c ^ (b | ~d); g = (7 * i) % 16; }
        const temp = d;
        d = c;
        c = b;
        const sum = (a + f + MD5_K[i] + words[g]) >>> 0;
        b = (b + ((sum << MD5_S[i]) | (sum >>> (32 - MD5_S[i])))) >>> 0;
        a = temp;
      }
      state[0] += a; state[1] += b; state[2] += c; state[3] += d;
    }

    function update(bytes) {
      let i = 0;
      length += bytes.length;
      if (buffered) {
        while (buffered < 64 && i < bytes.length) buffer[buffered++] = bytes[i++];
        if (buffered < 64) return;
        block(buffer, 0);
        buffered = 0;
      }
      for (; i + 64 <= bytes.length; i += 64) block(bytes, i);
      while (i < bytes.length) buffer[buffered++] = bytes[i++];
    }

    function digest() {
      const bits = length * 8;
      const pad = new Uint8Array(((buffered < 56 ? 56 : 120) - buffered) + 8);
      pad[0] = 0x80;
      const lo = bits >>> 0;
      const hi = Math.floor(bits / 2 ** 32) >>> 0;
      for (let i = 0; i < 4; i++) {
        pad[pad.length - 8 + i] = (lo >>> (8 * i)) & 0xff;
        pad[pad.length - 4 + i] = (hi >>> (8 * i)) & 0xff;
      }
      const saved = length;
      update(pad);
      length = saved;
      return Array.from(new Uint8Array(state.buffer)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
    }

    return { update, digest };
  }

  function md5Bytes(bytes) {
    const hash = createMd5();
    hash.update(bytes);
    return hash.digest();
  }

  const MD5_CHUNK = 4 * 1024 * 1024;
  async function md5File(file, { onProgress, signal } = {}) {
    if (signal?.aborted) throw new Error('aborted');
    const hash = createMd5();
    for (let offset = 0; offset < file.size; offset += MD5_CHUNK) {
      if (signal?.aborted) throw new Error('aborted');
      const chunk = new Uint8Array(await file.slice(offset, offset + MD5_CHUNK).arrayBuffer());
      if (signal?.aborted) throw new Error('aborted');
      hash.update(chunk);
      onProgress?.(Math.min(1, (offset + chunk.length) / file.size));
    }
    if (signal?.aborted) throw new Error('aborted');
    return hash.digest();
  }

  // Looks local archives up by MD5 through the official API. Resolves one entry per file.
  async function identifyArchives(files, { api = NexusExt.NexusApi?.shared?.(), onProgress, signal } = {}) {
    const results = [];
    for (const file of Array.from(files || [])) {
      if (signal?.aborted) break;
      try {
        const md5 = await md5File(file, { signal, onProgress: (share) => onProgress?.(file, share) });
        const matches = api ? await api.fileByMd5(md5, { signal }) : [];
        const match = matches.find((entry) => entry?.modFile?.mod?.game?.domainName) || null;
        results.push({
          name: file.name,
          md5,
          match: match && {
            modName: cleanText(match.modFile.mod.name),
            fileName: cleanText(match.modFile.name || match.fileName),
            version: cleanText(match.modFile.version),
            url: `https://www.nexusmods.com/${match.modFile.mod.game.domainName}/mods/${match.modFile.mod.modId}?tab=files&file_id=${match.modFile.fileId}`
          }
        });
      } catch (cause) {
        if (signal?.aborted) break;
        results.push({ name: file.name, md5: '', match: null, error: String(cause?.message || cause) });
      }
    }
    return results;
  }

  NexusExt.WabbajackImporter = Object.freeze({
    GAMES,
    GAME_IDS,
    WabbajackImportError,
    analyzeManifest,
    importFile,
    modlistId,
    toQueueMods,
    md5Bytes,
    md5File,
    identifyArchives
  });
})();
