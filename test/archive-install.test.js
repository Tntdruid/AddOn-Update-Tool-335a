'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { readArchive, findAddons, filesForAddon } = require('../src/core/archive');
const installer = require('../src/core/installer');
const { scanAddons, groupFolders } = require('../src/core/scanner');
const { makeZip, toc, makeWow } = require('./helpers');

const names = (found) => found.map((f) => f.name).sort();

test('root-level addon is renamed from "Repo-master" to its TOC name', () => {
  const files = readArchive(makeZip({ 'Bagnon-master/Bagnon.toc': toc('Bagnon'), 'Bagnon-master/main.lua': 'x', 'Bagnon-master/README.md': 'r' }));
  const found = findAddons(files, { repoName: 'Bagnon' });
  assert.deepEqual(names(found), ['Bagnon']);
  assert.ok(filesForAddon(files, found[0])['main.lua']);
});

test('multi-module repo installs each folder and skips embedded libs', () => {
  const files = readArchive(
    makeZip({
      'dbm-abc/DBM-Core/DBM-Core.toc': toc('DBM'),
      'dbm-abc/DBM-Core/Libs/LibStub/LibStub.toc': toc('LibStub'),
      'dbm-abc/DBM-Party/DBM-Party.toc': toc('Party'),
      'dbm-abc/.github/workflows/x.toc': toc('nope'),
      'dbm-abc/README.md': 'r',
    }),
  );
  const found = findAddons(files);
  assert.deepEqual(names(found), ['DBM-Core', 'DBM-Party']);
  const core = found.find((f) => f.name === 'DBM-Core');
  assert.ok(filesForAddon(files, core)['Libs/LibStub/LibStub.toc']);
});

test('the folder others depend on is listed first (regression: DBM title came from DBM-AQ20)', () => {
  const files = readArchive(
    makeZip({
      'r/DBM-AQ20/DBM-AQ20.toc': toc('AQ20', 30300, '## Dependencies: DBM-Core'),
      'r/DBM-Core/DBM-Core.toc': toc('DBM'),
      'r/DBM-GUI/DBM-GUI.toc': toc('GUI', 30300, '## Dependencies: DBM-Core'),
    }),
  );
  assert.deepEqual(findAddons(files, { repoName: 'DBM-Warmane' }).map((f) => f.name), ['DBM-Core', 'DBM-AQ20', 'DBM-GUI']);
});

test('nested Interface/AddOns layout is found', () => {
  const files = readArchive(makeZip({ 'r-sha/Interface/AddOns/Foo/Foo.toc': toc('Foo'), 'r-sha/Interface/AddOns/Foo/a.lua': '' }));
  assert.deepEqual(names(findAddons(files)), ['Foo']);
});

test('flavour-only TOC gets a plain TOC so 3.3.5a can load it', () => {
  const files = readArchive(makeZip({ 'x/Foo-Wrath.toc': toc('Foo', 30300), 'x/Foo-Mainline.toc': toc('Foo', 110000), 'x/a.lua': '' }));
  const [foo] = findAddons(files, { repoName: 'Foo' });
  assert.equal(foo.name, 'Foo');
  assert.equal(foo.compat, 'ok');
  assert.ok(filesForAddon(files, foo)['Foo.toc']);
});

test('newer interface is flagged', () => {
  const files = readArchive(makeZip({ 'x/Foo.toc': toc('Foo', 30403) }));
  assert.equal(findAddons(files, { repoName: 'Foo' })[0].compat, 'newer');
});

test('archive with ".." paths is rejected', () => {
  assert.throws(() => readArchive(makeZip({ 'a/../../evil.txt': 'x' })), /Unsafe/);
});

test('install backs up, removes stale folders, and rollback restores', async () => {
  const wow = await makeWow({ Foo: { 'Foo.toc': toc('Foo'), 'old.lua': 'v1' }, Foo_Old: { 'Foo_Old.toc': toc('x') }, Other: { 'Other.toc': toc('o') } });
  const ad = installer.layout(wow).addons;
  const r = await installer.installFolders(wow, 'gh/foo', [{ name: 'Foo', files: { 'Foo.toc': Buffer.from(toc('Foo')), 'new.lua': Buffer.from('v2') } }], {
    previousFolders: ['Foo', 'Foo_Old'],
    meta: { sha: 'aaa' },
  });
  assert.deepEqual(r.installed, ['Foo']);
  assert.deepEqual(r.removed, ['Foo_Old']);
  assert.equal(await fs.readFile(path.join(ad, 'Foo', 'new.lua'), 'utf8'), 'v2');
  await assert.rejects(fs.access(path.join(ad, 'Foo', 'old.lua')));
  await assert.rejects(fs.access(path.join(ad, 'Foo_Old')));
  await fs.access(path.join(ad, 'Other', 'Other.toc')); // untouched
  await assert.rejects(fs.access(installer.layout(wow).staging));

  const backups = await installer.listBackups(wow, 'gh/foo');
  assert.equal(backups.length, 1);
  assert.equal(backups[0].meta.sha, 'aaa');
  await installer.restoreBackup(wow, 'gh/foo', backups[0].id, ['Foo']);
  assert.equal(await fs.readFile(path.join(ad, 'Foo', 'old.lua'), 'utf8'), 'v1');
  await fs.access(path.join(ad, 'Foo_Old', 'Foo_Old.toc'));
  assert.equal((await installer.listBackups(wow, 'gh/foo')).length, 2);
});

test('backups are pruned to the last 5', async () => {
  const wow = await makeWow();
  for (let i = 0; i < 7; i++) {
    await installer.installFolders(wow, 'id', [{ name: 'Foo', files: { 'Foo.toc': Buffer.from(toc('Foo')) } }], {
      now: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
    });
  }
  assert.equal((await installer.listBackups(wow, 'id')).length, installer.MAX_BACKUPS);
});

test('unsafe folder names are refused', async () => {
  const wow = await makeWow();
  await assert.rejects(installer.installFolders(wow, 'id', [{ name: '..', files: {} }]), /Unsafe/);
  await assert.rejects(installer.installFolders(wow, 'id', [{ name: 'a/b', files: {} }]), /Unsafe/);
});

test('scanner groups modules under their parent addon', async () => {
  const wow = await makeWow({
    'DBM-Core': { 'DBM-Core.toc': toc('DBM') },
    'DBM-Party': { 'DBM-Party.toc': toc('P', 30300, '## Dependencies: DBM-Core') },
    Quartz: { 'Quartz.toc': toc('Quartz') },
    Quartz_Options: { 'Quartz_Options.toc': toc('QO') },
    NoToc: { 'readme.txt': '' },
    Blizzard_Foo: { 'Blizzard_Foo.toc': toc('B') },
  });
  const folders = await scanAddons(installer.layout(wow).addons);
  assert.ok(!folders.some((f) => f.folder === 'Blizzard_Foo'));
  assert.equal(folders.find((f) => f.folder === 'NoToc').compat, 'missing-toc');
  const { groups, managed } = groupFolders(folders, [{ id: 'q', folders: ['Quartz', 'Quartz_Options'] }]);
  assert.deepEqual(managed.q.map((f) => f.folder).sort(), ['Quartz', 'Quartz_Options']);
  const dbm = groups.find((g) => g.main && g.main.folder === 'DBM-Core');
  assert.deepEqual(dbm.modules.map((m) => m.folder), ['DBM-Party']);
});
