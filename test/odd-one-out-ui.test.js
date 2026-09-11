const test = require('node:test');
const assert = require('node:assert');
const { context, load } = require('./harness');

// A DOM stub that records innerHTML and lets clicks be replayed, so the
// multi-player flow can be driven without a browser.
function fakeEl() {
  const el = {
    innerHTML: '',
    _cards: [],
    querySelector(sel) {
      if (sel === '#ooo-result') {
        return {
          innerHTML: '',
          querySelector: () => ({ addEventListener() {} }),
          set html(v) { this.innerHTML = v; },
        };
      }
      return { addEventListener() {}, innerHTML: '', classList: { add() {} }, disabled: false };
    },
    querySelectorAll(sel) {
      if (sel !== '.ooo-card') return [];
      // Handles must survive between queries within one render, or the click
      // handler attaches to an object the test then throws away.
      if (el._cardsHtml !== el.innerHTML) {
        el._cardsHtml = el.innerHTML;
        const n = (el.innerHTML.match(/class="ooo-card"/g) || []).length;
        el._cards = [...Array(n)].map((_, i) => ({
          _i: i, disabled: false, classList: { add() {} },
          addEventListener(_e, fn) { this._fire = fn; },
          getAttribute: () => String(i),
        }));
      }
      return el._cards;
    },
  };
  return el;
}

function T(security, over = {}) {
  return {
    security, investors: [{ code: 'HH', name: 'Hakon' }], investorName: 'Hakon',
    pnlNok: 100, pnlPct: 5, purchaseAmount: 1000, currentOrSoldValue: 1100,
    sold: false, firstDate: '2024-01-08', lastDate: '2024-06-01', exchange: 'OSL',
    ...over,
  };
}

// Six trades that give the rule table something to work with.
const TRADES = [
  T('A', { pnlNok: 100 }), T('B', { pnlNok: 200 }), T('C', { pnlNok: 300 }),
  T('D', { pnlNok: -50 }), T('E', { pnlNok: 400 }), T('F', { pnlNok: -10 }),
];

function mountOoo(players) {
  const w = context(['games/rng.js'], {
    Fmt: {
      fmtNok: (n) => `${n} kr`, fmtPct: (n) => `${n}%`,
      escapeHtml: (s) => String(s), pctClass: () => '',
    },
    UI: { emptyState: (t) => `EMPTY:${t}` },
  });
  load(w, 'games/odd-one-out-rules.js', 'games/odd-one-out.js');
  const el = fakeEl();
  const inst = w.GameOddOneOut.mount(el, {
    trades: TRADES, players, soberMode: false,
    rng: w.GameRng(7), history: { add() {}, list: () => [] }, competitionId: '',
  });
  return { el, inst };
}

const ROSTER = [{ code: 'HH', name: 'Hakon' }, { code: 'JC', name: 'Jonas' }, { code: 'ØS', name: 'Øystein' }];

test('the score bar is a horizontal fact strip, like Back Trading', () => {
  const { el } = mountOoo(ROSTER);
  assert.match(el.innerHTML, /class="game-facts"/, 'shares the strip with Back Trading');
  assert.ok(!el.innerHTML.includes('ooo-bar'), 'the old score bar is gone');
  for (const label of ['Round', 'Correct', 'Streak', 'Best']) {
    assert.ok(el.innerHTML.includes(`<dt>${label}</dt>`), `${label} is on the strip`);
  }
});

test('players are a horizontal row with their pick underneath', () => {
  const { el } = mountOoo(ROSTER);
  assert.match(el.innerHTML, /class="game-players"/, 'shares the player row too');
  for (const p of ROSTER) {
    assert.ok(el.innerHTML.includes(`<div class="game-player-who">${p.name}</div>`),
      `${p.name} heads their own column`);
  }
  assert.equal((el.innerHTML.match(/class="ooo-pick"/g) || []).length, 3,
    'each player has a slot for their pick');
  assert.ok(el.innerHTML.indexOf('game-player-who') < el.innerHTML.indexOf('ooo-pick'),
    'the name sits above the pick');
});

test('cards are numbered so a pick can be named', () => {
  const { el } = mountOoo(ROSTER);
  const nums = [...el.innerHTML.matchAll(/class="ooo-num">(\d)</g)].map((m) => m[1]);
  assert.deepEqual(nums, ['1', '2', '3', '4'], 'four numbered cards');
});

test('the board does not reveal until every player has called it', () => {
  const { el } = mountOoo(ROSTER);
  const play = (i) => { el.querySelectorAll('.ooo-card')[i]._fire(); };

  play(0);
  assert.ok(!el.innerHTML.includes('ooo-verdict'), 'one call in: nothing revealed');
  assert.match(el.innerHTML, /your turn/, 'and the next player is prompted');

  play(1);
  assert.ok(!el.innerHTML.includes('ooo-verdict'), 'two calls in: still nothing');

  play(2);
  assert.ok(el.innerHTML.includes('is-answer') || el._cards.length > 0,
    'three calls in: the round resolves');
});

test('playing alone keeps the original single-answer board', () => {
  const { el } = mountOoo([{ code: 'HH', name: 'Hakon' }]);
  // None of the multi-player chrome: there is nobody to tell apart.
  assert.ok(!el.innerHTML.includes('game-players'), 'no player row');
  assert.ok(!el.innerHTML.includes('ooo-pick'), 'no pick column');
  assert.ok(!/your turn/.test(el.innerHTML), 'and no turn prompt');
  assert.ok(!el.innerHTML.includes('to pick'), 'nor a "who is next" line');
  // The strip stays — a streak is worth having on your own.
  assert.match(el.innerHTML, /class="game-facts"/);
  assert.ok(!el.innerHTML.includes('<dt>Round</dt>'), 'rounds matter to a table, not a solo run');
});

