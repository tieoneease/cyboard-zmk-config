// Read-only discovery of mounted Assimilator UF2 bootloader drives.
// Never mounts, writes, or follows symlinked roots. Does not infer keyboard side.
import fsPromises from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { INFO_MAX_BYTES, parseInfoUf2 } from './uf2.mjs';

export const INFO_FILE_NAME = 'INFO_UF2.TXT';
export const SUBPROCESS_TIMEOUT_MS = 10_000;
const SUBPROCESS_MAX_BUFFER = 1024 * 1024;
const MOUNTINFO_MAX_BYTES = 1024 * 1024;

/** Fixed PowerShell program; no user or filesystem data is interpolated into it. */
export const WINDOWS_VOLUME_QUERY =
  "ConvertTo-Json -Compress -InputObject @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=2' | " +
  'Select-Object DeviceID,VolumeName,VolumeSerialNumber)';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** execFile wrapper that always disables the shell and bounds runtime and output. */
export function defaultSafeExecFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      encoding: 'utf8',
      windowsHide: true,
      // 0 would mean "no timeout" to execFile, so only a positive value may shorten the cap.
      timeout: options.timeout > 0 ? Math.min(options.timeout, SUBPROCESS_TIMEOUT_MS) : SUBPROCESS_TIMEOUT_MS,
      maxBuffer: SUBPROCESS_MAX_BUFFER,
      shell: false,
    }, (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout, stderr })));
  });
}

/** OS errors (ENOENT, EACCES, EBUSY, EIO...) from a vanished, unready, or inaccessible volume skip that candidate only. */
const isVolumeError = (error) => typeof error?.code === 'string' && !error.code.startsWith('ERR_');

/**
 * Read at most limit + 1 bytes (so callers can detect oversize input). When `expected` is
 * given, the opened handle must be that same dev/ino or null is returned.
 */
async function readBounded(fs, file, limit, expected) {
  const handle = await fs.open(file, 'r');
  try {
    if (expected) {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino) return null;
    }
    const buffer = Buffer.alloc(limit + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return buffer.subarray(0, total);
  } finally {
    await handle.close();
  }
}

async function listChildDirs(fs, parent, p) {
  let entries;
  try {
    entries = await fs.readdir(parent, { withFileTypes: true });
  } catch (error) {
    if (isVolumeError(error)) return [];
    throw error;
  }
  // Symlinked entries are dropped here and rejected again by lstat during inspection.
  return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => p.join(parent, entry.name));
}

function safeUserName(user) {
  return typeof user === 'string' && user !== '' && user !== '.' && user !== '..' && !/[\\/\0]/.test(user) ? user : null;
}

/** Candidate mount roots for the platform, each with optional platform identity. */
export async function listCandidateRoots({ platform = process.platform, fs = fsPromises, run = defaultSafeExecFile, user } = {}) {
  if (platform === 'win32') {
    const systemRoot = /^[A-Za-z]:\\[^"<>|?*]*$/.test(process.env.SystemRoot ?? '') ? process.env.SystemRoot : 'C:\\Windows';
    const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    let stdout;
    try {
      ({ stdout } = await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_VOLUME_QUERY], {
        timeout: SUBPROCESS_TIMEOUT_MS, shell: false, windowsHide: true,
      }));
    } catch (error) {
      throw new Error(`Removable volume query failed: ${error.message}`, { cause: error });
    }
    let disks;
    try {
      disks = JSON.parse(stdout.trim() || '[]');
    } catch (error) {
      throw new Error('Removable volume query returned malformed JSON', { cause: error });
    }
    if (!Array.isArray(disks)) disks = [disks];
    return disks
      .filter((disk) => typeof disk?.DeviceID === 'string' && /^[A-Za-z]:$/.test(disk.DeviceID))
      .map((disk) => ({
        root: `${disk.DeviceID.toUpperCase()}\\`,
        label: typeof disk.VolumeName === 'string' ? disk.VolumeName : '',
        identity: typeof disk.VolumeSerialNumber === 'string' && disk.VolumeSerialNumber !== ''
          ? `volume-serial:${disk.VolumeSerialNumber}` : null,
      }));
  }
  if (platform === 'darwin') {
    return (await listChildDirs(fs, '/Volumes', path.posix)).map((root) => ({ root, label: path.posix.basename(root), identity: null }));
  }
  if (platform === 'linux') {
    const name = safeUserName(user ?? os.userInfo().username);
    const parents = [...(name ? [`/media/${name}`, `/run/media/${name}`] : []), '/mnt'];
    const roots = (await Promise.all(parents.map((parent) => listChildDirs(fs, parent, path.posix)))).flat();
    const mounts = await readLinuxMounts(fs);
    return roots.map((root) => ({ root, label: path.posix.basename(root), identity: mounts.get(root) ?? null }));
  }
  throw new Error(`Unsupported platform for UF2 drive discovery: ${platform}`);
}

