const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { baseWindow, load } = require('./harness');

// One number rule for the whole app: decimal comma, true minus (U+2212),
// never "-0,0". Every display formatter goes through window.Fmt.
const MINUS = '−';
const w = baseWindow({});
vm.createContext(w);
load(w, 'format.js');
const F = w.Fmt;

test('percent and decimals: comma, true minus, never a signed zero', () => {
  assert.strictEqual(F.fmtPct(5.84), '+5,8%');
  assert.strictEqual(F.fmtPct(-8.8), `${MINUS}8,8%`);
  assert.strictEqual(F.fmtPct(0), '0,0%');
  assert.strictEqual(F.fmtPct(-0.04), '0,0%');
  assert.strictEqual(F.fmtPct(-0.04, false), '0,0%');
  assert.strictEqual(F.fmtPct(null), '—');
  assert.strictEqual(F.fmtDec(-0.004, 2), '0,00');
  assert.strictEqual(F.fmtDec(12.345, 2), '12,35');
  assert.strictEqual(F.fmtDec(-5, 0, true), `${MINUS}5`);
  assert.strictEqual(F.fmtDec(7, 0, true), '+7');
});

test('money: short form uses the same rule, and a price has no currency', () => {
  assert.strictEqual(F.fmtNokShort(-1_234_000), `${MINUS}1,2M`);
  assert.strictEqual(F.fmtNokShort(412_300), '412k');
  assert.strictEqual(F.fmtNokShort(-5_400, 1000), `${MINUS}5k`);
  assert.strictEqual(F.fmtNokShort(undefined), '—');
  assert.strictEqual(F.fmtNok(-1500).replace(/\s/g, ' '), `${MINUS}1 500 kr`);
  assert.strictEqual(F.fmtPrice(1234.4).replace(/\s/g, ' '), '1 234');
});

test('chart month label is English short month + 2-digit year, UTC, no dot', () => {
  assert.strictEqual(F.fmtMonth(new Date(Date.UTC(2025, 0, 1))), 'Jan 25');
  assert.strictEqual(F.fmtMonth(new Date(Date.UTC(2025, 2, 31, 23, 59))), 'Mar 25');
  assert.strictEqual(F.fmtMonth(new Date(Date.UTC(2026, 11, 1))), 'Dec 26');
});

test('every docs/js file formats numbers only through Fmt (wiring invariant, scans the tree)', () => {
  const root = path.join(__dirname, '..', 'docs', 'js');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = walk(root).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 20, 'tree scan found the files');
  // toFixed only builds SVG coordinates in these two; admin.js shows debug fields.
  const coords = ['charts.js', 'horse-race-view.js', 'admin.js', 'format.js'];
  for (const f of files) {
    const name = path.basename(f);
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(name === 'format.js' || !/toLocale(Date|Time)?String\(|en-US/.test(src), `${name}: use Fmt, not a private locale`);
    if (coords.includes(name)) continue;
    assert.ok(!/\.toFixed\(/.test(src), `${name}: display numbers go through Fmt.fmtDec`);
  }
  const charts = fs.readFileSync(path.join(root, 'charts.js'), 'utf8');
  assert.ok(!/\.toFixed\([0-9]\)[^;\n]*%/.test(charts), 'tooltip % through Fmt.fmtPct');
});
