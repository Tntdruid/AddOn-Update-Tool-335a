'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { parseToc, compatibility, repoHints } = require('./toc');

/** Blizzard's own load-on-demand addons live in Interface/AddOns too on some repacks. */
const BLIZZARD = /^Blizzard_/i;

/**
 * Read every addon folder in Interface/AddOns.
 * @returns {Promise<Array<{folder:string, title:string, version:string|null, interface:number|null,
 *   compat:string, dependencies:string[], hints:string[], notes:string|null, author:string|null}>>}
 */
async function scanAddons(addonsDir) {
  let entries;
  try {
    entries = await fs.readdir(addonsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || BLIZZARD.test(e.name)) continue;
    const dir = path.join(addonsDir, e.name);
    let tocText = null;
    try {
      const files = await fs.readdir(dir);
      const tocFile = files.find((f) => f.toLowerCase() === `${e.name.toLowerCase()}.toc`);
      if (tocFile) tocText = await fs.readFile(path.join(dir, tocFile), 'utf8');
    } catch {
      /* unreadable */
    }
    if (tocText == null) {
      out.push({ folder: e.name, title: e.name, version: null, interface: null, compat: 'missing-toc', dependencies: [], hints: [], notes: null, author: null });
      continue;
    }
    const toc = parseToc(tocText);
    out.push({
      folder: e.name,
      title: toc.title || e.name,
      version: toc.version,
      interface: toc.interface,
      compat: compatibility(toc.interface),
      dependencies: toc.dependencies,
      hints: repoHints(toc),
      notes: toc.notes,
      author: toc.author,
    });
  }
  return out.sort((a, b) => a.folder.localeCompare(b.folder, undefined, { sensitivity: 'base' }));
}

/**
 * Group loose folders into logical addons:
 *  - folders owned by a managed addon go to that addon;
 *  - remaining modules join a "parent" when they share a name prefix and depend on it
 *    (e.g. DBM-Party-WotLK -> DBM-Core, or Foo_Options -> Foo).
 * @param {ReturnType<typeof scanAddons> extends Promise<infer T> ? T : never} folders
 * @param {Array<{id:string, folders:string[]}>} managed
 * @returns {{managed: Record<string, object[]>, groups: Array<{main:object, modules:object[]}>}}
 */
function groupFolders(folders, managed = []) {
  const owner = new Map();
  for (const m of managed) for (const f of m.folders || []) owner.set(f.toLowerCase(), m.id);
  const byManaged = {};
  const loose = [];
  for (const f of folders) {
    const id = owner.get(f.folder.toLowerCase());
    if (id) (byManaged[id] = byManaged[id] || []).push(f);
    else loose.push(f);
  }

  const names = new Map(loose.map((f) => [f.folder.toLowerCase(), f]));
  const parentOf = new Map();
  for (const f of loose) {
    const p = findParent(f, names);
    if (p) parentOf.set(f.folder, p.folder);
  }
  // Resolve chains to the root parent.
  const root = (name, seen = new Set()) => {
    const p = parentOf.get(name);
    if (!p || seen.has(p)) return name;
    seen.add(name);
    return root(p, seen);
  };
  const groups = new Map();
  for (const f of loose) {
    const r = root(f.folder);
    if (!groups.has(r)) groups.set(r, { main: names.get(r.toLowerCase()), modules: [] });
    if (r !== f.folder) groups.get(r).modules.push(f);
  }
  return { managed: byManaged, groups: [...groups.values()] };
}

function prefixOf(name) {
  const m = /^(.+?)[-_ ]/.exec(name);
  return m ? m[1].toLowerCase() : null;
}

function findParent(f, names) {
  const pre = prefixOf(f.folder);
  if (!pre) return null;
  // A dependency that shares our prefix is the strongest signal.
  for (const dep of f.dependencies) {
    const d = names.get(dep.toLowerCase());
    if (d && d.folder !== f.folder && (prefixOf(d.folder) === pre || d.folder.toLowerCase() === pre)) return d;
  }
  // Otherwise "Foo_Options" -> "Foo", if Foo exists.
  const bare = names.get(pre);
  if (bare && bare.folder !== f.folder) return bare;
  return null;
}

/**
 * Required dependencies that are not installed.
 * Blizzard_* addons ship with the client, so they are never reported.
 * @param {Array<{folder:string, dependencies:string[]}>} folders installed folders
 * @returns {Map<string, string[]>} missing dependency name -> folders that need it
 */
function missingDependencies(folders) {
  const present = new Set(folders.map((f) => f.folder.toLowerCase()));
  const missing = new Map();
  for (const f of folders) {
    for (const dep of f.dependencies || []) {
      if (BLIZZARD.test(dep) || present.has(dep.toLowerCase())) continue;
      const key = [...missing.keys()].find((k) => k.toLowerCase() === dep.toLowerCase()) || dep;
      missing.set(key, [...(missing.get(key) || []), f.folder]);
    }
  }
  return missing;
}

module.exports = { scanAddons, groupFolders, missingDependencies };
