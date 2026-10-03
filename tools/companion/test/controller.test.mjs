// Controller safety tests. Drives are temporary directories passed to discoverDrives as injected
// roots (no OS volume scan); GitHub is an in-memory fake (no gh, no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Controller } from '../lib/controller.mjs';
import { createDemo } from '../lib/demo.mjs';
import { discoverDrives } from '../lib/drives.mjs';
import { makeUf2, makeZip } from './fixtures.mjs';

const config = {
  repository: 'tieoneease/cyboard-zmk-config', branch: 'main', workflow: 'build.yml', artifact: 'firmware',
  files: { left: 'imprint_left-assimilator-bt-zmk.uf2', right: 'imprint_right-assimilator-bt-zmk.uf2' },
};
const SHA = 'a'.repeat(40);
const INFO = 'UF2 Bootloader 0.9.0\r\nModel: Assimilator BLE\r\nBoard-ID: nRF52840-assimilator-ble\r\n';
const FIRMWARE = { left: makeUf2({ fill: 1, blocks: 3 }), right: makeUf2({ fill: 2, blocks: 3 }) };
const CURRENT = { left: makeUf2({ fill: 44, blocks: 4 }), right: makeUf2({ fill: 55, blocks: 4 }) };
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exists = (file) => fs.access(file).then(() => true, () => false);
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

async function harness(t, { allowFlash = true, readDeviceFile, openDeviceFile } = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'companion-controller-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const remote = { sha: SHA, runId: 7, attempt: 1, status: 'completed', conclusion: 'success' };
  const zip = makeZip(['left', 'right'].map((side) => ({ name: config.files[side], bytes: FIRMWARE[side] })));
  const h = { dir, remote, calls: [], hooks: {}, discoverCalls: 0, clock: 1_800_000_000_000, connected: [], volumes: {} };
  h.github = {
    async check() {
      h.calls.push('check');
      await h.hooks.onCheck?.();
      const { sha, runId, attempt, status, conclusion } = remote;
      return { sha, message: '<img src=x onerror=alert(1)>', checkedAt: 'now', run: { id: runId, sha, status, conclusion, attempt, event: 'push', url: null } };
    },
    async rebuild() { h.calls.push('rebuild'); },
    async download(current) {
      h.calls.push('download');
      return { zip, provenance: { repository: config.repository, branch: config.branch, sha: current.sha, runId: current.run.id,
        runAttempt: current.run.attempt, artifactId: 1, digest: `sha256:${hash(zip)}`, downloadedAt: 'now' } };
    },
  };
  h.discover = async () => {
    const n = ++h.discoverCalls;
    await h.hooks.onDiscover?.(n);
    return discoverDrives({ roots: [...h.connected] });
  };
  /** Create a simulated bootloader volume whose CURRENT.UF2 is `image`. */
  h.volume = async (name, image) => {
    const root = path.join(dir, 'volumes', name);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'INFO_UF2.TXT'), INFO);
    await fs.writeFile(path.join(root, 'CURRENT.UF2'), image);
    h.volumes[name] = root;
    return root;
  };
  h.connect = (...names) => { h.connected = names.map((name) => h.volumes[name]); };
  h.controller = await new Controller({ config, github: h.github, discover: h.discover, cacheRoot: path.join(dir, 'cache'),
    allowFlash, readDeviceFile, openDeviceFile, now: () => h.clock }).init();
  await h.volume('left', CURRENT.left);
  await h.volume('right', CURRENT.right);
  h.flashed = async () => {
    const out = {};
    for (const [name, root] of Object.entries(h.volumes)) {
      if (await exists(path.join(root, 'FLASH.UF2'))) out[name] = await fs.readFile(path.join(root, 'FLASH.UF2'));
    }
    return out;
  };
  h.written = async () => Object.keys(await h.flashed());
  h.captureBoth = async () => {
    for (const side of ['left', 'right']) {
      h.connect(side);
      const [drive] = await h.controller.refreshDrives();
      await h.controller.capture({ side, driveId: drive.id, confirmed: true });
    }
    h.connect();
  };
  h.ready = async (side = 'left') => {
    await h.captureBoth();
    await h.controller.prepare();
    await h.controller.arm({ side, confirmed: true });
  };
  return h;
}

