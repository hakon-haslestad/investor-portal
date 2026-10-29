const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const { baseWindow, load } = require('./harness');

// Mounts the real Accounting view on a tiny fake DOM with a stub Sheet, so a
// render that throws (a helper used before it is set, as once in production)
// fails here. The view keeps module-level caches, so every test loads a fresh
// context. Synthetic figures only.
const Y = 2031;
const SB_HEAD = ['Kontonr', 'Kontonavn', 'IB', 'UB'];
const tabsData = {
  'SB, 31': [SB_HEAD, [1920, 'Bank', 100, 700], [1921, 'Broker', 0, 250], [2250, 'Equity', -50, -1050]],
  'HB, 31': [['Bilagsnr', 'Kontonr', 'Debet']],
  'SB, 30': [SB_HEAD, [1920, 'Bank', 0, 5]],
  'HB, 30': [['Bilagsnr', 'Kontonr', 'Debet']],
  DNB_raw: [['Year', 'Bokført dato', 'Transaksjonstype', 'Forklarende tekst', 'Ut', 'Inn'],
    [Y, `${Y}-12-20`, 'x', 'Member payment', '', 1000], [Y, `${Y}-02-01`, 'x', 'Giro nordnet', 400, '']],
  Nordnet_raw: [['Year', 'Bokføringsdag', 'Transaksjonstype', 'Beløp'],
    [Y, `${Y}-12-19`, 'INNSKUDD', 400], [Y, `${Y}-05-01`, 'KJØPT', -150]],
};

async function mount({ omit = [], year = null, extra = {}, main = null, accountingSheetId = 'synthetic-sheet', store = null, storage = {} } = {}) {
  const data = { ...tabsData, ...extra };
  const calls = [];
  const tabs = Object.keys(data).filter((t) => !omit.includes(t)).map((title) => ({ title }));
  // `main`: tabs of the portfolio sheet when a test separates the two sheets.
  const mainTabs = main ? Object.keys(main).map((title) => ({ title })) : tabs;
  const w = baseWindow({
    Views: {},
    ...(store ? { Store: { hydrate: async () => store } } : {}),
    PORTAL_CONFIG: { ACCOUNTING_SHEET_ID: accountingSheetId, ACCOUNTING_TABS: { dnbRaw: 'DNB_raw', nordnetRaw: 'Nordnet_raw' }, ACCOUNTING_CURRENT_YEAR: Y },
    Auth: { getEmail: () => 'test@example.test' },
    UI: { skeleton: () => '<div class="skeleton-wrap"><span class="sr-only">Loading…</span></div>', infoIcon: () => '', table: (cols, rows) => `<table>${rows.map((r) => `<tr>${r.join('|')}</tr>`).join('')}</table>` },
    Sheet: {
      listTabs: async (opts = {}) => (opts.sheetId ? tabs : mainTabs),
      batchGet: async (names, opts = {}) => {
        calls.push(opts.sheetId ? names : names.map((n) => `main:${n}`));
        const src = main && !opts.sheetId ? main : data;
        names.forEach((n) => { if (!src[n] || (!main && omit.includes(n))) throw new Error(`no such tab ${n}`); });
        return Object.fromEntries(names.map((n) => [n, src[n]]));
      },
    },
  });
  vm.createContext(w);
  load(w, 'parsers.js', 'format.js', 'bank-rules.js', 'accounting.js', 'books.js', 'calculated-books.js', 'views/accounting.js');
  if (year) w.localStorage.setItem('portal.accounting.year', String(year));
  for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
  const node = () => ({ innerHTML: '', textContent: '', style: {}, querySelectorAll: () => [], querySelector: () => ({ addEventListener() {} }) });
  const kids = { '#acc-root': node(), '#year-picker-mount': node(), '#meta-line': node() };
  const el = { innerHTML: '', querySelector: (s) => kids[s] };
  await w.Views.accounting(el, { me: { displayName: 'Tester' } });
  for (let i = 0; i < 50 && /Loading/.test(kids['#acc-root'].innerHTML); i++) await new Promise((r) => setImmediate(r));
  return { html: kids['#acc-root'].innerHTML, calls, shell: el.innerHTML };
}

test('latest year renders the checklist with a status line, no throw', async () => {
  const { html } = await mount();
  assert.match(html, /Year-end checklist/);
  assert.match(html, /role="status">[^<]*pass, [^<]*to check, [^<]*to do</);
  assert.match(html, /not accountant-reviewed/);
  assert.match(html, /Not booked yet/);
  assert.match(html, /DNB net vs SB 1920/);
});

