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

test('a solo player still gets a column and an immediate reveal', () => {
  const { el } = mountOoo([{ code: 'HH', name: 'Hakon' }]);
  assert.equal((el.innerHTML.match(/class="ooo-pick"/g) || []).length, 1);
  el.querySelectorAll('.ooo-card')[0]._fire();
  // One player means one call is everyone's call.
  assert.ok(!/your turn/.test(el.innerHTML), 'nobody is left to wait for');
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
