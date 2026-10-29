const test = require('node:test');
const assert = require('node:assert');
const { context } = require('./harness');

// One club total (positions + cash, owned or not), the attributed /
// unattributed / cash split, `Alle` as five equal shares, foreign rows with
// no FX rate, and per-ticker price age on a weekday rule. Synthetic data,
// `now` passed in.
const w = context(['parsers.js', 'ledger.js', 'prices.js', 'securities.js', 'positions.js', 'portfolio.js']);
const { Portfolio, Prices, Ledger, Securities } = w;
const NOW = '2026-10-28'; // a Wednesday

const sec = (name, ticker, currency = 'NOK') => ({ name, ticker, isin: null, aliases: [], currency, status: 'held' });
const registry = Securities.buildRegistry([sec('Owned', 'OWN'), sec('Everyone', 'ALL'), sec('Orphan', 'ORP'), sec('Stale', 'STL')]);
Portfolio._setRegistry(registry);

const buy = (security, qty, amount, extra = {}) => ({ security, type: 'KJØPT', tradeDate: '2026-01-05', bookDate: '2026-01-05', qty, amount, currency: 'NOK', ...extra });
function mkStore({ withOrphan = true, extraTx = [] } = {}) {
  const prices = Prices.build([
    ['date', 'OWN', 'ALL', 'ORP', 'STL', 'CUR:USDNOK'],
    ['2026-10-09', 10, 10, 10, 10, 10],
    ['2026-10-23', 10, 10, 10, '', 10],
    ['2026-10-28', 12, 20, 30, '', 11],
  ]);
  const attributionMap = new Map([['Owned', [{ code: 'HH', weight: 1 }]], ['Everyone', [{ code: 'Alle', weight: 1 }]]]);
  const transactions = [
    buy('Owned', 10, -1000), buy('Everyone', 10, -1000),
    ...(withOrphan ? [buy('Orphan', 10, -1000)] : []),
    { type: 'INNSKUDD', tradeDate: '2026-01-02', bookDate: '2026-01-02', amount: 5000, currency: 'NOK', saldo: 5000 },
    ...extraTx,
  ];
  return { transactions, attributionMap, prices, registry };
}

test('Alle in Dim-values means five equal shares, not a dropped security', () => {
  const split = Ledger.splitForSecurity(mkStore().attributionMap, 'Everyone');
  assert.strictEqual(split.length, 5);
  assert.ok(split.every((s) => Math.abs(s.weight - 0.2) < 1e-9));
  assert.strictEqual(Ledger.splitForSecurity(mkStore().attributionMap, 'Orphan').length, 0);
});

test('clubTotal counts every position and the saldo; unattributed is the no-owner name', () => {
  const c = Portfolio.clubTotal(mkStore(), NOW);
  assert.strictEqual(c.marketValue, 10 * 12 + 10 * 20 + 10 * 30);
  assert.strictEqual(c.attributed, 10 * 12 + 10 * 20); // Alle counts as attributed
  assert.strictEqual(c.unattributed, 300);
  assert.strictEqual(c.cash, 5000);
  assert.strictEqual(c.total, c.attributed + c.unattributed + c.cash);
  assert.deepStrictEqual([...c.unattributedNames], ['Orphan']);
});

test('Dashboard group total is the club total; five investors plus unattributed add up to it', () => {
  const store = mkStore();
  const club = Portfolio.clubTotal(store, NOW);
  const snap = Portfolio._debug.buildDashboardSnapshot(store, NOW);
  assert.strictEqual(Math.round(snap.group.totalValue), Math.round(club.total));
  const sum = Object.values(snap.perInvestor).reduce((a, x) => a + x.totalValue, 0);
  assert.strictEqual(Math.round(sum + club.unattributed), Math.round(club.total));
  assert.strictEqual(snap.perInvestor.HS.marketValue, 40); // Alle: 200 / 5, nothing else
  assert.strictEqual(snap.perInvestor.HH.marketValue, 120 + 40);
});

test('clean book: unattributed is 0 and the five investors sum to the club total', () => {
  const store = mkStore({ withOrphan: false });
  const club = Portfolio.clubTotal(store, NOW);
  const snap = Portfolio._debug.buildDashboardSnapshot(store, NOW);
  assert.strictEqual(club.unattributed, 0);
  assert.deepStrictEqual([...club.unattributedNames], []);
  const sum = Object.values(snap.perInvestor).reduce((a, x) => a + x.totalValue, 0);
  assert.strictEqual(Math.round(sum), Math.round(club.total));
});

