// Read-only validation of UF2 application images for the Assimilator (nRF52840) bootloader.
// Nothing here writes to a device or modifies the supplied bytes.
import { createHash } from 'node:crypto';

export const UF2_BLOCK_SIZE = 512;
export const UF2_PAYLOAD_SIZE = 256;
export const UF2_MAGIC_START0 = 0x0a324655;
export const UF2_MAGIC_START1 = 0x9e5d5157;
export const UF2_MAGIC_END = 0x0ab16f30;
/** Only the "familyID present" flag is allowed: no not-main-flash, file container, MD5 or extension tags. */
export const UF2_FLAGS = 0x00002000;
export const NRF52840_FAMILY_ID = 0xada52840;
export const APP_START = 0x26000;
/** Exclusive end of the application area; settings storage and the bootloader follow it. */
export const APP_END = 0xec000;
export const SRAM_START = 0x20000000;
export const SRAM_END = 0x20040000;
export const MAX_UF2_BYTES = 4 * 1024 * 1024;

export const INFO_MAX_BYTES = 16 * 1024;
export const ASSIMILATOR_BOARD_ID = 'nRF52840-assimilator-ble';
export const ASSIMILATOR_MODEL = 'Assimilator BLE';

const hex = (n) => `0x${n.toString(16)}`;

/**
 * Validate a compiled Assimilator application image. Throws Error on any malformed or
 * incompatible input; returns a summary on success.
 * @param {Uint8Array} buffer
 */
export function validateUf2(buffer) {
  if (!(buffer instanceof Uint8Array)) throw new Error('UF2 input must be a Buffer or Uint8Array');
  const length = buffer.byteLength;
  if (length === 0) throw new Error('UF2 image is empty');
  if (length > MAX_UF2_BYTES) throw new Error(`UF2 image exceeds ${MAX_UF2_BYTES} bytes`);
  if (length % UF2_BLOCK_SIZE !== 0) throw new Error('UF2 image is truncated: size is not a multiple of 512');

  const view = new DataView(buffer.buffer, buffer.byteOffset, length);
  const word = (offset) => view.getUint32(offset, true);
  const blocks = length / UF2_BLOCK_SIZE;
  const start = word(12);
  if (start !== APP_START) throw new Error(`UF2 image must start at application address ${hex(APP_START)}, found ${hex(start)}`);

  for (let i = 0; i < blocks; i++) {
    const base = i * UF2_BLOCK_SIZE;
    const at = `block ${i}`;
    if (word(base) !== UF2_MAGIC_START0 || word(base + 4) !== UF2_MAGIC_START1 || word(base + 508) !== UF2_MAGIC_END) {
      throw new Error(`${at}: bad UF2 magic`);
    }
    const flags = word(base + 8);
    if (flags !== UF2_FLAGS) throw new Error(`${at}: unsupported flags ${hex(flags)} (only ${hex(UF2_FLAGS)} allowed)`);
    const family = word(base + 28);
    if (family !== NRF52840_FAMILY_ID) throw new Error(`${at}: family ${hex(family)} is not nRF52840 ${hex(NRF52840_FAMILY_ID)}`);
    const payload = word(base + 16);
    if (payload !== UF2_PAYLOAD_SIZE) throw new Error(`${at}: payload size ${payload} (expected ${UF2_PAYLOAD_SIZE})`);
    const blockNo = word(base + 20);
    if (blockNo !== i) throw new Error(`${at}: block number ${blockNo} is out of order, duplicated or sparse`);
    const count = word(base + 24);
    if (count !== blocks) throw new Error(`${at}: declared block count ${count} does not match ${blocks} blocks present`);
    const address = word(base + 12);
    const expected = APP_START + i * UF2_PAYLOAD_SIZE;
    if (address !== expected) throw new Error(`${at}: address ${hex(address)} is not contiguous (expected ${hex(expected)})`);
  }

  const end = start + blocks * UF2_PAYLOAD_SIZE;
  if (end > APP_END) throw new Error(`UF2 image ends at ${hex(end)}, beyond the application area end ${hex(APP_END)}`);

  // Cortex-M vector table: first two words of the payload at the application start.
  const initialSp = word(32);
  const resetVector = word(36);
  if (initialSp <= SRAM_START || initialSp > SRAM_END || initialSp % 4 !== 0) {
    throw new Error(`initial stack pointer ${hex(initialSp)} is not a word-aligned SRAM address`);
  }
  const entry = (resetVector & ~1) >>> 0;
  if ((resetVector & 1) !== 1 || entry < start || entry >= end) {
    throw new Error(`reset vector ${hex(resetVector)} is not a Thumb address inside the image`);
  }

  return {
    sha256: createHash('sha256').update(buffer).digest('hex'),
    bytes: length,
    blocks,
    start,
    end,
    familyId: NRF52840_FAMILY_ID,
    initialSp,
    resetVector,
  };
}

/**
 * Parse INFO_UF2.TXT. compatible is true only for exactly one Board-ID and one Model line
 * matching the Assimilator BLE bootloader.
 * @param {string} text
 */
export function parseInfoUf2(text) {
  if (typeof text !== 'string') throw new Error('INFO_UF2.TXT content must be a string');
  if (Buffer.byteLength(text, 'utf8') > INFO_MAX_BYTES) throw new Error(`INFO_UF2.TXT exceeds ${INFO_MAX_BYTES} bytes`);
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const fields = new Map();
  let duplicate = false;
  for (const line of lines) {
    const match = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*?)[ \t]*$/.exec(line);
    if (!match) continue;
    // A repeated identity field is ambiguous; never treat it as compatible.
    if (fields.has(match[1]) && (match[1] === 'Model' || match[1] === 'Board-ID')) duplicate = true;
    fields.set(match[1], match[2]);
  }
  const version = /^UF2 Bootloader[ \t]+(\S+)/.exec(lines[0] ?? '')?.[1] ?? null;
  const model = fields.get('Model') ?? null;
  const boardId = fields.get('Board-ID') ?? null;
  const compatible = !duplicate && boardId === ASSIMILATOR_BOARD_ID && model === ASSIMILATOR_MODEL;
  return { model, boardId, version, compatible };
}
