const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// The Apps Script feed adds one benchmark column, IDX:OSEBX, to the daily
// fetch and the backfill. Code.gs is loaded into a vm with its Google
// services stubbed; no network and no sheet is touched.
function feed() {
  const ctx = { console, Utilities: {}, SpreadsheetApp: {}, PropertiesService: {}, CacheService: {}, LockService: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8'), ctx);
  ctx.lastValueDates_ = () => ({});
  return ctx;
}

test('the daily fetch list ends with the IDX:OSEBX index item', () => {
  const g = feed();
  const list = Array.from(g.fetchListFor_(null, [{ name: 'A', ticker: 'A.OL', status: 'held', currency: 'NOK', exchange: 'OSL', source: 'yahoo' }], '2026-10-28'));
  const idx = list.filter((i) => i.column === 'IDX:OSEBX');
  assert.strictEqual(idx.length, 1);
  assert.strictEqual(idx[0].source, 'index');
  assert.strictEqual(list[0].column, 'A.OL');
});

// One symbol only: a fallback to a different index (All-Share) would splice two
// levels into one column. If the primary fails the error propagates, and the
// daily fetch / backfill loops log it and skip the column.
test('the index uses one symbol: no fallback to another index, a failure propagates', () => {
  const g = feed();
  const seen = [];
  g.yahooQuote_ = (sym) => { seen.push(sym); if (sym === 'OSEBX.OL') throw new Error('not found'); return 1500; };
  assert.throws(() => g.fetchQuote_({ source: 'index', column: 'IDX:OSEBX', ticker: 'OSEBX.OL' }), /not found/);
  assert.deepStrictEqual([...seen], ['OSEBX.OL']);
  g.yahooHistory_ = (sym) => { seen.push(sym); return [['2026-01-02', 1400]]; };
  assert.strictEqual(g.fetchIndexHistory_('2026-01-01').length, 1);
  assert.deepStrictEqual([...seen].slice(1), ['OSEBX.OL']);
  g.yahooHistory_ = () => { throw new Error('boom'); };
  assert.throws(() => g.fetchIndexHistory_('2026-01-01'), /boom/);
});