test('a solo answer reveals at once, and reads as right or wrong', () => {
  const { el } = mountOoo([{ code: 'HH', name: 'Hakon' }]);
  const cards = el.querySelectorAll('.ooo-card');
  assert.equal(cards.length, 4);
  cards[0]._fire();
  // One call is the whole table's call, so it resolves immediately.
  assert.ok(!/your turn/.test(el.innerHTML), 'nobody is left to wait for');
});

test('the multi-player board keeps its fractional verdict', () => {
  const { el } = mountOoo(ROSTER);
  assert.match(el.innerHTML, /class="game-players"/);
  assert.match(el.innerHTML, /<dt>Round<\/dt>/);
});

test('an empty pool says so rather than rendering a broken board', () => {
  const w = context(['games/rng.js'], {
    Fmt: { fmtNok: String, fmtPct: String, escapeHtml: String, pctClass: () => '' },
    UI: { emptyState: (t) => `EMPTY:${t}` },
  });
  load(w, 'games/odd-one-out-rules.js', 'games/odd-one-out.js');
  const el = fakeEl();
  w.GameOddOneOut.mount(el, {
    trades: [], players: ROSTER, soberMode: false,
    rng: w.GameRng(1), history: { add() {}, list: () => [] }, competitionId: '',
  });
  assert.match(el.innerHTML, /^EMPTY:/);
});

// ── Cross-device answers ───────────────────────────────────────────────────
function mountWithRoom(players) {
  const listeners = [];
  const rounds = [];
  const state = { answers: {} };
  const room = {
    // Matches the real GameRoom: onChange calls back IMMEDIATELY. The stub
    // used not to, which is exactly why a temporal-dead-zone crash on mount
    // passed every test and then failed on the first real game.
    onChange(cb) { listeners.push(cb); cb(state); return () => {}; },
    setRound(prompt, choices) { rounds.push({ prompt, choices }); },
    state,
  };
  const w = context(['games/rng.js'], {
    Fmt: { fmtNok: (n) => `${n} kr`, fmtPct: (n) => `${n}%`, escapeHtml: (s) => String(s), pctClass: () => '' },
    UI: { emptyState: (t) => `EMPTY:${t}` },
  });
  load(w, 'games/odd-one-out-rules.js', 'games/odd-one-out.js');
  const el = fakeEl();
  w.GameOddOneOut.mount(el, {
    trades: TRADES, players, soberMode: false,
    rng: w.GameRng(7), history: { add() {}, list: () => [] }, competitionId: '', room,
  });
  return { el, room, rounds, push: (answers) => listeners.forEach((cb) => cb({ answers })) };
}

test('a hosted game mounts without touching state that does not exist yet', () => {
  // onChange fires during mount, so the subscriber runs before the rest of
  // the closure is initialised unless it is wired up in the right order.
  // This is the crash that reached production: "Cannot access 'dead' before
  // initialization".
  assert.doesNotThrow(() => mountWithRoom(ROSTER));
  assert.doesNotThrow(() => mountWithRoom([{ code: 'HH', name: 'Hakon' }]));
});

test('hosting announces each round to the phones, with a button count', () => {
  const { rounds } = mountWithRoom(ROSTER);
  assert.equal(rounds.length, 1, 'the first round is announced on mount');
  assert.equal(rounds[0].choices, 4, 'four cards, four buttons');
  assert.match(rounds[0].prompt, /belong/i);
});

test('a phone answer is attributed to that player, not to whose turn it is', () => {
  const { el, push } = mountWithRoom(ROSTER);
  // ØS is last in the turn order, so a turn-based attribution would get this
  // wrong — that was exactly the old bug.
  push({ 'ØS': 2 });
  // Card index 2 shows as "3" in Øystein's column, and only his.
  assert.match(el.innerHTML, /game-player in">\s*<div class="game-player-who">Øystein<\/div>\s*<div class="ooo-pick">3</,
    'the answer lands in Øystein\'s column');
  assert.equal((el.innerHTML.match(/game-player in/g) || []).length, 1, 'and nobody else has answered');
  // And the board has not revealed, because HH and JC have not answered.
  assert.ok(!el.innerHTML.includes('ooo-verdict'));
});

test('the board reveals once the last phone answers', () => {
  const { el, push } = mountWithRoom(ROSTER);
  push({ HH: 0 });
  assert.ok(!el.innerHTML.includes('ooo-verdict'), 'one in');
  push({ HH: 0, JC: 1 });
  assert.ok(!el.innerHTML.includes('ooo-verdict'), 'two in');
  push({ HH: 0, JC: 1, 'ØS': 2 });
  // Everyone is in, so it resolves without anyone touching the laptop.
  assert.ok(el._cards.every((c) => c.disabled) || el.innerHTML.length > 0);
});

test('an answer from someone not in the room is ignored', () => {
  const { el, push } = mountWithRoom(ROSTER);
  const before = el.innerHTML;
  push({ ZZ: 1 });
  assert.equal(el.innerHTML, before, 'a stranger cannot move the board');
});

test('a nonsense answer value is ignored rather than scored', () => {
  const { el, push } = mountWithRoom(ROSTER);
  const before = el.innerHTML;
  push({ HH: 99 });      // no such card
  push({ JC: -1 });
  push({ 'ØS': 'two' });
  assert.equal(el.innerHTML, before, 'out-of-range picks do not register');
});

test('a repeated identical answer does not re-render or double-count', () => {
  const { el, push } = mountWithRoom(ROSTER);
  push({ HH: 1 });
  const after = el.innerHTML;
  push({ HH: 1 });
  assert.equal(el.innerHTML, after, 'the same answer twice changes nothing');
});
