const test = require('node:test');
const assert = require('node:assert');
const { context } = require('./harness');

const R = () => context(['games/round.js']).GameRounds;
const ROSTER = [{ code: 'HH' }, { code: 'JC' }, { code: 'ØS' }];

// A room double that behaves like the real GameRoom in the two ways that
// have caused bugs: onChange fires its callback immediately, and the function
// it returns genuinely unsubscribes. A double that only half-implements the
// contract is how the last crash reached production.
function fakeRoom() {
  const listeners = new Set();
  const state = { answers: {} };
  const announced = [];
  return {
    announced,
    push(answers) { state.answers = answers; [...listeners].forEach((cb) => cb(state)); },
    onChange(cb) { listeners.add(cb); cb(state); return () => listeners.delete(cb); },
    setRound(prompt, labels) { announced.push({ prompt, labels }); },
  };
}

test('an answer is recorded whoever it came from', () => {
  const r = R().create({ roster: ROSTER });
  r.open({ prompt: 'q', labels: ['a', 'b', 'c', 'd'] });
  assert.equal(r.set('HH', 2), true);
  assert.equal(r.valueFor('HH'), 2);
  assert.equal(r.count, 1);
  assert.equal(r.complete, false);
});

test('a round is complete only when every player has answered', () => {
  const r = R().create({ roster: ROSTER });
  r.open({ prompt: 'q', labels: ['a', 'b'] });
  r.set('HH', 0); assert.equal(r.complete, false);
  r.set('JC', 1); assert.equal(r.complete, false);
  assert.deepEqual(r.remaining.map((p) => p.code), ['ØS']);
  r.set('ØS', 0); assert.equal(r.complete, true);
});

test('a stranger cannot answer, and an out-of-range option is refused', () => {
  const r = R().create({ roster: ROSTER });
  r.open({ prompt: 'q', labels: ['a', 'b'] });
  assert.equal(r.set('ZZ', 0), false, 'not on the roster');
  assert.equal(r.set('HH', 5), false, 'no such option');
  assert.equal(r.set('HH', -1), false);
  assert.equal(r.set('HH', 1.5), false);
  assert.equal(r.set('HH', 'one'), false);
  assert.equal(r.count, 0, 'none of those were recorded');
});

test('answering twice with the same value is not an error', () => {
  const r = R().create({ roster: ROSTER });
  r.open({ prompt: 'q', labels: ['a', 'b'] });
  assert.equal(r.set('HH', 1), true);
  assert.equal(r.set('HH', 1), true);
  assert.equal(r.count, 1);
});

test('a player can change their mind before the round closes', () => {
  const r = R().create({ roster: ROSTER });
  r.open({ prompt: 'q', labels: ['a', 'b', 'c'] });
  r.set('HH', 0);
  r.set('HH', 2);
  assert.equal(r.valueFor('HH'), 2);
  assert.equal(r.count, 1, 'still one answer, not two');
});

// ── Exclusive options: Horse Race ─────────────────────────────────────────
test('first claim on a horse wins; the second is refused', () => {
  const r = R().create({ roster: ROSTER, exclusive: true });
  r.open({ prompt: 'pick', labels: ['EQNR', 'KIT', 'SALM'] });
  assert.equal(r.set('JC', 1), true, 'JC gets it');
  assert.equal(r.set('ØS', 1), false, 'ØS is too late');
  assert.equal(r.valueFor('ØS'), null, 'and is left without one');
  assert.equal(r.holderOf(1), 'JC');
  assert.equal(r.set('ØS', 2), true, 'but can take another');
});

test('keeping your own horse is not a clash with yourself', () => {
  const r = R().create({ roster: ROSTER, exclusive: true });
  r.open({ prompt: 'pick', labels: ['A', 'B'] });
  r.set('HH', 0);
  assert.equal(r.set('HH', 0), true, 'the holder may re-send it');
});

test('without exclusivity, several players may pick the same option', () => {
  const r = R().create({ roster: ROSTER });
  r.open({ prompt: 'q', labels: ['a', 'b'] });
  assert.equal(r.set('HH', 0), true);
  assert.equal(r.set('JC', 0), true);
  assert.equal(r.count, 2);
});

