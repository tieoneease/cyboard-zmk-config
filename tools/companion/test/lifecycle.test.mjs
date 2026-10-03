// Controller lifecycle regressions: shutdown fencing, closed sessions, and the session write-mode gate.
// Uses only the explicit simulation (createDemo) in a fresh temporary directory: no volume scan,
// no GitHub, no credentials, no hardware. Device writes land only in the temporary simulated volume.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Controller } from '../lib/controller.mjs';
import { createDemo } from '../lib/demo.mjs';

const config = {
  repository: 'tieoneease/cyboard-zmk-config', branch: 'migration/studio-preserve-current', workflow: 'build.yml', artifact: 'firmware',
  files: { left: 'imprint_left-assimilator-bt-zmk.uf2', right: 'imprint_right-assimilator-bt-zmk.uf2' },
};
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const exists = (file) => fs.access(file).then(() => true, () => false);
const CLOSED = /session (has )?closed/i;

async function waitFor(predicate, label, ms = 5000) {
  const until = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/**
 * Demo controller with both partial backups captured, the simulated build prepared, and the left
 * half in bootloader mode. `hooks.discover(n)` / `hooks.read(n)` can hold the nth call open.
 */
async function harness(t, { allowFlash = true, openDeviceFile } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'companion-lifecycle-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const demo = await createDemo(root, config);
  const c = await new Controller({ config, github: demo.github, discover: demo.discover, cacheRoot: path.join(root, 'cache'),
    demo: true, allowFlash: true, ...(openDeviceFile ? { openDeviceFile } : {}) }).init();
  for (const side of ['left', 'right']) { await demo.connect(side); await c.capture({ side, confirmed: true }); }
  await c.prepare();
  await demo.connect('left');
  c.allowFlash = allowFlash;
  const h = { c, demo, hooks: {}, discovers: 0, reads: 0, checks: 0, flash: path.join(root, 'SIMULATED-ASSIMILATOR', 'FLASH.UF2') };
  const discover = c.discover;
  const read = c.readDeviceFile;
  const check = c.github.check;
  c.discover = async () => { const n = ++h.discovers; await h.hooks.discover?.(n); return discover(); };
  c.readDeviceFile = async (...args) => { const n = ++h.reads; await h.hooks.read?.(n); return read(...args); };
  c.github.check = async () => { const n = ++h.checks; await h.hooks.check?.(n); return check(); };
  h.written = () => exists(h.flash);
  h.resetCounts = () => { h.discovers = 0; h.reads = 0; h.checks = 0; };
  return h;
}

// ---------- non-vacuity: the harness really writes when nothing stops it ----------

test('control: without shutdown, the same gated arm + pending discovery does write to the simulated drive', async (t) => {
  const h = await harness(t);
  const discovery = deferred(); const preflight = deferred();
  h.hooks.discover = (n) => (n === 1 ? discovery.promise : undefined);
  h.hooks.check = () => preflight.promise;
  const ticking = h.c.tick();
  const arming = h.c.arm({ side: 'left', confirmed: true });
  preflight.resolve(); await arming;
  discovery.resolve(); await ticking;
  assert.equal(h.c.result?.status, 'submitted');
  assert.ok(await h.written());
});

// ---------- regression: shutdown during asynchronous preflight and discovery ----------

test('shutdown while arming preflight and discovery are pending: nothing is armed and nothing is written', async (t) => {
  const h = await harness(t);
  const discovery = deferred(); const preflight = deferred();
  h.hooks.discover = (n) => (n === 1 ? discovery.promise : undefined);
  h.hooks.check = () => preflight.promise;
  const ticking = h.c.tick();
  const arming = h.c.arm({ side: 'left', confirmed: true }).then(() => null, (e) => e);
  await waitFor(() => h.checks === 1, 'arm preflight to reach GitHub check');
  assert.equal(h.c.shutdown(), true);
  assert.equal(h.c.closed, true);
  preflight.resolve();
  const error = await arming;
  assert.ok(error instanceof Error, 'arm rejected');
  assert.match(error.message, /closed during preflight. Nothing was armed/);
  assert.equal(h.c.armed, null);
  discovery.resolve(); await ticking;
  assert.equal(h.c.armed, null);
  assert.equal(h.c.result, null);
  assert.equal(h.c.busy, null);
  assert.equal(await h.written(), false);
});

test('shutdown during each asynchronous step of the armed tick blocks the write', async (t) => {
  // Discovery calls in one armed tick: 1 refresh, 2 target, 3 re-check after reading CURRENT.UF2, 4 final check before writing.
  const phases = {
    'initial discovery': { hook: 'discover', n: 1 },
    'target discovery': { hook: 'discover', n: 2 },
    'first CURRENT.UF2 read': { hook: 'read', n: 1 },
    'second CURRENT.UF2 read': { hook: 'read', n: 2 },
    'post-read discovery': { hook: 'discover', n: 3 },
    'final pre-write discovery': { hook: 'discover', n: 4 },
  };
  let covered = 0;
  for (const [name, { hook, n }] of Object.entries(phases)) {
    {
      const h = await harness(t);
      await h.c.arm({ side: 'left', confirmed: true });
      assert.ok(h.c.armed);
      h.resetCounts();
      const gate = deferred();
      let reached = false;
      h.hooks[hook] = (i) => { if (i === n) { reached = true; return gate.promise; } };
      const ticking = h.c.tick();
      await waitFor(() => reached, name);
      assert.notEqual(h.c.busy, 'Writing firmware');
      assert.equal(h.c.shutdown(), true, 'shutdown accepted before writing');
      assert.equal(h.c.armed, null, 'shutdown cancels the arm synchronously');
      gate.resolve(); await ticking;
      assert.equal(await h.written(), false, `${name}: nothing written`);
      assert.notEqual(h.c.result?.status, 'submitted');
      assert.equal(h.c.armed, null);
      assert.equal(h.c.busy, null);
      covered++;
    }
  }
  assert.equal(covered, 6);
});

// ---------- closed sessions do no further work ----------

test('after shutdown every operation is refused and tick does no discovery', async (t) => {
  const h = await harness(t);
  assert.equal(h.c.shutdown(), true);
  assert.equal(h.c.shutdown(), true, 'repeated shutdown is harmless');
  assert.equal(h.c.state().closed, true);
  h.resetCounts();
  const operations = {
    check: () => h.c.check(), rebuild: () => h.c.rebuild(), prepare: () => h.c.prepare(),
    capture: () => h.c.capture({ side: 'left', confirmed: true, replace: true }),
    arm: () => h.c.arm({ side: 'left', confirmed: true }),
    enableWrites: () => h.c.setWriteMode({ enabled: true, confirmed: true }),
    disableWrites: () => h.c.setWriteMode({ enabled: false }),
  };
  for (const [name, run] of Object.entries(operations)) await assert.rejects(run(), CLOSED, name);
  await h.c.tick();
  assert.equal(h.discovers, 0, 'no discovery after close');
  assert.equal(h.reads, 0);
  assert.equal(h.checks, 0);
  assert.equal(h.c.allowFlash, true, 'mode unchanged');
  assert.equal(h.c.armed, null);
  assert.equal(await h.written(), false);
});

// ---------- normal quit during a write ----------

test('shutdown is refused while firmware is being written, then succeeds after the result', async (t) => {
  const opened = deferred(); const release = deferred();
  const openDeviceFile = async (file, flags, mode) => {
    const handle = await fs.open(file, flags, mode);
    opened.resolve();
    return {
      writeFile: async (bytes) => { await release.promise; return handle.writeFile(bytes); },
      sync: () => handle.sync(), close: () => handle.close(),
    };
  };
  const h = await harness(t, { openDeviceFile });
  await h.c.arm({ side: 'left', confirmed: true });
  const ticking = h.c.tick();
  await opened.promise;
  assert.equal(h.c.busy, 'Writing firmware');
  assert.equal(h.c.shutdown(), false, 'quit refused mid-write');
  assert.equal(h.c.closed, false);
  assert.ok(h.c.armed, 'write not torn down');
  release.resolve(); await ticking;
  assert.equal(h.c.result?.status, 'submitted');
  assert.equal(h.c.busy, null);
  assert.equal(h.c.shutdown(), true, 'quit accepted once the result is recorded');
  assert.equal(h.c.closed, true);
  h.resetCounts();
  await h.c.tick();
  assert.equal(h.discovers, 0);
});

// ---------- session write mode ----------

test('setWriteMode validates strictly and leaves mode unchanged on rejection', async (t) => {
  const h = await harness(t, { allowFlash: false });
  const bad = [
    {}, { enabled: 'true', confirmed: true }, { enabled: 1, confirmed: true }, { enabled: null, confirmed: true },
    { enabled: true }, { enabled: true, confirmed: 'true' }, { enabled: true, confirmed: 1 }, { enabled: true, confirmed: false },
  ];
  for (const request of bad) {
    await assert.rejects(h.c.setWriteMode(request), /confirm enabling hardware writes/i, JSON.stringify(request));
    assert.equal(h.c.allowFlash, false, JSON.stringify(request));
  }
  await assert.rejects(h.c.setWriteMode(undefined));
  assert.equal(h.c.allowFlash, false);
});

test('enabling writes logs the change but never arms or writes; disabling needs no confirmation', async (t) => {
  const h = await harness(t, { allowFlash: false });
  const before = h.c.activity.length;
  await h.c.setWriteMode({ enabled: true, confirmed: true });
  assert.equal(h.c.allowFlash, true);
  assert.equal(h.c.armed, null);
  assert.equal(h.c.busy, null);
  assert.match(h.c.activity[0].message, /enabled for this session. No installation is armed/);
  assert.ok(h.c.activity.length > before);
  await h.c.tick(); // bootloader connected, build prepared, backups present
  assert.equal(h.c.armed, null);
  assert.equal(h.c.result, null);
  assert.equal(await h.written(), false, 'write mode alone never writes');
  await h.c.setWriteMode({ enabled: false });
  assert.equal(h.c.allowFlash, false);
  assert.match(h.c.activity[0].message, /read-only/);
});

test('with writes disabled, arm is refused before any preflight', async (t) => {
  const h = await harness(t, { allowFlash: false });
  h.resetCounts();
  await assert.rejects(h.c.arm({ side: 'left', confirmed: true }), /Hardware writes are disabled/);
  assert.equal(h.checks, 0);
  assert.equal(h.c.armed, null);
  await h.c.tick();
  assert.equal(await h.written(), false);
});

test('write mode cannot change while a job is busy or an install is armed', async (t) => {
  const h = await harness(t);
  const preflight = deferred();
  h.hooks.check = () => preflight.promise;
  const arming = h.c.arm({ side: 'left', confirmed: true });
  await waitFor(() => h.checks === 1, 'arm preflight');
  await assert.rejects(h.c.setWriteMode({ enabled: false }), /Another operation is active/);
  preflight.resolve(); await arming;
  assert.ok(h.c.armed);
  await assert.rejects(h.c.setWriteMode({ enabled: false }), /Another operation is active/);
  assert.equal(h.c.allowFlash, true);
  h.c.cancel();
  await h.c.setWriteMode({ enabled: false });
  assert.equal(h.c.allowFlash, false);
});
