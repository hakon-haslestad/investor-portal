const test = require('node:test');
const assert = require('node:assert');
const { context } = require('./harness');

const plain = (x) => JSON.parse(JSON.stringify(x));
const fresh = () => context(['games/session.js']).GameSession;

test('totals add up across two games, with a per-game breakdown', () => {
  const S = fresh();
  S.award('guess', 'Guess the stock', { HH: 1, JC: 1 });
  S.award('guess', 'Guess the stock', { HH: 1 });
  S.award('back', 'Back trading', { JC: 1, HS: 1 });
  const rows = S.totals();
  assert.deepStrictEqual(plain(rows.map((r) => [r.code, r.total])), [['HH', 2], ['JC', 2], ['HS', 1]]);
  assert.deepStrictEqual(plain(rows[0].breakdown.map((b) => [b.name, b.points])), [['Guess the stock', 2]]);
  assert.deepStrictEqual(plain(rows[1].breakdown.map((b) => [b.name, b.points])), [['Guess the stock', 1], ['Back trading', 1]]);
});

test('ties share a rank and the next rank skips (1, 1, 3), stable by code', () => {
  const S = fresh();
  S.award('g', 'G', { JC: 2, HH: 2, HS: 1 });
  assert.deepStrictEqual(plain(S.totals().map((r) => [r.code, r.rank])), [['HH', 1], ['JC', 1], ['HS', 3]]);
});

test('placing gives 3, 2, 1 to the first three and nothing to the rest', () => {
  const S = fresh();
  const p = (o) => ({ ...S.placing(o) });
  assert.deepStrictEqual(p(['A', 'B', 'C', 'D']), { A: 3, B: 2, C: 1 });
  assert.deepStrictEqual(p(['A']), { A: 3 });
  assert.deepStrictEqual(p([]), {});
});

test('the same key is only counted once, so a re-render cannot award twice', () => {
  const S = fresh();
  const round = {};
  assert.strictEqual(S.award('g', 'G', { HH: 1 }, round), true);
  assert.strictEqual(S.award('g', 'G', { HH: 1 }, round), false);
  assert.strictEqual(S.totals()[0].total, 1);
});

test('zero and junk points add nothing and fire no change', () => {
  const S = fresh();
  let n = 0; S.onChange(() => { n += 1; });
  S.award('g', 'G', { HH: 0, JC: NaN });
  assert.strictEqual(n, 0);
  assert.ok(S.isEmpty());
});

test('reset clears points and awarded keys, and tells listeners', () => {
  const S = fresh();
  const round = {};
  S.award('g', 'G', { HH: 1 }, round);
  let seen; S.onChange((s) => { seen = s; });
  S.reset();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(seen)), { games: [] });
  assert.strictEqual(S.totals().length, 0);
  assert.strictEqual(S.award('g', 'G', { HH: 1 }, round), true);   // key forgotten
});

test('a phone computes the same totals from the snapshot the room carries', () => {
  const S = fresh();
  S.award('a', 'A', { HH: 3, JC: 2 });
  S.award('b', 'B', { JC: 3 });
  const wire = JSON.parse(JSON.stringify(S.snapshot()));
  const other = fresh();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(other.totals(wire))), JSON.parse(JSON.stringify(S.totals())));
});

// ── What a phone does with a snapshot it did not make ──────────────────────
test('a hostile snapshot cannot become markup: junk values are dropped, text is escaped', () => {
  const S = fresh();
  const wire = { games: [{ id: 'g', name: '<img src=x onerror=1>', pts: { HH: '<b>9</b>', JC: 1.5, '<i>': 2, HS: 3 } }, null, 'x'] };
  const rows = plain(S.totals(wire));
  assert.deepStrictEqual(rows.map((r) => [r.code, r.total]), [['HS', 3], ['<i>', 2]]);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const html = S.boardHtml(S.totals(wire), { esc });
  assert.ok(!/<img|<i>|<b>/.test(html));
  assert.deepStrictEqual(plain(S.totals({ games: 'nope' })), []);
});

test('the board names the player who is looking in words, not only colour, and says points to a screen reader', () => {
  const S = fresh();
  S.award('g', 'G', { HH: 2, JC: 1 });
  const esc = String;
  const html = S.boardHtml(S.totals(), { esc, me: 'JC' });
  assert.match(html, /session-name">JC<span class="session-you"> \(you\)<\/span>/);
  assert.equal((html.match(/\(you\)/g) || []).length, 1, 'only their own row');
  assert.match(html, /session-total">2<span class="sr-only"> points<\/span>/);
  assert.match(html, /aria-labelledby="session-board-title"/);
});

test('a player with no points still sees their own place; compact drops the breakdown', () => {
  const S = fresh();
  S.award('g', 'G', { HH: 2 });
  assert.match(S.boardHtml(S.totals(), { esc: String, me: 'JC' }), /You: 0 points/);
  assert.doesNotMatch(S.boardHtml(S.totals(), { esc: String, me: 'HH' }), /You: 0/);
  const compact = S.boardHtml(S.totals(), { esc: String, compact: true });
  assert.doesNotMatch(compact, /session-parts/);
  assert.match(compact, /session-board compact/);
});
