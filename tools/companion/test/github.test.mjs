import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Github, run as defaultRun, validateConfig } from '../lib/github.mjs';
import { extractFirmware } from '../lib/files.mjs';
import { makeUf2, makeZip } from './fixtures.mjs';

const REPO = 'tieoneease/cyboard-zmk-config';
const BRANCH = 'migration/studio-preserve-current';
const SHA = 'fa888c609b103eda3cd9d62b4fad34a605030211';
const OTHER_SHA = '2506fead2aaf7351f0c2e95adb47f6a3624bf274';
const LEFT = 'imprint_left-assimilator-bt-zmk.uf2';
const RIGHT = 'imprint_right-assimilator-bt-zmk.uf2';
const config = () => ({ repository: REPO, branch: BRANCH, workflow: 'build.yml', artifact: 'firmware', files: { left: LEFT, right: RIGHT } });
const digestOf = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const run = (fields = {}) => ({
  id: 36994219960, head_sha: SHA, head_branch: BRANCH, head_repository: { full_name: REPO },
  path: '.github/workflows/build.yml', event: 'push', status: 'completed', conclusion: 'success',
  run_attempt: 1, created_at: '2026-10-02T10:12:53Z', ...fields,
});

/**
 * Fake `gh` with GitHub API shapes. Only answers the exact endpoints the subject should call;
 * anything else fails like gh does. Binary endpoints honor options.encoding like execFile.
 */
function fakeGh({ head = { sha: SHA, commit: { message: 'Enable Studio\n\nbody' } }, runs = [run()], runsBody, detail, artifacts, artifactsBody, zip } = {}) {
  zip ??= makeZip([{ name: LEFT, bytes: makeUf2({ fill: 1 }) }, { name: RIGHT, bytes: makeUf2({ fill: 2 }) }]);
  artifacts ??= [{
    id: 11221172018, name: 'firmware', size_in_bytes: zip.length, expired: false, digest: digestOf(zip),
    workflow_run: { id: 36994219960, head_branch: BRANCH, head_sha: SHA },
  }];
  const calls = [];
  const routes = new Map([
    [`repos/${REPO}/commits/${encodeURIComponent(BRANCH)}`, () => head],
    [`repos/${REPO}/actions/workflows/build.yml/runs?branch=${encodeURIComponent(BRANCH)}&per_page=30`, () => runsBody ?? ({ total_count: runs.length, workflow_runs: runs })],
  ]);
  for (const r of runs) {
    routes.set(`repos/${REPO}/actions/runs/${r.id}`, () => detail ?? r);
    routes.set(`repos/${REPO}/actions/runs/${r.id}/artifacts?per_page=100`, () => artifactsBody ?? ({ total_count: artifacts.length, artifacts }));
  }
  for (const a of artifacts) routes.set(`repos/${REPO}/actions/artifacts/${a.id}/zip`, () => zip);
  const execute = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (command !== 'gh') throw new Error(`unexpected command ${command}`);
    if (args[0] !== 'api') return { stdout: '' };
    const route = routes.get(args[1]);
    if (!route || args.length !== 2) throw Object.assign(new Error('Command failed: gh api'), { stderr: `gh: Not Found (HTTP 404) ${args[1]}` });
    const value = route();
    if (Buffer.isBuffer(value)) return { stdout: options.encoding === 'buffer' ? value : value.toString(options.encoding ?? 'utf8') };
    return { stdout: JSON.stringify(value) };
  };
  return { execute, calls, zip, artifacts };
}

// ---------- configuration ----------

test('validateConfig accepts the expected repository settings', () => {
  assert.deepEqual(validateConfig(config()), config());
});

test('validateConfig rejects unsafe or unexpected settings', () => {
  const bad = {
    repository: ['owner', 'a/b/c', 'a b/c', '../x/y', 'o/r;rm', ''],
    branch: ['', 'a b', '-x', 'a..b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[', 'a\\b', 'x'.repeat(201)],
    workflow: ['build.json', '../build.yml', 'dir/build.yml', 'build.yml --x', ''],
    artifact: ['firmware2', 'settings_reset', ''],
  };
  for (const [key, values] of Object.entries(bad)) {
    for (const value of values) assert.throws(() => validateConfig({ ...config(), [key]: value }), Error, `${key}=${value}`);
  }
  for (const files of [{ left: RIGHT, right: LEFT }, { left: LEFT }, { left: LEFT, right: 'zmk.uf2' }, { left: `x/${LEFT}`, right: RIGHT }, undefined]) {
    assert.throws(() => validateConfig({ ...config(), files }), /per-half firmware filename/, JSON.stringify(files));
  }
});

