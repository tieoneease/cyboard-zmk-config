import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { AuthSession, AuthError } from '../lib/auth.mjs';
import { HttpGithub, GithubError } from '../lib/http-github.mjs';

const OLD = 'ghp_OLDSECRET0123456789';
const NEW = 'github_pat_NEWSECRET0123456789';
const STATE_KEYS = ['hasToken', 'login', 'remembered', 'canRemember', 'storageError'];

/** In-memory stand-in for the parent's OS credential adapter; `fail` makes an operation throw a token-bearing error. */
function memoryStore(initial = null) {
  const store = {
    value: initial, calls: [], fail: {},
    async get() { store.calls.push('get'); if (store.fail.get) throw new Error(`keychain read failed ${store.value}`); return store.value; },
    async set(token) { store.calls.push('set'); if (store.fail.set) throw new Error(`keychain write failed ${token}`); store.value = token; },
    async delete() { store.calls.push('delete'); if (store.fail.delete) throw new Error(`keychain delete failed ${store.value}`); store.value = null; },
  };
  return store;
}

function validator(logins = { [OLD]: 'old-user', [NEW]: 'new-user' }) {
  const calls = [];
  const validate = async (token) => {
    calls.push(token);
    if (logins[token]) return { login: logins[token] };
    throw new GithubError('unauthorized', 'GitHub rejected this token (HTTP 401).', 401);
  };
  return { validate, calls };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function assertNoSecrets(session, ...extra) {
  const state = session.state();
  assert.deepEqual(Object.keys(state), STATE_KEYS);
  for (const view of [JSON.stringify(state), JSON.stringify(session), inspect(session, { showHidden: true, depth: 5 }), String(session)]) {
    for (const secret of [OLD, NEW, ...extra]) assert.ok(!view.includes(secret), `leaks ${secret}: ${view}`);
  }
}

const safeError = (code, ...secrets) => (error) => {
  assert.ok(error instanceof AuthError, `${error?.name}: ${error?.message}`);
  assert.equal(error.code, code);
  for (const secret of [OLD, NEW, 'keychain', ...secrets]) assert.ok(!error.message.includes(secret) && !JSON.stringify(error).includes(secret), `leaks ${secret}`);
  return true;
};

// ---------- init and state ----------

test('init loads the saved token without treating it as authenticated; verify sets the login', async () => {
  const store = memoryStore(OLD);
  const v = validator();
  const session = new AuthSession({ store, validate: v.validate });
  assert.deepEqual(await session.init(), { hasToken: true, login: null, remembered: true, canRemember: true, storageError: null });
  assert.equal(session.getToken(), OLD);
  assert.equal(v.calls.length, 0, 'init does not call GitHub');
  assertNoSecrets(session);
  assert.equal((await session.verify()).login, 'old-user');
  assertNoSecrets(session);
  assert.deepEqual(await session.init(), session.state(), 'second init is a no-op');
  assert.deepEqual(store.calls, ['get']);
});

test('init without a store or record starts signed out', async () => {
  const session = new AuthSession({ validate: validator().validate });
  assert.deepEqual(await session.init(), { hasToken: false, login: null, remembered: false, canRemember: false, storageError: null });
  const store = memoryStore(null);
  assert.equal((await new AuthSession({ store, validate: validator().validate }).init()).hasToken, false);
});

test('init ignores a malformed saved record and session-only connect removes it', async () => {
  for (const saved of ['has space', 'x\ny', 'x'.repeat(513), '', 42, { token: OLD }]) {
    const store = memoryStore(saved);
    const session = new AuthSession({ store, validate: validator().validate });
    const state = await session.init();
    assert.equal(state.hasToken, false, JSON.stringify(saved));
    assert.match(state.storageError, /malformed/);
    assert.equal(session.getToken(), null);
    await session.connect({ token: NEW });
    assert.equal(store.value, null, 'malformed record removed');
    assert.equal(session.state().storageError, null);
  }
});

test('an unreadable store fails closed with a sanitized warning', async () => {
  const store = memoryStore(OLD);
  store.fail.get = true;
  const session = new AuthSession({ store, validate: validator().validate });
  const state = await session.init();
  assert.equal(state.hasToken, false);
  assert.match(state.storageError, /could not be read/);
  assert.ok(!state.storageError.includes(OLD) && !state.storageError.includes('keychain'));
  assertNoSecrets(session);
});

// ---------- connect ----------

test('connect validates first, then switches to the new token for this session only by default', async () => {
  const store = memoryStore(null);
  const v = validator();
  const session = new AuthSession({ store, validate: v.validate });
  await session.init();
  assert.deepEqual(await session.connect({ token: NEW }), { hasToken: true, login: 'new-user', remembered: false, canRemember: true, storageError: null });
  assert.equal(session.getToken(), NEW);
  assert.deepEqual(v.calls, [NEW]);
  assert.equal(store.value, null);
  assert.ok(!store.calls.includes('set'));
  assertNoSecrets(session);
});

test('remember must be strictly boolean; only true persists', async () => {
  for (const remember of ['true', 1, null, 'yes', {}, 0]) {
    const store = memoryStore(null);
    const v = validator();
    const session = new AuthSession({ store, validate: v.validate });
    await assert.rejects(session.connect({ token: NEW, remember }), safeError('invalid_remember'), String(remember));
    assert.equal(v.calls.length, 0);
    assert.equal(store.value, null);
  }
  const store = memoryStore(null);
  const session = new AuthSession({ store, validate: validator().validate });
  await session.init();
  assert.equal((await session.connect({ token: NEW, remember: true })).remembered, true);
  assert.equal(store.value, NEW);
  assert.equal((await session.connect({ token: OLD, remember: false })).remembered, false);
  assert.equal(store.value, null, 'switching to session-only removes the saved record');
});

test('connect rejects malformed tokens without validating or echoing them', async () => {
  const v = validator();
  const session = new AuthSession({ store: memoryStore(null), validate: v.validate });
  const bad = ['', ' ', `${NEW} `, 'a b', 'a\tb', 'a\nb', 'tök', 'x'.repeat(513), null, 42, ['x']];
  for (const token of bad) await assert.rejects(session.connect({ token }), safeError('invalid_token', ...(typeof token === 'string' && token.trim() ? [token.trim()] : [])));
  await assert.rejects(session.connect(), safeError('invalid_token'));
  await assert.rejects(session.connect('ghp_x'), safeError('invalid_token'));
  assert.equal(v.calls.length, 0);
  assert.ok(await session.connect({ token: 'x'.repeat(512) }).catch((e) => e.code === 'unauthorized'), '512 characters accepted for validation');
});

test('a failed validation keeps the prior token, login, and saved record', async () => {
  const store = memoryStore(OLD);
  const session = new AuthSession({ store, validate: validator().validate });
  await session.init();
  await session.verify();
  const before = session.state();
  for (const remember of [true, false, undefined]) {
    await assert.rejects(session.connect({ token: 'ghp_WRONG0123456789', remember }), safeError('unauthorized', 'ghp_WRONG'));
    assert.deepEqual(session.state(), before);
    assert.equal(session.getToken(), OLD);
    assert.equal(store.value, OLD);
  }
  assert.deepEqual(store.calls, ['get'], 'store untouched by failed validation');
});

test('validator errors are sanitized unless they are authored, token-free messages', async () => {
  const raw = new AuthSession({ validate: async (token) => { throw new Error(`fetch failed for Bearer ${token}`); } });
  await assert.rejects(raw.connect({ token: NEW }), (e) => safeError('validation_failed')(e) && /Could not validate/.test(e.message));
  const echo = new AuthSession({ validate: async (token) => { throw Object.assign(new Error(`bad ${token}`), { expose: true, code: 'unauthorized' }); } });
  await assert.rejects(echo.connect({ token: NEW }), safeError('validation_failed'));
  const authored = new AuthSession({ validate: async () => { throw new GithubError('network', 'Could not reach GitHub. Check the network connection and try again.'); } });
  await assert.rejects(authored.connect({ token: NEW }), (e) => safeError('network')(e) && /Could not reach GitHub/.test(e.message));
  for (const result of [null, {}, { login: '' }, { login: 'bad login' }, { login: NEW + '<' }]) {
    const session = new AuthSession({ validate: async () => result });
    await assert.rejects(session.connect({ token: NEW }), safeError('bad_response'));
    assert.equal(session.getToken(), null);
  }
});

test('remember without secure storage fails closed: no fallback, explicit session-only still works', async () => {
  const v = validator();
  const session = new AuthSession({ validate: v.validate });
  await session.init();
  await assert.rejects(session.connect({ token: NEW, remember: true }), (e) => safeError('storage_unavailable')(e) && /session only/.test(e.message));
  assert.equal(session.getToken(), null);
  assert.equal(v.calls.length, 0);
  assert.equal((await session.connect({ token: NEW, remember: false })).hasToken, true);
});

test('a failed save keeps the current connection and reports the storage failure', async () => {
  const store = memoryStore(OLD);
  const session = new AuthSession({ store, validate: validator().validate });
  await session.init();
  await session.verify();
  store.fail.set = true;
  await assert.rejects(session.connect({ token: NEW, remember: true }), (e) => safeError('storage_failed')(e) && /not changed/.test(e.message));
  assert.equal(session.getToken(), OLD);
  assert.equal(session.state().login, 'old-user');
  assert.equal(session.state().remembered, true);
  assert.match(session.state().storageError, /could not be saved/);
  assertNoSecrets(session);
});

test('switching a saved token to session-only fails clearly if the saved record cannot be removed', async () => {
  const store = memoryStore(OLD);
  const session = new AuthSession({ store, validate: validator().validate });
  await session.init();
  store.fail.delete = true;
  await assert.rejects(session.connect({ token: NEW }), (e) => safeError('storage_failed')(e) && /could not be removed/.test(e.message));
  assert.equal(session.getToken(), OLD, 'prior token kept');
  assert.equal(session.state().remembered, true);
  assert.equal(store.value, OLD);
  store.fail.delete = false;
  await session.connect({ token: NEW });
  assert.equal(store.value, null);
  assert.deepEqual(session.state(), { hasToken: true, login: 'new-user', remembered: false, canRemember: true, storageError: null });
});

test('when the store state is unknown, session-only connect proceeds but warns that a record may remain', async () => {
  const store = memoryStore(OLD);
  store.fail.get = true;
  store.fail.delete = true;
  const session = new AuthSession({ store, validate: validator().validate });
  await session.init();
  const state = await session.connect({ token: NEW });
  assert.equal(state.hasToken, true);
  assert.equal(state.remembered, false);
  assert.match(state.storageError, /could not confirm/);
  assert.deepEqual(store.calls, ['get', 'delete']);
});

// ---------- disconnect ----------

test('disconnect clears memory and the saved record', async () => {
  const store = memoryStore(OLD);
  const session = new AuthSession({ store, validate: validator().validate });
  await session.init();
  assert.deepEqual(await session.disconnect(), { hasToken: false, login: null, remembered: false, canRemember: true, storageError: null });
  assert.equal(session.getToken(), null);
  assert.equal(store.value, null);
});

test('disconnect reports honestly when the saved record may remain', async () => {
  const store = memoryStore(OLD);
  const session = new AuthSession({ store, validate: validator().validate });
  await session.init();
  store.fail.delete = true;
  const state = await session.disconnect();
  assert.equal(session.getToken(), null, 'memory cleared even though deletion failed');
  assert.equal(state.hasToken, false);
  assert.match(state.storageError, /may remain/);
  assertNoSecrets(session);
});

test('disconnect skips the store when nothing was saved', async () => {
  const store = memoryStore(null);
  const session = new AuthSession({ store, validate: validator().validate });
  await session.init();
  await session.connect({ token: NEW });
  await session.disconnect();
  assert.deepEqual(store.calls, ['get']);
});

// ---------- verify and concurrency ----------

test('verify keeps the token on failure; only a rejected token clears the login', async () => {
  let mode = 'ok';
  const session = new AuthSession({ store: memoryStore(OLD), validate: async () => {
    if (mode === 'network') throw new GithubError('network', 'Could not reach GitHub. Check the network connection and try again.');
    if (mode === 'unauthorized') throw new GithubError('unauthorized', 'GitHub rejected this token (HTTP 401).', 401);
    return { login: 'old-user' };
  } });
  await assert.rejects(session.verify(), safeError('no_token'));
  await session.init();
  await session.verify();
  mode = 'network';
  await assert.rejects(session.verify(), safeError('network'));
  assert.deepEqual([session.getToken(), session.state().login], [OLD, 'old-user']);
  mode = 'unauthorized';
  await assert.rejects(session.verify(), safeError('unauthorized'));
  assert.deepEqual([session.getToken(), session.state().login, session.state().remembered], [OLD, null, true]);
});

test('concurrent sign-in changes are rejected while one is in flight', async () => {
  const gate = deferred();
  const store = memoryStore(OLD);
  const session = new AuthSession({ store, validate: async (token) => { await gate.promise; return { login: token === NEW ? 'new-user' : 'old-user' }; } });
  await session.init();
  const first = session.connect({ token: NEW, remember: true });
  for (const attempt of [() => session.connect({ token: OLD }), () => session.disconnect(), () => session.verify(), () => session.init()]) {
    await assert.rejects(attempt(), safeError('busy'));
  }
  assert.equal(session.getToken(), OLD, 'unchanged until validation completes');
  gate.resolve();
  assert.equal((await first).login, 'new-user');
  assert.equal(session.getToken(), NEW);
  assert.equal(store.value, NEW);
  assert.equal((await session.disconnect()).hasToken, false, 'unlocked after completion');

  const failing = new AuthSession({ validate: async () => { throw new Error('boom'); } });
  await assert.rejects(failing.connect({ token: NEW }));
  await assert.rejects(failing.connect({ token: NEW }), (e) => e.code === 'validation_failed', 'unlocked after failure');
});

test('a late init never overrides a connection made first', async () => {
  const store = memoryStore(OLD);
  const session = new AuthSession({ store, validate: validator().validate });
  await session.connect({ token: NEW });
  await session.init();
  assert.equal(session.getToken(), NEW);
});

// ---------- integration with the HTTP transport ----------

test('AuthSession + HttpGithub: validation uses the candidate; requests use the connected token only on the API host', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    if (url === 'https://api.github.com/user') return new Response(JSON.stringify({ login: 'new-user' }), { headers: { 'content-type': 'application/json' } });
    if (url.includes('/runs?')) return new Response(JSON.stringify({ workflow_runs: [] }), { headers: { 'content-type': 'application/json' } });
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  };
  let session;
  const github = new HttpGithub({ repository: 'tieoneease/cyboard-zmk-config', branch: 'migration/studio-preserve-current', workflow: 'build.yml', artifact: 'firmware',
    files: { left: 'imprint_left-assimilator-bt-zmk.uf2', right: 'imprint_right-assimilator-bt-zmk.uf2' } }, { fetchImpl, getToken: () => session.getToken() });
  session = new AuthSession({ store: memoryStore(null), validate: (token) => github.validateToken(token) });
  await session.init();
  await assert.rejects(github.rebuild(), (e) => e.code === 'auth_required');
  assert.equal((await session.connect({ token: NEW })).login, 'new-user');
  assert.deepEqual(calls.map((c) => c.auth), [`Bearer ${NEW}`, `Bearer ${NEW}`]);
  await assert.rejects(github.check(), (e) => e.code === 'not_found');
  assert.equal(calls.at(-1).auth, `Bearer ${NEW}`);
  await session.disconnect();
  await assert.rejects(github.check(), (e) => e.code === 'not_found' && /Private repositories/.test(e.message));
  assert.equal(calls.at(-1).auth, undefined);
  assert.ok(calls.every((c) => c.url.startsWith('https://api.github.com/')));
});