test('a cable swap cannot silently replace a saved half identity', async (t) => {
  const h = await harness(t);
  h.connect('left');
  await h.controller.capture({ side: 'left', confirmed: true });
  const savedLeft = h.controller.readbacks.left;
  h.connect('right');
  for (const replace of [undefined, false, 'true', 1]) {
    await assert.rejects(h.controller.capture({ side: 'left', confirmed: true, replace }), /Explicitly confirm replacing/);
    assert.deepEqual(h.controller.readbacks.left, savedLeft);
  }
  await h.controller.capture({ side: 'right', confirmed: true });
  assert.equal(h.controller.readbacks.left.sha256, hash(CURRENT.left));
  assert.equal(h.controller.readbacks.right.sha256, hash(CURRENT.right));
  await h.controller.prepare();
  await h.controller.arm({ side: 'left', confirmed: true });
  await h.controller.tick(); // Right is still connected: the original left identity must hold.
  assert.match(h.controller.error, /does not match the left backup/);
  assert.deepEqual(await h.written(), []);
});

test('explicit replacement keeps earlier capture files and duplicate guidance never requests a swap', async (t) => {
  const h = await harness(t);
  h.connect('left');
  await h.controller.capture({ side: 'left', confirmed: true });
  const old = h.controller.readbacks.left;
  await h.controller.capture({ side: 'left', confirmed: true, replace: true });
  assert.notEqual(h.controller.readbacks.left.directory, old.directory);
  assert.ok((await fs.readFile(path.join(h.controller.cacheRoot, old.directory, 'CURRENT-read1.uf2'))).equals(CURRENT.left));
  await assert.rejects(h.controller.capture({ side: 'right', confirmed: true }), error => {
    assert.match(error.message, /already recorded as left/);
    assert.match(error.message, /do not swap halves just to bypass/);
    assert.doesNotMatch(error.message, /Connect the other physical half/);
    return true;
  });
});

test('two different device reads are refused without recording a backup', async (t) => {
  let reads = 0;
  const h = await harness(t, { readDeviceFile: async () => ++reads === 1 ? CURRENT.left : CURRENT.right });
  h.connect('left');
  const [drive] = await h.controller.refreshDrives();
  await assert.rejects(h.controller.capture({ side: 'left', driveId: drive.id, confirmed: true }), /Two CURRENT.UF2 reads differed/);
  assert.deepEqual(h.controller.readbacks, {});
  assert.deepEqual(await h.written(), []);
});

test('a failure after opening the destination stays unverified and is never retried', async (t) => {
  let opens = 0;
  const h = await harness(t, { openDeviceFile: async (...args) => {
    opens++;
    const handle = await fs.open(...args);
    return { writeFile: bytes => handle.writeFile(bytes), sync: async () => { throw new Error('Simulated device disconnect'); }, close: () => handle.close() };
  } });
  await h.ready('left'); h.connect('left');
  await h.controller.tick();
  assert.equal(h.controller.result.status, 'unverified');
  assert.match(h.controller.result.message, /do not assume success or auto-retry/);
  assert.equal(h.controller.armed, null);
  await h.controller.tick(); await h.controller.tick();
  assert.equal(opens, 1);
});

test('recurring discovery errors are deduplicated and clear on recovery', async (t) => {
  const h = await harness(t);
  h.hooks.onDiscover = () => { throw new Error('Simulated discovery failure'); };
  await h.controller.tick(); await h.controller.tick(); await h.controller.tick();
  assert.equal(h.controller.activity.filter(e => e.message === 'Simulated discovery failure').length, 1);
  delete h.hooks.onDiscover;
  await h.controller.tick();
  assert.equal(h.controller.error, null);
  assert.match(h.controller.activity[0].message, /available again/);
});

test('nothing is written by default, even with a prepared build and both backups', async (t) => {
  const h = await harness(t, { allowFlash: false });
  await h.captureBoth();
  await h.controller.prepare();
  await assert.rejects(h.controller.arm({ side: 'left', confirmed: true }), /Hardware writes are disabled/);
  assert.equal(h.controller.armed, null);
  h.connect('left');
  for (let i = 0; i < 3; i++) await h.controller.tick();
  assert.deepEqual(await h.written(), []);
  assert.deepEqual((await fs.readdir(h.volumes.left)).sort(), ['CURRENT.UF2', 'INFO_UF2.TXT'], 'capture and tick never write to the drive');
  assert.ok(h.controller.state().prepared);
  assert.equal(h.controller.state().prepared.dir, undefined, 'cache path not exposed in state');
});

