'use strict';

const { unzipSync, strFromU8 } = require('fflate');
const { parseToc, tocBaseName, compatibility } = require('./toc');

/** Folders inside repos that never contain installable addons. */
const IGNORED_DIRS = /^(\.git|\.github|\.vscode|\.idea|docs?|screenshots?|media|images?|\.circleci|node_modules|tests?)$/i;

/**
 * Unzip an archive into a { "dir/file": Uint8Array } map, skipping directory entries.
 * The single top-level folder that GitHub/GitLab archives add is stripped.
 */
function readArchive(bytes) {
  const raw = unzipSync(bytes);
  const files = {};
  for (const [name, data] of Object.entries(raw)) {
    const clean = name.replace(/\\/g, '/');
    if (clean.endsWith('/')) continue;
    if (clean.split('/').some((p) => p === '..')) throw new Error(`Unsafe path in archive: ${name}`);
    files[clean] = data;
  }
  return stripCommonRoot(files);
}

function stripCommonRoot(files) {
  const names = Object.keys(files);
  if (!names.length) return files;
  const first = names[0].split('/')[0];
  const allUnder = names.every((n) => n.includes('/') && n.split('/')[0] === first);
  if (!allUnder) return files;
  const out = {};
  for (const n of names) out[n.slice(first.length + 1)] = files[n];
  return out;
}

/** Build a tree of directories -> { files:Set, dirs:Set } from flat paths. */
function buildTree(paths) {
  const tree = new Map();
  const ensure = (dir) => {
    if (!tree.has(dir)) tree.set(dir, { files: new Set(), dirs: new Set() });
    return tree.get(dir);
  };
  ensure('');
  for (const p of paths) {
    const parts = p.split('/');
    for (let i = 0; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      const node = ensure(parent);
      if (i === parts.length - 1) node.files.add(parts[i]);
      else {
        node.dirs.add(parts[i]);
        ensure(parts.slice(0, i + 1).join('/'));
      }
    }
  }
  return tree;
}

/**
 * Pick the addon name for a directory containing .toc files, or null.
 * The 3.3.5a client loads "<Folder>/<Folder>.toc", so the folder must match the TOC name.
 */
function addonNameForDir(dirName, tocFiles, fallbackName) {
  if (!tocFiles.length) return null;
  const exact = tocFiles.find((t) => t.replace(/\.toc$/i, '').toLowerCase() === String(dirName).toLowerCase());
  if (exact) return { name: exact.replace(/\.toc$/i, ''), toc: exact };
  // Plain "<Name>.toc" (no flavour suffix) wins over flavour-specific TOCs.
  const plain = tocFiles.filter((t) => tocBaseName(t) === t.replace(/\.toc$/i, ''));
  const bases = [...new Set(tocFiles.map(tocBaseName))];
  if (plain.length === 1) return { name: tocBaseName(plain[0]), toc: plain[0] };
  if (bases.length === 1) {
    const toc = plain[0] || pickFlavorToc(tocFiles);
    return { name: bases[0], toc, needsTocRename: !plain.length };
  }
  if (fallbackName) {
    const byFallback = tocFiles.find((t) => tocBaseName(t).toLowerCase() === fallbackName.toLowerCase());
    if (byFallback) return { name: tocBaseName(byFallback), toc: byFallback };
  }
  return null;
}

/** When only flavour TOCs exist, prefer the Wrath one. */
function pickFlavorToc(tocFiles) {
  return (
    tocFiles.find((t) => /[-_](wrath|wotlkc)\.toc$/i.test(t)) ||
    tocFiles.find((t) => /[-_](bcc|tbc)\.toc$/i.test(t)) ||
    tocFiles[0]
  );
}

