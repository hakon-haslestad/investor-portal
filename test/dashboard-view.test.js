const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const { baseWindow, load } = require('./harness');

// Mounts the real Dashboard on the real portfolio code with a synthetic book
// (an `Alle` name, a no-owner name, a stale ticker). The four "right now" KPI
// cards must show the same text they showed when the view computed them
// itself, and must now come from Portfolio.summary.
const node = () => ({ innerHTML: '', style: {}, dataset: {}, value: '', classList: { add() {}, remove() {} }, addEventListener() {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [] });

function env(errors = []) {
  const w = baseWindow({
    Sheet: { spreadsheetTitle: async () => 'Club', getValues: async () => [] }, Charts: {},
    TimeSeries: { buildPortfolioValueSeries: () => [] }, PORTAL_CONFIG: { TABS: { priceLog: '_log' } },
    console: { ...console, error: (...a) => errors.push(a.join(' ')), warn: (...a) => errors.push(a.join(' ')) },
  });
  w.document.getElementById = () => node();
  vm.createContext(w);
  load(w, 'format.js', 'copy.js', 'parsers.js', 'ledger.js', 'prices.js', 'securities.js', 'positions.js', 'portfolio.js', 'returns.js', 'components.js', 'views/dashboard.js');
  return w;
}

function book(w, { sells = true, bench = false } = {}) {
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const sec = (name, ticker) => ({ name, ticker, isin: null, aliases: [], currency: 'NOK', status: 'held' });
  const registry = w.Securities.buildRegistry([sec('Owned', 'OWN'), sec('Everyone', 'ALL'), sec('Orphan', 'ORP'), sec('Stale', 'STL')]);
  w.Portfolio._setRegistry(registry);
  const rows = [['date', 'OWN', 'ALL', 'ORP', 'STL', ...(bench ? ['IDX:OSEBX'] : [])]];
  for (let n = 40; n >= 0; n--) rows.push([day(n), 10 + (n < 10 ? 2 : 0), 10, 10, n > 25 ? 10 : '', ...(bench ? [1000 + (40 - n) * 5] : [])]);
  const tx = (security, type, d, qty, amount) => ({ security, type, tradeDate: day(d), bookDate: day(d), qty, amount, currency: 'NOK' });
  return {
    registry, prices: w.Prices.build(rows), members: [], kpis: [],
    attributionMap: new Map([['Owned', [{ code: 'HH', weight: 1 }]], ['Everyone', [{ code: 'Alle', weight: 1 }]]]),
    transactions: [
      { type: 'INNSKUDD', tradeDate: day(35), bookDate: day(35), amount: 5000, currency: 'NOK', saldo: 5000 },
      tx('Owned', 'KJØPT', 30, 10, -100), tx('Everyone', 'KJØPT', 30, 10, -100), tx('Orphan', 'KJØPT', 30, 10, -100), tx('Stale', 'KJØPT', 30, 10, -100),
      ...(sells ? [tx('Owned', 'SALG', 5, 5, 70), tx('Everyone', 'UTBYTTE', 4, 0, 12)] : []),
    ],
  };
}

const KPI = ['Total portfolio', 'Holdings MV', 'Dry powder', 'Unrealized P/L'];
function kpis(html) {
  const out = {};
  for (const k of KPI) {
    const m = html.match(new RegExp(`<div class="label">${k}[\\s\\S]*?<div class="value[^"]*">(.*?)</div>`));
    out[k] = m && m[1];
  }
  return out;
}
async function mount(w, store) {
  const el = { ...node(), querySelector: () => node() };
  await w.Views.dashboard(el, { store });
  return el;
}

test('Dashboard mounts with data and the four KPI cards show the unchanged numbers, console clean', async () => {
  const errors = [];
  const w = env(errors); const store = book(w);
  const el = await mount(w, store);
  const g = w.Portfolio.buildDashboard(store).group;
  const f = w.Fmt.fmtNok;
  assert.deepStrictEqual({ ...kpis(el.innerHTML) }, {
    'Total portfolio': f(g.totalValue), 'Holdings MV': f(g.marketValue), 'Dry powder': f(g.cash), 'Unrealized P/L': f(g.unrealized),
  });
  assert.match(el.innerHTML, /Club total/);
  assert.deepStrictEqual([...errors], []);
});

test('the KPI cards read Portfolio.summary, not a second computation', async () => {
  const w = env(); const store = book(w);
  const real = w.Portfolio.summary;
  w.Portfolio.summary = (s, a) => { const x = real(s, a); return { ...x, value: { ...x.value, total: 123456, marketValue: 7000, cash: 99 }, profit: { ...x.profit, unrealized: 4242 } }; };
  const k = kpis((await mount(w, store)).innerHTML);
  const f = w.Fmt.fmtNok;
  assert.deepStrictEqual({ ...k }, { 'Total portfolio': f(123456), 'Holdings MV': f(7000), 'Dry powder': f(99), 'Unrealized P/L': f(4242) });
});

test('a one-investor filter still shows that investor\'s own numbers', async () => {
  const w = env(); const store = book(w);
  w.localStorage.setItem('portal.filter', 'HH');
  const k = kpis((await mount(w, store)).innerHTML);
  const inv = w.Portfolio.buildDashboard(store).perInvestor.HH;
  assert.strictEqual(k['Total portfolio'], w.Fmt.fmtNok(inv.totalValue));
  assert.strictEqual(k['Unrealized P/L'], w.Fmt.fmtNok(inv.unrealized));
});

test('an empty book shows the empty state and does not throw', async () => {
  const errors = [];
  const w = env(errors); const store = book(w); store.transactions = [];
  const el = await mount(w, store);
  assert.match(el.innerHTML, /No transactions yet/);
  assert.deepStrictEqual([...errors], []);
});

// Club return vs OSEBX. A stub Charts.multiLine records the series it is given.
async function mountWithChart(w, store) {
  const calls = [];
  w.Charts.multiLine = (o) => { calls.push(o); return {}; };
  const mountNode = { ...node(), appendChild() {} };
  const el = { ...node(), querySelector: (q) => (q === '#returns-chart' ? mountNode : node()) };
  await w.Views.dashboard(el, { store });
  return { el, calls };
}

test('Club return vs OSEBX shows TWR, XIRR, the old metric relabelled and OSEBX, and charts both lines from 100', async () => {
  const errors = [];
  const w = env(errors); const store = book(w, { bench: true });
  const { el, calls } = await mountWithChart(w, store);
  const html = el.innerHTML;
  assert.match(html, /Club return vs OSEBX/);
  for (const label of ['TWR', 'XIRR', 'Profit / total bought', 'OSEBX']) assert.ok(html.includes(label), label);
  assert.match(html, /per-investor/i);
  assert.ok(!/benchmark not available yet/.test(html));
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual([...calls[0].series.map((s) => s.points[0].y)], [100, 100]);
  assert.strictEqual(calls[0].series.length, 2);
  assert.strictEqual(calls[0].fitY, true, 'index chart zooms to the data, not to zero');
  assert.ok(calls[0].title.includes('Club ') && calls[0].title.includes('OSEBX '), calls[0].title);
  assert.match(calls[0].title, /[+-]?\d+(\.\d+)?\s?%/, 'chart label names the result');
  assert.match(html, /<span aria-hidden="true" style="color:#1FE0CE">/);
  assert.match(html, /<span aria-hidden="true" style="color:#FF9F1C">/);
  assert.deepStrictEqual([...errors], []);
});

test('without an IDX:OSEBX column the benchmark card and line are hidden and the page says so', async () => {
  const errors = [];
  const w = env(errors); const store = book(w);
  const { el, calls } = await mountWithChart(w, store);
  assert.match(el.innerHTML, /benchmark not available yet/);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].series.length, 1, 'club line only, never a flat OSEBX line');
  assert.match(el.innerHTML, /TWR/);
  assert.deepStrictEqual([...errors], []);
});

