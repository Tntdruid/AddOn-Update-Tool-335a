'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Regression: `el.onkeydown = (e) => e.key === 'Enter' && go()` returns false for
 * every other key, and a false return from an on* handler property cancels the
 * event. That made it impossible to type in the "Add from URL" dialog and to tick
 * checkboxes inside dialogs. on* handlers with expression bodies built from
 * boolean operators or comparisons are therefore not allowed.
 */
test('renderer on* handler properties never return a boolean expression', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  const offenders = [];
  const re = /\.on[a-z]+\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>\s*(?!\{)([^\n;]*)/g;
  for (const m of src.matchAll(re)) {
    const body = m[1];
    if (/&&|\|\||[=!]==|^\s*\(?\s*[\w.$#'()[\]]+\s*=(?!=)/.test(body)) {
      const line = src.slice(0, m.index).split('\n').length;
      offenders.push(`app.js:${line}: ${m[0].trim()}`);
    }
  }
  assert.deepEqual(offenders, []);
});
