const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const { baseWindow, load } = require('./harness');

// Dashboard, Portfolio, Investors and Admin mounted on the real portfolio
// code with a synthetic book that has an `Alle` name, a no-owner name, a
// stale ticker and a foreign row with no FX rate. Nothing is stubbed except
// the browser, charts and the sheet.
const node = () => ({ innerHTML: '', style: {}, dataset: {}, value: '', classList: { add() {}, remove() {} }, addEventListener() {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [] });

function env() {
  const w = baseWindow({
    Sheet: { spreadsheetTitle: async () => 'Club', getValues: async () => [] }, Charts: {},
    TimeSeries: { buildPortfolioValueSeries: () => [] }, PORTAL_CONFIG: { TABS: { priceLog: '_log' } },
  });
  w.document.getElementById = () => node();
  vm.createContext(w);
  load(w, 'format.js', 'copy.js', 'parsers.js', 'ledger.js', 'prices.js', 'securities.js', 'positions.js', 'portfolio.js', 'returns.js', 'components.js',
    'views/dashboard.js', 'views/investors.js', 'views/portfolio.js', 'views/admin.js');
  return w;
}

function book(w) {
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const sec = (name, ticker, currency = 'NOK') => ({ name, ticker, isin: null, aliases: [], currency, status: 'held' });
  const registry = w.Securities.buildRegistry([sec('Owned', 'OWN'), sec('Everyone', 'ALL'), sec('Orphan', 'ORP'), sec('Dormant', 'DOR', 'USD')]);
  w.Portfolio._setRegistry(registry);
  const rows = [['date', 'OWN', 'ALL', 'ORP', 'DOR', 'CUR:USDNOK']];
  for (let n = 40; n >= 0; n--) rows.push([day(n), 10, 10, 10, n > 25 ? 10 : '', 10]); // DOR stops 26 days ago
  const buy = (security, extra = {}) => ({ security, type: 'KJØPT', tradeDate: day(30), bookDate: day(30), qty: 10, amount: -100, currency: 'NOK', ...extra });
  return {
    registry, prices: w.Prices.build(rows), members: [], kpis: [],
    attributionMap: new Map([['Owned', [{ code: 'HH', weight: 1 }]], ['Everyone', [{ code: 'Alle', weight: 1 }]], ['Dormant', [{ code: 'HS', weight: 1 }]]]),
    transactions: [
      { type: 'INNSKUDD', tradeDate: day(35), bookDate: day(35), amount: 5000, currency: 'NOK', saldo: 5000 },
      buy('Owned'), buy('Everyone'), buy('Orphan'),
      buy('Dormant', { currency: 'USD', amount: -10, fxRate: null }),
    ],
  };
}

test('Dashboard shows the club total split, the stale chip and the FX flag', async () => {
  const w = env(); const store = book(w);
  const el = { ...node(), querySelector: () => node() };
  await w.Views.dashboard(el, { store });
  assert.match(el.innerHTML, /Club total/);
  assert.match(el.innerHTML, /unattributed/);
  assert.match(el.innerHTML, /price 26 days old/);
  assert.match(el.innerHTML, /1 foreign row without FX rate/);
  assert.match(el.innerHTML, /FX per /);
});

test('Portfolio holdings: same club total, per-row stale chip only on the stale ticker', async () => {
  const w = env(); const store = book(w);
  const pb = node();
  await w.Views.portfolio({ ...node(), querySelector: () => pb }, { store, params: ['holdings'], navigate() {} });
  assert.match(pb.innerHTML, /Club total/);
  assert.strictEqual((pb.innerHTML.match(/days old/g) || []).length, 1);
});

test('Investors overview shows the price date, not "as of today", and the club total', async () => {
  const w = env(); const store = book(w);
  const el = { ...node(), querySelector: () => node() };
  await w.Views.investors(el, { store, params: [], navigate() {} });
  assert.doesNotMatch(el.innerHTML, /as of today/);
  assert.match(el.innerHTML, new RegExp('prices per ' + store.prices.latestDate));
  assert.match(el.innerHTML, /Club total/);
});

test('Admin price-feed tab lists the foreign row with no FX rate', async () => {
  const w = env(); const store = book(w);
  const el = { ...node(), querySelector: () => node() };
  await w.Views.admin(el, { store, params: ['feed'], me: {} });
  assert.match(el.innerHTML, /1 foreign row without FX rate/);
  assert.match(el.innerHTML, /Dormant/);
});

test('Admin FX list stops at 50 rows and says how many more there are', async () => {
  const w = env(); const store = book(w);
  for (let i = 0; i < 59; i++) store.transactions.push({ security: 'Dormant', type: 'KJØPT', tradeDate: '2026-01-01', qty: 1, amount: -1, currency: 'USD', fxRate: null });
  const el = { ...node(), querySelector: () => node() };
  await w.Views.admin(el, { store, params: ['feed'], me: {} });
  assert.match(el.innerHTML, /60 foreign rows without FX rate/);
  assert.match(el.innerHTML, /\+10 more not shown/);
});

test('priceFreshness with an empty price store does not throw', () => {
  const w = env(); const store = book(w);
  store.prices = w.Prices.build([]);
  assert.doesNotThrow(() => w.UI.priceFreshness(store, '2026-10-28'));
});

// The headline metric is profit over everything bought (it understates when
// the club sells and rebuys), so every place that shows it says that.
test('Investor detail keeps "Profit / total bought"; per-security columns say "Profit / cost"; never a bare "Return %"', async () => {
  const w = env(); const store = book(w);
  const detail = { ...node(), querySelector: () => node() };
  await w.Views.investors(detail, { store, params: ['HH'], navigate() {} });
  assert.match(detail.innerHTML, /Profit \/ total bought/);
  assert.doesNotMatch(detail.innerHTML, />Return %</);
  const pb = node();
  await w.Views.portfolio({ ...node(), querySelector: () => pb }, { store, params: ['holdings'], navigate() {} });
  assert.match(pb.innerHTML, />Profit \/ cost</);
  assert.doesNotMatch(pb.innerHTML, />Return %</);
});
