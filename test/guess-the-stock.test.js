const test = require('node:test');
const assert = require('node:assert');
const { context, load } = require('./harness');

function fakeEl() {
  const el = {
    innerHTML: '',
    _optsHtml: null,
    _opts: [],
    // The verdict panel is looked up and then queried again for its button,
    // so the stub has to nest like the real DOM does.
    querySelector: () => ({
      addEventListener() {}, appendChild() {}, innerHTML: '',
      querySelector: () => ({ addEventListener() {} }),
    }),
    querySelectorAll(sel) {
      if (sel !== '.guess-option') return [];
      if (el._optsHtml !== el.innerHTML) {
        el._optsHtml = el.innerHTML;
        const n = (el.innerHTML.match(/class="guess-option[^"]*"/g) || []).length;
        el._opts = [...Array(n)].map((_, i) => ({
          addEventListener(_e, fn) { this._fire = fn; },
          getAttribute: () => String(i),
        }));
      }
      return el._opts;
    },
  };
  return el;
}

const T = (security, over = {}) => ({
  security, investors: [{ code: 'HH', name: 'Hakon' }], investorName: 'Hakon',
  pnlNok: 100, pnlPct: 5, purchaseAmount: 1000, currentOrSoldValue: 1100,
  sold: false, from: '2024-01-01', to: '2024-12-31', win: true, ...over,
});

function mountGuess(trades, players, roomHooks) {
  const rounds = [];
  const listeners = [];
  const state = { answers: {} };
  const room = roomHooks === false ? null : {
    onChange(cb) { listeners.push(cb); cb(state); return () => {}; },
    setRound(prompt, choices) { rounds.push({ prompt, choices }); },
  };
  const w = context(['games/rng.js'], {
    Fmt: { fmtNok: (n) => `${n} kr`, fmtPct: (n) => `${n}%`, escapeHtml: String, pctClass: () => '' },
    UI: { emptyState: (t) => `EMPTY:${t}` },
    Charts: { priceChart: () => ({}) },
  });
  load(w, 'games/round.js', 'games/guess-the-stock.js');
  const el = fakeEl();
  const inst = w.GameGuessTheStock.mount(el, {
    trades, players, soberMode: false, rng: w.GameRng(5),
    pool: {
      priceSeriesForSecurity: () => ({ points: [{ date: 'a', price: 1 }, { date: 'b', price: 2 }], markers: [] }),
      chartable: () => true,
    },
    history: { add() {}, list: () => [] }, competitionId: '', room,
  });
  return { el, inst, rounds, push: (a) => { state.answers = a; listeners.forEach((cb) => cb(state)); } };
}

const SIX = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'].map((s) => T(s));
const ROSTER = [{ code: 'HH', name: 'Hakon' }, { code: 'JC', name: 'Jonas' }];

test('a round offers five candidates, one of which is the real one', () => {
  const { el } = mountGuess(SIX, ROSTER);
  const names = [...el.innerHTML.matchAll(/class="guess-name">([^<]+)</g)].map((m) => m[1]);
  assert.equal(names.length, 5, 'five options');
  assert.equal(new Set(names).size, 5, 'and no duplicates');
  for (const n of names) assert.ok(SIX.some((t) => t.security === n), `${n} is a real holding`);
});

test('the options are numbered, so a phone can pick by number', () => {
  const { el, rounds } = mountGuess(SIX, ROSTER);
  const nums = [...el.innerHTML.matchAll(/class="guess-num">(\d)</g)].map((m) => m[1]);
  assert.deepEqual(nums, ['1', '2', '3', '4', '5']);
  // The phone gets bare numbers — the names stay on the shared screen.
  assert.deepEqual(rounds[0].choices, ['1', '2', '3', '4', '5']);
  assert.match(rounds[0].prompt, /which stock/i);
});

test('the answer is not given away before the reveal', () => {
  const { el } = mountGuess(SIX, ROSTER);
  assert.ok(!/is-answer/.test(el.innerHTML), 'nothing is marked correct yet');
  assert.ok(!/It was/.test(el.innerHTML), 'and the name is not announced');
});

test('phones answer by index, and the round resolves when all are in', () => {
  const { el, push } = mountGuess(SIX, ROSTER);
  push({ HH: 0 });
  assert.ok(!/is-answer/.test(el.innerHTML), 'one in, still hidden');
  push({ HH: 0, JC: 1 });
  assert.ok(/is-answer/.test(el.innerHTML), 'both in, revealed');
  assert.match(el.innerHTML, /It was/);
});

test('a thin pool gives fewer options rather than an error', () => {
  const three = ['Alpha', 'Beta', 'Gamma'].map((s) => T(s));
  const { el } = mountGuess(three, ROSTER);
  const names = [...el.innerHTML.matchAll(/class="guess-name">([^<]+)</g)].map((m) => m[1]);
  assert.ok(names.length >= 2 && names.length <= 3, `got ${names.length}`);
  assert.equal(new Set(names).size, names.length, 'still no duplicates');
});

test('with nothing to guess between it says so', () => {
  const { el } = mountGuess([T('Only')], ROSTER);
  assert.match(el.innerHTML, /^EMPTY:/);
});

test('it works with no room at all — the screen path still stands alone', () => {
  const { el } = mountGuess(SIX, ROSTER, false);
  assert.match(el.innerHTML, /class="guess-option/);
  assert.equal((el.innerHTML.match(/class="guess-num"/g) || []).length, 5);
});

test('playing alone drops the multi-player chrome', () => {
  const { el } = mountGuess(SIX, [{ code: 'HH', name: 'Hakon' }]);
  assert.ok(!el.innerHTML.includes('game-players'), 'no player row');
  assert.match(el.innerHTML, /class="game-facts"/, 'but the score strip stays');
});
