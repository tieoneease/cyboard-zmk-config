import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yauzl from 'yauzl';
import { extractFirmware, inside, inspectReadback, readRegular, storeBuild } from '../lib/files.mjs';
import { validateUf2 } from '../lib/uf2.mjs';
import { crc32, makeUf2, makeZip } from './fixtures.mjs';

const LEFT = 'imprint_left-assimilator-bt-zmk.uf2';
const RIGHT = 'imprint_right-assimilator-bt-zmk.uf2';
const config = { files: { left: LEFT, right: RIGHT } };
const left = makeUf2({ fill: 0x11, blocks: 3 });
const right = makeUf2({ fill: 0x22, blocks: 2 });
const REGULAR = (0o100644 << 16) >>> 0;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Offset of the n-th central-directory header in a ZIP buffer. */
function centralHeader(zip, n = 0) {
  let at = -1;
  for (let i = 0; i <= n; i++) at = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), at + 1);
  assert.ok(at >= 0, 'central header present');
  return at;
}

async function tempDir(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'companion-files-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// ---------- Fixture round trips (proves the shared fixtures themselves) ----------

test('fixtures: makeUf2 is a valid application image; fill changes the hash', () => {
  const a = validateUf2(makeUf2());
  assert.deepEqual([a.blocks, a.start, a.end, a.initialSp, a.resetVector], [2, 0x26000, 0x26200, 0x20010000, 0x26101]);
  assert.notEqual(validateUf2(makeUf2({ fill: 1 })).sha256, a.sha256);
  assert.equal(validateUf2(makeUf2({ blocks: 5 })).blocks, 5);
});

test('fixtures: makeZip round-trips names, bytes, CRC and attributes through yauzl', async () => {
  const zip = makeZip([{ name: LEFT, bytes: left, externalFileAttributes: REGULAR }, { name: 'dir/ü.txt', bytes: Buffer.from('hi') }]);
  const archive = await yauzl.fromBufferPromise(zip, { strictFileNames: true, validateEntrySizes: true });
  const seen = [];
  for await (const entry of archive.eachEntry()) {
    const chunks = [];
    for await (const chunk of await archive.openReadStreamPromise(entry)) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    seen.push({ name: entry.fileName, size: bytes.length, crcOk: crc32(bytes) === entry.crc32, attributes: entry.externalFileAttributes });
  }
  archive.close();
  assert.deepEqual(seen, [
    { name: LEFT, size: left.length, crcOk: true, attributes: REGULAR },
    { name: 'dir/ü.txt', size: 2, crcOk: true, attributes: 0 },
  ]);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926, 'standard CRC-32 check value');
});

// ---------- extractFirmware ----------

test('extracts exactly the two expected halves, byte-identical and validated', async () => {
  for (const entries of [
    [{ name: LEFT, bytes: left }, { name: RIGHT, bytes: right }],
    [{ name: RIGHT, bytes: right, externalFileAttributes: REGULAR }, { name: LEFT, bytes: left, externalFileAttributes: REGULAR }],
  ]) {
    const result = await extractFirmware(makeZip(entries), config);
    assert.deepEqual(Object.keys(result).sort(), ['left', 'right']);
    assert.ok(Buffer.isBuffer(result.left.data) && result.left.data.equals(left));
    assert.ok(Buffer.isBuffer(result.right.data) && result.right.data.equals(right));
    assert.equal(result.left.bytes, left.length, 'numeric size metadata');
    assert.equal(result.right.bytes, right.length);
    assert.equal(result.left.filename, LEFT);
    assert.equal(result.right.filename, RIGHT);
    assert.equal(result.left.sha256, hash(left));
    assert.equal(result.right.blocks, 2);
  }
});

const firmwareZip = process.env.FIRMWARE_ARTIFACT_ZIP;
test('extracts a saved real GitHub artifact (DEFLATE path)', { skip: !(firmwareZip && existsSync(firmwareZip)) && 'FIRMWARE_ARTIFACT_ZIP not set' }, async () => {
  const result = await extractFirmware(readFileSync(firmwareZip), config);
  assert.equal(result.left.start, 0x26000);
  assert.equal(result.right.start, 0x26000);
  assert.notEqual(result.left.sha256, result.right.sha256);
});

