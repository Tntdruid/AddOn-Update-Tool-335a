'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const STATE_FILE = 'AddonUpdateTool.json';

/**
 * Per-installation state, stored next to Wow.exe so it follows the game folder.
 * @typedef {{id:string, url:string, provider:string, branch:string, branchPinned:boolean,
 *   folders:string[], installedSha:string|null, installedAt:string|null, commitDate:string|null,
 *   remoteSha?:string|null, remoteDate?:string|null, lastError?:string|null, ignored?:boolean}} ManagedAddon
 */

function emptyState() {
  return { version: 1, addons: [], etags: {} };
}

async function loadState(wowDir) {
  try {
    const data = JSON.parse(await fs.readFile(path.join(wowDir, STATE_FILE), 'utf8'));
    return { ...emptyState(), ...data, addons: Array.isArray(data.addons) ? data.addons : [] };
  } catch (err) {
    if (err.code === 'ENOENT') return emptyState();
    throw new Error(`Could not read ${STATE_FILE}: ${err.message}`);
  }
}

async function saveState(wowDir, state) {
  const file = path.join(wowDir, STATE_FILE);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, file);
}

/**
 * Parse a config from the original AddOns-Update-Tool (JSON or the simple
 * "URL : branch" YAML form), returning [{url, branch}].
 */
function parseLegacyConfig(text) {
  return parseConfigEntries(text)
    .filter((e) => e.enabled)
    .map(({ url, branch }) => ({ url, branch }));
}

/**
 * Parse a config including commented-out entries. Shared configs (such as the
 * one in NoM0Re/WoW-3.3.5a-Addons) list addons as "# URL : branch" so users can
 * pick what they want; those come back with enabled:false.
 * Comment lines that aren't entries become the section of the entries below them,
 * and trailing "# notes" are kept.
 * @returns {Array<{url:string, branch:string|null, enabled:boolean, section:string|null, note:string|null}>}
 */
function parseConfigEntries(text) {
  const trimmed = String(text || '').replace(/^﻿/, '').trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('{')) {
    const obj = JSON.parse(trimmed);
    return Object.entries(obj).map(([url, branch]) => ({
      url: url.trim(),
      branch: String(branch || '').trim() || null,
      enabled: true,
      section: null,
      note: null,
    }));
  }
  const out = [];
  let section = null;
  for (const raw of trimmed.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    let enabled = true;
    if (line.startsWith('#')) {
      const inner = line.replace(/^#+\s*/, '');
      if (!/^['"]?(https?:\/\/|git@)/i.test(inner)) {
        if (inner) section = inner; // a heading such as "# DBM (https://discord...)"
        continue;
      }
      enabled = false;
      line = inner;
    }
    const hash = line.search(/\s+#/);
    const note = hash >= 0 ? line.slice(hash).replace(/^\s+#+\s*/, '').trim() || null : null;
    if (hash >= 0) line = line.slice(0, hash).trim();
    const entry = parseEntryLine(line);
    if (entry) out.push({ ...entry, enabled, section, note });
  }
  return out;
}

/** "URL : branch" or a bare URL. */
function parseEntryLine(line) {
  const unquoted = line.replace(/^(['"])(.*?)\1/, '$2');
  // Split on the last ":" that isn't part of "https://".
  const m = /^(.*?)\s*:\s*([^:\s]+)\s*$/.exec(unquoted);
  if (m && /\//.test(m[1])) return { url: m[1].replace(/^['"]|['"]$/g, ''), branch: m[2].replace(/^['"]|['"]$/g, '') };
  if (/^(https?:\/\/|git@)\S+$/.test(unquoted)) return { url: unquoted, branch: null };
  return null;
}

/**
 * Turn a link to a config file into a URL that returns the raw text.
 * Accepts https only; GitHub/GitLab "blob" pages are rewritten to their raw form.
 */
function configRawUrl(input) {
  let u;
  try {
    u = new URL(String(input).trim());
  } catch {
    throw new Error('That is not a valid URL');
  }
  if (u.protocol !== 'https:') throw new Error('Only https:// links are supported');
  if (u.hostname === 'github.com') {
    const m = /^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/.exec(u.pathname);
    if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
  }
  if (/\/-\/blob\//.test(u.pathname)) return u.href.replace('/-/blob/', '/-/raw/');
  return u.href;
}

module.exports = { loadState, saveState, emptyState, parseLegacyConfig, parseConfigEntries, configRawUrl, STATE_FILE };
