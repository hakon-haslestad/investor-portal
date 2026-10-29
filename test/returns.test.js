const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const { baseWindow, load } = require('./harness');

function env() {
  const w = baseWindow({ Charts: {} });
  vm.createContext(w);
  load(w, 'format.js', 'parsers.js', 'ledger.js', 'prices.js', 'securities.js', 'positions.js', 'portfolio.js', 'returns.js');
  return w;
}
const plain = (x) => JSON.parse(JSON.stringify(x));
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

// Hand-worked TWR. Day 0 value 1000 (base). Day 1: flow +500 at start of day,
// value 1650 -> 1650 / (1000 + 500) - 1 = +10 %. Day 2: flow +350, value 2200
// -> 2200 / (1650 + 350) - 1 = +10 %. TWR = 1.1 * 1.1 - 1 = 21 %; index 100, 110, 121.
test('twrChain chain-links daily returns with the flow at the start of the day', () => {
  const r = window_().twrChain([
    { date: '2026-01-01', value: 1000, flow: 0 },
    { date: '2026-01-02', value: 1650, flow: 500 },
    { date: '2026-01-03', value: 2200, flow: 350 },
  ]);
  near(r.twr, 0.21);
  assert.deepStrictEqual(plain(r.index.map((p) => Math.round(p.y * 1e6) / 1e6)), [100, 110, 121]);
  assert.strictEqual(window_().twrChain([{ date: '2026-01-01', value: 5, flow: 0 }]), null);
  assert.strictEqual(window_().twrChain([]), null);
});

test('twrChain skips a day whose base is not positive instead of dividing by zero', () => {
  const r = window_().twrChain([
    { date: 'a', value: 0, flow: 0 }, { date: 'b', value: 100, flow: 100 }, { date: 'c', value: 110, flow: 0 },
  ]);
  near(r.twr, 0.10);
});

// Closed form: deposit 1000, worth 1100 after exactly 365 days -> 10 % a year.
// Two deposits (1000 at t0, 1000 at +365d, end 2310 at +730d): x = 1+r solves
// 1000 x^2 + 1000 x = 2310 -> x = 1.1, so r = 10 %.
test('xirr matches the closed form and returns null without a sign change', () => {
  const { xirr } = window_();
  near(xirr([{ date: '2025-01-01', amount: 1000 }], '2026-01-01', 1100), 0.10, 1e-6);
  near(xirr([{ date: '2025-01-01', amount: 1000 }, { date: '2026-01-01', amount: 1000 }], '2027-01-01', 2310), 0.10, 1e-6);
  near(xirr([{ date: '2025-01-01', amount: 1000 }], '2026-01-01', 500), -0.5, 1e-6);
  assert.strictEqual(xirr([{ date: '2025-01-01', amount: 1000 }], '2026-01-01', 0), null);
  assert.strictEqual(xirr([], '2026-01-01', 100), null);
  assert.strictEqual(xirr([{ date: '2026-01-01', amount: 1000 }], '2026-01-01', 1100), null);
});

let W;
function window_() { return (W = W || env()).Returns; }

function store(w, { index = true } = {}) {
  const sec = (name, ticker) => ({ name, ticker, isin: null, aliases: [], currency: 'NOK', status: 'held' });
  w.Portfolio._setRegistry(w.Securities.buildRegistry([sec('Owned', 'OWN')]));
  const rows = [['date', 'OWN', ...(index ? ['IDX:OSEBX'] : [])]];
  rows.push(['2026-03-02', 10, ...(index ? [1000] : [])]);
  rows.push(['2026-03-03', 10, ...(index ? [1100] : [])]);
  rows.push(['2026-03-06', 12, ...(index ? [1210] : [])]);
  const tx = (type, d, qty, amount) => ({ security: type === 'KJØPT' ? 'Owned' : '', type, tradeDate: d, bookDate: d, qty, amount, currency: 'NOK', saldo: 0 });
  return {
    prices: w.Prices.build(rows),
    transactions: [tx('INNSKUDD', '2026-03-02', 0, 1000), tx('KJØPT', '2026-03-02', 50, -500), tx('INNSKUDD', '2026-03-04', 0, 100)],
  };
}

test('benchmark indexes OSEBX to 100 at the window start and forward-fills the start date', () => {
  const w = env(); const s = store(w);
  const b = w.Returns.benchmark(s, '2026-03-01', '2026-03-06');
  assert.strictEqual(b, null, 'no point at or before the start: no line');
  const c = w.Returns.benchmark(s, '2026-03-02', '2026-03-06');
  assert.deepStrictEqual(plain(c.points.map((p) => [p.date, Math.round(p.y * 1e6) / 1e6])), [['2026-03-02', 100], ['2026-03-03', 110], ['2026-03-06', 121]]);
  near(c.pct, 0.21);
  const mid = w.Returns.benchmark(s, '2026-03-04', '2026-03-06');
  near(mid.points[0].y, 100); near(mid.pct, 0.1);
});

