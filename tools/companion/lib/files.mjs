import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import yauzl from 'yauzl';
import { validateUf2 } from './uf2.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export async function readRegular(file, maxBytes) {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw new Error('Expected a bounded regular file, not a link or directory.');
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > maxBytes) throw new Error('File changed while opening it.');
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error('File exceeds the allowed size.');
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}
export function inside(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('Invalid cache path.');
  const full = path.resolve(root, relative);
  if (full === path.resolve(root) || !full.startsWith(path.resolve(root) + path.sep)) throw new Error('Path escapes the private cache.');
  return full;
}
export async function extractFirmware(zipBuffer, config) {
  if (zipBuffer.length > 16 * 1024 * 1024) throw new Error('Archive is too large.');
  const archive = await yauzl.fromBufferPromise(zipBuffer, { strictFileNames: true, validateEntrySizes: true });
  const result = {};
  let count = 0;
  try {
    for await (const entry of archive.eachEntry()) {
      if (++count > 2) throw new Error('Unexpected extra files in firmware artifact.');
      const side = ['left', 'right'].find(s => config.files[s] === entry.fileName);
      const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (!side || result[side] || (mode && mode !== 0x8000) || entry.isEncrypted() || entry.uncompressedSize > 4 * 1024 * 1024) throw new Error('Artifact contains an unexpected, duplicate, linked, or oversized entry.');
      const stream = await archive.openReadStreamPromise(entry);
      const chunks = [];
      let size = 0;
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) { stream.destroy(); throw new Error('Expanded firmware is too large.'); }
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      if (crc32(bytes) !== entry.crc32) throw new Error('ZIP entry CRC-32 mismatch.');
      result[side] = { ...validateUf2(bytes), data: bytes, filename: config.files[side] };
    }
  } finally { archive.close(); }
  if (!result.left || !result.right) throw new Error('Artifact must contain both matching Imprint halves.');
  return result;
}
export async function storeBuild(cacheRoot, downloaded, config) {
  if (!Number.isSafeInteger(downloaded.provenance?.runId) || downloaded.provenance.runId < 1) throw new Error('Invalid build run ID.');
  const files = await extractFirmware(downloaded.zip, config);
  const parent = path.join(cacheRoot, 'builds');
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const dir = await fs.mkdtemp(path.join(parent, `${downloaded.provenance.runId}-`));
  const summary = { ...downloaded.provenance, dir, files: {} };
  for (const side of ['left', 'right']) {
    const { data, ...metadata } = files[side];
    await fs.writeFile(path.join(dir, metadata.filename), data, { flag: 'wx', mode: 0o600 });
    summary.files[side] = metadata;
  }
  await fs.writeFile(path.join(dir, 'firmware-artifact.zip'), downloaded.zip, { flag: 'wx', mode: 0o600 });
  await fs.writeFile(path.join(dir, 'provenance.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return summary;
}
export function inspectReadback(bytes) {
  if (!bytes.length || bytes.length > 4 * 1024 * 1024 || bytes.length % 512) throw new Error('CURRENT.UF2 has an invalid size.');
  const count = bytes.length / 512;
  let start, end, family;
  for (let i = 0; i < count; i++) {
    const p = i * 512;
    if (bytes.readUInt32LE(p) !== 0x0a324655 || bytes.readUInt32LE(p + 4) !== 0x9e5d5157 || bytes.readUInt32LE(p + 508) !== 0x0ab16f30 || bytes.readUInt32LE(p + 8) !== 0x2000 || bytes.readUInt32LE(p + 16) !== 256 || bytes.readUInt32LE(p + 20) !== i || bytes.readUInt32LE(p + 24) !== count) throw new Error('CURRENT.UF2 has malformed blocks.');
    const address = bytes.readUInt32LE(p + 12), thisFamily = bytes.readUInt32LE(p + 28);
    if (![0xada52840, 0x239a00b3].includes(thisFamily) || (family !== undefined && family !== thisFamily) || address + 256 > 0x100000 || address % 256 || (end !== undefined && address !== end)) throw new Error('CURRENT.UF2 has unexpected address/family coverage.');
    start ??= address; family = thisFamily; end = address + 256;
  }
  return { sha256: sha256(bytes), bytes: bytes.length, start, end, familyId: family, partial: true, restoreTested: false };
}
