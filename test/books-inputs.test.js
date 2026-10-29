const test = require('node:test');
const assert = require('node:assert');
const { context } = require('./harness');

// The "Accounting inputs" tab: what raw data cannot give the calculated books
// (opening balance, manual decisions, the accountant's year-end entries).
// Synthetic rows only.
const W = context(['parsers.js', 'books.js']);
const B = W.Books;

const ROWS = [
  ['Accounting inputs (example)'],
  ['Kind', 'A', 'B', 'C', 'D', 'Note'],
  ['IB', 1920, 1000],
  ['IB', 2250, -1000],
  ['DECIDE', '2031-03-01', 250, 7798, '', 'Annual fee'],
  ['SPLIT', 'Alpha ASA', 0.25],
  ['REALISE', 'Beta AS', 2031],
  ['ENTRY', 2031, 8300, 500, '', 'Tax'],
  ['ENTRY', 2031, 2500, '', 500, 'Tax'],
  [],
  ['# a comment row is ignored'],
];

test('every row kind is read; a title row, blank rows and comments are skipped', () => {
  const r = B.parseInputs(ROWS);
  assert.strictEqual(r.ib.get(1920), 1000);
  assert.strictEqual(r.ib.get(2250), -1000);
  assert.strictEqual(r.decide.length, 1);
  assert.strictEqual(r.decide[0].date, '2031-03-01');
  assert.strictEqual(r.decide[0].amount, 250);
  assert.strictEqual(r.decide[0].account, 7798);
  assert.strictEqual(r.split[0].security, 'Alpha ASA');
  assert.strictEqual(r.split[0].share, 0.25);
  assert.strictEqual(r.realise[0].year, 2031);
  assert.strictEqual(r.entries.length, 2);
  assert.strictEqual(r.problems.length, 0, JSON.stringify(r.problems));
});

test('invalid rows become problems with a reason, never silent', () => {
  const r = B.parseInputs([
    ['Kind', 'A', 'B', 'C', 'D', 'Note'],
    ['IB', 999, 10],                       // not an NS 4102 account
    ['DECIDE', 'not a date', 10, 7798],
    ['SPLIT', 'Alpha', 1.5],                // share outside 0-1
    ['ENTRY', 2031, 8300, 500, '', 'x'],    // year does not balance
    ['WHAT', 1, 2],                         // unknown kind
  ]);
  const why = r.problems.map((p) => p.reason).join(' | ');
  assert.match(why, /999 is not an account/);
  assert.match(why, /date/);
  assert.match(why, /share/);
  assert.match(why, /do not balance/);
  assert.match(why, /unknown kind "WHAT"/);
  assert.strictEqual(r.ib.size, 0, 'an invalid row is not used');
});

test('an empty or missing tab gives empty inputs and no problems', () => {
  for (const rows of [null, [], [['Kind', 'A']]]) {
    const r = B.parseInputs(rows);
    assert.strictEqual(r.ib.size, 0);
    assert.strictEqual(r.problems.length, 0);
  }
});

test('Norwegian number and date formats in the sheet are read', () => {
  const r = B.parseInputs([['IB', '1920', '1 000,50'], ['DECIDE', '01.03.2031', '-250', '7798']]);
  assert.strictEqual(r.ib.get(1920), 1000.5);
  assert.strictEqual(r.decide[0].date, '2031-03-01');
  assert.strictEqual(r.decide[0].amount, 250, 'amounts are magnitudes, like DNB Ut/Inn');
});