test('a foreign row with no Vekslingskurs is flagged; NOK and rated rows are not', () => {
  const usd = (extra) => buy('Owned', 1, -10, { currency: 'USD', ...extra });
  const txs = [usd({ fxRate: null }), usd({ fxRate: 0 }), usd({ fxRate: 10.5 }), buy('Owned', 1, -10)];
  assert.strictEqual(Ledger.missingFxTxs(txs).length, 2);
  assert.strictEqual(Portfolio.clubTotal(mkStore({ extraTx: [usd({ fxRate: null })] }), NOW).missingFx, 1);
  assert.strictEqual(Portfolio.clubTotal(mkStore(), NOW).missingFx, 0);
});

test('price age counts weekdays: a Friday close is not stale on Monday or over the weekend', () => {
  const age = (from, now) => Prices.ageInfo(from, now);
  assert.strictEqual(age('2026-10-23', '2026-10-26').stale, false); // Fri -> Mon
  assert.strictEqual(age('2026-10-23', '2026-10-25').stale, false); // Fri -> Sun
  assert.strictEqual(age('2026-10-23', '2026-10-28').stale, false); // Fri -> Wed, 3 weekdays
  assert.strictEqual(age('2026-10-23', '2026-10-29').stale, true); // Fri -> Thu, 4 weekdays
  const old = age('2026-10-09', NOW);
  assert.deepStrictEqual([old.days, old.stale], [19, true]);
});

test('each holding carries its own price date and age, not the global newest date', () => {
  const rows = Portfolio.currentHoldings(mkStore({ extraTx: [buy('Stale', 10, -1000)] }), NOW);
  const by = (n) => rows.find((r) => r.security === n);
  assert.strictEqual(by('Stale').priceDate, '2026-10-09');
  assert.strictEqual(by('Stale').stale, true);
  assert.strictEqual(by('Stale').priceAgeDays, 19);
  assert.strictEqual(by('Owned').priceDate, '2026-10-28');
  assert.strictEqual(by('Owned').stale, false);
  assert.strictEqual(Prices.fxLatestDate(mkStore().prices), '2026-10-28');
});

// Column C is each investor's share. Only min(1, sum of weights) of a
// position's value has an owner; the rest shows as unattributed.
test('partly owned security (factor 0.5): half is unattributed, investors plus unattributed equal the club total', () => {
  const store = mkStore({ withOrphan: false });
  store.attributionMap.set('Owned', [{ code: 'HH', weight: 0.5 }]);
  const c = Portfolio.clubTotal(store, NOW);
  assert.strictEqual(c.attributed, 60 + 200);
  assert.strictEqual(c.unattributed, 60);
  assert.deepStrictEqual([...c.unattributedNames], ['Owned']);
  const snap = Portfolio._debug.buildDashboardSnapshot(store, NOW);
  const sum = Object.values(snap.perInvestor).reduce((a, x) => a + x.totalValue, 0);
  assert.strictEqual(Math.round(sum + c.unattributed), Math.round(c.total));
});

test('weights summing above 1 (HH and HS at factor 1) never book more than the market value', () => {
  const store = mkStore({ withOrphan: false });
  store.attributionMap.set('Owned', [{ code: 'HH', weight: 1 }, { code: 'HS', weight: 1 }]);
  const c = Portfolio.clubTotal(store, NOW);
  assert.strictEqual(c.attributed, 120 + 200);
  assert.strictEqual(c.unattributed, 0);
  assert.strictEqual(c.marketValue, 320);
});

test('Alle ignores its own factor: five equal shares even when column C says 0.3', () => {
  const store = mkStore({ withOrphan: false });
  store.attributionMap.set('Everyone', [{ code: 'Alle', weight: 0.3 }]);
  const split = Ledger.splitForSecurity(store.attributionMap, 'Everyone');
  assert.strictEqual(split.length, 5);
  assert.ok(split.every((s) => Math.abs(s.weight - 0.2) < 1e-9));
  assert.strictEqual(Portfolio.clubTotal(store, NOW).unattributed, 0);
});
