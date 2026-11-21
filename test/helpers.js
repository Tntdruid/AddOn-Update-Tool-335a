'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { zipSync, strToU8 } = require('fflate');

/** Build a zip from { "path": "content" }. */
function makeZip(files) {
  const entries = {};
  for (const [p, c] of Object.entries(files)) entries[p] = typeof c === 'string' ? strToU8(c) : c;
  return zipSync(entries);
}

function toc(title, iface = 30300, extra = '') {
  return `## Interface: ${iface}\n## Title: ${title}\n## Version: 1.0\n${extra}\nmain.lua\n`;
}

/** A temp WoW install with Wow.exe and Interface/AddOns. */
async function makeWow(addons = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aut-'));
  await fs.writeFile(path.join(dir, 'Wow.exe'), '');
  const ad = path.join(dir, 'Interface', 'AddOns');
  await fs.mkdir(ad, { recursive: true });
  for (const [folder, files] of Object.entries(addons)) {
    for (const [name, content] of Object.entries(files)) {
      const p = path.join(ad, folder, name);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, content);
    }
  }
  return dir;
}

/** Minimal Response-like object for a fake fetch. */
function response(status, body, headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => (h.has(k.toLowerCase()) ? h.get(k.toLowerCase()) : null) },
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    arrayBuffer: async () => {
      const u8 = body instanceof Uint8Array ? body : strToU8(JSON.stringify(body));
      return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    },
  };
}

/** Fake fetch routed by URL; records calls. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, headers: init.headers || {} });
    for (const [match, handler] of routes) {
      if (typeof match === 'string' ? url === match : match.test(url)) return handler(url, init);
    }
    return response(404, { message: 'Not Found' });
  };
  fn.calls = calls;
  return fn;
}

module.exports = { makeZip, toc, makeWow, response, fakeFetch };
