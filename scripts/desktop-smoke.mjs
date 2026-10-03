// Run the built desktop application, not an installed Node/Bun/gh substitute.
// Requires a native desktop/display (use xvfb-run on Linux CI). Hardware is never enumerated.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { zstdDecompressSync } from 'node:zlib';
import assert from 'node:assert/strict';

const platform = { win32: 'win', darwin: 'macos', linux: 'linux' }[process.platform];
if (!platform || !['x64', 'arm64'].includes(process.arch)) throw new Error('Unsupported desktop smoke target.');
const archive = path.resolve('desktop-artifacts', `stable-${platform}-${process.arch}-ImprintWorkbench${process.platform === 'darwin' ? '.app' : ''}.tar.zst`);
await fs.access(archive);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'imprint-package-smoke-'));
const reportPath = path.join(temp, 'report.json');
const executable = process.platform === 'darwin'
  ? path.join(temp, 'ImprintWorkbench.app', 'Contents', 'MacOS', 'launcher')
  : path.join(temp, 'ImprintWorkbench', 'bin', process.platform === 'win32' ? 'launcher.exe' : 'launcher');
// Deliberately remove Node, Bun and gh from PATH. Keep only OS utilities needed by the launcher.
const env = { ...process.env, IMPRINT_SMOKE_REPORT: reportPath, ELECTROBUN_CONSOLE: '1',
  PATH: process.platform === 'win32' ? `${process.env.SystemRoot || 'C:\\Windows'}\\System32` : '/usr/bin:/bin' };
delete env.GH_TOKEN; delete env.GITHUB_TOKEN; delete env.NODE_OPTIONS; delete env.BUN_OPTIONS;
let child;
let timer;
let log;
let passed = false;
const watching = new AbortController();
try {
  // Exercise the exact packaged payload without modifying installed applications or OS shortcuts.
  // On Windows the build-folder launcher is an installer stub, not the payload's runtime launcher.
  const tar = path.join(temp, 'payload.tar');
  await fs.writeFile(tar, zstdDecompressSync(await fs.readFile(archive), { maxOutputLength: 300 * 1024 * 1024 }), { flag: 'wx' });
  const tarTool = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  await promisify(execFile)(tarTool, ['-xf', tar, '-C', temp], { shell: false, windowsHide: true, timeout: 30000 });
  await fs.access(executable);
  const reportReady = (async () => {
    for await (const event of fs.watch(temp, { signal: watching.signal })) {
      if (event.filename === 'report.json') {
        // The main process atomically renames a complete report into place.
        return;
      }
    }
  })();
  // Observe rejection even if launch fails first.
  reportReady.catch(() => {});
  const logPath = path.join(temp, 'native.log');
  log = await fs.open(logPath, 'wx');
  console.log(`Packaged runtime check: ${temp}`);
  // A separate Windows process group/console isolates native console teardown from
  // the test driver. Keep the child referenced and await its exit (never unref).
  child = spawn(executable, [], { cwd: path.dirname(executable), env, detached: process.platform === 'win32',
    stdio: ['ignore', log.fd, log.fd], windowsHide: true });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { console.log(`Packaged launcher exit: ${code}, signal: ${signal}`); resolve(code); }); });
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Packaged smoke timed out; see ${logPath}`)), 90000); });
  const code = await Promise.race([exited, deadline]);
  if (code !== 0) throw new Error(`Packaged launcher exited ${code}.\n${(await fs.readFile(logPath, 'utf8')).slice(-12000)}`);
  await Promise.race([reportReady, deadline]);
  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  assert.equal(report.pass, true);
  assert.equal(report.fixtureOnly, true);
  assert.equal(report.nativeDomReady, true);
  assert.equal(report.nativeUiInitialized, true);
  assert.equal(report.bun, '1.4.0');
  assert.equal(report.platform, process.platform);
  assert.equal(report.arch, process.arch);
  console.log(JSON.stringify(report, null, 2));
  passed = true;
} finally {
  clearTimeout(timer);
  watching.abort();
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32') {
      // The detached launcher owns Bun and WebView2 descendants; stop only this tree.
      try {
        await promisify(execFile)(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, timeout: 10000 });
      } catch (error) {
        // Natural exit may win the race with teardown. Otherwise retain its failure.
        if (child.exitCode === null && child.signalCode === null) console.error('Native smoke cleanup failed:', error.message);
      }
    } else child.kill();
  }
  await log?.close();
  // Keep failed native diagnostics; successful runs remove their temporary payload.
  if (passed) await fs.rm(temp, { recursive: true, force: true });
}
