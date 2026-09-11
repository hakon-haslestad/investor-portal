const test = require('node:test');
const assert = require('node:assert');
const { context } = require('./harness');

// GameShell needs UI.esc / UI.emptyState; stub them rather than loading the
// whole components module.
function shellCtx() {
  const w = context([], {
    UI: {
      esc: (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
      emptyState: (t, h) => `<div class="empty-state"><strong>${t}</strong><p>${h || ''}</p></div>`,
    },
    GamePool: { measureFor: (p) => (p === 'all' ? 'lifetime' : 'window') },
  });
  require('./harness').load(w, 'games/shell.js');
  return w;
}

test('filtersFromQuery defaults to All time and rejects unknown periods', () => {
  const { GameShell } = shellCtx();
  assert.equal(GameShell.filtersFromQuery({}).period, 'all');
  assert.equal(GameShell.filtersFromQuery({ period: 'nonsense' }).period, 'all');
  assert.equal(GameShell.filtersFromQuery({ period: '1y' }).period, '1y');
  assert.deepEqual(GameShell.filtersFromQuery({ tags: 'party,skill' }).tags, ['party', 'skill']);
  assert.deepEqual(GameShell.filtersFromQuery({}).tags, []);
});

test('hashFor round-trips through filtersFromQuery', () => {
  const { GameShell } = shellCtx();
  const cases = [
    { period: 'all', tags: [], competitionId: '' },
    { period: '1y', tags: ['party'], competitionId: '' },
    { period: 'custom', from: '2024-01-01', to: '2024-06-30', tags: [], competitionId: '' },
    { period: 'all', tags: [], competitionId: 'C7' },
  ];
  for (const f of cases) {
    const hash = GameShell.hashFor('spin-the-stock', { from: '2024-01-01', to: '2024-06-30', ...f });
    const qs = hash.split('?')[1] || '';
    const query = Object.fromEntries(new URLSearchParams(qs));
    const back = GameShell.filtersFromQuery(query);
    assert.equal(back.competitionId, f.competitionId, `comp for ${hash}`);
    if (!f.competitionId) assert.equal(back.period, f.period, `period for ${hash}`);
    assert.deepEqual(back.tags, f.tags, `tags for ${hash}`);
    if (f.period === 'custom' && !f.competitionId) {
      assert.equal(back.from, '2024-01-01');
      assert.equal(back.to, '2024-06-30');
    }
  }
});

test('hashFor targets the grid when no game id is given', () => {
  const { GameShell } = shellCtx();
  const f = GameShell.filtersFromQuery({ period: '1y' });
  assert.equal(GameShell.hashFor(null, f), '#/games?period=1y');
  assert.equal(GameShell.hashFor('odd-one-out', f), '#/games/odd-one-out?period=1y');
});

test('a competition filter suppresses period params, so the two cannot fight', () => {
  const { GameShell } = shellCtx();
  const hash = GameShell.hashFor(null, { period: '1y', tags: [], competitionId: 'C1', from: '', to: '' });
  assert.ok(hash.includes('comp=C1'));
  assert.ok(!hash.includes('period='), `period leaked into ${hash}`);
});

const GAMES = [
  { id: 'a', name: 'Alpha', icon: '🎲', tagline: 'A game', tags: ['party'], players: '1', minTrades: 1, drinkingRule: 'drink up' },
  { id: 'b', name: 'Beta', icon: '🐎', tagline: 'B game', tags: ['skill'], players: '2+', minTrades: 8 },
];

test('grid gates a card when the filtered set is too small', () => {
  const { GameShell } = shellCtx();
  const f = GameShell.filtersFromQuery({});
  const html = GameShell.renderGrid(GAMES, new Array(3).fill({}), f);
  assert.ok(html.includes('href="#/games/a"'), 'playable game links to itself');
  assert.ok(html.includes('Needs at least 8 trades'), 'gated game explains why');
  assert.ok(!html.includes('href="#/games/b"'), 'gated game has no Play link');
  assert.ok(html.includes('game-card disabled'), 'gated card is marked disabled');
});

test('grid filters by tag chips, and no chips means show all', () => {
  const { GameShell } = shellCtx();
  const all = GameShell.renderGrid(GAMES, new Array(99).fill({}), GameShell.filtersFromQuery({}));
  assert.ok(all.includes('Alpha') && all.includes('Beta'));
  const party = GameShell.renderGrid(GAMES, new Array(99).fill({}), GameShell.filtersFromQuery({ tags: 'party' }));
  assert.ok(party.includes('Alpha') && !party.includes('Beta'));
  const none = GameShell.renderGrid(GAMES, new Array(99).fill({}), GameShell.filtersFromQuery({ tags: 'recurring' }));
  assert.ok(none.includes('No games match those tags'));
});

test('sober mode hides drinking rules on the cards', () => {
  const w = shellCtx();
  const f = w.GameShell.filtersFromQuery({});
  assert.ok(w.GameShell.renderGrid(GAMES, [{}], f).includes('drink up'));
  w.GameShell.setSoberMode(true);
  assert.ok(!w.GameShell.renderGrid(GAMES, [{}], f).includes('drink up'));
});

test('history is scoped per competition and per game, newest first', () => {
  const { GameShell } = shellCtx();
  const h = GameShell.history;
  h.add({ gameId: 'a', competitionId: 'C1', players: [], summary: 'one', payload: {} });
  h.add({ gameId: 'a', competitionId: 'C1', players: [], summary: 'two', payload: {} });
  h.add({ gameId: 'b', competitionId: 'C1', players: [], summary: 'other game', payload: {} });
  h.add({ gameId: 'a', competitionId: 'C2', players: [], summary: 'other comp', payload: {} });

  const a1 = h.list('C1', 'a');
  assert.equal(a1.length, 2);
  assert.equal(a1[0].summary, 'two', 'newest first');
  assert.equal(h.list('C1', 'b').length, 1);
  assert.equal(h.list('C2', 'a').length, 1);
  assert.equal(h.list('C9', 'a').length, 0);
  assert.ok(a1[0].id && a1[0].playedAt, 'entries get an id and a timestamp');
});

test('history survives unparseable storage instead of throwing', () => {
  const w = shellCtx();
  w.localStorage.setItem('portal.games.history.C1', 'not json');
  assert.deepEqual(w.GameShell.history.list('C1', 'a'), []);
  w.GameShell.history.add({ gameId: 'a', competitionId: 'C1', players: [], summary: 'ok', payload: {} });
  assert.equal(w.GameShell.history.list('C1', 'a').length, 1);
});

test('renderRecent lists newest rounds and is empty when there are none', () => {
  const { GameShell } = shellCtx();
  assert.equal(GameShell.renderRecent('C1', 'horse-race'), '', 'nothing yet renders as nothing');
  GameShell.history.add({ gameId: 'horse-race', competitionId: 'C1', players: ['HH'], summary: 'HH won', payload: {} });
  GameShell.history.add({ gameId: 'horse-race', competitionId: 'C1', players: ['JC'], summary: 'JC won', payload: {} });
  const html = GameShell.renderRecent('C1', 'horse-race');
  assert.ok(html.includes('JC won'));
  assert.ok(html.indexOf('JC won') < html.indexOf('HH won'), 'newest first');
  assert.equal(GameShell.renderRecent('C1', 'odd-one-out'), '', 'scoped to the game');
});

test('renderRecent caps at the requested limit', () => {
  const { GameShell } = shellCtx();
  for (let i = 0; i < 12; i++) {
    GameShell.history.add({ gameId: 'g', competitionId: 'C', players: [], summary: `round ${i}`, payload: {} });
  }
  const html = GameShell.renderRecent('C', 'g', 5);
  assert.equal((html.match(/<li>/g) || []).length, 5);
  assert.ok(html.includes('round 11'), 'the newest is included');
  assert.ok(!html.includes('round 6'), 'older ones are not');
});

test('history escapes summaries, since they carry security names', () => {
  const { GameShell } = shellCtx();
  GameShell.history.add({ gameId: 'g', competitionId: 'C', players: [], summary: '<img src=x onerror=1>', payload: {} });
  const html = GameShell.renderRecent('C', 'g');
  assert.ok(!html.includes('<img'), 'markup in a summary is escaped');
  assert.ok(html.includes('&lt;img'));
});

// ── Who is playing ─────────────────────────────────────────────────────────
const ROSTER = [
  { code: 'HH', name: 'Hakon' }, { code: 'JC', name: 'Jonas' }, { code: 'ØS', name: 'Øystein' },
];

test('no selection means everyone is playing', () => {
  const { GameShell } = shellCtx();
  const f = GameShell.filtersFromQuery({});
  assert.deepEqual(f.players, []);
  assert.deepEqual(GameShell.activePlayers(ROSTER, f).map((p) => p.code), ['HH', 'JC', 'ØS']);
});

test('a selection narrows the room, and survives the URL', () => {
  const { GameShell } = shellCtx();
  const f = GameShell.filtersFromQuery({ players: 'HH,ØS' });
  assert.deepEqual(GameShell.activePlayers(ROSTER, f).map((p) => p.code), ['HH', 'ØS']);
  const hash = GameShell.hashFor('odd-one-out', f);
  assert.ok(hash.includes('players=HH'), hash);
  const back = GameShell.filtersFromQuery(Object.fromEntries(new URLSearchParams(hash.split('?')[1])));
  assert.deepEqual(GameShell.activePlayers(ROSTER, back).map((p) => p.code), ['HH', 'ØS']);
});

test('picking one player is how you play alone', () => {
  const { GameShell } = shellCtx();
  const solo = GameShell.activePlayers(ROSTER, GameShell.filtersFromQuery({ players: 'JC' }));
  assert.equal(solo.length, 1);
  assert.equal(solo[0].name, 'Jonas');
});

test('a stale link naming nobody on the roster falls back to everyone', () => {
  const { GameShell } = shellCtx();
  // A competition changed, or a member left: better the whole room than none.
  const f = GameShell.filtersFromQuery({ players: 'ZZ,QQ' });
  assert.deepEqual(GameShell.activePlayers(ROSTER, f).map((p) => p.code), ['HH', 'JC', 'ØS']);
  assert.equal(GameShell.activePlayers(ROSTER, GameShell.filtersFromQuery({})).length, 3);
});

test('the picker is hidden when there is nobody to choose between', () => {
  const { GameShell } = shellCtx();
  const f = GameShell.filtersFromQuery({});
  assert.ok(!GameShell.renderFilterBar(f, [], [{ code: 'HH', name: 'Hakon' }]).includes('player-pills'),
    'one member is not a choice');
  assert.ok(GameShell.renderFilterBar(f, [], ROSTER).includes('player-pills'));
});

test('a two-player game is gated when only one person is playing', () => {
  const { GameShell } = shellCtx();
  const games = [
    { id: 'solo', name: 'Solo', icon: '🎲', tagline: 't', tags: ['party'], players: '1', minTrades: 1 },
    { id: 'duo', name: 'Duo', icon: '🏇', tagline: 't', tags: ['party'], players: '2+', minTrades: 1 },
  ];
  const f = GameShell.filtersFromQuery({});
  const alone = GameShell.renderGrid(games, [{}, {}], f, 1);
  assert.ok(alone.includes('href="#/games/solo"'), 'the solo game is still playable');
  assert.ok(!alone.includes('href="#/games/duo"'), 'the two-player game is not');
  assert.match(alone, /Needs 2 players — 1 selected/);

  const together = GameShell.renderGrid(games, [{}, {}], f, 3);
  assert.ok(together.includes('href="#/games/duo"'), 'and is playable with a room');
});

test('the trade gate still applies independently of the player gate', () => {
  const { GameShell } = shellCtx();
  const games = [{ id: 'x', name: 'X', icon: '🎲', tagline: 't', tags: ['party'], players: '1', minTrades: 9 }];
  const html = GameShell.renderGrid(games, [{}], GameShell.filtersFromQuery({}), 5);
  assert.match(html, /Needs at least 9 trades/);
});
