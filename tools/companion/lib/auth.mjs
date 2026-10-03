// In-memory GitHub token session with an optional OS credential store owned by the caller.
// The token is reachable only through getToken(); state(), toJSON(), inspection and errors never carry it.
// Store contract: async get() -> string|null, async set(token), async delete(); one record owned by this app.
import { isTokenSyntax } from './http-github.mjs';

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;
const SAFE_CODE = /^[a-z_]{1,32}$/;

export class AuthError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
    this.expose = true;
  }
}

const MESSAGES = {
  busy: 'Another GitHub sign-in change is in progress. Wait for it to finish.',
  invalidToken: 'Enter a GitHub token: up to 512 visible ASCII characters, no spaces.',
  invalidRemember: 'Choose whether to remember the token with true or false.',
  noStore: 'Secure credential storage is unavailable on this system. Connect for this session only.',
  readFailed: 'The system credential store could not be read. Connect for this session only, or try again later.',
  malformed: 'The saved GitHub credential is malformed and was ignored. Connect again to replace it.',
  saveFailed: 'The token could not be saved to the system credential store, so the connection was not changed. Connect for this session only, or try again.',
  removeBlocked: 'A saved GitHub credential could not be removed from the system credential store, so the connection was not changed. Try again, or disconnect.',
  removeUnconfirmed: 'Connected for this session, but could not confirm that no saved GitHub credential remains in the system credential store.',
  disconnectRemains: 'Disconnected for this session, but the saved GitHub credential could not be removed from the system credential store and may remain.',
  validateFailed: 'Could not validate the GitHub token.',
  badLogin: 'GitHub returned an invalid account name.',
  noToken: 'No GitHub token is connected.',
};

/** Rebuilds a validator error from authored fields only; anything unrecognized becomes a generic message. */
function sanitize(error, token) {
  const message = error?.message;
  if (error?.expose === true && typeof message === 'string' && message.length > 0 && message.length <= 300 && !message.includes(token)) {
    const code = typeof error.code === 'string' && SAFE_CODE.test(error.code) ? error.code : 'validation_failed';
    return new AuthError(code, message, Number.isInteger(error.status) ? error.status : null);
  }
  return new AuthError('validation_failed', MESSAGES.validateFailed);
}

export class AuthSession {
  #store; #validate;
  #token = null; #login = null; #remembered = false; #storageError = null;
  #stored; // whether this app's record may exist: true | false | 'unknown'
  #busy = false; #settled = false;

  constructor({ store = null, validate } = {}) {
    if (typeof validate !== 'function') throw new TypeError('AuthSession needs a validate(token) function.');
    if (store !== null && !['get', 'set', 'delete'].every((name) => typeof store?.[name] === 'function')) {
      throw new TypeError('The credential store needs get(), set() and delete().');
    }
    this.#store = store;
    this.#validate = validate;
    this.#stored = store ? 'unknown' : false;
  }

  /** Token for the GitHub transport only. Never put it in UI state, logs, or errors. */
  getToken() { return this.#token; }

  state() {
    return { hasToken: this.#token !== null, login: this.#login, remembered: this.#remembered, canRemember: this.#store !== null, storageError: this.#storageError };
  }

  toJSON() { return this.state(); }
  [Symbol.for('nodejs.util.inspect.custom')]() { return `AuthSession ${JSON.stringify(this.state())}`; }

  async #exclusive(operation) {
    if (this.#busy) throw new AuthError('busy', MESSAGES.busy);
    this.#busy = true;
    try { return await operation(); } finally { this.#busy = false; }
  }

  async #check(candidate) {
    let result;
    try { result = await this.#validate(candidate); } catch (error) { throw sanitize(error, candidate); }
    const login = result?.login;
    if (typeof login !== 'string' || !LOGIN.test(login)) throw new AuthError('bad_response', MESSAGES.badLogin);
    return login;
  }

  /** Loads this app's saved credential, if any. The login stays null until verify() or connect() validates it. */
  async init() {
    return this.#exclusive(async () => {
      if (this.#settled || !this.#store) { this.#settled = true; return this.state(); }
      this.#settled = true;
      let saved;
      try { saved = await this.#store.get(); } catch {
        this.#storageError = MESSAGES.readFailed;
        return this.state();
      }
      if (saved == null) { this.#stored = false; return this.state(); }
      this.#stored = true;
      if (!isTokenSyntax(saved)) { this.#storageError = MESSAGES.malformed; return this.state(); }
      this.#token = saved;
      this.#login = null;
      this.#remembered = true;
      this.#storageError = null;
      return this.state();
    });
  }

  /** Validates the current token and records its login. A failure keeps the token; only a 401 clears the login. */
  async verify() {
    return this.#exclusive(async () => {
      const token = this.#token;
      if (token === null) throw new AuthError('no_token', MESSAGES.noToken);
      try { this.#login = await this.#check(token); } catch (error) {
        if (error.code === 'unauthorized') this.#login = null;
        throw error;
      }
      return this.state();
    });
  }

  /** Validates a candidate, then stores it (remember === true) or removes any saved record, then switches. */
  async connect(request) {
    const { token, remember } = request && typeof request === 'object' ? request : {};
    if (remember !== undefined && typeof remember !== 'boolean') throw new AuthError('invalid_remember', MESSAGES.invalidRemember);
    if (!isTokenSyntax(token)) throw new AuthError('invalid_token', MESSAGES.invalidToken);
    const persist = remember === true;
    if (persist && !this.#store) throw new AuthError('storage_unavailable', MESSAGES.noStore);
    return this.#exclusive(async () => {
      const login = await this.#check(token);
      let warning = null;
      if (persist) {
        try { await this.#store.set(token); } catch {
          this.#stored = 'unknown';
          this.#storageError = MESSAGES.saveFailed;
          throw new AuthError('storage_failed', MESSAGES.saveFailed);
        }
        this.#stored = true;
      } else if (this.#store && this.#stored !== false) {
        try { await this.#store.delete(); this.#stored = false; } catch {
          if (this.#stored === true) {
            this.#storageError = MESSAGES.removeBlocked;
            throw new AuthError('storage_failed', MESSAGES.removeBlocked);
          }
          warning = MESSAGES.removeUnconfirmed;
        }
      }
      this.#token = token;
      this.#login = login;
      this.#remembered = persist;
      this.#storageError = warning;
      this.#settled = true;
      return this.state();
    });
  }

  /** Clears the in-memory token first, then removes this app's saved record; a failed removal is reported in state. */
  async disconnect() {
    return this.#exclusive(async () => {
      this.#token = null;
      this.#login = null;
      this.#remembered = false;
      this.#settled = true;
      this.#storageError = null;
      if (this.#store && this.#stored !== false) {
        try { await this.#store.delete(); this.#stored = false; } catch { this.#storageError = MESSAGES.disconnectRemains; }
      }
      return this.state();
    });
  }
}
