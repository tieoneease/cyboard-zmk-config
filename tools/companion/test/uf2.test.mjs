import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import {
  APP_END, APP_START, MAX_UF2_BYTES, NRF52840_FAMILY_ID, SRAM_END, SRAM_START,
  UF2_MAGIC_END, UF2_MAGIC_START0, UF2_MAGIC_START1, parseInfoUf2, validateUf2,
} from '../lib/uf2.mjs';

/** Build a synthetic application UF2; `edit(view, blockIndex)` may corrupt any block. */
function makeUf2({ blocks = 4, start = APP_START, flags = 0x2000, family = NRF52840_FAMILY_ID,
  sp = 0x20010000, reset = APP_START + 0x101, edit } = {}) {
  const bytes = Buffer.alloc(blocks * 512);
  for (let i = 0; i < blocks; i++) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + i * 512, 512);
    view.setUint32(0, UF2_MAGIC_START0, true);
    view.setUint32(4, UF2_MAGIC_START1, true);
    view.setUint32(8, flags, true);
    view.setUint32(12, start + i * 256, true);
    view.setUint32(16, 256, true);
    view.setUint32(20, i, true);
    view.setUint32(24, blocks, true);
    view.setUint32(28, family, true);
    view.setUint32(508, UF2_MAGIC_END, true);
    if (i === 0) {
      view.setUint32(32, sp, true);
      view.setUint32(36, reset, true);
    }
    edit?.(view, i);
  }
  return bytes;
}

const rejects = (bytes, pattern) => assert.throws(() => validateUf2(bytes), pattern);

test('accepts a well-formed application image without modifying it', () => {
  const bytes = makeUf2();
  const before = Buffer.from(bytes);
  const result = validateUf2(bytes);
  assert.deepEqual(result, {
    sha256: createHash('sha256').update(before).digest('hex'),
    bytes: 2048, blocks: 4, start: APP_START, end: APP_START + 1024,
    familyId: NRF52840_FAMILY_ID, initialSp: 0x20010000, resetVector: APP_START + 0x101,
  });
  assert.ok(bytes.equals(before));
});

test('accepts a Uint8Array view with a nonzero byte offset', () => {
  const inner = makeUf2();
  const outer = new Uint8Array(inner.length + 16);
  outer.set(inner, 16);
  assert.equal(validateUf2(outer.subarray(16)).blocks, 4);
});

test('accepts the edges: image ending exactly at the settings boundary, SP at SRAM top, last-byte reset', () => {
  const blocks = (APP_END - APP_START) / 256;
  assert.equal(validateUf2(makeUf2({ blocks, sp: SRAM_END, reset: (APP_END - 2) | 1 })).end, APP_END);
});

test('rejects non-buffer, empty, oversize and truncated input', () => {
  rejects('not bytes', /Buffer or Uint8Array/);
  rejects(Buffer.alloc(0), /empty/);
  rejects(Buffer.alloc(MAX_UF2_BYTES + 512), /exceeds/);
  rejects(makeUf2().subarray(0, 2047), /truncated/);
  rejects(Buffer.concat([makeUf2(), Buffer.alloc(100)]), /truncated/);
});

test('rejects corrupted magic in any block', () => {
  for (const offset of [0, 4, 508]) {
    rejects(makeUf2({ edit: (v, i) => i === 2 && v.setUint32(offset, 0, true) }), /block 2: bad UF2 magic/);
  }
});

test('rejects flags other than family-ID only', () => {
  for (const flags of [0, 0x1, 0x2001, 0x1000, 0x3000, 0x6000, 0xa000]) {
    rejects(makeUf2({ flags }), /unsupported flags/);
  }
  rejects(makeUf2({ edit: (v, i) => i === 3 && v.setUint32(8, 0x2001, true) }), /block 3: unsupported flags/);
});

test('rejects another family or inconsistent family', () => {
  rejects(makeUf2({ family: 0x68ed2b88 }), /family/);
  rejects(makeUf2({ edit: (v, i) => i === 1 && v.setUint32(28, 0x1b57745f, true) }), /block 1: family/);
});

test('rejects a non-256 payload size', () => {
  rejects(makeUf2({ edit: (v) => v.setUint32(16, 476, true) }), /payload size/);
});

test('rejects duplicate, out-of-order and sparse block numbering', () => {
  rejects(makeUf2({ edit: (v, i) => i === 2 && v.setUint32(20, 1, true) }), /block 2: block number 1/);
  rejects(makeUf2({ edit: (v, i) => i === 1 && v.setUint32(20, 5, true) }), /out of order/);
  rejects(makeUf2({ edit: (v) => v.setUint32(24, 5, true) }), /declared block count 5/);
  rejects(makeUf2({ edit: (v, i) => i === 3 && v.setUint32(24, 3, true) }), /block 3: declared block count/);
});

test('rejects non-contiguous, duplicated or unaligned addresses', () => {
  rejects(makeUf2({ edit: (v, i) => i === 2 && v.setUint32(12, APP_START + 0x400, true) }), /block 2: address .* not contiguous/);
  rejects(makeUf2({ edit: (v, i) => i === 1 && v.setUint32(12, APP_START, true) }), /not contiguous/);
  rejects(makeUf2({ edit: (v, i) => i === 1 && v.setUint32(12, APP_START + 0x180, true) }), /not contiguous/);
});