test('capture requires a physical-half confirmation and exactly one drive', async (t) => {
  const h = await harness(t);
  h.connect('left');
  const [drive] = await h.controller.refreshDrives();
  for (const confirmed of [undefined, false, 'true', 1]) {
    await assert.rejects(h.controller.capture({ side: 'left', driveId: drive.id, confirmed }), /Confirm which physical half/);
  }
  await assert.rejects(h.controller.capture({ side: 'top', driveId: drive.id, confirmed: true }), /Select left or right/);
  h.connect();
  await assert.rejects(h.controller.capture({ side: 'left', driveId: drive.id, confirmed: true }), /No compatible bootloader drive/);
  h.connect('left', 'right');
  await assert.rejects(h.controller.capture({ side: 'left', driveId: drive.id, confirmed: true }), /Multiple bootloader drives/);
  h.connect('right');
  await assert.rejects(h.controller.capture({ side: 'left', driveId: drive.id, confirmed: true }), /target changed/);
  assert.deepEqual(h.controller.readbacks, {});
  assert.equal(await exists(path.join(h.controller.cacheRoot, 'readbacks')), false);
});

test('capture saves two identical bounded partial readbacks privately and reloads them', async (t) => {
  const h = await harness(t);
  await h.captureBoth();
  for (const side of ['left', 'right']) {
    const record = h.controller.readbacks[side];
    assert.equal(record.sha256, hash(CURRENT[side]));
    assert.equal(record.partial, true);
    assert.equal(record.restoreTested, false);
    assert.match(record.warning, /Partial flash readback only/);
    const dir = path.join(h.controller.cacheRoot, record.directory);
    assert.ok(dir.startsWith(path.join(h.controller.cacheRoot, 'readbacks') + path.sep));
    assert.ok((await fs.readFile(path.join(dir, 'CURRENT-read1.uf2'))).equals(CURRENT[side]));
    assert.ok((await fs.readFile(path.join(dir, 'CURRENT-read2.uf2'))).equals(CURRENT[side]));
    assert.equal(await fs.readFile(path.join(dir, 'INFO_UF2.TXT'), 'utf8'), INFO);
  }
  const reloaded = await new Controller({ config, github: h.github, discover: h.discover, cacheRoot: h.controller.cacheRoot }).init();
  assert.deepEqual(reloaded.readbacks, h.controller.readbacks);
});

test('capture refuses an oversize or malformed CURRENT.UF2', async (t) => {
  const h = await harness(t);
  await h.volume('huge', Buffer.alloc(4 * 1024 * 1024 + 512));
  await h.volume('bad', Buffer.from('not a uf2'));
  for (const name of ['huge', 'bad']) {
    h.connect(name);
    const [drive] = await h.controller.refreshDrives();
    await assert.rejects(h.controller.capture({ side: 'left', driveId: drive.id, confirmed: true }));
  }
  assert.deepEqual(h.controller.readbacks, {});
});

test('the same image cannot identify both halves', async (t) => {
  const h = await harness(t);
  await h.volume('twin', CURRENT.left);
  h.connect('left');
  let [drive] = await h.controller.refreshDrives();
  await h.controller.capture({ side: 'left', driveId: drive.id, confirmed: true });
  h.connect('twin');
  [drive] = await h.controller.refreshDrives();
  await assert.rejects(h.controller.capture({ side: 'right', driveId: drive.id, confirmed: true }), /already recorded as left/);
  assert.equal(h.controller.readbacks.right, undefined);
  await h.controller.prepare();
  await assert.rejects(h.controller.arm({ side: 'left', confirmed: true }), /both physical halves/);
});

test('capture both, prepare, arm, tick writes exactly the selected UF2 to the matching half only', async (t) => {
  const h = await harness(t);
  await h.ready('right');
  assert.equal(h.controller.state().armed.side, 'right');
  h.connect('right');
  await h.controller.tick();
  const flashed = await h.flashed();
  assert.deepEqual(Object.keys(flashed), ['right']);
  assert.ok(flashed.right.equals(FIRMWARE.right), 'exact prepared right-half bytes');
  assert.equal(h.controller.result.status, 'submitted');
  assert.equal(h.controller.armed, null);
  assert.equal(h.controller.busy, null);

  // The bootloader consumes FLASH.UF2; further ticks must not write again.
  await fs.rm(path.join(h.volumes.right, 'FLASH.UF2'));
  for (let i = 0; i < 3; i++) await h.controller.tick();
  assert.deepEqual(await h.written(), []);
});

