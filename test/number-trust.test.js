const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const { baseWindow, load } = require('./harness');

// Counts, labels and quantities on Dashboard / Investors / Portfolio. The
// views are mounted for real on a fake DOM so a render that throws fails here.
const split = (...c) => c.map(([code, weight]) => ({ code, weight }));
const store = {
  attributionMap: new Map([['A', split(['HH', 0.5], ['HS', 0.5])], ['B', split(['HH', 1])]]),
  registry: { forName: () => null }, members: [], prices: null, // no price matrix: the real Portfolio treats it as 'no prices'
  transactions: [
    { security: 'A', type: 'KJØPT', tradeDate: '2024-02-01', qty: 10, amount: -100, currency: 'NOK' },
    { security: 'A', type: 'KJØPT', tradeDate: '2024-03-01', qty: 10, amount: -100, currency: 'NOK' },
    { security: 'B', type: 'KJØPT', tradeDate: '2024-04-01', qty: 10, amount: -100, currency: 'NOK' },
    { security: 'A', type: 'SALG', tradeDate: '2024-05-01', qty: 5, amount: 150, currency: 'NOK' },
  ],
};
const CLUB = { total: 1, marketValue: 1, attributed: 1, unattributed: 0, cash: 0, unattributedNames: [], missingFx: 0 };
const node = () => ({ innerHTML: '', style: {}, dataset: {}, value: '', addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] });
const WIN = { preset: 'ytd', from: '2024-01-01', to: '2024-12-31' };

function env(extra = {}) {
  const el = (id) => ({ id, innerHTML: '', style: {}, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [] });
  const w = baseWindow({ Sheet: { spreadsheetTitle: async () => 'Club' }, Charts: {}, TimeSeries: { buildPortfolioValueSeries: () => [] }, ...extra });
  w.document.getElementById = el;
  vm.createContext(w);
  load(w, 'format.js', 'copy.js', 'parsers.js', 'ledger.js', 'prices.js', 'portfolio.js', 'returns.js', 'components.js', 'views/dashboard.js', 'views/investors.js', 'views/portfolio.js');
  return w;
}
const metrics = () => env().Portfolio.windowMetrics(store, WIN.from, WIN.to);

test('windowMetrics counts a split trade once; per-investor counts stay "trades taken part in"', () => {
  const wm = metrics();
  assert.deepStrictEqual([wm.group.buyCount, wm.group.sellCount], [3, 1]);
  assert.deepStrictEqual([wm.perInvestor.HH.buyCount, wm.perInvestor.HS.buyCount], [3, 2]);
  assert.strictEqual(wm.group.buyTrades.size, 3);
});

test('fmtQty keeps decimals, whole numbers stay whole, under 1 keeps two decimals', () => {
  const { fmtQty } = env().Fmt;
  assert.strictEqual(fmtQty(7.45), '7,45');
  assert.strictEqual(fmtQty(12), '12');
  assert.strictEqual(fmtQty(1234), (1234).toLocaleString('nb-NO'));
  assert.strictEqual(fmtQty(0.5), '0,50');
});

async function dashboard(filter, wm) {
  const w = env();
  const real = w.Portfolio;
  const hold = (security, currency, extra) => ({ security, currency, qty: 7.45, gav: 100, currentPrice: 150, marketValueNok: 7.45 * 150, returnNok: 10, returnPct: 1, priced: true, snapshotDate: '2024-06-01', ...extra });
  w.Portfolio = { ...real,
    usePriceMatrix: () => false,
    buildDashboard: () => ({ window: WIN, windowMetrics: wm || real.windowMetrics(store, WIN.from, WIN.to), snapshotDate: '2024-06-01', group: {}, perInvestor: { HH: {}, HS: {} } }),
    currentHoldings: () => [hold('Acme', 'USD', { currentPrice: 110.5, marketValueNok: 7.45 * 1108 }), hold('Fjord', 'NOK')] };
  if (filter) w.localStorage.setItem('portal.filter', filter);
  const el = { ...node(), classList: { add() {} }, querySelectorAll: () => [], querySelector: () => node() };
  await w.Views.dashboard(el, { store });
  return { html: el.innerHTML, w };
}

test('Dashboard: trades counted once, multi-select unions them and weights the return', async () => {
  assert.match((await dashboard()).html, />3 buys</);
  const { html, w } = await dashboard('HH,HS');
  assert.match(html, />3 buys</);
  assert.match(html, />1 sells</);
  assert.ok(html.includes(`>${w.Fmt.fmtPct((100 / 300) * 100)}<`), 'sum P/L over sum basis');
});

test('Dashboard multi-select with unequal basis: sum P/L over sum basis, not an average of percentages', async () => {
  const side = (netPnlInWindow, basis) => ({ netPnlInWindow, basis, periodReturnPct: (netPnlInWindow / basis) * 100, buyTrades: new Set(), sellTrades: new Set() });
  const wm = { group: side(20, 1000), perInvestor: { HH: side(10, 100), HS: side(10, 900) } };
  const { html, w } = await dashboard('HH,HS', wm);
  assert.ok(html.includes(`>${w.Fmt.fmtPct(2)}<`), '20 / 1000 = 2%, not the 5.5% average');
});

test('Dashboard holdings: foreign price carries its ISO code and the NOK value; avg cost is labelled kr', async () => {
  const { html } = await dashboard();
  assert.match(html, /110,5 USD/);
  assert.match(html, /1[\s ]108[\s ]kr/);
  assert.match(html, /Avg cost \(kr\)/);
  assert.doesNotMatch(html, /Fjord[\s\S]*?150 NOK/);
});

test('Investors overview and detail say "change incl. deposits"; Portfolio holdings too', async () => {
  const w = env();
  const row = { totalValue: 1, marketValue: 1, realized: 0, unrealized: 0, dividends: 0, portfolioReturnPct: 1 };
  const perInvestor = Object.fromEntries(w.Ledger.INVESTOR_CODES.map((c) => [c, row]));
  const detail = { summary: { ...row, invested: 1, holdings: [] }, previous: [], recent: [] };
  const then = { mv: 100, total: 100, cash: 100, unrealized: 0 };
  w.Portfolio = { ...w.Portfolio, usePriceMatrix: () => true, buildDashboard: () => ({ perInvestor }),
    investorValueAt: () => then, groupValueAt: () => then, investorDetail: () => detail, computeWindow: () => WIN,
    windowMetrics: () => ({ perInvestor: { HH: { periodReturnPct: 1, netPnlInWindow: 1 } } }),
    clubTotal: () => CLUB, currentHoldings: () => [], cash: { latestSaldo: () => 5 } };
  const mount = async (view, params, pb = { ...node() }) => {
    const el = { ...node(), classList: { add() {} }, querySelector: () => pb };
    await w.Views[view](el, { store: { ...store, prices: { latestDate: '2024-06-01', series: new Map() } }, params, navigate() {} });
    return view === 'portfolio' ? pb.innerHTML : el.innerHTML;
  };
  const overview = await mount('investors', []);
  assert.match(overview, /Change 1m/);
  assert.doesNotMatch(overview, /Δ/);
  assert.match(overview, /change incl\. deposits/);
  assert.match(await mount('investors', ['HH']), /change incl\. deposits vs 2024-01-01/);
  assert.match(await mount('portfolio', ['holdings']), /change incl\. deposits vs 2024-01-01/);
});
