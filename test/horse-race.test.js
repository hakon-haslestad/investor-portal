const test = require('node:test');
const assert = require('node:assert');
const { context } = require('./harness');

const E = () => context(['games/horse-race-engine.js']).HorseRaceEngine;
const pts = (...prices) => prices.map((p, i) => ({ date: `2024-01-${String(i + 1).padStart(2, '0')}`, price: p }));

test('normalise makes every horse start at zero, whatever it costs', () => {
  const e = E();
  const cheap = e.normalise(pts(10, 11, 12));
  const dear = e.normalise(pts(1000, 1100, 1200));
  assert.equal(cheap[0].pos, 0);
  assert.equal(dear[0].pos, 0);
  // Same percentage move, same position — price level must not matter.
  assert.ok(Math.abs(cheap[1].pos - dear[1].pos) < 1e-12);
  assert.ok(Math.abs(cheap[2].pos - 0.2) < 1e-12);
});

test('normalise refuses data it cannot use', () => {
  const e = E();
  assert.equal(e.normalise([]), null);
  assert.equal(e.normalise(pts(100)), null, 'one point is not a race');
  assert.equal(e.normalise(pts(0, 100)), null, 'a zero base would divide by zero');
  assert.equal(e.normalise(null), null);
});

test('higher volatility gives longer odds, and odds stay in a sane band', () => {
  const e = E();
  const calm = e.volatility(pts(100, 100.1, 100.2, 100.1, 100.2));
  const wild = e.volatility(pts(100, 130, 80, 140, 70));
  assert.ok(wild > calm, 'the wild series is more volatile');
  assert.ok(e.oddsFor(wild) > e.oddsFor(calm), 'and so is priced longer');
  assert.ok(e.oddsFor(0) >= e.ODDS_MIN);
  assert.ok(e.oddsFor(999) <= e.ODDS_MAX, 'odds are clamped, not absurd');
  assert.equal(e.volatility(pts(100)), 0, 'too little data is zero, not NaN');
});

// ── Commentary triggers ────────────────────────────────────────────────────
function lanes(spec) {
  return Object.entries(spec).map(([ticker, positions]) => ({ ticker, positions }));
}

test('a change at the front is called', () => {
  const e = E();
  const ev = e.commentary(lanes({ AAA: [0, 0.01, 0.02], BBB: [0, 0.005, 0.05] }));
  const lead = ev.filter((x) => x.kind === 'lead');
  assert.equal(lead.length, 1);
  assert.equal(lead[0].text, 'BBB takes the lead');
  assert.equal(lead[0].step, 2);
});

test('a gain over 3 percentage points in one step is a breakaway', () => {
  const e = E();
  const just = e.commentary(lanes({ AAA: [0, 0.029], BBB: [0, 0] }));
  assert.equal(just.filter((x) => x.kind === 'breakaway').length, 0, '2.9pp is not a breakaway');
  const over = e.commentary(lanes({ AAA: [0, 0.031], BBB: [0, 0] }));
  const b = over.filter((x) => x.kind === 'breakaway');
  assert.equal(b.length, 1);
  assert.equal(b[0].text, 'AAA breaks away');
});

test('the single worst step of the race is the stumble, and only one is called', () => {
  const e = E();
  const ev = e.commentary(lanes({
    AAA: [0, -0.02, -0.03],     // two small drops
    BBB: [0, 0.01, -0.20],      // one big one
  }));
  const st = ev.filter((x) => x.kind === 'stumble');
  assert.equal(st.length, 1, 'exactly one stumble per race');
  assert.equal(st[0].text, 'BBB stumbles');
  assert.equal(st[0].step, 2);
});

test('a finish inside 0.3 percentage points is a photo finish', () => {
  const e = E();
  const close = e.commentary(lanes({ AAA: [0, 0.100], BBB: [0, 0.098] }));
  assert.ok(close.some((x) => x.kind === 'photo'), '0.2pp apart is a photo finish');
  const clear = e.commentary(lanes({ AAA: [0, 0.100], BBB: [0, 0.090] }));
  assert.ok(!clear.some((x) => x.kind === 'photo'), '1pp apart is not');
});

test('commentary is ordered by step and never throws on thin input', () => {
  const e = E();
  const ev = e.commentary(lanes({ AAA: [0, 0.05, -0.10, 0.2], BBB: [0, 0.01, 0.02, 0.19] }));
  const steps = ev.map((x) => x.step);
  assert.deepEqual(steps, steps.slice().sort((a, b) => a - b));
  assert.deepEqual(e.commentary([]), []);
  assert.deepEqual(e.commentary(lanes({ AAA: [0] })), [], 'a single data point has nothing to say');
});

// ── Interpolation ──────────────────────────────────────────────────────────
test('interpolation hits every real data point exactly', () => {
  const e = E();
  const positions = [0, 0.05, -0.02, 0.11];
  const n = positions.length;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    assert.ok(Math.abs(e.interpolate(positions, t) - positions[i]) < 1e-9, `data point ${i}`);
  }
});