test('rejects images that do not start at the application base', () => {
  rejects(makeUf2({ start: 0, reset: 0x101 }), /must start at application address 0x26000/);
  rejects(makeUf2({ start: 0x27000, reset: 0x27101 }), /must start/);
  rejects(makeUf2({ start: APP_START + 0x80 }), /must start/);
});

test('rejects images that reach into the settings area', () => {
  rejects(makeUf2({ blocks: (APP_END - APP_START) / 256 + 1 }), /beyond the application area end 0xec000/);
});

test('rejects a bootloader readback that covers more than the application area', () => {
  // A CURRENT.UF2-style image from the application base through settings to the bootloader.
  rejects(makeUf2({ blocks: (0xf4000 - APP_START) / 256 }), /beyond the application area/);
  // A full-chip readback starting at the MBR.
  rejects(makeUf2({ blocks: 16, start: 0, sp: 0x20000400, reset: 0xa81 }), /must start/);
});

test('rejects implausible initial stack pointers', () => {
  for (const sp of [0, SRAM_START, SRAM_START - 4, SRAM_END + 4, 0x20010002, 0xffffffff, APP_START]) {
    rejects(makeUf2({ sp }), /initial stack pointer/);
  }
});

test('rejects reset vectors that are not Thumb addresses inside the image', () => {
  rejects(makeUf2({ reset: APP_START + 0x100 }), /reset vector/);
  rejects(makeUf2({ reset: APP_START + 1024 + 1 }), /reset vector/);
  rejects(makeUf2({ reset: APP_START - 0xff }), /reset vector/);
  rejects(makeUf2({ reset: 0xffffffff }), /reset vector/);
  rejects(makeUf2({ reset: 0x1 }), /reset vector/);
});

// Optional: real CI candidates kept outside the repository (set UF2_CANDIDATE_DIR). Validator-only, no hardware.
const candidateDir = process.env.UF2_CANDIDATE_DIR;
for (const side of ['left', 'right']) {
  const file = candidateDir && `${candidateDir}/imprint_${side}-assimilator-bt-zmk.uf2`;
  test(`accepts saved CI candidate (${side})`, { skip: !(file && existsSync(file)) && 'UF2_CANDIDATE_DIR candidate not present' }, () => {
    const bytes = readFileSync(file);
    const result = validateUf2(bytes);
    assert.equal(result.start, APP_START);
    assert.equal(result.bytes, bytes.length);
    assert.ok(result.end <= APP_END);
  });
}

const INFO = [
  'UF2 Bootloader 0.6.0 lib/nrfx (v2.0.0) lib/tinyusb (0.10.1) lib/uf2 (remotes/origin/configupdate-9)',
  'Model: Assimilator BLE',
  'Board-ID: nRF52840-assimilator-ble',
  'SoftDevice: S140 version 6.1.1',
  'Date: Jan  1 2024',
  '',
];

test('parses compatible INFO_UF2.TXT with LF, CRLF and BOM', () => {
  const expected = { model: 'Assimilator BLE', boardId: 'nRF52840-assimilator-ble', version: '0.6.0', compatible: true };
  assert.deepEqual(parseInfoUf2(INFO.join('\n')), expected);
  assert.deepEqual(parseInfoUf2(INFO.join('\r\n')), expected);
  assert.deepEqual(parseInfoUf2('\uFEFF' + INFO.join('\r\n')), expected);
  assert.deepEqual(parseInfoUf2(INFO.join('\r\n').replace('Board-ID: nRF52840-assimilator-ble', 'Board-ID:\tnRF52840-assimilator-ble  ')), expected);
});

test('INFO_UF2.TXT compatibility requires exact Board-ID and Model', () => {
  const variant = (from, to) => parseInfoUf2(INFO.join('\n').replace(from, to));
  assert.equal(variant('nRF52840-assimilator-ble', 'nRF52840-assimilator-ble2').compatible, false);
  assert.equal(variant('nRF52840-assimilator-ble', 'nrf52840-assimilator-ble').compatible, false);
  assert.equal(variant('nRF52840-assimilator-ble', 'nRF52840-nice-nano').compatible, false);
  assert.equal(variant('Model: Assimilator BLE', 'Model: Assimilator').compatible, false);
  assert.equal(variant('Model: Assimilator BLE\n', '').compatible, false);
  assert.equal(variant('Board-ID: nRF52840-assimilator-ble\n', '').compatible, false);
  assert.equal(variant('Board-ID:', 'Board-Id:').compatible, false);
  assert.equal(parseInfoUf2(INFO.join('\n') + 'Board-ID: nRF52840-other\n').compatible, false, 'duplicate Board-ID');
  assert.equal(parseInfoUf2(INFO.join('\n') + 'Model: Assimilator BLE\n').compatible, false, 'duplicate Model');
  assert.deepEqual(parseInfoUf2(''), { model: null, boardId: null, version: null, compatible: false });
});

test('INFO_UF2.TXT input is bounded and must be text', () => {
  assert.throws(() => parseInfoUf2('x'.repeat(16 * 1024 + 1)), /exceeds/);
  assert.equal(parseInfoUf2(INFO.join('\n') + ' '.repeat(16 * 1024 - INFO.join('\n').length)).compatible, true);
  assert.throws(() => parseInfoUf2(Buffer.from(INFO.join('\n'))), /must be a string/);
});
