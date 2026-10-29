const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const { baseWindow, load } = require('./harness');

// Real Fmt, Copy and builder; the engine is a stub that returns whatever
// standings a test hands it, so ties and empty contests can be pinned.
const NOW = new Date('2024-06-01T12:00:00Z');
const COMP = { id: 'C1', name: 'Spring', start_date: '2024-01-01', end_date: '2024-03-31' };
const PARTS = [{ investor_code: 'HH' }, { investor_code: 'HS' }];
const STORE = { prices: { dates: ['2024-01-10', '2024-02-01', '2024-03-31'] }, transactions: [], kpis: [], members: [] };
const row = (code, pct, extra = {}) => ({ code, teamLabel: code, pct, netPnl: pct * 100, pctBase: 'buyIn', grossBought: 1, amountSpent: 1, breakdown: [], ...extra });
const team = (label, pct, extra = {}) => ({ label, members: [label], pct, netPnl: pct * 100, pctBase: 'buyIn', buyIn: 50000, amountSpent: 1, ...extra });

function ctx(engineOut) {
  const w = baseWindow({
    Ledger: { splitForSecurity: () => [], INVESTOR_COLORS: {}, classify: () => 'OTHER', isRealizingSell: () => false, amountNok: () => 0 },
    Portfolio: { canonicalName: (s) => s },
    CompetitionEngine: { scoreCompetition: () => engineOut },
  });
  vm.createContext(w);
  load(w, 'format.js', 'copy.js', 'presentation-builder.js');
  return w;
}
const deck = (scored, store = STORE) => {
  const w = ctx(scored);
  const out = w.PresentationBuilder.buildPresentation(store, { competition: COMP, participants: PARTS, ...scored }, NOW);
  return (t) => out.slides.find((s) => s.type === t);
};
const contest = (a, b) => ({ ranks: [row('HH', a), row('HS', b)], teams: [team('HH', a), team('HS', b)] });

test('competitionOutcome: a full tie and an empty contest have no winner; a normal one does', () => {
  const { Fmt } = ctx(contest(1, 1));
  assert.equal(Fmt.competitionOutcome(contest(3, 3)).tie, true);
  assert.equal(Fmt.competitionOutcome(contest(0, 0)).noContest, true);
  assert.equal(Fmt.competitionOutcome(contest(3, 2)).noContest, false);
  assert.equal(Fmt.competitionOutcome({ ranks: [row('HH', 3)], teams: [team('HH', 3)] }).tie, false, 'one team cannot tie');
  const idle = { ranks: [row('HH', 0, { grossBought: 0 })], teams: [team('HH', 0)] };
  const o = Fmt.competitionOutcome(idle);
  assert.equal(o.noActivity, true);
  assert.equal(o.noContest, true);
  assert.equal(Fmt.isTie([{ pct: 2 }, { pct: 2 }, { pct: 2.5 }]), false);
});

test('club %: always on the sum of budgets; teams without a budget are left out and counted', () => {
  const { Fmt } = ctx(contest(1, 1));
  const all = Fmt.competitionOutcome({ ranks: [], teams: [team('A', 0, { netPnl: 5000 }), team('B', 0, { netPnl: -1000 })] }).club;
  assert.deepEqual({ pnl: all.pnl, base: all.base, pct: all.pct, pctBase: all.pctBase, leftOut: all.leftOut },
    { pnl: 4000, base: 100000, pct: 4, pctBase: 'buyIn', leftOut: 0 });
  assert.equal(all.basis, 'of total budget');

  const legacy = Fmt.competitionOutcome({ ranks: [], teams: [team('A', 0, { netPnl: 5000 }), team('B', 0, { netPnl: 9000, buyIn: 0 })] }).club;
  assert.equal(legacy.pnl, 5000);
  assert.equal(legacy.pct, 10);
  assert.equal(legacy.leftOut, 1);

  const none = Fmt.competitionOutcome({
    ranks: [row('HH', 0, { netPnl: 500, amountSpent: 10000 })],
    teams: [team('HH', 0, { buyIn: 0, netPnl: 500, amountSpent: 10000 })],
  }).club;
  assert.equal(none.pctBase, 'invested');
  assert.equal(none.pct, 5);
  assert.equal(none.basis, 'of net invested');
  assert.equal(none.leftOut, 0);
});

