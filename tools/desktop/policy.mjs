export const DESKTOP_RUNTIME = '1.4.0'; // Electrobun 2.0.2 devkit's bundled Bun.

export function desktopOptions(args) {
  const allowed = new Set(['--demo', '--smoke']);
  if (args.some(arg => !allowed.has(arg))) throw new Error('Unknown desktop option. Only --demo and --smoke are supported.');
  const smoke = args.includes('--smoke');
  return { smoke, demo: smoke || args.includes('--demo') };
}

export function canOpenExternal(value, origin, repository) {
  if (typeof value !== 'string' || value.length > 1200) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.origin === origin && url.pathname === '/guide') return true;
  if (url.protocol !== 'https:' || url.port) return false;
  if (url.hostname === 'nickcoutsos.github.io') return url.pathname === '/keymap-editor/';
  if (url.hostname !== 'github.com') return false;
  const prefix = `/${repository}`;
  return url.pathname === prefix || url.pathname === '/settings/personal-access-tokens/new'
    || (url.pathname.startsWith(`${prefix}/actions/runs/`) && /^[1-9][0-9]*$/.test(url.pathname.slice(`${prefix}/actions/runs/`.length)));
}

export function navigationRules(origin) {
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) throw new Error('Expected the local workbench origin.');
  // Electrobun's default for an unmatched URL is allow; the explicit deny-all is essential.
  return JSON.stringify(['^*', `${origin}/`, `${origin}/#*`]);
}

export function credentialStore(repository, secrets = globalThis.Bun?.secrets, platform = process.platform) {
  // Bun 1.4.0 ignores `persist` and writes CRED_PERSIST_ENTERPRISE on Windows.
  // Do not create a roamable token or load one from an earlier build. Windows
  // stays session-only until a tested local-computer-only adapter is available.
  if (platform === 'win32' || !['darwin', 'linux'].includes(platform)) return null;
  if (!secrets || !['get', 'set', 'delete'].every(key => typeof secrets[key] === 'function')) return null;
  const key = { service: 'io.github.tieoneease.imprint-workbench', name: `github.com:${repository}` };
  return {
    get: () => secrets.get(key),
    set: value => secrets.set({ ...key, value, allowUnrestrictedAccess: false }),
    delete: () => secrets.delete(key),
  };
}
