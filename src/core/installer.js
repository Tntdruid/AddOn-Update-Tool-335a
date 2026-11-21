'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_BACKUPS = 5;

/** Folder names must be a single safe path segment. */
function assertSafeName(name) {
  if (!name || /[\\/]/.test(name) || name === '.' || name === '..' || /[<>:"|?*]/.test(name)) {
    throw new Error(`Unsafe addon folder name: ${name}`);
  }
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Paths used for a WoW installation. */
function layout(wowDir) {
  return {
    addons: path.join(wowDir, 'Interface', 'AddOns'),
    backups: path.join(wowDir, 'Interface', 'AddOns.backups'),
    staging: path.join(wowDir, 'Interface', 'AddOns.staging'),
  };
}

async function writeTree(dir, files) {
  for (const [rel, data] of Object.entries(files)) {
    const target = path.join(dir, ...rel.split('/'));
    if (!target.startsWith(dir + path.sep)) throw new Error(`Unsafe path: ${rel}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
  }
}

/**
 * Install addon folders, replacing existing ones atomically per folder.
 * Existing folders (and folders previously owned by this addon that disappeared)
 * are moved into a timestamped backup so the update can be rolled back.
 *
 * @param {string} wowDir
 * @param {string} addonId
 * @param {Array<{name:string, files:Record<string,Uint8Array>}>} folders
 * @param {{previousFolders?:string[], meta?:object, now?:Date}} [opts]
 * @returns {Promise<{installed:string[], removed:string[], backup:string|null}>}
 */
async function installFolders(wowDir, addonId, folders, opts = {}) {
  const L = layout(wowDir);
  for (const f of folders) assertSafeName(f.name);
  const names = folders.map((f) => f.name);
  const stale = (opts.previousFolders || []).filter((n) => !names.some((m) => m.toLowerCase() === n.toLowerCase()));
  for (const n of stale) assertSafeName(n);

  const stamp = (opts.now || new Date()).toISOString().replace(/[:.]/g, '-');
  const stageDir = path.join(L.staging, `${safeId(addonId)}-${stamp}`);
  await fs.mkdir(stageDir, { recursive: true });
  await fs.mkdir(L.addons, { recursive: true });

  // 1. Write everything to staging first; a failed download never touches AddOns.
  try {
    for (const f of folders) await writeTree(path.join(stageDir, f.name), f.files);
  } catch (err) {
    await fs.rm(stageDir, { recursive: true, force: true });
    throw err;
  }

  // 2. Move current folders to a backup.
  const toBackup = [];
  for (const n of [...names, ...stale]) if (await exists(path.join(L.addons, n))) toBackup.push(n);
  let backupDir = null;
  if (toBackup.length) {
    backupDir = path.join(L.backups, safeId(addonId), stamp);
    await fs.mkdir(backupDir, { recursive: true });
    for (const n of toBackup) await moveDir(path.join(L.addons, n), path.join(backupDir, n));
    await fs.writeFile(
      path.join(backupDir, 'backup.json'),
      JSON.stringify({ addonId, folders: toBackup, createdAt: stamp, meta: opts.meta || null }, null, 2),
    );
  }

  // 3. Move staged folders into place; on failure restore the backup.
  const placed = [];
  try {
    for (const n of names) {
      await moveDir(path.join(stageDir, n), path.join(L.addons, n));
      placed.push(n);
    }
  } catch (err) {
    for (const n of placed) await fs.rm(path.join(L.addons, n), { recursive: true, force: true });
    if (backupDir) for (const n of toBackup) await moveDir(path.join(backupDir, n), path.join(L.addons, n)).catch(() => {});
    throw err;
  } finally {
    await fs.rm(stageDir, { recursive: true, force: true });
    await removeIfEmpty(L.staging);
  }

  await pruneBackups(wowDir, addonId, MAX_BACKUPS);
  return { installed: names, removed: stale.filter((n) => toBackup.includes(n)), backup: backupDir };
}

async function moveDir(from, to) {
  try {
    await fs.rename(from, to);
  } catch (err) {
    // Cross-device or locked: fall back to copy + delete.
    if (!['EXDEV', 'EPERM', 'EBUSY'].includes(err.code)) throw err;
    await fs.cp(from, to, { recursive: true });
    await fs.rm(from, { recursive: true, force: true });
  }
}

async function removeIfEmpty(dir) {
  try {
    if (!(await fs.readdir(dir)).length) await fs.rmdir(dir);
  } catch {
    /* ignore */
  }
}

function safeId(id) {
  return String(id).replace(/[^a-z0-9._-]+/gi, '_');
}

/** List backups for an addon, newest first. */
async function listBackups(wowDir, addonId) {
  const dir = path.join(layout(wowDir).backups, safeId(addonId));
  if (!(await exists(dir))) return [];
  const out = [];
  for (const stamp of await fs.readdir(dir)) {
    try {
      const info = JSON.parse(await fs.readFile(path.join(dir, stamp, 'backup.json'), 'utf8'));
      out.push({ id: stamp, path: path.join(dir, stamp), ...info });
    } catch {
      /* not a backup */
    }
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : -1));
}

async function pruneBackups(wowDir, addonId, keep) {
  const all = await listBackups(wowDir, addonId);
  for (const b of all.slice(keep)) await fs.rm(b.path, { recursive: true, force: true });
}

/**
 * Restore a backup. The current folders are themselves backed up first, so a
 * rollback can be undone.
 * @returns {Promise<{restored:string[], meta:object|null}>}
 */
async function restoreBackup(wowDir, addonId, backupId, currentFolders = []) {
  const L = layout(wowDir);
  const src = path.join(L.backups, safeId(addonId), backupId);
  const info = JSON.parse(await fs.readFile(path.join(src, 'backup.json'), 'utf8'));
  const folders = [];
  for (const n of info.folders) {
    assertSafeName(n);
    folders.push({ name: n, files: await readTree(path.join(src, n)) });
  }
  await installFolders(wowDir, addonId, folders, { previousFolders: currentFolders, meta: { restoredFrom: backupId } });
  return { restored: info.folders, meta: info.meta };
}

async function readTree(dir, base = dir, out = {}) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await readTree(full, base, out);
    else out[path.relative(base, full).split(path.sep).join('/')] = await fs.readFile(full);
  }
  return out;
}

/** Move addon folders to the backup area (uninstall, reversible). */
async function uninstallFolders(wowDir, addonId, folderNames) {
  const L = layout(wowDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(L.backups, safeId(addonId), stamp);
  const moved = [];
  for (const n of folderNames) {
    assertSafeName(n);
    if (!(await exists(path.join(L.addons, n)))) continue;
    await fs.mkdir(backupDir, { recursive: true });
    await moveDir(path.join(L.addons, n), path.join(backupDir, n));
    moved.push(n);
  }
  if (moved.length) {
    await fs.writeFile(
      path.join(backupDir, 'backup.json'),
      JSON.stringify({ addonId, folders: moved, createdAt: stamp, meta: { uninstalled: true } }, null, 2),
    );
  }
  return { removed: moved, backup: moved.length ? backupDir : null };
}

module.exports = { installFolders, listBackups, restoreBackup, uninstallFolders, layout, assertSafeName, MAX_BACKUPS };