test('with an investor filter the returns section says club-level only and draws nothing', async () => {
  const w = env(); const store = book(w, { bench: true });
  w.localStorage.setItem('portal.filter', 'HH');
  const { el, calls } = await mountWithChart(w, store);
  assert.match(el.innerHTML, /club-level only/);
  assert.strictEqual(calls.length, 0);
});

test('fewer than two priced days: the section degrades without an error', async () => {
  const errors = [];
  const w = env(errors); const store = book(w, { bench: true });
  store.prices = w.Prices.build([['date', 'OWN', 'IDX:OSEBX'], [new Date().toISOString().slice(0, 10), 10, 1000]]);
  const { el, calls } = await mountWithChart(w, store);
  assert.match(el.innerHTML, /Club return vs OSEBX/);
  assert.strictEqual(calls.length, 0);
  assert.deepStrictEqual([...errors], []);
});

test('XIRR shows "—" with "needs 90 days or more" on a short window, the number on a long one', async () => {
  for (const [from, to, shows] of [['2026-03-02', '2026-04-15', false], ['2026-01-02', '2026-10-28', true]]) {
    const w = env([]); const store = book(w, { bench: true });
    const real = w.Returns.clubSeries;
    w.Returns = { ...w.Returns, clubSeries: (...a) => { const c = real(...a) || {}; return { ...c, days: [{ date: from, value: 100 }], endDate: to, xirr: 0.55, twr: 0.02, index: c.index || [] }; } };
    const { el } = await mountWithChart(w, store);
    const card = el.innerHTML.slice(el.innerHTML.indexOf('>XIRR'), el.innerHTML.indexOf('>XIRR') + 400);
    if (shows) { assert.match(card, /55/); assert.doesNotMatch(card, /needs 90 days/); }
    else { assert.match(card, /—/); assert.match(card, /needs 90 days or more/); }
  }
});
