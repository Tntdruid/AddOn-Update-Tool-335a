'use strict';

const path = require('node:path');
const src = require('./source');
const { readArchive, findAddons, filesForAddon } = require('./archive');
const installer = require('./installer');
const { scanAddons, groupFolders, missingDependencies } = require('./scanner');
const { catalogFor } = require('./catalog');
const { loadState, saveState } = require('./state');
const { HttpClient, mapLimit } = require('./http');

const CONCURRENCY = 6;

/**
 * High-level operations for one WoW installation.
 */
class Updater {
  /**
   * @param {string} wowDir folder containing Wow.exe
   * @param {{http?:HttpClient, tokens?:Record<string,string>, fetch?:typeof fetch, log?:(msg:string, level?:string)=>void}} [opts]
   */
  constructor(wowDir, opts = {}) {
    this.wowDir = wowDir;
    this.addonsDir = installer.layout(wowDir).addons;
    this.opts = opts;
    this.log = opts.log || (() => {});
    this.state = null;
    this.http = opts.http || null;
    this.catalog = opts.catalog || [];
  }

  async load() {
    this.state = await loadState(this.wowDir);
    if (!this.http) this.http = new HttpClient({ fetch: this.opts.fetch, tokens: this.opts.tokens, etagCache: this.state.etags });
    else this.http.etagCache = this.state.etags;
    return this;
  }

  async save() {
    // Keep the ETag cache bounded.
    const keys = Object.keys(this.state.etags);
    if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete this.state.etags[k];
    await saveState(this.wowDir, this.state);
  }

  find(id) {
    return this.state.addons.find((a) => a.id === id);
  }

  /** Full view model for the UI: managed addons plus unmanaged local groups. */
  async overview() {
    const folders = await scanAddons(this.addonsDir);
    const { managed, groups } = groupFolders(folders, this.state.addons);
    const present = new Set(folders.map((f) => f.folder.toLowerCase()));
    const addons = this.state.addons.map((a) => {
      const local = managed[a.id] || [];
      const main = local.find((f) => f.folder === a.folders[0]) || local[0] || null;
      const missing = a.folders.filter((f) => !present.has(f.toLowerCase()));
      return {
        ...a,
        title: (main && main.title) || a.folders[0] || a.id,
        version: main ? main.version : null,
        interface: main ? main.interface : null,
        compat: main ? main.compat : 'unknown',
        missing,
        status: statusOf(a, missing),
      };
    });
    const unmanaged = groups
      .filter((g) => g.main)
      .map((g) => ({
        folder: g.main.folder,
        title: g.main.title,
        version: g.main.version,
        interface: g.main.interface,
        compat: g.main.compat,
        modules: g.modules.map((m) => m.folder),
        hints: [...g.main.hints, ...g.modules.flatMap((m) => m.hints)].filter(isRepoUrl),
        notes: g.main.notes,
        author: g.main.author,
        catalog: catalogFor(this.catalog, [g.main.folder, ...g.modules.map((m) => m.folder)]),
      }));

    // Missing required dependencies, attached to the addon that needs them.
    const missingDeps = [...missingDependencies(folders)].map(([name, neededBy]) => ({
      name,
      neededBy,
      catalog: catalogFor(this.catalog, [name]),
    }));
    const depsFor = (folderNames) => {
      const own = new Set(folderNames.map((f) => f.toLowerCase()));
      return missingDeps.filter((d) => d.neededBy.some((n) => own.has(n.toLowerCase())));
    };
    for (const a of addons) a.missingDeps = depsFor(a.folders);
    for (const u of unmanaged) u.missingDeps = depsFor([u.folder, ...u.modules]);

    const managedUrls = new Set(this.state.addons.map((a) => a.id));
    return {
      wowDir: this.wowDir,
      addons,
      unmanaged,
      missingDeps,
      catalog: this.catalog.map((c) => ({ ...c, installed: managedUrls.has(c.id) })),
      rateLimit: this.http.rateLimit,
    };
  }

