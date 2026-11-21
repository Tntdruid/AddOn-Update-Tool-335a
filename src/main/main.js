'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { Settings } = require('./settings');
const { Updater, wowDirFrom } = require('../core/updater');
const { parseLegacyConfig } = require('../core/state');
const { HttpClient } = require('../core/http');
const { loadCatalog } = require('../core/catalog');
const bundledCatalog = require('../catalog/addons.json');

const REPO_URL = 'https://github.com/Tntdruid/AddOn-Update-Tool-335a';
// Read from package.json: app.getVersion() reports Electron's version when started via a custom entry.
const APP_VERSION = require('../../package.json').version;

let win;
let settings;
let updater = null;
let http = null;

function log(message, level = 'info') {
  if (win && !win.isDestroyed()) win.webContents.send('log', { message, level, time: Date.now() });
}

async function isWowDir(dir) {
  try {
    const files = await fs.readdir(dir);
    const hasExe = files.some((f) => f.toLowerCase() === 'wow.exe');
    const hasInterface = files.some((f) => f.toLowerCase() === 'interface' || f.toLowerCase() === 'data');
    return hasExe && hasInterface;
  } catch {
    return false;
  }
}

/** Look for Wow.exe next to the app (the original tool lived in the WoW folder). */
async function detectWowDir() {
  const candidates = [process.env.PORTABLE_EXECUTABLE_DIR, path.dirname(process.execPath), process.cwd()].filter(Boolean);
  for (const c of candidates) if (await isWowDir(c)) return c;
  return null;
}

let catalog = { entries: [], source: 'none' };
let catalogLoad = null;

/** Load the addon catalog once (remote copy if reachable, else the bundled one). */
function ensureCatalog(force = false) {
  if (!catalogLoad || force) {
    const client = new HttpClient({ tokens: settings.tokens() });
    catalogLoad = loadCatalog(client, bundledCatalog).then((c) => {
      catalog = c;
      if (updater) updater.setCatalog(c.entries);
      return c;
    });
  }
  return catalogLoad;
}

async function getUpdater() {
  const dir = settings.data.wowPath;
  if (!dir) throw new Error('Choose your WoW 3.3.5a folder first');
  await ensureCatalog();
  if (updater && updater.wowDir === dir) return updater;
  http = new HttpClient({ tokens: settings.tokens() });
  updater = await new Updater(dir, { http, log, catalog: catalog.entries }).load();
  return updater;
}

async function useWow(dir) {
  dir = wowDirFrom(dir);
  if (!(await isWowDir(dir))) throw new Error('That folder does not contain Wow.exe and an Interface/Data folder');
  await fs.mkdir(path.join(dir, 'Interface', 'AddOns'), { recursive: true });
  settings.data.wowPath = dir;
  settings.data.recentWowPaths = [dir, ...(settings.data.recentWowPaths || []).filter((p) => p !== dir)].slice(0, 5);
  await settings.save();
  updater = null;
  return settings.view();
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      log(err.message, 'error');
      return { ok: false, error: err.message };
    }
  });
}

