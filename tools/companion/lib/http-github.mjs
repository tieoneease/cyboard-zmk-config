// Built-in GitHub REST transport: no gh CLI, no Node-only APIs beyond fetch/Buffer.
// Provenance selection and archive verification stay in the inherited Github.check()/download().
//
// Sources (GitHub docs, checked 2026-10):
// - API versions: 2022-11-28 and 2026-03-10 are supported; a superseded version stays supported for
//   at least 24 months. 2022-11-28 is pinned because the inherited response checks were written and
//   replayed against its shapes; 2026-03-10 changes the dispatch response (204 -> 200 with run details).
//   https://docs.github.com/en/rest/about-the-rest-api/api-versions
// - Download an artifact: 302 with a Location that expires after 1 minute; 410 when gone.
//   https://docs.github.com/en/rest/actions/artifacts
// - Workflow artifacts are served from results-receiver.actions.githubusercontent.com and
//   *.blob.core.windows.net. https://docs.github.com/en/actions/reference/runners/github-hosted-runners
// - Create a workflow dispatch event: POST .../actions/workflows/{file}/dispatches {ref}; 204 (200 with
//   run details on newer versions). https://docs.github.com/en/rest/actions/workflows
import { Github } from './github.mjs';

export const API_ORIGIN = 'https://api.github.com';
export const API_VERSION = '2022-11-28';
export const USER_AGENT = 'cyboard-imprint-workbench';
export const JSON_LIMIT = 2 * 1024 * 1024;
export const ARCHIVE_LIMIT = 16 * 1024 * 1024;
export const MAX_ARCHIVE_REDIRECTS = 3;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const TOKEN = /^[\x21-\x7E]{1,512}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;
const PATH = /^[A-Za-z0-9._~!()\-/%]+(?:\?[A-Za-z0-9._~!()\-%&=]*)?$/;
const ARTIFACT_HOST = /^(?:[a-z0-9-]+\.)+(?:actions\.githubusercontent\.com|blob\.core\.windows\.net)$/;

/** Candidate token syntax: 1-512 visible ASCII characters, no whitespace. */
export const isTokenSyntax = (token) => typeof token === 'string' && TOKEN.test(token);

/** Error whose message is authored here and safe to show; never carries bodies, headers, tokens or URLs. */
export class GithubError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = 'GithubError';
    this.code = code;
    this.status = status;
    this.expose = true;
  }
}

export function isArtifactUrl(url) {
  return url.protocol === 'https:' && !url.username && !url.password && url.port === '' && ARTIFACT_HOST.test(url.hostname);
}

function statusError(status, headers, { context, authenticated }) {
  const code = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
  const limited = code === 429 || (code === 403 && (headers?.get('x-ratelimit-remaining') === '0' || headers?.get('retry-after') != null));
  if (limited) return new GithubError('rate_limited', `GitHub rate limit reached (HTTP ${code}). Try again later.`, code);
  if (code === 401) {
    return new GithubError('unauthorized', authenticated
      ? (context === 'validate' ? 'GitHub rejected this token (HTTP 401).' : 'GitHub rejected the connected token (HTTP 401). Reconnect GitHub with a valid token.')
      : 'GitHub requires a connected token for this request (HTTP 401).', code);
  }
  if (code === 403) {
    return new GithubError('forbidden', context === 'dispatch'
      ? 'GitHub refused Rebuild (HTTP 403). The token needs Actions write permission on this repository.'
      : 'GitHub refused access (HTTP 403). The token needs Actions read access to this repository.', code);
  }
  if (code === 404) {
    return new GithubError('not_found', authenticated
      ? 'GitHub could not find the repository, branch, workflow, or artifact, or the token cannot access it (HTTP 404).'
      : 'GitHub could not find the repository, branch, or workflow (HTTP 404). Private repositories need a connected token.', code);
  }
  if (code === 410) return new GithubError('gone', 'The firmware artifact has expired or was removed (HTTP 410). Rebuild this commit.', code);
  if (code === 422 && context === 'dispatch') return new GithubError('rejected', 'GitHub rejected Rebuild (HTTP 422). Check that the workflow allows workflow_dispatch on the configured branch.', code);
  if (code >= 500) return new GithubError('server', `GitHub is having trouble (HTTP ${code}). Try again later.`, code);
  return new GithubError('http', `GitHub request failed (HTTP ${code || 'invalid status'}).`, code || null);
}

function discard(response) {
  try { response?.body?.cancel?.()?.catch?.(() => {}); } catch { /* already consumed or locked */ }
}

