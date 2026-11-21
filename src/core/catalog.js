'use strict';

const { parseRepoUrl, sourceId } = require('./source');

/** Where the app fetches the latest catalog from, so it can grow without app releases. */
const REMOTE_CATALOG_URL = 'https://raw.githubusercontent.com/Tntdruid/AddOn-Update-Tool-335a/main/src/catalog/addons.json';

/**
 * Validate and normalize raw catalog JSON.
 * Invalid entries are dropped rather than failing the whole catalog.
 * @returns {Array<{id:string, name:string, url:string, branch:string|null, folders:string[],
 *   category:string, description:string, author:string|null, stars:number|null}>}
 */
function normalizeCatalog(json) {
  const list = Array.isArray(json) ? json : json && Array.isArray(json.addons) ? json.addons : [];
  const out = [];
  const seen = new Set();
  for (const e of list) {
    if (!e || typeof e.url !== 'string' || typeof e.name !== 'string') continue;
    let s;
    try {
      s = parseRepoUrl(e.url);
    } catch {
      continue;
    }
    const id = sourceId(s);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: e.name.trim(),
      url: s.url,
      branch: typeof e.branch === 'string' && e.branch.trim() ? e.branch.trim() : s.branch,
      folders: Array.isArray(e.folders) ? e.folders.filter((f) => typeof f === 'string' && f) : [],
      category: typeof e.category === 'string' && e.category ? e.category : 'Other',
      description: typeof e.description === 'string' ? e.description : '',
      author: typeof e.author === 'string' ? e.author : s.owner,
      stars: Number.isFinite(e.stars) ? e.stars : null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/**
 * Find the catalog entry that provides any of the given folder names.
 * Entries that list the folder first (their main folder) win over ones that merely include it.
 */
function catalogFor(catalog, folderNames) {
  if (!catalog || !catalog.length) return null;
  const wanted = folderNames.map((f) => String(f).toLowerCase());
  let best = null;
  let bestRank = Infinity;
  for (const entry of catalog) {
    const idx = entry.folders.findIndex((f) => wanted.includes(f.toLowerCase()));
    if (idx < 0) continue;
    // Prefer main-folder matches, then smaller repos (less likely to be a big collection).
    const rank = (idx === 0 ? 0 : 1000) + entry.folders.length;
    if (rank < bestRank) {
      best = entry;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * Load the catalog: the remote copy when reachable (ETag-cached), else the bundled copy.
 * @param {{json:(url:string)=>Promise<any>}} http
 * @param {any} bundled bundled catalog JSON
 */
async function loadCatalog(http, bundled) {
  try {
    const remote = normalizeCatalog(await http.json(REMOTE_CATALOG_URL));
    if (remote.length) return { entries: remote, source: 'remote' };
  } catch {
    /* offline or not published yet */
  }
  return { entries: normalizeCatalog(bundled), source: 'bundled' };
}

module.exports = { normalizeCatalog, catalogFor, loadCatalog, REMOTE_CATALOG_URL };
