const test = require('node:test');
const assert = require('node:assert');
const { context } = require('./harness');

// Portfolio.summary(store, asOf): one plain object for the club's numbers,
// built from the functions the views already use. Synthetic data, `asOf` passed in.
const w = context(['parsers.js', 'ledger.js', 'prices.js', 'securities.js', 'positions.js', 'portfolio.js']);
const { Portfolio, Prices, Securities } = w;
const NOW = '2026-10-28';

const sec = (name, ticker, currency = 'NOK') => ({ name, ticker, isin: null, aliases: [], currency, status: 'held' });
const registry = Securities.buildRegistry([sec('Owned', 'OWN'), sec('Everyone', 'ALL'), sec('Orphan', 'ORP'), sec('Stale', 'STL'), sec('Sold', 'SLD')]);
Portfolio._setRegistry(registry);

const tx = (security, type, tradeDate, qty, amount, extra = {}) => ({ security, type, tradeDate, bookDate: tradeDate, qty, amount, currency: 'NOK', ...extra });
function mkStore(extraTx = []) {
  const prices = Prices.build([
    ['date', 'OWN', 'ALL', 'ORP', 'STL', 'SLD', 'CUR:USDNOK'],
    ['2026-01-05', 10, 10, 10, 10, 10, 10],
    ['2026-06-01', 11, 10, 10, 10, 12, 10],
    ['2026-10-09', 11, 10, 10, 10, 12, 10],
    ['2026-10-28', 12, 20, 30, '', 12, 11],
  ]);
  const attributionMap = new Map([['Owned', [{ code: 'HH', weight: 1 }]], ['Everyone', [{ code: 'Alle', weight: 1 }]], ['Sold', [{ code: 'HS', weight: 1 }]]]);
  const transactions = [
    { type: 'INNSKUDD', tradeDate: '2026-01-02', bookDate: '2026-01-02', amount: 5000, currency: 'NOK', saldo: 5000 },
    tx('Owned', 'KJØPT', '2026-01-05', 10, -1000), tx('Everyone', 'KJØPT', '2026-01-05', 10, -1000),
    tx('Orphan', 'KJØPT', '2026-01-05', 10, -1000), tx('Stale', 'KJØPT', '2026-01-05', 10, -1000),
    tx('Sold', 'KJØPT', '2026-01-05', 10, -1000), tx('Sold', 'SALG', '2026-06-01', 10, 1200),
    tx('Owned', 'UTBYTTE', '2026-06-02', 0, 50),
    ...extraTx,
  ];
  return { transactions, attributionMap, prices, registry };
}

test('summary total is the club total and the profit parts are the dashboard group figures', () => {
  const store = mkStore();
  const s = Portfolio.summary(store, NOW);
  const club = Portfolio.clubTotal(store, NOW);
  const g = Portfolio._debug.buildDashboardSnapshot(store, NOW).group;
  assert.strictEqual(s.asOf, NOW);
  assert.strictEqual(s.hasData, true);
  for (const k of ['total', 'marketValue', 'cash', 'attributed', 'unattributed']) assert.strictEqual(s.value[k], club[k], k);
  assert.deepStrictEqual([s.profit.realized, s.profit.unrealized, s.profit.dividends], [g.realized, g.unrealized, g.dividends]);
  assert.strictEqual(s.profit.total, g.netReturn);
  assert.strictEqual(s.invested, g.invested);
  assert.strictEqual(s.returnPct, g.portfolioReturnPct);
  assert.strictEqual(s.profit.realized, 200);
  assert.strictEqual(s.profit.dividends, 50);
});

test('profit.ytd is the windowMetrics net P/L from 1 Jan to asOf', () => {
  const store = mkStore();
  const wm = Portfolio.windowMetrics(store, '2026-01-01', NOW);
  assert.strictEqual(Portfolio.summary(store, NOW).profit.ytd, wm.group.netPnlInWindow);
});

test('top three holdings by market value, with weight; cash share of the total', () => {
  const s = Portfolio.summary(mkStore(), NOW);
  assert.deepStrictEqual([...s.top.map((h) => h.security)], ['Orphan', 'Everyone', 'Owned']);
  assert.strictEqual(s.top[0].marketValue, 300);
  assert.ok(Math.abs(s.top[0].weightPct - (300 / s.value.marketValue) * 100) < 1e-9);
  assert.ok(Math.abs(s.cashPct - (s.value.cash / s.value.total) * 100) < 1e-9);
  assert.ok(Math.abs(s.stocksPct + s.cashPct - 100) < 1e-9, 'stocks and cash shares add up to the whole');
});

