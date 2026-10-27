import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';

const context = vm.createContext({
  window: {}, console, Blob, DecompressionStream, TextDecoder, TextEncoder, setTimeout,
  DataView, Uint8Array, ArrayBuffer, Number, Math, JSON, Object, Array,
  String, Error, RegExp, Promise, URL, BigInt
});

for (const file of ['src/content/zip-reader.js', 'src/content/wabbajack-importer.js']) {
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
}

const ZipReader = context.window.NexusExt.ZipReader;
const Importer = context.window.NexusExt.WabbajackImporter;

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return (bytes) => {
    let value = 0xffffffff;
    for (const byte of bytes) value = table[(value ^ byte) & 0xff] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
  };
})();

function buildZip(entries, options = {}) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const body = entry.store ? raw : zlib.deflateRawSync(raw);
    const method = entry.method ?? (entry.store ? 0 : 8);
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const localNameBytes = Buffer.from(entry.localName ?? entry.name, 'utf8');
    const localFlags = entry.localFlags ?? entry.flags ?? 0;
    const centralFlags = entry.centralFlags ?? entry.flags ?? 0;
    const crc = entry.crc ?? CRC(raw);
    const compressedSize = entry.compressedSize ?? body.length;
    const uncompressedSize = entry.uncompressedSize ?? raw.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(localFlags, 6);
    local.writeUInt16LE(method, 8);
    // A writer using a data descriptor (flag bit 3) leaves these zero in the local header.
    const localSizes = entry.localSizes !== false;
    local.writeUInt32LE(localSizes ? crc : 0, 14);
    local.writeUInt32LE(localSizes ? compressedSize : 0, 18);
    local.writeUInt32LE(localSizes ? uncompressedSize : 0, 22);
    local.writeUInt16LE(localNameBytes.length, 26);

    const directory = Buffer.alloc(46);
    const centralExtra = entry.centralExtra ?? Buffer.alloc(0);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(centralFlags, 8);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(compressedSize, 20);
    directory.writeUInt32LE(uncompressedSize, 24);
    directory.writeUInt16LE(nameBytes.length, 28);
    directory.writeUInt16LE(centralExtra.length, 30);
    directory.writeUInt16LE(entry.diskStart ?? 0, 34);
    directory.writeUInt32LE(entry.localOffset ?? offset, 42);

    chunks.push(local, localNameBytes, body);
    central.push(directory, nameBytes, centralExtra);
    offset += local.length + localNameBytes.length + body.length;
  }

  const centralBuffer = Buffer.concat(central);
  const comment = options.comment || Buffer.alloc(0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(options.disk ?? 0, 4);
  eocd.writeUInt16LE(options.centralDisk ?? 0, 6);
  eocd.writeUInt16LE(options.entriesOnDisk ?? entries.length, 8);
  eocd.writeUInt16LE(options.entriesTotal ?? entries.length, 10);
  eocd.writeUInt32LE(options.centralSize ?? centralBuffer.length, 12);
  eocd.writeUInt32LE(options.centralOffset ?? offset, 16);
  eocd.writeUInt16LE(comment.length, 20);

  return new Blob([Buffer.concat([...chunks, centralBuffer, eocd, comment])]);
}