test('the wrong half or multiple drives are rejected before writing', async (t) => {
  for (const connected of [['right'], ['left', 'right']]) {
    const h = await harness(t);
    await h.ready('left');
    h.connect(...connected);
    await h.controller.tick();
    assert.deepEqual(await h.written(), [], connected.join('+'));
    assert.equal(h.controller.armed, null, 'disarmed after a mismatch');
    assert.match(h.controller.error, connected.length > 1 ? /Multiple bootloader drives/ : /does not match the left backup/);
    h.connect('left');
    await h.controller.tick();
    assert.deepEqual(await h.written(), [], 'no later write without re-arming');
  }
});

test('a stale source SHA, run, attempt or unsuccessful run rejects arming', async (t) => {
  const changes = [
    [{ sha: 'b'.repeat(40) }, /source changed/],
    [{ attempt: 2 }, /latest successful build attempt/],
    [{ runId: 8 }, /latest successful build attempt/],
    [{ status: 'in_progress', conclusion: null }, /latest successful build attempt/],
    [{ conclusion: 'failure' }, /latest successful build attempt/],
  ];
  for (const [change, pattern] of changes) {
    const h = await harness(t);
    await h.captureBoth();
    await h.controller.prepare();
    Object.assign(h.remote, change);
    await assert.rejects(h.controller.arm({ side: 'left', confirmed: true }), pattern, JSON.stringify(change));
    assert.equal(h.controller.armed, null);
    if (change.sha) assert.equal(h.controller.prepared, null, 'stale build discarded');
  }
});

test('a corrupted or replaced cached UF2 rejects arming', async (t) => {
  const h = await harness(t);
  await h.captureBoth();
  await h.controller.prepare();
  const file = path.join(h.controller.prepared.dir, config.files.left);
  const tampered = Buffer.from(FIRMWARE.left);
  tampered[600] ^= 1;
  await fs.writeFile(file, tampered);
  await assert.rejects(h.controller.arm({ side: 'left', confirmed: true }), /Cached firmware changed/);
  await fs.writeFile(file, FIRMWARE.right);
  await assert.rejects(h.controller.arm({ side: 'left', confirmed: true }), /Cached firmware changed/);
  await fs.writeFile(file, tampered.subarray(0, 700));
  await assert.rejects(h.controller.arm({ side: 'left', confirmed: true }), /truncated/);
  assert.equal(h.controller.armed, null);
});

test('a corrupted or missing backup rejects arming', async (t) => {
  for (const damage of ['flip', 'delete', 'swap']) {
    const h = await harness(t);
    await h.captureBoth();
    await h.controller.prepare();
    const dir = path.join(h.controller.cacheRoot, h.controller.readbacks.right.directory);
    const file = path.join(dir, 'CURRENT-read2.uf2');
    if (damage === 'flip') { const b = await fs.readFile(file); b[700] ^= 1; await fs.writeFile(file, b); }
    if (damage === 'delete') await fs.rm(file);
    if (damage === 'swap') await fs.writeFile(file, CURRENT.left);
    await assert.rejects(h.controller.arm({ side: 'left', confirmed: true }), damage === 'delete' ? { code: 'ENOENT' } : /saved right backup changed/, damage);
    assert.equal(h.controller.armed, null);
  }
});

test('cancel before writing prevents the write', async (t) => {
  const h = await harness(t);
  await h.ready('left');
  h.controller.cancel();
  h.connect('left');
  await h.controller.tick();
  assert.deepEqual(await h.written(), []);
});

test('arming TTL and browser heartbeat lease expire without writing', async (t) => {
  // Lease: no heartbeat for more than 15 s.
  let h = await harness(t);
  await h.ready('left');
  h.clock += 15_001;
  h.connect('left');
  await h.controller.tick();
  assert.deepEqual(await h.written(), []);
  assert.equal(h.controller.armed, null);

  // TTL: heartbeats keep the lease alive but 120 s is absolute.
  h = await harness(t);
  await h.ready('left');
  const { id } = h.controller.state().armed;
  for (let i = 0; i < 13; i++) { h.clock += 10_000; h.controller.heartbeat(id); }
  h.connect('left');
  await h.controller.tick();
  assert.deepEqual(await h.written(), []);
  assert.equal(h.controller.armed, null);

  // A heartbeat for another id does not extend the lease; the right id does.
  h = await harness(t);
  await h.ready('left');
  h.clock += 10_000;
  h.controller.heartbeat('not-the-armed-id');
  h.clock += 6_000;
  h.connect('left');
  await h.controller.tick();
  assert.deepEqual(await h.written(), []);

  h = await harness(t);
  await h.ready('left');
  h.clock += 10_000;
  h.controller.heartbeat(h.controller.state().armed.id);
  h.clock += 10_000;
  h.connect('left');
  await h.controller.tick();
  assert.ok((await h.flashed()).left?.equals(FIRMWARE.left), 'heartbeat kept the lease valid');
});

