const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const { baseWindow, load } = require('./harness');

// C4: the calculated HB and SB of a year (bank vouchers + Nordnet + revaluation
// + year-end entries), and the chain from one year's close to the next IB.
// Synthetic figures; every expected number is worked by hand.
const w = baseWindow({});
vm.createContext(w);
load(w, 'parsers.js', 'ledger.js', 'bank-rules.js', 'books.js');
const { Books, BankRules } = w;
const Y = 2031;
const ALIASES = BankRules.buildAliases([{ code: 'AT', alias: 'Alva Testsen' }]);
const dnbRow = (date, type, text, o = {}) => ({ year: Number(date.slice(0, 4)), date, type, text, ut: null, inn: null, ...o });
let id = 0;
const tx = (type, date, security, qty, amount) => ({ nordnetId: String(++id), bookDate: date, tradeDate: date, type, security, isin: security ? `X-${security}` : null, qty, amount, currency: 'NOK' });
const DNB = [
  dnbRow(`${Y}-01-05`, 'Giro', 'Alva Testsen', { inn: 1000 }),      // D1: 1920 / 2250
  dnbRow(`${Y}-01-06`, 'Giro', 'Til Nordnet', { ut: 900 }),         // D2: 1921 / 1920
  dnbRow(`${Y}-02-01`, 'Omkostninger', 'Gebyr', { ut: 10 }),        // D3: 7700 / 1920
];
const TXS = [
  tx('INNSKUDD', `${Y}-01-07`, null, null, 900),
  tx('KJØPT', `${Y}-01-10`, 'Alpha', 10, -500),
  tx('SALG', `${Y}-06-01`, 'Alpha', 4, 260),        // cost 200, gain 60
  tx('UTBYTTE', `${Y}-04-01`, 'Alpha', 10, 30),
  tx('KUPONGSKATT', `${Y}-04-01`, 'Alpha', 10, -5),
  tx('DEBETRENTE', `${Y}-07-01`, null, null, -2),
];
const price = () => 60;                              // 6 left @ 60 = 360 vs cost 300: +60
const ub = (r, a) => (r.sb.find((x) => x.kontonr === a) || { ub: 0 }).ub;
const run = (inputs = [], ib = new Map()) => Books.ledgerYear({ dnb: DNB, aliases: ALIASES, transactions: TXS, priceAt: price, inputs: Books.parseInputs(inputs), year: Y, ib });

test('the HB balances and every account lands where the books put it', () => {
  const r = run();
  const d = r.hb.reduce((s, l) => s + l.debet, 0), k = r.hb.reduce((s, l) => s + l.kredit, 0);
  assert.ok(Math.abs(d - k) < 0.005, `debet ${d} kredit ${k}`);
  assert.strictEqual(ub(r, 1920), 1000 - 900 - 10);
  assert.strictEqual(ub(r, 2250), -1000);
  assert.strictEqual(ub(r, 7700), 10);
  assert.strictEqual(ub(r, 1921), 900 - 500 + 260 + 30 - 5 - 2, 'cash on Nordnet: the deposit comes from the bank side only');
  assert.strictEqual(ub(r, 1810), 300, 'cost of the 6 left');
  assert.strictEqual(ub(r, 8078), -60, 'gain, a credit');
  assert.strictEqual(ub(r, 8071), -25, 'dividend net of withholding');
  assert.strictEqual(ub(r, 8150), 2);
  assert.strictEqual(ub(r, 1811), 60, 'revaluation up');
  assert.strictEqual(ub(r, 8080), -60);
  for (const f of ['kontonr', 'kontonavn', 'bilagsnr', 'date', 'kommentar', 'debet', 'kredit']) assert.ok(f in r.hb[0], `the parseHovedbok field ${f}`);
  assert.ok(r.hb.some((l) => /^NN\d+$/.test(l.bilagsnr)) && r.hb.some((l) => /^BA\d+$/.test(l.bilagsnr)) && r.hb.some((l) => l.bilagsnr === 'GLV'));
});

test('the result is the sum of the result accounts and moves to 2050 in next year\'s IB', () => {
  const r = run();
  // 10 fee + 2 interest - 60 gain - 25 dividend - 60 revaluation = -133 (a profit)
  assert.strictEqual(r.result, -133);
  assert.strictEqual(r.ibNext.get(2050), -133);
  assert.ok(!r.ibNext.has(8078), 'result accounts start next year at zero');
  assert.strictEqual(r.ibNext.get(1810), 300);
});

test('IB carries on balance accounts; revaluation books only the change from IB', () => {
  const r = run([], new Map([[1920, 50], [1811, 40], [2050, -90]]));
  assert.strictEqual(ub(r, 1920), 50 + 90);
  assert.strictEqual(ub(r, 1811), 60, 'UB is the year-end gross gain');
  assert.strictEqual(ub(r, 8080), -20, 'only the change is income');
  assert.strictEqual(r.sb.find((x) => x.kontonr === 2050).ib, -90);
});

test('ENTRY rows are booked on 31.12 and change the result', () => {
  const r = run([['ENTRY', Y, 8300, 30, '', 'tax'], ['ENTRY', Y, 2500, '', 30, 'tax']]);
  assert.strictEqual(ub(r, 8300), 30);
  assert.strictEqual(ub(r, 2500), -30);
  assert.strictEqual(r.result, -103);
  assert.ok(r.hb.filter((l) => l.source === 'manual').every((l) => l.date === `${Y}-12-31`));
});

test('a deposit after the last DNB line is booked provisionally and an open bank line is reported', () => {
  const txs = [...TXS, tx('INNSKUDD', `${Y}-11-01`, null, null, 100)];
  const dnb = [...DNB, dnbRow(`${Y}-03-01`, 'Varekjøp', 'Something', { ut: 40 })];
  const r = Books.ledgerYear({ dnb, aliases: ALIASES, transactions: txs, priceAt: price, inputs: Books.parseInputs([]), year: Y, ib: new Map() });
  assert.strictEqual(r.provisional, 100);
  assert.ok(r.flags.some((f) => /1 bank line not booked/.test(f)));
});

test('calculatedYears chains the years: next IB is this UB plus the result transfer', () => {
  const ys = Books.calculatedYears({ dnb: DNB, aliases: ALIASES, transactions: TXS, prices: () => price, inputs: Books.parseInputs([['IB', 1920, 0]]), firstYear: Y, lastYear: Y + 1 });
  assert.strictEqual(ys.length, 2);
  const [a, b] = ys;
  assert.strictEqual(b.sb.find((x) => x.kontonr === 1810).ib, ub(a, 1810));
  assert.strictEqual(b.sb.find((x) => x.kontonr === 2050).ib, a.result);
  assert.strictEqual(ub(b, 8078), 0, 'no sales in the second year');
  assert.strictEqual(ub(b, 1811), 60, 'the gain stays on the balance sheet');
});

test('a redemption kept unrealised that paid money is flagged, not silently dropped', () => {
  const txs = [...TXS, tx('KJØPT', `${Y}-02-01`, 'Rho', 10, -100), tx('INNLØSN. UTTAK VP', `${Y}-08-01`, 'Rho', 10, 120)];
  const r = Books.ledgerYear({ dnb: DNB, aliases: ALIASES, transactions: txs, priceAt: price, inputs: Books.parseInputs([['REALISE', 'Rho', Y, 'no']]), year: Y, ib: new Map() });
  assert.ok(r.flags.some((f) => /redemption of Rho is kept unrealised .* paid 120/.test(f)), r.flags.join(' | '));
});
