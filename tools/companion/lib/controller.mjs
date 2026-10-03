import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readRegular, sha256, inside, inspectReadback, storeBuild } from './files.mjs';
import { validateUf2 } from './uf2.mjs';

const sideOf = side => { if (!['left', 'right'].includes(side)) throw new Error('Select left or right.'); return side; };
export class Controller {
  constructor({ config, github, discover, cacheRoot, allowFlash = false, demo = false, now = Date.now,
    readDeviceFile = readRegular, openDeviceFile = fs.open }) {
    Object.assign(this, { config, github, discover, cacheRoot, allowFlash, demo, now, readDeviceFile, openDeviceFile });
    this.current = null; this.prepared = null; this.drives = []; this.readbacks = {};
    this.busy = null; this.armed = null; this.result = null; this.error = null; this.activity = [];
    this.ticking = false;
    this.closed = false;
  }
  async init() {
    await fs.mkdir(this.cacheRoot, { recursive: true, mode: 0o700 });
    this.cacheRoot = await fs.realpath(this.cacheRoot);
    try {
      const index = JSON.parse((await readRegular(path.join(this.cacheRoot, 'readbacks.json'), 32768)).toString('utf8'));
      for (const side of ['left', 'right']) {
        const r = index[side];
        if (r && /^[0-9a-f]{64}$/.test(r.sha256) && typeof r.directory === 'string') {
          inside(this.cacheRoot, r.directory);
          this.readbacks[side] = r;
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') this.log('Saved backup index could not be loaded. Capture both halves again.'); }
    return this;
  }
  log(message) { this.activity.unshift({ at: new Date(this.now()).toISOString(), message }); this.activity = this.activity.slice(0, 30); }
  state() {
    return {
      config: this.config, demo: this.demo, allowFlash: this.allowFlash, cacheRoot: this.cacheRoot, closed: this.closed,
      current: this.current, prepared: this.prepared ? { ...this.prepared, dir: undefined } : null,
      drives: this.drives.map(({ fingerprint, ...d }) => d), readbacks: this.readbacks,
      busy: this.busy, armed: this.armed ? { id: this.armed.id, side: this.armed.side, sha: this.armed.build.sha, expiresAt: this.armed.expiresAt } : null,
      result: this.result, error: this.error, activity: this.activity,
    };
  }
  async job(label, operation) {
    if (this.closed) throw new Error('This workbench session has closed. Restart the app.');
    if (this.busy || this.armed) throw new Error('Another operation is active. Finish or cancel it first.');
    this.busy = label; this.error = null;
    try { return await operation(); }
    catch (error) { this.error = error.message; this.log(`${label}: ${error.message}`); throw error; }
    finally { this.busy = null; }
  }
  async check() {
    return this.job('Checking GitHub', async () => {
      this.current = await this.github.check();
      if (this.prepared && this.prepared.sha !== this.current.sha) { this.prepared = null; this.log('Source changed; prepare the new commit before installing.'); }
      return this.current;
    });
  }
  async rebuild() {
    return this.job('Requesting build', async () => {
      await this.github.rebuild();
      this.log('Requested a GitHub Actions build of the configured branch. No source was pushed.');
      this.current = await this.github.check();
    });
  }
  async prepare() {
    return this.job('Downloading and validating firmware', async () => {
      this.prepared = null;
      this.current = await this.github.check();
      const downloaded = await this.github.download(this.current);
      const prepared = await storeBuild(this.cacheRoot, downloaded, this.config);
      const fresh = await this.github.check();
      this.current = fresh;
      if (fresh.sha !== prepared.sha) throw new Error('The source changed during download. Prepare the new build instead.');
      this.prepared = prepared;
      this.log(`Verified both UF2 files for ${prepared.sha.slice(0, 7)} against GitHub artifact SHA-256.`);
    });
  }
  async refreshDrives() {
    this.drives = await this.discover();
    return this.drives;
  }
  async onlyDrive(id) {
    const drives = await this.refreshDrives();
    if (drives.length !== 1) throw new Error(drives.length ? 'Multiple bootloader drives found. Leave only one half in bootloader mode.' : 'No compatible bootloader drive. Connect a half and double-tap its reset button.');
    if (id && drives[0].id !== id) throw new Error('The bootloader target changed. Check the connected half and try again.');
    return drives[0];
  }
  async currentBytes(drive) {
    const first = await this.readDeviceFile(path.join(drive.root, 'CURRENT.UF2'), 4 * 1024 * 1024);
    const second = await this.readDeviceFile(path.join(drive.root, 'CURRENT.UF2'), 4 * 1024 * 1024);
    const summary = inspectReadback(first);
    if (!first.equals(second)) throw new Error('Two CURRENT.UF2 reads differed. Nothing will be written.');
    const again = await this.onlyDrive(drive.id);
    if (again.fingerprint !== drive.fingerprint) throw new Error('Bootloader changed while reading it.');
    return { first, second, summary };
  }
  async persistReadbacks() {
    const target = path.join(this.cacheRoot, 'readbacks.json');
    const temp = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(this.readbacks, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(temp, target);
  }
  async capture({ side, driveId, confirmed, replace = false }) {
    sideOf(side);
    if (confirmed !== true) throw new Error('Confirm which physical half is connected.');
    return this.job(`Capturing ${side} backup`, async () => {
      if (this.readbacks[side] && replace !== true) throw new Error(`A ${side} backup already exists. Explicitly confirm replacing its saved identity record; previous capture files will be retained.`);
      const drive = await this.onlyDrive(driveId);
      const { first, second, summary } = await this.currentBytes(drive);
      const other = side === 'left' ? 'right' : 'left';
      if (this.readbacks[other]?.sha256 === summary.sha256) throw new Error(`This image is already recorded as ${other}. The connected half may be ${other}, or a saved label may be wrong. Verify the physical half and saved labels; do not swap halves just to bypass this warning.`);
      const directory = `readbacks/${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}-${side}-${randomUUID().slice(0, 8)}`;
      const dir = inside(this.cacheRoot, directory);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(dir, 'CURRENT-read1.uf2'), first, { flag: 'wx', mode: 0o600 });
      await fs.writeFile(path.join(dir, 'CURRENT-read2.uf2'), second, { flag: 'wx', mode: 0o600 });
      const info = await readRegular(path.join(drive.root, 'INFO_UF2.TXT'), 16384);
      await fs.writeFile(path.join(dir, 'INFO_UF2.TXT'), info, { flag: 'wx', mode: 0o600 });
      const record = { ...summary, directory, side, capturedAt: new Date(this.now()).toISOString(), boardId: drive.boardId, bootloaderVersion: drive.bootloaderVersion,
        warning: 'Partial flash readback only. Excludes settings and other regions; not a complete or restore-tested rollback.' };
      await fs.writeFile(path.join(dir, 'capture.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      this.readbacks[side] = record;
      await this.persistReadbacks();
      this.log(`Saved two identical ${side} readbacks privately. This is not a full-chip backup.`);
    });
  }
  async verifyBackups() {
    for (const side of ['left', 'right']) {
      const r = this.readbacks[side];
      if (!r) throw new Error('Capture a partial backup of both physical halves before arming installation.');
      const dir = inside(this.cacheRoot, r.directory);
      for (const name of ['CURRENT-read1.uf2', 'CURRENT-read2.uf2']) {
        const data = await readRegular(path.join(dir, name), 4 * 1024 * 1024);
        if (sha256(data) !== r.sha256) throw new Error(`The saved ${side} backup changed. Capture it again.`);
        inspectReadback(data);
      }
    }
    if (this.readbacks.left.sha256 === this.readbacks.right.sha256) throw new Error('Both backup records identify the same image. Identify the two halves again.');
  }
  async arm({ side, confirmed }) {
    sideOf(side);
    if (!this.allowFlash) throw new Error('Hardware writes are disabled. Enable installations for this session only when you are ready.');
    if (confirmed !== true) throw new Error('Confirm the selected physical half and the partial-backup limitation.');
    return this.job('Checking installation prerequisites', async () => {
      if (!this.prepared) throw new Error('Prepare a successful current build first.');
      const latest = await this.github.check();
      this.current = latest;
      if (latest.sha !== this.prepared.sha) { this.prepared = null; throw new Error('The source changed. Prepare its successful build before installing.'); }
      if (latest.run?.status !== 'completed' || latest.run.conclusion !== 'success' || latest.run.id !== this.prepared.runId || latest.run.attempt !== this.prepared.runAttempt) throw new Error('Prepare the latest successful build attempt before installing.');
      await this.verifyBackups();
      const file = this.prepared.files[side];
      const bytes = await readRegular(path.join(this.prepared.dir, file.filename), 4 * 1024 * 1024);
      if (validateUf2(bytes).sha256 !== file.sha256) throw new Error('Cached firmware changed. Download and prepare it again.');
      if (this.closed) throw new Error('This workbench session closed during preflight. Nothing was armed.');
      this.result = null;
      this.armed = { id: randomUUID(), side, build: this.prepared, bytes, expectedReadback: this.readbacks[side].sha256,
        expiresAt: this.now() + 120000, leaseUntil: this.now() + 15000 };
      this.log(`Armed once for ${side}, source ${this.prepared.sha.slice(0, 7)}. Waiting for the matching bootloader.`);
    });
  }
  heartbeat(id) { if (this.armed?.id === id) this.armed.leaseUntil = this.now() + 15000; }
  cancel() {
    if (this.busy === 'Writing firmware') throw new Error('A write has begun. Do not unplug or interrupt it.');
    if (this.armed) this.log('Installation cancelled before writing.');
    this.armed = null;
  }
  async setWriteMode({ enabled, confirmed }) {
    if (typeof enabled !== 'boolean' || (enabled && confirmed !== true)) throw new Error('Explicitly confirm enabling hardware writes for this session.');
    return this.job('Changing installation mode', async () => {
      this.allowFlash = enabled;
      this.log(enabled ? 'Hardware writes enabled for this session. No installation is armed.' : 'Returned to read-only hardware mode.');
    });
  }
  shutdown() {
    // Fence asynchronous arming as well as existing arms before stopping timers.
    if (this.busy === 'Writing firmware') return false;
    this.closed = true;
    this.cancel();
    return true;
  }
  async tick() {
    if (this.closed || this.ticking || this.busy) return;
    this.ticking = true;
    let ownsBusy = false;
    try {
      await this.refreshDrives();
      if (this.discoveryError) {
        if (this.error === this.discoveryError) this.error = null;
        this.discoveryError = null;
        this.log('Bootloader discovery is available again.');
      }
      if (this.closed || this.busy) return; // A foreground job or shutdown may have started during discovery.
      const armed = this.armed;
      if (!armed) return;
      if (this.now() > armed.expiresAt || this.now() > armed.leaseUntil) { this.cancel(); this.log('Arming expired or the browser stopped responding. Nothing was written.'); return; }
      if (!this.drives.length) return;
      this.busy = 'Verifying connected half';
      ownsBusy = true;
      const drive = await this.onlyDrive();
      const { summary } = await this.currentBytes(drive);
      if (summary.sha256 !== armed.expectedReadback) throw new Error(`The connected image does not match the ${armed.side} backup. Check the half, or capture its current firmware again. Nothing was written.`);
      if (this.armed?.id !== armed.id || this.now() > armed.leaseUntil || this.now() > armed.expiresAt) { this.armed = null; return; }
      const again = await this.onlyDrive(drive.id);
      if (again.fingerprint !== drive.fingerprint) throw new Error('Bootloader changed before writing. Nothing was written.');
      // Cancellation/shutdown/lease expiry can happen during that final asynchronous discovery.
      if (this.closed || this.armed?.id !== armed.id || this.now() > armed.leaseUntil || this.now() > armed.expiresAt) { this.armed = null; return; }
      this.busy = 'Writing firmware';
      // A fixed 8.3 filename, exclusive creation, no user-controlled destination.
      // Never overwrite a symlink, a leftover file, or a second discovered volume.
      let handle;
      let writeStarted = false;
      try {
        handle = await this.openDeviceFile(path.join(drive.root, 'FLASH.UF2'), 'wx', 0o600);
        writeStarted = true;
        await handle.writeFile(armed.bytes);
        await handle.sync();
        await handle.close(); handle = null;
        this.result = { side: armed.side, sha: armed.build.sha, status: 'submitted', at: new Date(this.now()).toISOString(),
          message: this.demo ? 'Simulation complete. Bytes were written only to a temporary test drive.' : 'Firmware bytes were submitted. Check that this half restarts and test its behavior; installation is not independently verified.' };
        this.log(`${armed.side}: ${this.demo ? 'simulated transfer complete' : 'bytes submitted; hardware verification still required'}.`);
      } catch (error) {
        this.result = { side: armed.side, sha: armed.build.sha, status: writeStarted ? 'unverified' : 'not-written', at: new Date(this.now()).toISOString(),
          message: writeStarted ? `The drive disconnected or the write failed. Outcome is unverified; do not assume success or auto-retry. ${error.message}` : `No firmware was written. ${error.message}` };
        this.error = this.result.message;
        this.log(this.result.message);
      } finally {
        if (handle) await handle.close().catch(() => {});
        this.armed = null;
      }
    } catch (error) {
      this.error = error.message;
      if (ownsBusy || this.discoveryError !== error.message) this.log(error.message);
      if (!ownsBusy) this.discoveryError = error.message;
      this.armed = null;
    } finally { if (ownsBusy) this.busy = null; this.ticking = false; }
  }
}
