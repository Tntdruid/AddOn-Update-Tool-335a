#!/usr/bin/env node
'use strict';

/**
 * Build src/catalog/addons.json from GitHub.
 *
 * Finds candidate 3.3.5a addon repositories with GitHub search, then verifies
 * each one: it must contain an addon whose .toc says "## Interface: 30300" on the
 * branch the app would pick. Folder names are computed with the same logic the
 * app uses when installing, so catalog folders match what ends up in AddOns.
 *
 *   GITHUB_TOKEN=... node tools/build-catalog.js [--min-stars 3] [--dry-run]
 *
 * tools/catalog-config.json can force-include or exclude repositories and
 * override names/categories.
 */

const fs = require('node:fs');
const path = require('node:path');
const { findAddons } = require('../src/core/archive');
const { parseRepoUrl, pickBranch, sourceId } = require('../src/core/source');
const { mapLimit } = require('../src/core/http');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'catalog', 'addons.json');
const CONFIG = path.join(__dirname, 'catalog-config.json');
const args = process.argv.slice(2);
const MIN_STARS = Number(args[args.indexOf('--min-stars') + 1]) || 3;
const DRY = args.includes('--dry-run');
const MAX_TOCS = 60; // bigger repos are addon packs, not single addons
const MAX_FOLDERS = 40;

const QUERIES = [
  'topic:wotlk language:Lua',
  'topic:3-3-5a',
  'topic:335a',
  'topic:3-3-5',
  'topic:wotlk-addon',
  'topic:wow-addon wotlk',
  'topic:wow-addon 3.3.5',
  '3.3.5a in:name,description language:Lua',
  '3.3.5 addon in:name,description language:Lua',
  'wotlk addon in:name,description language:Lua',
  'warmane in:name,description language:Lua',
  'backport 3.3.5 in:description language:Lua',
];

// First match wins, so specific categories come before broad ones.
// Only the start of words is anchored, so "auction" also matches "Auctionator".
const CATEGORIES = [
  ['Unit frames', /\b(unit ?frame|ouf|raid ?frame|party ?frame|nameplate|plates|grid|healbot|vuhdo|cell\b|x-?perl|pitbull|shadowed)/],
  ['Action bars', /\b(action ?bar|actionbar|bartender|dominos|keybind|macaroon|console ?port)/],
  ['Bags & inventory', /\b(bag|inventory|bank|bagnon|arkinventory|adibags|loot)/],
  ['Boss mods & raiding', /\b(boss|dbm|bigwigs|deadly boss|encounter|raid ?tool|raid ?browser|dungeon|dungeon ?map|instance)/],
  ['Combat & DPS', /\b(dps|damage|meter|recount|skada|details|threat|omen|weakaura|aura|cooldown|sct|combat text|buffs?|debuffs?)/],
  ['Professions & economy', /\b(auction|profession|tradeskill|gold|crafting|ah\b|economy|mail)/],
  ['Quests & leveling', /\b(quest|leveling|levelling|guide|questie|zygor|restedxp|storyline|immersion)/],
  ['PvP', /\b(pvp|arena|battleground|gladius)/],
  ['Class & rotation', /\b(rotation|druid|paladin|pally|warrior|rogue|hunter|mage|priest|shaman|warlock|death ?knight|totem|gse|sequence)/],
  ['Transmog & cosmetics', /\b(transmog|mogit|dress|wardrobe|appearance|morph)/],
  ['Maps & navigation', /\b(map|minimap|carbonite|coordinates|tomtom|navigation|gps)/],
  ['Interface & UI', /\b(ui\b|interface|chat|tooltip|skin|elvui|tukui|frame|hud|retail ?ui|dragon ?ui|pretty)/],
];

/** Repos that ship Blizzard's own UI code rather than an addon. */
const NOT_ADDON = /^(FrameXML|GlueXML|Blizzard_|SharedXML)/i;