function buildZip64WithMaxComment(name, data) {
  const raw = Buffer.from(data);
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(CRC(raw), 14);
  local.writeUInt32LE(raw.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);

  const centralOffset = local.length + nameBytes.length + raw.length;
  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50, 0);
  directory.writeUInt16LE(45, 4);
  directory.writeUInt16LE(20, 6);
  directory.writeUInt16LE(0, 10);
  directory.writeUInt32LE(CRC(raw), 16);
  directory.writeUInt32LE(raw.length, 20);
  directory.writeUInt32LE(raw.length, 24);
  directory.writeUInt16LE(nameBytes.length, 28);
  directory.writeUInt32LE(0, 42);
  const centralSize = directory.length + nameBytes.length;

  const zip64Offset = centralOffset + centralSize;
  const zip64 = Buffer.alloc(56);
  zip64.writeUInt32LE(0x06064b50, 0);
  zip64.writeBigUInt64LE(44n, 4);
  zip64.writeUInt16LE(45, 12);
  zip64.writeUInt16LE(45, 14);
  zip64.writeBigUInt64LE(1n, 24);
  zip64.writeBigUInt64LE(1n, 32);
  zip64.writeBigUInt64LE(BigInt(centralSize), 40);
  zip64.writeBigUInt64LE(BigInt(centralOffset), 48);

  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(zip64Offset), 8);
  locator.writeUInt32LE(1, 16);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0xffff, 8);
  eocd.writeUInt16LE(0xffff, 10);
  eocd.writeUInt32LE(0xffffffff, 12);
  eocd.writeUInt32LE(0xffffffff, 16);
  eocd.writeUInt16LE(0xffff, 20);

  const comment = Buffer.alloc(0xffff, 0x61);
  comment.writeUInt32LE(0x06054b50, 123);
  return new Blob([Buffer.concat([
    local, nameBytes, raw, directory, nameBytes, zip64, locator, eocd, comment
  ])]);
}

function nexusArchive(gameName, modId, fileId, overrides = {}) {
  return {
    Name: overrides.Name || `${gameName}-${fileId}.7z`,
    Size: overrides.Size ?? 2048,
    State: {
      $type: 'NexusDownloader, Wabbajack.Lib',
      GameName: gameName,
      ModID: modId,
      FileID: fileId,
      Name: overrides.modName || '',
      ...overrides.State
    }
  };
}

const MODLIST = {
  Name: 'Test List',
  Author: 'Someone',
  Version: '1.2.3',
  GameType: 'SkyrimSpecialEdition',
  Archives: [
    nexusArchive('SkyrimSpecialEdition', 266, 1000, { Size: 5 * 1024 * 1024, modName: 'Cool Mod' }),
    nexusArchive('OblivionRemastered', 5, 6),
    {
      Name: 'FromGoogleDrive.7z',
      State: { $type: 'GoogleDriveDownloader+State, Wabbajack.Lib', Id: 'abc' }
    },
    nexusArchive('Skyrim', 0, 7, { Name: 'Broken.7z' })
  ]
};

async function rejectsCode(action, code, message) {
  await assert.rejects(action, (error) => error?.code === code, message || code);
}

