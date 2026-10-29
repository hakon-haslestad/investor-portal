const test = require('node:test');
const assert = require('node:assert');
const { context } = require('./harness');

// Allocation, FX split, dividends per security and the trade CSV rows.
// Synthetic book; `now` is the price date, never the real clock.
const w = context(['parsers.js', 'ledger.js', 'prices.js', 'securities.js', 'positions.js', 'portfolio.js']);
const { Portfolio, Prices, Securities } = w;
const NOW = '2026-10-28';

const sec = (name, ticker, currency, isin) => ({ name, ticker, isin: isin || null, aliases: [], currency, status: 'held' });
const buy = (security, qty, amount, extra = {}) => ({ security, type: 'KJØPT', tradeDate: '2026-01-05', bookDate: '2026-01-05', qty, amount, currency: 'NOK', ...extra });

// specs: [name, currency, isin, qty, priceNow]; USD buys at fx 10, USD now 11.
function mk(specs, extraTx = [], saldo = 0) {
  const secs = specs.map(([n, c, i], k) => sec(n, `T${k}`, c, i));
  const registry = Securities.buildRegistry(secs);
  Portfolio._setRegistry(registry);
  const head = ['date', ...specs.map((_, k) => `T${k}`), 'CUR:USDNOK'];
  const prices = Prices.build([head, ['2026-10-27', ...specs.map(() => 1), 10], ['2026-10-28', ...specs.map((s) => s[4]), 11]]);
  const transactions = specs.map(([n, c, , qty]) => (c === 'USD'
    ? buy(n, qty, -100 * qty, { currency: 'USD', fxRate: 10 })
    : buy(n, qty, -10 * qty)));
  transactions.push({ type: 'INNSKUDD', tradeDate: '2026-01-02', bookDate: '2026-01-02', amount: 9e5, currency: 'NOK', saldo });
  return { transactions: [...transactions, ...extraTx], attributionMap: new Map(), prices, registry };
}
const plain = (v) => JSON.parse(JSON.stringify(v));
const sum = (l) => l.reduce((a, x) => a + x.pct, 0);

test('allocation: top-5, biggest, cash, splits sum to 100, empty ISIN is Unknown', () => {
  const store = mk([
    ['A', 'NOK', 'NO0001', 10, 50], ['B', 'USD', 'US0001', 10, 100], ['C', 'NOK', null, 10, 20],
    ['D', 'NOK', 'SE0001', 10, 10], ['E', 'NOK', 'NO0002', 10, 5], ['F', 'NOK', 'NO0003', 10, 5],
  ], [], 1000);
  const a = Portfolio.allocation(store, NOW);
  // MV: B 11000, A 500, C 200, D 100, E 50, F 50 = 11900
  assert.strictEqual(a.holdingsValue, 11900);
  assert.strictEqual(a.biggest.security, 'B');
  assert.ok(Math.abs(a.biggest.pct - (11000 / 11900) * 100) < 1e-9);
  assert.ok(Math.abs(a.top5Pct - (11850 / 11900) * 100) < 1e-9);
  assert.ok(Math.abs(a.cashPct - (1000 / 12900) * 100) < 1e-9);
  assert.deepStrictEqual(plain(a.byCurrency.map((x) => x.key)), ['USD', 'NOK']);
  assert.deepStrictEqual(plain(a.byCountry.map((x) => x.key)), ['US', 'NO', 'Unknown', 'SE']);
  assert.ok(Math.abs(sum(a.byCurrency) - 100) < 1e-9 && Math.abs(sum(a.byCountry) - 100) < 1e-9);
});

test('allocation: fewer than five holdings gives top-5 of 100; empty book gives null', () => {
  const a = Portfolio.allocation(mk([['A', 'NOK', 'NO0001', 10, 50]]), NOW);
  assert.strictEqual(a.top5Pct, 100);
  assert.strictEqual(a.cashPct, 0);
  assert.strictEqual(Portfolio.allocation({ ...mk([['A', 'NOK', null, 1, 1]]), transactions: [] }, NOW), null);
});