/**
 * Locate installable addon folders in an extracted archive.
 * Rules:
 *  - A directory holding a matching .toc is an addon; its subfolders (embedded libs) are not scanned.
 *  - If the archive root itself is an addon (TOC at top level), it is installed under the TOC name,
 *    which fixes "Repo-master" style folder names.
 *  - Otherwise every subdirectory is searched recursively (handles repos with several modules,
 *    or addons nested in e.g. "AddOns/" or "Interface/AddOns/").
 * @param {Record<string, Uint8Array>} files
 * @param {{repoName?:string}} [opts]
 * @returns {Array<{name:string, prefix:string, toc:string, interface:number|null, title:string|null,
 *   version:string|null, compat:string, renameToc?:string}>}
 */
function findAddons(files, opts = {}) {
  const tree = buildTree(Object.keys(files));
  const found = [];
  const visit = (dir, depth) => {
    const node = tree.get(dir);
    if (!node || depth > 6) return;
    const dirName = dir ? dir.split('/').pop() : opts.repoName || '';
    if (dir && IGNORED_DIRS.test(dirName)) return;
    const tocs = [...node.files].filter((f) => /\.toc$/i.test(f));
    const hit = addonNameForDir(dirName, tocs, dir ? null : opts.repoName);
    if (hit) {
      const tocPath = dir ? `${dir}/${hit.toc}` : hit.toc;
      const toc = parseToc(strFromU8(files[tocPath]));
      found.push({
        name: hit.name,
        prefix: dir,
        toc: hit.toc,
        interface: toc.interface,
        title: toc.title,
        version: toc.version,
        compat: compatibility(toc.interface),
        dependencies: toc.dependencies,
        ...(hit.needsTocRename ? { renameToc: `${hit.name}.toc` } : {}),
      });
      return;
    }
    for (const sub of [...node.dirs].sort()) visit(dir ? `${dir}/${sub}` : sub, depth + 1);
  };
  visit('', 0);
  return orderByImportance(dedupe(found), opts.repoName);
}

/**
 * Put the "main" folder first: the one most other folders depend on, then one
 * named like the repo, then the shortest name. Keeps the rest alphabetical.
 */
function orderByImportance(found, repoName) {
  const dependents = new Map(found.map((f) => [f.name.toLowerCase(), 0]));
  for (const f of found) {
    for (const d of f.dependencies || []) {
      const k = d.toLowerCase();
      if (dependents.has(k) && k !== f.name.toLowerCase()) dependents.set(k, dependents.get(k) + 1);
    }
  }
  const repo = String(repoName || '').toLowerCase();
  const rank = (f) => [
    -dependents.get(f.name.toLowerCase()),
    f.name.toLowerCase() === repo || repo.startsWith(f.name.toLowerCase()) ? 0 : 1,
    f.name.length,
  ];
  const sorted = [...found].sort((a, b) => a.name.localeCompare(b.name));
  const main = [...found].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return a.name.localeCompare(b.name);
  })[0];
  return main ? [main, ...sorted.filter((f) => f !== main)] : sorted;
}

/** If two candidates produce the same folder name, keep the shallowest. */
function dedupe(found) {
  const byName = new Map();
  for (const a of found) {
    const key = a.name.toLowerCase();
    const prev = byName.get(key);
    if (!prev || a.prefix.split('/').length < prev.prefix.split('/').length) byName.set(key, a);
  }
  return [...byName.values()];
}

/**
 * Files belonging to one addon, keyed by path relative to the addon folder.
 */
function filesForAddon(files, addon) {
  const out = {};
  const pre = addon.prefix ? `${addon.prefix}/` : '';
  for (const [path, data] of Object.entries(files)) {
    if (pre && !path.startsWith(pre)) continue;
    let rel = path.slice(pre.length);
    if (!pre && rel.split('/').some((p, i, arr) => i < arr.length - 1 && IGNORED_DIRS.test(p))) continue;
    if (!pre && /^(\.git\w*|\.pkgmeta|\.editorconfig|\.luacheckrc)$/i.test(rel)) continue;
    if (addon.renameToc && rel === addon.toc) rel = addon.renameToc;
    out[rel] = data;
  }
  return out;
}

module.exports = { readArchive, findAddons, filesForAddon, addonNameForDir, stripCommonRoot };
