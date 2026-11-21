'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Updater } = require('../src/core/updater');
const { normalizeCatalog, catalogFor, loadCatalog } = require('../src/core/catalog');
const { missingDependencies } = require('../src/core/scanner');
const { compareOf, parseRepoUrl } = require('../src/core/source');
const { makeZip, toc, makeWow, response, fakeFetch } = require('./helpers');

/* ---------- changes ---------- */

test('compareOf normalizes GitHub and GitLab commits, newest first', () => {
  const gh = compareOf(parseRepoUrl('github.com/o/r'), {
    total_commits: 2,
    commits: [
      { sha: 'a1', commit: { message: 'first\n\nbody', committer: { date: '2026-01-01' } }, author: { login: 'x' } },
      { sha: 'b2', commit: { message: 'second', author: { name: 'Y', date: '2026-01-02' } } },
    ],
  });
  assert.deepEqual(gh.commits.map((c) => c.sha), ['b2', 'a1']);
  assert.equal(gh.commits[1].author, 'x');
  assert.equal(gh.commits[0].author, 'Y');
  const gl = compareOf(parseRepoUrl('gitlab.com/g/r'), { commits: [{ id: 'c3', title: 't', message: 'msg', author_name: 'Z', committed_date: 'd' }] });
  assert.deepEqual(gl, { commits: [{ sha: 'c3', message: 'msg', author: 'Z', date: 'd' }], total: 1 });
});

function repoFetch(state, extra = []) {
  return fakeFetch([
    ...extra,
    [/\/commits\/main$/, () => response(200, { sha: state.sha, commit: { committer: { date: '2026-01-01' } } })],
    [/codeload/, () => response(200, makeZip(state.zip || { 'Foo-x/Foo.toc': toc('Foo'), 'Foo-x/a.lua': state.sha }))],
  ]);
}

test('changes lists commits between installed and remote, split into title/body with links', async () => {
  const wow = await makeWow();
  const st = { sha: 'old' };
  const fetch = repoFetch(st, [
    [
      /compare\/old\.\.\.new$/,
      () => response(200, { total_commits: 1, commits: [{ sha: 'new', commit: { message: 'Fix Lich King timer\n\nDetails here' } }] }),
    ],
  ]);
  const u = await new Updater(wow, { fetch }).load();
  const { addon } = await u.add('https://github.com/o/Foo', { branch: 'main' });
  st.sha = 'new';
  await u.checkAll();
  const r = await u.changes(addon.id);
  assert.equal(r.total, 1);
  assert.equal(r.commits[0].title, 'Fix Lich King timer');
  assert.equal(r.commits[0].body, 'Details here');
  assert.equal(r.commits[0].url, 'https://github.com/o/Foo/commit/new');
});

test('changes explains a force-push instead of failing', async () => {
  const wow = await makeWow();
  const st = { sha: 'old' };
  const u = await new Updater(wow, { fetch: repoFetch(st) }).load();
  const { addon } = await u.add('https://github.com/o/Foo', { branch: 'main' });
  st.sha = 'new';
  await u.checkAll();
  const r = await u.changes(addon.id);
  assert.match(r.unavailable, /force-push/);
});

test('changes is empty when up to date', async () => {
  const wow = await makeWow();
  const u = await new Updater(wow, { fetch: repoFetch({ sha: 's' }) }).load();
  const { addon } = await u.add('https://github.com/o/Foo', { branch: 'main' });
  assert.deepEqual(await u.changes(addon.id), { commits: [], total: 0 });
});

/* ---------- dependencies ---------- */

test('missingDependencies ignores installed and Blizzard_ addons, case-insensitively', () => {
  const m = missingDependencies([
    { folder: 'DBM-Party', dependencies: ['dbm-core', 'Blizzard_CombatLog'] },
    { folder: 'DBM-Raid', dependencies: ['DBM-Core'] },
    { folder: 'Foo', dependencies: ['Ace3'] },
    { folder: 'Ace3', dependencies: [] },
  ]);
  assert.deepEqual([...m], [['dbm-core', ['DBM-Party', 'DBM-Raid']]]);
});

const CATALOG = normalizeCatalog({
  addons: [
    { name: 'Deadly Boss Mods', url: 'https://github.com/o/DBM', folders: ['DBM-Core', 'DBM-GUI'], category: 'Boss mods & raiding' },
    { name: 'Big pack', url: 'https://github.com/o/Pack', folders: ['Other', 'DBM-Core', 'X', 'Y'] },
  ],
});

test('overview attaches missing deps to the addon that needs them, with a catalog fix', async () => {
  const wow = await makeWow({ 'DBM-Party': { 'DBM-Party.toc': toc('Party', 30300, '## Dependencies: DBM-Core') } });
  const u = await new Updater(wow, { fetch: fakeFetch([]), catalog: CATALOG }).load();
  const ov = await u.overview();
  assert.equal(ov.missingDeps.length, 1);
  assert.equal(ov.missingDeps[0].catalog.name, 'Deadly Boss Mods'); // main-folder match beats the pack
  assert.equal(ov.unmanaged[0].missingDeps[0].name, 'DBM-Core');
});

