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
  const trimmed = String(text || '').replace(/^﻿/, '').trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('{')) {
    const obj = JSON.parse(trimmed);
    return Object.entries(obj).map(([url, branch]) => ({ url: url.trim(), branch: String(branch || '').trim() || null }));
  }
  const out = [];
  for (const raw of trimmed.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    // Split on the last " : " / ":" that isn't part of "https://".
    const m = /^(.*?)\s*:\s*([^:\s]+)\s*$/.exec(line.replace(/^(['"])(.*)\1/, '$2'));
    if (m && /\//.test(m[1])) out.push({ url: m[1].replace(/^['"]|['"]$/g, ''), branch: m[2].replace(/^['"]|['"]$/g, '') });
    else if (/^https?:\/\//.test(line)) out.push({ url: line, branch: null });
  }
  return out;
}

module.exports = { loadState, saveState, emptyState, parseLegacyConfig, STATE_FILE };
