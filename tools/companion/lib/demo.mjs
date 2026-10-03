import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { makeUf2, makeZip } from './demo-fixtures.mjs';
import { discoverDrives } from './drives.mjs';

// Explicit simulation only: never enumerates host volumes or invokes gh.
export async function createDemo(root, config) {
  const volume = path.join(root, 'SIMULATED-ASSIMILATOR');
  await fs.mkdir(volume, { recursive: true });
  let connected = false;
  let building = false;
  let runId = 1;
  const sha = 'de'.padEnd(40, '0');
  const firmware = { left: makeUf2({ fill: 11, blocks: 3 }), right: makeUf2({ fill: 22, blocks: 3 }) };
  const zip = makeZip(['left', 'right'].map(side => ({ name: config.files[side], bytes: firmware[side] })));
  const github = {
    async check() { return { sha, message: 'Simulation: your source-managed keyboard workflow', checkedAt: new Date().toISOString(),
      run: { id: runId, sha, status: building ? 'in_progress' : 'completed', conclusion: building ? null : 'success', url: null, event: 'push', attempt: 1 } }; },
    async rebuild() { runId++; building = true; setTimeout(() => { building = false; }, 1500).unref(); },
    async download(current) {
      if (current.run.conclusion !== 'success') throw new Error('The simulated build is not complete.');
      return { zip, provenance: { repository: config.repository, branch: config.branch, sha, runId, artifactId: runId, runAttempt: 1,
        digest: `sha256:${createHash('sha256').update(zip).digest('hex')}`, downloadedAt: new Date().toISOString() } };
    },
  };
  return {
    github,
    discover: () => discoverDrives({ roots: connected ? [volume] : [] }),
    async connect(side) {
      if (!['left', 'right', 'none'].includes(side)) throw new Error('Invalid simulated half.');
      connected = false;
      await fs.rm(path.join(volume, 'FLASH.UF2'), { force: true });
      if (side !== 'none') {
        await fs.writeFile(path.join(volume, 'INFO_UF2.TXT'), 'UF2 Bootloader 0.0-demo\nModel: Assimilator BLE\nBoard-ID: nRF52840-assimilator-ble\n');
        await fs.writeFile(path.join(volume, 'CURRENT.UF2'), makeUf2({ fill: side === 'left' ? 44 : 55, blocks: 4 }));
        connected = true;
      }
    },
  };
}
