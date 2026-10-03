import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { INFO_FILE_NAME, WINDOWS_VOLUME_QUERY, discoverDrives, listCandidateRoots } from '../lib/drives.mjs';

const GOOD_INFO = [
  'UF2 Bootloader 0.6.0 lib/nrfx (v2.0.0) lib/tinyusb (0.10.1)',
  'Model: Assimilator BLE',
  'Board-ID: nRF52840-assimilator-ble',
  'Date: Jan  1 2024',
  '',
].join('\r\n');
const OTHER_INFO = GOOD_INFO.replace('nRF52840-assimilator-ble', 'nRF52840-nice-nano');
const noRun = async () => assert.fail('no subprocess expected');

// ---------- Real temp-directory discovery through injected roots ----------

async function tempDir(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'uf2-drives-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function volume(dir, name, info) {
  const root = path.join(dir, name);
  await fs.mkdir(root);
  if (info !== undefined) await fs.writeFile(path.join(root, INFO_FILE_NAME), info);
  return root;
}

test('recognizes a compatible volume and reports its metadata', async (t) => {
  const dir = await tempDir(t);
  const root = await volume(dir, 'IMPRINTBOOT', GOOD_INFO);
  const drives = await discoverDrives({ roots: [root], run: noRun });
  assert.equal(drives.length, 1);
  const [drive] = drives;
  assert.equal(drive.root, root);
  assert.equal(drive.label, 'IMPRINTBOOT');
  assert.equal(drive.boardId, 'nRF52840-assimilator-ble');
  assert.equal(drive.model, 'Assimilator BLE');
  assert.equal(drive.bootloaderVersion, '0.6.0');
  assert.match(drive.id, /^[0-9a-f]{32}$/);
  assert.equal(typeof drive.fingerprint, 'string');
  const again = await discoverDrives({ roots: [root, root], run: noRun });
  assert.deepEqual(again, drives, 'rescan is stable and deduplicated');
});

test('rejects other boards, malformed, missing, oversize and directory INFO files', async (t) => {
  const dir = await tempDir(t);
  const roots = [
    await volume(dir, 'other', OTHER_INFO),
    await volume(dir, 'garbage', '\u0000\u0001binary'),
    await volume(dir, 'missing'),
    await volume(dir, 'oversize', GOOD_INFO + ' '.repeat(16 * 1024)),
  ];
  const infoDir = await volume(dir, 'infodir');
  await fs.mkdir(path.join(infoDir, INFO_FILE_NAME));
  roots.push(infoDir);
  const notDir = path.join(dir, 'plainfile');
  await fs.writeFile(notDir, GOOD_INFO);
  roots.push(notDir);
  assert.deepEqual(await discoverDrives({ roots, run: noRun }), []);
});

test('rejects symlinked roots and symlinked parents', async (t) => {
  const dir = await tempDir(t);
  const real = await volume(dir, 'real', GOOD_INFO);
  const linkRoot = path.join(dir, 'linkroot');
  await fs.symlink(real, linkRoot, 'junction');
  const linkParent = path.join(dir, 'linkparent');
  await fs.symlink(dir, linkParent, 'junction');
  const viaParent = path.join(linkParent, 'real');
  const drives = await discoverDrives({ roots: [linkRoot, viaParent, real], run: noRun });
  assert.deepEqual(drives.map((d) => d.root), [real], 'only the real path is accepted');
});

test('rejects a symlinked INFO file', async (t) => {
  const dir = await tempDir(t);
  const real = await volume(dir, 'real', GOOD_INFO);
  const fileLink = await volume(dir, 'filelink');
  try {
    await fs.symlink(path.join(real, INFO_FILE_NAME), path.join(fileLink, INFO_FILE_NAME), 'file');
  } catch (error) {
    if (error.code === 'EPERM') return t.skip('file symlinks need privilege on this host');
    throw error;
  }
  assert.deepEqual(await discoverDrives({ roots: [fileLink], run: noRun }), []);
});

test('tolerates a removed volume and keeps scanning', async (t) => {
  const dir = await tempDir(t);
  const gone = await volume(dir, 'gone', GOOD_INFO);
  const kept = await volume(dir, 'kept', GOOD_INFO);
  await fs.rm(gone, { recursive: true });
  const drives = await discoverDrives({ roots: [gone, kept], run: noRun });
  assert.deepEqual(drives.map((d) => d.root), [kept]);
});

