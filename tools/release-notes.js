#!/usr/bin/env node
'use strict';

/**
 * Turn one version's section of CHANGELOG.md into GitHub release notes.
 *
 *   node tools/release-notes.js 0.2.0 [--ref v0.2.0] > notes.md
 *
 * - Relative image/link paths become absolute raw/blob URLs (release pages
 *   don't resolve repo-relative paths). --ref picks the git ref they point at.
 * - A download hint and the "full changelog" compare link are appended.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO = 'Tntdruid/AddOn-Update-Tool-335a';

/**
 * @param {string} changelog full CHANGELOG.md text
 * @param {string} version e.g. "0.2.0" (a leading "v" is ignored)
 * @param {{ref?:string, repo?:string}} [opts]
 * @returns {string}
 */
function releaseNotes(changelog, version, opts = {}) {
  const v = String(version).replace(/^v/, '');
  const repo = opts.repo || REPO;
  const ref = opts.ref || `v${v}`;
  const lines = String(changelog).replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => new RegExp(`^## \\[${escapeRe(v)}\\]`).test(l));
  if (start < 0) throw new Error(`Version ${v} not found in CHANGELOG.md`);
  let end = lines.findIndex((l, i) => i > start && (/^## \[/.test(l) || /^\[[^\]]+\]:\s/.test(l)));
  if (end < 0) end = lines.length;

  let body = lines.slice(start + 1, end).join('\n');
  body = body.replace(/\n-{3,}\s*$/, '').trim(); // trailing separator
  body = absolutize(body, repo, ref);

  const compare = new RegExp(`^\\[${escapeRe(v)}\\]:\\s*(\\S+)`, 'm').exec(changelog);
  const footer = [
    '---',
    `**Download:** \`AddonUpdateTool-${v}-portable.exe\` below. No installation needed; Windows may show a SmartScreen warning because the exe is unsigned.`,
  ];
  if (compare && /\/compare\//.test(compare[1])) footer.push(`**Full changelog:** ${compare[1]}`);
  return `${body}\n\n${footer.join('\n\n')}\n`;
}

/** Make repo-relative src/href values absolute. */
function absolutize(text, repo, ref) {
  const raw = `https://raw.githubusercontent.com/${repo}/${ref}/`;
  const blob = `https://github.com/${repo}/blob/${ref}/`;
  const isRelative = (u) => !/^([a-z]+:|#|\/\/)/i.test(u);
  return text
    .replace(/(<img\b[^>]*\bsrc=")([^"]+)"/gi, (m, pre, u) => (isRelative(u) ? `${pre}${raw}${u.replace(/^\.?\//, '')}"` : m))
    .replace(/(!\[[^\]]*\]\()([^)\s]+)\)/g, (m, pre, u) => (isRelative(u) ? `${pre}${raw}${u.replace(/^\.?\//, '')})` : m))
    .replace(/((?<!!)\[[^\]]*\]\()([^)\s]+)\)/g, (m, pre, u) => (isRelative(u) ? `${pre}${blob}${u.replace(/^\.?\//, '')})` : m));
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const version = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--ref');
  if (!version) {
    console.error('usage: node tools/release-notes.js <version> [--ref <git ref>]');
    process.exit(1);
  }
  const refIdx = args.indexOf('--ref');
  const text = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
  process.stdout.write(releaseNotes(text, version, { ref: refIdx >= 0 ? args[refIdx + 1] : undefined }));
}

module.exports = { releaseNotes };
