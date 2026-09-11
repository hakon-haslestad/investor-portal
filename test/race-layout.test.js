const test = require('node:test');
const assert = require('node:assert');

// The placement maths from horse-race-view.js place(). Mirrored here because
// it lives inside a DOM closure; the constants are asserted against the source
// below so the two cannot drift apart.
const NAME_W = 150, LEFT_X = NAME_W + 24, START_X = 300, RIGHT_X = 960, VIEW_W = 1000;

function place(positions) {
  const maxPos = Math.max(1e-4, ...positions);
  const minPos = Math.min(0, ...positions);
  const posScale = (RIGHT_X - START_X) / maxPos;
  const negScale = minPos < 0 ? (START_X - LEFT_X) / Math.abs(minPos) : 0;
  return positions.map((pos) => {
    const raw = START_X + pos * (pos >= 0 ? posScale : negScale);
    return Math.max(LEFT_X, Math.min(VIEW_W - 14, raw));
  });
}

const CASES = {
  'all positive': [0.05, 0.20, 0.12],
  'mixed': [0.30, -0.10, 0.05],
  'mostly negative': [-0.40, -0.05, 0.02],
  'one catastrophic loser': [0.10, -0.95],
  'all flat': [0, 0, 0],
  'all negative': [-0.10, -0.30, -0.20],
  'tiny spread': [0.001, 0.002],
  'one runner': [0.15],
};

test('the constants here match the ones the view actually uses', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'docs', 'js', 'games', 'horse-race-view.js'), 'utf8');
  assert.match(src, new RegExp(`const NAME_W = ${NAME_W};`));
  assert.match(src, new RegExp(`const START_X = ${START_X};`));
  assert.match(src, new RegExp(`const RIGHT_X = ${RIGHT_X};`));
  assert.match(src, new RegExp(`const VIEW_W = ${VIEW_W};`));
  assert.match(src, /const LEFT_X = NAME_W \+ 24;/);
});

test('a runner never reaches the name gutter, however badly it is doing', () => {
  for (const [name, ps] of Object.entries(CASES)) {
    for (const x of place(ps)) {
      assert.ok(x >= NAME_W, `${name}: runner at ${x} is over the names (gutter ends ${NAME_W})`);
    }
  }
  // Even an absurd loss stays on the track.
  for (const x of place([0.2, -50])) assert.ok(x >= NAME_W);
});

test('nobody is ever drawn off the right edge', () => {
  for (const [name, ps] of Object.entries(CASES)) {
    for (const x of place(ps)) assert.ok(x <= VIEW_W - 14, `${name}: ${x} overflows`);
  }
});

test('the leader always reaches the right edge, even beside a big loser', () => {
  for (const [name, ps] of Object.entries(CASES)) {
    if (Math.max(...ps) <= 0) continue; // nobody is up; there is no winner to park
    const xs = place(ps);
    assert.ok(Math.max(...xs) > RIGHT_X - 1, `${name}: leader only got to ${Math.max(...xs)}`);
  }
  // The case that motivated per-side scales: one disaster must not squash the field.
  const xs = place([0.10, -0.95]);
  assert.ok(Math.max(...xs) > RIGHT_X - 1, 'the winner still runs the full track');
});

test('finishing order on screen always matches the real returns', () => {
  for (const [name, ps] of Object.entries(CASES)) {
    const xs = place(ps);
    const byValue = ps.map((_, i) => i).sort((a, b) => ps[a] - ps[b]);
    const byScreen = ps.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
    assert.deepEqual(byScreen, byValue, `${name}: the track lies about the order`);
  }
});

test('a horse in profit is right of the line; one in loss is left of it', () => {
  const ps = [0.10, -0.10, 0];
  const [win, lose, flat] = place(ps);
  assert.ok(win > START_X, 'profit runs ahead');
  assert.ok(lose < START_X, 'loss falls back');
  assert.equal(flat, START_X, 'flat sits exactly on the line');
});

test('an all-flat field stands on the line rather than dividing by zero', () => {
  for (const x of place([0, 0, 0])) assert.equal(x, START_X);
  assert.ok(Number.isFinite(place([0])[0]));
});