test('fingerprint changes when the INFO metadata or the volume changes', async (t) => {
  const dir = await tempDir(t);
  const root = await volume(dir, 'VOL', GOOD_INFO);
  const [first] = await discoverDrives({ roots: [root], run: noRun });
  await fs.writeFile(path.join(root, INFO_FILE_NAME), GOOD_INFO.replace('0.6.0', '0.6.1'));
  const [updated] = await discoverDrives({ roots: [root], run: noRun });
  assert.notEqual(updated.fingerprint, first.fingerprint);
  assert.notEqual(updated.id, first.id);

  // Remount at the same path with identical metadata: a new directory is a new dev/ino.
  await fs.rm(root, { recursive: true });
  await volume(dir, 'VOL', GOOD_INFO);
  const [remounted] = await discoverDrives({ roots: [root], run: noRun });
  assert.equal(remounted.root, first.root);
  assert.notEqual(remounted.fingerprint, first.fingerprint);
});

test('rejects relative injected roots', async () => {
  await assert.rejects(discoverDrives({ roots: ['relative/dir'], run: noRun }), /absolute/);
});

// ---------- Fake platform inputs: in-memory filesystem, no real disk calls ----------

/** Minimal in-memory fs: nodes keyed by exact path. Links are followed by realpath/open only. */
function fakeFs(nodes, { failures = {} } = {}) {
  const error = (code, p) => Object.assign(new Error(`${code}: ${p}`), { code });
  const statOf = (node) => ({
    isSymbolicLink: () => node.type === 'link',
    isDirectory: () => node.type === 'dir',
    isFile: () => node.type === 'file',
    size: BigInt(Buffer.byteLength(node.content ?? '')),
    dev: BigInt(node.dev ?? 1),
    ino: BigInt(node.ino ?? 1),
  });
  const get = (p) => {
    if (failures[p]) throw error(failures[p], p);
    const node = nodes[p];
    if (!node) throw error('ENOENT', p);
    return node;
  };
  const follow = (p) => {
    const node = get(p);
    return node.type === 'link' ? follow(node.target) : { path: p, node };
  };
  return {
    async readdir(dir) {
      if (get(dir).type !== 'dir') throw error('ENOTDIR', dir);
      const sep = dir.includes('\\') ? '\\' : '/';
      const prefix = dir.endsWith(sep) ? dir : dir + sep;
      return Object.entries(nodes)
        .filter(([p]) => p.startsWith(prefix) && p.length > prefix.length && !p.slice(prefix.length).includes(sep))
        .map(([p, node]) => ({
          name: p.slice(prefix.length),
          isDirectory: () => node.type === 'dir',
          isSymbolicLink: () => node.type === 'link',
        }));
    },
    async lstat(p) { return statOf(get(p)); },
    async realpath(p) { return follow(p).path; },
    async open(p) {
      const { node } = follow(p);
      if (node.type !== 'file') throw error('EISDIR', p);
      const data = Buffer.from(node.content);
      return {
        // `swappedTo` simulates the file being replaced between lstat and open.
        async stat() { return statOf(node.swappedTo ?? node); },
        async read(buffer, offset, length, position) {
          const bytesRead = data.copy(buffer, offset, position, Math.min(data.length, position + length));
          return { bytesRead };
        },
        async close() {},
      };
    },
  };
}

const dir = (dev, ino) => ({ type: 'dir', dev, ino });
const file = (content, dev, ino) => ({ type: 'file', content, dev, ino });

function fakeWindows(disks, calls = []) {
  return async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: disks === undefined ? '' : JSON.stringify(disks), stderr: '' };
  };
}