  /** Install whatever provides a missing dependency, using the catalog. */
  async installDependency(name) {
    const entry = catalogFor(this.catalog, [name]);
    if (!entry) throw new Error(`${name} is not in the catalog. Use "Add from URL" instead.`);
    if (this.find(entry.id)) return this.update([entry.id]);
    return this.add(entry.url, { branch: entry.branch || undefined });
  }

  /**
   * Annotate parsed config entries for the import checklist: a display name,
   * whether it's already managed, the catalog name, and whether the URL is usable.
   */
  importPreview(entries) {
    const seen = new Set();
    const out = [];
    for (const e of entries) {
      let s;
      try {
        s = src.parseRepoUrl(e.url);
      } catch {
        out.push({ ...e, id: null, name: e.url, valid: false, managed: false });
        continue;
      }
      const id = src.sourceId(s);
      if (seen.has(id)) continue;
      seen.add(id);
      const known = this.catalog.find((c) => c.id === id);
      out.push({
        ...e,
        url: s.url,
        branch: e.branch || s.branch || null,
        id,
        name: known ? known.name : s.repo.replace(/[-_.]?(3\.?3\.?5a?|wotlk|wrath)$/i, '').replace(/[-_]+/g, ' '),
        owner: s.owner,
        valid: true,
        managed: Boolean(this.find(id)),
        inCatalog: Boolean(known),
      });
    }
    return out;
  }

  /**
   * Install several entries one after another (keeps the API load polite).
   * Already-managed entries are skipped, not reported as failures.
   */
  async importMany(entries, onProgress = () => {}) {
    const results = [];
    for (const e of entries) {
      let r;
      try {
        const res = await this.add(e.url, { branch: e.branch || undefined });
        r = { url: e.url, id: res.addon.id, ok: true, warnings: res.warnings };
      } catch (err) {
        const skipped = /already managed/.test(err.message);
        r = { url: e.url, ok: skipped, skipped, error: skipped ? null : err.message };
      }
      results.push(r);
      onProgress(results.length, entries.length, r);
    }
    return results;
  }

  setCatalog(entries) {
    this.catalog = Array.isArray(entries) ? entries : [];
  }

  /** Resolve repo metadata and the best branch for 3.3.5a. */
  async resolve(url, branch) {
    const s = src.parseRepoUrl(url);
    const ep = src.endpoints(s);
    const branches = src.branchNamesOf(await this.http.json(ep.branches).catch(() => []));
    // A link like ".../tree/main/addon/PocketVendor" names a branch *and* a folder.
    // Branch names may contain "/", so split using the real branch list.
    const { ref, subpath } = src.splitRefPath(branch || s.branch, branches);
    const wanted = ref;
    // An explicit branch that exists (or that we can't verify) is used as-is.
    if (wanted && (!branches.length || branches.includes(wanted))) {
      return { source: s, branch: wanted, branchPinned: true, branches, subpath };
    }
    // Shared configs often name a branch that was later renamed (e.g. "main" vs "master"):
    // fall back to the best existing branch instead of failing with "Not found".
    const repo = await this.http.json(ep.repo);
    const chosen = src.pickBranch(branches, src.defaultBranchOf(s, repo), null);
    return { source: s, branch: chosen, branchPinned: false, branches, subpath, ...(wanted ? { fallbackFrom: wanted } : {}) };
  }

  async headOf(addon) {
    const s = src.parseRepoUrl(addon.url);
    const json = await this.http.json(src.endpoints(s).commit(addon.branch));
    const c = src.commitOf(s, json);
    if (!c || !c.sha) throw new Error('Could not read latest commit');
    return c;
  }

