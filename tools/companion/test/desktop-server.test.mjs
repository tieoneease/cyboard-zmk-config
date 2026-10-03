// Desktop HTTP boundary: auth and write-mode routes, their gates, secret handling, and server shutdown.
// Real loopback server on an ephemeral port; fake controller (with the real busy/armed job guard)
// and fake auth session. No devices, credentials, GitHub, or network beyond 127.0.0.1.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createServer, closeServer } from '../server.mjs';

const SECRET = 'github_pat_DESKTOPSECRET0123456789';
const AUTH_ROUTES = { '/api/auth-connect': 'Connecting GitHub', '/api/auth-disconnect': 'Disconnecting GitHub', '/api/auth-verify': 'Verifying GitHub access' };
const NEW_ROUTES = [...Object.keys(AUTH_ROUTES), '/api/write-mode'];

function fakeController() {
  const c = {
    busy: null, armed: null, allowFlash: false, jobs: [], calls: [],
    state: () => ({ busy: c.busy, armed: c.armed ? { id: 'armed-1', side: 'left' } : null, allowFlash: c.allowFlash, error: null, activity: [] }),
    // Same guard as Controller.job: one foreground operation, never while armed.
    async job(label, operation) {
      if (c.busy || c.armed) throw new Error('Another operation is active. Finish or cancel it first.');
      c.jobs.push(label); c.busy = label;
      try { return await operation(); } finally { c.busy = null; }
    },
    async setWriteMode(data) {
      c.calls.push(['setWriteMode', data]);
      return c.job('Changing installation mode', async () => { c.allowFlash = data.enabled; });
    },
    check: async () => { c.calls.push(['check']); }, rebuild: async () => { c.calls.push(['rebuild']); },
    prepare: async () => { c.calls.push(['prepare']); }, capture: async (d) => { c.calls.push(['capture', d]); },
    arm: async (d) => { c.calls.push(['arm', d]); }, refreshDrives: async () => [],
    cancel: () => { c.calls.push(['cancel']); }, heartbeat: (id) => { c.calls.push(['heartbeat', id]); },
  };
  return c;
}

function fakeAuth() {
  let token = null;
  const a = {
    calls: [], failWith: null,
    status: { hasToken: false, login: null, remembered: false, canRemember: true, storageError: null },
    state: () => ({ ...a.status }),
    async connect(request) {
      a.calls.push(['connect', request]);
      if (a.failWith) throw new Error(a.failWith);
      token = request.token;
      a.status = { ...a.status, hasToken: true, login: 'octo-user', remembered: request.remember === true };
      return a.state();
    },
    async disconnect() { a.calls.push(['disconnect']); token = null; a.status = { ...a.status, hasToken: false, login: null, remembered: false }; return a.state(); },
    async verify() { a.calls.push(['verify']); if (a.failWith) throw new Error(a.failWith); return a.state(); },
    getToken: () => token,
  };
  return a;
}

