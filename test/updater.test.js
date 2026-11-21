'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Updater } = require('../src/core/updater');
const { HttpClient } = require('../src/core/http');
const { makeZip, toc, makeWow, response, fakeFetch } = require('./helpers');

function githubRepo({ sha = 'sha1', iface = 30300, branches = ['master', 'wotlk'] } = {}) {
  const repo = { sha };
  const fetch = fakeFetch([
    ['https://api.github.com/repos/o/Foo', () => response(200, { default_branch: 'master' })],
    [/\/repos\/o\/Foo\/branches/, () => response(200, branches.map((name) => ({ name })))],
    [
      /\/repos\/o\/Foo\/commits\//,
      (url, init) => {
        const etag = `"${repo.sha}"`;
        if (init.headers['If-None-Match'] === etag) return response(304, null, { 'x-ratelimit-remaining': 59, 'x-ratelimit-limit': 60 });
        return response(200, { sha: repo.sha, commit: { committer: { date: '2026-01-01T00:00:00Z' }, message: 'm' } }, { etag, 'x-ratelimit-remaining': 58, 'x-ratelimit-limit': 60 });
      },
    ],
    [/codeload\.github\.com\/o\/Foo\/zip\//, () => response(200, makeZip({ [`Foo-${repo.sha}/Foo.toc`]: toc('Foo', iface), [`Foo-${repo.sha}/v.lua`]: repo.sha }))],
  ]);
  return { repo, fetch };
}

test('add picks the WotLK branch, installs, and records state next to Wow.exe', async () => {
  const wow = await makeWow();
  const { fetch } = githubRepo();
  const u = await new Updater(wow, { fetch }).load();
  const r = await u.add('https://github.com/o/Foo');
  assert.equal(r.addon.branch, 'wotlk');
  assert.deepEqual(r.installed, ['Foo']);
  assert.ok(fetch.calls.some((c) => c.url.endsWith('/commits/wotlk')));
  assert.equal(await fs.readFile(path.join(wow, 'Interface', 'AddOns', 'Foo', 'v.lua'), 'utf8'), 'sha1');
  const saved = JSON.parse(await fs.readFile(path.join(wow, 'AddonUpdateTool.json'), 'utf8'));
  assert.equal(saved.addons[0].installedSha, 'sha1');
  await assert.rejects(u.add('https://github.com/o/Foo'), /already managed/);
});

test('check uses ETags, detects updates, and update installs them', async () => {
  const wow = await makeWow();
  const { repo, fetch } = githubRepo();
  const u = await new Updater(wow, { fetch }).load();
  await u.add('https://github.com/o/Foo', { branch: 'master' });

  await u.checkAll();
  let ov = await u.overview();
  assert.equal(ov.addons[0].status, 'ok');
  const last = fetch.calls.filter((c) => /commits/.test(c.url)).pop();
  assert.equal(last.headers['If-None-Match'], '"sha1"');

  repo.sha = 'sha2';
  await u.checkAll();
  ov = await u.overview();
  assert.equal(ov.addons[0].status, 'update');
  const res = await u.update();
  assert.ok(res[0].ok);
  ov = await u.overview();
  assert.equal(ov.addons[0].status, 'ok');
  assert.equal(ov.addons[0].installedSha, 'sha2');

  // ETag cache survives a reload of state.
  const u2 = await new Updater(wow, { fetch }).load();
  assert.ok(Object.keys(u2.state.etags).length > 0);
});

test('rollback restores the previous commit and marks it as behind', async () => {
  const wow = await makeWow();
  const { repo, fetch } = githubRepo();
  const u = await new Updater(wow, { fetch }).load();
  const { addon } = await u.add('https://github.com/o/Foo', { branch: 'master' });
  repo.sha = 'sha2';
  await u.checkAll();
  await u.update();
  const [b] = await u.backups(addon.id);
  await u.rollback(addon.id, b.id);
  assert.equal(await fs.readFile(path.join(wow, 'Interface', 'AddOns', 'Foo', 'v.lua'), 'utf8'), 'sha1');
  const ov = await u.overview();
  assert.equal(ov.addons[0].installedSha, 'sha1');
  assert.equal(ov.addons[0].status, 'update');
});

test('adopting a local addon replaces its folders and removes it from "unmanaged"', async () => {
  const wow = await makeWow({ Foo: { 'Foo.toc': toc('Foo'), 'v.lua': 'local' }, Foo_Extra: { 'Foo_Extra.toc': toc('E') } });
  const { fetch } = githubRepo();
  const u = await new Updater(wow, { fetch }).load();
  let ov = await u.overview();
  assert.deepEqual(ov.unmanaged.map((x) => [x.folder, x.modules]), [['Foo', ['Foo_Extra']]]);
  await u.add('https://github.com/o/Foo', { branch: 'master', adoptFolders: ['Foo', 'Foo_Extra'] });
  ov = await u.overview();
  assert.equal(ov.unmanaged.length, 0);
  await assert.rejects(fs.access(path.join(wow, 'Interface', 'AddOns', 'Foo_Extra')));
  assert.equal((await u.backups(ov.addons[0].id))[0].folders.length, 2);
});

test('newer-interface addons install with a warning', async () => {
  const wow = await makeWow();
  const { fetch } = githubRepo({ iface: 110000 });
  const u = await new Updater(wow, { fetch }).load();
  const r = await u.add('https://github.com/o/Foo', { branch: 'master' });
  assert.match(r.warnings[0], /newer than 3\.3\.5a/);
});

test('failed add leaves no state and no files behind', async () => {
  const wow = await makeWow();
  const fetch = fakeFetch([[/commits/, () => response(200, { sha: 'x', commit: {} })], [/codeload/, () => response(200, makeZip({ 'r/README.md': 'no toc' }))]]);
  const u = await new Updater(wow, { fetch }).load();
  await assert.rejects(u.add('https://github.com/o/Foo', { branch: 'master' }), /No addon/);
  assert.equal(u.state.addons.length, 0);
  assert.deepEqual(await fs.readdir(path.join(wow, 'Interface', 'AddOns')), []);
});

test('one failing addon does not stop the others during update', async () => {
  const wow = await makeWow();
  const { repo, fetch } = githubRepo();
  const u = await new Updater(wow, { fetch }).load();
  await u.add('https://github.com/o/Foo', { branch: 'master' });
  u.state.addons.push({ id: 'github.com/o/gone', url: 'https://github.com/o/gone', provider: 'github', branch: 'master', folders: [], installedSha: 'a', remoteSha: 'b' });
  repo.sha = 'sha2';
  await u.checkAll();
  u.find('github.com/o/gone').remoteSha = 'b';
  const r = await u.update();
  assert.deepEqual(r.map((x) => x.ok).sort(), [false, true]);
});

test('rate-limit errors give a helpful message and tokens are sent', async () => {
  const fetch = fakeFetch([[/api\.github\.com/, () => response(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': 0, 'x-ratelimit-limit': 60, 'x-ratelimit-reset': 1 })]]);
  const http = new HttpClient({ fetch, tokens: { 'github.com': 'tok' } });
  await assert.rejects(http.json('https://api.github.com/repos/a/b'), /rate limit.*token/i);
  assert.equal(fetch.calls[0].headers.Authorization, 'Bearer tok');
});

test('suggest ranks TOC hints and 3.3.5a repos first', async () => {
  const wow = await makeWow();
  const fetch = fakeFetch([
    [
      /search\/repositories/,
      () =>
        response(200, {
          items: [
            { html_url: 'https://github.com/x/Foo', full_name: 'x/Foo', name: 'Foo', description: 'retail version', stargazers_count: 500 },
            { html_url: 'https://github.com/y/Foo-335', full_name: 'y/Foo-335', name: 'Foo-335', description: 'Backport for 3.3.5a', stargazers_count: 10 },
          ],
        }),
    ],
  ]);
  const u = await new Updater(wow, { fetch }).load();
  const s = await u.suggest('Foo', 'Foo', ['https://github.com/author/Foo']);
  assert.equal(s[0].source, 'toc');
  assert.equal(s[1].name, 'y/Foo-335');
});

test('suggest drops search hits that do not mention the addon (regression: readme noise)', async () => {
  const wow = await makeWow();
  const fetch = fakeFetch([
    [
      /search\/repositories/,
      () =>
        response(200, {
          items: [
            { html_url: 'https://github.com/z/community', full_name: 'z/community', name: 'community', description: 'unrelated', stargazers_count: 900 },
            { html_url: 'https://github.com/q/quartz', full_name: 'q/quartz', name: 'quartz', description: 'Quartz job scheduler', language: 'Java', stargazers_count: 7000 },
            { html_url: 'https://github.com/g/Quartz', full_name: 'g/Quartz', name: 'Quartz', description: '3.3.5 castbar', stargazers_count: 4 },
          ],
        }),
    ],
  ]);
  const u = await new Updater(wow, { fetch }).load();
  assert.deepEqual((await u.suggest('Quartz', 'Quartz', [])).map((c) => c.name), ['g/Quartz']);
});

test('linking a folder to a collection repo installs only that folder (regression)', async () => {
  const wow = await makeWow({ Foo: { 'Foo.toc': toc('Foo') } });
  const fetch = fakeFetch([
    [/commits/, () => response(200, { sha: 's', commit: {} })],
    [/codeload/, () => response(200, makeZip({ 'c-s/Foo/Foo.toc': toc('Foo'), 'c-s/Bar/Bar.toc': toc('Bar'), 'c-s/Baz/Baz.toc': toc('Baz') }))],
  ]);
  const u = await new Updater(wow, { fetch }).load();
  const r = await u.add('https://github.com/o/Collection', { branch: 'main', adoptFolders: ['Foo'] });
  assert.deepEqual(r.installed, ['Foo']);
  assert.deepEqual(await fs.readdir(path.join(wow, 'Interface', 'AddOns')), ['Foo']);
});
