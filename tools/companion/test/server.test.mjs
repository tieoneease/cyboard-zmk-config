// HTTP boundary tests: real loopback server on an ephemeral port with a fake controller.
// No devices, no gh, no network beyond 127.0.0.1.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer, closeServer, main } from '../server.mjs';

const HOSTILE = '<script>alert(1)</script><img src=x onerror=alert(2)>';

function fakeController() {
  const calls = [];
  const record = (name) => async (data) => { calls.push([name, data]); if (controller.failWith) throw new Error(controller.failWith); };
  const controller = {
    calls, busy: null, failWith: null,
    state: () => ({ current: { sha: 'a'.repeat(40), message: HOSTILE }, activity: [{ message: HOSTILE }], busy: controller.busy }),
    check: record('check'), rebuild: record('rebuild'), prepare: record('prepare'),
    capture: record('capture'), arm: record('arm'), refreshDrives: record('refreshDrives'),
    cancel: (data) => { calls.push(['cancel', data]); },
    heartbeat: (id) => { calls.push(['heartbeat', id]); },
  };
  return controller;
}

async function start(t, options = {}) {
  const controller = fakeController();
  const server = createServer({ controller, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const authority = `127.0.0.1:${server.address().port}`;
  t.after(() => closeServer(server));
  const request = ({ method = 'GET', path = '/', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path, agent: false,
      headers: { Host: authority, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
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
  const origin = `http://${authority}`;
  const post = (path, data = {}, headers = {}) => request({
    method: 'POST', path, body: typeof data === 'string' ? data : JSON.stringify(data),
    headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Workbench-Token': session.json.csrf, ...headers },
  });
  return { server, controller, request, post, session, origin, authority };
}

test('GET /api/session returns a CSRF token, state and security headers', async (t) => {
  const { session } = await start(t);
  assert.equal(session.status, 200);
  assert.match(session.json.csrf, /^[0-9a-f]{64}$/);
  assert.equal(session.json.state.current.message, HOSTILE);
  assert.match(session.headers['content-type'], /^application\/json/);
  assert.equal(session.headers['x-content-type-options'], 'nosniff');
  assert.equal(session.headers['cache-control'], 'no-store');
  assert.equal(session.headers['x-frame-options'], 'DENY');
  assert.match(session.headers['content-security-policy'], /script-src 'self'/);
  assert.match(session.headers['content-security-policy'], /frame-ancestors 'none'/);
});

test('valid same-origin JSON commands with the token reach the controller', async (t) => {
  const { post, controller } = await start(t);
  const commands = [
    ['/api/check', {}, 'check'], ['/api/rebuild', {}, 'rebuild'], ['/api/prepare', {}, 'prepare'],
    ['/api/capture', { side: 'left', driveId: 'abc', confirmed: true }, 'capture'],
    ['/api/arm', { side: 'right', confirmed: true }, 'arm'], ['/api/cancel', {}, 'cancel'], ['/api/heartbeat', { id: 'x1' }, 'heartbeat'],
  ];
  for (const [path, data, name] of commands) {
    const response = await post(path, data);
    assert.equal(response.status, 200, path);
    assert.equal(response.json.current.message, HOSTILE);
    const [called, arg] = controller.calls.at(-1);
    assert.equal(called, name);
    if (name === 'capture' || name === 'arm') assert.deepEqual(arg, data);
    if (name === 'heartbeat') assert.equal(arg, 'x1');
  }
  assert.equal(controller.calls.length, commands.length);
  const charset = await post('/api/check', {}, { 'Content-Type': 'application/json; charset=utf-8' });
  assert.equal(charset.status, 200);
});

test('cross-origin, missing origin, bad token and bad Host are rejected without reaching the controller', async (t) => {
  const { post, request, controller, session, authority } = await start(t);
  const token = session.json.csrf;
  const cases = {
    otherOrigin: { Origin: 'http://evil.example' },
    otherPort: { Origin: 'http://127.0.0.1:1' },
    localhostOrigin: { Origin: `http://localhost:${authority.split(':')[1]}` },
    nullOrigin: { Origin: 'null' },
    crossSite: { 'Sec-Fetch-Site': 'cross-site' },
    sameSite: { 'Sec-Fetch-Site': 'same-site' },
    wrongToken: { 'X-Workbench-Token': token.replace(/.$/, (c) => (c === '0' ? '1' : '0')) },
    shortToken: { 'X-Workbench-Token': token.slice(0, 10) },
    emptyToken: { 'X-Workbench-Token': '' },
    badHost: { Host: 'evil.example' },
    localhostHost: { Host: `localhost:${authority.split(':')[1]}` },
    rebindHost: { Host: `attacker.example:${authority.split(':')[1]}` },
  };
  for (const [name, headers] of Object.entries(cases)) {
    const response = await post('/api/arm', { side: 'left', confirmed: true }, headers);
    assert.equal(response.status, 403, name);
  }
  const missingOrigin = await request({ method: 'POST', path: '/api/arm', body: '{"side":"left","confirmed":true}',
    headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': token } });
  assert.equal(missingOrigin.status, 403, 'missing Origin');
  const missingToken = await request({ method: 'POST', path: '/api/arm', body: '{}',
    headers: { Origin: `http://${authority}`, 'Content-Type': 'application/json' } });
  assert.equal(missingToken.status, 403, 'missing token');
  const textPlain = await post('/api/arm', '{"side":"left","confirmed":true}', { 'Content-Type': 'text/plain' });
  assert.equal(textPlain.status, 415, 'simple-request content type');
  for (const host of ['evil.example', `localhost:${authority.split(':')[1]}`]) {
    assert.equal((await request({ path: '/api/session', headers: { Host: host } })).status, 403, `session via ${host}`);
    assert.equal((await request({ path: '/', headers: { Host: host } })).status, 403, `static via ${host}`);
  }
  assert.equal((await request({ path: '/api/session', headers: { Origin: 'http://evil.example' } })).status, 403);
  assert.deepEqual(controller.calls, []);
});

test('a non-ASCII token of the right length is rejected and not executed', async (t) => {
  const { post, controller, session } = await start(t);
  const response = await post('/api/arm', { side: 'left', confirmed: true }, { 'X-Workbench-Token': `\u00e9${session.json.csrf.slice(1)}` });
  assert.ok(response.status >= 400 && response.status < 500, `status ${response.status}`);
  assert.deepEqual(controller.calls, []);
});

test('mutations over GET or other methods are not allowed', async (t) => {
  const { request, controller, session, origin } = await start(t);
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const response = await request({ method, path: '/api/arm?side=left&confirmed=true', headers: { Origin: origin, 'X-Workbench-Token': session.json.csrf } });
    assert.equal(response.status, 405, method);
  }
  assert.equal((await request({ method: 'POST', path: '/' })).status, 405);
  assert.deepEqual(controller.calls, []);
});

test('unknown routes, malformed bodies and controller errors fail gracefully', async (t) => {
  const { post, request, controller } = await start(t);
  const unknown = await post('/api/format-drive', {});
  assert.equal(unknown.status, 404);
  assert.equal((await request({ path: '/no-such-page' })).status, 404);
  assert.equal((await request({ path: '/../config.json' })).status, 404);
  assert.equal((await request({ path: '/%2e%2e/server.mjs' })).status, 404);
  for (const body of ['{not json', '[1,2]', 'null', '"text"', '42']) {
    const response = await post('/api/arm', body);
    assert.equal(response.status, 400, body);
    assert.equal(typeof response.json.error, 'string');
  }
  const big = await post('/api/arm', JSON.stringify({ pad: 'x'.repeat(9000) }));
  assert.equal(big.status, 400);
  assert.match(big.json.error, /too large/);
  assert.deepEqual(controller.calls, []);

  controller.failWith = `Disk failure ${HOSTILE}`;
  const failed = await post('/api/prepare', {});
  assert.equal(failed.status, 400);
  assert.equal(failed.json.error, `Disk failure ${HOSTILE}`);
  assert.match(failed.headers['content-type'], /^application\/json/);
  assert.ok(failed.json.state, 'state accompanies the error');
});

test('/api/demo-connect is absent in production and gated by the token in simulation', async (t) => {
  const production = await start(t);
  assert.equal((await production.post('/api/demo-connect', { side: 'left' })).status, 404);
  assert.equal((await production.post('/api/demo-connect', { side: 'left' }, { Origin: 'http://evil.example' })).status, 403);

  const connects = [];
  const simulation = await start(t, { demoBridge: { connect: async (side) => { connects.push(side); } } });
  assert.equal((await simulation.post('/api/demo-connect', { side: 'right' }, { 'X-Workbench-Token': 'x' })).status, 403);
  assert.equal((await simulation.post('/api/demo-connect', { side: 'right' })).status, 200);
  assert.deepEqual(connects, ['right']);
  assert.deepEqual(simulation.controller.calls.map(([name]) => name), ['refreshDrives']);
  simulation.controller.busy = 'Writing firmware';
  assert.equal((await simulation.post('/api/demo-connect', { side: 'left' })).status, 400);
  assert.deepEqual(connects, ['right']);
});

test('source-controlled strings stay inert data in API responses and static pages', async (t) => {
  const { request, session } = await start(t);
  assert.match(session.headers['content-type'], /^application\/json; charset=utf-8$/);
  assert.equal(session.json.state.activity[0].message, HOSTILE, 'returned verbatim as JSON data');
  const status = await request({ path: '/api/status' });
  assert.equal(status.status, 200);
  assert.equal(status.headers['x-content-type-options'], 'nosniff');
  const page = await request({ path: '/' });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /^text\/html/);
  assert.ok(!page.text.includes('alert('), 'state is never templated into HTML');
  const script = await request({ path: '/app.js' });
  assert.match(script.headers['content-type'], /^text\/javascript/);
});

test('server closes all sockets', async (t) => {
  const { server, request } = await start(t);
  await request({ path: '/api/session' });
  const keepAlive = new http.Agent({ keepAlive: true });
  await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/status', agent: keepAlive,
    headers: { Host: `127.0.0.1:${server.address().port}` } }, (res) => { res.resume(); res.on('end', resolve); }).on('error', reject));
  await closeServer(server);
  keepAlive.destroy();
  const count = await new Promise((resolve) => server.getConnections((error, n) => resolve(error ? -1 : n)));
  assert.equal(count, 0);
  assert.equal(server.listening, false);
});

test('main rejects unsafe or unknown startup options before doing anything', async () => {
  await assert.rejects(main(['--demo', '--allow-flash']), /either simulation or hardware-write/);
  await assert.rejects(main(['--bogus']), /Unknown option: --bogus/);
  await assert.rejects(main(['--port', '80']), /Port must be/);
  await assert.rejects(main(['--port', 'abc']), /Port must be/);
});
