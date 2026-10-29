const test = require('node:test');
const assert = require('node:assert');
const { baseWindow, load } = require('./harness');
const vm = require('vm');

// Mounts the real Games view (host side) with the scoreboard present, on a
// fake DOM that understands ids. A render that throws (a helper used before it
// is defined, as in a past production bug) fails here.
const ROSTER = [{ code: 'HH', name: 'Hakon' }, { code: 'JC', name: 'Jonas' }, { code: 'HS', name: 'Hanne' }];
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function fakeEl() {
  const handlers = {};
  const el = {
    innerHTML: '', classList: { add() {}, remove() {} }, handlers,
    querySelector(sel) {
      const id = sel.startsWith('#') ? sel.slice(1) : null;
      if (!id || !el.innerHTML.includes(`id="${id}"`)) return null;
      return {
        disabled: false, innerHTML: '', hidden: false,
        addEventListener(t, fn) { handlers[`${id}:${t}`] = fn; },
        set outerHTML(v) {
          if (id === 'session-board') el.innerHTML = el.innerHTML.replace(/<section[^>]*id="session-board"[\s\S]*?<\/section>/, v);
        },
        remove() { el.innerHTML = el.innerHTML.replace(/<section[^>]*id="session-board"[\s\S]*?<\/section>/, ''); },
      };
    },
    querySelectorAll: () => [],
  };
  return el;
}

function setup({ hosted = true } = {}) {
  const state = { joined: ['HH'], answers: {}, away: [] };
  const room = hosted ? {
    code: 'ABCD', state,
    onChange(cb) { cb(state); return () => {}; },
    setGame() {}, async close() { room.closed = true; hosted && (w._room = null); },
  } : null;
  const w = baseWindow({
    Views: {}, location: { origin: 'https://x.test', pathname: '/' },
    UI: { esc, infoIcon: () => '', emptyState: (t) => `<div>${t}</div>`, table: () => '' },
    CompetitionsData: { listCompetitions: async () => [] },
    GamePool: { measureFor: () => 'window' },
    Games: { registry: [], byId: (id) => (id === 'spin' ? { id, name: 'Spin', rules: '', hosted: true, players: '1', minTrades: 1, component: { mount: () => ({}) } } : null) },
  });
  w._room = room;
  w.GameRoom = { configured: () => true, current: () => w._room, openHost: async () => room };
  vm.createContext(w);
  load(w, 'games/rng.js', 'games/session.js', 'games/shell.js', 'views/game.js');
  // The pool is the one thing the view builds from the store.
  w.GamePool.createContext = () => ({
    computeWindow: () => ({ from: '2024-01-01', to: '2024-12-31' }), buildPool: () => [{}], withPriceData: (a) => ({ kept: a, dropped: [] }), playersFor: () => ROSTER,
  });
  return w;
}

const run = async (w, el, params) => w.Views.games(el, { store: {}, me: 'HH', query: {}, params, navigate() {} });

test('grid view mounts with a scoreboard present: names, shared rank, breakdown', async () => {
  const w = setup();
  w.GameSession.award('a', 'Guess the stock', { HH: 2, JC: 2, HS: 1 });
  w.GameSession.award('b', 'Back trading', { HS: 1 });
  const el = fakeEl();
  await run(w, el, []);
  assert.match(el.innerHTML, /id="session-board"/);
  assert.doesNotMatch(el.innerHTML, /session-board compact/, 'the grid has room for the breakdown');
  const ranks = [...el.innerHTML.matchAll(/session-rank">(\d)</g)].map((m) => m[1]);
  assert.deepEqual(ranks, ['1', '1', '1'], 'HH, JC and HS all have 2 points');
  assert.match(el.innerHTML, /Hanne<\/span>[\s\S]*Guess the stock 1 · Back trading 1/);
});

test('game view mounts with a scoreboard, and a new award repaints it in place', async () => {
  const w = setup();
  w.GameSession.award('a', 'Guess the stock', { HH: 1 });
  const el = fakeEl();
  await run(w, el, ['spin']);
  assert.match(el.innerHTML, /id="session-board"/);
  assert.equal((el.innerHTML.match(/class="session-row /g) || []).length, 1);
  assert.match(el.innerHTML, /session-board compact/, 'one line per player beside a game');
  assert.doesNotMatch(el.innerHTML, /session-parts/);
  w.GameSession.award('a', 'Guess the stock', { JC: 1 });
  assert.equal((el.innerHTML.match(/class="session-row /g) || []).length, 2);
});

test('no room, no board; and a room with nothing scored shows none yet', async () => {
  const w = setup({ hosted: false });
  w.GameSession.award('a', 'A', { HH: 1 });
  const el = fakeEl();
  await run(w, el, []);
  assert.doesNotMatch(el.innerHTML, /session-board/);
  const w2 = setup();
  const el2 = fakeEl();
  await run(w2, el2, []);
  assert.doesNotMatch(el2.innerHTML, /session-board/);
});

test('stopping the host shows the final board once, then clears the session', async () => {
  const w = setup();
  w.GameSession.award('a', 'Guess the stock', { HH: 3, JC: 1 });
  const el = fakeEl();
  await run(w, el, []);
  await el.handlers['host-stop:click']();
  assert.match(el.innerHTML, /Final scores/);
  assert.match(el.innerHTML, /Hakon/);
  assert.ok(w.GameSession.isEmpty(), 'cleared after the final board was built');
});