test('an older year shows the number checks as a closed year, without the in-progress rows', async () => {
  const { html } = await mount({ year: 2030 });
  assert.match(html, /Year-end checklist · closed year/);
  assert.match(html, /DNB net vs SB 1920/);
  assert.doesNotMatch(html, /Not booked yet/);
  assert.doesNotMatch(html, /Year tab name/);
  assert.match(html, /Saldobalanse · 2030/);
});

test('a missing cross-year tab is To do, is not requested, and the page still renders', async () => {
  const { html, calls } = await mount({ omit: ['DNB_raw'] });
  assert.match(html, /No DNB rows for 2031/);
  assert.match(html, /Saldobalanse · 2031/);
  assert.ok(calls.every((c) => !c.includes('DNB_raw')));
});

test('no cross-year tabs at all: no cross-year request, checklist still renders', async () => {
  const { html, calls } = await mount({ omit: ['DNB_raw', 'Nordnet_raw'] });
  assert.match(html, /Year-end checklist/);
  assert.ok(calls.every((c) => c.length && !c.includes('Nordnet_raw')));
});

// Result and equity block. Rows are kept apart from tabsData so the other
// tests keep their SB without result accounts.
const BOOKS = [SB_HEAD, [1920, 'Bank', 100, 700], [3000, 'Income', 0, -900], [7000, 'Cost', 0, 300], [2000, 'Share capital', -500, -500]];
const NN = [['Name', 'Kostpris', 'Realisert gevinst/tap'], ['Stock A', 100, 450]];
const withBooks = { 'SB, 31': BOOKS, 'Nordnet 31': NN };

test('result and equity block shows labelled figures and the bridge', async () => {
  const { html } = await mount({ extra: withBooks });
  assert.match(html, /Result and equity, per the books, 2031/);
  const block = html.slice(html.indexOf('Result and equity'));
  assert.match(block, /Result[^<]*<[^]*?\b600\b/);
  assert.match(block, /Equity[^<]*<[^]*?\b500\b/);
  assert.match(block, /realized gains per Nordnet[^]*?\b450\b[^]*?other \(fees, interest, dividends, timing\)[^]*?\b150\b/);
  assert.ok(html.indexOf('Year-end checklist') < html.indexOf('Result and equity'));
});

test('result block works on an older year and without Nordnet rows (no bridge, no throw)', async () => {
  const { html } = await mount({ year: 2030, extra: { ...withBooks, 'SB, 30': BOOKS } });
  assert.match(html, /Result and equity, per the books, 2030/);
  assert.match(html, /Year-end checklist · closed year/);
  assert.doesNotMatch(html, /realized gains per Nordnet/);
});

test('no result and no equity accounts: no result block', async () => {
  const { html } = await mount();
  assert.doesNotMatch(html, /Result and equity/);
});

test('the panel shows a skeleton, not bare text, while the year loads', async () => {
  const { shell } = await mount();
  assert.match(shell, /id="acc-root"><div class="skeleton-wrap"/);
});


// ── One sheet (C1): raw data and the inputs tab come from the portfolio sheet ──
const DNB_MAIN = [['Year', 'Bokført dato', 'Transaksjonstype', 'Forklarende tekst', 'Ut', 'Inn'],
  [Y, `${Y}-12-20`, 'x', 'Member payment', '', 1000], [Y, `${Y}-02-01`, 'x', 'Giro nordnet', -400, '']];

test('DNB_raw is read from the portfolio sheet when it is there', async () => {
  const { html, calls } = await mount({ main: { DNB_raw: DNB_MAIN } });
  assert.ok(calls.some((c) => c.includes('main:DNB_raw')), JSON.stringify(calls));
  assert.ok(!calls.some((c) => c.includes('DNB_raw') && !c.includes('main:DNB_raw')), 'not from the accounting sheet');
  assert.match(html, /DNB net vs SB 1920/);
});

test('invalid rows in "Accounting inputs" show as To do in the checklist', async () => {
  const inputs = [['Kind', 'A', 'B'], ['IB', 999, 10], ['ENTRY', Y, 8300, 500, '', 'Tax']];
  const { html } = await mount({ main: { DNB_raw: DNB_MAIN, 'Accounting inputs': inputs } });
  assert.match(html, /Accounting inputs/);
  assert.match(html, /999 is not an account/);
  assert.match(html, /do not balance/);
});

