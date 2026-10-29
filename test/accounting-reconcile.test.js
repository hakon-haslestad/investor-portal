const test = require('node:test');
const assert = require('node:assert');
const { context } = require('./harness');

// Synthetic figures only. The year is a plain number passed in, no real clock.
const A = context(['parsers.js', 'format.js', 'accounting.js']).Accounting;
const Y = 2031;
const sb = (mv1920, mv1921, mv2250) => [
  { kontonr: 1920, ib: 100, ub: 100 + mv1920 },
  { kontonr: 1921, ib: 0, ub: mv1921 },
  { kontonr: 2250, ib: -50, ub: -50 + mv2250 },
];
const dnb = [
  { year: Y, date: `${Y}-03-01`, type: 'x', text: 'Giro to NORDNET broker', ut: 400, inn: null },
  { year: Y, date: `${Y}-12-20`, type: 'x', text: 'Member payment', ut: null, inn: 1000 },
  { year: 2030, date: '2030-05-01', type: 'x', text: 'other year', ut: 7, inn: 9 },
];
const nordnet = [
  { year: Y, date: `${Y}-12-19`, type: 'INNSKUDD', amount: 400 },
  { year: Y, date: `${Y}-06-01`, type: 'KJØPT', amount: -150 },
  { year: 2030, date: '2030-06-01', type: 'INNSKUDD', amount: 99 },
];
const good = { sb: sb(600, 250, -1000), dnb, nordnet, year: Y, wipTabName: 'SB, 31', dnbTab: 'DNB_raw', nordnetTab: 'Nordnet_raw' };
const byId = (r, id) => r.rows.find((x) => x.id === id);

test('everything equal: the four number rows pass, year filter ignores other years', () => {
  const r = A.reconcile(good);
  for (const id of ['dnb-1920', 'nordnet-1921', 'dnb-2250', 'transfers', 'dates', 'wip-tab']) assert.strictEqual(byId(r, id).status, 'pass', id);
});

test('a planted mismatch is Check and shows the difference', () => {
  const r = A.reconcile({ ...good, sb: sb(650, 250, -1000) });
  const row = byId(r, 'dnb-1920');
  assert.strictEqual(row.status, 'check');
  assert.match(row.detail, /Difference 50 kr/);
  assert.strictEqual(byId(r, 'nordnet-1921').status, 'pass');
});

test('under 1 kr counts as equal, 1 kr does not', () => {
  assert.strictEqual(byId(A.reconcile({ ...good, sb: sb(600.5, 250, -1000) }), 'dnb-1920').status, 'pass');
  assert.strictEqual(byId(A.reconcile({ ...good, sb: sb(601, 250, -1000) }), 'dnb-1920').status, 'check');
});

test('credit account 2250 expects the movement to be minus the incoming total', () => {
  const r = A.reconcile({ ...good, sb: sb(600, 250, 1000) });
  assert.strictEqual(byId(r, 'dnb-2250').status, 'check');
  assert.match(byId(r, 'dnb-2250').detail, /Difference 2\D000 kr/);
});

test('transfers: Nordnet deposits differing from DNB giro out is Check', () => {
  const r = A.reconcile({ ...good, nordnet: [{ year: Y, date: `${Y}-12-19`, type: 'innskudd', amount: 300 }] });
  assert.strictEqual(byId(r, 'transfers').status, 'check');
  assert.match(byId(r, 'transfers').detail, /Difference \D100 kr/);
});

test('missing sources are To do with a reason, never an error', () => {
  const noTab = A.reconcile({ ...good, dnbTab: null });
  assert.strictEqual(byId(noTab, 'dnb-1920').status, 'todo');
  assert.match(byId(noTab, 'dnb-1920').detail, /No DNB rows/);
  assert.strictEqual(byId(noTab, 'transfers').status, 'todo');
  const noRows = A.reconcile({ ...good, nordnet: [{ year: 2030, date: '2030-01-01', type: 'x', amount: 1 }] });
  assert.strictEqual(byId(noRows, 'nordnet-1921').status, 'todo');
  assert.strictEqual(byId(noRows, 'dates').status, 'todo');
  const noAcct = A.reconcile({ ...good, sb: [{ kontonr: 1920, ib: 0, ub: 600 }] });
  assert.match(byId(noAcct, 'nordnet-1921').detail, /Account 1921 not found/);
  assert.strictEqual(byId(noAcct, 'dnb-1920').status, 'pass');
  const noAmounts = A.reconcile({ ...good, nordnet: [{ year: Y, date: `${Y}-12-30`, type: 'x', amount: null }] });
  assert.match(byId(noAmounts, 'nordnet-1921').detail, /No amounts/);
  assert.doesNotThrow(() => A.reconcile({ year: Y }));
  assert.strictEqual(A.reconcile({ year: Y }).counts.pass, 1); // only the tab-name row can pass with nothing loaded
});

