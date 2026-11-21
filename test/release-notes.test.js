'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { releaseNotes } = require('../tools/release-notes');

const SAMPLE = `# Changelog

## [Unreleased]
- wip

---

## [1.1.0] — 2026-01-02

> Highlight.

<img src="assets/shot.png" width="10" />
![alt](assets/b.png) [docs](docs/x.md) [ext](https://example.com) [anchor](#top)

### ✨ New
- Thing

---

## [1.0.0] — 2026-01-01
- First

[Unreleased]: https://github.com/o/r/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/o/r/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/o/r/releases/tag/v1.0.0
`;

test('extracts only the requested version, without the trailing separator', () => {
  const n = releaseNotes(SAMPLE, 'v1.1.0', { repo: 'o/r' });
  assert.match(n, /^> Highlight\./);
  assert.match(n, /- Thing/);
  assert.doesNotMatch(n, /First|wip|## \[/);
});

test('rewrites relative images and links to absolute URLs at the given ref', () => {
  const n = releaseNotes(SAMPLE, '1.1.0', { repo: 'o/r', ref: 'main' });
  assert.match(n, /src="https:\/\/raw\.githubusercontent\.com\/o\/r\/main\/assets\/shot\.png"/);
  assert.match(n, /!\[alt\]\(https:\/\/raw\.githubusercontent\.com\/o\/r\/main\/assets\/b\.png\)/);
  assert.match(n, /\[docs\]\(https:\/\/github\.com\/o\/r\/blob\/main\/docs\/x\.md\)/);
  assert.match(n, /\[ext\]\(https:\/\/example\.com\)/);
  assert.match(n, /\[anchor\]\(#top\)/);
});

test('defaults the ref to the version tag and appends download + compare footer', () => {
  const n = releaseNotes(SAMPLE, '1.1.0', { repo: 'o/r' });
  assert.match(n, /o\/r\/v1\.1\.0\/assets\/shot\.png/);
  assert.match(n, /AddonUpdateTool-1\.1\.0-portable\.exe/);
  assert.match(n, /Full changelog:\*\* https:\/\/github\.com\/o\/r\/compare\/v1\.0\.0\.\.\.v1\.1\.0/);
  assert.doesNotMatch(releaseNotes(SAMPLE, '1.0.0', { repo: 'o/r' }), /Full changelog/);
});

test('unknown versions fail loudly', () => {
  assert.throws(() => releaseNotes(SAMPLE, '9.9.9'), /not found/);
});

test('the real CHANGELOG has a section for the current package version', () => {
  const root = path.join(__dirname, '..');
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const notes = releaseNotes(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), version);
  assert.ok(notes.length > 100);
});
