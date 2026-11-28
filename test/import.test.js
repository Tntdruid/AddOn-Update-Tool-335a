'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseConfigEntries, parseLegacyConfig, configRawUrl } = require('../src/core/state');
const { Updater } = require('../src/core/updater');
const { normalizeCatalog } = require('../src/core/catalog');
const { makeZip, toc, makeWow, response, fakeFetch } = require('./helpers');

// Shaped like the shared config in NoM0Re/WoW-3.3.5a-Addons: everything commented out.
const SHARED = `### AddOns Update Tool WotLK 3.3.5a
# AddOns are sorted alphabetically by name.

# DBM (https://discord.gg/xyz)
# https://github.com/Zidras/DBM-Warmane : main        # Latest DBM
# https://github.com/Vargoth86/DBM-Rising-Gods : main # DBM for Rising Gods

# bkader AddOns
https://github.com/bkader/KPack : main
# https://gitlab.com/tsoukie-3.3.5/classicapi : main
# not a url : nope
`;

test('parseConfigEntries keeps commented entries, sections and notes (regression: shared configs imported 0 addons)', () => {
  const e = parseConfigEntries(SHARED);
  assert.equal(e.length, 4);
  assert.deepEqual(e[0], {
    url: 'https://github.com/Zidras/DBM-Warmane',
    branch: 'main',
    enabled: false,
    section: 'DBM (https://discord.gg/xyz)',
    note: 'Latest DBM',
  });
  assert.equal(e[2].enabled, true);
  assert.equal(e[2].section, 'bkader AddOns');
  assert.equal(e[3].url, 'https://gitlab.com/tsoukie-3.3.5/classicapi');
  // The old API still returns only the active entries.
  assert.deepEqual(parseLegacyConfig(SHARED), [{ url: 'https://github.com/bkader/KPack', branch: 'main' }]);
});

test('configRawUrl turns blob links into raw links and refuses non-https', () => {
  assert.equal(
    configRawUrl('https://github.com/NoM0Re/WoW-3.3.5a-Addons/blob/main/src/Addons/config.yaml'),
    'https://raw.githubusercontent.com/NoM0Re/WoW-3.3.5a-Addons/main/src/Addons/config.yaml',
  );
  assert.equal(configRawUrl('https://github.com/o/r/raw/main/c.yaml'), 'https://raw.githubusercontent.com/o/r/main/c.yaml');
  assert.equal(configRawUrl('https://gitlab.com/g/r/-/blob/main/c.yaml'), 'https://gitlab.com/g/r/-/raw/main/c.yaml');
  assert.throws(() => configRawUrl('http://example.com/c.yaml'), /https/);
  assert.throws(() => configRawUrl('nope'), /valid URL/);
});

test('importPreview marks managed, catalog and invalid entries and removes duplicates', async () => {
  const wow = await makeWow();
  const catalog = normalizeCatalog({ addons: [{ name: 'Deadly Boss Mods', url: 'https://github.com/Zidras/DBM-Warmane', folders: ['DBM-Core'] }] });
  const u = await new Updater(wow, { fetch: fakeFetch([]), catalog }).load();
  u.state.addons.push({ id: 'github.com/bkader/kpack', url: 'https://github.com/bkader/KPack', folders: [] });
  const p = u.importPreview([
    ...parseConfigEntries(SHARED),
    { url: 'https://github.com/zidras/dbm-warmane.git', branch: null, enabled: true },
    { url: 'https://github.com/onlyowner', branch: null, enabled: true },
  ]);
  const by = (id) => p.find((x) => x.id === id);
  assert.equal(by('github.com/zidras/dbm-warmane').name, 'Deadly Boss Mods');
  assert.equal(by('github.com/zidras/dbm-warmane').inCatalog, true);
  assert.equal(by('github.com/bkader/kpack').managed, true);
  assert.equal(p.filter((x) => x.id === 'github.com/zidras/dbm-warmane').length, 1);
  assert.equal(p.find((x) => !x.valid).name, 'https://github.com/onlyowner');
});

test('a branch that no longer exists falls back to the best existing one, with a warning (regression)', async () => {
  const wow = await makeWow();
  const fetch = fakeFetch([
    [/repos\/o\/Foo\/branches/, () => response(200, [{ name: 'master' }, { name: 'dev' }])],
    ['https://api.github.com/repos/o/Foo', () => response(200, { default_branch: 'master' })],
    [/repos\/o\/Foo\/commits\/master$/, () => response(200, { sha: 'm', commit: {} })],
    [/codeload/, () => response(200, makeZip({ 'Foo-m/Foo.toc': toc('Foo') }))],
  ]);
  const u = await new Updater(wow, { fetch }).load();
  const r = await u.add('https://github.com/o/Foo', { branch: 'main' });
  assert.equal(r.addon.branch, 'master');
  assert.equal(r.addon.branchPinned, false);
  assert.match(r.warnings[0], /Branch "main" does not exist.*used "master"/);
});