test('benchmark is null when the IDX:OSEBX column is missing', () => {
  const w = env();
  assert.strictEqual(w.Returns.benchmark(store(w, { index: false }), '2026-03-02', '2026-03-06'), null);
  assert.strictEqual(w.Returns.benchmark({ prices: w.Prices.build([]), transactions: [] }, 'a', 'b'), null);
});

// Flows: +1000 on day 1 (in the base value), +100 on a Wednesday with no price
// row, which rolls to the next priced day (03-06). Cash is the latest saldo.
test('clubSeries builds daily value, rolls weekend flows to the next priced day and feeds xirr', () => {
  const w = env(); const s = store(w);
  s.transactions[0].saldo = 500; s.transactions[1].saldo = 500; s.transactions[2].saldo = 600;
  const c = w.Returns.clubSeries(s, '2026-03-02', '2026-03-06');
  assert.deepStrictEqual(plain(c.days.map((d) => [d.date, d.value, d.flow])), [
    ['2026-03-02', 1000, 0], ['2026-03-03', 1000, 0], ['2026-03-06', 1200, 100],
  ]);
  // 03-06: 1200 / (1000 + 100) - 1
  near(c.twr, 1200 / 1100 - 1);
  assert.strictEqual(c.xirrFlows[0].amount, 1000);
  assert.strictEqual(c.endValue, 1200);
  assert.ok(c.xirr > 0);
  assert.strictEqual(w.Returns.clubSeries({ prices: w.Prices.build([]), transactions: [] }, 'a', 'b'), null);
});

// Flows are keyed like the cash saldo: bookDate first. A deposit traded on
// 03-02 (a priced day) but booked 03-06 moves cash on 03-06, so the flow must
// land on 03-06 too, not vanish before day 0.
test('clubSeries keys a flow by bookDate when it differs from tradeDate', () => {
  const w = env(); const s = store(w);
  s.transactions = [
    { security: '', type: 'INNSKUDD', tradeDate: '2026-03-02', bookDate: '2026-03-02', qty: 0, amount: 1000, currency: 'NOK', saldo: 1000 },
    { security: '', type: 'INNSKUDD', tradeDate: '2026-03-02', bookDate: '2026-03-06', qty: 0, amount: 200, currency: 'NOK', saldo: 1200 },
  ];
  const c = w.Returns.clubSeries(s, '2026-03-02', '2026-03-06');
  assert.deepStrictEqual(plain(c.days.map((d) => d.flow)), [0, 0, 200]);
  assert.ok(c.xirrFlows.some((f) => f.date === '2026-03-06' && f.amount === 200));
});

test('clubSeries converts a foreign-currency flow to NOK like the ledger', () => {
  const w = env(); const s = store(w);
  s.transactions = [{ security: '', type: 'INNSKUDD', tradeDate: '2026-03-03', bookDate: '2026-03-03', qty: 0, amount: 100, currency: 'USD', fxRate: 10, saldo: 1000 }];
  assert.strictEqual(w.Returns.clubSeries(s, '2026-03-02', '2026-03-06').days[1].flow, 1000);
});

test('benchmark forward-fills the last close to the end date when the index misses the last days', () => {
  const w = env(); const s = store(w);
  s.prices = w.Prices.build([['date', 'OWN', 'IDX:OSEBX'], ['2026-03-02', 10, 1000], ['2026-03-03', 10, 1100], ['2026-03-06', 12, '']]);
  const b = w.Returns.benchmark(s, '2026-03-02', '2026-03-06');
  assert.deepStrictEqual(plain(b.points.map((p) => [p.date, Math.round(p.y * 1e6) / 1e6])), [['2026-03-02', 100], ['2026-03-03', 110], ['2026-03-06', 110]]);
  near(b.pct, 0.1);
});

// Wiring invariant (no behaviour to call): the page loads returns.js before
// the views, and every info key the dashboard section uses has an entry.
test('index.html loads returns.js before the views and metrics-info defines twr, xirr, benchmark', () => {
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'docs', 'index.html'), 'utf8');
  assert.ok(html.indexOf('js/returns.js') > 0 && html.indexOf('js/returns.js') < html.indexOf('js/views/dashboard.js'));
  const w = baseWindow(); vm.createContext(w); load(w, 'metrics-info.js');
  for (const k of ['twr', 'xirr', 'benchmark', 'return-pct']) assert.ok(w.MetricsInfo[k] && w.MetricsInfo[k].calc, k);
});