async function start(options = {}) {
  const controller = options.controller ?? fakeController();
  const server = createServer({ controller, ...options });
  const connections = { opened: 0, closed: 0 };
  server.on('connection', (socket) => { connections.opened++; socket.on('close', () => { connections.closed++; }); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const authority = `127.0.0.1:${port}`;
  const origin = `http://${authority}`;
  const request = ({ method = 'GET', path = '/', headers = {}, body, agent = false } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, agent, headers: { Host: authority, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
  const session = await request({ path: '/api/session' });
  const csrf = session.json?.csrf;
  const post = (path, data = {}, headers = {}, extra = {}) => request({
    method: 'POST', path, body: typeof data === 'string' ? data : JSON.stringify(data),
    headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Workbench-Token': csrf, ...headers }, ...extra,
  });
  return { server, controller, request, post, session, csrf, origin, authority, port, connections };
}

async function using(options, body) {
  const ctx = await start(options);
  try { return await body(ctx); } finally { await closeServer(ctx.server); }
}

const noSecret = (response, label = '') => assert.ok(!response.text.includes(SECRET), `${label} response leaks the token`);

// ---------- state contract ----------

test('state adds auth, desktop and canChangeWriteMode; legacy servers report auth null and no mode change', async () => {
  const auth = fakeAuth();
  await using({ auth, desktop: true }, async ({ session, request }) => {
    assert.equal(session.status, 200);
    assert.deepEqual(session.json.state.auth, auth.state());
    assert.equal(session.json.state.desktop, true);
    assert.equal(session.json.state.canChangeWriteMode, true);
    const status = await request({ path: '/api/status' });
    assert.deepEqual(status.json.auth, auth.state());
    assert.equal(status.json.canChangeWriteMode, true);
  });
  await using({}, async ({ session }) => {
    assert.equal(session.json.state.auth, null);
    assert.equal(session.json.state.desktop, false);
    assert.equal(session.json.state.canChangeWriteMode, false);
  });
});

// ---------- auth routes ----------

test('auth routes run through controller.job with fixed labels and return full state without the token', async () => {
  const auth = fakeAuth();
  await using({ auth, desktop: true }, async ({ post, request, controller }) => {
    const connected = await post('/api/auth-connect', { token: SECRET, remember: true });
    assert.equal(connected.status, 200);
    noSecret(connected, 'connect');
    assert.deepEqual(connected.json.auth, { hasToken: true, login: 'octo-user', remembered: true, canRemember: true, storageError: null });
    assert.equal(connected.json.desktop, true);
    assert.ok('busy' in connected.json && 'activity' in connected.json, 'full controller state');
    assert.equal(auth.calls[0][0], 'connect');
    assert.equal(auth.calls[0][1].token, SECRET);
    assert.equal(auth.calls[0][1].remember, true);
    noSecret(await request({ path: '/api/status' }), 'status');
    noSecret(await request({ path: '/api/session' }), 'session');

    const verified = await post('/api/auth-verify', {});
    assert.equal(verified.status, 200);
    const disconnected = await post('/api/auth-disconnect', {});
    assert.equal(disconnected.status, 200);
    assert.equal(disconnected.json.auth.hasToken, false);
    assert.deepEqual(controller.jobs, ['Connecting GitHub', 'Verifying GitHub access', 'Disconnecting GitHub']);
    assert.deepEqual(auth.calls.map(([name]) => name), ['connect', 'verify', 'disconnect']);
    assert.equal(controller.busy, null);
  });
});

test('auth failures return the error and full state, never the token', async () => {
  const auth = fakeAuth();
  auth.failWith = 'GitHub rejected this token (HTTP 401).';
  await using({ auth, desktop: true }, async ({ post }) => {
    const response = await post('/api/auth-connect', { token: SECRET, remember: false });
    assert.equal(response.status, 400);
    assert.equal(response.json.error, 'GitHub rejected this token (HTTP 401).');
    assert.deepEqual(response.json.state.auth, auth.state());
    assert.equal(response.json.state.desktop, true);
    noSecret(response, 'failed connect');
  });
});

test('auth changes are rejected while an install is armed or another job is busy', async () => {
  const auth = fakeAuth();
  await using({ auth, desktop: true }, async ({ post, controller }) => {
    for (const blocker of [() => { controller.armed = { id: 'armed-1' }; }, () => { controller.armed = null; controller.busy = 'Downloading and validating firmware'; }]) {
      blocker();
      for (const path of Object.keys(AUTH_ROUTES)) {
        const response = await post(path, path === '/api/auth-connect' ? { token: SECRET, remember: true } : {});
        assert.equal(response.status, 400, path);
        assert.match(response.json.error, /Another operation is active/);
        noSecret(response, path);
      }
    }
    assert.deepEqual(auth.calls, [], 'auth session never touched');
    assert.deepEqual(controller.jobs, []);
  });
});

// ---------- request gates on every new route ----------

test('Host, Origin, fetch-metadata, CSRF, method and content-type gates apply to every new route', async () => {
  const auth = fakeAuth();
  await using({ auth, desktop: true }, async ({ request, post, origin, csrf, controller }) => {
    const body = JSON.stringify({ token: SECRET, remember: true, enabled: true, confirmed: true });
    const base = { Origin: origin, 'Content-Type': 'application/json', 'X-Workbench-Token': csrf };
    const cases = {
      noOrigin: [{ ...base, Origin: undefined }, 403],
      foreignOrigin: [{ ...base, Origin: 'http://evil.example' }, 403],
      nullOrigin: [{ ...base, Origin: 'null' }, 403],
      noToken: [{ ...base, 'X-Workbench-Token': undefined }, 403],
      wrongToken: [{ ...base, 'X-Workbench-Token': 'f'.repeat(64) }, 403],
      crossSite: [{ ...base, 'Sec-Fetch-Site': 'cross-site' }, 403],
      wrongHost: [{ ...base, Host: 'localhost:1' }, 403],
      textPlain: [{ ...base, 'Content-Type': 'text/plain' }, 415],
      formEncoded: [{ ...base, 'Content-Type': 'application/x-www-form-urlencoded' }, 415],
    };
    for (const path of NEW_ROUTES) {
      for (const [name, [headers, status]] of Object.entries(cases)) {
        const clean = Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined));
        const response = await request({ method: 'POST', path, headers: clean, body });
        assert.equal(response.status, status, `${path} ${name}`);
        noSecret(response, `${path} ${name}`);
      }
      const get = await request({ path, headers: { Origin: origin } });
      assert.equal(get.status, 405, `${path} GET`);
    }
    assert.deepEqual(auth.calls, []);
    assert.deepEqual(controller.calls, []);
    assert.deepEqual(controller.jobs, []);
    assert.equal((await post('/api/auth-verify', {})).status, 200, 'the same server accepts a valid request');
  });
});

test('malformed JSON is rejected generically without echoing a partial token', async () => {
  const auth = fakeAuth();
  await using({ auth, desktop: true }, async ({ post, controller }) => {
    const bodies = [`{"token":"${SECRET}"`, `{"token":"${SECRET}",}`, `{'token':'${SECRET}'}`, `${SECRET}`, `{"token":"${SECRET}"}}`, `{"token":"${SECRET.slice(0, 20)}`];
    for (const path of [...NEW_ROUTES, '/api/check']) {
      for (const body of bodies) {
        const response = await post(path, body);
        assert.equal(response.status, 400, `${path} ${body}`);
        assert.equal(response.json.error, 'Request body is not valid JSON.', `${path} ${body}`);
        noSecret(response, path);
        assert.ok(!response.text.includes(SECRET.slice(0, 20)), 'no partial token');
      }
      for (const body of [`["${SECRET}"]`, `"${SECRET}"`, 'null', '42']) {
        const response = await post(path, body);
        assert.equal(response.status, 400, `${path} ${body}`);
        noSecret(response, path);
      }
    }
    assert.deepEqual(auth.calls, []);
    assert.deepEqual(controller.calls, []);
  });
});

// ---------- availability by mode ----------

test('auth routes exist only with an auth session; write-mode only on desktop', async () => {
  const cases = [
    [{}, NEW_ROUTES],                                   // command-line default
    [{ auth: fakeAuth() }, ['/api/write-mode']],        // auth without desktop
    [{ desktop: true }, Object.keys(AUTH_ROUTES)],      // desktop without auth (e.g. demo)
  ];
  for (const [options, unavailable] of cases) {
    await using(options, async ({ post, controller }) => {
      for (const path of unavailable) {
        const response = await post(path, path === '/api/write-mode' ? { enabled: true, confirmed: true } : { token: SECRET });
        assert.equal(response.status, 404, `${JSON.stringify(Object.keys(options))} ${path}`);
        noSecret(response, path);
      }
      assert.deepEqual(controller.calls, []);
      assert.deepEqual(controller.jobs, []);
      assert.equal(controller.allowFlash, false);
      if (options.auth) assert.deepEqual(options.auth.calls, []);
    });
  }
});

test('desktop write-mode passes the request to controller.setWriteMode and returns full state', async () => {
  await using({ desktop: true, auth: fakeAuth() }, async ({ post, controller }) => {
    const enabled = await post('/api/write-mode', { enabled: true, confirmed: true });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.json.allowFlash, true);
    assert.equal(enabled.json.canChangeWriteMode, true);
    assert.deepEqual(controller.calls, [['setWriteMode', { enabled: true, confirmed: true }]]);
    controller.armed = { id: 'armed-1' };
    const blocked = await post('/api/write-mode', { enabled: false, confirmed: true });
    assert.equal(blocked.status, 400);
    assert.match(blocked.json.error, /Another operation is active/);
    assert.equal(blocked.json.state.allowFlash, true);
  });
});

// ---------- shutdown ----------

test('closeServer waits until every socket has closed, and repeated closes resolve', async () => {
  const ctx = await start({ desktop: true, auth: fakeAuth() });
  const agent = new http.Agent({ keepAlive: true });
  try {
    await ctx.request({ path: '/api/status', agent });
    await ctx.post('/api/auth-verify', {}, {}, { agent });
    // A connection that never sends a request (for example a speculative preconnect).
    const raw = net.connect(ctx.port, '127.0.0.1');
    await new Promise((resolve, reject) => { raw.once('connect', resolve); raw.once('error', reject); });
    raw.on('error', () => {});
    const until = Date.now() + 2000;
    while (ctx.connections.opened < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
    assert.ok(ctx.connections.opened >= 2, `connections opened: ${ctx.connections.opened}`);

    let timer;
    const closing = closeServer(ctx.server);
    await Promise.race([closing, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('closeServer did not resolve within 3 s')), 3000); })]);
    clearTimeout(timer);
    assert.equal(ctx.connections.closed, ctx.connections.opened, 'every server socket emitted close before resolution');
    assert.equal(ctx.server.listening, false);
    const count = await new Promise((resolve) => ctx.server.getConnections((error, n) => resolve(error ? -1 : n)));
    assert.equal(count, 0);
    raw.destroy();

    await closeServer(ctx.server);
    await Promise.all([closeServer(ctx.server), closeServer(ctx.server)]);
  } finally {
    agent.destroy();
  }
});

test('concurrent closeServer calls on a live server both resolve', async () => {
  const ctx = await start({});
  await ctx.request({ path: '/api/status' });
  await Promise.all([closeServer(ctx.server), closeServer(ctx.server)]);
  assert.equal(ctx.server.listening, false);
  assert.equal(ctx.connections.closed, ctx.connections.opened);
});
