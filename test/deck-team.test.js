const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const { baseWindow, load } = require('./harness');

// Real Fmt and Copy; the engine is a stub that returns per-date ranks AND
// teams, so the deck's team mode can be pinned without a ledger.
const NOW = new Date('2024-06-01T12:00:00Z');
const COMP = { id: 'C1', name: 'Spring', start_date: '2024-01-01', end_date: '2024-03-01' };
const PARTS = [{ investor_code: 'HH' }, { investor_code: 'HS' }, { investor_code: 'HF' }];
const STORE = {
  prices: { dates: ['2024-01-10', '2024-01-31', '2024-02-15', '2024-03-01'] },
  transactions: [], kpis: [], members: [],
};
const row = (code, teamLabel, pct, netPnl) => ({ code, teamLabel, pct, netPnl, pctBase: 'buyIn', grossBought: 1, breakdown: [] });
const team = (label, members, pct, netPnl) => ({ label, members, pct, netPnl, pctBase: 'buyIn', buyIn: 50000, amountSpent: 1, realized: 0, divs: 0, unrealized: netPnl });
// At each date the team HH+HS (two members) leads the solo HF; at the
// individual level HF beats both of them, so lanes per person would disagree.
const at = (k) => ({
  ranks: [row('HF', 'HF', 2 * k, 400 * k), row('HH', 'HH+HS', k, 300 * k), row('HS', 'HH+HS', k, 300 * k)],
  teams: [team('HH+HS', ['HH', 'HS'], 4 * k, 600 * k), team('HF', ['HF'], 2 * k, 400 * k)],
});

function build(competition = COMP, now = NOW, mutate = (x) => x) {
  const w = baseWindow({
    Ledger: { splitForSecurity: () => [], INVESTOR_COLORS: { HF: '#222' }, classify: () => 'OTHER', isRealizingSell: () => false, amountNok: () => 0 },
    Portfolio: { canonicalName: (s) => s },
    CompetitionEngine: { scoreCompetition: (s, c) => at(c.end_date === '2024-03-01' ? 1 : 0.5) },
  });
  vm.createContext(w);
  load(w, 'format.js', 'copy.js', 'presentation-builder.js');
  const scored = mutate(at(1));
  const out = w.PresentationBuilder.buildPresentation(STORE,
    { competition, participants: PARTS, snapshotUsed: null, ...scored }, now);
  return { w, slides: out.slides, by: (t) => out.slides.find((s) => s.type === t) };
}

test('Leader card, race winner and standings winner are the same team, on % of budget', () => {
  const { by } = build();
  const lead = by('summary').cards.find((c) => c.label === 'Leader');
  assert.equal(lead.value, 'HH+HS');
  assert.match(lead.sub, /\+4,0% of budget/);
  assert.equal(by('standings').teams[0].label, 'HH+HS');
  assert.equal(by('race').lanes[0].code, 'HH+HS');
});

test('lanes and curve lines are per team when any team has more than one member, with the individual P/L as a second line', () => {
  const { by } = build();
  assert.deepEqual(by('race').lanes.map((l) => l.code), ['HH+HS', 'HF']);
  assert.deepEqual(by('curve').series.map((s) => s.name), ['HH+HS', 'HF']);
  assert.deepEqual(by('early').ranks.map((r) => r.code), ['HH+HS', 'HF']);
  assert.match(by('race').lanes[0].name, /HH 300 kr.*HS 300 kr/);
  const last = by('curve').series[0].points.at(-1);
  assert.equal(last.y, by('standings').teams[0].pct, 'curve ends on the standings number');
  const lane = by('race').lanes[0];
  assert.ok(Math.abs(lane.positions.at(-1) * 100 - last.y) < 1e-9, 'race ends on it too');
});