test('stale prices, unattributed names and missing FX are counted', () => {
  const s = Portfolio.summary(mkStore([tx('Owned', 'KJØPT', '2026-02-01', 1, -10, { currency: 'USD', fxRate: null })]), NOW);
  assert.strictEqual(s.staleCount, 1); // Stale: last close 2026-10-09 (priced 2026-01-05..10-09 only)
  assert.deepStrictEqual([...s.unattributedNames], ['Orphan', 'Stale']);
  assert.strictEqual(s.missingFx, 1);
});

test('a partly owned security leaves the rest unattributed', () => {
  const store = mkStore();
  store.attributionMap.set('Owned', [{ code: 'HH', weight: 0.5 }]);
  const s = Portfolio.summary(store, NOW);
  assert.ok(s.unattributedNames.includes('Owned'));
  assert.strictEqual(s.value.unattributed, Portfolio.clubTotal(store, NOW).unattributed);
  assert.ok(s.value.unattributed >= 60 + 300);
  assert.strictEqual(s.value.attributed + s.value.unattributed, s.value.marketValue);
});

test('Alle is split evenly: all of it is attributed', () => {
  const s = Portfolio.summary(mkStore(), NOW);
  assert.ok(!s.unattributedNames.includes('Everyone'));
  assert.strictEqual(s.value.attributed, 120 + 200);
});

test('asOf in the past prices and counts only what was true then', () => {
  const store = mkStore();
  const past = Portfolio.summary(store, '2026-06-01');
  assert.strictEqual(past.asOf, '2026-06-01');
  assert.strictEqual(past.value.marketValue, 110 + 100 + 100 + 100); // Sold is gone, Owned at 11
  assert.strictEqual(past.profit.realized, 200);
  const early = Portfolio.summary(store, '2026-03-01');
  assert.strictEqual(early.profit.realized, 0); // the sale had not happened
  assert.strictEqual(early.profit.dividends, 0);
  assert.strictEqual(early.value.marketValue, 400 + 100);
});

test('asOf accepts a Date', () => {
  assert.strictEqual(Portfolio.summary(mkStore(), new Date('2026-10-28T12:00:00Z')).asOf, NOW);
});

test('empty store: zeros, no data, no throw', () => {
  const s = Portfolio.summary({ transactions: [], attributionMap: new Map(), prices: Prices.build([]), registry }, NOW);
  assert.strictEqual(s.hasData, false);
  assert.strictEqual(s.value.total, 0);
  assert.strictEqual(s.invested, 0);
  assert.strictEqual(s.returnPct, 0);
  assert.deepStrictEqual([s.top.length, s.staleCount, s.missingFx], [0, 0, 0]);
  assert.strictEqual(s.cashPct, null);
  assert.strictEqual(s.stocksPct, null);
});

test('transactions but no prices: cash and invested stand, holdings are empty, no throw', () => {
  const store = mkStore(); store.prices = Prices.build([]);
  const s = Portfolio.summary(store, NOW);
  assert.strictEqual(s.hasData, true);
  assert.strictEqual(s.value.marketValue, 0);
  assert.strictEqual(s.value.cash, 5000);
  assert.strictEqual(s.top.length, 0);
});

test('profit.ytd follows Nordnet\'s running total when a conversion is booked twice', () => {
  // A listing move: one row out, but the broker books the shares in twice.
  // Nordnet's "Totalt antall" after each row says 0, 10, 10: still 10 held.
  const swap = [
    tx('Owned', 'BYTTE UTTAK VP', '2026-03-02', 10, 0, { totalAfter: 0 }),
    tx('Owned', 'BYTE INLÄGG VP', '2026-03-05', 10, 0, { totalAfter: 10 }),
    tx('Owned', 'BYTE INLÄGG VP', '2026-03-05', 10, 0, { totalAfter: 10 }),
  ];
  const plain = Portfolio.summary(mkStore(), NOW).profit.ytd;
  assert.strictEqual(Portfolio.summary(mkStore(swap), NOW).profit.ytd, plain, 'the extra shares are not profit');
});
