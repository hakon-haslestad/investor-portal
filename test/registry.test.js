const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { baseWindow, load } = require('./harness');
const vm = require('vm');

// Load every games/* module in the order index.html does, so registration
// order problems show up here rather than in the browser.
function scriptOrder() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'docs', 'index.html'), 'utf8');
  return [...html.matchAll(/src="\.\/js\/(games\/[a-z-]+\.js)/g)].map((m) => m[1]);
}

function appCtx() {
  const w = baseWindow({
    Fmt: {
      fmtNok: (n) => String(n), fmtPct: (n) => String(n), fmtQty: (n) => String(n),
      escapeHtml: (s) => String(s), pctClass: () => '',
    },
    UI: { esc: (s) => String(s), emptyState: () => '', table: () => '', section: () => '', infoIcon: () => '' },
    Copy: { namesFromMembers: () => ({}) },
    Ledger: { INVESTOR_CODES: ['HH'], classify: () => 'BUY', splitForSecurity: () => [], isRealizingSell: () => false },
    Portfolio: { canonicalName: (s) => s, buildDashboard: () => ({ perInvestor: {} }), previousHoldings: () => [], usePriceMatrix: () => false },
    Positions: { bySecurity: () => new Map(), stateAt: () => null },
    CompetitionEngine: { scoreCompetition: () => ({ ranks: [] }) },
    TimeSeries: { buildSecurityPriceSeries: () => [] },
    Charts: { priceChart: () => ({}) },
  });
  vm.createContext(w);
  load(w, ...scriptOrder());
  return w;
}

test('index.html loads every games module, and in a workable order', () => {
  const order = scriptOrder();
  // The registry references each game's component at load, so it must be last.
  assert.equal(order[order.length - 1], 'games/registry.js',
    'registry.js must load after the games it registers');
  const dir = fs.readdirSync(path.join(__dirname, '..', 'docs', 'js', 'games'));
  for (const f of dir) {
    assert.ok(order.includes('games/' + f), `${f} is not loaded by index.html`);
  }
});

test('every registered game satisfies the GameDefinition contract', () => {
  const w = appCtx();
  const reg = w.Games.registry;
  assert.ok(reg.length >= 5, `expected the full catalogue, got ${reg.length}`);
  const ids = new Set();
  for (const g of reg) {
    assert.match(g.id, /^[a-z0-9-]+$/, `${g.id} is kebab-case`);
    assert.ok(!ids.has(g.id), `${g.id} is registered twice`);
    ids.add(g.id);
    assert.ok(g.name && g.tagline && g.rules, `${g.id} has name, tagline and rules`);
    assert.ok(Array.isArray(g.tags) && g.tags.length, `${g.id} has tags`);
    for (const t of g.tags) {
      assert.ok(['party', 'skill', 'recurring'].includes(t), `${g.id} tag "${t}" is a known tag`);
    }
    assert.ok(['1', '2+', '3+'].includes(g.players), `${g.id} players "${g.players}" is valid`);
    assert.ok(Number.isInteger(g.minTrades) && g.minTrades >= 0, `${g.id} minTrades`);
    assert.ok(g.component && typeof g.component.mount === 'function', `${g.id} has a mountable component`);
  }
});

test('the three new games are registered alongside the two originals', () => {
  const w = appCtx();
  for (const id of ['spin-the-stock', 'guess-the-stock', 'odd-one-out', 'back-trading', 'horse-race']) {
    assert.ok(w.Games.byId(id), `${id} is registered`);
  }
  assert.equal(w.Games.byId('nope'), null);
});

test('Games.register replaces rather than duplicates an existing id', () => {
  const w = appCtx();
  const before = w.Games.registry.length;
  w.Games.register({ id: 'horse-race', name: 'Replaced', component: { mount() {} }, tags: ['party'], players: '2+', minTrades: 2, tagline: 't', rules: 'r' });
  assert.equal(w.Games.registry.length, before, 'no duplicate');
  assert.equal(w.Games.byId('horse-race').name, 'Replaced');
});
