const test = require('node:test');
const assert = require('node:assert');
const { context } = require('./harness');

// Portfolio.summary(store).earnings: the "What the businesses earn us" numbers,
// built by Fundamentals.buildLookThrough plus a quarter comparison. Synthetic data.
const w = context(['parsers.js', 'ledger.js', 'prices.js', 'securities.js', 'positions.js', 'portfolio.js', 'fundamentals.js']);
const { Portfolio, Prices, Securities } = w;
const NOW = '2026-10-28';

const sec = (name, ticker) => ({ name, ticker, isin: null, aliases: [], currency: 'NOK', status: 'held' });
const registry = Securities.buildRegistry([sec('Alpha', 'AAA'), sec('Beta', 'BBB')]);
Portfolio._setRegistry(registry);

const tx = (security, type, tradeDate, qty, amount) => ({ security, type, tradeDate, bookDate: tradeDate, qty, amount, currency: 'NOK' });
const kpi = (company, period, eps, profit, note = null) => ({ company, period, currency: 'NOK', eps, yourProfitNok: profit, note });
// Alpha: 10 shares at 12 = 120. Beta: 10 shares at 20 = 200. Market value 320.
function mkStore(kpis) {
  return {
    registry, kpis, members: [],
    prices: Prices.build([['date', 'AAA', 'BBB'], ['2026-01-05', 10, 20], [NOW, 12, 20]]),
    attributionMap: new Map([['Alpha', [{ code: 'HH', weight: 1 }]], ['Beta', [{ code: 'HS', weight: 1 }]]]),
    transactions: [
      { type: 'INNSKUDD', tradeDate: '2026-01-02', bookDate: '2026-01-02', amount: 5000, currency: 'NOK', saldo: 5000 },
      tx('Alpha', 'KJØPT', '2026-01-05', 10, -100), tx('Beta', 'KJØPT', '2026-01-05', 10, -200),
    ],
  };
}
const BASE = [kpi('Alpha', 'Q2 2026', '2,00 NOK', 100), kpi('Beta', 'Q2 2026', '3,00 NOK', 50), kpi('Alpha', 'Q2 2025', '1,00 NOK', 80), kpi('Beta', 'Q2 2025', '1,00 NOK', 70)];

test('earnings yield and P/E: look-through earnings over the value of the holdings that report', () => {
  const e = Portfolio.summary(mkStore(BASE), NOW).earnings;
  assert.strictEqual(e.earnings, 50, '10 x 2 + 10 x 3');
  assert.ok(Math.abs(e.yieldPct - (50 / 320) * 100) < 1e-9, 'earnings / value of those holdings');
  assert.ok(Math.abs(e.pe - 320 / 50) < 1e-9);
});

test('earnings reuse buildLookThrough: same totals, no second calculation', () => {
  const store = mkStore(BASE);
  const t = w.Fundamentals.buildLookThrough(store).totals;
  const e = Portfolio.summary(store, NOW).earnings;
  assert.strictEqual(e.earnings, t.earnings);
  assert.strictEqual(e.yieldPct, t.earningsYieldPct);
  assert.strictEqual(e.pe, t.portfolioPe);
});

test('latest quarter vs the same quarter last year, summed over companies that have both; freshness counts holdings', () => {
  const q = Portfolio.summary(mkStore(BASE), NOW).earnings.quarter;
  assert.deepStrictEqual({ label: q.label, priorLabel: q.priorLabel, now: q.now, before: q.before, companies: q.companies, reported: q.reported, of: q.of },
    { label: 'Q2 2026', priorLabel: 'Q2 2025', now: 150, before: 150, companies: 2, reported: 2, of: 2 });
  const changed = Portfolio.summary(mkStore([...BASE.slice(0, 3)]), NOW).earnings.quarter;
  assert.strictEqual(changed.companies, 1, 'only Alpha has both quarters');
  assert.strictEqual(changed.now, 100); assert.strictEqual(changed.before, 80);
  assert.ok(Math.abs(changed.changePct - 25) < 1e-9);
});

test('quarter comparison is null when the same quarter last year is missing; freshness is null without any quarter', () => {
  const noPrior = Portfolio.summary(mkStore(BASE.slice(0, 2)), NOW).earnings;
  assert.strictEqual(noPrior.quarter, null);
  assert.strictEqual(noPrior.freshness.label, 'Q2 2026');
  assert.strictEqual(noPrior.freshness.reported, 2);
  const annual = Portfolio.summary(mkStore([kpi('Alpha', '2025', '2,00 NOK', null)]), NOW).earnings;
  assert.strictEqual(annual.quarter, null);
  assert.strictEqual(annual.freshness, null);
  const oneMissing = Portfolio.summary(mkStore([BASE[0], BASE[2]]), NOW).earnings;
  assert.strictEqual(oneMissing.freshness.reported, 1); assert.strictEqual(oneMissing.freshness.of, 2);
});

test('earnings is null with no KPI rows, or none for the current holdings; notes: top holdings only, truncated, raw text kept', () => {
  assert.strictEqual(Portfolio.summary(mkStore([]), NOW).earnings, null);
  assert.strictEqual(Portfolio.summary(mkStore([kpi('Unrelated', 'Q2 2026', '2,00 NOK', 1)]), NOW).earnings, null);
  const long = 'x'.repeat(300);
  const e = Portfolio.summary(mkStore([kpi('Alpha', 'Q2 2026', '2,00 NOK', 1, '<img src=x onerror=alert(1)>'), kpi('Beta', 'Q2 2026', '3,00 NOK', 1, long)]), NOW).earnings;
  assert.strictEqual(e.notes.map((n) => n.security).join(), 'Beta,Alpha', 'by market value');
  assert.ok(e.notes[0].note.length <= 121, 'truncated');
  assert.strictEqual(e.notes[1].note, '<img src=x onerror=alert(1)>', 'the summary keeps the text; the view escapes it');
});

test('adding earnings changes no existing summary key', () => {
  const s = Portfolio.summary(mkStore(BASE), NOW);
  const { earnings, ...rest } = s;
  const bare = Portfolio.summary({ ...mkStore(BASE), kpis: [] }, NOW);
  assert.strictEqual(bare.earnings, null);
  delete bare.earnings;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(rest)), JSON.parse(JSON.stringify(bare)));
});