test('a solo-only competition keeps one lane per person', () => {
  const solo = { ...at(1), teams: at(1).teams.map((t) => ({ ...t, members: [t.members[0]] })) };
  const w2 = baseWindow({
    Ledger: { splitForSecurity: () => [], INVESTOR_COLORS: {}, classify: () => 'OTHER', isRealizingSell: () => false, amountNok: () => 0 },
    Portfolio: { canonicalName: (s) => s },
    CompetitionEngine: { scoreCompetition: () => solo },
  });
  vm.createContext(w2);
  load(w2, 'format.js', 'copy.js', 'presentation-builder.js');
  const out = w2.PresentationBuilder.buildPresentation(STORE, { competition: COMP, participants: PARTS, ...solo }, NOW);
  assert.deepEqual(out.slides.find((s) => s.type === 'race').lanes.map((l) => l.code), ['HF', 'HH', 'HS']);
});

test('a live competition says "so far": no "wins it", no future finish date, no vintage line', () => {
  const live = build({ ...COMP, end_date: '2024-09-30' });
  const text = JSON.stringify(live.slides);
  assert.equal(live.by('race').live, true);
  assert.match(live.by('summary').cards[0].label, /so far/i);
  assert.match(live.by('verdict').teaser, /so far/);
  assert.doesNotMatch(live.by('verdict').teaser, /takes the win|vintage/i);
  assert.doesNotMatch(text, /2024-09-30/);
  assert.equal(live.by('race').asOf, '2024-03-01', 'as of the last price date');
  assert.equal(build().by('race').live, false);
});

test('early, curve, race and club % carry the basis from one Fmt.pctBasisLabel', () => {
  const { w, by } = build();
  assert.equal(w.Fmt.pctBasisLabel('buyIn'), 'of budget');
  assert.equal(w.Fmt.pctBasisLabel('invested'), 'of invested');
  for (const t of ['early', 'curve', 'race']) assert.equal(by(t).basis, 'of budget', t);
  assert.equal(by('company').basis, 'of total budget', 'the club figure says it is on the total');
});

test('verdict wording is calibrated for % of budget; runner-up at +0.5% reads sensibly', () => {
  const { w } = build();
  const v = (p, b = 'of budget') => w.Copy.verdictFromReturn('X', p, b);
  assert.match(v(4.3), /\+4,3% of budget/);
  assert.doesNotMatch(v(4.3), /flat/);
  assert.match(v(0.5), /flat/);
  assert.match(v(12), /Take a bow/);
  assert.match(v(-6), /−6,0% of budget/);
  assert.match(v(4.3, 'of invested'), /flat/, 'the old bands still apply to % of invested');
});

test('verdict line thresholds on % of budget: vintage above +10, better luck below -3', () => {
  assert.doesNotMatch(build().by('verdict').teaser, /vintage|luck/i, '+4.0 / +2.0 is neither');
  const big = build(COMP, NOW, (x) => ({ ...x, teams: [{ ...x.teams[0], pct: 12 }, { ...x.teams[1], pct: -6 }] }));
  assert.match(big.by('verdict').teaser, /vintage.*luck/i);
  const minus4 = build(COMP, NOW, (x) => ({ ...x, teams: [x.teams[0], { ...x.teams[1], pct: -4 }] }));
  assert.match(minus4.by('verdict').teaser, /luck/i, '-4% is below the -3% band');
});

test('the summary card is "Biggest gain (kr)"', () => {
  const { by } = build();
  assert.ok(by('summary').cards.some((c) => c.label === 'Biggest gain (kr)'));
  assert.ok(!by('summary').cards.some((c) => c.label === 'Best single pick'));
});

test('curve y axis: no duplicate tick labels when the range is under 10 (one decimal)', () => {
  const texts = [];
  const el = () => ({ style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, appendChild() {}, addEventListener() {},
    set textContent(v) { if (this.attrs['text-anchor'] === 'start') texts.push(v); } });
  const w = baseWindow({});
  w.document.createElementNS = el;
  w.document.createElement = el;
  vm.createContext(w);
  load(w, 'format.js', 'charts.js');
  const pts = [0, 0.4, 1.2, 2.9, 4.3].map((y, i) => ({ date: `2024-01-0${i + 1}`, y }));
  w.Charts.multiLine({ series: [{ name: 'A', color: '#fff', points: pts }], width: 960, height: 360 });
  const ticks = texts.filter((t) => /^[-\u2212]?\d/.test(t));
  assert.ok(ticks.length >= 5, `got ${ticks}`);
  assert.equal(new Set(ticks).size, ticks.length, `duplicate ticks: ${ticks}`);
});
