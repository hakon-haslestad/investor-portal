const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const { baseWindow, load } = require('./harness');

// C3: Nordnet per year (the "Nordnet YY" tab), calculated with FIFO lots from
// Rådata fra nordnet. Synthetic trades; every expected number is worked by hand.
const w = baseWindow({});
vm.createContext(w);
load(w, 'parsers.js', 'ledger.js', 'books.js');
const { Books } = w;
const Y = 2031;
let id = 0;
const tx = (type, date, security, qty, amount, o = {}) => ({ nordnetId: String(++id), bookDate: date, tradeDate: date, type, security, isin: o.isin || `X-${security}`, qty, amount, currency: 'NOK', purchaseValue: o.kv == null ? null : o.kv, ...o });
const price = (map) => (sec) => (sec in map ? map[sec] : null);
const bySec = (rows) => Object.fromEntries(rows.map((r) => [r.security, r]));
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.005, `${msg}: ${a} vs ${b}`);

test('FIFO: a partial sale takes the oldest lot first, and the rest is valued at the 31.12 price', () => {
  const txs = [
    tx('KJØPT', `${Y}-01-10`, 'Alpha', 10, -100),   // lot 1: 10 @ 10
    tx('KJØPT', `${Y}-02-10`, 'Alpha', 10, -200),   // lot 2: 10 @ 20
    tx('SALG', `${Y}-06-01`, 'Alpha', 15, 450),     // FIFO cost 100 + 5*20 = 200 -> gain 250
  ];
  const r = Books.nordnetYear(txs, price({ Alpha: 25 }), Books.parseInputs([]), Y);
  const a = bySec(r.rows).Alpha;
  near(a.realisert, 250, 'realised');
  near(a.kostpris, 100, 'cost left: 5 @ 20');
  near(a.markedsverdi, 125, 'MV: 5 @ 25');
  near(a.urealisert, 25, 'unrealised');
  assert.strictEqual(r.method, 'fifo');
});

test('FIFO and average cost give different realised gains on the same trades', () => {
  const txs = [tx('KJØPT', `${Y}-01-10`, 'Alpha', 10, -100), tx('KJØPT', `${Y}-02-10`, 'Alpha', 10, -200), tx('SALG', `${Y}-06-01`, 'Alpha', 15, 450)];
  const fifo = Books.nordnetYear(txs, price({ Alpha: 25 }), Books.parseInputs([]), Y);
  const avg = Books.nordnetYear(txs, price({ Alpha: 25 }), Books.parseInputs([]), Y, { method: 'avg' });
  near(bySec(fifo.rows).Alpha.realisert, 250, 'FIFO');
  near(bySec(avg.rows).Alpha.realisert, 225, 'average: cost 15 * 15 = 225');
});

test('a year only shows that year\'s realised gains and dividends; lots carry over from earlier years', () => {
  const txs = [
    tx('KJØPT', `${Y - 1}-05-01`, 'Beta', 10, -100),
    tx('SALG', `${Y - 1}-08-01`, 'Beta', 2, 30),          // last year's gain: 10
    tx('UTBYTTE', `${Y}-04-01`, 'Beta', 8, 16),
    tx('KUPONGSKATT', `${Y}-04-01`, 'Beta', 8, -4),
    tx('SALG', `${Y}-09-01`, 'Beta', 3, 60),              // this year: cost 30 -> gain 30
  ];
  const b = bySec(Books.nordnetYear(txs, price({ Beta: 12 }), Books.parseInputs([]), Y).rows).Beta;
  near(b.realisert, 30, 'only this year');
  near(b.utbytte, 12, 'dividend net of coupon tax');
  near(b.kostpris, 50, '5 left @ 10');
});

