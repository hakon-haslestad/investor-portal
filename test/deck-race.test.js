const test = require('node:test');
const assert = require('node:assert');
const { baseWindow, load } = require('./harness');
const vm = require('vm');

// presentation-builder.js destructures window.Ledger at load and calls into
// CompetitionEngine. Stub just enough to exercise the race/curve sampling.
function builderCtx(scoreByDate) {
  const w = baseWindow({
    Fmt: {
      fmtNok: (n) => `${Math.round(n)} kr`, fmtPct: (n) => `${Number(n).toFixed(1)}%`,
      fmtQty: String, pctClass: () => '', escapeHtml: String, PODIUM: [],
    },
    Ledger: {
      splitForSecurity: () => [],
      INVESTOR_COLORS: { HH: '#111', JC: '#222' },
      classify: () => 'OTHER',
      isRealizingSell: () => false,
      amountNok: () => 0,
    },
    Portfolio: { canonicalName: (s) => s },
    Copy: { NAMES: {}, namesFromMembers: () => ({ HH: 'Hakon', JC: 'Jonas' }), verdictFromReturn: () => '' },
    CompetitionEngine: {
      scoreCompetition: (store, comp) => ({ ranks: scoreByDate(comp.end_date) }),
    },
  });
  vm.createContext(w);
  load(w, 'presentation-builder.js');
  return w;
}

const STORE = {
  prices: { dates: ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05'] },
  transactions: [], kpis: [], members: [],
};
const COMP = { id: 'C1', name: 'Spring', start_date: '2024-01-01', end_date: '2024-01-05' };
const PARTS = [{ investor_code: 'HH' }, { investor_code: 'JC' }];

// HH climbs steadily, JC dips then recovers to less.
const SCORES = {
  '2024-01-02': [{ code: 'HH', pct: 1, netPnl: 100 }, { code: 'JC', pct: -1, netPnl: -100 }],
  '2024-01-03': [{ code: 'HH', pct: 3, netPnl: 300 }, { code: 'JC', pct: 0, netPnl: 0 }],
  '2024-01-04': [{ code: 'HH', pct: 6, netPnl: 600 }, { code: 'JC', pct: 2, netPnl: 200 }],
  '2024-01-05': [{ code: 'HH', pct: 8, netPnl: 800 }, { code: 'JC', pct: 5, netPnl: 500 }],
};

function build() {
  const w = builderCtx((d) => SCORES[d] || []);
  const out = w.PresentationBuilder.buildPresentation(STORE, {
    competition: COMP, participants: PARTS,
    ranks: [{ code: 'HH', pct: 8, netPnl: 800, grossBought: 1000, breakdown: [] },
      { code: 'JC', pct: 5, netPnl: 500, grossBought: 1000, breakdown: [] }],
    teams: null,
  });
  return out;
}

test('the deck gains a race slide, and it sits just before the standings', () => {
  const { slides } = build();
  const types = slides.map((s) => s.type);
  assert.ok(types.includes('race'), 'a race slide exists');
  assert.equal(types[types.indexOf('race') + 1], 'standings',
    'the race runs up to the standings, which then confirm it');
});

test('one lane per participant, ordered by where they finished', () => {
  const race = build().slides.find((s) => s.type === 'race');
  assert.equal(race.lanes.length, 2);
  assert.deepEqual(race.lanes.map((l) => l.code), ['HH', 'JC'], 'best finisher first');
  assert.equal(race.lanes[0].colour, '#111', 'silks come from INVESTOR_COLORS');
});

test('every lane is anchored at zero on the start date', () => {
  const race = build().slides.find((s) => s.type === 'race');
  for (const l of race.lanes) {
    assert.equal(l.positions[0], 0, `${l.code} starts at the line`);
    assert.equal(l.dates[0], COMP.start_date);
  }
});

test('positions are fractions, not percentages — the view works in fractions', () => {
  const race = build().slides.find((s) => s.type === 'race');
  const hh = race.lanes.find((l) => l.code === 'HH');
  // Final score was 8%, so the finishing position is 0.08.
  assert.ok(Math.abs(hh.positions[hh.positions.length - 1] - 0.08) < 1e-12,
    `got ${hh.positions[hh.positions.length - 1]}`);
});

test('one position per date, so the timeline cannot run off the end', () => {
  const race = build().slides.find((s) => s.type === 'race');
  for (const l of race.lanes) {
    assert.equal(l.positions.length, l.dates.length, `${l.code}: positions and dates line up`);
    assert.ok(l.positions.length >= 2, 'enough to race');
  }
});

test('the race finishes in the same order the standings rank — the point of sharing the sampler', () => {
  const { slides } = build();
  const race = slides.find((s) => s.type === 'race');
  const standings = slides.find((s) => s.type === 'standings');
  const raceOrder = race.lanes.map((l) => l.code);
  const standingsOrder = (standings.individual || []).map((r) => r.code);
  assert.deepEqual(raceOrder, standingsOrder,
    'if these ever disagree the shared sampler is not actually shared');
});

test('the curve slide plots the same numbers the race runs on', () => {
  const { slides } = build();
  const race = slides.find((s) => s.type === 'race');
  const curve = slides.find((s) => s.type === 'curve');
  for (const lane of race.lanes) {
    const line = curve.series.find((x) => x.name.startsWith(lane.code));
    assert.ok(line, `${lane.code} is on the curve too`);
    assert.equal(line.points.length, lane.positions.length, `${lane.code}: same sample count`);
    line.points.forEach((p, i) => {
      assert.ok(Math.abs(p.y / 100 - lane.positions[i]) < 1e-12,
        `${lane.code} point ${i}: curve ${p.y}% vs race ${lane.positions[i]}`);
    });
  }
});

test('a competition with no activity yields a race slide that says so', () => {
  const w = builderCtx(() => []);
  const out = w.PresentationBuilder.buildPresentation(STORE, {
    competition: COMP, participants: PARTS,
    ranks: [{ code: 'HH', pct: 0, netPnl: 0, grossBought: 0, breakdown: [] }],
    teams: null,
  });
  const race = out.slides.find((s) => s.type === 'race');
  assert.ok(race, 'the slide still exists');
  assert.equal(race.noActivity, true);
  assert.ok(race.emptyNote, 'and carries the same explanation every other slide uses');
  assert.deepEqual(race.lanes, [], 'with no runners rather than a broken track');
});
