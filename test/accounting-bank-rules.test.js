const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const { baseWindow, load } = require('./harness');

// The bank rule engine on synthetic rows. Made-up names only; amounts are
// invented per test and the engine must never depend on them.
const w = baseWindow({});
vm.createContext(w);
load(w, 'bank-rules.js');
const R = w.BankRules;
// Objects built inside the vm context are not reference-equal to ours.
const eq = (a, b) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), b);

const ALIASES = R.buildAliases([
  { code: 'AT', alias: 'Alva Testsen' },
  { code: 'BQ', alias: 'Bjarne Quist' },
  { code: 'CM', alias: 'Cora Mockeby' },
]);
const row = (type, text, o = {}) => ({ date: '2019-03-01', type, text, ut: null, inn: null, ...o });
const sum = (b, side) => b.lines.filter((l) => l.side === side).reduce((s, l) => s + l.amount, 0);

test('normalize lowercases, strips diacritics and punctuation', () => {
  assert.strictEqual(R.normalize('  Ålesund-Bjørn, A/S 12 '), 'alesund bjorn a s');
});

test('matchMember: exact, fuzzy (one typo), none', () => {
  eq(R.matchMember('Giro fra TESTSEN Alva', ALIASES), { code: 'AT', kind: 'exact' });
  eq(R.matchMember('Innbetaling Alva Testsn', ALIASES), { code: 'AT', kind: 'fuzzy' });
  assert.strictEqual(R.matchMember('Giro fra Dag Utenfor', ALIASES), null);
  assert.strictEqual(R.matchMember('', ALIASES), null);
  // short tokens are never fuzzy
  const short = R.buildAliases([{ code: 'XX', alias: 'Ola Li' }]);
  assert.strictEqual(R.matchMember('Ola Lo', short), null);
});

test('aliasesFromMembers uses display names', () => {
  const a = R.aliasesFromMembers([{ investorCode: 'AT', displayName: 'Alva Testsen' }, { investorCode: 'ZZ', displayName: '' }]);
  assert.strictEqual(R.matchMember('x alva testsen y', a).code, 'AT');
  assert.strictEqual(a.length, 1);
});

test('isNordnet tolerates typos but not other words', () => {
  assert.ok(R.isNordnet('Overf til NORDNET AB'));
  assert.ok(R.isNordnet('Nordnt innskudd'));
  assert.ok(R.isNordnet('Nordnett'));
  assert.ok(!R.isNordnet('Nordic Capital'));
  assert.ok(!R.isNordnet('Strøm og nett'));
});

test('one row per rule produces the rule table lines, amounts from the row', () => {
  const rows = [
    row('Giro', 'Alva Testsen', { inn: 1234.5 }),
    row('Overføring innland', 'Bjarne Quist', { inn: 77 }),
    row('Giro', 'Overf Nordnet', { ut: 4321 }),
    row('Omkostninger', 'Månedsgebyr', { ut: 12.345 }),
    row('Giro', 'Dag Utenfor', { ut: 90 }),
    row('Gebyr', 'Ukjent inn', { inn: 55 }),
  ];
  const out = rows.map((r) => R.classify(r, ALIASES));
  eq(out.map((o) => o.rule), ['D1', 'D1', 'D2', 'D3', 'D4', 'D5']);
  eq(out[0].lines, [{ side: 'D', account: 1920, amount: 1234.5 }, { side: 'C', account: 2250, amount: 1234.5 }]);
  assert.strictEqual(out[0].member, 'AT');
  assert.strictEqual(out[0].mode, 'A');
  eq(out[2].lines.map((l) => [l.side, l.account]), [['D', 1921], ['C', 1920]]);
  eq(out[3].lines.map((l) => [l.side, l.account, l.amount]), [['D', 7700, 12.35], ['C', 1920, 12.35]]);
  assert.strictEqual(out[3].feeToConfirm, true);
  assert.strictEqual(out[2].feeToConfirm, false);
  eq([out[4].mode, out[4].suggest, out[4].lines.length], ['H', [8179, 7798, 2400], 0]);
  eq([out[5].mode, out[5].suggest], ['H', [8050, 2000, 2020]]);
});

test('a typo in the Nordnet text still goes to 1921', () => {
  const o = R.classify(row('Giro', 'Til Nordnt AB', { ut: 500 }), ALIASES);
  assert.strictEqual(o.rule, 'D2');
});

test('a payer who is not a member is flagged and never booked to 2250', () => {
  const o = R.classify(row('Giro', 'Dag Utenfor', { inn: 1500 }), ALIASES);
  assert.strictEqual(o.rule, 'D1');
  assert.strictEqual(o.mode, 'H');
  assert.strictEqual(o.reason, 'unknownPayer');
  eq(o.lines, []);
  const none = R.classify(row('Giro', 'Alva Testsen', { inn: 1500 }), []);
  assert.strictEqual(none.reason, 'unknownPayer');
});