// ---------- check(): source and run selection ----------

test('check reports the branch head and its newest matching run, ignoring unrelated runs', async () => {
  const gh = fakeGh({
    runs: [
      run({ id: 10 }),
      run({ id: 30, run_attempt: 2, status: 'in_progress', conclusion: null }),
      run({ id: 40, head_sha: OTHER_SHA }),
      run({ id: 41, head_branch: 'main' }),
      run({ id: 42, head_repository: { full_name: 'attacker/cyboard-zmk-config' } }),
      run({ id: 43, event: 'pull_request' }),
      run({ id: 44, event: 'schedule' }),
      run({ id: 45, head_repository: null }),
    ],
  });
  const result = await new Github(config(), gh.execute).check();
  assert.equal(result.sha, SHA);
  assert.equal(result.message, 'Enable Studio');
  assert.deepEqual(result.run, {
    id: 30, sha: SHA, status: 'in_progress', conclusion: null, attempt: 2, event: 'push',
    url: `https://github.com/${REPO}/actions/runs/30`, createdAt: '2026-10-02T10:12:53Z',
  });
  assert.ok(!Number.isNaN(Date.parse(result.checkedAt)));
  assert.deepEqual(gh.calls.map((c) => [c.command, ...c.args]), [
    ['gh', 'api', `repos/${REPO}/commits/migration%2Fstudio-preserve-current`],
    ['gh', 'api', `repos/${REPO}/actions/workflows/build.yml/runs?branch=migration%2Fstudio-preserve-current&per_page=30`],
  ]);
});

test('check returns no run when nothing matches, and rejects an invalid head SHA', async () => {
  const none = await new Github(config(), fakeGh({ runs: [run({ head_sha: OTHER_SHA }), run({ id: 2, event: 'workflow_run' })] }).execute).check();
  assert.equal(none.run, null);
  for (const sha of ['ABC', SHA.toUpperCase(), undefined, `${SHA}0`]) {
    await assert.rejects(new Github(config(), fakeGh({ head: { sha } }).execute).check(), /invalid commit ID/);
  }
});

test('workflow_dispatch runs are accepted', async () => {
  const result = await new Github(config(), fakeGh({ runs: [run({ event: 'workflow_dispatch' })] }).execute).check();
  assert.equal(result.run.event, 'workflow_dispatch');
});

test('API failures are wrapped with a bounded, actionable message', async () => {
  const execute = async () => { throw Object.assign(new Error('Command failed'), { stderr: 'HTTP 401: Bad credentials ' + 'x'.repeat(5000) }); };
  await assert.rejects(new Github(config(), execute).check(), (error) => {
    assert.match(error.message, /^GitHub request failed\. Check gh auth status and network access\. HTTP 401: Bad credentials/);
    assert.ok(error.message.length < 800);
    return true;
  });
});

test('malformed API responses fail with clear errors', async () => {
  for (const runsBody of [{}, { workflow_runs: null }, { workflow_runs: {} }, []]) {
    await assert.rejects(new Github(config(), fakeGh({ runsBody }).execute).check(), /invalid workflow-runs response/, JSON.stringify(runsBody));
  }
  for (const artifactsBody of [{}, { artifacts: null }, { artifacts: 'firmware' }]) {
    const gh = fakeGh({ artifactsBody });
    await assert.rejects(new Github(config(), gh.execute).download(await current(gh)), /invalid artifacts response/, JSON.stringify(artifactsBody));
  }
  const notJson = async () => ({ stdout: '<html>rate limited</html>' });
  await assert.rejects(new Github(config(), notJson).check(), /^Error: GitHub request failed/);
});

