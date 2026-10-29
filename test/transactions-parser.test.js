const test = require('node:test');
const assert = require('node:assert');
const { context } = require('./harness');

// parseTransactions must find the Nordnet header even when a pasted export
// carries a byte-order mark on "Id" or sits below a title row; otherwise every
// row is skipped and the whole portal shows no data. Synthetic rows only.
const P = context(['parsers.js']).Parsers;
const HEADER = ['Id', 'Bokføringsdag', 'Handelsdag', 'Oppgjørsdag', 'Portefølje', 'Transaksjonstype', 'Verdipapir', 'ISIN', 'Antall', 'Kurs', 'Rente', 'Totale Avgifter', 'Valuta', 'Beløp', 'Valuta'];
const ROW = ['1001', '2026-01-05', '2026-01-05', '2026-01-07', 'X', 'KJØPT', 'Alpha', 'NO0000000001', 10, 100, '', 29, 'NOK', -1029, 'NOK'];

test('a plain header row parses', () => {
  const t = P.parseTransactions([HEADER, ROW]);
  assert.strictEqual(t.length, 1);
  assert.strictEqual(t[0].type, 'KJØPT');
});

test('a byte-order mark on "Id" (pasted UTF-16 export) still parses', () => {
  const t = P.parseTransactions([['﻿Id', ...HEADER.slice(1)], ROW]);
  assert.strictEqual(t.length, 1);
  assert.strictEqual(t[0].nordnetId, '1001');
});

test('a title row above the header still parses', () => {
  const t = P.parseTransactions([['Rådata fra Nordnet'], [' Id ', ...HEADER.slice(1)], ROW]);
  assert.strictEqual(t.length, 1);
  assert.strictEqual(t[0].security, 'Alpha');
});

test('an overwritten "Id" header (stray keystroke in A1) still parses from column A', () => {
  const t = P.parseTransactions([['g', ...HEADER.slice(1)], ROW]);
  assert.strictEqual(t.length, 1);
  assert.strictEqual(t[0].nordnetId, '1001');
});

test('transactionsProblem says why a tab gives no rows', () => {
  assert.match(P.transactionsProblem(null, 'Rådata fra nordnet'), /was not found/);
  assert.match(P.transactionsProblem([['x']], 'Rådata fra nordnet'), /is empty/);
  assert.match(P.transactionsProblem([['a', 'b'], ['c', 'd']], 'Rådata fra nordnet'), /no Nordnet header row/);
});
