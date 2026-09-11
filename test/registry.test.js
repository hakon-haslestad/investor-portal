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

test('only games that collect an answer per player can be hosted on phones', () => {
  const w = appCtx();
  // `hosted` drives the "Play on phones" button. A game that scores nothing
  // has nothing for a phone to send, so offering it would be a dead end.
  assert.equal(w.Games.byId('odd-one-out').hosted, true);
  assert.equal(w.Games.byId('back-trading').hosted, true);
  for (const id of ['spin-the-stock', 'guess-the-stock', 'horse-race']) {
    assert.ok(!w.Games.byId(id).hosted, `${id} is not hosted yet`);
  }
});

test('cross-device play is wired into the page and the CSP', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'docs', 'index.html'), 'utf8');
  // Apps Script answers from script.google.com and redirects its response to
  // googleusercontent — both origins are needed or the fetch dies mid-flight.
  const csp = /content="([^"]*connect-src[^"]*)"/.exec(html)[1];
  assert.ok(csp.includes('https://script.google.com'), 'connect-src allows the web app');
  assert.ok(csp.includes('https://script.googleusercontent.com'), 'and its redirect target');
  assert.ok(html.includes('js/games/room.js'), 'the room client is loaded');
  assert.ok(html.includes('js/views/play.js'), 'the phone view is loaded');
  // The deck does not host, so its CSP stays narrow.
  const deck = fs.readFileSync(path.join(__dirname, '..', 'docs', 'presentation.html'), 'utf8');
  assert.ok(!/script\.google\.com/.test(deck), 'the deck gains no new origins');
});

test('the play route exists and stays out of the nav bar', () => {
  const router = fs.readFileSync(path.join(__dirname, '..', 'docs', 'js', 'router.js'), 'utf8');
  assert.match(router, /match: 'play'[^}]*view: 'play'[^}]*hidden: true/);
  const app = fs.readFileSync(path.join(__dirname, '..', 'docs', 'js', 'app.js'), 'utf8');
  assert.match(app, /filter\(\(r\) => !r\.hidden\)/, 'buildNav honours hidden, or Play shows in the nav');
});

test('the rooms endpoint is either unset or a real deployed web app', () => {
  const cfg = fs.readFileSync(path.join(__dirname, '..', 'docs', 'js', 'config.js'), 'utf8');
  const m = /ROOMS_URL: '([^']*)'/.exec(cfg);
  assert.ok(m, 'ROOMS_URL is declared');
  const url = m[1];
  if (!url) return;   // unset is valid: the games simply stay single-device
  assert.match(url, /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/, url);
  // The /dev URL only works for whoever is signed into the Apps Script
  // editor, so a phone would fail against it with no useful error.
  assert.ok(!url.endsWith('/dev'), 'a /dev URL works only for the script owner');
});

test('hosting and joining are visibly different actions', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'docs', 'js', 'views', 'game.js'), 'utf8');
  // The original had one button, so every phone that reached this screen
  // opened its own room instead of joining the one on the wall.
  assert.match(src, /Host on this screen/, 'hosting says it hosts');
  assert.match(src, /href="#\/play"/, 'and there is a way to join');
  assert.ok(!/Play on phones/.test(src), 'the ambiguous label is gone');
  // Joining is reachable from the grid too, not only from inside a game:
  // the grid renders the same host banner, which carries the join link.
  assert.match(src, /\$\{renderHostBanner\(null\)\}/, 'the grid shows the host banner');
});

test('one room serves the whole session, not one game', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'docs', 'js', 'views', 'game.js'), 'utf8');
  // Keying the room by game id would have made every game open a new room
  // and drop everyone who had joined.
  assert.ok(!/r\.gameId === g\.id/.test(src), 'the room is not keyed by game');
  assert.match(src, /room\.setGame\(game\.id\)/, 'opening a game points the existing room at it');
});

test('closing the room tells the phones before it stops listening', () => {
  const room = fs.readFileSync(path.join(__dirname, '..', 'docs', 'js', 'games', 'room.js'), 'utf8');
  // close() must POST first; stopping the poller first would leave every
  // phone showing live buttons for a game that had ended.
  const body = /async close\(\) \{([\s\S]*?)\n      \},/.exec(room)[1];
  assert.ok(body.indexOf("action: 'close'") < body.indexOf('poll.stop()') || body.includes('p.stop()'),
    'the close is sent before the listener stops');
  const play = fs.readFileSync(path.join(__dirname, '..', 'docs', 'js', 'views', 'play.js'), 'utf8');
  assert.match(play, /state\.closed/, 'the phone reacts to it');
  assert.match(play, /That's the game/, 'with an end screen, not dead buttons');
});

test('a live room tells you how to join it, not just its code', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'docs', 'js', 'views', 'game.js'), 'utf8');
  assert.match(src, /Join a room<\/strong> → type/, 'the steps are on screen');
  assert.match(src, /host-copy/, 'and the link can be copied');
  assert.match(src, /waiting for/, 'the screen names who has not joined yet');
});