test('jitter changes the path but never the endpoints — the finish is the real return', () => {
  const e = E();
  const positions = [0, 0.05, -0.02, 0.11];
  const n = positions.length;
  for (const seed of [0.13, 0.77, 0.42]) {
    // Every real data point still lands exactly.
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      assert.ok(Math.abs(e.interpolate(positions, t, seed) - positions[i]) < 1e-9,
        `seed ${seed} data point ${i}`);
    }
    // But mid-segment it differs, which is what makes lead changes visible.
    const plain = e.interpolate(positions, 0.17);
    const wobbly = e.interpolate(positions, 0.17, seed);
    assert.notEqual(plain, wobbly);
  }
});

test('interpolation stays inside the series for out-of-range t', () => {
  const e = E();
  const positions = [0, 0.5];
  assert.equal(e.interpolate(positions, -1), 0);
  assert.equal(e.interpolate(positions, 2), 0.5);
  assert.equal(e.interpolate([], 0.5), 0);
  assert.equal(e.interpolate([0.3], 0.5), 0.3);
});

test('a race lasts about a minute, a little longer for wider windows', () => {
  const e = E();
  assert.equal(e.durationFor(5), 60000);
  assert.equal(e.durationFor(20), 75000);
  assert.equal(e.durationFor(60), 75000);
  // Long enough to watch, not so long it outlasts the room's patience.
  for (const d of [5, 20, 60]) {
    assert.ok(e.durationFor(d) >= 60000 && e.durationFor(d) <= 90000, `window ${d}`);
  }
});

// ── buildRace ──────────────────────────────────────────────────────────────
test('buildRace excludes horses with no data, before the race rather than during', () => {
  const e = E();
  const race = e.buildRace([
    { ticker: 'AAA', name: 'A', player: 'HH', points: pts(100, 110) },
    { ticker: 'BBB', name: 'B', player: 'JC', points: pts(50, 45) },
    { ticker: 'CCC', name: 'C', player: 'ØS', points: [] },
  ]);
  assert.ok(race.ok);
  assert.deepEqual(race.lanes.map((l) => l.ticker), ['AAA', 'BBB']);
  assert.equal(race.excluded.length, 1);
  assert.equal(race.excluded[0].ticker, 'CCC');
  assert.ok(race.excluded[0].reason);
});

test('buildRace refuses to start with fewer than two runners', () => {
  const e = E();
  assert.equal(e.buildRace([{ ticker: 'AAA', points: pts(1, 2) }]).ok, false);
  assert.equal(e.buildRace([]).ok, false);
  assert.equal(e.buildRace(null).ok, false);
});

test('the finishing order is the real returns, best first', () => {
  const e = E();
  const race = e.buildRace([
    { ticker: 'AAA', points: pts(100, 105) },   // +5%
    { ticker: 'BBB', points: pts(100, 130) },   // +30%
    { ticker: 'CCC', points: pts(100, 90) },    // -10%
  ]);
  assert.deepEqual(race.ranking.map((l) => l.ticker), ['BBB', 'AAA', 'CCC']);
  assert.ok(Math.abs(race.ranking[0].finalPos - 0.30) < 1e-12);
  assert.ok(race.ranking[2].finalPos < 0, 'a loser finishes behind the start line');
});

test('every lane exposes a date per position — what the timeline reads', () => {
  const e = E();
  const race = e.buildRace([
    { ticker: 'AAA', points: pts(100, 105, 110) },
    { ticker: 'BBB', points: pts(50, 52, 49) },
  ]);
  assert.ok(race.ok);
  for (const l of race.lanes) {
    assert.equal(l.dates.length, l.positions.length, `${l.ticker}: one date per position`);
    assert.ok(l.dates[0] < l.dates[l.dates.length - 1], 'dates run forwards');
  }
  // The timeline slices lane 0 to `steps`, so that must be in range.
  assert.ok(race.steps <= race.lanes[0].dates.length);
  assert.equal(race.lanes[0].dates.slice(0, race.steps).length, race.steps);
});

test('a short lane sets the race length, so the timeline cannot overrun', () => {
  const e = E();
  const race = e.buildRace([
    { ticker: 'AAA', points: pts(100, 105, 110, 115) },
    { ticker: 'BBB', points: pts(50, 52) },
  ]);
  assert.equal(race.steps, 2, 'the shortest lane decides');
  const timelineDates = race.lanes[0].dates.slice(0, race.steps);
  assert.equal(timelineDates.length, 2);
  // The playhead maps t in [0,1] onto these — both ends must be addressable.
  for (const t of [0, 0.5, 1]) {
    const i = Math.round(t * (timelineDates.length - 1));
    assert.ok(timelineDates[i], `t=${t} resolves to a date`);
  }
});