test('a swap moves the cost and the quantity to the new security; no gain', () => {
  const txs = [
    tx('KJØPT', `${Y}-01-10`, 'Old ASA', 10, -100),
    tx('BYTTE UTTAK VP', `${Y}-03-01`, 'Old ASA', 10, 0),
    tx('BYTTE INNLEGG VP', `${Y}-03-01`, 'New ASA', 20, 0),
  ];
  const rows = bySec(Books.nordnetYear(txs, price({ 'New ASA': 6 }), Books.parseInputs([]), Y).rows);
  near(rows['New ASA'].kostpris, 100, 'cost carried');
  near(rows['New ASA'].realisert, 0, 'no gain');
  assert.ok(!rows['Old ASA'] || rows['Old ASA'].kostpris === 0);
});

test('a spin-off without a SPLIT row is flagged; with SPLIT the cost moves from the parent', () => {
  const txs = [
    tx('KJØPT', `${Y}-01-10`, 'Parent ASA', 10, -1000),
    tx('UTSKILLING FISJON IN', `${Y}-05-01`, 'Child AS', 10, 0, { kv: 80 }),
  ];
  const plain = Books.nordnetYear(txs, price({ 'Parent ASA': 90, 'Child AS': 15 }), Books.parseInputs([]), Y);
  assert.ok(plain.flags.some((f) => /Child AS/.test(f) && /SPLIT/.test(f)), plain.flags.join(' | '));
  const split = Books.nordnetYear(txs, price({ 'Parent ASA': 90, 'Child AS': 15 }), Books.parseInputs([['SPLIT', 'Child AS', 0.25, 'Parent ASA']]), Y);
  const s = bySec(split.rows);
  near(s['Child AS'].kostpris, 250, 'a quarter of the parent cost');
  near(s['Parent ASA'].kostpris, 750, 'the parent keeps the rest');
  assert.ok(!split.flags.some((f) => /Child AS/.test(f)), 'closed by the input');
});

test('a missing 31.12 price is flagged and the holding is never silently valued at cost', () => {
  const txs = [tx('KJØPT', `${Y}-01-10`, 'Gamma', 10, -100)];
  const r = Books.nordnetYear(txs, price({}), Books.parseInputs([]), Y);
  const g = bySec(r.rows).Gamma;
  assert.strictEqual(g.markedsverdi, null);
  assert.strictEqual(g.urealisert, null);
  assert.ok(r.flags.some((f) => /price missing/i.test(f) && /Gamma/.test(f)));
});

test('cash identity: buys, sales, dividends and fees add up to the cash movement of the year', () => {
  const txs = [
    tx('INNSKUDD', `${Y}-01-02`, null, null, 1000),
    tx('KJØPT', `${Y}-01-10`, 'Alpha', 10, -300),
    tx('SALG', `${Y}-06-01`, 'Alpha', 4, 160),
    tx('UTBYTTE', `${Y}-04-01`, 'Alpha', 10, 20),
    tx('DEBETRENTE', `${Y}-07-01`, null, null, -3),
  ];
  const r = Books.nordnetYear(txs, price({ Alpha: 40 }), Books.parseInputs([]), Y);
  near(r.cash.movement, 1000 - 300 + 160 + 20 - 3, 'cash movement');
  near(r.cash.deposits, 1000, 'deposits');
  near(r.cash.interest, -3, 'interest');
  near(r.totals.bought, 300, 'bought');
  near(r.totals.sold, 160, 'sale proceeds');
});

test('an unknown Nordnet type is reported, never dropped silently', () => {
  const r = Books.nordnetYear([tx('MERKELIG TYPE', `${Y}-02-02`, 'Alpha', 1, 0)], price({}), Books.parseInputs([]), Y);
  assert.ok(r.flags.some((f) => /unknown Nordnet type MERKELIG TYPE/.test(f)));
});

test('REALISE writes the rest of a position off at 31.12 of its year', () => {
  const txs = [tx('KJØPT', `${Y}-01-10`, 'Delta', 10, -500)];
  const r = Books.nordnetYear(txs, price({ Delta: 0 }), Books.parseInputs([['REALISE', 'Delta', Y]]), Y);
  const d = bySec(r.rows).Delta;
  near(d.realisert, -500, 'loss = cost');
  near(d.kostpris, 0, 'nothing left');
  const next = Books.nordnetYear(txs, price({ Delta: 0 }), Books.parseInputs([['REALISE', 'Delta', Y + 1]]), Y);
  near(bySec(next.rows).Delta.realisert, 0, 'not before its year');
});