test('the deck company slide uses the shared club helper, with the legacy note', () => {
  const s = deck({ ranks: [row('HH', 0, { netPnl: 5000, grossBought: 9 })], teams: [team('A', 0, { netPnl: 5000 }), team('B', 0, { buyIn: 0, netPnl: 9000 })] })('company');
  assert.equal(s.pct, 10);
  assert.equal(s.basis, 'of total budget');
  assert.equal(s.leftOut, 1);
});

test('standings and early slides carry no winner on a full tie, and keep it on a normal contest', () => {
  const tied = deck(contest(2, 2));
  assert.equal(tied('standings').noContest, true);
  assert.ok(tied('standings').teams.every((t) => !t.podium));
  assert.ok(tied('standings').individual.every((r) => !r.podium));
  assert.equal(tied('early').noContest, true);

  const normal = deck(contest(3, 2));
  assert.equal(normal('standings').noContest, false);
  assert.equal(normal('standings').teams[0].podium, '🥇');
  assert.equal(normal('early').noContest, false);
});

test('no purchases: every slide is flagged noActivity and the standings and early slides have no winner', () => {
  const idle = { ranks: [row('HH', 0, { grossBought: 0 }), row('HS', 0, { grossBought: 0 })], teams: [team('HH', 0), team('HS', 0)] };
  const by = deck(idle);
  assert.equal(by('standings').noContest, true);
  assert.equal(by('early').noContest, true);
  assert.equal(by('company').noActivity, true);
  assert.equal(by('race').noActivity, true);
});

test('the first-30-days slide ends on the price date nearest day 30, within 20-60 days, and never past the end', () => {
  const at = (dates, end = COMP.end_date) => {
    const w = ctx(contest(1, 2));
    return w.PresentationBuilder.nearestSnapshotEnd({ prices: { dates } }, { ...COMP, end_date: end }, 30, 20, 60);
  };
  assert.equal(at(['2024-01-10', '2024-02-05', '2024-02-25']), '2024-02-05');
  assert.equal(at(['2024-01-10', '2024-04-30']), '2024-01-31', 'no price in the band: start + 30 days');
  assert.equal(at(['2024-01-10'], '2024-01-20'), '2024-01-20', 'clamped to the end date');
  assert.equal(at(['2024-02-20', '2024-03-05'], '2024-02-25'), '2024-02-20', 'band is clamped to the end date too');
});

test('verdict teaser and Leader card name no winner on a tie or a no-purchase deck, from the shared Fmt text', () => {
  const { Fmt } = ctx(contest(1, 1));
  const tied = deck(contest(2, 2));
  assert.equal(tied('verdict').teaser, Fmt.noWinnerText(Fmt.competitionOutcome(contest(2, 2))));
  assert.match(tied('verdict').teaser, /no winner/i);
  assert.doesNotMatch(tied('verdict').teaser, /takes the win|leads at/);
  assert.deepEqual(tied('verdict').runnerUps, []);
  const lead = tied('summary').cards[0];
  assert.equal(lead.label, 'Leader');
  assert.equal(lead.value, 'None');
  assert.equal(lead.sub, 'All teams are level');

  const idle = { ranks: [row('HH', 0, { grossBought: 0 }), row('HS', 0, { grossBought: 0 })], teams: [team('HH', 0), team('HS', 0)] };
  assert.equal(deck(idle)('verdict').teaser, 'No purchases in the window yet.');
  assert.equal(deck(idle)('summary').cards[0].value, 'None');

  const normal = deck(contest(3, 2));
  assert.match(normal('verdict').teaser, /HH takes the win/);
  assert.equal(normal('verdict').runnerUps.length, 2);
  assert.equal(normal('summary').cards[0].value, 'HH');
});
