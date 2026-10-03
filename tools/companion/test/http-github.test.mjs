import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { HttpGithub, GithubError, isArtifactUrl, API_VERSION, USER_AGENT, JSON_LIMIT, ARCHIVE_LIMIT } from '../lib/http-github.mjs';
import { extractFirmware } from '../lib/files.mjs';
import { makeUf2, makeZip } from './fixtures.mjs';

const REPO = 'tieoneease/cyboard-zmk-config';
const BRANCH = 'migration/studio-preserve-current';
const ENC_BRANCH = encodeURIComponent(BRANCH);
const SHA = 'fa888c609b103eda3cd9d62b4fad34a605030211';
const OTHER_SHA = '2506fead2aaf7351f0c2e95adb47f6a3624bf274';
const LEFT = 'imprint_left-assimilator-bt-zmk.uf2';
const RIGHT = 'imprint_right-assimilator-bt-zmk.uf2';
const TOKEN = 'github_pat_SECRETTOKEN0123456789';
const SIGNED = 'https://productionresultssa1.blob.core.windows.net/actions-results/abc/firmware.zip?sv=2023&sig=SIGNEDSECRET';
const API = 'https://api.github.com';
const RUN_ID = 36994219960;
const ARTIFACT_ID = 11221172018;
const config = () => ({ repository: REPO, branch: BRANCH, workflow: 'build.yml', artifact: 'firmware', files: { left: LEFT, right: RIGHT } });
const digestOf = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const ZIP = makeZip([{ name: LEFT, bytes: makeUf2({ fill: 1 }) }, { name: RIGHT, bytes: makeUf2({ fill: 2 }) }]);
const run = (fields = {}) => ({
  id: RUN_ID, head_sha: SHA, head_branch: BRANCH, head_repository: { full_name: REPO },
  path: '.github/workflows/build.yml', event: 'push', status: 'completed', conclusion: 'success',
  run_attempt: 1, created_at: '2026-10-02T10:12:53Z', ...fields,
});
const URLS = {
  head: `${API}/repos/${REPO}/commits/${ENC_BRANCH}`,
  runs: `${API}/repos/${REPO}/actions/workflows/build.yml/runs?branch=${ENC_BRANCH}&per_page=30`,
  run: `${API}/repos/${REPO}/actions/runs/${RUN_ID}`,
  artifacts: `${API}/repos/${REPO}/actions/runs/${RUN_ID}/artifacts?per_page=100`,
  zip: `${API}/repos/${REPO}/actions/artifacts/${ARTIFACT_ID}/zip`,
  dispatch: `${API}/repos/${REPO}/actions/workflows/build.yml/dispatches`,
  user: `${API}/user`,
  validateRuns: `${API}/repos/${REPO}/actions/workflows/build.yml/runs?branch=${ENC_BRANCH}&per_page=1`,
};

const json = (value, status = 200, headers = {}) => new Response(typeof value === 'string' ? value : JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
const redirect = (location, status = 302) => new Response(null, { status, headers: location === undefined ? {} : { location } });
const bytes = (buffer, headers = {}) => new Response(buffer, { status: 200, headers: { 'content-type': 'application/zip', ...headers } });
const secretBody = (status, headers = {}) => json({ message: `SECRET-BODY ${TOKEN} ${SIGNED}` }, status, headers);

/** Fake fetch: records every request and answers from `routes` (url -> () => Response), 404 otherwise. */
function fakeFetch(routes = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', headers: { ...init.headers }, body: init.body, redirect: init.redirect, signal: init.signal });
    const route = routes[url];
    return route ? route(init) : json({ message: 'Not Found' }, 404);
  };
  return { fetchImpl, calls };
}

