const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const { baseWindow, load } = require('./harness');

// Views mounted with data in the shapes that used to print "-0,0" or a dot
// decimal: negative gap, tiny negative, null P/E, a share-weighted holding.
// Every number the user sees must use comma, true minus (U+2212), no "-0".
const CLUB = { total: 1, marketValue: 1, attributed: 1, unattributed: 0, cash: 0, unattributedNames: [], missingFx: 0 };
const node = () => ({ innerHTML: '', style: {}, dataset: {}, value: '', addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] });
const WIN = { preset: 'ytd', from: '2024-01-01', to: '2024-12-31' };
const side = { netPnlInWindow: -0.4, basis: 100, periodReturnPct: -0.04, buyTrades: new Set(), sellTrades: new Set() };
const store = { attributionMap: new Map(), registry: { forName: () => null }, members: [], prices: { latestDate: '2024-06-01', series: new Map() },
  kpis: [{ company: 'Acme', period: '2023', revenue: 100, eat: 10, eps: '1,23', pe: -3.456, pb: null, ps: 0.049, yourRevNok: -1234.5, yourProfitNok: -0.2 }],
  transactions: [{ security: 'Acme', type: 'KJØPT', tradeDate: '2024-02-01', qty: 3, amount: -30, currency: 'NOK' }] };

