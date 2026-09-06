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

  const GAME_IDS = Object.freeze(Object.fromEntries(
    Object.entries(GAMES).map(([name, metadata]) => [name, metadata?.id ?? null])
  ));

  const NEXUS_STATE_TYPE = /(?:^|\.)NexusDownloader(?:\+State)?$/i;
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
      const gameName = cleanText(state.GameName, 100);
      if (!modId || !fileId || !gameName) {
        skip(name, 'incomplete-entry');
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(GAMES, gameName)) {
        skip(name, `unknown-game:${gameName}`);
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

  function sliceBalanced(text, open) {
    let depth = 0;
    let index = open;
    while (index < text.length) {
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

  // Only the Archives array is parsed; Directives can be hundreds of megabytes.
  function scanManifest(text) {
    const scalars = {};
    let archivesJson = '';
    let depth = 0;
    let index = 0;

    while (index < text.length) {
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

      const key = text.slice(keyStart + 1, afterKey - 1);
      if (key === 'Archives' && !archivesJson && text.charCodeAt(cursor) === OPEN_BRACKET) {
        archivesJson = sliceBalanced(text, cursor);
        index = cursor + archivesJson.length;
        continue;
      }
      if (MANIFEST_SCALAR_KEYS.has(key) && text.charCodeAt(cursor) === QUOTE) {
        const end = skipJsonString(text, cursor);
        scalars[key] = text.slice(cursor + 1, end - 1);
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

  function parseManifest(text) {
    const { archivesJson, scalars } = scanManifest(text);
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
    const manifest = parseManifest(text);
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

  NexusExt.WabbajackImporter = Object.freeze({
    GAMES,
    GAME_IDS,
    WabbajackImportError,
    analyzeManifest,
    importFile,
    toQueueMods
  });
})();