test('dates: Pass in the last 14 days, Check with the dates when data ends earlier', () => {
  const early = A.reconcile({ ...good, nordnet: [{ year: Y, date: `${Y}-12-17`, type: 'INNSKUDD', amount: 400 }, { year: Y, type: 'KJØPT', amount: -150 }] });
  assert.strictEqual(byId(early, 'dates').status, 'check');
  assert.match(byId(early, 'dates').detail, new RegExp(`DNB ${Y}-12-20, Nordnet ${Y}-12-17`));
  assert.strictEqual(byId(A.reconcile(good), 'dates').status, 'pass');
});

test('a stale WIP tab name is Check with the expected name', () => {
  const r = byId(A.reconcile({ ...good, wipTabName: 'SB, 30 (2)' }), 'wip-tab');
  assert.strictEqual(r.status, 'check');
  assert.match(r.detail, /"SB, 31"/);
});

test('year-end entries are always To do, "Not booked yet", never 0', () => {
  for (const input of [good, { year: Y }]) {
    const row = byId(A.reconcile(input), 'year-end');
    assert.strictEqual(row.status, 'todo');
    assert.match(row.detail, /Not booked yet/);
    assert.doesNotMatch(row.detail, /\b0\b/);
  }
});

test('counts and summary text add up to the rows', () => {
  const r = A.reconcile({ ...good, sb: sb(650, 250, -1000), dnbTab: 'DNB_raw' });
  assert.deepStrictEqual({ ...r.counts }, { pass: 5, check: 1, todo: 1 });
  assert.strictEqual(r.text, '5 pass, 1 to check, 1 to do');
  assert.strictEqual(r.rows.length, 7);
});

test('equityForYear: credit balance of 2000-2099 shown positive, null without such accounts', () => {
  const rows = [{ kontonr: 1920, ub: 5 }, { kontonr: 2000, ub: -500 }, { kontonr: 2050, ub: -200 }, { kontonr: 2099, ub: 100 }, { kontonr: 2100, ub: -9 }];
  assert.deepStrictEqual({ ...A.equityForYear(rows) }, { equity: 600, accounts: 3 });
  assert.strictEqual(A.equityForYear([{ kontonr: 1920, ub: 5 }, { kontonr: 2250, ub: -1 }]), null);
  assert.strictEqual(A.equityForYear([]), null);
  assert.strictEqual(A.equityForYear([{ kontonr: 2000, ub: 0 }]).equity, 0, 'zero is not negative zero');
});

test('resultBridge: realized gains from Nordnet plus the difference, null without Nordnet rows', () => {
  const b = A.resultBridge(600, [{ realisert: 450 }, { realisert: null }, { realisert: -50 }]);
  assert.deepStrictEqual({ ...b }, { realized: 400, other: 200 });
  assert.strictEqual(A.resultBridge(600, []), null);
  assert.strictEqual(A.resultBridge(600, null), null);
  assert.strictEqual(A.resultBridge(null, [{ realisert: 1 }]), null);
});

// The bank's own export writes money out as a negative Ut (seen in the real sheet:
// the checklist added outgoing money instead of subtracting it). Synthetic rows.
const dnbRaw = (rows) => [
  ['DNB transactions'], [], [],
  ['Year', 'Bokført dato', 'Transaksjonstype', 'Forklarende tekst', 'Ut', 'Inn'],
  ...rows,
];

test('parseDnbRaw keeps Ut and Inn as positive amounts, whatever sign the export uses', () => {
  const rows = A.parseDnbRaw(dnbRaw([
    [Y, `${Y}-03-01`, 'Giro', 'Til NORDNET', -400, ''],
    [Y, `${Y}-04-01`, 'Omkostninger', 'Gebyr', 25, ''],
    [Y, `${Y}-12-20`, 'Giro', 'Member payment', '', 1000],
  ]));
  assert.strictEqual(rows.map((r) => r.ut).join(), '400,25,');
  assert.strictEqual(rows[2].inn, 1000);
});