test('Windows: queries removable disks with a fixed, shell-free PowerShell command', async () => {
  const calls = [];
  const disks = [
    { DeviceID: 'E:', VolumeName: 'IMPRINTBOOT', VolumeSerialNumber: '00420042' },
    { DeviceID: 'F:', VolumeName: 'IMPRINTBOOT', VolumeSerialNumber: '00420042' },
    { DeviceID: 'G:', VolumeName: 'OTHER', VolumeSerialNumber: '1234ABCD' },
    { DeviceID: 'H:', VolumeName: null, VolumeSerialNumber: null }, // card reader without media
    { DeviceID: '\\\\server\\share', VolumeName: 'x' },
    { DeviceID: 'E:\\..', VolumeName: 'x' },
  ];
  const fsys = fakeFs({
    'E:\\': dir(0x42, 5), 'E:\\INFO_UF2.TXT': file(GOOD_INFO, 0x42, 6),
    'F:\\': dir(0x42, 5), 'F:\\INFO_UF2.TXT': file(GOOD_INFO, 0x42, 6),
    'G:\\': dir(7, 5), 'G:\\INFO_UF2.TXT': file(OTHER_INFO, 7, 6),
  }, { failures: { 'H:\\': 'EBUSY' } });
  const drives = await discoverDrives({ platform: 'win32', fs: fsys, run: fakeWindows(disks, calls) });

  assert.equal(calls.length, 1);
  assert.match(calls[0].command, /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
  assert.deepEqual(calls[0].args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_VOLUME_QUERY]);
  assert.equal(calls[0].options.shell, false);
  assert.ok(calls[0].options.timeout > 0 && calls[0].options.timeout <= 10_000);
  assert.match(WINDOWS_VOLUME_QUERY, /Win32_LogicalDisk -Filter 'DriveType=2'.*DeviceID,VolumeName,VolumeSerialNumber/);

  assert.deepEqual(drives.map((d) => [d.root, d.label]), [['E:\\', 'IMPRINTBOOT'], ['F:\\', 'IMPRINTBOOT']]);
  assert.notEqual(drives[0].id, drives[1].id, 'same label and metadata, different root');
  assert.match(drives[0].fingerprint, /volume-serial:00420042/);
});

test('Windows: the fixed query parses as PowerShell (parse only, no execution)', { skip: process.platform !== 'win32' && 'needs Windows PowerShell' }, async () => {
  const { execFile } = await import('node:child_process');
  const script = `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseInput($env:Q,[ref]$null,[ref]$e); $e.Count`;
  const stdout = await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { env: { ...process.env, Q: WINDOWS_VOLUME_QUERY }, timeout: 20_000, shell: false, windowsHide: true },
    (error, out) => (error ? reject(error) : resolve(out))));
  assert.equal(stdout.trim(), '0');
});

test('Windows: accepts a single unwrapped object or empty output; reports query failure clearly', async () => {
  const fsys = fakeFs({ 'E:\\': dir(1, 5), 'E:\\INFO_UF2.TXT': file(GOOD_INFO, 1, 6) });
  const one = await discoverDrives({ platform: 'win32', fs: fsys, run: fakeWindows({ DeviceID: 'E:', VolumeName: 'B', VolumeSerialNumber: 'AA' }) });
  assert.equal(one.length, 1);
  assert.deepEqual(await discoverDrives({ platform: 'win32', fs: fsys, run: fakeWindows(undefined) }), []);
  await assert.rejects(
    discoverDrives({ platform: 'win32', fs: fsys, run: async () => { throw Object.assign(new Error('timed out'), { killed: true }); } }),
    /Removable volume query failed: timed out/,
  );
  await assert.rejects(discoverDrives({ platform: 'win32', fs: fsys, run: async () => ({ stdout: '{nope' }) }), /malformed JSON/);
});

test('Windows: fingerprint changes with volume serial or filesystem identity, not label', async () => {
  const scan = async (disk, dev = 1, ino = 6) => (await discoverDrives({
    platform: 'win32',
    fs: fakeFs({ 'E:\\': dir(dev, 5), 'E:\\INFO_UF2.TXT': file(GOOD_INFO, dev, ino) }),
    run: fakeWindows([{ DeviceID: 'E:', VolumeSerialNumber: '00420042', ...disk }]),
  }))[0];
  const base = await scan({ VolumeName: 'LEFT' });
  assert.equal((await scan({ VolumeName: 'RIGHT' })).fingerprint, base.fingerprint, 'label is not identity');
  assert.notEqual((await scan({ VolumeName: 'LEFT', VolumeSerialNumber: '00420043' })).fingerprint, base.fingerprint);
  assert.notEqual((await scan({ VolumeName: 'LEFT' }, 2)).fingerprint, base.fingerprint);
  assert.notEqual((await scan({ VolumeName: 'LEFT' }, 1, 7)).fingerprint, base.fingerprint);
});

