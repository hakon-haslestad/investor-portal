const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const { baseWindow, load } = require('./harness');

// Mounts the real phone view on a resumed room whose state carries the evening's
// scoreboard. A render that throws on mount fails here.
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const SCORES = { games: [{ id: 'a', name: 'Guess the stock', pts: { HH: 2, JC: 2, HS: 1 } }, { id: 'b', name: 'Back trading', pts: { HS: 2 } }] };

function mount(state) {
  const w = baseWindow({ Views: {}, UI: { esc, emptyState: String }, location: { hash: '' } });
  vm.createContext(w);
  load(w, 'games/session.js', 'views/play.js');
  let push;
  const room = {
    member: 'JC', code: 'ABCD', forget() {}, close() {}, answer: async () => ({ ok: true }),
    onChange(cb) { push = cb; cb(state); return () => {}; },
  };
  const el = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
  w.Views.playResumed(el, room);
  return { el, push: (s) => push(s) };
}

test('the phone shows the same totals as the host: rank, total, breakdown, own row marked', () => {
  const { el } = mount({ roundId: 1, choices: 3, scores: SCORES });
  assert.match(el.innerHTML, /id="session-board"/);
  const rows = [...el.innerHTML.matchAll(/session-rank">(\d)<\/span>\s*<span class="session-name">(\w+)(?:<span class="session-you"> \(you\)<\/span>)?<\/span>\s*<span class="session-total">(\d)</g)].map((m) => m.slice(1).join(':'));
  assert.deepEqual(rows, ['1:HS:3', '2:HH:2', '2:JC:2']);
  assert.match(el.innerHTML, /HS<\/span>[\s\S]*Guess the stock 1 · Back trading 2/);
  assert.match(el.innerHTML, /session-row r2 mine/);
  assert.equal((el.innerHTML.match(/play-btn"/g) || []).length, 3, 'the buttons are still there');
});

test('no scores yet: no board, and a missing field never breaks the phone', () => {
  assert.doesNotMatch(mount({ roundId: 1, choices: 2 }).el.innerHTML, /session-board/);
  assert.doesNotMatch(mount({ roundId: 1, choices: 2, scores: null }).el.innerHTML, /session-board/);
});

test('a later poll updates the totals, and the end screen keeps the final board', () => {
  const { el, push } = mount({ roundId: 1, choices: 2, scores: { games: [] } });
  push({ roundId: 1, choices: 2, scores: SCORES });
  assert.match(el.innerHTML, /session-board/);
  push({ roundId: 1, closed: true });       // the closing poll may carry no scores field
  assert.match(el.innerHTML, /That's the game/);
  assert.match(el.innerHTML, /Final scores/);
});

test('during play the answer buttons come first and the board after; own row has a text cue', () => {
  const { el } = mount({ roundId: 1, choices: 2, scores: SCORES });
  assert.ok(el.innerHTML.indexOf('play-btn') < el.innerHTML.indexOf('id="session-board"'));
  assert.match(el.innerHTML, /JC<span class="session-you"> \(you\)/);
});

test('a player with no points reads "You: 0 points"; the ended screen says how it ended', () => {
  const none = mount({ roundId: 1, choices: 2, scores: { games: [{ id: 'a', name: 'A', pts: { HH: 1 } }] } });
  assert.match(none.el.innerHTML, /You: 0 points/);
  const ended = mount({ roundId: 1, closed: true, scores: SCORES });
  assert.match(ended.el.innerHTML, /Here is how it ended/);
  assert.doesNotMatch(ended.el.innerHTML, /Look up at the screen/);
  assert.match(mount({ roundId: 1, closed: true }).el.innerHTML, /Look up at the screen/);
});
