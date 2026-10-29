const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const { baseWindow, load } = require('./harness');

// C2: the bank vouchers of one year, calculated from DNB_raw (the "Bank YY" tab).
// Made-up names and amounts only.
const w = baseWindow({});
vm.createContext(w);
load(w, 'parsers.js', 'bank-rules.js', 'books.js');
const { Books, BankRules } = w;
const ALIASES = BankRules.buildAliases([{ code: 'AT', alias: 'Alva Testsen' }, { code: 'BQ', alias: 'Bjarne Quist' }]);
const Y = 2031;
const row = (date, type, text, o = {}) => ({ year: Number(date.slice(0, 4)), date, type, text, ut: null, inn: null, ...o });
const ROWS = [
  row(`${Y}-03-05`, 'Giro', 'Til Nordent konto', { ut: 5000 }),        // typo'd Nordnet: D2
  row(`${Y}-01-10`, 'Giro', 'Alva Testsen', { inn: 1500 }),             // member: D1
  row(`${Y}-01-10`, 'Giro', 'Bjarne Quist', { inn: 1500 }),             // same day, same amount
  row(`${Y}-02-01`, 'Omkostninger', 'Gebyr', { ut: 20 }),               // fee: D3
  row(`${Y}-06-01`, 'Varekjøp', 'LEI registry', { ut: 900 }),           // other out: needs a decision
  row(`${Y}-07-01`, 'Giro', 'Utenforstående person', { inn: 300 }),     // unknown payer: never booked to 2250
  row(`${Y - 1}-12-31`, 'Giro', 'Alva Testsen', { inn: 1 }),            // other year
];
const sum = (lines, f) => lines.reduce((a, l) => a + (l[f] || 0), 0);

test('every bank line is numbered BA1, BA2, ... in bank-date order (open ones too) and every voucher balances', () => {
  const r = Books.bankYear(ROWS, ALIASES, Books.parseInputs([]), Y);
  assert.strictEqual(r.vouchers.map((v) => v.bilagsnr).join(), 'BA1,BA2,BA3,BA4');
  assert.strictEqual(r.open.map((o) => o.bilagsnr).join(), 'BA5,BA6', 'open lines keep their place in the numbering');
  const decided = Books.bankYear(ROWS, ALIASES, Books.parseInputs([['DECIDE', `${Y}-06-01`, 900, 7798]]), Y);
  assert.strictEqual(decided.vouchers.find((v) => v.date === `${Y}-06-01`).bilagsnr, 'BA5', 'a decision does not renumber');
  assert.strictEqual(r.vouchers.map((v) => v.date).join(), `${Y}-01-10,${Y}-01-10,${Y}-02-01,${Y}-03-05`);
  for (const v of r.vouchers) assert.ok(Math.abs(sum(v.lines, 'debet') - sum(v.lines, 'kredit')) < 0.005, v.bilagsnr);
  const nordnet = r.vouchers.find((v) => v.date === `${Y}-03-05`);
  assert.strictEqual(nordnet.lines.find((l) => l.debet).account, 1921, 'a typo still goes to Nordnet');
});

test('the lines the rules cannot decide are listed exactly, each with a DECIDE row to paste', () => {
  const r = Books.bankYear(ROWS, ALIASES, Books.parseInputs([]), Y);
  assert.strictEqual(r.open.map((o) => o.date).join(), `${Y}-06-01,${Y}-07-01`);
  const unknown = r.open.find((o) => o.date === `${Y}-07-01`);
  assert.strictEqual(unknown.reason, 'unknownPayer');
  assert.ok(!r.vouchers.some((v) => v.lines.some((l) => l.account === 2250 && v.date === `${Y}-07-01`)), 'an unknown payer is never booked to 2250');
  assert.strictEqual(r.open[0].paste.join('\t'), `DECIDE\t${Y}-06-01\t900\t8179\t\tLEI registry`);
});

test('a DECIDE row books an open line, the unused ones are reported', () => {
  const inputs = Books.parseInputs([
    ['DECIDE', `${Y}-06-01`, 900, 7798, '', 'LEI fee'],
    ['DECIDE', `${Y}-09-09`, 42, 7798, '', 'no such line'],
  ]);
  const r = Books.bankYear(ROWS, ALIASES, inputs, Y);
  const v = r.vouchers.find((x) => x.date === `${Y}-06-01`);
  assert.strictEqual(v.source, 'manual');
  assert.strictEqual(v.lines.find((l) => l.debet).account, 7798);
  assert.strictEqual(v.lines.find((l) => l.kredit).account, 1920);
  assert.strictEqual(r.open.length, 1);
  assert.strictEqual(r.unusedDecisions.length, 1);
  assert.strictEqual(r.unusedDecisions[0].amount, 42);
});

test('a DECIDE row overrides a rule, for an incoming line too', () => {
  const inputs = Books.parseInputs([['DECIDE', `${Y}-01-10`, 1500, 2020, '', 'loan, not equity']]);
  const r = Books.bankYear(ROWS, ALIASES, inputs, Y);
  const manual = r.vouchers.filter((v) => v.source === 'manual');
  assert.strictEqual(manual.length, 1, 'one of the two same-day lines');
  assert.strictEqual(manual[0].lines.find((l) => l.debet).account, 1920);
  assert.strictEqual(manual[0].lines.find((l) => l.kredit).account, 2020);
});