async function main() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('Set GITHUB_TOKEN (e.g. GITHUB_TOKEN=$(gh auth token))');
  const config = fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, 'utf8')) : {};
  const exclude = new Set((config.exclude || []).map((u) => sourceId(parseRepoUrl(u))));
  const overrides = config.overrides || {};

  const api = async (url) => {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'aut-catalog' },
    });
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
      const wait = Math.max(5000, reset - Date.now() + 1000);
      console.error(`rate limited, waiting ${Math.round(wait / 1000)}s`);
      await new Promise((r) => setTimeout(r, Math.min(wait, 70000)));
      return api(url);
    }
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.json();
  };

  // 1. Candidates
  const repos = new Map();
  for (const q of QUERIES) {
    for (let page = 1; page <= 3; page++) {
      const json = await api(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&per_page=100&page=${page}`);
      for (const r of json.items || []) if (!repos.has(r.full_name.toLowerCase())) repos.set(r.full_name.toLowerCase(), r);
      if (!json.items || json.items.length < 100) break;
      await new Promise((r) => setTimeout(r, 2500)); // search API: 30 req/min
    }
  }
  for (const url of config.include || []) {
    const s = parseRepoUrl(url);
    if (!repos.has(s.path.toLowerCase())) repos.set(s.path.toLowerCase(), await api(`https://api.github.com/repos/${s.path}`));
  }
  const candidates = [...repos.values()].filter((r) => {
    const forced = (config.include || []).some((u) => sourceId(parseRepoUrl(u)) === `github.com/${r.full_name}`.toLowerCase());
    if (forced) return true;
    if (exclude.has(`github.com/${r.full_name}`.toLowerCase())) return false;
    if (r.archived || r.disabled) return false;
    return r.stargazers_count >= MIN_STARS;
  });
  console.error(`${repos.size} repos found, ${candidates.length} candidates`);

  // 2. Verify
  const results = await mapLimit(candidates, 8, async (r) => {
    const branches = (await api(`https://api.github.com/repos/${r.full_name}/branches?per_page=100`)).map((b) => b.name);
    const branch = pickBranch(branches, r.default_branch, overrides[r.full_name] && overrides[r.full_name].branch);
    const tree = await api(`https://api.github.com/repos/${r.full_name}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    const blobs = (tree.tree || []).filter((t) => t.type === 'blob').map((t) => t.path);
    const tocs = blobs.filter((p) => /\.toc$/i.test(p));
    if (!tocs.length || tocs.length > MAX_TOCS) return null;
    const files = {};
    for (const p of blobs) files[p] = new Uint8Array(0);
    await Promise.all(
      tocs.map(async (p) => {
        const res = await fetch(`https://raw.githubusercontent.com/${r.full_name}/${encodeURIComponent(branch)}/${p.split('/').map(encodeURIComponent).join('/')}`);
        files[p] = new Uint8Array(await res.arrayBuffer());
      }),
    );
    const found = findAddons(files, { repoName: r.name });
    if (!found.length || found.length > MAX_FOLDERS) return null;
    if (found[0].interface !== 30300) return null;
    if (NOT_ADDON.test(found[0].name)) return null;
    const text = `${r.name} ${r.description || ''} ${(r.topics || []).join(' ')} ${found.map((f) => f.title || '').join(' ')}`.toLowerCase();
    const o = overrides[r.full_name] || {};
    return {
      name: o.name || displayName(found[0], r.name),
      url: r.html_url,
      ...(branch !== r.default_branch ? { branch } : {}),
      folders: found.map((f) => f.name),
      category: o.category || (CATEGORIES.find(([, re]) => re.test(text)) || ['Other'])[0],
      description: o.description || (r.description || '').trim().slice(0, 200),
      author: r.owner.login,
      stars: r.stargazers_count,
    };
  });

  // 3. Keep the best repo per main folder (forks of the same addon), highest stars first.
  const byFolder = new Map();
  let failed = 0;
  for (const res of results) {
    if (!res.ok) {
      failed++;
      continue;
    }
    const e = res.value;
    if (!e) continue;
    const key = e.folders[0].toLowerCase();
    const prev = byFolder.get(key);
    if (!prev || e.stars > prev.stars) byFolder.set(key, e);
  }
  const entries = [...byFolder.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  console.error(`${entries.length} verified 3.3.5a addons (${failed} repos failed to load)`);
  const out = { generated: new Date().toISOString().slice(0, 10), interface: 30300, addons: entries };
  if (DRY) console.log(JSON.stringify(out, null, 2));
  else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
    console.error(`wrote ${path.relative(ROOT, OUT)}`);
  }
}

function cleanName(title) {
  return String(title)
    .replace(/<([^>]*)>/g, ' $1 ') // "<DBM> Core" -> "DBM Core"
    .replace(/\s*[-–|:(]\s*(3\.3\.5a?|wotlk|wrath|backport)[^)]*\)?\s*$/i, '')
    .replace(/^[^\p{L}\p{N}!]+/u, '') // leading "*", "-", "["...
    .replace(/\s+/g, ' ')
    .trim();
}

/** Generic module names ("Core", "Main") say less than the repo name. */
const GENERIC = /^(core|main|base|addon|lib|libs|ui|options?|config)$/i;

function displayName(addon, repoName) {
  const fromToc = cleanName(addon.title || '');
  const fromFolder = cleanName(addon.name.replace(/[-_](core|main)$/i, ''));
  const fromRepo = cleanName(repoName.replace(/[-_.]?(3\.?3\.?5a?|wotlk|wrath|backport)$/i, '').replace(/[-_]+/g, ' '));
  return [fromToc, fromFolder, fromRepo].find((c) => c.length >= 3 && !GENERIC.test(c)) || addon.name;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