test('an existing explicit branch is kept and pinned', async () => {
  const wow = await makeWow();
  const fetch = fakeFetch([
    [/branches/, () => response(200, [{ name: 'master' }, { name: 'wotlk' }])],
    [/commits\/master$/, () => response(200, { sha: 'm', commit: {} })],
    [/codeload/, () => response(200, makeZip({ 'Foo-m/Foo.toc': toc('Foo') }))],
  ]);
  const u = await new Updater(wow, { fetch }).load();
  const r = await u.add('https://github.com/o/Foo', { branch: 'master' });
  assert.equal(r.addon.branch, 'master');
  assert.equal(r.addon.branchPinned, true);
  assert.deepEqual(r.warnings, []);
});

test('importMany installs in order, skips managed ones and keeps going after failures', async () => {
  const wow = await makeWow();
  const fetch = fakeFetch([
    [/repos\/o\/(A|B)\/commits/, (url) => response(200, { sha: url.includes('/A/') ? 'a' : 'b', commit: {} })],
    [/codeload.*\/A\//, () => response(200, makeZip({ 'A-a/A.toc': toc('A') }))],
    [/codeload.*\/B\//, () => response(200, makeZip({ 'B-b/B.toc': toc('B') }))],
  ]);
  const u = await new Updater(wow, { fetch }).load();
  await u.add('https://github.com/o/A', { branch: 'main' });
  const progress = [];
  const r = await u.importMany(
    [
      { url: 'https://github.com/o/A', branch: 'main' },
      { url: 'https://github.com/o/Missing', branch: 'main' },
      { url: 'https://github.com/o/B', branch: 'main' },
    ],
    (done, total) => progress.push(`${done}/${total}`),
  );
  assert.deepEqual(progress, ['1/3', '2/3', '3/3']);
  assert.deepEqual(r.map((x) => [x.ok, Boolean(x.skipped)]), [[true, true], [false, false], [true, false]]);
  assert.equal(u.state.addons.length, 2);
});

/* ---------- links to a folder inside a repo ---------- */

const { splitRefPath } = require('../src/core/source');

test('splitRefPath separates branch and folder using the real branch list', () => {
  assert.deepEqual(splitRefPath('main/addon/PocketVendor', ['main', 'dev']), { ref: 'main', subpath: 'addon/PocketVendor' });
  // Branch names with "/" win over shorter prefixes.
  assert.deepEqual(splitRefPath('feature/x/addon/Foo', ['feature', 'feature/x']), { ref: 'feature/x', subpath: 'addon/Foo' });
  assert.deepEqual(splitRefPath('feature/x', ['feature', 'feature/x']), { ref: 'feature/x', subpath: null });
  assert.deepEqual(splitRefPath('main/addon/', ['main']), { ref: 'main', subpath: 'addon' });
  // Without a branch list, nothing can be split safely.
  assert.deepEqual(splitRefPath('main/addon', []), { ref: 'main/addon', subpath: null });
  assert.deepEqual(splitRefPath(null, ['main']), { ref: null, subpath: null });
});

test('a /tree/<branch>/<folder> link installs only that folder, with no branch warning (regression)', async () => {
  const wow = await makeWow();
  const fetch = fakeFetch([
    [/repos\/o\/mod-thing\/branches/, () => response(200, [{ name: 'main' }])],
    [/repos\/o\/mod-thing\/commits\/main$/, () => response(200, { sha: 's', commit: {} })],
    [
      /codeload/,
      () =>
        response(
          200,
          makeZip({
            'm-s/addon/PocketVendor/PocketVendor.toc': toc('PocketVendor'),
            'm-s/addon/PocketVendor/a.lua': '',
            'm-s/tools/Other/Other.toc': toc('Other'),
            'm-s/src/server.cpp': '',
          }),
        ),
    ],
  ]);
  const u = await new Updater(wow, { fetch }).load();
  const r = await u.add('https://github.com/o/mod-thing/tree/main/addon/PocketVendor');
  assert.equal(r.addon.branch, 'main');
  assert.equal(r.addon.subpath, 'addon/PocketVendor');
  assert.deepEqual(r.installed, ['PocketVendor']);
  assert.deepEqual(r.warnings, []);
  // Updates keep using the folder.
  const again = await u.update([r.addon.id]);
  assert.ok(again[0].ok);
  assert.deepEqual(u.find(r.addon.id).folders, ['PocketVendor']);
});

test('the missing-dependency warning names the addon just installed (regression)', async () => {
  const wow = await makeWow({ Other: { 'Other.toc': toc('Other', 30300, '## Dependencies: Ace3') } });
  const fetch = fakeFetch([
    [/commits/, () => response(200, { sha: 's', commit: {} })],
    [/codeload/, () => response(200, makeZip({ 'M-s/MyAutoVendor.toc': toc('MyAutoVendor', 30300, '## Dependencies: Ace3') }))],
  ]);
  const u = await new Updater(wow, { fetch }).load();
  const r = await u.add('https://github.com/o/MyAutoVendor', { branch: 'main' });
  assert.deepEqual(r.warnings, ['MyAutoVendor requires Ace3, which is not installed']);
  assert.deepEqual(r.missingDeps[0].neededBy, ['MyAutoVendor']);
});