  /**
   * Add a new addon from a repository URL and install it.
   * @param {string} url
   * @param {{branch?:string, adoptFolders?:string[]}} [opts]
   */
  async add(url, opts = {}) {
    const r = await this.resolve(url, opts.branch);
    const id = src.sourceId(r.source);
    if (this.find(id)) throw new Error('This repository is already managed');
    const addon = {
      id,
      url: r.source.url,
      provider: r.source.provider,
      branch: r.branch,
      branchPinned: r.branchPinned,
      // Only install from this folder of the repo (e.g. the addon inside a server module).
      subpath: r.subpath || null,
      folders: opts.adoptFolders || [],
      // When linking local folders, only install those from the repo (collection repos).
      // Callers that know the repo's full folder list (the catalog) pass include: null.
      include: opts.include !== undefined ? opts.include : opts.adoptFolders && opts.adoptFolders.length ? opts.adoptFolders : null,
      installedSha: null,
      installedAt: null,
      commitDate: null,
      lastError: null,
    };
    this.state.addons.push(addon);
    try {
      const result = await this.install(addon);
      if (r.fallbackFrom) result.warnings.unshift(`Branch "${r.fallbackFrom}" does not exist in ${r.source.path}; used "${r.branch}" instead`);
      return { addon, ...result, branches: r.branches };
    } catch (err) {
      this.state.addons = this.state.addons.filter((a) => a !== addon);
      throw err;
    } finally {
      await this.save();
    }
  }

  /** Download and install the head of an addon's branch. */
  async install(addon, head) {
    head = head || (await this.headOf(addon));
    const s = src.parseRepoUrl(addon.url);
    this.log(`Downloading ${addon.id}@${addon.branch} (${head.sha.slice(0, 7)})`);
    const bytes = await this.http.buffer(src.endpoints(s).archive(head.sha));
    const files = limitToSubpath(readArchive(bytes), addon.subpath);
    const all = findAddons(files, { repoName: s.repo });
    if (!all.length) {
      throw new Error(addon.subpath ? `No addon (.toc file) found in ${addon.subpath}/` : 'No addon (.toc file) found in the repository');
    }
    const found = applyInclude(all, addon.include);
    const warnings = [];
    for (const f of found) {
      if (f.compat === 'newer') {
        warnings.push(`${f.name} targets interface ${f.interface} (newer than 3.3.5a's 30300) and may not work`);
      }
    }
    const folders = found.map((f) => ({ name: f.name, files: filesForAddon(files, f) }));
    const result = await installer.installFolders(this.wowDir, addon.id, folders, {
      previousFolders: addon.folders,
      meta: { sha: addon.installedSha, branch: addon.branch, commitDate: addon.commitDate },
    });
    Object.assign(addon, {
      folders: result.installed,
      installedSha: head.sha,
      installedAt: new Date().toISOString(),
      commitDate: head.date || null,
      remoteSha: head.sha,
      remoteDate: head.date || null,
      lastError: null,
    });
    const missing = missingDependencies(await scanAddons(this.addonsDir));
    const mine = new Set(result.installed.map((n) => n.toLowerCase()));
    const missingDeps = [];
    for (const [dep, neededBy] of missing) {
      // Name the folder we just installed, not whichever other addon also lacks the dependency.
      const ours = neededBy.filter((n) => mine.has(n.toLowerCase()));
      if (!ours.length) continue;
      missingDeps.push({ name: dep, neededBy: ours, catalog: catalogFor(this.catalog, [dep]) });
      warnings.push(`${ours[0]} requires ${dep}, which is not installed`);
    }
    return { installed: result.installed, removed: result.removed, warnings, missingDeps };
  }

  /** Check all managed addons for updates (cheap: ETag-cached commit lookups). */
  async checkAll() {
    const targets = this.state.addons.filter((a) => !a.ignored);
    const results = await mapLimit(targets, CONCURRENCY, async (a) => {
      const head = await this.headOf(a);
      a.remoteSha = head.sha;
      a.remoteDate = head.date || null;
      a.lastError = null;
      return head;
    });
    results.forEach((r, i) => {
      if (!r.ok) targets[i].lastError = r.error.message;
    });
    await this.save();
    return results.map((r, i) => ({ id: targets[i].id, ok: r.ok, error: r.ok ? null : r.error.message }));
  }

