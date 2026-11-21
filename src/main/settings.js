'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

/**
 * App-wide settings stored in Electron's userData folder.
 * Tokens are encrypted with the OS keychain (DPAPI on Windows) when available.
 */
class Settings {
  constructor(dir, safeStorage) {
    this.file = path.join(dir, 'settings.json');
    this.safe = safeStorage && safeStorage.isEncryptionAvailable() ? safeStorage : null;
    this.data = { wowPath: null, recentWowPaths: [], tokens: {}, autoCheck: true, closeOnLaunch: false };
  }

  async load() {
    try {
      Object.assign(this.data, JSON.parse(await fs.readFile(this.file, 'utf8')));
    } catch {
      /* first run */
    }
    return this;
  }

  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.data, null, 2));
  }

  tokens() {
    const out = {};
    for (const [host, value] of Object.entries(this.data.tokens || {})) {
      try {
        out[host] = value.enc && this.safe ? this.safe.decryptString(Buffer.from(value.enc, 'base64')) : value.plain;
      } catch {
        /* unreadable on this machine */
      }
    }
    return out;
  }

  setToken(host, token) {
    this.data.tokens = this.data.tokens || {};
    if (!token) delete this.data.tokens[host];
    else if (this.safe) this.data.tokens[host] = { enc: this.safe.encryptString(token).toString('base64') };
    else this.data.tokens[host] = { plain: token };
  }

  /** Public view without secrets. */
  view() {
    return {
      wowPath: this.data.wowPath,
      recentWowPaths: this.data.recentWowPaths || [],
      autoCheck: this.data.autoCheck !== false,
      closeOnLaunch: Boolean(this.data.closeOnLaunch),
      tokenHosts: Object.keys(this.data.tokens || {}),
    };
  }
}

module.exports = { Settings };