test('fxSplit: price and currency effect add up to the total; omitted when not derivable', () => {
  const store = mk([['A', 'NOK', null, 10, 50], ['B', 'USD', 'US0001', 10, 100]]);
  const fx = Portfolio.fxSplit(store, NOW);
  // B: cost 1000 USD at 10, now 1000 USD at 11: all currency effect.
  assert.ok(Math.abs(fx.price) < 1e-9 && Math.abs(fx.currency - 1000) < 1e-9);
  assert.strictEqual(fx.price + fx.currency, fx.total);
  const up = mk([['B', 'USD', 'US0001', 10, 120]]);
  const f2 = Portfolio.fxSplit(up, NOW);
  assert.ok(Math.abs(f2.price - 2000) < 1e-9);   // (1200 - 1000 USD) * 10
  assert.ok(Math.abs(f2.currency - 1200) < 1e-9); // 1200 USD * (11 - 10)
  assert.ok(Math.abs(f2.total - 3200) < 1e-9);
  assert.strictEqual(Portfolio.fxSplit(mk([['A', 'NOK', null, 10, 50]]), NOW), null, 'no foreign holding');
  const noFx = mk([['B', 'USD', 'US0001', 10, 120]]);
  delete noFx.transactions[0].fxRate;
  assert.strictEqual(Portfolio.fxSplit(noFx, NOW), null, 'no Vekslingskurs on the buy');
});

const div = (security, amount, type = 'UTBYTTE', extra = {}) => ({ security, type, tradeDate: '2026-06-01', bookDate: '2026-06-01', qty: null, amount, currency: 'NOK', ...extra });

test('dividendsBySecurity: gross, tax, net, yield on cost; total net equals the cash-flow dividends', () => {
  const store = mk([['A', 'NOK', null, 10, 50], ['B', 'USD', 'US0001', 10, 100]], [
    div('A', 30), div('A', -9, 'KUPONGSKATT'), div('A', 10),
    div('B', 5, 'UTBYTTE', { currency: 'USD', fxRate: 10 }),
  ]);
  const d = Portfolio.dividendsBySecurity(store);
  assert.deepStrictEqual(plain(d.rows.map((r) => r.security)), ['B', 'A']);
  const a = d.rows[1];
  assert.deepStrictEqual(plain([a.gross, a.tax, a.net]), [40, 9, 31]);
  assert.ok(Math.abs(a.yieldOnCost - (40 / 100) * 100) < 1e-9); // cost 10 * 10 NOK
  assert.strictEqual(d.rows[0].gross, 50);
  assert.strictEqual(d.total.net, Portfolio._debug.deriveCashFlow(store).netDividends);
  assert.strictEqual(d.total.gross, 90);
});

test('dividendsBySecurity: no dividends gives no rows', () => {
  assert.deepStrictEqual(plain(Portfolio.dividendsBySecurity(mk([['A', 'NOK', null, 10, 50]])).rows), []);
});

test('tradesCsvRows: header, trades only, ISO dates, numbers as-is', () => {
  const store = mk([['A', 'NOK', 'NO0001', 10, 50]]);
  const rows = [
    { date: '2026-01-05', cat: 'BUY', type: 'KJØPT', security: 'A', isin: null, qty: 10, price: 10, currency: 'NOK', amountNok: -100, feeNok: 1, realizedNok: null },
    { date: '2026-02-05', cat: 'DIVIDEND', type: 'UTBYTTE', security: 'A', amountNok: 5 },
    { date: '2026-03-05', cat: 'SELL', type: 'SALG', security: 'A, "Inc"', isin: 'NO0001', qty: 5, price: 12, currency: 'NOK', amountNok: 60, feeNok: 0, realizedNok: 10 },
  ];
  const out = Portfolio.tradesCsvRows(store, rows);
  assert.deepStrictEqual(plain(out[0]), ['Date', 'Type', 'Security', 'ISIN', 'Quantity', 'Price', 'Currency', 'Amount NOK', 'Fee NOK', 'Realized P/L NOK']);
  assert.strictEqual(out.length, 3);
  assert.deepStrictEqual(plain(out[1]), ['2026-01-05', 'KJØPT', 'A', 'NO0001', 10, 10, 'NOK', -100, 1, '']);
  assert.strictEqual(out[2][2], 'A, "Inc"');
  assert.strictEqual(out[2][9], 10);
  assert.deepStrictEqual(Portfolio.tradesCsvRows(store, []).length, 1);
});