test('Nordnet rows come from Rådata fra nordnet (the store) instead of a Nordnet_raw copy', async () => {
  const store = { members: [], transactions: [
    { bookDate: `${Y}-12-19`, tradeDate: `${Y}-12-19`, type: 'INNSKUDD', security: null, qty: null, amount: 400 },
    { bookDate: `${Y}-05-01`, tradeDate: `${Y}-05-01`, type: 'KJØPT', security: 'Alpha', qty: 1, amount: -150 },
  ] };
  const { html, calls } = await mount({ store, main: { DNB_raw: DNB_MAIN } });
  assert.ok(!calls.flat().includes('Nordnet_raw'), 'the second sheet copy is not read');
  assert.match(html, /Nordnet cash vs SB 1921/);
  assert.match(html, /250 kr in both|250\s?kr in both/, 'Rådata sums to the SB movement');
});

test('without an accounting sheet the tab shows the calculated books, labelled as such', async () => {
  const { html, shell } = await mount({ accountingSheetId: '', main: { DNB_raw: DNB_MAIN } });
  assert.match(html, /Calculated from raw data, not accountant-reviewed/);
  assert.match(html, /Bank vouchers 2031, calculated/);
  assert.ok(!/Calculated vs the books/.test(html), 'nothing to compare with');
  assert.ok(!/No years to show/.test(html));
});

test('without an accounting sheet and without DNB_raw the tab says what is missing', async () => {
  const { html } = await mount({ accountingSheetId: '', main: { Other: [['x']] } });
  assert.match(html, /No years to show/);
  assert.match(html, /DNB_raw/);
});

test('Calculated mode shows the per-account comparison with the books', async () => {
  const w = { 'portal.accounting.source': 'calc' };
  const { html } = await mount({ storage: w });
  assert.match(html, /Calculated from raw data/);
  assert.match(html, /Calculated vs the books 2031 · \d+ of \d+ accounts match/);
  assert.match(html, /<tr>1920\|Bank\|700\skr\|0\skr\|−700\skr<\/tr>/, 'a differing account with books, calculated and the difference');
});

test('Books mode (the default) also shows the comparison when the calculated books exist', async () => {
  const { html } = await mount();
  assert.match(html, /Calculated vs the books 2031/);
  assert.ok(!/Calculated from raw data, not accountant-reviewed/.test(html));
});

test('the year page lists the calculated bank vouchers and the lines to decide, with a row to paste', async () => {
  const { html } = await mount();
  // The synthetic lines have type "x", so no rule books them: both wait for a decision.
  assert.match(html, /Bank vouchers 2031, calculated · 0 booked, 2 to decide/);
  assert.match(html, /BA1\|2031-02-01/, 'numbered in date order');
  assert.match(html, /DECIDE\t2031-12-20\t1000\t8050/, 'a ready DECIDE row with the suggested account');
});

test('a DECIDE row in Accounting inputs books the open line', async () => {
  const { html } = await mount({ extra: { 'Accounting inputs': [['DECIDE', `${Y}-12-20`, 1000, 2250, '', 'member']] } });
  assert.match(html, /Bank vouchers 2031, calculated · 1 booked, 1 to decide/);
  assert.match(html, /BA2\|2031-12-20\|Member payment\|2250\|1\s000\skr\|manual/);
});

test('the year page shows Nordnet calculated from Rådata, with a missing price flagged', async () => {
  const store = { members: [], transactions: [
    { bookDate: `${Y}-05-01`, tradeDate: `${Y}-05-01`, type: 'KJØPT', security: 'Alpha', qty: 2, amount: -150, currency: 'NOK' },
  ] };
  const { html } = await mount({ store });
  assert.match(html, /Nordnet 2031, calculated · 1 security/);
  assert.match(html, /price missing for Alpha on 31.12.2031/);
});

test('when every account matches, the comparison says so', async () => {
  const { html } = await mount({ extra: {
    'SB, 31': [SB_HEAD, [1920, 'Bank', 0, 600], [1921, 'Broker', 0, 400], [2250, 'Equity', 0, -1000]],
    'Accounting inputs': [['DECIDE', `${Y}-02-01`, 400, 1921], ['DECIDE', `${Y}-12-20`, 1000, 2250]],
  } });
  assert.match(html, /Calculated vs the books 2031 · 3 of 3 accounts match/);
  assert.match(html, /Every account with a balance matches/);
});