  /** Update the given addons (or all with updates available). */
  async update(ids) {
    const targets = ids
      ? ids.map((id) => this.find(id)).filter(Boolean)
      : this.state.addons.filter((a) => !a.ignored && a.remoteSha && a.remoteSha !== a.installedSha);
    const results = await mapLimit(targets, Math.min(3, CONCURRENCY), async (a) => {
      try {
        return await this.install(a);
      } catch (err) {
        a.lastError = err.message;
        throw err;
      }
    });
    await this.save();
    return results.map((r, i) => ({
      id: targets[i].id,
      ok: r.ok,
      error: r.ok ? null : r.error.message,
      warnings: r.ok ? r.value.warnings : [],
    }));
  }

  async changeBranch(id, branch) {
    const a = this.find(id);
    if (!a) throw new Error('Unknown addon');
    a.branch = branch;
    a.branchPinned = true;
    a.remoteSha = null;
    const result = await this.install(a);
    await this.save();
    return result;
  }

  /**
   * Commits between the installed version and the latest remote version.
   * @returns {Promise<{commits:Array<{sha:string, title:string, body:string, author:string|null, date:string|null, url:string}>,
   *   total:number, unavailable?:string}>}
   */
  async changes(id) {
    const a = this.find(id);
    if (!a) throw new Error('Unknown addon');
    if (!a.installedSha) return { commits: [], total: 0, unavailable: 'Nothing installed yet' };
    const head = a.remoteSha || (await this.headOf(a)).sha;
    if (head === a.installedSha) return { commits: [], total: 0 };
    const s = src.parseRepoUrl(a.url);
    const ep = src.endpoints(s);
    let json;
    try {
      json = await this.http.json(ep.compare(a.installedSha, head));
    } catch (err) {
      // Typically a force-push removed the installed commit from history.
      if (err.status === 404) return { commits: [], total: 0, unavailable: 'The installed commit is no longer in the branch history (force-push?)' };
      throw err;
    }
    const { commits, total } = src.compareOf(s, json);
    return {
      total,
      commits: commits.map((c) => {
        const [title, ...rest] = String(c.message).split(/\r?\n/);
        return { sha: c.sha, title, body: rest.join('\n').trim(), author: c.author, date: c.date, url: ep.commitUrl(c.sha) };
      }),
    };
  }

  async branches(id) {
    const a = this.find(id);
    const s = src.parseRepoUrl(a.url);
    return src.branchNamesOf(await this.http.json(src.endpoints(s).branches));
  }

  async backups(id) {
    return installer.listBackups(this.wowDir, id);
  }

  async rollback(id, backupId) {
    const a = this.find(id);
    if (!a) throw new Error('Unknown addon');
    const { restored, meta } = await installer.restoreBackup(this.wowDir, id, backupId, a.folders);
    a.folders = restored;
    a.installedSha = (meta && meta.sha) || null;
    a.commitDate = (meta && meta.commitDate) || null;
    a.installedAt = new Date().toISOString();
    await this.save();
    return { restored };
  }

  /** Stop managing an addon; optionally move its folders to the backup area. */
  async remove(id, { deleteFiles = false } = {}) {
    const a = this.find(id);
    if (!a) return { removed: [] };
    let removed = [];
    if (deleteFiles) removed = (await installer.uninstallFolders(this.wowDir, id, a.folders)).removed;
    this.state.addons = this.state.addons.filter((x) => x !== a);
    await this.save();
    return { removed };
  }

  setIgnored(id, ignored) {
    const a = this.find(id);
    if (a) a.ignored = Boolean(ignored);
    return this.save();
  }