test('rejects wrong names and paths', async () => {
  const rejectsWith = async (name, pattern = /unexpected, duplicate, linked, or oversized/) =>
    assert.rejects(extractFirmware(makeZip([{ name, bytes: left }, { name: RIGHT, bytes: right }]), config), pattern, name);
  for (const name of ['zmk.uf2', 'imprint_left-assimilator-bt-zmk.UF2', `firmware/${LEFT}`, `./${LEFT}`, `${LEFT}/`, ` ${LEFT}`, 'imprint_left-nice_nano-zmk.uf2']) {
    await rejectsWith(name);
  }
  // yauzl's own name validation rejects these before the subject sees them.
  await rejectsWith(`../${LEFT}`, /invalid relative path/);
  await rejectsWith(`/${LEFT}`, /absolute path/);
  await rejectsWith(`C:${LEFT}`, /absolute path/);
  await rejectsWith(`x\\${LEFT}`, /invalid characters/);
});

test('rejects symlink and directory entries by Unix mode', async () => {
  for (const mode of [0o120777, 0o040755, 0o010644, 0o140755]) {
    await assert.rejects(
      extractFirmware(makeZip([{ name: LEFT, bytes: Buffer.from(RIGHT), externalFileAttributes: (mode << 16) >>> 0 }, { name: RIGHT, bytes: right }]), config),
      /linked/, `mode ${mode.toString(8)}`,
    );
  }
});

test('rejects duplicates, extras and a missing half', async () => {
  await assert.rejects(extractFirmware(makeZip([{ name: LEFT, bytes: left }, { name: LEFT, bytes: left }]), config), /duplicate/);
  await assert.rejects(extractFirmware(makeZip([{ name: LEFT, bytes: left }, { name: RIGHT, bytes: right }, { name: 'README.txt', bytes: Buffer.from('x') }]), config), /extra files/);
  await assert.rejects(extractFirmware(makeZip([{ name: LEFT, bytes: left }]), config), /both matching Imprint halves/);
  await assert.rejects(extractFirmware(makeZip([{ name: RIGHT, bytes: right }]), config), /both/);
  await assert.rejects(extractFirmware(makeZip([]), config), /both/);
});

test('rejects oversized archives, oversized entries and lying sizes', async () => {
  await assert.rejects(extractFirmware(Buffer.alloc(16 * 1024 * 1024 + 1), config), /too large/);
  const big = Buffer.alloc(4 * 1024 * 1024 + 512);
  await assert.rejects(extractFirmware(makeZip([{ name: LEFT, bytes: big }, { name: RIGHT, bytes: right }]), config), /oversized/);

  // Central directory claims a different uncompressed size than the stored data.
  const zip = makeZip([{ name: LEFT, bytes: left }, { name: RIGHT, bytes: right }]);
  zip.writeUInt32LE(left.length + 512, centralHeader(zip) + 24);
  await assert.rejects(extractFirmware(zip, config), /size mismatch/);
});

test('rejects encrypted entries, malformed archives and invalid UF2 contents', async () => {
  const encrypted = makeZip([{ name: LEFT, bytes: left }, { name: RIGHT, bytes: right }]);
  const flags = centralHeader(encrypted) + 8;
  encrypted.writeUInt16LE(encrypted.readUInt16LE(flags) | 1, flags);
  await assert.rejects(extractFirmware(encrypted, config));

  await assert.rejects(extractFirmware(Buffer.from('not a zip at all'), config));
  const good = makeZip([{ name: LEFT, bytes: left }, { name: RIGHT, bytes: right }]);
  await assert.rejects(extractFirmware(good.subarray(0, good.length - 10), config));

  const corrupt = Buffer.from(left);
  corrupt.writeUInt32LE(0x2001, 512 + 8); // forbidden flag in block 1
  await assert.rejects(extractFirmware(makeZip([{ name: LEFT, bytes: corrupt }, { name: RIGHT, bytes: right }]), config), /unsupported flags/);
  await assert.rejects(extractFirmware(makeZip([{ name: LEFT, bytes: Buffer.alloc(0) }, { name: RIGHT, bytes: right }]), config), /empty/);
  await assert.rejects(extractFirmware(makeZip([{ name: LEFT, bytes: left.subarray(0, 700) }, { name: RIGHT, bytes: right }]), config), /truncated/);
});