function env() {
  const el = (id) => ({ id, innerHTML: '', style: {}, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [] });
  const w = baseWindow({ Sheet: { spreadsheetTitle: async () => 'Club' }, Charts: {}, TimeSeries: { buildPortfolioValueSeries: () => [] } });
  w.document.getElementById = el;
  vm.createContext(w);
  load(w, 'format.js', 'copy.js', 'parsers.js', 'ledger.js', 'prices.js', 'portfolio.js', 'returns.js', 'components.js', 'views/dashboard.js', 'views/investors.js', 'views/portfolio.js');
  return w;
}
// No ASCII hyphen before a digit and no dot decimal in visible text.
function assertClean(html, what) {
  const text = html.replace(/<[^>]*>/g, ' ');
  assert.doesNotMatch(text, /(^|[\s(>])-\d/, `${what}: ASCII minus in text`);
  assert.doesNotMatch(text, /[+−]?\d\.\d/, `${what}: dot decimal in text`);
  assert.doesNotMatch(text, /[-−]0(,0+)?%/, `${what}: signed zero`);
}

test('Dashboard look-through: gap %, P/E, P/B, P/S, weight use the one number rule', async () => {
  const w = env();
  const hold = { security: 'Acme', currency: 'NOK', qty: 3, gav: 10, currentPrice: 12, marketValueNok: 36, returnNok: -0.2, returnPct: -0.04, priced: true, snapshotDate: '2024-06-01' };
  const rows = [
    { security: 'Acme', period: '2023', qty: 3, earningsNok: -5, revenueNok: 1234, bookNok: 10, pe: -3.456, pb: 0.049, ps: 1.5, fundamentalValue: 20, marketValueNok: 36, gapPct: -42.6 },
    { security: 'Beta', period: '2023', qty: 1, earningsNok: 5, revenueNok: 10, bookNok: null, pe: null, pb: null, ps: null, fundamentalValue: 20, marketValueNok: 20, gapPct: -0.04 },
  ];
  w.Fundamentals = { buildLookThrough: () => ({ rows, missing: [], totals: { gapPct: -12.34, fundamentalValue: 5000, earnings: -1, revenue: 9, portfolioPe: 12.34, earningsYieldPct: 8.1, book: 5, pb: 0.84 } }) };
  w.Portfolio = { ...w.Portfolio, usePriceMatrix: () => true,
    buildDashboard: () => ({ window: WIN, windowMetrics: { group: side, perInvestor: {} }, snapshotDate: '2024-06-01', group: {}, perInvestor: {} }),
    windowMetrics: () => ({ group: side, perInvestor: {} }), currentHoldings: () => [hold], clubTotal: () => CLUB };
  const el = { ...node(), classList: { add() {} }, querySelector: () => node() };
  await w.Views.dashboard(el, { store });
  const html = el.innerHTML;
  assert.match(html, /−43%/, 'gap % with true minus');
  assert.match(html, /12,3%? (below|above)|12,3/, 'headline gap with comma');
  assert.match(html, /−3,5/, 'negative P/E');
  assert.match(html, /0,05/, 'P/B two decimals');
  assertClean(html, 'dashboard');
});

test('Investors detail: share tag, negative unrealized, tiny negative % are clean', async () => {
  const w = env();
  const row = { totalValue: 1, marketValue: 1, realized: 0, unrealized: 0, dividends: 0, portfolioReturnPct: 1 };
  const h = { security: 'Acme', weight: 0.5, qty: 7.45, avgCost: 100, currentPrice: 90.5, marketValue: 674, unrealized: -75.5, unrealizedPct: -0.04, realized: 1234.5 };
  const detail = { summary: { ...row, invested: 1, holdings: [h] }, previous: [{ security: 'Old', weight: 0.25, invested: 5, proceeds: 4, dividends: 0, realized: -1, netResult: -1234, returnPct: -12.3, first: '2023-01-01', last: '2023-06-01' }], recent: [] };
  const then = { mv: 100, total: 100, cash: 100, unrealized: 0 };
  w.Portfolio = { ...w.Portfolio, usePriceMatrix: () => true, buildDashboard: () => ({ perInvestor: { HH: row } }),
    investorValueAt: () => then, groupValueAt: () => then, investorDetail: () => detail, computeWindow: () => WIN,
    windowMetrics: () => ({ perInvestor: { HH: { periodReturnPct: -0.04, netPnlInWindow: -3 } } }),
    clubTotal: () => CLUB, currentHoldings: () => [], cash: { latestSaldo: () => 5 } };
  const el = { ...node(), classList: { add() {} }, querySelector: () => node() };
  await w.Views.investors(el, { store, params: ['HH'], navigate() {} });
  const html = el.innerHTML;
  assert.match(html, /50% share/);
  assert.match(html, /25% share/);
  assert.match(html, /7,45/);
  assert.match(html, /−12,3%/);
  assertClean(html, 'investor detail');
});

test('Portfolio holdings view mounts with a negative return and stays clean', async () => {
  const w = env();
  const h = { security: 'Acme', currency: 'NOK', qty: 3, gav: 10, currentPrice: 9.5, marketValueNok: 28.5, returnNok: -1.5, returnPct: -5.04, priced: true, snapshotDate: '2024-06-01' };
  const then = { mv: 100, total: 100, cash: 100, unrealized: 0 };
  w.Portfolio = { ...w.Portfolio, usePriceMatrix: () => true, buildDashboard: () => ({ perInvestor: {} }),
    investorValueAt: () => then, groupValueAt: () => then, computeWindow: () => WIN,
    windowMetrics: () => ({ group: side, perInvestor: {} }), clubTotal: () => CLUB, currentHoldings: () => [h], cash: { latestSaldo: () => 5 } };
  const pb = node();
  const el = { ...node(), classList: { add() {} }, querySelector: () => pb };
  await w.Views.portfolio(el, { store, params: ['holdings'], navigate() {} });
  assert.match(pb.innerHTML, /−5,0%/);
  assertClean(pb.innerHTML, 'portfolio holdings');
});

test('fundamentalsTable (security drill-down): comma P/E, true minus, null P/B as dash', () => {
  const w = env();
  const html = w.Components ? w.Components.fundamentalsTable(store, 'Acme') : w.UI.fundamentalsTable(store, 'Acme');
  assert.match(html, /−3,5/);
  assert.match(html, /0,05/);
  assertClean(html, 'fundamentals table');
});

test('chart axis: crossing zero and millions use true minus, comma, k/M and English months', () => {
  const texts = [];
  const el = () => ({ style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, appendChild() {}, addEventListener() {},
    set textContent(v) { texts.push(String(v)); } });
  const w = baseWindow({});
  w.document.createElementNS = el;
  w.document.createElement = el;
  vm.createContext(w);
  load(w, 'format.js', 'charts.js');
  const ys = [-1_200_000, -400_000, 300_000, 1_500_000, 2_400_000];
  const pts = ys.map((y, i) => ({ date: `2024-0${i + 1}-15`, y }));
  w.Charts.multiLine({ series: [{ name: 'A', color: '#fff', points: pts }], width: 960, height: 360 });
  const all = texts.join('|');
  assert.match(all, /\u2212\d,\dM/, `axis: ${all}`);
  assert.match(all, /\d,\dM/, `axis: ${all}`);
  assert.match(all, /\d{3}k/, `axis: ${all}`);
  assert.doesNotMatch(all, /(^|\|)-\d/, 'no ASCII minus on any label');
  assert.match(all, /(Jan|Feb|Mar|Apr|May) 24/, `month label: ${all}`);
});

test('chart axis: a first tick on the left edge is start-anchored so its label is not clipped', () => {
  const labels = [];
  const el = () => { const o = { style: {}, attrs: {}, setAttribute(k, v) { o.attrs[k] = v; }, appendChild() {}, addEventListener() {},
    set textContent(v) { o.text = String(v); labels.push(o); } }; return o; };
  const w = baseWindow({});
  w.document.createElementNS = el;
  w.document.createElement = el;
  vm.createContext(w);
  load(w, 'format.js', 'charts.js');
  const pts = ['2025-03-01', '2025-04-10', '2025-05-20'].map((date, i) => ({ date, y: i * 100 }));
  w.Charts.multiLine({ series: [{ name: 'A', color: '#fff', points: pts }], width: 960, height: 360 });
  const first = labels.find((l) => /Mar 25/.test(l.text));
  assert.ok(first, 'first month label drawn');
  assert.equal(first.attrs['text-anchor'], 'start');
  const next = labels.find((l) => /Apr 25/.test(l.text));
  assert.equal(next.attrs['text-anchor'], 'middle');
});

// ── Investors overview: one container width, no empty Change columns ──
function overview({ cutoffDays, firstTradeDaysAgo, matrix = true }) {
  const w = env();
  const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  const perInvestor = {};
  for (const c of w.Ledger.INVESTOR_CODES) perInvestor[c] = { totalValue: 1, marketValue: 100, realized: 0, unrealized: 0, dividends: 0, portfolioReturnPct: 1 };
  w.Portfolio = { ...w.Portfolio, usePriceMatrix: () => matrix, buildDashboard: () => ({ perInvestor, group: {} }),
    investorValueAt: (s, c, from) => ({ mv: from >= day(cutoffDays) ? 100 : 0 }) };
  const added = [];
  const el = { ...node(), classList: { add: (c) => added.push(c) } };
  const st = { ...store, transactions: [{ tradeDate: day(firstTradeDaysAgo) }] };
  return { w, el, added, run: () => w.Views.investors(el, { store: st, params: [], navigate() {} }) };
}

test('Investors overview: Change columns with no data are not rendered, the ones with data stay', async () => {
  const o = overview({ cutoffDays: 40, firstTradeDaysAgo: 20 });
  await o.run();
  for (const h of ['1w', '1m', 'All']) assert.match(o.el.innerHTML, new RegExp(`Change ${h}<`));
  for (const h of ['3m', '6m', '1y', '3y']) assert.doesNotMatch(o.el.innerHTML, new RegExp(`Change ${h}<`));
});

test('Investors overview: with a long history every Change column is shown', async () => {
  const o = overview({ cutoffDays: 99999, firstTradeDaysAgo: 2000 });
  await o.run();
  for (const h of ['1w', '1m', '3m', '6m', 'YTD', '1y', '3y', 'All']) assert.match(o.el.innerHTML, new RegExp(`Change ${h}<`));
});

test('Investors overview: uses the one container width (never adds "wide")', async () => {
  const o = overview({ cutoffDays: 99999, firstTradeDaysAgo: 2000 });
  await o.run();
  assert.ok(!o.added.includes('wide'));
});

test('Investors overview: without a price matrix every Change column is dropped', async () => {
  const o = overview({ cutoffDays: 99999, firstTradeDaysAgo: 2000, matrix: false });
  await o.run();
  assert.doesNotMatch(o.el.innerHTML, /Change \S+</);
});

test('Investors overview: Invested, Total gain/loss and Gain % of invested, ordered by that %', async () => {
  const o = overview({ cutoffDays: 99999, firstTradeDaysAgo: 2000 });
  const pi = o.w.Portfolio.buildDashboard().perInvestor;
  const set = (c, invested, gain) => Object.assign(pi[c], { invested, gainBase: invested, gainBaseKind: 'held', netReturn: gain, gainPct: invested ? (gain / invested) * 100 : 0, portfolioReturnPct: 0 });
  set('HH', 100000, 5000); set('HS', 50000, 10000); set('ØS', 200000, -4000); set('JC', 80000, 8000); set('HF', 0, 0);
  await o.run();
  const html = o.el.innerHTML;
  for (const h of ['Invested (held)', 'Total gain/loss', 'Gain % of invested']) assert.ok(html.includes(`>${h}<`), h);
  const at = (c) => html.indexOf(`data-code="${c}"`);
  assert.ok(at('HS') < at('JC') && at('JC') < at('HH') && at('HH') < at('HF') && at('HF') < at('ØS'), 'HS 20% > JC 10% > HH 5% > HF 0% > ØS -2%');
});
