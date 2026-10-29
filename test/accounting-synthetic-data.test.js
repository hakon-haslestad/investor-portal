const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Guard: the accounting tests carry synthetic figures only. No member
// initials or names, no account-number-like digit runs, no IBANs. Chart
// accounts (1920, 1921, 2250) are four digits and fine. This file is not
// scanned: it holds the patterns.
const DIR = __dirname;
const files = fs.readdirSync(DIR).filter((f) => /^accounting-.*\.test\.js$/.test(f) && f !== path.basename(__filename));

const RULES = [
  ['member initials', /['"`\s](HH|HS|ØS|JC|HF)['"`\s,)]/],
  ['member names', /\b(Hanne|Håkon|Hakon|Haslestad)\b/i],
  ['9+ digit run', /\d{9,}/],
  ['IBAN-like', /\b[A-Z]{2}\d{2}[ ]?\d{4}/],
];

test('the accounting test files exist to be scanned', () => {
  assert.ok(files.includes('accounting-reconcile.test.js') && files.includes('accounting-view.test.js'));
});

for (const [name, re] of RULES) {
  test(`accounting tests contain no ${name}`, () => {
    for (const f of files) {
      const hit = fs.readFileSync(path.join(DIR, f), 'utf8').split('\n').findIndex((l) => re.test(l));
      assert.strictEqual(hit, -1, `${f}:${hit + 1} matches ${name}`);
    }
  });
}
