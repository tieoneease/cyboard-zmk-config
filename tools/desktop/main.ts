import Electrobun, { BrowserWindow, Utils, PATHS } from 'electrobun/main';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startWorkbench } from '../companion/server.mjs';
import { validateConfig } from '../companion/lib/github.mjs';
import { HttpGithub } from '../companion/lib/http-github.mjs';
import { AuthSession } from '../companion/lib/auth.mjs';
import { canOpenExternal, credentialStore, desktopOptions, navigationRules, DESKTOP_RUNTIME } from './policy.mjs';
import { smokeCheck } from './smoke.mjs';

let runtime;
let finishing = false;
let finished = false;
let quitCode = 0;
const stopForQuit = (event) => {
  if (finished) return;
  event.response = { allow: false };
  if (finishing || !runtime) return;
  const stopped = runtime.stop();
  if (stopped === false) return; // The write commit point has passed: keep the window and main process alive.
  finishing = true;
  Promise.resolve(stopped).then(() => { finished = true; Utils.quit(quitCode); }).catch(() => {
    finishing = false;
    void Utils.showMessageBox({ type: 'error', title: 'Imprint Workbench', message: 'The local session could not close cleanly.', detail: 'No new installation can start. Wait for any active operation before closing again.' });
  });
};
Electrobun.events.on('before-quit', stopForQuit);

try {
  if (Bun.version !== DESKTOP_RUNTIME) throw new Error(`This build requires the tested Bun ${DESKTOP_RUNTIME} runtime.`);
  // The platform extractor consumes its own command-line arguments. Smoke/demo selection
  // uses explicit environment flags and can only REDUCE access to fixture-only mode.
  const options = desktopOptions(process.env.IMPRINT_SMOKE_REPORT ? ['--smoke']
    : process.env.IMPRINT_WORKBENCH_DEMO === '1' ? ['--demo'] : []);
  const assets = path.join(PATHS.RESOURCES_FOLDER, 'app', 'companion');
  const config = validateConfig(JSON.parse(await fs.readFile(path.join(assets, 'config.json'), 'utf8')));
  let auth;
  const github = new HttpGithub(config, { getToken: () => auth?.getToken() ?? null });
  if (!options.demo) {
    auth = new AuthSession({ store: credentialStore(config.repository), validate: token => github.validateToken(token) });
    await auth.init();
  }
  runtime = await startWorkbench({ config, github, auth, demo: options.demo, desktop: true,
    staticRoot: path.join(assets, 'public'), guidePath: path.join(assets, 'WORKFLOW.md'), resourceRoot: PATHS.RESOURCES_FOLDER,
    openLink: url => {
      if (!canOpenExternal(url, runtime.url, config.repository)) throw new Error('This link is not allowed outside the workbench.');
      if (!Utils.openExternal(url)) throw new Error('The default browser could not be opened.');
    },
  });
  // Sandbox permits an event-only readiness marker, not native command RPC.
  // Unlike dom-ready alone, this proves the served app script initialized its session.
  let readyTimer;
  const applicationReady = options.smoke ? new Promise<void>((resolve, reject) => {
    readyTimer = setTimeout(() => reject(new Error('Native workbench UI did not initialize.')), 30000);
    Electrobun.events.on('host-message', event => {
      const detail = event.data.detail;
      if (detail?.type === 'imprint-workbench-ready') { clearTimeout(readyTimer); resolve(); }
    });
  }) : Promise.resolve();
  applicationReady.catch(() => {});
  const window = new BrowserWindow({
    title: options.demo ? 'Imprint Workbench — Simulation' : 'Imprint Workbench',
    url: `${runtime.url}/`, frame: { width: 1320, height: 960 },
    renderer: 'native', titleBarStyle: 'default', hidden: options.smoke,
    sandbox: true, allowedProtocols: { views: false, appData: false },
    navigationRules: navigationRules(runtime.url),
  });
  window.on('will-close', stopForQuit);
  // Electrobun's sandbox preload intercepts Cmd/Ctrl-click before our page click handler.
  Electrobun.events.on('new-window-open', event => {
    const detail = event.data.detail;
    const url = typeof detail === 'string' ? detail : detail?.url;
    if (canOpenExternal(url, runtime.url, config.repository)) Utils.openExternal(url);
  });
  // The same fence applies to graceful terminal/service signals. Forced OS termination is not preventable.
  process.on('SIGINT', () => stopForQuit({}));
  process.on('SIGTERM', () => stopForQuit({}));

  if (options.smoke) {
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Native webview did not become ready.')), 30000);
      window.webview.on('dom-ready', event => {
        if (event.data.detail === `${runtime.url}/`) { clearTimeout(timer); resolve(); }
      });
    });
    try {
      await Promise.all([ready, applicationReady]);
      const report = await smokeCheck(runtime);
      const target = process.env.IMPRINT_SMOKE_REPORT;
      if (!target) throw new Error('The smoke report destination is missing.');
      await fs.writeFile(`${target}.tmp`, JSON.stringify({ ...report, nativeDomReady: true, nativeUiInitialized: true, bun: Bun.version, platform: process.platform, arch: process.arch }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await fs.rename(`${target}.tmp`, target);
    } catch (error) {
      quitCode = 1;
      console.error('Packaged smoke check failed:', error.message);
    } finally { clearTimeout(readyTimer); }
    stopForQuit({});
  }
} catch (error) {
  quitCode = 1;
  console.error('Imprint Workbench could not start:', error.message);
  if (!process.env.IMPRINT_SMOKE_REPORT) await Utils.showMessageBox({ type: 'error', title: 'Imprint Workbench could not start', message: 'The desktop package could not initialize.', detail: String(error.message).slice(0, 300) });
  if (runtime) stopForQuit({});
  else { finished = true; Utils.quit(1); }
}
