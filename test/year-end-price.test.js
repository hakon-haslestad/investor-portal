const test = require('node:test');
const assert = require('node:assert');
const { context } = require('./harness');

// Issue #85: the 31.12 price of the calculated books is the last trading-day
// close in StockPrices, in NOK with that day's FX, never a later price.
// Synthetic tickers and prices only.
const w = context(['parsers.js', 'ledger.js', 'prices.js', 'securities.js', 'positions.js', 'portfolio.js', 'books.js']);
const { Securities, Portfolio, Prices, Books } = w;
const sec = (name, ticker, currency, isin) => ({ name, ticker, currency, isin, aliases: [], status: 'active' });
Portfolio._setRegistry(Securities.buildRegistry([
  sec('Alpha', 'AAA', 'NOK', 'XX0000000001'), sec('Svea', 'SSS', 'SEK', 'SE0000000002'), sec('Late', 'LLL', 'NOK', 'XX0000000003'),
  sec('Gone', '', 'NOK', 'XX0000000004'),
]));
const store = { prices: Prices.build([
  ['date', 'AAA', 'SSS', 'LLL', 'CUR:SEKNOK', 'TX:Gone'],
  ['2031-12-01', 9, 100, null, 0.9, 4],
  ['2031-12-29', 10, 110, null, 1.0, null],  // the last trading day of 2031
  ['2032-01-02', 99, 999, 50, 2.0, null],
]) };

test('the last close on or before 31.12, not a later one', () => {
  const p = Portfolio.yearEndPrice(store, 'Alpha', 'XX0000000001', '2031-12-31');
  assert.deepStrictEqual({ ...p }, { nok: 10, date: '2031-12-29', source: 'close' });
});

test('foreign shares use the FX rate of the same day', () => {
  const p = Portfolio.yearEndPrice(store, 'Svea', null, '2031-12-31');
  assert.strictEqual(p.nok, 110);
  assert.strictEqual(p.date, '2031-12-29');
});

test('a series that starts after 31.12 gives no price (never a borrowed later one)', () => {
  assert.strictEqual(Portfolio.yearEndPrice(store, 'Late', 'XX0000000003', '2031-12-31'), null);
});

test('a security with no market close falls back to the last own trade, and says so', () => {
  const p = Portfolio.yearEndPrice(store, 'Gone', null, '2031-12-31');
  assert.strictEqual(p.nok, 4);
  assert.strictEqual(p.source, 'last own trade');
});

test('the Nordnet year shows the price, its date and source, and flags an old one', () => {
  let id = 0;
  const tx = (type, date, security, isin, qty, amount) => ({ nordnetId: String(++id), bookDate: date, type, security, isin, qty, amount, currency: 'NOK' });
  const txs = [tx('KJØPT', '2031-03-01', 'Alpha', 'XX0000000001', 10, -80), tx('KJØPT', '2031-03-01', 'Gone', 'XX0000000004', 5, -50)];
  const r = Books.nordnetYear(txs, (s, isin) => Portfolio.yearEndPrice(store, s, isin, '2031-12-31'), Books.parseInputs([]), 2031);
  const a = r.rows.find((x) => x.security === 'Alpha'), g = r.rows.find((x) => x.security === 'Gone');
  assert.strictEqual(a.markedsverdi, 100);
  assert.strictEqual(a.prisDato, '2031-12-29');
  assert.strictEqual(a.prisKilde, 'close');
  assert.ok(!r.flags.some((f) => /Alpha/.test(f)));
  assert.strictEqual(g.markedsverdi, 20);
  assert.ok(r.flags.some((f) => /price for Gone is from 2031-12-01 \(the last own trade/.test(f)), r.flags.join(' | '));
  const typed = Books.nordnetYear(txs, (s, isin) => Portfolio.yearEndPrice(store, s, isin, '2031-12-31'), Books.parseInputs([['PRICE', 'Alpha', 2031, '12,5']]), 2031);
  assert.strictEqual(typed.rows.find((x) => x.security === 'Alpha').prisKilde, 'PRICE row');
});

test('a security with status delisted is worth 0 at year-end, with no fetch needed', () => {
  const w2 = context(['parsers.js', 'ledger.js', 'prices.js', 'securities.js', 'positions.js', 'portfolio.js']);
  w2.Portfolio._setRegistry(w2.Securities.buildRegistry([{ name: 'Bust', ticker: '', currency: 'NOK', isin: 'XX0000000009', aliases: [], status: 'delisted' }]));
  const st = { prices: w2.Prices.build([['date', 'TX:Bust'], ['2030-05-01', 7]]) };
  const p = w2.Portfolio.yearEndPrice(st, 'Bust', 'XX0000000009', '2031-12-31');
  assert.deepStrictEqual({ ...p }, { nok: 0, date: null, source: 'delisted' });
});

test('delisted: a year-end while it still traded keeps its close; after that it is 0, never an old own trade', () => {
  const w3 = context(['parsers.js', 'ledger.js', 'prices.js', 'securities.js', 'positions.js', 'portfolio.js']);
  w3.Portfolio._setRegistry(w3.Securities.buildRegistry([{ name: 'Bst', ticker: 'BST', currency: 'NOK', isin: 'XX0000000010', aliases: [], status: 'delisted' }]));
  const st = { prices: w3.Prices.build([['date', 'BST', 'TX:Bst'], ['2031-12-30', 80, 70], ['2032-06-01', 5, null]]) };
  assert.strictEqual(w3.Portfolio.yearEndPrice(st, 'Bst', null, '2031-12-31').nok, 80, 'still traded at 31.12.2031');
  assert.deepStrictEqual({ ...w3.Portfolio.yearEndPrice(st, 'Bst', null, '2033-12-31') }, { nok: 0, date: null, source: 'delisted' });
});