// yauzl does not verify CRC-32; extractFirmware must. The corrupted byte is inside a UF2 payload,
// so validateUf2 alone would accept it.
test('rejects an entry whose data does not match its CRC-32', async () => {
  for (const [index, name, bytes] of [[0, LEFT, left], [1, RIGHT, right]]) {
    const entries = [{ name: LEFT, bytes: left }, { name: RIGHT, bytes: right }];
    const zip = makeZip(entries);
    const dataStart = (index === 0 ? 0 : 30 + LEFT.length + left.length) + 30 + name.length;
    assert.ok(zip.subarray(dataStart, dataStart + bytes.length).equals(bytes), 'located entry data');
    zip[dataStart + 100] ^= 0xff; // payload byte, CRC left stale
    const corrupted = Buffer.from(bytes);
    corrupted[100] ^= 0xff;
    assert.doesNotThrow(() => validateUf2(corrupted), 'corruption is invisible to UF2 validation');
    await assert.rejects(extractFirmware(zip, config), /CRC-32 mismatch/, name);
  }
});

// ---------- storeBuild ----------

test('storeBuild writes both halves, the archive and provenance into a fresh private directory', async (t) => {
  const cache = await tempDir(t);
  const zip = makeZip([{ name: LEFT, bytes: left }, { name: RIGHT, bytes: right }]);
  const provenance = { repository: 'o/r', branch: 'main', sha: 'a'.repeat(40), runId: 123, digest: `sha256:${hash(zip)}` };
  const summary = await storeBuild(cache, { zip, provenance }, config);
  assert.equal(path.dirname(summary.dir), path.join(cache, 'builds'));
  assert.match(path.basename(summary.dir), /^123-/);
  assert.ok((await fs.readFile(path.join(summary.dir, LEFT))).equals(left));
  assert.ok((await fs.readFile(path.join(summary.dir, RIGHT))).equals(right));
  assert.ok((await fs.readFile(path.join(summary.dir, 'firmware-artifact.zip'))).equals(zip));
  const saved = JSON.parse(await fs.readFile(path.join(summary.dir, 'provenance.json'), 'utf8'));
  assert.equal(saved.files.left.sha256, hash(left));
  assert.equal(saved.files.right.filename, RIGHT);
  assert.equal(saved.sha, provenance.sha);
  assert.equal(saved.files.left.start, 0x26000);
  assert.equal(saved.files.left.bytes, left.length);
  assert.equal('data' in saved.files.left, false);
  assert.deepEqual(summary.files, saved.files);
  assert.ok(Buffer.byteLength(JSON.stringify(saved)) < 4096, 'provenance holds metadata, not firmware bytes');

  const second = await storeBuild(cache, { zip, provenance }, config);
  assert.notEqual(second.dir, summary.dir, 'never overwrites an earlier build');
});

test('storeBuild writes nothing when the archive is rejected', async (t) => {
  const cache = await tempDir(t);
  const zip = makeZip([{ name: LEFT, bytes: left }]);
  await assert.rejects(storeBuild(cache, { zip, provenance: { runId: 1 } }, config), /both/);
  assert.deepEqual(await fs.readdir(cache), []);
});

test('storeBuild rejects a non-numeric or non-positive run ID before writing', async (t) => {
  const cache = await tempDir(t);
  const zip = makeZip([{ name: LEFT, bytes: left }, { name: RIGHT, bytes: right }]);
  for (const runId of [undefined, null, 0, -1, 1.5, '123', '../x', NaN, Number.MAX_SAFE_INTEGER + 1, 2n]) {
    await assert.rejects(storeBuild(cache, { zip, provenance: { runId } }, config), /Invalid build run ID/, String(runId));
  }
  await assert.rejects(storeBuild(cache, { zip }, config), /Invalid build run ID/);
  assert.deepEqual(await fs.readdir(cache), []);
});

