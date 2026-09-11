const test = require('node:test');
const assert = require('node:assert');
const { context } = require('./harness');

// The real geometry and placement, exported from the view rather than mirrored
// here — so these tests cannot quietly drift from what the screen does.
function V() {
  const w = context([], {
    Fmt: { fmtPct: String, escapeHtml: String },
    HorseRaceEngine: { interpolate: () => 0, FILLER: [] },
  });
  require('./harness').load(w, 'games/horse-race-view.js');
  return w.HorseRaceView;
}

const WIDTHS = [360, 390, 768, 1000, 1440, 1920, 2560];
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

test('the viewBox tracks the real width, so text keeps its size at any screen', () => {
  const { geometry } = V();
  for (const w of WIDTHS) {
    const g = geometry(w);
    assert.equal(g.VIEW_W, Math.max(340, Math.min(2400, w)),
      `at ${w}px the viewBox should match the pixels`);
  }
  // Absurd inputs are clamped rather than producing a broken box.
  assert.equal(geometry(10).VIEW_W, 340, 'clamped up to something usable');
  assert.equal(geometry(99999).VIEW_W, 2400, 'clamped down');
  // A hidden element reports clientWidth 0, which means "unmeasurable", not
  // "zero wide" — so it takes the default rather than the floor.
  assert.equal(geometry(0).VIEW_W, 1000);
  assert.equal(geometry(undefined).VIEW_W, 1000);
});

test('a wider screen gives more track, not bigger horses', () => {
  const { geometry } = V();
  const narrow = geometry(1000);
  const wide = geometry(2000);
  const trackOf = (g) => g.RIGHT_X - g.START_X;
  assert.ok(trackOf(wide) > trackOf(narrow) * 1.7,
    'doubling the screen should roughly double the running room');
});

test('the name gutter stays a sane share of the screen', () => {
  const { geometry } = V();
  for (const w of WIDTHS) {
    const g = geometry(w);
    assert.ok(g.NAME_W >= 76, `${w}px: gutter too small to hold a code`);
    assert.ok(g.NAME_W / g.VIEW_W < 0.32, `${w}px: gutter eats ${(g.NAME_W / g.VIEW_W * 100).toFixed(0)}% of the track`);
  }
  assert.equal(geometry(360).showSublabel, false, 'no room for a full name on a phone');
  assert.equal(geometry(1440).showSublabel, true, 'but plenty on a laptop');
});

test('a runner never reaches the name gutter, at any width or any result', () => {
  const { geometry, placeX } = V();
  for (const w of WIDTHS) {
    const g = geometry(w);
    for (const [name, ps] of Object.entries(CASES)) {
      for (const x of placeX(ps, g)) {
        assert.ok(x >= g.NAME_W, `${w}px ${name}: runner at ${x} covers the names (gutter ${g.NAME_W})`);
      }
    }
    for (const x of placeX([0.2, -50], g)) assert.ok(x >= g.NAME_W, `${w}px: absurd loss still on track`);
  }
});

test('nobody is drawn off either edge', () => {
  const { geometry, placeX } = V();
  for (const w of WIDTHS) {
    const g = geometry(w);
    for (const [name, ps] of Object.entries(CASES)) {
      for (const x of placeX(ps, g)) {
        assert.ok(x >= 0 && x <= g.VIEW_W, `${w}px ${name}: ${x} is outside 0..${g.VIEW_W}`);
      }
    }
  }
});

test('the leader always reaches the right edge, even beside a big loser', () => {
  const { geometry, placeX } = V();
  for (const w of WIDTHS) {
    const g = geometry(w);
    for (const [name, ps] of Object.entries(CASES)) {
      if (Math.max(...ps) <= 0) continue; // nobody is up, so nobody parks at the line
      const xs = placeX(ps, g);
      assert.ok(Math.max(...xs) > g.RIGHT_X - 1, `${w}px ${name}: leader only got to ${Math.max(...xs)}`);
    }
    const xs = placeX([0.10, -0.95], g);
    assert.ok(Math.max(...xs) > g.RIGHT_X - 1, `${w}px: one disaster must not squash the winner`);
  }
});

test('screen order always matches the real returns', () => {
  const { geometry, placeX } = V();
  for (const w of WIDTHS) {
    const g = geometry(w);
    for (const [name, ps] of Object.entries(CASES)) {
      const xs = placeX(ps, g);
      const byValue = ps.map((_, i) => i).sort((a, b) => ps[a] - ps[b]);
      const byScreen = ps.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
      assert.deepEqual(byScreen, byValue, `${w}px ${name}: the track lies about the order`);
    }
  }
});

test('profit is right of the line, loss is left, flat is on it', () => {
  const { geometry, placeX } = V();
  const g = geometry(1200);
  const [win, lose, flat] = placeX([0.10, -0.10, 0], g);
  assert.ok(win > g.START_X);
  assert.ok(lose < g.START_X);
  assert.equal(flat, g.START_X);
});

test('an all-flat field stands on the line rather than dividing by zero', () => {
  const { geometry, placeX } = V();
  const g = geometry(1000);
  for (const x of placeX([0, 0, 0], g)) assert.equal(x, g.START_X);
  assert.ok(Number.isFinite(placeX([0], g)[0]));
});
