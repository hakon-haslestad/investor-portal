const test = require('node:test');
const assert = require('node:assert');
const { context } = require('./harness');

// Fundamentals.deckKpis: the deck's "What each team owns" and "Earnings season"
// numbers, from the in-window picks and the KPI tab. Synthetic data only.
const w = context(['parsers.js'], { Portfolio: { canonicalName: (s) => s } });
const { load } = require('./harness');
load(w, 'fundamentals.js');
const { deckKpis } = w.Fundamentals;

const WIN = { start_date: '2026-01-01', end_date: '2026-06-30' };
const kpi = (company, period, eps, eat = null, note = null) => ({ company, period, currency: 'NOK', eps, eat, note });
const lot = (security, qty, endPrice) => ({ security, qty, endPrice, marketValue: qty * endPrice });
const team = (label, members, buyIn) => ({ label, members, buyIn });
const rank = (code, breakdown) => ({ code, breakdown });

test('what each team owns: yearly profit per 1 000 kr of budget and weighted P/E', () => {
  const kpis = [kpi('Alpha', '2025', '2,00 NOK'), kpi('Beta', '2025', '5,00 NOK')];
  const scored = {
    teams: [team('HH+HS', ['HH', 'HS'], 50000), team('JC', ['JC'], 50000)],
    ranks: [rank('HH', [lot('Alpha', 100, 20)]), rank('HS', [lot('Beta', 10, 100)]), rank('JC', [lot('Beta', 60, 100)])],
  };
  const d = deckKpis(kpis, scored, WIN);
  const hh = d.owns.teams.find((t) => t.label === 'HH+HS');
  assert.strictEqual(hh.earnings, 250, '100 x 2 + 10 x 5');
  assert.strictEqual(hh.per1000, 5, '250 / 50 000 x 1 000');
  assert.strictEqual(hh.pe, 3000 / 250, 'value of the covered picks / their earnings');
  assert.strictEqual(d.owns.best.join(), 'JC', 'JC: 60 x 5 = 300 -> 6 per 1 000 beats 5');
});

test('the best-value mention is shared on a tie and absent without earnings', () => {
  const kpis = [kpi('Alpha', '2025', '2,00 NOK')];
  const scored = {
    teams: [team('A', ['HH'], 10000), team('B', ['HS'], 10000)],
    ranks: [rank('HH', [lot('Alpha', 50, 10)]), rank('HS', [lot('Alpha', 50, 10)])],
  };
  assert.strictEqual(deckKpis(kpis, scored, WIN).owns.best.join(), 'A,B');
  const none = deckKpis([], scored, WIN);
  assert.strictEqual(none.owns, null, 'no KPI rows: no slide');
});

test('sold-out lots and picks without a KPI row do not count', () => {
  const kpis = [kpi('Alpha', '2025', '2,00 NOK')];
  const scored = { teams: [team('A', ['HH'], 10000)], ranks: [rank('HH', [lot('Alpha', 0, 10), lot('Gamma', 10, 10)])] };
  assert.strictEqual(deckKpis(kpis, scored, WIN).owns, null);
});

test('earnings season: a quarter that ended in the window, vs the previous quarter and a year earlier', () => {
  const kpis = [
    kpi('Alpha', 'Q1 2026', null, '120'), kpi('Alpha', 'Q4 2025', null, '100'), kpi('Alpha', 'Q1 2025', null, '80'),
    kpi('Beta', 'Q3 2026', null, '50'), // ended after the window
  ];
  const scored = { teams: [team('A', ['HH'], 10000)], ranks: [rank('HH', [lot('Alpha', 10, 10), lot('Beta', 10, 10)])] };
  const s = deckKpis(kpis, scored, WIN).season;
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].security, 'Alpha');
  assert.strictEqual(s[0].label, 'Q1 2026');
  assert.strictEqual(s[0].vsPrevPct, 20);
  assert.strictEqual(s[0].vsYearPct, 50);
});

test('earnings season is empty when nothing reported in the window; notes come from the latest row', () => {
  const kpis = [kpi('Alpha', 'Q3 2026', null, '50', 'old'), kpi('Alpha', '2025', '1,00 NOK', null, 'Strong order book <b>')];
  const scored = { teams: [team('A', ['HH'], 10000)], ranks: [rank('HH', [lot('Alpha', 10, 10)])] };
  const d = deckKpis(kpis, scored, WIN);
  assert.strictEqual(d.season.length, 0);
  assert.strictEqual(d.notes.get('Alpha'), 'old', 'Q3 2026 is the newest period');
});

test('the KPI tab parser skips a title row that holds both words in one cell', () => {
  const rows = [
    ['Offisielle nøkkeltall (fiktive data)'],
    ['Per selskap og periode'],
    ['Period', 'Selskap', 'Val.', 'EPS TTM'],
    ['2025', 'Alpha', 'NOK', '2,00 NOK'],
  ];
  const k = w.Parsers.parseKpis(rows);
  assert.strictEqual(k.length, 1);
  assert.strictEqual(k[0].company, 'Alpha');
  assert.strictEqual(k[0].period, '2025');
});