// ── Announcing ────────────────────────────────────────────────────────────
test('opening the same round twice does not re-announce or wipe answers', () => {
  const room = fakeRoom();
  const r = R().create({ roster: ROSTER, room });
  assert.equal(r.open({ prompt: 'q', labels: ['a', 'b'], key: 'round-1' }), true);
  r.set('HH', 1);
  // A re-render must not cost the room its answers — this is why the guard
  // exists: every game re-renders on any toggle.
  assert.equal(r.open({ prompt: 'q', labels: ['a', 'b'], key: 'round-1' }), false);
  assert.equal(r.valueFor('HH'), 1, 'the answer survived the re-render');
  assert.equal(room.announced.length, 1, 'and the phones were told once');
});

test('a genuinely new round announces and clears', () => {
  const room = fakeRoom();
  const r = R().create({ roster: ROSTER, room });
  r.open({ prompt: 'q1', labels: ['a', 'b'], key: 'r1' });
  r.set('HH', 0);
  assert.equal(r.open({ prompt: 'q2', labels: ['c', 'd'], key: 'r2' }), true);
  assert.equal(r.count, 0, 'last round\'s answers do not carry over');
  assert.deepEqual(room.announced.map((a) => a.prompt), ['q1', 'q2']);
});

test('labels are passed to the phones as given', () => {
  const room = fakeRoom();
  const r = R().create({ roster: ROSTER, room });
  r.open({ prompt: 'Held?', labels: ['Hold', 'Sell'], key: 'x' });
  assert.deepEqual(room.announced[0].labels, ['Hold', 'Sell']);
  assert.deepEqual(r.labels, ['Hold', 'Sell']);
});

// ── Remote answers ────────────────────────────────────────────────────────
test('phone answers land in the same place as taps', () => {
  const room = fakeRoom();
  const seen = [];
  const r = R().create({ roster: ROSTER, room, onChange: (e) => seen.push(e) });
  r.open({ prompt: 'q', labels: ['a', 'b', 'c', 'd'], key: 'r1' });
  room.push({ HH: 2, JC: 0 });
  assert.equal(r.valueFor('HH'), 2);
  assert.equal(r.valueFor('JC'), 0);
  assert.equal(seen.length, 1, 'one notification for the batch');
  assert.equal(seen[0].changed, true);
});

test('subscribing does not fire the game before a round is open', () => {
  const room = fakeRoom();
  const seen = [];
  // room.onChange calls back synchronously on subscribe. Rounds swallows
  // that, which is what stops a game touching state it has not declared yet.
  R().create({ roster: ROSTER, room, onChange: (e) => seen.push(e) });
  assert.equal(seen.length, 0);
});

test('junk from a phone is ignored rather than scored', () => {
  const room = fakeRoom();
  const seen = [];
  const r = R().create({ roster: ROSTER, room, onChange: (e) => seen.push(e) });
  r.open({ prompt: 'q', labels: ['a', 'b'], key: 'r1' });
  room.push({ ZZ: 0, HH: 99, JC: 'nonsense' });
  assert.equal(r.count, 0);
  assert.equal(seen.length, 0, 'nothing changed, so the game is not woken');
});

test('a refused phone claim is reported so that player can be told', () => {
  const room = fakeRoom();
  const seen = [];
  const r = R().create({ roster: ROSTER, room, exclusive: true, onChange: (e) => seen.push(e) });
  r.open({ prompt: 'pick', labels: ['A', 'B'], key: 'r1' });
  r.set('HH', 0);
  room.push({ HH: 0, JC: 0 });
  assert.deepEqual(seen[seen.length - 1].refused, ['JC']);
  assert.equal(r.valueFor('JC'), null);
});

test('an empty roster is never complete', () => {
  const r = R().create({ roster: [] });
  r.open({ prompt: 'q', labels: ['a'] });
  assert.equal(r.complete, false);
});

test('destroy unsubscribes and drops the answers', () => {
  const room = fakeRoom();
  const seen = [];
  const r = R().create({ roster: ROSTER, room, onChange: (e) => seen.push(e) });
  r.open({ prompt: 'q', labels: ['a', 'b'], key: 'r1' });
  r.set('HH', 0);
  r.destroy();
  assert.equal(r.count, 0);
  room.push({ JC: 1 });
  assert.equal(seen.length, 0, 'a destroyed round hears nothing');
});
