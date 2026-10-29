const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const { baseWindow, load } = require('./harness');

// The shared loader for the calculated books (one sheet): reads DNB_raw,
// Aliases and Accounting inputs from the portfolio sheet only. Synthetic rows.
const Y = 2031;
function env(tabs) {
  const asked = [];
  const w = baseWindow({
    PORTAL_CONFIG: { ACCOUNTING_TABS: { dnbRaw: 'DNB_raw' } },
    Store: { hydrate: async () => ({ members: [], transactions: [] }) },
    Sheet: {
      listTabs: async (opts = {}) => { asked.push(opts.sheetId || 'main'); return Object.keys(tabs).map((title) => ({ title })); },
      batchGet: async (names, opts = {}) => { asked.push(opts.sheetId || 'main'); return Object.fromEntries(names.map((n) => [n, tabs[n]])); },
    },
  });
  vm.createContext(w);
  load(w, 'parsers.js', 'format.js', 'ledger.js', 'bank-rules.js', 'accounting.js', 'books.js', 'calculated-books.js');
  return { w, asked };
}

test('loads from the portfolio sheet and calculates every year from DNB_raw', async () => {
  const { w, asked } = env({
    DNB_raw: [['Year', 'Bokført dato', 'Transaksjonstype', 'Forklarende tekst', 'Ut', 'Inn'], [Y, `${Y}-02-01`, 'Giro', 'Til Nordnet', 400, '']],
    'Accounting inputs': [['IB', 1920, 1000], ['IB', 2050, -1000]],
  });
  const r = await w.CalculatedBooks.load();
  assert.deepStrictEqual([...r.years.keys()], [Y]);
  const ub = (a) => r.years.get(Y).sb.find((x) => x.kontonr === a).ub;
  assert.strictEqual(ub(1920), 600);
  assert.strictEqual(ub(1921), 400);
  assert.ok(asked.every((s) => s === 'main'), 'never the accounting sheet');
  assert.strictEqual(await w.CalculatedBooks.load(), await w.CalculatedBooks.load(), 'cached');
});

test('without DNB_raw there are no calculated years', async () => {
  const { w } = env({ Other: [['x']] });
  assert.strictEqual((await w.CalculatedBooks.load()).years.size, 0);
});

test('Store.clear() also drops the calculated books, so a refresh recalculates', async () => {
  const { w, asked } = env({ DNB_raw: [['Year', 'Bokført dato', 'Transaksjonstype', 'Forklarende tekst', 'Ut', 'Inn'], [Y, `${Y}-02-01`, 'Giro', 'Til Nordnet', 400, '']] });
  const realHydrate = w.Store.hydrate;
  load(w, 'store.js');
  w.Store.hydrate = realHydrate;   // keep the synthetic store; only clear() is under test
  await w.CalculatedBooks.load();
  const before = asked.length;
  await w.CalculatedBooks.load();
  assert.strictEqual(asked.length, before, 'cached');
  w.Store.clear();
  await w.CalculatedBooks.load();
  assert.ok(asked.length > before, 'read again after Store.clear()');
});