test('a payer with one typo is booked as R and flagged for review', () => {
  const { bilag, unclassified } = R.run([row('Giro', 'Alva Testsn', { inn: 1500 })], ALIASES);
  assert.strictEqual(unclassified.length, 0);
  assert.strictEqual(bilag[0].mode, 'R');
  assert.strictEqual(bilag[0].member, 'AT');
  assert.ok(bilag[0].flags.includes('review'));
});

test('a row with no amount is unclassified, not booked', () => {
  const { bilag, unclassified } = R.run([row('Giro', 'Alva Testsen'), row('Giro', 'Alva Testsen', { inn: 0, ut: 0 })], ALIASES);
  assert.strictEqual(bilag.length, 0);
  eq(unclassified.map((u) => u.reason), ['noAmount', 'noAmount']);
});

test('the unclassified list equals the planted rows exactly and every bilag balances', () => {
  const planted = [
    row('Giro', 'Dag Utenfor', { inn: 100.1, date: '2019-02-02' }),
    row('Giro', 'Til Pia Pettersen', { ut: 250, date: '2019-04-04' }),
    row('Betaling', 'Refusjon', { inn: 31.37, date: '2019-05-05' }),
    row('Giro', '', { date: '2019-06-06' }),
  ];
  const booked = [
    row('Giro', 'Alva Testsen', { inn: 1500.10 }),
    row('Giro', 'Bjarne Quist', { inn: 1500.10 }),
    row('Overføring innland', 'Cora Mockeby', { inn: 0.1 + 0.2 }),
    row('Giro', 'Nordnet', { ut: 3333.33 }),
    row('Omkostninger', 'Gebyr', { ut: 49.95 }),
    row('Omkostninger', 'Gebyr', { ut: 49.95 }),
  ];
  const mixed = [planted[0], booked[0], planted[1], booked[1], booked[2], planted[2], booked[3], booked[4], planted[3], booked[5]];
  const out = R.run(mixed, ALIASES);
  eq(out.unclassified.map((u) => u.row), planted);
  assert.strictEqual(out.bilag.length, booked.length);
  for (const b of out.bilag) {
    assert.strictEqual(Math.round(sum(b, 'D') * 100), Math.round(sum(b, 'C') * 100));
    assert.ok(b.lines.every((l) => Math.round(l.amount * 100) === l.amount * 100 || Math.abs(l.amount * 100 - Math.round(l.amount * 100)) < 1e-6));
  }
  assert.strictEqual(out.bilag[2].lines[0].amount, 0.3);
});

test('the engine has no amount in its rules: any amount works, rule table holds accounts only', () => {
  for (const amt of [0.01, 1, 1350, 1500, 999999.99]) {
    assert.strictEqual(R.classify(row('Giro', 'Alva Testsen', { inn: amt }), ALIASES).lines[0].amount, amt);
  }
  eq(R.RULES.dnb.map((r) => r.id), ['D1', 'D2', 'D3', 'D4', 'D5']);
  const nums = JSON.stringify(R.RULES.dnb).match(/\d+/g).map(Number);
  assert.ok(nums.every((n) => n >= 1 && n <= 8179), 'only account numbers and rule ids');
  assert.strictEqual(R.RULES.dnb[2].lines[0][1], 7700);
});

test('parseAliases finds its header and skips blanks', () => {
  const a = R.parseAliases([['note'], ['Code', 'Alias'], ['AT', 'Alva Testsen'], ['', ''], ['BQ', '']]);
  eq(a, [{ code: 'AT', alias: 'Alva Testsen' }]);
  eq(R.parseAliases([]), []);
});

// ─── compareWithBooks ─────────────────────────────────────────────────────
const hbLine = (bilagsnr, date, kontonr, debet, kredit) => ({ bilagsnr, date, kontonr, debet, kredit });
const bilagHb = (nr, date, amt, counter, dir = 'in') => (dir === 'in'
  ? [hbLine(nr, date, 1920, amt, null), hbLine(nr, date, counter, null, amt)]
  : [hbLine(nr, date, counter, amt, null), hbLine(nr, date, 1920, null, amt)]);