/** Map mount point -> "mount-id major:minor source" from /proc/self/mountinfo; changes on remount. */
async function readLinuxMounts(fs) {
  const mounts = new Map();
  let bytes;
  try {
    bytes = await readBounded(fs, '/proc/self/mountinfo', MOUNTINFO_MAX_BYTES);
  } catch (error) {
    if (isVolumeError(error)) return mounts;
    throw error;
  }
  if (bytes.length > MOUNTINFO_MAX_BYTES) return mounts;
  const unescape = (field) => field.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
  for (const line of bytes.toString('utf8').split('\n')) {
    const fields = line.split(' ');
    const separator = fields.indexOf('-');
    if (fields.length < 10 || separator < 6) continue;
    mounts.set(unescape(fields[4]), `mount:${fields[0]} ${fields[2]} ${unescape(fields[separator + 2] ?? '')}`);
  }
  return mounts;
}

async function inspectRoot({ platform, fs, p, candidate }) {
  const root = p.resolve(candidate.root);
  const rootStat = await fs.lstat(root, { bigint: true });
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;
  const canonical = await fs.realpath(root);
  const same = platform === 'win32' ? canonical.toLowerCase() === root.toLowerCase() : canonical === root;
  if (!same) return null; // A symlinked or redirected path component.

  const infoPath = p.join(canonical, INFO_FILE_NAME);
  const infoStat = await fs.lstat(infoPath, { bigint: true });
  if (infoStat.isSymbolicLink() || !infoStat.isFile() || infoStat.size > BigInt(INFO_MAX_BYTES)) return null;
  // The opened handle must be the regular file lstat saw, not a link swapped in between.
  const bytes = await readBounded(fs, infoPath, INFO_MAX_BYTES, infoStat);
  if (!bytes || bytes.length > INFO_MAX_BYTES) return null;

  let info;
  try {
    info = parseInfoUf2(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (!info.compatible) return null;

  const fingerprint = JSON.stringify({
    v: 1,
    platform,
    root: canonical,
    identity: candidate.identity ?? null,
    rootStat: `${rootStat.dev}:${rootStat.ino}`,
    infoStat: `${infoStat.dev}:${infoStat.ino}`,
    info: sha256(bytes),
  });
  return {
    id: sha256(fingerprint).slice(0, 32),
    root: canonical,
    label: candidate.label ?? '',
    boardId: info.boardId,
    model: info.model,
    bootloaderVersion: info.version,
    fingerprint,
  };
}

/**
 * Discover mounted, strictly compatible Assimilator UF2 bootloader drives. Read-only.
 * `roots` (absolute paths) replaces platform enumeration, for tests and simulation.
 */
export async function discoverDrives({ platform = process.platform, fs = fsPromises, run = defaultSafeExecFile, roots, user } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  let candidates;
  if (roots !== undefined) {
    if (!Array.isArray(roots)) throw new TypeError('roots must be an array of absolute paths');
    candidates = roots.map((root) => {
      if (typeof root !== 'string' || !p.isAbsolute(root)) throw new TypeError(`root must be an absolute path: ${root}`);
      return { root, label: p.basename(root), identity: null };
    });
  } else {
    candidates = await listCandidateRoots({ platform, fs, run, user });
  }

  const found = new Map();
  for (const candidate of candidates) {
    try {
      const drive = await inspectRoot({ platform, fs, p, candidate });
      if (drive && !found.has(drive.root)) found.set(drive.root, drive);
    } catch (error) {
      if (!isVolumeError(error)) throw error; // Vanished, unready or permission-denied: skip it.
    }
  }
  return [...found.values()].sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
}
