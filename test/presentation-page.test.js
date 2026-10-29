const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { baseWindow, load, ROOT } = require('./harness');

// Runs the real deck page (pages/presentation-page.js) on a fake DOM, with the
// real Fmt, Copy and builder. The engine is a stub: the full window returns
// `main`, any shortened window (the first-30-days rescore) returns `early`,
// so the early slide cannot pass by copying the main standings.
const COMP = { id: 'C1', name: 'Spring', start_date: '2024-01-01', end_date: '2024-03-31' };
const PARTS = [{ investor_code: 'HH' }, { investor_code: 'HS' }];
const row = (code, pct) => ({ code, teamLabel: code, pct, netPnl: pct * 100, pctBase: 'buyIn', grossBought: 1, amountSpent: 1, breakdown: [] });
const team = (label, pct, extra = {}) => ({ label, members: [label], pct, netPnl: pct * 100, pctBase: 'buyIn', buyIn: 50000, amountSpent: 1, ...extra });
const contest = (a, b, extra = {}) => ({ ranks: [row('HH', a), row('HS', b)], teams: [team('HH', a, extra), team('HS', b, extra)] });

async function runDeck(main, early, kpis = [], extra = {}) {
  const root = { innerHTML: '', addEventListener() {} };
  const w = baseWindow({
    PORTAL_CONFIG: { OAUTH_CLIENT_ID: 'x' },
    Auth: { ensureToken: async () => {}, ensureEmail: async () => {} },
    Store: { hydrate: async () => ({ prices: { dates: ['2024-01-10', '2024-02-01', '2024-03-31'] }, transactions: [], kpis, members: [] }) },
    UI: { bindRowExpanders() {}, table: (cols, rows) => rows.map((r) => r.join('|')).join('\n') },
    CompetitionsData: { getCompetition: async () => ({ competition: COMP, participants: PARTS }) },
    CompetitionEngine: { scoreCompetition: (store, c) => ({ competition: c, ...(c.end_date === COMP.end_date ? main : early) }) },
    Ledger: { splitForSecurity: () => [], INVESTOR_COLORS: {}, classify: () => 'OTHER', isRealizingSell: () => false, amountNok: () => 0 },
    Portfolio: { canonicalName: (s) => s },
    HorseRaceAudio: { TRACK: {}, supported: () => false },
    location: { hash: '', search: '?competition=C1', href: '' },
    ...extra,
  });
  w.document.getElementById = (id) => (id === 'root' ? root : null);
  w.document.addEventListener = () => {};
  vm.createContext(w);
  load(w, 'format.js', 'copy.js', 'presentation-builder.js');
  const file = path.join(ROOT, 'pages', 'presentation-page.js');
  await vm.runInContext(fs.readFileSync(file, 'utf8'), w, { filename: file });
  // Walk the deck, keep the markup of each slide by its type.
  const html = {};
  for (let i = 0; i < 40; i++) {
    const m = /class="slide slide-(\w+)"/.exec(root.innerHTML);
    if (m) html[m[1]] = root.innerHTML;
    const at = /(\d+) \/ (\d+)/.exec(root.innerHTML);
    if (!at || at[1] === at[2]) break;
    w.__next();
  }
  return html;
}
const trophies = (h) => (h.match(/🏆|🥄|🥇|🥈|🥉/g) || []).length;

test('deck page: a tied deck shows no trophy, spoon or medals, and says no winner on every slide that would name one', async () => {
  const h = await runDeck(contest(2, 2), contest(4, 1));
  assert.equal(trophies(h.standings), 0);
  assert.match(h.standings, /No winner/);
  assert.doesNotMatch(h.standings, /Winner<|Last place/);
  assert.match(h.verdict, /no winner/i);
  assert.doesNotMatch(h.verdict, /takes the win/);
  assert.match(h.summary, /Leader<\/div>\s*<div class="value[^"]*">None</);
  // The first 30 days has its own result (not a tie), so it keeps its medals.
  assert.match(h.early, /🥇/);
});

test('deck page: the early slide drops its medals when only the early window is tied', async () => {
  const h = await runDeck(contest(3, 2), contest(1, 1));
  assert.equal(trophies(h.early), 0);
  assert.match(h.standings, /🏆/);
  assert.match(h.verdict, /HH takes the win/);
  assert.match(h.summary, /value[^>]*">HH</);
});

test('deck page: a legacy deck with a team without a budget keeps the left-out note on the company slide', async () => {
  const main = { ranks: [row('HH', 5), row('HS', 2)], teams: [team('HH', 5), team('HS', 2, { buyIn: 0 })] };
  const h = await runDeck(main, main);
  assert.match(h.company, /1 team without a budget is left out of this figure/);
  assert.match(h.company, /of total budget/);
});

test('final standings show each team\'s trade count', async () => {
  const main = contest(4, 2);
  main.teams[0].trades = 1; main.teams[1].trades = 12;
  const h = await runDeck(main, contest(1, 1));
  assert.match(h.standings, /1 trade</);
  assert.match(h.standings, /12 trades/);
});

test('positions slide: P/E uses the decimal comma, EPS stays as the sheet wrote it', async () => {
  const main = contest(4, 2);
  main.ranks[0].breakdown = [
    { security: 'Acme', costSum: 100, marketValue: 120, unrealized: 20, realized: 0, divs: 0 },
    { security: 'Beta', costSum: 100, marketValue: 90, unrealized: -10, realized: 0, divs: 0 },
  ];
  const kpis = [
    { company: 'Acme', year: 2025, pe: 19.94, eps: '3.11 EUR' },
    { company: 'Beta', year: 2025, pe: 41, eps: null },
  ];
  const h = await runDeck(main, contest(1, 1), kpis);
  assert.match(h.positions, /19,9\|3\.11 EUR/);
  assert.match(h.positions, /41,0\|—/);
  assert.doesNotMatch(h.positions, /19\.9/);
});


test('KPI slides: what each team owns and earnings season, escaped, plus the note on positions', async () => {
  const deckKpis = () => ({
    owns: { best: ['HH'], teams: [
      { label: 'HH', covered: 2, picks: 3, earnings: 1200, per1000: 24, pe: 11.5 },
      { label: 'HS', covered: 0, picks: 1, earnings: null, per1000: null, pe: null },
    ] },
    season: [{ security: 'Alpha <b>', label: 'Q1 2024', profit: 120, vsPrevPct: 20, vsYearPct: -5 }],
    notes: new Map([['Alpha', 'Order book up <script>']]),
  });
  const main = contest(4, 2);
  main.ranks[0].breakdown = [{ security: 'Alpha', qty: 1, costSum: 1, marketValue: 1, unrealized: 0, realized: 0, divs: 0 }];
  const h = await runDeck(main, contest(1, 1), [], { Fundamentals: { deckKpis } });
  assert.match(h.owns, /Best value for the budget/);
  assert.match(h.owns, /per 1 000 kr/);
  assert.match(h.owns, /No KPI rows for these picks/);
  assert.match(h.owns, /winner is still decided by % of budget/);
  assert.match(h.season, /Alpha &lt;b&gt;/);
  assert.doesNotMatch(h.season, /<b>/);
  assert.match(h.positions, /Order book up &lt;script&gt;/);
});

test('KPI slides stay out of the deck without KPI figures', async () => {
  const deckKpis = () => ({ owns: null, season: [], notes: new Map() });
  const h = await runDeck(contest(4, 2), contest(1, 1), [], { Fundamentals: { deckKpis } });
  assert.strictEqual(h.owns, undefined);
  assert.strictEqual(h.season, undefined);
});
