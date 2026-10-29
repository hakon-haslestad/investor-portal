const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const { baseWindow, load } = require('./harness');

// Mounts the real Portfolio view (Holdings and Activity) on the real portfolio
// code with a synthetic book that has a foreign holding, an ISIN-less holding,
// dividends and tax. A render that throws, or a helper used before it is set,
// fails here.
const stub = () => ({
  innerHTML: '', style: {}, dataset: {}, value: '', hidden: false, listeners: {},
  classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {}, querySelectorAll: () => [],
  addEventListener(t, fn) { this.listeners[t] = fn; },
});
function dom() {
  const cache = {};
  const q = (sel) => (cache[sel] = cache[sel] || stub());
  const body = { ...stub(), querySelector: q, querySelectorAll: () => [] };
  const el = { innerHTML: '', querySelector: (sel) => (sel === '#pf-body' ? body : q(sel)) };
  return { el, body, q };
}

function env(errors, csv) {
  const d = dom();
  const w = baseWindow({
    Sheet: {}, Charts: { tradeScatter: () => stub(), multiLine: () => stub() },
    Accounting: { downloadCsv: (f, rows) => csv.push({ f, rows }) },
    console: { ...console, error: (...a) => errors.push(a.join(' ')), warn: (...a) => errors.push(a.join(' ')) },
  });
  w.document.getElementById = () => stub();
  w.location = { replace() {}, hash: '' };
  vm.createContext(w);
  load(w, 'format.js', 'copy.js', 'parsers.js', 'ledger.js', 'prices.js', 'securities.js', 'positions.js', 'portfolio.js', 'metrics-info.js', 'components.js', 'views/portfolio.js');
  return { w, ...d };
}

function book(w, { dividends = true } = {}) {
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const sec = (name, ticker, currency, isin) => ({ name, ticker, isin, aliases: [], currency, status: 'held' });
  const registry = w.Securities.buildRegistry([sec('Alpha', 'ALP', 'NOK', 'NO0000000001'), sec('Beta', 'BET', 'USD', 'US0000000001'), sec('Gamma', 'GAM', 'NOK', null)]);
  w.Portfolio._setRegistry(registry);
  const rows = [['date', 'ALP', 'BET', 'GAM', 'CUR:USDNOK']];
  for (let n = 40; n >= 0; n--) rows.push([day(n), 10 + (n < 10 ? 2 : 0), 100 + (n < 10 ? 20 : 0), 10, n < 10 ? 11 : 10]);
  const tx = (security, type, d, qty, amount, extra = {}) => ({ security, type, tradeDate: day(d), bookDate: day(d), qty, amount, currency: 'NOK', ...extra });
  return {
    registry, prices: w.Prices.build(rows), members: [], kpis: [], attributionMap: new Map(),
    transactions: [
      { type: 'INNSKUDD', tradeDate: day(35), bookDate: day(35), amount: 9000, currency: 'NOK', saldo: 5000 },
      tx('Alpha', 'KJØPT', 30, 10, -100), tx('Beta', 'KJØPT', 30, 10, -1000, { currency: 'USD', fxRate: 10 }), tx('Gamma', 'KJØPT', 30, 10, -100),
      tx('Alpha', 'SALG', 5, 2, 24),
      ...(dividends ? [tx('Alpha', 'UTBYTTE', 4, 0, 12), tx('Alpha', 'KUPONGSKATT', 4, 0, -3)] : []),
    ],
  };
}

async function mount(w, ui, store, tab) {
  await w.Views.portfolio(ui.el, { store, params: [tab] });
  return ui.body.innerHTML;
}

test('Holdings mounts with data: allocation card, splits, FX line, console clean', async () => {
  const errors = [];
  const e = env(errors, []);
  const html = await mount(e.w, e, book(e.w), 'holdings');
  assert.match(html, /Allocation/);
  assert.match(html, /Top 5 positions/);
  assert.match(html, /Unknown/);
  assert.doesNotMatch(html, /\+\d+,\d%<\/div>\s*<div class="sub">of holdings/, 'shares carry no plus sign');
  assert.match(html, /foreign holdings: price/);
  assert.match(html, /Holdings by currency/);
  assert.deepStrictEqual([...errors], []);
});

test('Holdings with an empty book shows no allocation card and does not throw', async () => {
  const errors = [];
  const e = env(errors, []);
  const store = book(e.w); store.transactions = [];
  const html = await mount(e.w, e, store, 'holdings');
  assert.doesNotMatch(html, /Top 5 positions/);
  assert.deepStrictEqual([...errors], []);
});

test('Activity mounts with data: dividends table totals, CSV button downloads the trades', async () => {
  const errors = [], csv = [];
  const e = env(errors, csv);
  const store = book(e.w);
  const html = await mount(e.w, e, store, 'activity');
  assert.match(html, /Dividends by security/);
  assert.match(html, /<strong>Total<\/strong>/);
  assert.ok(html.includes(e.w.Fmt.fmtNok(9)), 'net 12 - 3');
  assert.match(html, /Download trades CSV/);
  e.q('#act-csv').listeners.click();
  assert.strictEqual(csv.length, 1);
  assert.match(csv[0].f, /^trades-\d{4}-\d\d-\d\d-\d{4}-\d\d-\d\d\.csv$/);
  assert.strictEqual(csv[0].rows.length, 1 + 4); // header + three buys + one sale
  assert.deepStrictEqual([...errors], []);
});

test('Activity with no dividends renders no dividends table and does not throw', async () => {
  const errors = [];
  const e = env(errors, []);
  const html = await mount(e.w, e, book(e.w, { dividends: false }), 'activity');
  assert.doesNotMatch(html, /Dividends by security/);
  assert.deepStrictEqual([...errors], []);
});

test('Activity with an empty book does not throw and shows no dividends table or enabled CSV', async () => {
  const errors = [];
  const e = env(errors, []);
  const store = book(e.w); store.transactions = [];
  const html = await mount(e.w, e, store, 'activity');
  assert.doesNotMatch(html, /Dividends by security/);
  assert.match(html, /id="act-csv" disabled/);
  assert.deepStrictEqual([...errors], []);
});
