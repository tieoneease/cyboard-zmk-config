import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { Github, validateConfig } from './lib/github.mjs';
import { Controller } from './lib/controller.mjs';
import { discoverDrives } from './lib/drives.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']], ['/assets/ibm-plex-sans.ttf', ['assets/ibm-plex-sans.ttf', 'font/ttf']],
  ['/assets/OFL.txt', ['assets/OFL.txt', 'text/plain; charset=utf-8']],
  ['/assets/imprint.svg', ['assets/imprint.svg', 'image/svg+xml']],
]);
const equalToken = (actual, expected) => typeof actual === 'string' && /^[0-9a-f]{64}$/.test(actual) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
async function bodyOf(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    if ((size += chunk.length) > 8192) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new Error('Request body is not valid JSON.'); } // JSON parser diagnostics can echo a pasted credential.
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
  return value;
}
const connections = new WeakMap();
const closing = new WeakMap();
export function createServer({ controller, demoBridge = null, auth = null, desktop = false, openLink = null,
  staticRoot = path.join(here, 'public'), guidePath = path.join(repoRoot, 'WORKFLOW.md') }) {
  const csrf = randomBytes(32).toString('hex');
  const state = () => ({ ...controller.state(), auth: auth?.state() ?? null, desktop, canChangeWriteMode: desktop });
  const server = http.createServer(async (req, res) => {
    const address = server.address();
    if (!address || controller.closed) { res.writeHead(503); res.end('Workbench session closed.'); return; }
    const authority = `127.0.0.1:${address.port}`;
    const origin = `http://${authority}`;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const json = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      if (req.headers.host !== authority) return json(403, { error: 'Only the loopback application address is accepted.' });
      const url = new URL(req.url, origin);
      if (url.pathname.startsWith('/api/')) {
        if ((req.headers.origin && req.headers.origin !== origin) || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) return json(403, { error: 'Cross-origin requests are not allowed.' });
        if (req.method === 'GET' && url.pathname === '/api/session') return json(200, { csrf, state: state() });
        if (req.method === 'GET' && url.pathname === '/api/status') return json(200, state());
        if (req.method !== 'POST') return json(405, { error: 'This operation requires POST.' });
        if (req.headers.origin !== origin || !equalToken(req.headers['x-workbench-token'], csrf)) return json(403, { error: 'Session confirmation is missing. Reload the workbench.' });
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return json(415, { error: 'Expected application/json.' });
        const data = await bodyOf(req);
        switch (url.pathname) {
          case '/api/check': await controller.check(); break;
          case '/api/rebuild': await controller.rebuild(); break;
          case '/api/prepare': await controller.prepare(); break;
          case '/api/capture': await controller.capture(data); break;
          case '/api/arm': await controller.arm(data); break;
          case '/api/cancel': controller.cancel(); break;
          case '/api/heartbeat': controller.heartbeat(data.id); break;
          case '/api/auth-connect':
            if (!auth) return json(404, { error: 'Built-in GitHub access is not enabled.' });
            await controller.job('Connecting GitHub', () => auth.connect(data)); break;
          case '/api/auth-disconnect':
            if (!auth) return json(404, { error: 'Built-in GitHub access is not enabled.' });
            await controller.job('Disconnecting GitHub', () => auth.disconnect()); break;
          case '/api/auth-verify':
            if (!auth) return json(404, { error: 'Built-in GitHub access is not enabled.' });
            await controller.job('Verifying GitHub access', () => auth.verify()); break;
          case '/api/open-link':
            if (!desktop || !openLink) return json(404, { error: 'Desktop link handling is not enabled.' });
            await openLink(data.url); break;
          case '/api/write-mode':
            if (!desktop) return json(404, { error: 'Session write-mode controls are not enabled.' });
            await controller.setWriteMode(data); break;
          case '/api/demo-connect':
            if (!demoBridge) return json(404, { error: 'Simulation is not enabled.' });
            if (controller.busy) throw new Error('Wait for the active operation to finish.');
            await demoBridge.connect(data.side); await controller.refreshDrives(); break;
          default: return json(404, { error: 'Unknown operation.' });
        }
        return json(200, state());
      }
      if (req.method !== 'GET') return json(405, { error: 'GET required.' });
      if (url.pathname === '/guide') {
        const guide = await fs.readFile(guidePath);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(guide);
      }
      const file = staticFiles.get(url.pathname);
      if (!file) return json(404, { error: 'Not found.' });
      const contents = await fs.readFile(path.join(staticRoot, file[0]));
      res.writeHead(200, { 'Content-Type': file[1] });
      res.end(contents);
    } catch (error) {
      if (!res.headersSent) json(400, { error: String(error.message).slice(0, 1200), state: state() });
      else res.end();
    }
  });
  const sockets = new Set();
  connections.set(server, sockets);
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    if (closing.has(server)) socket.destroy();
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  return server;
}
export function closeServer(server) {
  if (closing.has(server)) return closing.get(server);
  // Bun's close callback can precede socket teardown. Await actual close events too.
  const sockets = connections.get(server) || new Set();
  let timer;
  const promise = (async () => {
    const closed = new Promise((resolve, reject) => {
      if (!server.listening) return resolve();
      server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
    });
    const drained = (async () => {
      while (sockets.size) {
        const waits = [...sockets].map(socket => once(socket, 'close'));
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
        await Promise.all(waits);
      }
    })();
    try {
      await Promise.race([Promise.all([closed, drained]), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Local server connections did not close.')), 10000);
      })]);
    } finally { clearTimeout(timer); }
  })();
  closing.set(server, promise);
  return promise;
}
export async function main(args = process.argv.slice(2)) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Install Node.js 24 LTS or newer.');
  const flags = new Set(args);
  const portIndex = args.indexOf('--port');
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 4765;
  const known = new Set(['--demo', '--allow-flash', '--open', '--port']);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') { i++; continue; }
    if (!known.has(args[i])) throw new Error(`Unknown option: ${args[i]}`);
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be 1024–65535.');
  if (flags.has('--demo') && flags.has('--allow-flash')) throw new Error('Use either simulation or hardware-write mode, never both.');
  const runtime = await startWorkbench({ port, demo: flags.has('--demo'), allowFlash: flags.has('--allow-flash') });
  if (flags.has('--open')) {
    const options = { shell: false, windowsHide: true, timeout: 8000 };
    const command = process.platform === 'win32' ? ['cmd.exe', ['/d', '/c', 'start', '', runtime.url]] : process.platform === 'darwin' ? ['open', [runtime.url]] : ['xdg-open', [runtime.url]];
    execFile(command[0], command[1], options, () => {});
  }
  const onSignal = () => {
    const stopped = runtime.stop();
    if (stopped === false) { console.log('A firmware write is active. Wait for its result before closing.'); return; }
    Promise.resolve(stopped).then(() => { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); });
  };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  return runtime;
}
export function defaultCacheRoot() {
  const base = process.platform === 'win32' ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
    : (process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'));
  return path.join(base, 'CyboardImprintWorkbench');
}
export async function startWorkbench({ port = 0, demo = false, allowFlash = false, config = null, github = null,
  auth = null, desktop = false, openLink = null, staticRoot = path.join(here, 'public'), guidePath = path.join(repoRoot, 'WORKFLOW.md'),
  resourceRoot = repoRoot, cacheRoot: cacheOverride = null, discover = discoverDrives } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid server port.');
  if (demo && allowFlash) throw new Error('Simulation cannot enable real hardware writes.');
  config = validateConfig(config || JSON.parse(await fs.readFile(path.join(here, 'config.json'), 'utf8')));
  const requestedCache = demo ? await fs.mkdtemp(path.join(os.tmpdir(), 'imprint-workbench-demo-')) : (cacheOverride || defaultCacheRoot());
  await fs.mkdir(requestedCache, { recursive: true, mode: 0o700 });
  const cacheRoot = await fs.realpath(requestedCache);
  const relative = path.relative(await fs.realpath(resourceRoot), cacheRoot);
  if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) throw new Error('Private cache must be outside the repository.');
  const demoBridge = demo ? await (await import('./lib/demo.mjs')).createDemo(cacheRoot, config) : null;
  const controller = await new Controller({ config, github: demoBridge?.github || github || new Github(config), discover: demoBridge?.discover || discover,
    cacheRoot, demo, allowFlash: demo || allowFlash }).init();
  const server = createServer({ controller, demoBridge, auth: demo ? null : auth, desktop, openLink, staticRoot, guidePath });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  console.log(`Imprint Workbench: ${url}`);
  console.log(demo ? 'SIMULATION: only temporary fixture files can be written.' : controller.allowFlash ? 'Hardware-write mode. Nothing writes until explicitly armed in the UI.' : 'Read-only hardware mode. Builds/downloads and readbacks are allowed; flashing is disabled.');
  console.log(`Private cache: ${controller.cacheRoot}`);
  const initialCheck = controller.check().catch(() => {});
  let activeTick = Promise.resolve();
  let activeCheck = initialCheck;
  const tick = setInterval(() => { activeTick = controller.tick(); }, 1200);
  const check = setInterval(() => {
    // Signed-out public requests have a much smaller GitHub rate limit. Check once on
    // launch (or explicitly), rather than spending that limit while the app sits idle.
    if (auth && !demo && !auth.state().hasToken) return;
    if (!controller.busy && !controller.armed) activeCheck = controller.check().catch(() => {});
  }, 30000);
  const clearPolling = () => { clearInterval(tick); clearInterval(check); };
  const pausePolling = async () => { clearPolling(); await Promise.all([activeTick, activeCheck]); };
  const stop = () => {
    if (!controller.shutdown()) return false;
    clearPolling();
    return closeServer(server);
  };
  return { server, controller, stop, url, demoBridge, initialCheck, pausePolling };
}