test('the SPLIT input reads its parent column', () => {
  const r = Books.parseInputs([['SPLIT', 'Child AS', '0,25', 'Parent ASA']]);
  assert.strictEqual(r.split[0].parent, 'Parent ASA');
  assert.strictEqual(r.split[0].share, 0.25);
});

test('a redemption is realised in its year; REALISE ... no keeps it unrealised as the books once did', () => {
  const txs = [tx('KJØPT', `${Y}-01-10`, 'Omega', 10, -300), tx('INNLØSN. UTTAK VP', `${Y}-08-01`, 'Omega', 10, 0)];
  const r = Books.nordnetYear(txs, price({ Omega: 0 }), Books.parseInputs([]), Y);
  near(bySec(r.rows).Omega.realisert, -300, 'realised loss');
  const kept = Books.nordnetYear(txs, price({ Omega: 0 }), Books.parseInputs([['REALISE', 'Omega', Y, 'no']]), Y);
  const o = bySec(kept.rows).Omega;
  near(o.realisert, 0, 'nothing realised');
  near(o.kostpris, 300, 'still at cost');
  near(o.urealisert, -300, 'an unrealised loss instead');
});

test('a SPLIT with a typed cost moves that cost from the parent', () => {
  const txs = [tx('KJØPT', `${Y}-01-10`, 'Parent ASA', 10, -1000), tx('UTSKILLING FISJON IN', `${Y}-05-01`, 'Child AS', 10, 0, { kv: 80 })];
  const s = bySec(Books.nordnetYear(txs, price({ 'Parent ASA': 90, 'Child AS': 15 }), Books.parseInputs([['SPLIT', 'Child AS', '', 'Parent ASA', 120]]), Y).rows);
  near(s['Child AS'].kostpris, 120, 'typed cost');
  near(s['Parent ASA'].kostpris, 880, 'taken from the parent');
});

test('lots follow the ISIN when Nordnet changes the name without a swap row', () => {
  const txs = [tx('KJØPT', `${Y}-01-10`, 'Eps Old Name', 10, -100, { isin: 'XX0001' }), tx('SALG', `${Y}-03-01`, 'Eps New Name', 10, 150, { isin: 'XX0001' })];
  const r = Books.nordnetYear(txs, price({}), Books.parseInputs([]), Y);
  assert.strictEqual(r.rows.length, 1);
  near(r.rows[0].realisert, 50, 'one position, one gain');
  assert.strictEqual(r.rows[0].security, 'Eps New Name', 'the latest name is shown');
  assert.ok(!r.flags.some((f) => /removed but only/.test(f)));
});

test('a SPLIT for a later spin-off is quiet in earlier years; one that matches nothing is flagged', () => {
  const txs = [tx('KJØPT', `${Y - 1}-01-10`, 'Parent ASA', 10, -1000), tx('UTSKILLING FISJON IN', `${Y}-05-01`, 'Child AS', 10, 0)];
  const earlier = Books.nordnetYear(txs, price({ 'Parent ASA': 90 }), Books.parseInputs([['SPLIT', 'Child AS', 0.25, 'Parent ASA']]), Y - 1);
  assert.strictEqual(earlier.flags.length, 0, earlier.flags.join(' | '));
  const typo = Books.nordnetYear(txs, price({ 'Parent ASA': 90, 'Child AS': 1 }), Books.parseInputs([['SPLIT', 'Chld AS', 0.25, 'Parent ASA']]), Y);
  assert.ok(typo.flags.some((f) => /SPLIT Chld AS: no spin-off/.test(f)));
});