test('install reports dependencies the new addon needs; installDependency resolves them from the catalog', async () => {
  const wow = await makeWow();
  const fetch = fakeFetch([
    [/repos\/o\/Party\/commits/, () => response(200, { sha: 'p', commit: {} })],
    [/codeload.*Party/, () => response(200, makeZip({ 'P-p/DBM-Party/DBM-Party.toc': toc('Party', 30300, '## Dependencies: DBM-Core') }))],
    [/repos\/o\/DBM$/, () => response(200, { default_branch: 'main' })],
    [/repos\/o\/DBM\/branches/, () => response(200, [{ name: 'main' }])],
    [/repos\/o\/DBM\/commits/, () => response(200, { sha: 'd', commit: {} })],
    [/codeload.*DBM/, () => response(200, makeZip({ 'D-d/DBM-Core/DBM-Core.toc': toc('DBM'), 'D-d/DBM-GUI/DBM-GUI.toc': toc('GUI') }))],
  ]);
  const u = await new Updater(wow, { fetch, catalog: CATALOG }).load();
  const r = await u.add('https://github.com/o/Party', { branch: 'main' });
  assert.equal(r.missingDeps[0].name, 'DBM-Core');
  assert.match(r.warnings.join(), /requires DBM-Core/);
  await u.installDependency('DBM-Core');
  const ov = await u.overview();
  assert.equal(ov.missingDeps.length, 0);
  await assert.rejects(u.installDependency('Nope'), /not in the catalog/);
});

/* ---------- catalog ---------- */

test('normalizeCatalog drops invalid and duplicate entries and sorts by name', () => {
  const c = normalizeCatalog({
    addons: [
      { name: 'Zeta', url: 'https://github.com/a/zeta', folders: ['Zeta'] },
      { name: 'dup', url: 'github.com/A/Zeta.git' },
      { name: 'bad', url: 'not a url at all/' },
      { url: 'https://github.com/a/noname' },
      { name: 'Alpha', url: 'https://gitlab.com/g/alpha', branch: 'wotlk' },
    ],
  });
  assert.deepEqual(c.map((e) => e.name), ['Alpha', 'Zeta']);
  assert.equal(c[0].branch, 'wotlk');
  assert.equal(c[0].category, 'Other');
});

test('catalogFor prefers main-folder matches over collections', () => {
  assert.equal(catalogFor(CATALOG, ['dbm-core']).name, 'Deadly Boss Mods');
  assert.equal(catalogFor(CATALOG, ['X']).name, 'Big pack');
  assert.equal(catalogFor(CATALOG, ['Nope']), null);
  assert.equal(catalogFor([], ['X']), null);
});

test('loadCatalog falls back to the bundled copy when offline', async () => {
  const offline = { json: async () => Promise.reject(new Error('offline')) };
  const r = await loadCatalog(offline, { addons: [{ name: 'A', url: 'https://github.com/a/a' }] });
  assert.equal(r.source, 'bundled');
  assert.equal(r.entries.length, 1);
  const online = { json: async () => ({ addons: [{ name: 'B', url: 'https://github.com/b/b' }] }) };
  assert.equal((await loadCatalog(online, { addons: [] })).entries[0].name, 'B');
});

test('loadCatalog uses the newer copy (regression: an older remote catalog hid the bundled one)', async () => {
  const remote = (generated) => ({ json: async () => ({ generated, addons: [{ name: 'Remote', url: 'https://github.com/r/r' }] }) });
  const bundled = { generated: '2026-11-21', addons: [{ name: 'Bundled', url: 'https://github.com/b/b' }] };
  assert.equal((await loadCatalog(remote('2026-11-20'), bundled)).source, 'bundled');
  assert.equal((await loadCatalog(remote('2026-11-21'), bundled)).source, 'remote');
  assert.equal((await loadCatalog(remote('2026-12-01'), bundled)).entries[0].name, 'Remote');
});

test('linking from the catalog installs every catalog folder, not just the local ones', async () => {
  const wow = await makeWow({ 'DBM-Core': { 'DBM-Core.toc': toc('DBM') } });
  const fetch = fakeFetch([
    [/commits/, () => response(200, { sha: 'd', commit: {} })],
    [/codeload/, () => response(200, makeZip({ 'D-d/DBM-Core/DBM-Core.toc': toc('DBM'), 'D-d/DBM-GUI/DBM-GUI.toc': toc('GUI') }))],
  ]);
  const u = await new Updater(wow, { fetch, catalog: CATALOG }).load();
  await u.add('https://github.com/o/DBM', { branch: 'main', adoptFolders: ['DBM-Core'], include: null });
  assert.deepEqual((await fs.readdir(path.join(wow, 'Interface', 'AddOns'))).sort(), ['DBM-Core', 'DBM-GUI']);
  const ov = await u.overview();
  assert.equal(ov.catalog.find((c) => c.name === 'Deadly Boss Mods').installed, true);
});

test('suggest puts the catalog match first', async () => {
  const wow = await makeWow();
  const u = await new Updater(wow, { fetch: fakeFetch([[/search/, () => response(200, { items: [] })]]), catalog: CATALOG }).load();
  const s = await u.suggest('DBM-Core', 'DBM', []);
  assert.equal(s[0].source, 'catalog');
  assert.equal(s[0].url, 'https://github.com/o/DBM');
});
