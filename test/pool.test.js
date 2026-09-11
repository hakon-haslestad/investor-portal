const test = require('node:test');
const assert = require('node:assert');
const { context, load } = require('./harness');

test('the period decides the measure, replacing the old Scope filter', () => {
  const w = context(['games/pool.js']);
  // All time scores every position over its whole life...
  assert.equal(w.GamePool.measureFor('all'), 'lifetime');
  // ...every narrower period scores only what was bought inside it.
  for (const p of ['ytd', '1y', '2y', '3y', 'custom']) {
    assert.equal(w.GamePool.measureFor(p), 'window', `period ${p}`);
  }
});

// A tiny store: two members, three securities, a handful of trades.
function fakeStore() {
  return {
    members: [
      { investorCode: 'HH', displayName: 'Hakon' },
      { investorCode: 'JC', displayName: 'Jonas' },
    ],
    transactions: [
      { tradeDate: '2024-02-01', type: 'KJØPT', security: 'Alpha', qty: 10, price: 100, currency: 'NOK' },
      { tradeDate: '2024-09-01', type: 'SALG', security: 'Alpha', qty: -10, price: 150, currency: 'NOK' },
      { tradeDate: '2025-03-01', type: 'KJØPT', security: 'Beta', qty: 5, price: 200, currency: 'NOK' },
    ],
    attributionMap: {},
    prices: { hasData: false, dates: [], series: new Map() },
    registry: {
      forName: (n) => ({ ticker: n.toUpperCase().slice(0, 3), exchange: n === 'Alpha' ? 'OSL' : 'STO' }),
    },
  };
}

function poolCtx() {
  const w = context([], {
    Copy: { namesFromMembers: (ms) => Object.fromEntries((ms || []).map((m) => [m.investorCode, m.displayName])) },
    Ledger: {
      INVESTOR_CODES: ['HH', 'JC'],
      classify: (t) => (t === 'KJØPT' ? 'BUY' : t === 'SALG' ? 'SELL' : 'OTHER'),
      splitForSecurity: () => [{ code: 'HH', weight: 1 }],
    },
    Portfolio: {
      canonicalName: (s) => String(s || '').toLowerCase().trim(),
      buildDashboard: () => ({ perInvestor: {} }),
      previousHoldings: () => [],
      usePriceMatrix: () => false,
    },
    CompetitionEngine: { scoreCompetition: () => ({ ranks: [] }) },
    TimeSeries: { buildSecurityPriceSeries: () => [] },
  });
  load(w, 'games/pool.js');
  return w.GamePool.createContext(fakeStore());
}

test('activityDates finds the first and last trade of a security', () => {
  const pool = poolCtx();
  assert.deepEqual(pool.activityDates('Alpha', 'HH'), { first: '2024-02-01', last: '2024-09-01' });
  assert.deepEqual(pool.activityDates('Beta', 'HH'), { first: '2025-03-01', last: '2025-03-01' });
  assert.deepEqual(pool.activityDates('Nothing', 'HH'), { first: null, last: null });
});

test('computeWindow: All time starts at the earliest trade', () => {
  const pool = poolCtx();
  assert.equal(pool.computeWindow('all').from, '2024-02-01');
  assert.equal(pool.computeWindow('custom', '2020-01-01', '2020-12-31').from, '2020-01-01');
  assert.equal(pool.computeWindow('ytd').from, `${new Date().getUTCFullYear()}-01-01`);
});

test('refinePool merges every investor slice of one stock into a single row', () => {
  const pool = poolCtx();
  const rows = pool.refinePool([
    { security: 'Alpha', investor: 'HH', investorName: 'Hakon', purchaseAmount: 1000, pnlNok: 500, currentOrSoldValue: 1500, sold: true, from: 'a', to: 'b' },
    { security: 'Alpha', investor: 'JC', investorName: 'Jonas', purchaseAmount: 3000, pnlNok: -100, currentOrSoldValue: 2900, sold: true, from: 'a', to: 'b' },
    { security: 'Beta', investor: 'HH', investorName: 'Hakon', purchaseAmount: 1000, pnlNok: 0, currentOrSoldValue: 1000, sold: false, from: 'a', to: 'b' },
  ]);
  assert.equal(rows.length, 2, 'one row per canonical stock');
  const alpha = rows.find((r) => r.security === 'Alpha');
  assert.equal(alpha.purchaseAmount, 4000);
  assert.equal(alpha.pnlNok, 400);
  assert.equal(alpha.investor, 'JC', 'largest owner leads');
  assert.equal(alpha.investors.length, 2);
  assert.ok(alpha.win, 'net positive P/L wins');
  assert.equal(alpha.exchange, 'OSL', 'exchange comes from the registry');
  // Trade dates are attached once here so no game re-walks the ledger.
  assert.equal(alpha.firstDate, '2024-02-01');
  assert.equal(alpha.lastDate, '2024-09-01');
  const beta = rows.find((r) => r.security === 'Beta');
  assert.equal(beta.sold, false, 'a still-open slice keeps the row open');
});

test('refinePool drops rights/subscription artifacts', () => {
  const pool = poolCtx();
  const rows = pool.refinePool([
    { security: 'Alpha TR', investor: 'HH', investorName: 'H', purchaseAmount: 1, pnlNok: 0, currentOrSoldValue: 1, sold: true, from: 'a', to: 'b' },
    { security: 'Beta tegningsrett', investor: 'HH', investorName: 'H', purchaseAmount: 1, pnlNok: 0, currentOrSoldValue: 1, sold: true, from: 'a', to: 'b' },
    { security: 'Alpha', investor: 'HH', investorName: 'H', purchaseAmount: 1, pnlNok: 0, currentOrSoldValue: 1, sold: true, from: 'a', to: 'b' },
  ]);
  assert.deepEqual(rows.map((r) => r.security), ['Alpha']);
});

test('players fall back to all members when no competition is selected', () => {
  const pool = poolCtx();
  const all = pool.playersFor({ competitionId: '' }, new Map());
  assert.deepEqual(all.map((p) => p.code), ['HH', 'JC']);
  assert.equal(all[0].name, 'Hakon');

  const comps = new Map([['C1', { participants: [{ investor_code: 'JC' }, { investor_code: 'JC' }] }]]);
  const some = pool.playersFor({ competitionId: 'C1' }, comps);
  assert.deepEqual(some.map((p) => p.code), ['JC'], 'participants are de-duplicated');
});

test('an empty pool never throws', () => {
  const pool = poolCtx();
  assert.deepEqual(pool.refinePool([]), []);
  assert.deepEqual(pool.buildPool({ period: 'all' }, new Map()), []);
  assert.deepEqual(pool.buildPool({ competitionId: 'missing' }, new Map()), []);
});
