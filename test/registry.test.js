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

// ── Load order across BOTH entry points ────────────────────────────────────
const DECK = path.join(__dirname, '..', 'docs', 'presentation.html');

function decksScripts() {
  const html = fs.readFileSync(DECK, 'utf8');
  return [...html.matchAll(/src="\.\/(js\/[a-z0-9/-]+\.js)/g)].map((m) => m[1]);
}

test('horse-race.js loads after the view it delegates the race to', () => {
  const order = scriptOrder();
  const view = order.indexOf('games/horse-race-view.js');
  const game = order.indexOf('games/horse-race.js');
  assert.ok(view >= 0, 'index.html loads the view');
  assert.ok(view < game, 'the view must be defined before the game that uses it');
});

test('the deck loads the race modules, and in a workable order', () => {
  const order = decksScripts();
  for (const f of ['js/games/horse-race-engine.js', 'js/games/horse-race-view.js', 'js/games/horse-race-audio.js']) {
    assert.ok(order.includes(f), `presentation.html loads ${f}`);
  }
  assert.ok(order.indexOf('js/games/horse-race-engine.js') < order.indexOf('js/games/horse-race-view.js'),
    'the view needs the engine');
  assert.ok(order.indexOf('js/games/horse-race-view.js') < order.indexOf('js/pages/presentation-page.js'),
    'the page needs the view');
});

test('the deck does NOT drag in the games shell', () => {
  const order = decksScripts();
  for (const f of ['js/games/registry.js', 'js/games/shell.js', 'js/games/pool.js', 'js/games/horse-race.js']) {
    assert.ok(!order.includes(f), `${f} has no business on the deck`);
  }
});

test('the race modules reference no games-shell globals', () => {
  for (const f of ['horse-race-engine.js', 'horse-race-view.js', 'horse-race-audio.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'docs', 'js', 'games', f), 'utf8');
    for (const g of ['GamePool', 'GameShell', 'GameRng', 'window.Games']) {
      assert.ok(!src.includes(g), `${f} must not depend on ${g} — the deck does not load it`);
    }
  }
});

test('every file in docs/js/games is loaded by index.html', () => {
  const order = scriptOrder();
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'docs', 'js', 'games'))) {
    assert.ok(order.includes('games/' + f), `${f} is not loaded by index.html`);
  }
});

test('every game declares a player requirement it can actually honour', () => {
  const w = appCtx();
  // `players` is enforced now — the grid disables a game below it and the
  // shell refuses to mount one — so it must mean "cannot be played with
  // fewer", not "is more fun with more".
  for (const g of w.Games.registry) {
    assert.ok(['1', '2+', '3+'].includes(g.players), `${g.id}: ${g.players}`);
  }
  // Horse Race genuinely needs runners to race against each other.
  assert.equal(w.Games.byId('horse-race').players, '2+');
  // Everything else is playable on your own.
  for (const id of ['spin-the-stock', 'guess-the-stock', 'odd-one-out', 'back-trading']) {
    assert.equal(w.Games.byId(id).players, '1', `${id} should be playable alone`);
  }
});
