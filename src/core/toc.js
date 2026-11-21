'use strict';

/** Interface version of the 3.3.5a (Wrath of the Lich King) client. */
const TARGET_INTERFACE = 30300;

/**
 * Suffixes used by multi-client addons for flavour-specific TOC files
 * (e.g. "Foo-WOTLKC.toc", "Foo_Wrath.toc"). The 3.3.5a client only reads
 * "<Folder>.toc", so these are informational only.
 */
const FLAVOR_SUFFIX = /[-_](mainline|classic|vanilla|era|bcc|tbc|wotlkc|wrath|cata|mists|mop|retail)$/i;

/** Strip WoW UI escape sequences (colour codes, textures) from a string. */
function stripEscapes(text) {
  return String(text || '')
    .replace(/\|c[0-9a-fA-F]{8}/g, '')
    .replace(/\|r/g, '')
    .replace(/\|T[^|]*\|t/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse the contents of a .toc file.
 * @param {string} content
 * @returns {{title:string|null, interface:number|null, version:string|null, notes:string|null,
 *   author:string|null, dependencies:string[], optionalDeps:string[], fields:Record<string,string>, files:string[]}}
 */
function parseToc(content) {
  const fields = {};
  const files = [];
  const seen = new Set();
  const text = String(content || '').replace(/^﻿/, '');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const meta = /^##\s*([^:]+?)\s*:\s*(.*)$/.exec(line);
    if (meta) {
      const key = meta[1].trim();
      // First occurrence wins, matching the client's behaviour.
      if (!seen.has(key.toLowerCase())) {
        seen.add(key.toLowerCase());
        fields[key] = meta[2].trim();
      }
      continue;
    }
    if (line.startsWith('#')) continue;
    files.push(line);
  }
  const get = (name) => {
    const hit = Object.keys(fields).find((k) => k.toLowerCase() === name.toLowerCase());
    return hit ? fields[hit] : null;
  };
  const list = (...names) => {
    for (const n of names) {
      const v = get(n);
      if (v) return v.split(',').map((s) => s.trim()).filter(Boolean);
    }
    return [];
  };
  const iface = parseInt(get('Interface'), 10);
  const title = get('Title');
  return {
    title: title ? stripEscapes(title) : null,
    interface: Number.isFinite(iface) ? iface : null,
    version: get('Version'),
    notes: get('Notes') ? stripEscapes(get('Notes')) : null,
    author: get('Author'),
    dependencies: list('Dependencies', 'RequiredDeps', 'Dep', 'Dependancies'),
    optionalDeps: list('OptionalDeps', 'OptionalDependencies'),
    fields,
    files,
  };
}

/** Base addon name of a TOC filename, with any flavour suffix removed. */
function tocBaseName(fileName) {
  return String(fileName).replace(/\.toc$/i, '').replace(FLAVOR_SUFFIX, '');
}

/**
 * Compatibility of a TOC interface number with the 3.3.5a client.
 * @returns {'ok'|'newer'|'older'|'unknown'}
 */
function compatibility(iface) {
  if (!Number.isFinite(iface)) return 'unknown';
  if (iface === TARGET_INTERFACE) return 'ok';
  // Anything in the 3.x range loads fine on 3.3.5a (or with "load out of date").
  if (iface >= 30000 && iface < TARGET_INTERFACE) return 'older';
  if (iface < 30000) return 'older';
  return 'newer';
}

/** Repository URLs that addon authors commonly put in TOC metadata. */
function repoHints(toc) {
  const out = [];
  for (const [key, value] of Object.entries(toc.fields || {})) {
    if (!/^x-|^url$|^website$/i.test(key)) continue;
    const m = String(value).match(/https?:\/\/[^\s|"']+/g);
    if (m) out.push(...m);
  }
  return out;
}

module.exports = { TARGET_INTERFACE, parseToc, tocBaseName, compatibility, stripEscapes, repoHints };