test('default runner never uses a shell and honors only a shorter timeout', async () => {
  // A local Node child process, not gh: proves arguments arrive literally even if shell:true is requested.
  const args = ['a b', '$(whoami)', '&', 'echo hacked', '"quoted"', '%PATH%'];
  const { stdout } = await defaultRun(process.execPath, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...args], { shell: true, timeout: 0 });
  assert.deepEqual(JSON.parse(stdout), args);
  const binary = await defaultRun(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0,255,1]))'], { encoding: 'buffer' });
  assert.ok(Buffer.isBuffer(binary.stdout) && binary.stdout.equals(Buffer.from([0, 255, 1])));
  const started = Date.now();
  await assert.rejects(defaultRun(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeout: 200 }), (error) => error.killed === true);
  assert.ok(Date.now() - started < 5000, 'shorter timeout applied');
});

test('rebuild dispatches only the configured workflow on the configured branch', async () => {
  const gh = fakeGh();
  await new Github(config(), gh.execute).rebuild();
  assert.deepEqual(gh.calls.map((c) => [c.command, ...c.args]), [['gh', 'workflow', 'run', 'build.yml', '--repo', REPO, '--ref', BRANCH]]);
});

// ---------- download(): provenance and artifact integrity ----------

async function current(gh) {
  return new Github(config(), gh.execute).check();
}

test('download returns the verified archive and its provenance', async () => {
  const gh = fakeGh();
  const result = await new Github(config(), gh.execute).download(await current(gh));
  assert.ok(result.zip.equals(gh.zip));
  assert.deepEqual({ ...result.provenance, downloadedAt: undefined }, {
    repository: REPO, branch: BRANCH, sha: SHA, runId: 36994219960, runAttempt: 1,
    artifactId: 11221172018, digest: digestOf(gh.zip), downloadedAt: undefined,
  });
  const zipCall = gh.calls.at(-1);
  assert.deepEqual(zipCall.args, ['api', `repos/${REPO}/actions/artifacts/11221172018/zip`]);
  assert.equal(zipCall.options.encoding, 'buffer');
  const halves = await extractFirmware(result.zip, config());
  assert.equal(halves.left.filename, LEFT);
});

test('download refuses a selection that is not a completed successful build of the head', async () => {
  const gh = fakeGh();
  const base = await current(gh);
  const before = gh.calls.length;
  for (const run of [null, { ...base.run, status: 'in_progress' }, { ...base.run, conclusion: 'failure' }, { ...base.run, conclusion: 'cancelled' }, { ...base.run, sha: OTHER_SHA }]) {
    await assert.rejects(new Github(config(), gh.execute).download({ ...base, run }), /needs a successful build/);
  }
  assert.equal(gh.calls.length, before, 'no API calls for an invalid selection');
});

test('download re-checks run provenance: repo, branch, SHA, workflow, status, conclusion, event', async () => {
  const changes = [
    { head_sha: OTHER_SHA }, { head_branch: 'main' }, { head_repository: { full_name: 'attacker/cyboard-zmk-config' } },
    { head_repository: undefined }, { path: '.github/workflows/other.yml' }, { path: 'build.yml' },
    { status: 'in_progress' }, { conclusion: 'failure' }, { conclusion: null }, { event: 'pull_request' }, { event: 'pull_request_target' },
    { id: 36994219961 }, { id: '36994219960' }, { id: undefined },
  ];
  for (const change of changes) {
    const gh = fakeGh({ detail: run(change) });
    await assert.rejects(new Github(config(), gh.execute).download(await current(gh)), /provenance changed/, JSON.stringify(change));
    assert.ok(!gh.calls.some((c) => String(c.args[1]).endsWith('/zip')), 'archive never fetched');
  }
});

const artifact = (zip, fields = {}) => ({
  id: 11221172018, name: 'firmware', size_in_bytes: zip.length, expired: false, digest: digestOf(zip),
  workflow_run: { id: 36994219960, head_branch: BRANCH, head_sha: SHA }, ...fields,
});
const zip = makeZip([{ name: LEFT, bytes: makeUf2({ fill: 1 }) }, { name: RIGHT, bytes: makeUf2({ fill: 2 }) }]);