(async () => {
  for (const store of [false, true]) {
    const label = store ? 'stored' : 'deflated';
    const zip = buildZip([
      { name: 'meta', data: 'ignored' },
      { name: 'modlist', data: JSON.stringify(MODLIST), store },
      { name: 'image.png', data: 'x'.repeat(500) }
    ]);
    const list = await Importer.importFile(zip);
    assert.equal(list.name, 'Test List', `${label}: manifest metadata`);
    assert.equal(list.total, 4, `${label}: archive count`);
    assert.equal(list.items.length, 2, `${label}: usable Nexus entries`);
    assert.equal(list.items[0].gameId, 1704);
    assert.equal(list.items[0].sizeKb, 5120);
    assert.equal(list.items[1].gameDomain, 'oblivionremastered');
    assert.deepEqual(
      [...list.skipped].map((entry) => `${entry.name}:${entry.reason}`).sort(),
      ['Broken.7z:incomplete-entry', 'FromGoogleDrive.7z:not-on-nexus:GoogleDrive']
    );

    const mods = Importer.toQueueMods(list);
    assert.equal(mods[0].historyId, '1704:1000');
    assert.equal(mods[0].file.mod.game.domainName, 'skyrimspecialedition');
    const url = new URL(mods[0].file.url);
    assert.equal(url.hostname, 'www.nexusmods.com');
    assert.equal(url.searchParams.get('file_id'), '1000');
  }

  const mappings = {
    Stalker2: ['stalker2heartofchornobyl', 6944],
    Fallout76: ['fallout76', 2590],
    Fallout4London: ['fallout4london', 6332],
    Warhammer40kDarktide: ['warhammer40kdarktide', 4943],
    Kotor2: ['kotor2', 198],
    VtMB: ['vampirebloodlines', 437],
    KingdomComeDeliverance2: ['kingdomcomedeliverance2', 7286],
    DragonsDogma2: ['dragonsdogma2', 6234],
    NieRAutomata: ['nierautomata', 1950],
    Terraria: ['terraria', 549]
  };
  for (const [name, [domain, id]] of Object.entries(mappings)) {
    assert.equal(Importer.GAMES[name].domain, domain, `${name}: Nexus domain`);
    assert.equal(Importer.GAMES[name].id, id, `${name}: Nexus ID`);
  }
  assert.equal(Importer.GAMES.KarrynsPrison, null);

  const analyzed = Importer.analyzeManifest({ Archives: [
    nexusArchive('Skyrim', 1, 42),
    nexusArchive('Skyrim', 2, 42),
    nexusArchive('Fallout4', 3, 42),
    nexusArchive('constructor', 4, 5),
    nexusArchive('__proto__', 4, 6),
    nexusArchive('toString', 4, 7),
    nexusArchive('KarrynsPrison', 4, 8),
    nexusArchive('FutureGame', 4, 9)
  ] });
  assert.equal(analyzed.items.length, 2, 'duplicates are game-aware');
  assert.deepEqual(Array.from(analyzed.items, (item) => item.gameId), [110, 1151]);
  assert.ok([...analyzed.skipped].some((entry) => entry.reason === 'duplicate-entry'));
  assert.ok([...analyzed.skipped].some((entry) => entry.reason === 'unsupported-game:KarrynsPrison'));
  assert.equal([...analyzed.skipped].filter((entry) => entry.reason.startsWith('unknown-game:')).length, 4);

  for (const invalid of [true, '0x10', '1e3', 1.5, 0, -1, '', null]) {
    const result = Importer.analyzeManifest({ Archives: [nexusArchive('Skyrim', invalid, 12)] });
    assert.equal(result.items.length, 0, `invalid ID rejected: ${String(invalid)}`);
    assert.equal(result.skipped[0].reason, 'incomplete-entry');
  }
  assert.equal(
    Importer.analyzeManifest({ Archives: [nexusArchive('Skyrim', '123', '456')] }).items.length,
    1,
    'plain decimal string IDs are accepted'
  );

  const legacy = nexusArchive('Skyrim', 1, 2, {
    State: { $type: 'NexusDownloader+State, Wabbajack.Lib' }
  });
  assert.equal(Importer.analyzeManifest({ Archives: [legacy] }).items.length, 1);
  const namespaced = nexusArchive('Skyrim', 1, 2, {
    State: { $type: 'Wabbajack.Downloaders.Nexus.NexusDownloader, Wabbajack.Downloaders.Nexus' }
  });
  assert.equal(Importer.analyzeManifest({ Archives: [namespaced] }).items.length, 1);
  for (const type of ['Nexus', 'nexus', 'Wabbajack.DTOs.DownloadStates.Nexus, Wabbajack.DTOs']) {
    const alias = nexusArchive('Skyrim', 1, 2, { State: { $type: type } });
    const list = await Importer.importFile(buildZip([{
      name: 'modlist', data: JSON.stringify({ Archives: [alias] })
    }]));
    assert.equal(list.items.length, 1, `${type}: a Nexus DTO alias imports its file`);
    assert.equal(list.items[0].fileId, 2);
    assert.equal(list.skipped.length, 0, `${type}: the entry is not mistaken for an external download`);
  }
  assert.equal(Importer.analyzeManifest({ Archives: [
    nexusArchive('Skyrim', 1, 2, { State: { $type: 'NotNexus' } })
  ] }).items.length, 0, 'an unrelated declared downloader cannot match the Nexus alias');
  const untyped = nexusArchive('Skyrim', 1, 2, { State: { $type: undefined } });
  assert.equal(Importer.analyzeManifest({ Archives: [untyped] }).items.length, 1);
  const unrelated = nexusArchive('Skyrim', 1, 2, {
    State: { $type: 'GoogleDriveDownloader+State, Wabbajack.Lib' }
  });
  assert.equal(Importer.analyzeManifest({ Archives: [unrelated] }).items.length, 0);

  await rejectsCode(
    () => Importer.importFile(buildZip([{ name: 'meta', data: 'none' }])),
    'no-modlist'
  );
  await rejectsCode(() => Importer.importFile(new Blob(['not a zip'])), 'not-a-zip');
  await rejectsCode(
    () => Importer.importFile(buildZip([{ name: 'modlist', data: '{ broken' }])),
    'bad-modlist'
  );
  await rejectsCode(
    () => Importer.importFile(buildZip([{ name: 'modlist', data: Buffer.from([0xc3, 0x28]) }])),
    'bad-encoding'
  );
  await rejectsCode(
    () => Importer.importFile(buildZip([{
      name: 'modlist',
      data: JSON.stringify({ Archives: Array(10001).fill(null) })
    }])),
    'too-many-entries'
  );
  await rejectsCode(() => Importer.importFile(null), 'no-file');

  await rejectsCode(
    () => ZipReader.readEntry(buildZip([{ name: 'modlist', data: 'hello', crc: 1 }]), 'modlist'),
    'corrupt-entry'
  );
  await rejectsCode(
    () => ZipReader.readEntry(buildZip([{ name: 'modlist', data: 'hello', flags: 1 }]), 'modlist'),
    'encrypted-entry'
  );
  await rejectsCode(
    () => ZipReader.readEntry(buildZip([{ name: 'modlist', data: 'hello' }], { disk: 1 }), 'modlist'),
    'split-archive'
  );
  await rejectsCode(
    () => ZipReader.readEntry(buildZip([{ name: 'modlist', localName: 'different', data: 'hello' }]), 'modlist'),
    'bad-entry'
  );
  await rejectsCode(
    () => ZipReader.readEntry(buildZip([{ name: 'modlist', data: 'x'.repeat(4096), uncompressedSize: 1 }]), 'modlist', { maxBytes: 100 }),
    'entry-too-large'
  );
  await rejectsCode(
    () => ZipReader.readEntry(buildZip([{ name: 'modlist', data: 'hello', localOffset: 999999 }]), 'modlist'),
    'bad-entry'
  );

  const comment = Buffer.alloc(64, 0x61);
  comment.writeUInt32LE(0x06054b50, 7);
  const commentZip = buildZip([{ name: 'modlist', data: JSON.stringify(MODLIST), store: true }], { comment });
  assert.equal((await Importer.importFile(commentZip)).items.length, 2, 'EOCD bytes inside comments are ignored');

  const zip64 = buildZip64WithMaxComment('modlist', JSON.stringify(MODLIST));
  assert.equal((await Importer.importFile(zip64)).items.length, 2, 'ZIP64 works with the largest legal comment');

  // A per-entry ZIP64 field only has to carry the values whose legacy field is
  // saturated, but writers exist that emit the whole triple regardless.
  const zip64Extra = (...values) => {
    const extra = Buffer.alloc(4 + 8 * values.length);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(8 * values.length, 2);
    values.forEach((value, index) => extra.writeBigUInt64LE(value, 4 + index * 8));
    return extra;
  };
  const zip64Entry = (centralExtra, overrides = {}) => buildZip([{
    name: 'modlist',
    data: JSON.stringify(MODLIST),
    store: true,
    localOffset: 0xffffffff,
    centralExtra,
    ...overrides
  }]);
  const payloadSize = BigInt(Buffer.byteLength(JSON.stringify(MODLIST)));

  assert.equal(
    (await Importer.importFile(zip64Entry(zip64Extra(0n)))).items.length,
    2,
    'a ZIP64 field holding only the saturated offset is read'
  );
  assert.equal(
    (await Importer.importFile(zip64Entry(zip64Extra(payloadSize, payloadSize, 0n)))).items.length,
    2,
    'a ZIP64 field padded with unsaturated sizes still resolves the offset'
  );
  assert.equal(
    (await Importer.importFile(zip64Entry(
      zip64Extra(payloadSize, payloadSize, 0n),
      { uncompressedSize: 0xffffffff, compressedSize: 0xffffffff }
    ))).items.length,
    2,
    'all three saturated fields are read in order'
  );
  await rejectsCode(
    () => ZipReader.readEntry(zip64Entry(Buffer.alloc(0)), 'modlist'),
    'zip64-missing',
    'a saturated offset without its ZIP64 field is refused'
  );


  // The modlist's own labels are JSON strings: an escape in them is decoded, never shown raw.
  const escaped = `{"Archives":${JSON.stringify(MODLIST.Archives)},"Name":"Caf\\u00e9 \\"Deluxe\\" \\\\ 2","Author":"A\\/B","Version":"1.0"}`;
  const escapedList = await Importer.importFile(buildZip([{ name: 'modlist', data: escaped }]));
  assert.equal(escapedList.name, 'Café "Deluxe" \\ 2', 'escapes in the modlist name are decoded');
  assert.equal(escapedList.author, 'A/B');
  const brokenEscape = '{"Archives":[],"Name":"bad \\x escape"}';
  assert.equal((await Importer.importFile(buildZip([{ name: 'modlist', data: brokenEscape }]))).name, 'bad \\x escape',
    'a label that is not valid JSON is kept as written rather than failing the import');

  // Game names are matched whatever their case.
  const cased = Importer.analyzeManifest({ Archives: [nexusArchive('skyrimspecialedition', 3, 4), nexusArchive('FALLOUT4', 5, 6)] });
  assert.deepEqual([...cased.items.map((item) => item.gameDomain)], ['skyrimspecialedition', 'fallout4'], 'a game name in another case is mapped');
  assert.deepEqual([...cased.skipped], []);

  // A modlist's history id: names with no ASCII letters used to collapse to "wj-modlist", so two such
  // lists shared one download history.
  const greek = Importer.modlistId({ name: 'Ελληνική λίστα', author: 'Κάποιος', version: '1' });
  const japanese = Importer.modlistId({ name: '日本語のリスト', author: 'someone', version: '1' });
  assert.match(greek, /^wj-[a-z0-9]{6,}$/, 'a name with no usable characters gets a stable hashed id');
  assert.notEqual(greek, japanese, 'two such lists get different ids');
  assert.equal(greek, Importer.modlistId({ name: 'Ελληνική λίστα', author: 'Κάποιος', version: '1' }), 'the same list always gets the same id');
  assert.equal(Importer.modlistId({ name: 'Living Skyrim 4' }), 'wj-Living-Skyrim-4', 'an ASCII name keeps its readable id');
  assert.ok(Importer.modlistId({ name: 'x'.repeat(400) }).length <= 128);

  // Entry data is streamed from slices of the file (xorshift noise, so deflate cannot shrink it): never one read of the whole packed entry, and the
  // inflated output is checked as it arrives.
  const noise = Buffer.alloc(3 * 1024 * 1024);
  let seedValue = 7;
  for (let index = 0; index < noise.length; index += 1) {
    seedValue ^= seedValue << 13; seedValue >>>= 0;
    seedValue ^= seedValue >>> 17;
    seedValue ^= seedValue << 5; seedValue >>>= 0;
    noise[index] = seedValue & 0xff;
  }
  const watch = (blob) => {
    const reads = [];
    const wrap = (inner, offset) => ({
      size: inner.size,
      slice: (start = 0, end = inner.size) => wrap(inner.slice(start, end), offset + start),
      arrayBuffer: () => { reads.push(inner.size); return inner.arrayBuffer(); },
      stream: () => inner.stream()
    });
    return { file: wrap(blob, 0), reads };
  };
  for (const store of [false, true]) {
    const watched = watch(buildZip([{ name: 'modlist', data: noise, store }]));
    const read = await ZipReader.readEntry(watched.file, 'modlist', { maxBytes: 8 * 1024 * 1024 });
    assert.equal(Buffer.compare(Buffer.from(read), noise), 0, `${store ? 'stored' : 'deflated'}: the entry is read intact`);
    assert.ok(Math.max(...watched.reads) <= 1024 * 1024,
      `${store ? 'stored' : 'deflated'}: no single read of more than 1 MiB (largest ${Math.max(...watched.reads)})`);
  }

  // A deflated entry in ZIP64 form, and one written with a data descriptor (bit 3): its local header
  // carries no sizes or CRC, which is why they are only ever taken from the directory.
  const payload = JSON.stringify(MODLIST);
  const deflatedSize = BigInt(zlib.deflateRawSync(Buffer.from(payload)).length);
  assert.equal((await Importer.importFile(zip64Entry(
    zip64Extra(BigInt(Buffer.byteLength(payload)), deflatedSize, 0n),
    { store: false, uncompressedSize: 0xffffffff, compressedSize: 0xffffffff }
  ))).items.length, 2, 'a deflated ZIP64 entry is read');
  assert.equal((await Importer.importFile(buildZip([{ name: 'modlist', data: payload, flags: 8, localSizes: false }]))).items.length, 2,
    'an entry written with a data descriptor is read');
  await rejectsCode(
    () => ZipReader.readEntry(buildZip([{ name: 'modlist', data: 'x'.repeat(200), uncompressedSize: 100 }]), 'modlist', { maxBytes: 1000 }),
    'corrupt-entry', 'an entry that unpacks to more than it declares is refused');

  // A 10,000-archive modlist is parsed in steps: the page gets its turn while it is read.
  const manyArchives = Array.from({ length: 10000 }, (_, index) => nexusArchive('SkyrimSpecialEdition', 100 + index, 50000 + index));
  const filler = JSON.stringify(Array.from({ length: 40000 }, (_, index) => ({ $type: 'FromArchive, Wabbajack.Lib', To: `mods/x/${index}.dds` })));
  const large = `{"Archives":${JSON.stringify(manyArchives)},"Directives":${filler},"Name":"Large"}`;
  let ticks = 0;
  let ticking = true;
  const tick = () => { if (!ticking) return; ticks += 1; setTimeout(tick, 0); };
  setTimeout(tick, 0);
  const largeList = await Importer.importFile(buildZip([{ name: 'modlist', data: large, store: true }]));
  ticking = false;
  assert.equal(largeList.items.length, 10000);
  assert.ok(ticks >= 3, `the page's own tasks ran while ${(large.length / 1048576).toFixed(1)} MiB were read (${ticks} turns)`);

  // Wabbajack writes GameType, Name and Version *after* the Directives array, and
  // Directives is where the size lives, so the reader has to walk past all of it
  // without parsing it.
  const bigModlist = (() => {
    const archives = MODLIST.Archives.map((archive) => JSON.stringify(archive)).join(',');
    const directive = (index) => JSON.stringify({
      $type: 'FromArchive, Wabbajack.Lib',
      To: `mods/Some Mod/textures/body_${index}.dds`,
      // Decoys: a nested Archives key and JSON punctuation inside strings.
      Archives: [{ Name: 'not the real list' }],
      Note: 'brackets ]} and a quote \\" inside a string',
      ArchiveHashPath: ['hash', `textures\\body_${index}.dds`]
    });
    const directives = Array.from({ length: 6000 }, (_, index) => directive(index)).join(',');
    return `{"Archives":[${archives}],"Author":"Someone","Directives":[${directives}],`
      + '"GameType":"SkyrimSpecialEdition","Name":"Trailing Name","Version":"9.9.9"}';
  })();

  const bigList = await Importer.importFile(buildZip([{ name: 'modlist', data: bigModlist }]));
  assert.ok(bigModlist.length > 1024 * 1024, `the fixture is worth testing (${bigModlist.length} bytes)`);
  assert.equal(bigList.items.length, 2, 'the archive list is read past a large Directives array');
  assert.equal(bigList.total, 4, 'every archive entry is counted');
  assert.equal(bigList.name, 'Trailing Name', 'a label written after Directives is still found');
  assert.equal(bigList.version, '9.9.9');
  assert.equal(bigList.gameName, 'SkyrimSpecialEdition');
  assert.equal(bigList.items[0].modId, 266, 'a nested Archives key is not mistaken for the real one');

  await rejectsCode(
    () => Importer.importFile(buildZip([{ name: 'modlist', data: '[{"Archives":[]}]' }])),
    'bad-modlist',
    'an array at the root has no top-level Archives'
  );
  await rejectsCode(
    () => Importer.importFile(buildZip([{ name: 'modlist', data: '{"Archives":null}' }])),
    'bad-modlist',
    'Archives has to be an array'
  );
  await rejectsCode(
    () => Importer.importFile(buildZip([{ name: 'modlist', data: '{"Archives":[{"Name":"unclosed"' }])),
    'bad-modlist',
    'an unterminated archive list is refused'
  );

  const oversized = buildZip([{
    name: 'modlist',
    data: 'x'.repeat(4096),
    uncompressedSize: 8 * 1024 * 1024
  }]);
  await assert.rejects(
    () => ZipReader.readEntry(oversized, 'modlist', { maxBytes: 2 * 1024 * 1024 }),
    (error) => (
      error.code === 'entry-too-large'
      && /"modlist" entry holds 8\.0 MiB/.test(error.message)
      && /above the 2\.0 MiB this build reads/.test(error.message)
    ),
    'the refusal names the entry, its size and the limit'
  );

  // What a real modlist actually contains besides Nexus files: vanilla game data
  // taken from the installed game, and files Wabbajack fetches itself.
  const offNexus = Importer.analyzeManifest({
    Archives: [
      { Name: 'Data_Update.esm', State: { $type: 'GameFileSourceDownloader, Wabbajack.Lib', Game: 'SkyrimSpecialEdition' } },
      { Name: 'Mod.Organizer-2.5.2.7z', State: { $type: 'HttpDownloader, Wabbajack.Lib', Url: 'https://github.com/x/y' } },
      { Name: 'Synthesis.zip', State: { $type: 'Wabbajack.DTOs.DownloadStates.GitHub, Wabbajack.DTOs' } },
      { Name: 'FromMega.7z', State: { $type: 'MegaDownloader+State, Wabbajack.Lib' } },
      { Name: 'AskMe.7z', State: { $type: 'ManualDownloader, Wabbajack.Lib' } },
      { Name: 'NoType.7z', State: { Url: 'https://example.invalid/x.7z' } }
    ]
  });
  assert.equal(offNexus.items.length, 0, 'none of these are Nexus files');
  assert.deepEqual(
    [...offNexus.skipped].map((entry) => entry.reason),
    [
      'not-on-nexus:GameFileSource',
      'not-on-nexus:Http',
      'not-on-nexus:GitHub',
      'not-on-nexus:Mega',
      'not-on-nexus:Manual',
      'not-on-nexus'
    ],
    'the source is named so the count can be acted on'
  );

  // What a user actually downloads is an archive holding the modlist and its .meta.json,
  // so the file they pick is usually the container rather than the .wabbajack itself.
  const modlistBytes = async (options = {}) => Buffer.from(await buildZip([
    { name: 'modlist', data: JSON.stringify(MODLIST), store: true }
  ], options).arrayBuffer());

  const inner = await modlistBytes();

  const wrapped = buildZip([
    { name: 'Test List.wabbajack.meta.json', data: '{"directURL":"https://example.invalid"}' },
    { name: 'Test List.wabbajack', data: inner, store: true }
  ]);
  const fromContainer = await Importer.importFile(wrapped);
  assert.equal(fromContainer.name, 'Test List', 'a modlist inside a zip is read');
  assert.equal(fromContainer.total, 4, 'and every archive is accounted for');
  assert.equal(fromContainer.items.length, 2, 'and the Nexus entries are queued');

  // The .meta.json sits next to it and is listed first here on purpose: a match on
  // "contains .wabbajack" rather than "ends with" would pick the wrong file.
  const metaOnly = buildZip([
    { name: 'Test List.wabbajack.meta.json', data: '{"directURL":"https://example.invalid"}' }
  ]);
  await rejectsCode(() => Importer.importFile(metaOnly), 'no-modlist',
    'a .meta.json on its own is not treated as a modlist');

  const upperCase = buildZip([
    { name: 'TEST LIST.WABBAJACK', data: inner, store: true }
  ]);
  assert.equal((await Importer.importFile(upperCase)).name, 'Test List',
    'the extension is matched regardless of case');

  const nested = buildZip([
    { name: 'modlists/Test List.wabbajack', data: inner, store: true }
  ]);
  assert.equal((await Importer.importFile(nested)).name, 'Test List',
    'a modlist inside a folder in the archive is still found');

  // Deflating it would mean unpacking the whole modlist to reach its directory, which is
  // the one thing the slice-only reader exists to avoid.
  const squashed = buildZip([
    { name: 'Test List.wabbajack', data: inner }
  ]);
  await rejectsCode(() => Importer.importFile(squashed), 'entry-compressed',
    'a compressed inner modlist is refused with a reason');

  for (const [label, signature] of [
    ['RAR', [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]],
    ['7z', [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]]
  ]) {
    const container = new Blob([Buffer.from([...signature, ...Buffer.alloc(64)])]);
    await rejectsCode(() => Importer.importFile(container), 'needs-extracting',
      `a ${label} archive is named as something to extract first`);

    // The dialog names the format without having to parse the message text.
    const error = await Importer.importFile(container).then(() => null, (cause) => cause);
    assert.equal(error.format, label, `${label}: the format travels on the error`);
  }

  const emptyZip = buildZip([{ name: 'readme.txt', data: 'nothing useful here' }]);
  await rejectsCode(() => Importer.importFile(emptyZip), 'no-modlist',
    'an archive with neither a modlist nor a .wabbajack is refused');

  // Names are UTF-8. Comparing a decoded name against the raw bytes of the local header
  // would reject anything that is not plain ASCII, since one character is then several
  // bytes and the lengths stop agreeing.
  for (const name of ['Ελληνικά Λίστα.wabbajack', 'Мод-лист.wabbajack', '日本語.wabbajack',
    'Café Modlist.wabbajack']) {
    const utf8 = buildZip([
      { name: `${name}.meta.json`, data: '{}' },
      { name, data: inner, store: true }
    ]);
    assert.equal((await Importer.importFile(utf8)).name, 'Test List',
      `a modlist named "${name}" is read`);
  }

  // The name asked for is restricted to printable ASCII on purpose — only "modlist" is ever
  // requested. Names found inside an archive are a different matter and may be anything,
  // which is why the two are never compared as text. Both halves are pinned down here.
  await rejectsCode(() => ZipReader.readEntry(buildZip([{ name: 'x', data: 'y' }]), 'περιεχόμενο'),
    'bad-entry-name', 'a non-ASCII name cannot be requested');
  await rejectsCode(() => ZipReader.readEntry(buildZip([{ name: 'x', data: 'y' }]), ''),
    'bad-entry-name', 'nor an empty one');
  await rejectsCode(() => ZipReader.sliceStoredEntry(buildZip([{ name: 'x', data: 'y' }]), ''),
    'bad-entry-name', 'and a suffix is held to the same rule');
  assert.equal(await ZipReader.readEntry(buildZip([{ name: 'περιεχόμενο', data: 'ναι', store: true }]), 'modlist'),
    null, 'a UTF-8 entry name is walked past without upsetting the directory scan');

  // A cancellation can land while the final (often only) asynchronous file read is pending.
  // It must stop before hashing that chunk or looking the archive up on Nexus.
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(() => Importer.md5File(new Blob(), { signal: cancelled.signal }), /aborted/,
    'an already-cancelled empty file does not finish hashing');
  const duringRead = new AbortController();
  const cancelledFile = {
    name: 'cancelled.7z', size: 3,
    slice: () => ({ arrayBuffer: async () => { duringRead.abort(); return new Uint8Array([1, 2, 3]).buffer; } })
  };
  let hashLookups = 0;
  let progressEvents = 0;
  const cancelledResults = await Importer.identifyArchives([cancelledFile], {
    signal: duringRead.signal,
    onProgress: () => { progressEvents++; },
    api: { fileByMd5: async () => { hashLookups++; return []; } }
  });
  assert.equal(hashLookups, 0, 'cancelling the final read prevents the Nexus hash lookup');
  assert.equal(progressEvents, 0, 'a cancelled read is not presented as completed progress');
  assert.equal(cancelledResults.length, 0, 'cancelling identification produces no failed archive result');

  console.log('wabbajack importer OK');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