// ---------- readRegular / inside ----------

test('readRegular reads bounded regular files and rejects directories, oversize and links', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'CURRENT.UF2');
  await fs.writeFile(file, left);
  assert.ok((await readRegular(file, left.length)).equals(left), 'exactly at the bound');
  await assert.rejects(readRegular(file, left.length - 1), /bounded regular file/);
  await assert.rejects(readRegular(dir, 1 << 20), /bounded regular file/);
  await assert.rejects(readRegular(path.join(dir, 'missing'), 10), { code: 'ENOENT' });

  const junction = path.join(dir, 'junction');
  await fs.symlink(dir, junction, 'junction');
  await assert.rejects(readRegular(junction, 1 << 20), /bounded regular file/);
});

test('readRegular rejects a symlinked file', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'CURRENT.UF2');
  await fs.writeFile(file, left);
  try {
    await fs.symlink(file, path.join(dir, 'link.uf2'), 'file');
  } catch (error) {
    if (error.code === 'EPERM') return t.skip('file symlinks need privilege on this host');
    throw error;
  }
  await assert.rejects(readRegular(path.join(dir, 'link.uf2'), 1 << 20), /bounded regular file/);
});

test('inside keeps paths strictly within the cache root', () => {
  const root = path.resolve(os.tmpdir(), 'cache');
  assert.equal(inside(root, path.join('builds', 'x.uf2')), path.join(root, 'builds', 'x.uf2'));
  for (const bad of ['..', path.join('..', 'cache-evil', 'x'), path.join('builds', '..', '..', 'x'), '', '.', path.resolve(root, 'x'), 42]) {
    assert.throws(() => inside(root, bad), /Invalid cache path|escapes/, String(bad));
  }
});

// ---------- inspectReadback ----------

test('inspectReadback round-trips a valid image and reports partial, untested coverage', () => {
  const image = makeUf2({ fill: 7, blocks: 4 });
  const result = inspectReadback(image);
  assert.deepEqual(result, {
    sha256: validateUf2(image).sha256, bytes: 2048, start: 0x26000, end: 0x26400,
    familyId: 0xada52840, partial: true, restoreTested: false,
  });
});

test('inspectReadback rejects malformed or out-of-bounds readbacks', () => {
  const edit = (fn) => { const b = makeUf2({ blocks: 3 }); fn(b); return b; };
  const cases = {
    empty: Buffer.alloc(0),
    unaligned: makeUf2().subarray(0, 1000),
    oversize: Buffer.alloc(4 * 1024 * 1024 + 512),
    badMagic: edit((b) => b.writeUInt32LE(0, 512)),
    badEndMagic: edit((b) => b.writeUInt32LE(0, 1024 + 508)),
    badFlags: edit((b) => b.writeUInt32LE(0x2001, 8)),
    badPayload: edit((b) => b.writeUInt32LE(476, 512 + 16)),
    outOfOrder: edit((b) => b.writeUInt32LE(0, 512 + 20)),
    badCount: edit((b) => b.writeUInt32LE(4, 1024 + 24)),
    gap: edit((b) => b.writeUInt32LE(0x26000 + 0x300, 1024 + 12)),
    unalignedAddress: edit((b) => { for (let i = 0; i < 3; i++) b.writeUInt32LE(0x26080 + i * 256, i * 512 + 12); }),
    beyondFlash: edit((b) => { for (let i = 0; i < 3; i++) b.writeUInt32LE(0xfff00 + i * 256, i * 512 + 12); }),
    otherFamily: edit((b) => { for (let i = 0; i < 3; i++) b.writeUInt32LE(0x68ed2b88, i * 512 + 28); }),
    mixedFamily: edit((b) => b.writeUInt32LE(0x239a00b3, 512 + 28)),
  };
  for (const [name, bytes] of Object.entries(cases)) assert.throws(() => inspectReadback(bytes), /CURRENT\.UF2/, name);
});
