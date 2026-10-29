const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const { baseWindow, load } = require('./harness');

// Mounts the real Admin view (all three sub-tabs) on synthetic data, with the
// real UI components, so a load-order or render error fails here.
const sec = { ticker: 'AAA', name: 'Alpha Test', aliases: [], isin: 'XX0000000001', currency: 'NOK', exchange: 'OSE', source: 'yahoo', status: 'held', soldDate: '', notes: '', lastChecked: '2026-01-01' };
const store = {
  transactions: [{ security: 'Alpha Test', type: 'KJØPT', qty: 1, amount: -100, bookDate: '2026-01-02', currency: 'NOK' }],
  securities: [sec],
  prices: { hasData: true, latestDate: '2026-01-05', dates: ['2026-01-05'], series: new Map([['AAA', [{ d: '2026-01-05', v: 1 }]]]) },
};

function mount(sub, { logRows, logFails } = {}) {
  const kids = {};
  const node = (id) => (kids[id] = kids[id] || { id, innerHTML: '', textContent: '', style: {}, dataset: {}, disabled: false, listeners: {}, addEventListener(t, f) { this.listeners[t] = f; }, querySelector: () => node('inner') });
  const w = baseWindow({
    Views: {},
    PORTAL_CONFIG: { SHEET_ID: 'synthetic', TABS: { priceLog: '_log' } },
    Auth: { getEmail: () => 'a@example.test', hasWriteScope: () => false, requestWriteAccess() {} },
    Sheet: { getValues: async () => { if (logFails) throw new Error('no tab'); return logRows || [['t', 'c', 'k', 'm']]; } },
    DimValues: { readIndex: async () => ({ map: new Map() }), upsert: async () => {} },
    Store: { refresh: async () => store },
  });
  vm.createContext(w);
  load(w, 'format.js', 'metrics-info.js', 'ledger.js', 'components.js', 'views/admin.js');
  w.Positions = { holdingsAt: () => [] };
  w.Portfolio = { canonicalName: (s) => s };
  const el = { innerHTML: '', querySelector: (s) => node(s), querySelectorAll: () => [], addEventListener() {} };
  return { w, el, kids, run: () => w.Views.admin(el, { store, me: { role: 'admin' }, params: sub ? [sub] : [] }) };
}
const settle = () => new Promise((r) => setTimeout(r, 5));

test('securities tab mounts with a security present', async () => {
  const m = mount('securities'); await m.run();
  assert.match(m.el.innerHTML, /Alpha Test/);
  assert.match(m.el.innerHTML, /1 securities/);
});

test('price feed tab mounts, shows a skeleton while the log loads, then the log', async () => {
  const m = mount('feed', { logRows: [['h'], ['2026-01-01', 'ctx', 'AAA', 'stale']] });
  await m.run();
  assert.match(m.el.innerHTML, /Latest price date/);
  assert.match(m.el.innerHTML, /id="feed-log"><div class="skeleton-wrap"/);
  assert.doesNotMatch(m.el.innerHTML, /Loading log…/);
  await settle();
  assert.match(m.kids['#feed-log'].innerHTML, /stale/);
});

test('price feed tab without a _log tab says so instead of staying busy', async () => {
  const m = mount('feed', { logFails: true }); await m.run(); await settle();
  assert.match(m.kids['#feed-log'].innerHTML, /No _log tab/);
});

test('ownership tab mounts: skeleton in the panel first; without write access it shows the gate', async () => {
  const m = mount(null); await m.run();
  assert.match(m.el.innerHTML, /id="admin-root"><div class="skeleton-wrap"/);
  assert.match(m.kids['#admin-root'].innerHTML, /Editing needs write access/);
});
