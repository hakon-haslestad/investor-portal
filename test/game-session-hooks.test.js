const test = require('node:test');
const assert = require('node:assert');
const { context, load } = require('./harness');

// Each hosted game awards into GameSession at the point it already scores.
// Phones answer through a stub room, exactly as in the games' own UI tests.

const plain = (x) => JSON.parse(JSON.stringify(x));
const ROSTER = [{ code: 'HH', name: 'Hakon' }, { code: 'JC', name: 'Jonas' }];
const T = (security, over = {}) => ({
  security, investors: [{ code: 'HH', name: 'Hakon' }], investorName: 'Hakon',
  pnlNok: 100, pnlPct: 5, purchaseAmount: 1000, currentOrSoldValue: 1100,
  sold: false, from: '2024-01-01', to: '2024-12-31', win: true, ...over,
});

function stubRoom() {
  const listeners = [];
  const state = { answers: {} };
  return {
    onChange(cb) { listeners.push(cb); cb(state); return () => {}; },
    setRound() {},
    state,
    push(answers) { state.answers = answers; listeners.forEach((cb) => cb(state)); },
  };
}
const el = () => {
  const o = {
    innerHTML: '',
    querySelector: () => ({ addEventListener() {}, appendChild() {}, innerHTML: '', classList: { add() {} }, querySelector: () => ({ addEventListener() {} }) }),
    querySelectorAll: () => [],
    addEventListener() {}, insertAdjacentHTML() {},
  };
  return o;
};

// Find a seed where one of the two calls (cards 0 and 1) is right, so the
// assertion is never vacuous. `answerOf` reads the revealed card from the markup.
function playGuess(seed) {
  const room = stubRoom();
  const w = context(['games/session.js', 'games/rng.js'], {
    Fmt: { fmtNok: String, fmtPct: String, fmtDec: (n, d = 1) => Number(n).toFixed(d), escapeHtml: String, pctClass: () => '' },
    UI: { emptyState: String }, Charts: { priceChart: () => ({}) },
  });
  load(w, 'games/round.js', 'games/guess-the-stock.js');
  const e = el();
  w.GameGuessTheStock.mount(e, {
    trades: ['A', 'B', 'C', 'D', 'E', 'F'].map((s) => T(s)), players: ROSTER, soberMode: false, rng: w.GameRng(seed),
    pool: { priceSeriesForSecurity: () => ({ points: [{ date: 'a', price: 1 }, { date: 'b', price: 2 }], markers: [] }), chartable: () => true },
    history: { add() {}, list: () => [] }, competitionId: '', room,
  });
  room.push({ HH: 0, JC: 1 });
  const opts = e.innerHTML.match(/class="guess-option(?: [^"]*)?"/g) || [];
  return { w, room, answer: opts.findIndex((o) => /is-answer/.test(o)) };
}

test('guess the stock: each correct call is +1, wrong calls and a repaint add nothing', () => {
  let hit = null;
  for (let seed = 1; seed < 60 && !hit; seed++) { const r = playGuess(seed); if (r.answer === 0 || r.answer === 1) hit = r; }
  assert.ok(hit, 'a seed where a call is right');
  const rows = plain(hit.w.GameSession.totals());
  assert.deepStrictEqual(rows.map((r) => [r.code, r.total]), [[hit.answer === 0 ? 'HH' : 'JC', 1]]);
  assert.strictEqual(rows[0].breakdown[0].name, 'Guess the stock');
  const before = JSON.stringify(hit.w.GameSession.snapshot());
  hit.room.push({ HH: 0, JC: 1 });               // same answers again: no second award
  assert.strictEqual(JSON.stringify(hit.w.GameSession.snapshot()), before);
});