/** Reads at most `limit` bytes, cancelling the stream as soon as the limit or deadline is crossed. */
async function readBounded(response, limit, race, what) {
  const declared = response.headers?.get('content-length');
  if (declared != null && /^\d+$/.test(declared) && Number(declared) > limit) {
    discard(response);
    throw new GithubError('too_large', `GitHub ${what} exceeds the ${limit / 1048576} MiB limit.`);
  }
  if (!response.body) return Buffer.alloc(0);
  let reader;
  try { reader = response.body.getReader(); } catch { throw new GithubError('bad_response', `GitHub ${what} could not be read.`); }
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await race(reader.read());
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new GithubError('bad_response', `GitHub ${what} could not be read.`);
      total += value.byteLength;
      if (total > limit) throw new GithubError('too_large', `GitHub ${what} exceeds the ${limit / 1048576} MiB limit.`);
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } catch (error) {
    try { reader.cancel().catch(() => {}); } catch { /* ignore */ }
    if (error instanceof GithubError) throw error;
    throw new GithubError('network', `The connection to GitHub was interrupted while reading the ${what}.`);
  }
  return Buffer.concat(chunks, total);
}

export class HttpGithub extends Github {
  #getToken; #fetch; #timeoutMs;

  constructor(config, { getToken = () => null, fetchImpl = globalThis.fetch, timeoutMs = 45000 } = {}) {
    super(config, () => { throw new GithubError('internal', 'The gh CLI is not used by the built-in GitHub client.'); });
    const [owner, repo] = this.config.repository.split('/');
    if (['.', '..'].includes(owner) || ['.', '..'].includes(repo)) throw new Error('Invalid configured repository.');
    if (typeof getToken !== 'function' || typeof fetchImpl !== 'function') throw new TypeError('HttpGithub needs getToken and fetch functions.');
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) throw new TypeError('timeoutMs must be an integer between 1 and 120000.');
    this.#getToken = getToken;
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
  }

  #token(required) {
    let token;
    try { token = this.#getToken(); } catch { throw new GithubError('auth_unavailable', 'The connected GitHub token could not be read. Reconnect GitHub.'); }
    if (token == null || token === '') {
      if (required) throw new GithubError('auth_required', 'Connect GitHub with a token first. Downloads need Actions read; Rebuild needs Actions write.');
      return null;
    }
    if (!isTokenSyntax(token)) throw new GithubError('auth_invalid', 'The connected GitHub token is malformed. Reconnect GitHub.');
    return token;
  }

  #url(path) {
    const { repository } = this.config;
    const ok = typeof path === 'string' && path.length <= 1024 && PATH.test(path) && !path.includes('//')
      && !/%(?![0-9A-Fa-f]{2})/.test(path) && !/%2e/i.test(path) && !/(?:^|\/)\.{1,2}(?:\/|\?|$)/.test(path)
      && (path === 'user' || path.startsWith(`repos/${repository}/`));
    const url = ok ? new URL(path, `${API_ORIGIN}/`) : null;
    if (!url || url.href !== `${API_ORIGIN}/${path}`) throw new GithubError('unsafe_path', 'Refused an unexpected GitHub API path.');
    return url.href;
  }

  #headers(token, extra = {}) {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': API_VERSION, 'User-Agent': USER_AGENT, ...extra };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  /** Runs one logical request (all hops and the body) under a single deadline. */
  async #within(operation, { timeoutMessage }) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { reject(new GithubError('timeout', timeoutMessage)); controller.abort(); }, this.#timeoutMs);
    });
    deadline.catch(() => {});
    const race = (promise) => Promise.race([promise, deadline]);
    try { return await operation({ race, signal: controller.signal }); }
    finally { clearTimeout(timer); }
  }

  async #send(url, init, { race, signal }, networkMessage) {
    let response;
    try { response = await race(this.#fetch(url, { ...init, redirect: 'manual', signal })); }
    catch (error) {
      if (error instanceof GithubError) throw error;
      throw new GithubError('network', networkMessage);
    }
    if (!response || typeof response.status !== 'number' || !response.headers || typeof response.headers.get !== 'function') {
      discard(response);
      throw new GithubError('bad_response', 'GitHub returned an unreadable response.');
    }
    return response;
  }

  async #json(path, token, context) {
    const url = this.#url(path);
    return this.#within(async (scope) => {
      const response = await this.#send(url, { method: 'GET', headers: this.#headers(token) }, scope, 'Could not reach GitHub. Check the network connection and try again.');
      if (REDIRECTS.has(response.status)) { discard(response); throw new GithubError('redirect', 'GitHub redirected an API request unexpectedly. Check the configured repository.', response.status); }
      if (response.status !== 200) { discard(response); throw statusError(response.status, response.headers, { context, authenticated: Boolean(token) }); }
      if (!/\bjson\b/i.test(response.headers.get('content-type') || '')) { discard(response); throw new GithubError('bad_response', 'GitHub returned a non-JSON response.'); }
      const bytes = await readBounded(response, JSON_LIMIT, scope.race, 'response');
      let value;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { throw new GithubError('bad_response', 'GitHub returned an unreadable JSON response.'); }
      if (value === null || typeof value !== 'object') throw new GithubError('bad_response', 'GitHub returned an empty or invalid JSON response.');
      return value;
    }, { timeoutMessage: 'GitHub did not respond in time. Try again.' });
  }

  async #archive(path, token) {
    const { repository } = this.config;
    const prefix = `repos/${repository}/actions/artifacts/`;
    if (typeof path !== 'string' || !path.startsWith(prefix) || !/^[1-9][0-9]{0,18}\/zip$/.test(path.slice(prefix.length))) {
      throw new GithubError('unsafe_path', 'Refused an unexpected GitHub artifact path.');
    }
    const first = this.#url(path);
    return this.#within(async (scope) => {
      const failed = 'Could not download the firmware artifact. Check the network connection and try again.';
      let response = await this.#send(first, { method: 'GET', headers: this.#headers(token) }, scope, failed);
      let onApi = true;
      for (let hops = 0; REDIRECTS.has(response.status); hops++) {
        const location = response.headers.get('location');
        discard(response);
        if (hops >= MAX_ARCHIVE_REDIRECTS) throw new GithubError('redirect', 'The artifact download redirected too many times.');
        let next;
        try { next = new URL(location, onApi ? first : undefined); } catch { next = null; }
        if (!location || !next || !isArtifactUrl(next)) throw new GithubError('redirect', 'GitHub sent the artifact download to an unexpected location. Nothing was downloaded.');
        // Presigned storage URL: no Authorization, no GitHub headers, and never echoed in errors.
        response = await this.#send(next.href, { method: 'GET', headers: { 'User-Agent': USER_AGENT } }, scope, failed);
        onApi = false;
      }
      if (response.status !== 200) {
        discard(response);
        if (onApi) throw statusError(response.status, response.headers, { context: 'artifact', authenticated: true });
        throw new GithubError('download_refused', `Artifact storage refused the download (HTTP ${Number.isInteger(response.status) ? response.status : 'invalid'}). The link may have expired; try again.`, response.status);
      }
      return readBounded(response, ARCHIVE_LIMIT, scope.race, 'artifact archive');
    }, { timeoutMessage: 'The firmware artifact download did not finish in time. Try again.' });
  }

  async api(path, binary = false) {
    if (binary) return this.#archive(path, this.#token(true));
    return this.#json(path, this.#token(false), 'read');
  }

  async download(current) {
    this.#token(true);
    return super.download(current);
  }

  /** Requests one workflow_dispatch of the configured workflow on the configured branch. Never retried. */
  async rebuild() {
    const token = this.#token(true);
    const { repository, branch, workflow } = this.config;
    const url = this.#url(`repos/${repository}/actions/workflows/${workflow}/dispatches`);
    const unknown = 'The Rebuild request did not complete, so GitHub may or may not have started a build. Check the run list before trying again.';
    await this.#within(async (scope) => {
      const response = await this.#send(url, {
        method: 'POST', headers: this.#headers(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ ref: branch }),
      }, scope, unknown);
      discard(response);
      if (response.status === 204 || response.status === 200) return;
      if (REDIRECTS.has(response.status)) throw new GithubError('redirect', 'GitHub redirected the Rebuild request; it was not followed. Check the configured repository.', response.status);
      throw statusError(response.status, response.headers, { context: 'dispatch', authenticated: true });
    }, { timeoutMessage: unknown });
  }

  /**
   * Checks a candidate token without using or changing the current session: it must authenticate
   * (GET /user) and read this repository's workflow runs. Actions write cannot be checked without
   * dispatching, so Rebuild may still fail with 403.
   */
  async validateToken(token) {
    if (!isTokenSyntax(token)) throw new GithubError('invalid_token', 'Enter a GitHub token: up to 512 visible ASCII characters, no spaces.');
    const user = await this.#json('user', token, 'validate');
    if (Array.isArray(user) || typeof user.login !== 'string' || !LOGIN.test(user.login)) throw new GithubError('bad_response', 'GitHub returned an invalid user response.');
    const { repository, branch, workflow } = this.config;
    const runs = await this.#json(`repos/${repository}/actions/workflows/${workflow}/runs?branch=${encodeURIComponent(branch)}&per_page=1`, token, 'validate');
    if (!Array.isArray(runs.workflow_runs)) throw new GithubError('bad_response', 'GitHub returned an invalid workflow-runs response.');
    return { login: user.login };
  }
}
