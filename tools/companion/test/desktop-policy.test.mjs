import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canOpenExternal, navigationRules, credentialStore, desktopOptions } from '../../desktop/policy.mjs';
import { startWorkbench } from '../server.mjs';
import { AuthSession } from '../lib/auth.mjs';
import { smokeCheck } from '../../desktop/smoke.mjs';

const origin = 'http://127.0.0.1:49999';
const repository = 'tieoneease/cyboard-zmk-config';

test('desktop external links are a closed set, never arbitrary shell or filesystem URLs', () => {
  for (const url of [`${origin}/guide`, `https://github.com/${repository}`, `https://github.com/${repository}/actions/runs/123`,
    'https://github.com/settings/personal-access-tokens/new', 'https://nickcoutsos.github.io/keymap-editor/']) {
    assert.equal(canOpenExternal(url, origin, repository), true, url);
  }
  for (const url of ['file:///C:/Windows', 'javascript:alert(1)', 'cmd:calc', 'https://github.com.evil.example/',
    `https://user:password@github.com/${repository}`, `https://github.com:444/${repository}`, `http://github.com/${repository}`,
    `https://github.com/${repository}?token=secret`, `https://github.com/${repository}#fragment`, `https://github.com/${repository}/actions/runs/1/../../issues`,
    `https://github.com/${repository}/actions/runs/1;calc`, 'https://nickcoutsos.github.io/other/', `${origin}/api/session`, `${origin}/`,
    'http://localhost:49999/guide', 'http://127.0.0.1:49998/guide', null, {}, 'x'.repeat(1300)]) {
    assert.equal(canOpenExternal(url, origin, repository), false, String(url));
  }
});

test('native navigation explicitly denies unmatched URLs and exposes only the app document', () => {
  assert.deepEqual(JSON.parse(navigationRules(origin)), ['^*', `${origin}/`, `${origin}/#*`]);
  for (const bad of ['https://example.com', 'http://localhost:49999', `${origin}/path`, `${origin}/`, 'file:///tmp']) {
    assert.throws(() => navigationRules(bad));
  }
});

test('desktop fixture selection can only reduce hardware access', () => {
  assert.deepEqual(desktopOptions([]), { demo: false, smoke: false });
  assert.deepEqual(desktopOptions(['--demo']), { demo: true, smoke: false });
  assert.deepEqual(desktopOptions(['--smoke']), { demo: true, smoke: true });
  assert.throws(() => desktopOptions(['--allow-flash']));
});

test('macOS/Linux credential adapter owns one app/repository record and restricts macOS access', async () => {
  for (const platform of ['darwin', 'linux']) {
    const calls = [];
    const secrets = Object.fromEntries(['get', 'set', 'delete'].map(name => [name, async data => { calls.push({ name, data }); return null; }]));
    const store = credentialStore(repository, secrets, platform);
    await store.get(); await store.set('synthetic-test-value'); await store.delete();
    assert.deepEqual(calls.map(c => c.data.name), Array(3).fill(`github.com:${repository}`));
    assert.ok(calls.every(c => c.data.service === 'io.github.tieoneease.imprint-workbench'));
    assert.equal(calls[1].data.allowUnrestrictedAccess, false);
    assert.equal(Object.hasOwn(calls[1].data, 'persist'), false);
    assert.equal(credentialStore(repository, null, platform), null);
  }
});

test('Windows remains session-only: no saved token is loaded, written, or silently remembered', async () => {
  const secrets = Object.fromEntries(['get', 'set', 'delete'].map(name => [name, () => assert.fail(`Windows must not call secrets.${name}`)]));
  const store = credentialStore(repository, secrets, 'win32');
  assert.equal(store, null);
  if (process.platform === 'win32') assert.equal(credentialStore(repository, secrets), null);
  const auth = new AuthSession({ store, validate: async () => ({ login: 'fixture' }) });
  await auth.init();
  assert.equal(auth.state().canRemember, false);
  assert.equal(auth.getToken(), null);
  await assert.rejects(auth.connect({ token: 'synthetic-test-value', remember: true }), /storage is unavailable/);
  assert.equal(auth.getToken(), null);
  await auth.connect({ token: 'synthetic-test-value', remember: false });
  assert.equal(auth.getToken(), 'synthetic-test-value');
  assert.equal(auth.state().remembered, false);
  await auth.disconnect();
  assert.equal(auth.getToken(), null);
});

test('packaged backend smoke flow also runs against the source runtime with no host volumes or gh', async () => {
  const runtime = await startWorkbench({ demo: true, desktop: true });
  try {
    const report = await smokeCheck(runtime);
    assert.equal(report.pass, true);
    assert.equal(report.fixtureOnly, true);
    assert.equal(report.partialCaptures, 2);
  } finally { await runtime.stop(); await fs.rm(runtime.controller.cacheRoot, { recursive: true, force: true }); }
});

test('real-mode startup may inject discovery and GitHub without enabling writes or requiring a checkout', async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-runtime-')));
  const config = JSON.parse(await fs.readFile(new URL('../config.json', import.meta.url), 'utf8'));
  let checks = 0;
  const runtime = await startWorkbench({ config, resourceRoot: dir, cacheRoot: path.join(os.tmpdir(), `outside-${path.basename(dir)}`),
    github: { check: async () => { checks++; return { sha: 'a'.repeat(40), run: null }; } }, discover: async () => [], desktop: true });
  try {
    await runtime.initialCheck;
    const state = await (await fetch(`${runtime.url}/api/status`)).json();
    assert.equal(state.allowFlash, false);
    assert.equal(state.canChangeWriteMode, true);
    assert.equal(state.armed, null);
    assert.equal(checks, 1);
  } finally {
    await runtime.stop();
    await fs.rm(runtime.controller.cacheRoot, { recursive: true, force: true });
    await fs.rm(dir, { recursive: true, force: true });
  }
});