test('an existing FLASH.UF2 is never overwritten', async (t) => {
  const h = await harness(t);
  await h.ready('left');
  await fs.writeFile(path.join(h.volumes.left, 'FLASH.UF2'), 'sentinel');
  h.connect('left');
  await h.controller.tick();
  assert.equal(await fs.readFile(path.join(h.volumes.left, 'FLASH.UF2'), 'utf8'), 'sentinel');
  assert.equal(h.controller.result.status, 'not-written');
  assert.equal(h.controller.armed, null);
});

// tick() calls discover 4 times: initial refresh (1), onlyDrive (2), the identity re-check inside
// currentBytes (3), and the final pre-write identity check (4). Cancel or expire at each await.
for (const call of [2, 3, 4]) {
  test(`cancellation during asynchronous pre-write verification (discover call ${call}) prevents the write`, async (t) => {
    const h = await harness(t);
    await h.ready('left');
    h.connect('left');
    h.discoverCalls = 0;
    h.hooks.onDiscover = (n) => { if (n === call) h.controller.cancel(); };
    await h.controller.tick();
    assert.equal(h.discoverCalls >= call, true, 'reached the hooked await');
    assert.deepEqual(await h.written(), []);
    assert.equal(h.controller.armed, null);
  });

  test(`lease expiry during asynchronous pre-write verification (discover call ${call}) prevents the write`, async (t) => {
    const h = await harness(t);
    await h.ready('left');
    h.connect('left');
    h.discoverCalls = 0;
    h.hooks.onDiscover = (n) => { if (n === call) h.clock += 15_001; };
    await h.controller.tick();
    assert.deepEqual(await h.written(), []);
  });
}

test('background discovery finishing during a foreground job does not clear its busy lock', async (t) => {
  const h = await harness(t);
  const discovery = deferred();
  h.hooks.onDiscover = () => discovery.promise;
  const tick = h.controller.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.controller.ticking, true);

  const gate = deferred();
  h.hooks.onCheck = () => gate.promise;
  const job = h.controller.check();
  assert.equal(h.controller.busy, 'Checking GitHub');

  discovery.resolve();
  await tick;
  assert.equal(h.controller.busy, 'Checking GitHub', 'tick must not release a lock it does not own');
  await assert.rejects(h.controller.prepare(), /Another operation is active/);
  assert.equal(h.controller.busy, 'Checking GitHub');

  gate.resolve();
  await job;
  assert.equal(h.controller.busy, null);
});

test('a foreground job cannot start while tick verifies a drive', async (t) => {
  const h = await harness(t);
  await h.ready('left');
  h.connect('left');
  const gate = deferred();
  h.discoverCalls = 0;
  h.hooks.onDiscover = (n) => (n === 2 ? gate.promise : undefined);
  const tick = h.controller.tick();
  while (h.discoverCalls < 2) await new Promise((r) => setImmediate(r));
  assert.equal(h.controller.busy, 'Verifying connected half');
  await assert.rejects(h.controller.check(), /Another operation is active/);
  gate.resolve();
  await tick;
  assert.equal(h.controller.busy, null);
  assert.ok((await h.flashed()).left?.equals(FIRMWARE.left));
});

test('simulation mode completes the full flow on temporary files only', async (t) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'companion-demo-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const demo = await createDemo(dir, config);
  const controller = await new Controller({ config, github: demo.github, discover: demo.discover, cacheRoot: path.join(dir, 'cache'), demo: true, allowFlash: true }).init();
  for (const side of ['left', 'right']) {
    await demo.connect(side);
    const [drive] = await controller.refreshDrives();
    await controller.capture({ side, driveId: drive.id, confirmed: true });
  }
  await controller.prepare();
  await controller.arm({ side: 'left', confirmed: true });
  await demo.connect('left');
  await controller.tick();
  const written = await fs.readFile(path.join(dir, 'SIMULATED-ASSIMILATOR', 'FLASH.UF2'));
  assert.equal(hash(written), controller.state().prepared.files.left.sha256);
  assert.equal(controller.result.status, 'submitted');
});