test('a PRICE row sets the 31.12 price, in place of StockPrices', () => {
  const txs = [tx('KJØPT', `${Y}-01-10`, 'Alpha', 10, -100)];
  const inputs = Books.parseInputs([['PRICE', 'X-Alpha', Y, '12,5'], ['PRICE', 'Alpha', Y + 1, 99]]);
  const a = bySec(Books.nordnetYear(txs, price({ Alpha: 25 }), inputs, Y).rows).Alpha;
  near(a.markedsverdi, 125, 'the typed price, by ISIN');
  near(a.urealisert, 25, 'unrealised from the typed price');
  const missing = Books.nordnetYear(txs, price({}), Books.parseInputs([['PRICE', 'Alpha', Y, 11]]), Y);
  near(bySec(missing.rows).Alpha.markedsverdi, 110, 'by name, and it fills a missing price');
  assert.ok(!missing.flags.some((f) => /price missing/.test(f)));
  assert.match(Books.parseInputs([['PRICE', 'Alpha', Y]]).problems[0].reason, /needs a price per share/);
});

test('a PRICE that is really a date (Norwegian locale) or far from the close is flagged', () => {
  const txs = [tx('KJØPT', `${Y}-01-10`, 'Alpha', 10, -100)];
  const asDate = Books.nordnetYear(txs, price({ Alpha: 25 }), Books.parseInputs([['PRICE', 'Alpha', Y, 46228]]), Y);
  assert.ok(asDate.flags.some((f) => /PRICE for Alpha 2031 is 46228, far from the close 25 \(a date\?/.test(f)), asDate.flags.join(' | '));
  const noClose = Books.nordnetYear(txs, price({}), Books.parseInputs([['PRICE', 'Alpha', Y, 46228]]), Y);
  assert.ok(noClose.flags.some((f) => /looks like a date/.test(f)));
  const fine = Books.nordnetYear(txs, price({ Alpha: 25 }), Books.parseInputs([['PRICE', 'Alpha', Y, '24,8']]), Y);
  assert.ok(!fine.flags.some((f) => /PRICE for/.test(f)), 'a normal difference from the close is not flagged');
});

// Review findings (2026-10-28 night), each with the failing input it reported.
test('two swaps on the same day keep both costs and both holdings', () => {
  const txs = [
    tx('KJØPT', `${Y}-01-10`, 'A', 10, -100), tx('KJØPT', `${Y}-01-10`, 'B', 10, -500),
    tx('BYTTE UTTAK VP', `${Y}-03-01`, 'A', 10, 0), tx('BYTTE INNLEGG VP', `${Y}-03-01`, 'A2', 10, 0),
    tx('BYTTE UTTAK VP', `${Y}-03-01`, 'B', 10, 0), tx('BYTTE INNLEGG VP', `${Y}-03-01`, 'B2', 10, 0),
  ];
  const r = Books.nordnetYear(txs, price({ A2: 10, B2: 50 }), Books.parseInputs([]), Y);
  const s = bySec(r.rows);
  near(s.A2.kostpris, 100, 'A2 carries A');
  near(s.B2.kostpris, 500, 'B2 carries B');
  assert.ok(!r.flags.some((f) => /swap/.test(f)), r.flags.join(' | '));
});

test('a name reused by a later swap still means the old ISIN for an earlier year', () => {
  const txs = [
    tx('KJØPT', `${Y}-01-10`, 'Foo', 10, -100, { isin: 'OLD' }),
    tx('BYTTE UTTAK VP', `${Y + 1}-03-01`, 'Foo', 10, 0, { isin: 'OLD' }), tx('BYTTE INNLEGG VP', `${Y + 1}-03-01`, 'Foo', 10, 0, { isin: 'NEW' }),
  ];
  const r = Books.nordnetYear(txs, price({ Foo: 20 }), Books.parseInputs([['PRICE', 'Foo', Y, 12]]), Y);
  near(bySec(r.rows).Foo.markedsverdi, 120, 'the PRICE row is used for the OLD lots');
});

test('a PRICE row for a security nobody holds is flagged (a typo)', () => {
  const r = Books.nordnetYear([tx('KJØPT', `${Y}-01-10`, 'Alpha', 10, -100)], price({ Alpha: 25 }), Books.parseInputs([['PRICE', 'Alpah', Y, 24]]), Y);
  assert.ok(r.flags.some((f) => /PRICE Alpah 2031: nothing of that security is held/.test(f)));
});