function registerIpc() {
  handle('settings:get', async () => ({ ...settings.view(), version: APP_VERSION, repoUrl: REPO_URL }));
  handle('settings:set', async (patch) => {
    for (const k of ['autoCheck', 'closeOnLaunch']) if (k in patch) settings.data[k] = Boolean(patch[k]);
    await settings.save();
    return settings.view();
  });
  handle('settings:token', async (host, token) => {
    settings.setToken(host, String(token || '').trim());
    await settings.save();
    updater = null;
    return settings.view();
  });
  handle('wow:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Select Wow.exe (3.3.5a)',
      filters: [{ name: 'Wow.exe', extensions: ['exe'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return useWow(r.filePaths[0]);
  });
  handle('wow:use', useWow);
  handle('wow:launch', async () => {
    const dir = settings.data.wowPath;
    const exe = (await fs.readdir(dir)).find((f) => f.toLowerCase() === 'wow.exe');
    spawn(path.join(dir, exe), [], { cwd: dir, detached: true, stdio: 'ignore' }).unref();
    log('Starting World of Warcraft…');
    if (settings.data.closeOnLaunch) setTimeout(() => app.quit(), 1500);
    return true;
  });

  handle('addons:overview', async () => (await getUpdater()).overview());
  handle('addons:check', async () => {
    const u = await getUpdater();
    log('Checking for updates…');
    const r = await u.checkAll();
    const failed = r.filter((x) => !x.ok);
    log(failed.length ? `Check finished, ${failed.length} failed` : 'Check finished', failed.length ? 'warn' : 'info');
    return r;
  });
  handle('addons:update', async (ids) => {
    const u = await getUpdater();
    const r = await u.update(ids || null);
    for (const x of r) {
      if (x.ok) log(`Updated ${x.id}`);
      else log(`${x.id}: ${x.error}`, 'error');
      for (const w of x.warnings) log(w, 'warn');
    }
    return r;
  });
  handle('addons:add', async (url, opts) => {
    const u = await getUpdater();
    const r = await u.add(url, opts || {});
    log(`Installed ${r.installed.join(', ')} from ${r.addon.id} (${r.addon.branch})`);
    for (const w of r.warnings) log(w, 'warn');
    return r;
  });
  handle('addons:remove', async (id, opts) => (await getUpdater()).remove(id, opts));
  handle('addons:ignore', async (id, v) => (await getUpdater()).setIgnored(id, v));
  handle('addons:backups', async (id) => (await getUpdater()).backups(id));
  handle('addons:rollback', async (id, backupId) => {
    const r = await (await getUpdater()).rollback(id, backupId);
    log(`Restored ${r.restored.join(', ')}`);
    return r;
  });
  handle('addons:branches', async (id) => (await getUpdater()).branches(id));
  handle('addons:changes', async (id) => (await getUpdater()).changes(id));
  handle('addons:installDep', async (name) => {
    const r = await (await getUpdater()).installDependency(name);
    log(`Installed dependency ${name}`);
    return r;
  });
  handle('catalog:refresh', async () => {
    const c = await ensureCatalog(true);
    log(`Catalog: ${c.entries.length} addons (${c.source})`);
    return { count: c.entries.length, source: c.source };
  });
  handle('addons:changeBranch', async (id, b) => (await getUpdater()).changeBranch(id, b));
  handle('addons:suggest', async (folder, title, hints) => (await getUpdater()).suggest(folder, title, hints));
  handle('addons:import', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Import config from AddOns-Update-Tool',
      filters: [{ name: 'Config', extensions: ['yaml', 'yml', 'json'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const entries = parseLegacyConfig(await fs.readFile(r.filePaths[0], 'utf8'));
    const u = await getUpdater();
    const results = [];
    for (const e of entries) {
      try {
        const res = await u.add(e.url, { branch: e.branch || undefined });
        log(`Imported ${res.addon.id}`);
        results.push({ url: e.url, ok: true });
      } catch (err) {
        log(`${e.url}: ${err.message}`, err.message.includes('already') ? 'warn' : 'error');
        results.push({ url: e.url, ok: false, error: err.message });
      }
    }
    return results;
  });
  handle('shell:folder', async (which) => {
    const dir = settings.data.wowPath;
    const target = which === 'backups' ? path.join(dir, 'Interface', 'AddOns.backups') : path.join(dir, 'Interface', 'AddOns');
    await fs.mkdir(target, { recursive: true });
    return shell.openPath(target);
  });
  handle('shell:url', async (url) => {
    if (!/^https:\/\//i.test(url)) throw new Error('Only https links can be opened');
    return shell.openExternal(url);
  });
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 820,
    minHeight: 520,
    backgroundColor: '#14161b',
    title: 'AddOn Update Tool 3.3.5a',
    autoHideMenuBar: true,
    ...(app.isPackaged ? {} : { icon: path.join(__dirname, '..', '..', 'build', 'icon.png') }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  settings = await new Settings(app.getPath('userData'), safeStorage).load();
  if (!settings.data.wowPath) {
    const found = await detectWowDir();
    if (found) await useWow(found).catch(() => {});
  }
  registerIpc();
  await createWindow();
});

app.on('window-all-closed', () => app.quit());