test('odd one out: only the right call scores', () => {
  const TR = [100, 200, 300, -50, 400, -10].map((p, i) => T('S' + i, { pnlNok: p }));
  let total = null;
  for (let seed = 1; seed < 60 && total === null; seed++) {
    const room = stubRoom();
    const w = context(['games/session.js', 'games/rng.js'], {
      Fmt: { fmtNok: String, fmtPct: String, fmtDec: (n, d = 1) => Number(n).toFixed(d), escapeHtml: String, pctClass: () => '' }, UI: { emptyState: String },
    });
    load(w, 'games/round.js', 'games/odd-one-out-rules.js', 'games/odd-one-out.js');
    w.GameOddOneOut.mount(el(), { trades: TR, players: ROSTER, soberMode: false, rng: w.GameRng(seed), history: { add() {}, list: () => [] }, competitionId: '', room });
    room.push({ HH: 0, JC: 1 });
    const rows = plain(w.GameSession.totals());
    if (rows.length) total = rows;
  }
  assert.ok(total, 'a seed where a call is right');
  assert.strictEqual(total.length, 1, 'cards 0 and 1 cannot both be the answer');
  assert.deepStrictEqual([total[0].total, total[0].breakdown[0].name], [1, 'Odd one out']);
});

test('horse race: the engine keeps the player code on each lane so the podium can be scored', () => {
  const w = context(['games/horse-race-engine.js']);
  const mk = (ticker, code, end) => ({ ticker, name: ticker, player: code, code, odds: 2, positions: [0, end] });
  const race = w.HorseRaceEngine.buildRace([mk('A', 'HH', 0.1), mk('B', 'JC', 0.3), mk('C', 'ØS', 0.2)]);
  assert.deepStrictEqual(plain(race.ranking.map((l) => l.code)), ['JC', 'ØS', 'HH']);
});

test('back trading: reveal scores each right call +1, and revealing twice adds nothing', () => {
  const room = stubRoom();
  const handlers = {};
  const node = (sel) => ({ addEventListener(t, fn) { handlers[sel] = fn; }, appendChild() {}, disabled: false, textContent: '', value: '', classList: { add() {} } });
  const e = { innerHTML: '', querySelector: node, querySelectorAll: () => [], addEventListener() {}, insertAdjacentHTML(_p, h) { this.innerHTML += h; } };
  const w = context(['games/session.js', 'games/back-trading-verdict.js'], {
    Fmt: { fmtNok: String, fmtPct: String, fmtDec: (n, d = 1) => Number(n).toFixed(d), escapeHtml: String, pctClass: () => '' },
    UI: { emptyState: String, table: () => '', section: () => '' }, Charts: { priceChart: () => ({}) },
    Positions: { bySecurity: () => new Map([['alpha', { dates: ['2024-01-10', '2024-05-01'] }]]), stateAt: () => ({ qty: 100, costSum: 8000, realized: 0 }) },
    Ledger: { isRealizingSell: (t) => t === 'SALG', splitForSecurity: () => [{ code: 'HH' }] },
  });
  load(w, 'games/round.js', 'games/back-trading.js');
  const points = [...Array(200)].map((_, i) => ({ date: new Date(Date.UTC(2024, 4, 2 + i)).toISOString().slice(0, 10), price: 130 }));
  const TX = [
    { tradeDate: '2024-01-10', type: 'KJØPT', security: 'Alpha', qty: 100, price: 80, currency: 'NOK' },
    { tradeDate: '2024-05-01', type: 'SALG', security: 'Alpha', qty: -50, price: 120, currency: 'NOK', nordnetId: 'a' },
  ];
  w.GameBackTrading.mount(e, {
    players: ROSTER, soberMode: false, rng: { pick: (a) => a[0] }, room,
    pool: { store: { transactions: TX, attributionMap: {} }, canon: (s) => String(s).toLowerCase(), names: {}, priceSeriesForSecurity: () => ({ points, markers: [] }), holdingText: () => '4 mo' },
    history: { add() {}, list: () => [] }, competitionId: '',
  });
  room.push({ HH: 0, JC: 1 });                  // HH holds, JC sells; price ran on, so holding was right
  handlers['#bt-reveal']();
  const rows = plain(w.GameSession.totals());
  assert.deepStrictEqual(rows.map((r) => [r.code, r.total, r.breakdown[0].name]), [['HH', 1, 'Back trading']]);
  handlers['#bt-reveal']();                      // a second click on the same reveal
  assert.strictEqual(plain(w.GameSession.totals())[0].total, 1);
});
