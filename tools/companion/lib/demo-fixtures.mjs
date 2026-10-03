// Shared synthetic fixtures for companion tests. Small, deterministic, no I/O.

const APP_START = 0x26000;

/**
 * A valid Assimilator nRF52840 application UF2: sequential 256-byte payload blocks from 0x26000,
 * family-ID flag only, initial SP in SRAM and a Thumb reset vector inside the image.
 * `fill` sets the remaining payload bytes, so different fills give different hashes.
 */
export function makeUf2({ fill = 0, blocks = 2 } = {}) {
  if (!Number.isInteger(blocks) || blocks < 1) throw new Error('blocks must be a positive integer');
  const bytes = Buffer.alloc(blocks * 512);
  for (let i = 0; i < blocks; i++) {
    const base = i * 512;
    bytes.writeUInt32LE(0x0a324655, base);
    bytes.writeUInt32LE(0x9e5d5157, base + 4);
    bytes.writeUInt32LE(0x00002000, base + 8);
    bytes.writeUInt32LE(APP_START + i * 256, base + 12);
    bytes.writeUInt32LE(256, base + 16);
    bytes.writeUInt32LE(i, base + 20);
    bytes.writeUInt32LE(blocks, base + 24);
    bytes.writeUInt32LE(0xada52840, base + 28);
    bytes.fill(fill & 0xff, base + 32, base + 32 + 256);
    bytes.writeUInt32LE(0x0ab16f30, base + 508);
  }
  bytes.writeUInt32LE(0x20010000, 32); // initial stack pointer
  bytes.writeUInt32LE(APP_START + 0x101, 36); // Thumb reset handler
  return bytes;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Minimal valid ZIP (STORE method, real CRC-32, UTF-8 names). entries: [{ name, bytes,
 * externalFileAttributes? }]. Names are written verbatim so tests can supply hostile paths.
 * When externalFileAttributes is given, "version made by" is Unix so the high 16 bits are a mode.
 */
export function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, bytes, externalFileAttributes } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(bytes);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // STORE
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(externalFileAttributes === undefined ? 20 : (3 << 8) | 20, 4); // made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE((externalFileAttributes ?? 0) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