function githubRoutes({ head = { sha: SHA, commit: { message: 'Enable Studio\n\nbody' } }, runs = [run()], detail, artifacts, served = ZIP, zipRoute } = {}) {
  artifacts ??= [{ id: ARTIFACT_ID, name: 'firmware', size_in_bytes: ZIP.length, expired: false, digest: digestOf(ZIP), workflow_run: { id: RUN_ID, head_branch: BRANCH, head_sha: SHA } }];
  return {
    [URLS.head]: () => json(head),
    [URLS.runs]: () => json({ total_count: runs.length, workflow_runs: runs }),
    [URLS.run]: () => json(detail ?? runs[0]),
    [URLS.artifacts]: () => json({ total_count: artifacts.length, artifacts }),
    [URLS.zip]: zipRoute ?? (() => redirect(SIGNED)),
    [SIGNED]: () => bytes(served),
  };
}

const client = (fetchImpl, options = {}) => new HttpGithub(config(), { fetchImpl, getToken: () => TOKEN, ...options });
const anonymous = (fetchImpl, options = {}) => new HttpGithub(config(), { fetchImpl, ...options });

function assertSafe(error, ...secrets) {
  assert.ok(error instanceof GithubError, `expected GithubError, got ${error?.name}: ${error?.message}`);
  for (const secret of [TOKEN, SIGNED, 'SIGNEDSECRET', 'SECRET-BODY', 'blob.core.windows.net', ...secrets]) {
    assert.ok(!error.message.includes(secret), `message leaks ${secret}: ${error.message}`);
    assert.ok(!JSON.stringify(error).includes(secret), `serialized error leaks ${secret}`);
  }
  assert.equal(error.cause, undefined);
  return true;
}

// ---------- public reads ----------

