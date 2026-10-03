const $ = id => document.getElementById(id);
const escapeHtml = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let state;
let token;
let selected = 'left';
let requesting = false;
let pollPending = false;
let lastHeartbeat = 0;
let connectionError = '';
let pollError = '';
let observedDrives;
let observedAuth;
let observedWrites;
let authError = '';
let authNotice = '';
const TOKEN_SYNTAX = /^[\x21-\x7E]{1,512}$/;
function resetConfirmation() {
  $('confirm').checked = false;
  $('replace').checked = false;
  $('write-confirm').checked = false;
}
// Polling must not replace unchanged text, selections, or live-region contents.
const renderedHtml = new Map();
const text = (id, value) => {
  const next = String(value ?? '');
  if ($(id).textContent !== next) $(id).textContent = next;
};
const html = (id, value) => {
  if (renderedHtml.get(id) !== value) { $(id).innerHTML = value; renderedHtml.set(id, value); }
};
const size = bytes => `${(bytes / 1024).toFixed(1)} KiB`;
const clock = value => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function render(s) {
  if (!s) return;
  state = s;
  const driveSignature = JSON.stringify(s.drives.map(d => [d.id, d.root]).sort());
  if (driveSignature !== observedDrives) { resetConfirmation(); observedDrives = driveSignature; }
  const auth = s.auth ?? null;
  const authSignature = auth ? JSON.stringify([auth.hasToken, auth.login, auth.remembered]) : 'none';
  if (authSignature !== observedAuth) {
    resetConfirmation();
    // Open the access disclosure when signed out; collapse it once a token is in use.
    if (auth) $('github-access').open = !auth.hasToken;
    observedAuth = authSignature;
  }
  if (s.allowFlash !== observedWrites) { resetConfirmation(); observedWrites = s.allowFlash; }
  const busy = !!s.busy || requesting;
  const active = busy || !!s.armed;
  const needsToken = !!auth && !auth.hasToken;
  text('mode', s.demo ? 'Simulation · no hardware' : s.allowFlash ? 'Hardware writes enabled' : 'Read-only hardware');
  $('mode').classList.toggle('write', !s.demo && s.allowFlash);
  $('demo-notice').hidden = !s.demo;
  $('demo-controls').hidden = !s.demo;
  $('repo-link').href = `https://github.com/${s.config.repository}`;
  text('repo-link', s.config.repository);
  text('branch', s.config.branch);
  const error = pollError || connectionError || s.error;
  // An auth failure is shown beside the token field instead of twice.
  const globalError = error && error !== authError ? error : '';
  text('error', globalError); $('error').hidden = !globalError;
  text('companion-kind', s.desktop ? 'Desktop companion' : 'Local companion');
  renderAccess(auth, active);
  const current = s.current;
  const run = current?.run;
  const good = run?.status === 'completed' && run.conclusion === 'success';
  const status = !current ? 'Checking your branch…' : !run ? 'No build for the current commit' : good ? 'Current commit built successfully' : run.status !== 'completed' ? `Build ${run.status.replaceAll('_', ' ')}` : `Build ${run.conclusion || 'not successful'}`;
  text('build-status', status);
  text('commit-message', current?.message || 'Use Check now to connect to GitHub.');
  $('build-dot').className = `status-dot ${good ? 'ready' : run?.status === 'completed' ? 'bad' : ''}`;
  text('sha', current?.sha || '—');
  text('checked-at', current ? `Checked ${clock(current.checkedAt)}` : '');
  $('run-link').hidden = !run?.url;
  if (run?.url) $('run-link').href = run.url;
  $('check').disabled = active; $('rebuild').disabled = active || needsToken;
  $('prepare').disabled = active || !good || needsToken;
  $('access-required').hidden = !needsToken;
  text('prepare', s.prepared ? 'Recheck & download build' : 'Download & verify firmware');
  $('firmware').hidden = !s.prepared;
  if (s.prepared) {
    html('firmware', '<div class="firmware-title">Both halves verified · ' + escapeHtml(s.prepared.sha.slice(0, 7)) + '</div>' + ['left', 'right'].map(side => {
      const f = s.prepared.files[side];
      return `<div class="firmware-file"><strong>${escapeHtml(f.filename)}</strong><span class="small">${size(f.bytes)} · application-only address range</span><div class="hash mono">SHA-256 ${escapeHtml(f.sha256)}</div></div>`;
    }).join(''));
  }
  for (const side of ['left', 'right']) {
    $(`half-${side}`).setAttribute('aria-pressed', String(selected === side));
    $(`half-${side}`).disabled = active;
    text(`${side}-backup`, s.readbacks[side] ? 'Partial backup saved' : 'No backup captured');
  }
  text('selected-label', selected);
  text('capture', `${s.readbacks[selected] ? 'Replace' : 'Capture'} ${selected} backup`);
  text('arm', s.armed ? `Armed for ${s.armed.side}` : `Arm ${selected} install`);
  $('confirm').disabled = active;
  const one = s.drives.length === 1;
  text('device-status', one ? 'Compatible bootloader detected' : s.drives.length ? 'More than one bootloader detected' : 'Waiting for bootloader mode');
  text('device-detail', one ? `${s.drives[0].model} · ${s.drives[0].root}` : s.drives.length ? 'Leave only one half in bootloader mode.' : 'Normal keyboard mode is not a flash target.');
  $('device-dot').className = `status-dot ${one ? 'ready' : s.drives.length ? 'bad' : ''}`;
  const confirmed = $('confirm').checked;
  const both = s.readbacks.left && s.readbacks.right;
  const replacing = !!s.readbacks[selected];
  $('replace-control').hidden = !replacing;
  text('replace-label', selected);
  $('replace').disabled = active;
  $('capture').disabled = active || !one || !confirmed || (replacing && !$('replace').checked);
  const latestPrepared = good && s.prepared?.runId === run.id && s.prepared?.runAttempt === run.attempt;
  $('arm').disabled = active || !s.allowFlash || !latestPrepared || !both || !confirmed;
  $('cancel').hidden = !s.armed;
  $('cancel').disabled = s.busy === 'Writing firmware';
  const modeControls = !!s.canChangeWriteMode && !s.demo;
  $('write-mode').hidden = !modeControls;
  if (modeControls) {
    text('write-mode-status', s.allowFlash ? 'Hardware writes on for this session' : 'Read-only hardware');
    $('write-mode-status').classList.toggle('write', s.allowFlash);
    text('write-mode-detail', s.allowFlash ? 'Each install still needs both backups, a verified build, a fresh physical-half confirmation, and arming. Return to read-only when finished.' : 'Backups can be captured now. Installing needs hardware writes for this session.');
    $('write-enable-control').hidden = s.allowFlash; $('write-enable').hidden = s.allowFlash; $('write-disable').hidden = !s.allowFlash;
    $('write-confirm').disabled = active;
    $('write-enable').disabled = active || !$('write-confirm').checked;
    $('write-disable').disabled = active;
  }
  const writesOff = modeControls ? 'Hardware writes are off. Enable them above for this session when ready.' : s.desktop ? 'Hardware writes are off for this session.' : 'Hardware writes are disabled. When ready, restart with npm run companion:flash.';
  let reason = !s.allowFlash ? writesOff : !latestPrepared ? 'Download and verify the latest successful build first.' : !both ? 'Capture a partial backup of both physical halves first.' : !confirmed ? 'Confirm the selected physical half and backup limitation above.' : 'Ready to arm one installation. No files are written until the matching bootloader is detected.';
  if (s.armed) reason = `Waiting to install ${s.armed.sha.slice(0, 7)} on ${s.armed.side}. Keep this page open; arming expires at ${clock(s.armed.expiresAt)}.`;
  if (s.busy === 'Writing firmware') reason = 'Writing firmware. Do not unplug or close the app.';
  text('install-reason', reason);
  $('result').hidden = !s.result;
  if (s.result) html('result', `<strong>${escapeHtml(s.result.side.toUpperCase())} · ${escapeHtml(s.result.sha.slice(0, 7))} · ${escapeHtml(s.result.status.replaceAll('-', ' '))}</strong><p>${escapeHtml(s.result.message)}</p>`);
  $('result').classList.toggle('uncertain', s.result?.status === 'unverified');
  text('busy', s.busy || (s.armed ? 'Waiting for the selected half' : 'Ready'));
  html('activity', s.activity.length ? s.activity.slice(0, 8).map(e => `<li><time>${escapeHtml(clock(e.at))}</time><span>${escapeHtml(e.message)}</span></li>`).join('') : '<li>No operations yet. Nothing flashes automatically on launch.</li>');
  text('cache-note', 'Readbacks stay private, outside the repository.');
  for (const button of document.querySelectorAll('[data-demo]')) button.disabled = busy;
}
function renderAccess(auth, active) {
  $('github-access').hidden = !auth;
  $('access-storage').hidden = !auth?.storageError;
  $('access-note').hidden = !auth || !authNotice;
  if (!auth) return;
  text('access-repo', state.config.repository);
  text('access-status', !auth.hasToken ? 'Not connected \u00b7 public checks only' : auth.login ? `Connected as ${auth.login}` : 'Saved token loaded \u00b7 not verified yet');
  $('access-signed-out').hidden = auth.hasToken;
  $('access-signed-in').hidden = !auth.hasToken;
  const where = auth.remembered ? 'Saved in the system credential store and loaded at launch. Disconnect removes it.' : 'Kept in memory for this session only; forgotten when the app quits.';
  text('access-session', !auth.hasToken ? '' : auth.login ? `GitHub accepted this token for ${auth.login}. ${where} Rebuild also needs Actions write permission, which GitHub checks only when you use it.` : `A saved token was loaded but has not been checked with GitHub yet. ${where}`);
  $('access-verify').hidden = !auth.hasToken || !!auth.login;
  $('access-verify').disabled = active; $('access-disconnect').disabled = active;
  $('access-connect').disabled = active;
  $('remember').disabled = active || !auth.canRemember;
  if (!auth.canRemember) $('remember').checked = false;
  text('remember-label', auth.canRemember ? 'Remember in the system credential store' : 'Remember unavailable in this build. This session only.');
  text('access-error', authError); $('access-error').hidden = !authError;
  text('access-note', authNotice);
  text('access-storage', auth.storageError || '');
}
async function post(action, data = {}, background = false) {
  if (!state || !token) return false;
  let ok = false;
  if (!background) { requesting = true; render(state); }
  try {
    const response = await fetch(`/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': token }, body: JSON.stringify(data) });
    const result = await response.json();
    if (!response.ok) {
      if (result.state) state = result.state;
      throw new Error(result.error || 'Operation failed.');
    }
    connectionError = '';
    state = result;
    ok = true;
  } catch (error) { connectionError = error.message; }
  finally { if (!background) requesting = false; if (state) render(state); }
  return ok;
}
// Auth requests: confirmations are reset first; failures are shown beside the token field.
async function authPost(action, data, focusAfter) {
  resetConfirmation();
  authError = ''; authNotice = '';
  const ok = await post(action, data);
  if (ok) authNotice = action === 'auth-disconnect' ? '' : 'Use Check now to refresh the build status with this token.';
  else { authError = connectionError; $('github-access').open = true; }
  render(state);
  focusAfter(ok)?.focus();
}
for (const side of ['left', 'right']) $(`half-${side}`).addEventListener('click', () => {
  selected = side; resetConfirmation(); render(state);
});
$('confirm').addEventListener('change', () => render(state));
$('replace').addEventListener('change', () => render(state));
$('check').addEventListener('click', () => { authNotice = ''; post('check'); });
$('access-form').addEventListener('submit', event => {
  event.preventDefault();
  const input = $('token-input');
  // The token leaves the DOM before any await; only the request body carries it.
  const candidate = input.value.trim();
  input.value = '';
  const remember = $('remember').checked && !$('remember').disabled;
  $('remember').checked = false;
  if (!TOKEN_SYNTAX.test(candidate)) {
    authError = candidate ? 'That is not a GitHub token: paste up to 512 visible characters with no spaces.' : 'Paste a fine-grained token first.';
    render(state); input.focus();
    return;
  }
  authPost('auth-connect', { token: candidate, remember }, ok => ok ? $('github-access').querySelector('summary') : input);
});
$('token-input').addEventListener('input', () => { if (authError) { authError = ''; render(state); } });
$('access-verify').addEventListener('click', () => authPost('auth-verify', {}, ok => ok ? $('access-disconnect') : $('access-verify')));
$('access-disconnect').addEventListener('click', () => authPost('auth-disconnect', {}, ok => ok ? $('token-input') : $('access-disconnect')));
$('write-confirm').addEventListener('change', () => render(state));
$('write-enable').addEventListener('click', async () => {
  const data = { enabled: true, confirmed: $('write-confirm').checked };
  resetConfirmation();
  const ok = await post('write-mode', data);
  (ok ? $('write-disable') : $('write-confirm')).focus();
});
$('write-disable').addEventListener('click', async () => {
  resetConfirmation();
  const ok = await post('write-mode', { enabled: false, confirmed: true });
  (ok ? $('write-confirm') : $('write-disable')).focus();
});
$('rebuild').addEventListener('click', () => post('rebuild'));
$('prepare').addEventListener('click', () => post('prepare'));
$('capture').addEventListener('click', () => {
  const data = { side: selected, driveId: state.drives[0]?.id, confirmed: $('confirm').checked, replace: $('replace').checked };
  resetConfirmation(); post('capture', data);
});
$('arm').addEventListener('click', () => {
  const data = { side: selected, confirmed: $('confirm').checked };
  resetConfirmation(); post('arm', data);
});
$('cancel').addEventListener('click', () => post('cancel'));
for (const button of document.querySelectorAll('[data-demo]')) button.addEventListener('click', () => {
  resetConfirmation(); post('demo-connect', { side: button.dataset.demo });
});
// A desktop webview never navigates to external content or receives a native RPC bridge.
// The main process validates this URL again before opening the default browser.
document.addEventListener('click', event => {
  const link = event.target.closest('a[href]');
  if (!state?.desktop || !link) return;
  event.preventDefault();
  post('open-link', { url: link.href }, true);
});
async function poll() {
  if (pollPending) return;
  pollPending = true;
  try {
    const response = await fetch('/api/status');
    if (!response.ok) throw new Error('The local companion is unavailable. Reload after restarting it.');
    pollError = '';
    render(await response.json());
    if (state.armed && Date.now() - lastHeartbeat > 4000) {
      lastHeartbeat = Date.now();
      await post('heartbeat', { id: state.armed.id }, true);
    }
  } catch (error) { pollError = error.message; if (state) render(state); }
  finally { pollPending = false; }
}
try {
  const response = await fetch('/api/session');
  if (!response.ok) throw new Error('Unable to initialize the local session.');
  const session = await response.json(); token = session.csrf; render(session.state);
  setInterval(poll, 1200);
  // An event-only native readiness marker carries no credential or command authority.
  if (state.desktop && typeof window.__electrobunSendToHost === 'function') window.__electrobunSendToHost({ type: 'imprint-workbench-ready' });
} catch (error) { text('error', error.message); $('error').hidden = false; }
