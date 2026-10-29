const test = require('node:test');
const assert = require('node:assert');
const { context } = require('./harness');

// Gain % of invested per investor: total gain over the cost of shares still
// held, falling back to everything bought after a big sell-off. Synthetic data.
const w = context(['parsers.js', 'ledger.js', 'prices.js', 'securities.js', 'positions.js', 'portfolio.js']);
const { Portfolio, Prices, Securities } = w;
const NOW = '2026-10-28';
const sec = (name, ticker) => ({ name, ticker, isin: null, aliases: [], currency: 'NOK', status: 'held' });
const registry = Securities.buildRegistry([sec('Alpha', 'AAA'), sec('Beta', 'BBB')]);
Portfolio._setRegistry(registry);
const tx = (security, type, tradeDate, qty, amount) => ({ security, type, tradeDate, bookDate: tradeDate, qty, amount, currency: 'NOK' });
const store = {
  registry, kpis: [], members: [],
  prices: Prices.build([['date', 'AAA', 'BBB'], ['2026-01-05', 10, 10], [NOW, 12, 30]]),
  attributionMap: new Map([['Alpha', [{ code: 'HH', weight: 1 }]], ['Beta', [{ code: 'HS', weight: 1 }]]]),
  transactions: [
    { type: 'INNSKUDD', tradeDate: '2026-01-02', bookDate: '2026-01-02', amount: 5000, currency: 'NOK', saldo: 5000 },
    tx('Alpha', 'KJØPT', '2026-01-05', 10, -100), // HH keeps it all: cost held 100
    tx('Beta', 'KJØPT', '2026-01-05', 10, -100), // HS sells 9 of 10 at 30
    tx('Beta', 'SALG', '2026-06-01', 9, 270),
  ],
};

test('an investor who still holds the shares: gain over the cost held', () => {
  const hh = Portfolio.buildDashboard(store).perInvestor.HH;
  assert.strictEqual(hh.gainBaseKind, 'held');
  assert.ok(Math.abs(hh.costHeld - 100) < 1e-9);
  assert.ok(Math.abs(hh.gainPct - (hh.netReturn / 100) * 100) < 1e-9);
});

test('after selling most of it (10% still held), the base falls back to everything bought', () => {
  const hs = Portfolio.buildDashboard(store).perInvestor.HS;
  assert.ok(hs.costHeld < 0.25 * hs.invested, 'only a tenth is still held');
  assert.strictEqual(hs.gainBaseKind, 'bought');
  assert.strictEqual(hs.gainBase, hs.invested);
  assert.ok(Math.abs(hs.gainPct - (hs.netReturn / hs.invested) * 100) < 1e-9);
  assert.ok(hs.gainPct < 300, 'no "pure net" blow-up');
});