test('negative Ut from the bank export: DNB net and the Nordnet transfer check both pass', () => {
  const parsed = A.parseDnbRaw(dnbRaw([
    [Y, `${Y}-03-01`, 'Giro', 'Giro to NORDNET broker', -400, ''],
    [Y, `${Y}-12-20`, 'Giro', 'Member payment', '', 1000],
  ]));
  const r = A.reconcile({ ...good, dnb: parsed });
  assert.strictEqual(byId(r, 'dnb-1920').status, 'pass', byId(r, 'dnb-1920').detail);
  assert.strictEqual(byId(r, 'transfers').status, 'pass', byId(r, 'transfers').detail);
});

test('a closed year keeps the number checks and drops the in-progress rows', () => {
  const r = A.reconcile({ ...good, closed: true });
  assert.ok(byId(r, 'dnb-1920') && byId(r, 'nordnet-1921') && byId(r, 'transfers'));
  assert.strictEqual(byId(r, 'wip-tab'), undefined);
  assert.strictEqual(byId(r, 'year-end'), undefined);
});

test('a misspelt transfer to Nordnet still counts toward "Nordnet deposits vs DNB transfers"', () => {
  const { context: ctx } = require('./harness');
  const W = ctx(['parsers.js', 'format.js', 'bank-rules.js', 'accounting.js']);
  const dnbTypo = [
    { year: Y, date: `${Y}-03-01`, type: 'Giro', text: 'Overf til Nordent', ut: 400, inn: null },
    { year: Y, date: `${Y}-12-20`, type: 'Giro', text: 'Member payment', ut: null, inn: 1000 },
  ];
  const r = W.Accounting.reconcile({ ...good, dnb: dnbTypo });
  assert.strictEqual(r.rows.find((x) => x.id === 'transfers').status, 'pass');
});

test('closed year: "Latest data dates" passes when the data ends early but the cash checks match', () => {
  const quiet = [
    { year: Y, date: `${Y}-11-02`, type: 'INNSKUDD', amount: 400 },
    { year: Y, date: `${Y}-06-01`, type: 'KJØPT', amount: -150 },
  ];
  const r = A.reconcile({ ...good, nordnet: quiet, closed: true });
  assert.strictEqual(byId(r, 'nordnet-1921').status, 'pass');
  assert.strictEqual(byId(r, 'dates').status, 'pass', byId(r, 'dates').detail);
  assert.match(byId(r, 'dates').detail, /no Nordnet activity after/);
  const off = A.reconcile({ ...good, sb: sb(600, 999, -1000), nordnet: quiet, closed: true });
  assert.strictEqual(byId(off, 'dates').status, 'check', 'cash does not match: early data stays a Check');
  assert.strictEqual(A.reconcile({ ...good, nordnet: quiet }).rows.find((x) => x.id === 'dates').status, 'check', 'the year in progress keeps the plain rule');
});

test('a Sum or Total row in a Nordnet year tab is not read as a security', () => {
  const rows = A.parseNordnetYear([
    ['Verdipapir', 'Kostpris', 'Realisert gevinst/tap'],
    ['Alpha', 100, 10], ['Beta', 200, 20], ['Sum', 300, 30], ['Totalt', 300, 30],
  ]);
  assert.strictEqual(rows.map((r) => r.security).join(), 'Alpha,Beta');
});

test('CSV: text starting with = + - @ is neutralised, numbers stay numbers', () => {
  const t = A.csvText([['=HYPERLINK("x")', '+cmd', '-1029', -1029, '@SUM', 'Alpha']]);
  assert.strictEqual(t.replace('﻿', ''), `"'=HYPERLINK(""x"")",'+cmd,-1029,-1029,'@SUM,Alpha`);
});

test('a redemption counts its cash once: the LIKVID row, not the securities row as well', () => {
  const withRedemption = [...nordnet,
    { year: Y, date: `${Y}-07-14`, type: 'INNL. VP LIKVID', amount: 700 },
    { year: Y, date: `${Y}-07-14`, type: 'INNLØSN. UTTAK VP', security: 'Gamma', qty: 10, amount: 700 }];
  const r = A.reconcile({ ...good, sb: sb(600, 250 + 700, -1000), nordnet: withRedemption });
  assert.strictEqual(byId(r, 'nordnet-1921').status, 'pass', byId(r, 'nordnet-1921').detail);
});