test('download requires exactly one unexpired firmware artifact', async () => {
  const sets = {
    none: [],
    expiredOnly: [artifact(zip, { expired: true })],
    otherName: [artifact(zip, { name: 'firmware-left' })],
    ambiguous: [artifact(zip), artifact(zip, { id: 11221172019 })],
  };
  for (const [name, artifacts] of Object.entries(sets)) {
    const gh = fakeGh({ zip, artifacts });
    await assert.rejects(new Github(config(), gh.execute).download(await current(gh)), /exactly one unexpired firmware artifact/, name);
  }
  const gh = fakeGh({ zip, artifacts: [artifact(zip, { id: 5, expired: true }), artifact(zip)] });
  assert.equal((await new Github(config(), gh.execute).download(await current(gh))).provenance.artifactId, 11221172018);
});

test('download rejects artifacts with invalid metadata or another source', async () => {
  const cases = {
    noDigest: { digest: undefined }, md5Digest: { digest: 'md5:abc' }, upperDigest: { digest: digestOf(zip).toUpperCase().replace('SHA256', 'sha256') },
    shortDigest: { digest: 'sha256:abcd' }, zeroSize: { size_in_bytes: 0 }, hugeSize: { size_in_bytes: 16 * 1024 * 1024 + 1 },
    floatId: { id: 1.5 }, stringId: { id: '11221172018' },
  };
  for (const [name, fields] of Object.entries(cases)) {
    const gh = fakeGh({ zip, artifacts: [artifact(zip, fields)] });
    await assert.rejects(new Github(config(), gh.execute).download(await current(gh)), /size or GitHub SHA-256 digest/, name);
  }
  const sources = { sha: { head_sha: OTHER_SHA }, branch: { head_branch: 'main' }, run: { id: 1 }, missing: undefined };
  for (const [name, change] of Object.entries(sources)) {
    const workflow_run = change && { id: 36994219960, head_branch: BRANCH, head_sha: SHA, ...change };
    const gh = fakeGh({ zip, artifacts: [artifact(zip, { workflow_run })] });
    await assert.rejects(new Github(config(), gh.execute).download(await current(gh)), /Artifact source does not match/, name);
  }
});

test('download rejects an archive whose bytes differ from the GitHub digest or size', async () => {
  const tampered = Buffer.from(zip);
  tampered[100] ^= 1;
  const cases = {
    digest: { served: tampered, meta: artifact(zip) },
    longer: { served: Buffer.concat([zip, Buffer.from([0])]), meta: artifact(zip) },
    sizeOnly: { served: zip, meta: artifact(zip, { size_in_bytes: zip.length + 1 }) },
  };
  for (const [name, { served, meta }] of Object.entries(cases)) {
    const gh = fakeGh({ zip: served, artifacts: [meta] });
    await assert.rejects(new Github(config(), gh.execute).download(await current(gh)), /does not match GitHub size\/SHA-256/, name);
  }
});

// Optional: replay saved real API responses and archive (set GITHUB_EVIDENCE_DIR). No network.
const evidence = process.env.GITHUB_EVIDENCE_DIR;
test('download accepts saved real GitHub run/artifact responses', { skip: !(evidence && existsSync(evidence)) && 'GITHUB_EVIDENCE_DIR not set' }, async () => {
  const find = (prefix) => readdirSync(path.join(evidence, 'evidence')).find((f) => f.startsWith(prefix));
  const realRun = JSON.parse(readFileSync(path.join(evidence, 'evidence', find('run-')), 'utf8'));
  const realArtifacts = JSON.parse(readFileSync(path.join(evidence, 'evidence', find('artifacts-')), 'utf8')).artifacts;
  const realZip = readFileSync(path.join(evidence, 'firmware-artifact.zip'));
  const cfg = { ...config(), repository: realRun.head_repository.full_name, branch: realRun.head_branch };
  assert.equal(cfg.repository, REPO);
  const gh = fakeGh({ head: { sha: realRun.head_sha }, runs: [realRun], artifacts: realArtifacts, zip: realZip });
  const github = new Github(cfg, gh.execute);
  const result = await github.download(await github.check());
  assert.equal(result.provenance.digest, realArtifacts[0].digest);
  const halves = await extractFirmware(result.zip, cfg);
  assert.equal(halves.left.start, 0x26000);
});