  /**
   * Search for repositories that might host a local addon. Uses TOC hints first,
   * then GitHub search biased toward 3.3.5a / WotLK backports.
   */
  async suggest(folder, title, hints = []) {
    const out = [];
    const seen = new Set();
    const push = (c) => {
      const key = c.url.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(c);
      }
    };
    const known = catalogFor(this.catalog, [folder]);
    if (known) push({ url: known.url, name: known.name, description: known.description || 'From the addon catalog', stars: null, source: 'catalog', score: 200 });
    for (const h of hints) {
      try {
        const s = src.parseRepoUrl(h);
        push({ url: s.url, name: s.path, description: 'From the addon’s TOC metadata', stars: null, source: 'toc', score: 100 });
      } catch {
        /* not a repo */
      }
    }
    const name = folder.replace(/[-_]?(core|main)$/i, '') || folder;
    const queries = [`${name} 3.3.5 in:name,description,readme`, `${name} wotlk in:name,description`, `${name} in:name language:Lua`];
    const needle = normalize(name);
    for (const q of queries) {
      if (out.length >= 8) break;
      try {
        const json = await this.http.json(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=10`);
        for (const item of json.items || []) {
          // Readme matches are noisy: the addon name must appear in the repo name or description.
          if (!normalize(`${item.name} ${item.description || ''}`).includes(needle)) continue;
          // ...and it must look like a WoW addon at all (generic names hit unrelated projects).
          if (!looksLikeWowAddon(item)) continue;
          push(scoreRepo(item, name));
        }
      } catch (err) {
        if (err.rateLimited) break;
      }
    }
    return out.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 10);
  }
}

function scoreRepo(item, name) {
  const text = `${item.name} ${item.description || ''} ${(item.topics || []).join(' ')}`.toLowerCase();
  let score = Math.log10((item.stargazers_count || 0) + 1);
  if (item.name.toLowerCase() === name.toLowerCase()) score += 3;
  else if (item.name.toLowerCase().includes(name.toLowerCase())) score += 1.5;
  if (/3\.?3\.?5|wotlk|wrath|lich/.test(text)) score += 3;
  if (/retail|dragonflight|shadowlands|classic era|cataclysm/.test(text)) score -= 1;
  if (item.archived) score -= 0.5;
  return {
    url: item.html_url,
    name: item.full_name,
    description: item.description,
    stars: item.stargazers_count,
    updated: item.pushed_at,
    score,
    source: 'search',
  };
}

/** Keep only the files under `subpath` (paths stay as they are). */
function limitToSubpath(files, subpath) {
  if (!subpath) return files;
  const pre = `${subpath.replace(/^\/+|\/+$/g, '')}/`;
  const out = {};
  for (const [p, data] of Object.entries(files)) if (p.startsWith(pre)) out[p] = data;
  return out;
}

function looksLikeWowAddon(item) {
  if (String(item.language || '').toLowerCase() === 'lua') return true;
  const text = `${item.name} ${item.description || ''} ${(item.topics || []).join(' ')}`.toLowerCase();
  return /\b(wow|warcraft|addons?|wotlk|wrath|3\.3\.5a?|azeroth|raid|ui)\b/.test(text);
}

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Narrow the folders found in a repo to an include list (used when a repo is a
 * collection of many addons and only some of them were linked). Falls back to
 * everything when the list matches nothing, so a renamed addon still installs.
 */
function applyInclude(found, include) {
  if (!include || !include.length) return found;
  const wanted = new Set(include.map((n) => n.toLowerCase()));
  const hit = found.filter((f) => wanted.has(f.name.toLowerCase()));
  return hit.length ? hit : found;
}

function isRepoUrl(u) {
  try {
    const s = src.parseRepoUrl(u);
    return s.provider !== 'gitea' || /codeberg|gitea|forgejo/.test(s.host);
  } catch {
    return false;
  }
}

function statusOf(a, missing) {
  if (a.lastError) return 'error';
  if (!a.installedSha) return 'not-installed';
  if (missing.length) return 'missing';
  if (a.remoteSha && a.remoteSha !== a.installedSha) return 'update';
  if (!a.remoteSha) return 'unknown';
  return 'ok';
}

/** Locate the WoW folder from a path to Wow.exe or the folder itself. */
function wowDirFrom(p) {
  return /\.exe$/i.test(p) ? path.dirname(p) : p;
}

module.exports = { Updater, statusOf, scoreRepo, wowDirFrom, applyInclude };
