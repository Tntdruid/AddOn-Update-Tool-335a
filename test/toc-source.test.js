'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseToc, tocBaseName, compatibility, repoHints } = require('../src/core/toc');
const { parseRepoUrl, pickBranch, endpoints, sourceId } = require('../src/core/source');
const { parseLegacyConfig } = require('../src/core/state');

test('parseToc reads metadata, strips colour codes and BOM', () => {
  const t = parseToc('﻿## Interface: 30300\r\n## Title: |cff00ff00Deadly|r Boss Mods\n## Title: ignored\n## Dependencies: DBM-Core, Foo\n## X-Website: https://github.com/a/b\n# comment\ncore.lua\n');
  assert.equal(t.interface, 30300);
  assert.equal(t.title, 'Deadly Boss Mods');
  assert.deepEqual(t.dependencies, ['DBM-Core', 'Foo']);
  assert.deepEqual(t.files, ['core.lua']);
  assert.deepEqual(repoHints(t), ['https://github.com/a/b']);
});

test('tocBaseName strips flavour suffixes', () => {
  assert.equal(tocBaseName('Foo-WOTLKC.toc'), 'Foo');
  assert.equal(tocBaseName('Foo_Wrath.toc'), 'Foo');
  assert.equal(tocBaseName('Foo-Bar.toc'), 'Foo-Bar');
});

test('compatibility classifies interface numbers', () => {
  assert.equal(compatibility(30300), 'ok');
  assert.equal(compatibility(30200), 'older');
  assert.equal(compatibility(30403), 'newer');
  assert.equal(compatibility(110000), 'newer');
  assert.equal(compatibility(null), 'unknown');
});

test('parseRepoUrl handles GitHub, GitLab, Codeberg and SSH forms', () => {
  const gh = parseRepoUrl('https://github.com/Owner/Repo.git');
  assert.equal(gh.provider, 'github');
  assert.equal(gh.path, 'Owner/Repo');
  assert.equal(gh.branch, null);
  assert.equal(parseRepoUrl('github.com/o/r/tree/feature/x').branch, 'feature/x');
  assert.equal(parseRepoUrl('git@github.com:o/r.git').url, 'https://github.com/o/r');
  const gl = parseRepoUrl('https://gitlab.com/group/sub/repo/-/tree/wotlk');
  assert.equal(gl.provider, 'gitlab');
  assert.equal(gl.path, 'group/sub/repo');
  assert.equal(gl.branch, 'wotlk');
  const cb = parseRepoUrl('https://codeberg.org/o/r/src/branch/main');
  assert.equal(cb.provider, 'gitea');
  assert.equal(cb.branch, 'main');
  assert.throws(() => parseRepoUrl('https://github.com/onlyowner'));
  assert.equal(sourceId(gh), 'github.com/owner/repo');
});

test('endpoints build archive URLs per provider', () => {
  assert.equal(endpoints(parseRepoUrl('github.com/o/r')).archive('abc'), 'https://codeload.github.com/o/r/zip/abc');
  assert.match(endpoints(parseRepoUrl('gitlab.com/g/r')).archive('abc'), /projects\/g%2Fr\/repository\/archive\.zip\?sha=abc$/);
});

test('pickBranch prefers 3.3.5a/WotLK branches, but not Wrath Classic', () => {
  assert.equal(pickBranch(['master', 'wotlk', 'dev'], 'master'), 'wotlk');
  assert.equal(pickBranch(['main', '3.3.5'], 'main'), '3.3.5');
  assert.equal(pickBranch(['main', 'wrath-classic'], 'main'), 'main');
  assert.equal(pickBranch(['main', 'dev'], 'main'), 'main');
  assert.equal(pickBranch(['x'], 'main', 'explicit'), 'explicit');
});

test('parseLegacyConfig reads the original tool’s YAML and JSON', () => {
  const yaml = `https://github.com/a/b : master\n# https://github.com/c/d : main\n  "https://gitlab.com/e/f" : wotlk  # comment\nhttps://github.com/g/h\n`;
  assert.deepEqual(parseLegacyConfig(yaml), [
    { url: 'https://github.com/a/b', branch: 'master' },
    { url: 'https://gitlab.com/e/f', branch: 'wotlk' },
    { url: 'https://github.com/g/h', branch: null },
  ]);
  assert.deepEqual(parseLegacyConfig('{"https://github.com/a/b": "main"}'), [{ url: 'https://github.com/a/b', branch: 'main' }]);
});