test('compare: same account counts as same; differences are grouped by cause', () => {
  const rows = [
    row('Giro', 'Alva Testsen', { inn: 1000, date: '2019-01-10' }),
    row('Giro', 'Dag Utenfor', { inn: 700, date: '2019-01-11' }),
    row('Omkostninger', 'Gebyr', { ut: 20, date: '2019-01-12' }),
    row('Giro', 'Til Pia Pettersen', { ut: 300, date: '2019-01-13' }),
    row('Giro', 'Overf Nordnet', { ut: 5000, date: '2019-01-14' }),
  ];
  const hb = [
    ...bilagHb('B1', '2019-01-10', 1000, 2250),
    ...bilagHb('B2', '2019-01-11', 700, 2250),
    ...bilagHb('B3', '2019-01-12', 20, 8179, 'out'),
    ...bilagHb('B4', '2019-01-13', 300, 7798, 'out'),
    ...bilagHb('B5', '2019-01-14', 5000, 1921, 'out'),
    ...bilagHb('B6', '2019-02-01', 42, 2250),
  ];
  const c = R.compareWithBooks(rows, hb, ALIASES);
  eq([c.total, c.same, c.noLedger], [5, 2, false]);
  eq(c.groups.unknownPayer.map((i) => [i.date, i.amount, i.ours, i.books]), [['2019-01-11', 700, 'none', '2250']]);
  eq(c.groups.fee.map((i) => [i.ours, i.books]), [['7700', '8179']]);
  eq(c.groups.other.map((i) => [i.ours, i.books]), [['8179, 7798, 2400', '7798']]);
  eq(c.booksOnly.map((b) => b.bilagsnr), ['B6']);
});

test('compare: same-day equal amounts pair one-to-one with the right bilag', () => {
  const rows = [
    row('Giro', 'Alva Testsen', { inn: 1500, date: '2019-03-03' }),
    row('Giro', 'Dag Utenfor', { inn: 1500, date: '2019-03-03' }),
    row('Giro', 'Bjarne Quist', { inn: 1500, date: '2019-03-03' }),
  ];
  // books: two to 2250, one to an expense account, listed with the odd one first
  const hb = [...bilagHb('B1', '2019-03-03', 1500, 8050), ...bilagHb('B2', '2019-03-03', 1500, 2250), ...bilagHb('B3', '2019-03-03', 1500, 2250)];
  const c = R.compareWithBooks(rows, hb, ALIASES);
  assert.strictEqual(c.same, 2);
  eq(c.groups.unknownPayer.map((i) => i.books), ['8050']);
  assert.strictEqual(c.booksOnly.length, 0);
});

test('compare: a bank line with no bilag is "other" with books none; money direction must agree', () => {
  const rows = [row('Giro', 'Alva Testsen', { inn: 1000, date: '2019-01-10' })];
  const out = R.compareWithBooks(rows, bilagHb('B1', '2019-01-10', 1000, 2250, 'out'), ALIASES);
  assert.strictEqual(out.same, 0);
  assert.strictEqual(out.groups.other[0].books, 'none');
  assert.strictEqual(out.booksOnly.length, 1);
});

test('compare: matches on cents, and an empty ledger is flagged', () => {
  const rows = [row('Giro', 'Alva Testsen', { inn: 10.005, date: '2019-01-10' })];
  assert.strictEqual(R.compareWithBooks(rows, bilagHb('B1', '2019-01-10', 10.01, 2250), ALIASES).same, 1);
  const none = R.compareWithBooks(rows, [], ALIASES);
  eq([none.noLedger, none.total, none.same], [true, 1, 0]);
});

test('a transfer read from the bank export with a negative Ut is money out to Nordnet (D2)', () => {
  const pw = baseWindow({});
  vm.createContext(pw);
  load(pw, 'parsers.js', 'format.js', 'accounting.js');
  const [parsed] = pw.Accounting.parseDnbRaw([
    ['Year', 'Bokført dato', 'Transaksjonstype', 'Forklarende tekst', 'Ut', 'Inn'],
    [2019, '2019-03-01', 'Giro', 'Til Nordnet', -300, ''],
  ]);
  const c = R.classify({ ...parsed }, ALIASES);
  assert.strictEqual(c.dir, 'out');
  assert.strictEqual(c.rule, 'D2');
});

test('compare: a ledger that writes credits as negative numbers still matches (as the real HB does)', () => {
  const rows = [
    row('Giro', 'Overf Nordnet', { ut: 5000, date: '2019-01-14' }),
    row('Omkostninger', 'Gebyr', { ut: 20, date: '2019-01-15' }),
  ];
  const neg = (nr, date, amt, counter) => [hbLine(nr, date, counter, amt, null), hbLine(nr, date, 1920, null, -amt)];
  const hb = [...neg('B1', '2019-01-14', 5000, 1921), ...neg('B2', '2019-01-15', 20, 7700)];
  const c = R.compareWithBooks(rows, hb, ALIASES);
  eq([c.total, c.same], [2, 2]);
});