test('check works without a token and sends only pinned GitHub headers to api.github.com', async () => {
  const gh = fakeFetch(githubRoutes());
  const result = await anonymous(gh.fetchImpl).check();
  assert.equal(result.sha, SHA);
  assert.equal(result.run.id, RUN_ID);
  assert.deepEqual(gh.calls.map((c) => c.url), [URLS.head, URLS.runs]);
  for (const call of gh.calls) {
    assert.deepEqual(call.headers, { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': USER_AGENT });
    assert.equal(call.method, 'GET');
    assert.equal(call.redirect, 'manual');
    assert.ok(call.signal instanceof AbortSignal);
  }
  assert.equal(API_VERSION, '2022-11-28');
});

test('a connected token is sent as Bearer to the fixed API host', async () => {
  const gh = fakeFetch(githubRoutes());
  await client(gh.fetchImpl).check();
  for (const call of gh.calls) {
    assert.ok(call.url.startsWith(`${API}/`));
    assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`);
  }
});

test('the gh CLI runner is never used', async () => {
  const github = anonymous(fakeFetch(githubRoutes()).fetchImpl);
  assert.throws(() => github.execute('gh', ['api', 'user']), /not used/);
});

// ---------- download: inherited provenance over HTTP ----------

test('download verifies provenance, follows one redirect to artifact storage without credentials, and checks the digest', async () => {
  const gh = fakeFetch(githubRoutes());
  const github = client(gh.fetchImpl);
  const result = await github.download(await github.check());
  assert.ok(result.zip.equals(ZIP));
  assert.equal(result.provenance.digest, digestOf(ZIP));
  assert.equal(result.provenance.artifactId, ARTIFACT_ID);
  assert.deepEqual(gh.calls.map((c) => c.url), [URLS.head, URLS.runs, URLS.run, URLS.artifacts, URLS.zip, SIGNED]);
  const storage = gh.calls.at(-1);
  assert.deepEqual(storage.headers, { 'User-Agent': USER_AGENT }, 'no Authorization or GitHub headers to storage');
  assert.equal(storage.redirect, 'manual');
  assert.equal(gh.calls.at(-2).headers.Authorization, `Bearer ${TOKEN}`);
  const halves = await extractFirmware(result.zip, config());
  assert.equal(halves.left.filename, LEFT);
});

test('download needs a token before any request; check does not', async () => {
  const gh = fakeFetch(githubRoutes());
  const current = await anonymous(gh.fetchImpl).check();
  const before = gh.calls.length;
  await assert.rejects(anonymous(gh.fetchImpl).download(current), (e) => e.code === 'auth_required' && assertSafe(e));
  await assert.rejects(anonymous(gh.fetchImpl).api(`repos/${REPO}/actions/artifacts/${ARTIFACT_ID}/zip`, true), (e) => e.code === 'auth_required');
  assert.equal(gh.calls.length, before);
});

test('inherited provenance and digest checks still apply over HTTP', async () => {
  const tampered = Buffer.from(ZIP);
  tampered[100] ^= 1;
  let gh = fakeFetch(githubRoutes({ served: tampered }));
  let github = client(gh.fetchImpl);
  await assert.rejects(github.download(await github.check()), /does not match GitHub size\/SHA-256/);

  gh = fakeFetch(githubRoutes({ detail: run({ head_sha: OTHER_SHA }) }));
  github = client(gh.fetchImpl);
  await assert.rejects(github.download(await github.check()), /provenance changed/);
  assert.ok(!gh.calls.some((c) => c.url === URLS.zip), 'archive never requested');

  gh = fakeFetch({ ...githubRoutes(), [URLS.runs]: () => json({ workflow_runs: null }) });
  await assert.rejects(anonymous(gh.fetchImpl).check(), /invalid workflow-runs response/);
});

test('archive redirects go only to HTTPS GitHub artifact hosts, without credentials or ports, within a hop limit', async () => {
  const bad = {
    http: 'http://productionresultssa1.blob.core.windows.net/x?sig=SIGNEDSECRET',
    otherHost: 'https://evil.example/x?sig=SIGNEDSECRET',
    suffixTrick: 'https://productionresultssa1.blob.core.windows.net.evil.example/x?sig=SIGNEDSECRET',
    lookalike: 'https://evilblob.core.windows.net.example/x',
    bareSuffix: 'https://blob.core.windows.net/x',
    userinfo: 'https://user:pass@productionresultssa1.blob.core.windows.net/x?sig=SIGNEDSECRET',
    port: 'https://productionresultssa1.blob.core.windows.net:8443/x?sig=SIGNEDSECRET',
    relativeToApi: '/repos/other/thing',
    apiHost: `${API}/user`,
    githubCom: 'https://github.com/x',
    ipAddress: 'https://127.0.0.1/x',
    javascript: 'javascript:alert(1)',
    empty: '',
    missing: undefined,
  };
  for (const [name, location] of Object.entries(bad)) {
    const gh = fakeFetch(githubRoutes({ zipRoute: () => redirect(location) }));
    const github = client(gh.fetchImpl);
    const current = await github.check();
    await assert.rejects(github.download(current), (e) => e.code === 'redirect' && assertSafe(e, 'evil'), name);
    assert.equal(gh.calls.at(-1).url, URLS.zip, `${name}: redirect not followed`);
  }

  // A second hop between storage hosts is allowed; more than the limit is not.
  const hop2 = 'https://results-receiver.actions.githubusercontent.com/next?sig=SIGNEDSECRET';
  let gh = fakeFetch({ ...githubRoutes(), [SIGNED]: () => redirect(hop2, 307), [hop2]: () => bytes(ZIP) });
  let github = client(gh.fetchImpl);
  assert.ok((await github.download(await github.check())).zip.equals(ZIP));
  assert.ok(gh.calls.slice(-2).every((c) => c.headers.Authorization === undefined));

  const loop = {};
  for (let i = 0; i < 6; i++) loop[`https://h${i}.blob.core.windows.net/x?sig=SIGNEDSECRET`] = () => redirect(`https://h${i + 1}.blob.core.windows.net/x?sig=SIGNEDSECRET`);
  gh = fakeFetch({ ...githubRoutes({ zipRoute: () => redirect('https://h0.blob.core.windows.net/x?sig=SIGNEDSECRET') }), ...loop });
  github = client(gh.fetchImpl);
  await assert.rejects(github.download(await github.check()), (e) => e.code === 'redirect' && /too many/.test(e.message) && assertSafe(e));
  assert.equal(gh.calls.filter((c) => c.url.includes('.blob.core.windows.net')).length, 3, 'stops at the hop limit');
  assert.ok(gh.calls.filter((c) => !c.url.startsWith(API)).every((c) => c.headers.Authorization === undefined));
});

test('storage and API failures during the archive step are sanitized', async () => {
  for (const [status, code] of [[403, 'download_refused'], [404, 'download_refused'], [500, 'download_refused']]) {
    const gh = fakeFetch({ ...githubRoutes(), [SIGNED]: () => secretBody(status) });
    const github = client(gh.fetchImpl);
    await assert.rejects(github.download(await github.check()), (e) => e.code === code && e.status === status && assertSafe(e));
  }
  const gh = fakeFetch(githubRoutes({ zipRoute: () => secretBody(410) }));
  const github = client(gh.fetchImpl);
  await assert.rejects(github.download(await github.check()), (e) => e.code === 'gone' && /Rebuild/.test(e.message) && assertSafe(e));
});

test('isArtifactUrl accepts only documented artifact hosts', () => {
  for (const url of ['https://results-receiver.actions.githubusercontent.com/a', 'https://pipelines.actions.githubusercontent.com/a', 'https://productionresultssa19.blob.core.windows.net/a?sig=x', 'https://x.blob.core.windows.net:443/a']) {
    assert.ok(isArtifactUrl(new URL(url)), url);
  }
  for (const url of ['https://actions.githubusercontent.com/a', 'https://api.github.com/a', 'http://x.blob.core.windows.net/a', 'https://x.blob.core.windows.net.evil.com/a', 'https://a@x.blob.core.windows.net/a', 'https://x.blob.core.windows.net:444/a']) {
    assert.ok(!isArtifactUrl(new URL(url)), url);
  }
});

// ---------- API path and redirect policy ----------

test('unsafe or out-of-scope API paths are refused before any request', async () => {
  const gh = fakeFetch(githubRoutes());
  const github = client(gh.fetchImpl);
  const paths = [
    '../user', '/user', 'https://evil.example/x', '//evil.example/x', 'user?x=1', 'users/someone',
    `repos/other/repo/actions/runs`, `repos/${REPO}/../../other/repo`, `repos/${REPO}/%2e%2e/x`, `repos/${REPO}/%2E%2E/x`,
    `repos/${REPO}/a//b`, `repos/${REPO}/a\\b`, `repos/${REPO}/x@evil`, `repos/${REPO}/x#frag`, `repos/${REPO}/x y`,
    `repos/${REPO}/%zz`, `repos/${REPO}/a\nb`, `repos/${REPO}`, '', null, 42,
  ];
  for (const path of paths) await assert.rejects(github.api(path), (e) => e.code === 'unsafe_path', String(path));
  for (const path of [`repos/${REPO}/actions/runs/${RUN_ID}`, `repos/${REPO}/actions/artifacts/x/zip`, `repos/${REPO}/actions/artifacts/0/zip`, `repos/other/repo/actions/artifacts/1/zip`, `repos/${REPO}/actions/artifacts/1/zip?x=1`]) {
    await assert.rejects(github.api(path, true), (e) => e.code === 'unsafe_path', path);
  }
  assert.equal(gh.calls.length, 0);
  assert.throws(() => new HttpGithub({ ...config(), repository: '../x' }), /Invalid configured repository/);
  assert.throws(() => new HttpGithub(config(), { timeoutMs: 0 }), /timeoutMs/);
});

test('JSON API redirects are never followed, so the token never leaves the API host', async () => {
  for (const status of [301, 302, 307, 308]) {
    const gh = fakeFetch({ ...githubRoutes(), [URLS.head]: () => redirect('https://evil.example/steal', status) });
    await assert.rejects(client(gh.fetchImpl).check(), (e) => e.code === 'redirect' && assertSafe(e, 'evil'));
    assert.deepEqual(gh.calls.map((c) => c.url), [URLS.head]);
  }
});

test('a malformed token from the session is refused without a request', async () => {
  for (const token of ['a b', 'x\r\nX-Evil: 1', 'é', 'x'.repeat(513), 42]) {
    const gh = fakeFetch(githubRoutes());
    await assert.rejects(client(gh.fetchImpl, { getToken: () => token }).check(), (e) => e.code === 'auth_invalid' && assertSafe(e));
    assert.equal(gh.calls.length, 0);
  }
  const gh = fakeFetch(githubRoutes());
  await assert.rejects(client(gh.fetchImpl, { getToken: () => { throw new Error(TOKEN); } }).check(), (e) => e.code === 'auth_unavailable' && assertSafe(e));
});

// ---------- HTTP status and body handling ----------

test('HTTP errors map to clear codes without echoing bodies, headers, or tokens', async () => {
  const cases = [
    [() => secretBody(401), 'unauthorized', /Reconnect/, true],
    [() => secretBody(401), 'unauthorized', /requires a connected token/, false],
    [() => secretBody(403), 'forbidden', /Actions read/, true],
    [() => secretBody(403, { 'x-ratelimit-remaining': '0' }), 'rate_limited', /rate limit/, true],
    [() => secretBody(403, { 'retry-after': '60' }), 'rate_limited', /rate limit/, false],
    [() => secretBody(404), 'not_found', /token cannot access/, true],
    [() => secretBody(404), 'not_found', /Private repositories need a connected token/, false],
    [() => secretBody(429), 'rate_limited', /rate limit/, true],
    [() => secretBody(500), 'server', /HTTP 500/, true],
    [() => secretBody(418), 'http', /HTTP 418/, true],
  ];
  for (const [respond, code, message, withToken] of cases) {
    const gh = fakeFetch({ ...githubRoutes(), [URLS.head]: respond });
    const github = withToken ? client(gh.fetchImpl) : anonymous(gh.fetchImpl);
    await assert.rejects(github.check(), (e) => e.code === code && message.test(e.message) && assertSafe(e), `${code} ${message}`);
    assert.equal(gh.calls.length, 1, 'no automatic retry');
  }
});

test('nullable, non-JSON, and malformed bodies are rejected', async () => {
  const bodies = [
    () => json('null'), () => json('"text"'), () => json('42'), () => json('true'), () => json('{"sha":'), () => json(''),
    () => new Response('<html>SECRET-BODY</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    () => new Response(Buffer.from([0x7b, 0xff, 0x7d]), { status: 200, headers: { 'content-type': 'application/json' } }),
    () => new Response(null, { status: 204 }),
  ];
  for (const body of bodies) {
    const gh = fakeFetch({ ...githubRoutes(), [URLS.head]: body });
    await assert.rejects(client(gh.fetchImpl).check(), (e) => ['bad_response', 'http'].includes(e.code) && assertSafe(e));
  }
  const gh = fakeFetch({ ...githubRoutes(), [URLS.head]: () => ({ status: 200 }) });
  await assert.rejects(client(gh.fetchImpl).check(), (e) => e.code === 'bad_response');
});

function endless(chunkSize, counter) {
  return new ReadableStream({
    pull(controller) { counter.pulled += chunkSize; controller.enqueue(new Uint8Array(chunkSize)); },
    cancel() { counter.cancelled = true; },
  });
}

test('JSON and archive bodies are bounded while streaming and by declared length', async () => {
  let counter = { pulled: 0, cancelled: false };
  let gh = fakeFetch({ ...githubRoutes(), [URLS.head]: () => new Response(endless(64 * 1024, counter), { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(client(gh.fetchImpl).check(), (e) => e.code === 'too_large' && /2 MiB/.test(e.message));
  assert.ok(counter.pulled <= JSON_LIMIT + 4 * 64 * 1024, `stopped near the limit (${counter.pulled})`);
  assert.ok(counter.cancelled, 'stream cancelled');

  counter = { pulled: 0, cancelled: false };
  gh = fakeFetch({ ...githubRoutes(), [URLS.head]: () => new Response(endless(1024, counter), { headers: { 'content-type': 'application/json', 'content-length': String(JSON_LIMIT + 1) } }) });
  await assert.rejects(client(gh.fetchImpl).check(), (e) => e.code === 'too_large');

  counter = { pulled: 0, cancelled: false };
  gh = fakeFetch({ ...githubRoutes(), [SIGNED]: () => new Response(endless(1024 * 1024, counter)) });
  let github = client(gh.fetchImpl);
  await assert.rejects(github.download(await github.check()), (e) => e.code === 'too_large' && /16 MiB/.test(e.message) && assertSafe(e));
  assert.ok(counter.pulled <= ARCHIVE_LIMIT + 4 * 1024 * 1024 && counter.cancelled);

  gh = fakeFetch({ ...githubRoutes(), [SIGNED]: () => bytes(Buffer.alloc(16), { 'content-length': String(ARCHIVE_LIMIT + 1) }) });
  github = client(gh.fetchImpl);
  await assert.rejects(github.download(await github.check()), (e) => e.code === 'too_large');
});

test('one total deadline covers headers, redirects, and body', async () => {
  // fetch that ignores the abort signal entirely
  let gh = fakeFetch({ ...githubRoutes(), [URLS.head]: () => new Promise(() => {}) });
  let started = Date.now();
  await assert.rejects(client(gh.fetchImpl, { timeoutMs: 50 }).check(), (e) => e.code === 'timeout' && assertSafe(e));
  assert.ok(Date.now() - started < 2000);
  assert.ok(gh.calls[0].signal.aborted, 'request aborted');

  // headers arrive, the body stalls
  const counter = { pulled: 0, cancelled: false };
  const stalled = () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { counter.cancelled = true; } }), { headers: { 'content-type': 'application/json' } });
  gh = fakeFetch({ ...githubRoutes(), [URLS.head]: stalled });
  started = Date.now();
  await assert.rejects(client(gh.fetchImpl, { timeoutMs: 50 }).check(), (e) => e.code === 'timeout');
  assert.ok(Date.now() - started < 2000);
  assert.ok(counter.cancelled, 'stalled body cancelled');

  // each hop is fast but together they exceed the deadline
  const slow = (response) => () => new Promise((resolve) => setTimeout(() => resolve(response()), 40));
  gh = fakeFetch({ ...githubRoutes({ zipRoute: slow(() => redirect(SIGNED)) }), [SIGNED]: slow(() => bytes(ZIP)) });
  const github = client(gh.fetchImpl, { timeoutMs: 60 });
  const current = await client(fakeFetch(githubRoutes()).fetchImpl).check();
  await assert.rejects(github.download(current), (e) => e.code === 'timeout' && assertSafe(e));
});

test('network errors are replaced with a fixed message', async () => {
  const fetchImpl = async () => { throw Object.assign(new TypeError(`fetch failed ${TOKEN} ${SIGNED}`), { cause: new Error(SIGNED) }); };
  await assert.rejects(client(fetchImpl).check(), (e) => e.code === 'network' && assertSafe(e));
});

// ---------- rebuild ----------

test('rebuild sends one fixed workflow_dispatch POST and accepts 204 or 200', async () => {
  for (const status of [204, 200]) {
    const gh = fakeFetch({ [URLS.dispatch]: () => (status === 204 ? new Response(null, { status }) : json({ workflow_run_id: 1, run_url: 'x', html_url: 'y' })) });
    assert.equal(await client(gh.fetchImpl).rebuild(), undefined);
    assert.equal(gh.calls.length, 1);
    const [call] = gh.calls;
    assert.equal(call.url, URLS.dispatch);
    assert.equal(call.method, 'POST');
    assert.equal(call.redirect, 'manual');
    assert.deepEqual(JSON.parse(call.body), { ref: BRANCH });
    assert.deepEqual(call.headers, { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': USER_AGENT, 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` });
  }
});

test('rebuild requires a token and is never retried', async () => {
  let gh = fakeFetch({ [URLS.dispatch]: () => new Response(null, { status: 204 }) });
  await assert.rejects(anonymous(gh.fetchImpl).rebuild(), (e) => e.code === 'auth_required' && /Actions write/.test(e.message));
  assert.equal(gh.calls.length, 0);

  const failures = [
    [() => secretBody(403), 'forbidden', /Actions write/],
    [() => secretBody(422), 'rejected', /workflow_dispatch/],
    [() => secretBody(500), 'server', /HTTP 500/],
    [() => secretBody(401), 'unauthorized', /Reconnect/],
    [() => redirect('https://evil.example/x', 307), 'redirect', /not followed/],
    [() => { throw new Error(`socket ${TOKEN}`); }, 'network', /may or may not have started/],
    [() => new Promise(() => {}), 'timeout', /may or may not have started/],
  ];
  for (const [respond, code, message] of failures) {
    gh = fakeFetch({ [URLS.dispatch]: respond });
    await assert.rejects(client(gh.fetchImpl, { timeoutMs: 50 }).rebuild(), (e) => e.code === code && message.test(e.message) && assertSafe(e, 'evil'), code);
    assert.equal(gh.calls.length, 1, `${code}: exactly one dispatch attempt`);
  }
});

// ---------- validateToken ----------

test('validateToken checks the candidate against /user and the workflow runs, ignoring the session token', async () => {
  const candidate = 'ghp_CANDIDATE0123456789';
  const gh = fakeFetch({ [URLS.user]: () => json({ login: 'tieoneease', id: 1 }), [URLS.validateRuns]: () => json({ total_count: 0, workflow_runs: [] }) });
  const github = new HttpGithub(config(), { fetchImpl: gh.fetchImpl, getToken: () => { throw new Error('session token must not be read'); } });
  assert.deepEqual(await github.validateToken(candidate), { login: 'tieoneease' });
  assert.deepEqual(gh.calls.map((c) => [c.method, c.url]), [['GET', URLS.user], ['GET', URLS.validateRuns]]);
  assert.ok(gh.calls.every((c) => c.headers.Authorization === `Bearer ${candidate}`));
});

test('validateToken rejects bad syntax, rejected tokens, missing Actions read, and malformed bodies', async () => {
  const gh0 = fakeFetch({});
  for (const token of ['', 'a b', ' x', 'x\n', 'x'.repeat(513), 'é', null, 42]) {
    await assert.rejects(anonymous(gh0.fetchImpl).validateToken(token), (e) => e.code === 'invalid_token');
  }
  assert.equal(gh0.calls.length, 0);
  const runsOk = () => json({ workflow_runs: [] });
  const cases = [
    [{ [URLS.user]: () => secretBody(401) }, 'unauthorized', /rejected this token/],
    [{ [URLS.user]: () => json({ login: 'x' }), [URLS.validateRuns]: () => secretBody(403) }, 'forbidden', /Actions read/],
    [{ [URLS.user]: () => json({ login: 'x' }), [URLS.validateRuns]: () => secretBody(404) }, 'not_found', /cannot access/],
    [{ [URLS.user]: () => json('null'), [URLS.validateRuns]: runsOk }, 'bad_response', /./],
    [{ [URLS.user]: () => json([]), [URLS.validateRuns]: runsOk }, 'bad_response', /invalid user/],
    [{ [URLS.user]: () => json({ login: 'bad login<script>' }), [URLS.validateRuns]: runsOk }, 'bad_response', /invalid user/],
    [{ [URLS.user]: () => json({ login: 'x' }), [URLS.validateRuns]: () => json({ workflow_runs: null }) }, 'bad_response', /workflow-runs/],
  ];
  for (const [routes, code, message] of cases) {
    const gh = fakeFetch(routes);
    await assert.rejects(anonymous(gh.fetchImpl).validateToken(TOKEN), (e) => e.code === code && message.test(e.message) && assertSafe(e), code);
    assert.ok(gh.calls.every((c) => c.method === 'GET' && !c.url.endsWith('/dispatches')));
  }
});