test('macOS: scans immediate /Volumes directories and skips symlinks and failures', async () => {
  const fsys = fakeFs({
    '/Volumes': dir(1, 1),
    '/Volumes/Macintosh HD': { type: 'link', target: '/' },
    '/': dir(1, 2),
    '/Volumes/IMPRINTBOOT': dir(9, 1),
    '/Volumes/IMPRINTBOOT/INFO_UF2.TXT': file(GOOD_INFO, 9, 3),
    '/Volumes/IMPRINTBOOT/nested': dir(9, 4),
    '/Volumes/USBSTICK': dir(10, 1),
    '/Volumes/Locked': dir(11, 1),
    '/Volumes/LINKED': dir(12, 1),
    '/Volumes/LINKED/INFO_UF2.TXT': { type: 'link', target: '/Volumes/IMPRINTBOOT/INFO_UF2.TXT' },
    '/Volumes/SWAPPED': dir(13, 1),
    '/Volumes/SWAPPED/INFO_UF2.TXT': { ...file(GOOD_INFO, 13, 2), swappedTo: file(GOOD_INFO, 13, 99) },
    '/Volumes/Gone': dir(14, 1),
  }, { failures: { '/Volumes/Locked/INFO_UF2.TXT': 'EACCES', '/Volumes/Gone': 'ENOENT' } });
  const drives = await discoverDrives({ platform: 'darwin', fs: fsys, run: noRun });
  assert.deepEqual(drives.map((d) => [d.root, d.label]), [['/Volumes/IMPRINTBOOT', 'IMPRINTBOOT']]);
});

test('Linux: scans /media/<user>, /run/media/<user> and /mnt with mountinfo identity', async () => {
  const mountinfo = (id) => [
    '22 1 8:1 / / rw - ext4 /dev/sda1 rw',
    `${id} 22 8:17 / /media/alice/IMPRINT\\040BOOT rw,nosuid - vfat /dev/sdb1 rw`,
    '91 22 8:33 / /run/media/alice/OTHER rw - vfat /dev/sdc1 rw',
    '',
  ].join('\n');
  const nodes = (id) => ({
    '/proc/self/mountinfo': file(mountinfo(id), 0, 0),
    '/media/alice': dir(2, 1),
    '/media/alice/IMPRINT BOOT': dir(8, 1),
    '/media/alice/IMPRINT BOOT/INFO_UF2.TXT': file(GOOD_INFO, 8, 2),
    '/run/media/alice': dir(3, 1),
    '/run/media/alice/OTHER': dir(9, 1),
    '/run/media/alice/OTHER/INFO_UF2.TXT': file(OTHER_INFO, 9, 2),
    '/mnt': dir(4, 1),
    '/mnt/escape': { type: 'link', target: '/media/alice/IMPRINT BOOT' },
  });
  const first = await discoverDrives({ platform: 'linux', user: 'alice', fs: fakeFs(nodes(90)), run: noRun });
  assert.deepEqual(first.map((d) => [d.root, d.label]), [['/media/alice/IMPRINT BOOT', 'IMPRINT BOOT']]);
  assert.match(first[0].fingerprint, /mount:90 8:17 \/dev\/sdb1/);
  const remounted = await discoverDrives({ platform: 'linux', user: 'alice', fs: fakeFs(nodes(95)), run: noRun });
  assert.notEqual(remounted[0].fingerprint, first[0].fingerprint, 'remount changes identity');

  // Missing parents and an unreadable mountinfo do not break the scan.
  const sparse = fakeFs({ '/mnt': dir(4, 1), '/mnt/BOOT': dir(5, 1), '/mnt/BOOT/INFO_UF2.TXT': file(GOOD_INFO, 5, 2) },
    { failures: { '/proc/self/mountinfo': 'EACCES' } });
  const roots = await listCandidateRoots({ platform: 'linux', user: 'alice', fs: sparse, run: noRun });
  assert.deepEqual(roots, [{ root: '/mnt/BOOT', label: 'BOOT', identity: null }]);
  assert.equal((await discoverDrives({ platform: 'linux', user: '../etc', fs: sparse, run: noRun })).length, 1);
});

test('unsupported platforms fail clearly', async () => {
  await assert.rejects(discoverDrives({ platform: 'freebsd', fs: fakeFs({}), run: noRun }), /Unsupported platform.*freebsd/);
});
