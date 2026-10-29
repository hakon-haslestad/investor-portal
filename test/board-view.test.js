const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const { baseWindow, load } = require('./harness');

// Mounts the real Board view on the real portfolio code with a synthetic book,
// stub competitions and a stub accounting workbook. Covers: data present, an
// empty store, each optional block missing, and the accounting-result helpers.
const node = () => ({ innerHTML: '', style: {}, dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [] });
const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const thisYear = new Date().getFullYear();

const COMP = (id, name, start, end) => ({ competition: { id, name, start_date: start, end_date: end }, participants: [] });
const scoredFor = (c) => ({
  competition: c, ranks: [{ grossBought: 1, netPnl: 100 }],
  teams: [{ label: c.id === 'OLD' ? 'Team Fox' : 'Team Owl', pct: c.id === 'OLD' ? 12.5 : -3.4, netPnl: 100, buyIn: 1000, pctBase: 'buyIn' }, { label: 'Other', pct: -9, netPnl: -90, buyIn: 1000, pctBase: 'buyIn' }],
});

// SB rows: income accounts carry credit (negative) balances, costs positive.
const SB = [['Kontonr', 'Kontonavn', 'IB', 'UB'], [1920, 'Bank', 0, 5000], [3000, 'Income', 0, -9000], [7000, 'Cost', 0, 4000], [8050, 'Interest', 0, -500], [9000, 'Not result', 0, 123]];

function env({ errors = [], competitions = [COMP('OLD', 'Spring', '2020-01-01', '2020-02-01'), COMP('NEW', 'Autumn', day(5), day(-30))], sheet, tabs } = {}) {
  const w = baseWindow({
    Charts: {}, PORTAL_CONFIG: { ACCOUNTING_SHEET_ID: 'acc' },
    CompetitionsData: { listCompetitions: async () => { if (competitions instanceof Error) throw competitions; return competitions; } },
    CompetitionEngine: { scoreCompetition: (_s, c) => scoredFor(c) },
    Sheet: sheet || {
      listTabs: async () => tabs || ['SB, 24', 'HB, 24', `SB, ${String(thisYear).slice(2)}`, `HB, ${String(thisYear).slice(2)}`],
      batchGet: async (names) => Object.fromEntries(names.map((n) => [n, SB])),
    },
    console: { ...console, error: (...a) => errors.push(a.join(' ')), warn: (...a) => errors.push(a.join(' ')) },
  });
  w.document.getElementById = () => node();
  vm.createContext(w);
  load(w, 'format.js', 'copy.js', 'parsers.js', 'ledger.js', 'prices.js', 'securities.js', 'positions.js', 'portfolio.js', 'fundamentals.js', 'accounting.js', 'metrics-info.js', 'components.js', 'views/board.js');
  return w;
}

function book(w, { stale = false } = {}) {
  const sec = (name, ticker) => ({ name, ticker, isin: null, aliases: [], currency: 'NOK', status: 'held' });
  const registry = w.Securities.buildRegistry([sec('Alpha', 'AAA'), sec('Beta', 'BBB')]);
  w.Portfolio._setRegistry(registry);
  const rows = [['date', 'AAA', 'BBB']];
  for (let n = 40; n >= (stale ? 20 : 0); n--) rows.push([day(n), 10 + (n < 10 ? 2 : 0), 20]);
  const tx = (security, type, d, qty, amount) => ({ security, type, tradeDate: day(d), bookDate: day(d), qty, amount, currency: 'NOK' });
  return {
    registry, prices: w.Prices.build(rows), members: [], kpis: [],
    attributionMap: new Map([['Alpha', [{ code: 'HH', weight: 1 }]], ['Beta', [{ code: 'HS', weight: 1 }]]]),
    transactions: [
      { type: 'INNSKUDD', tradeDate: day(35), bookDate: day(35), amount: 5000, currency: 'NOK', saldo: 5000 },
      tx('Alpha', 'KJØPT', 30, 10, -100), tx('Beta', 'KJØPT', 30, 10, -200),
    ],
  };
}
const emptyStore = (w) => ({ registry: w.Securities.buildRegistry([]), prices: w.Prices.build([['date']]), members: [], kpis: [], attributionMap: new Map(), transactions: [] });

async function mount(w, store) {
  const el = { ...node() };
  await w.Views.board(el, { store, me: { role: 'member' } });
  return el.innerHTML;
}
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const kr = (w, n) => text(w.Fmt.fmtNok(n)); // fmtNok groups with a no-break space

test('Board mounts with data: the numbers are Portfolio.summary, English labels, no console errors', async () => {
  const errors = [];
  const w = env({ errors }); const store = book(w);
  const html = await mount(w, store); const t = text(html);
  const s = w.Portfolio.summary(store);
  assert.match(t, /Board overview/);
  assert.ok(t.includes(`as of ${s.asOf}`));
  assert.ok(t.includes(kr(w, s.value.total)), 'company value incl. cash');
  assert.ok(t.includes(kr(w, s.profit.total)), 'profit total');
  assert.ok(t.includes(kr(w, s.profit.ytd)), 'profit this year');
  assert.match(t, /Cash vs invested/);
  assert.ok(t.includes('Alpha') && t.includes('Beta'), 'top holdings');
  assert.match(html, /data-act="print"/);
  assert.match(html, /data-info="total-value"/, 'definitions link');
  assert.deepStrictEqual(errors, []);
});

test('Board competitions line: last finished winner and the live leader', async () => {
  const w = env(); const t = text(await mount(w, book(w)));
  assert.match(t, /Spring[^.]*Team Fox[^.]*12,5%/);
  assert.match(t, /Autumn[^.]*Team Owl[^.]*[−-]3,4%/);
  assert.ok(!/ -\d/.test(t), 'true minus only: a hyphen never marks a negative number');
});

test('Board accounting tile: latest closed year, "per the books", result accounts 3000-8999 only', async () => {
  const w = env(); const t = text(await mount(w, book(w)));
  assert.match(t, /per the books, 2024/, 'the current year is not closed');
  assert.ok(t.includes(kr(w, 5500)), '-(-9000 + 4000 - 500) = 5 500 kr; accounts outside 3000-8999 left out');
});

test('Board hides blocks it has no data for and never throws', async () => {
  const forbidden = new Error('Sheets API 403: PERMISSION_DENIED');
  const cases = {
    'accounting 403': [env({ sheet: { listTabs: async () => { throw forbidden; } } }), /per the books/],
    'no SB tab': [env({ tabs: ['INDEX'] }), /per the books/],
    'only the current year': [env({ tabs: [`SB, ${String(thisYear).slice(2)}`, `HB, ${String(thisYear).slice(2)}`] }), /per the books/],
    'competitions fail': [env({ competitions: new Error('boom') }), /Competitions/],
    'no competitions': [env({ competitions: [] }), /Competitions/],
  };
  for (const [name, [w, gone]] of Object.entries(cases)) {
    const t = text(await mount(w, book(w)));
    assert.ok(!gone.test(t), `${name}: block hidden`);
    assert.match(t, /Company value/, `${name}: rest still shows`);
  }
});

test('Board with an empty store shows a plain empty state, no stale chip, no top list', async () => {
  const errors = [];
  const w = env({ errors, competitions: [], tabs: ['INDEX'] }); const html = await mount(w, emptyStore(w)); const t = text(html);
  assert.match(t, /Board overview/);
  assert.match(html, /empty-state/);
  assert.ok(!/Company value|Top holdings|old prices/.test(t));
  assert.deepStrictEqual(errors, []);
});

test('Board with an empty store still shows the accounting result when the books answer', async () => {
  const w = env({ competitions: [] }); const t = text(await mount(w, emptyStore(w)));
  assert.match(t, /per the books, 2024/);
  assert.ok(!/Company value/.test(t));
});

test('Board prices chip: fresh vs stale count from the summary', async () => {
  const w = env(); const fresh = text(await mount(w, book(w)));
  assert.match(fresh, /Prices up to date/);
  const w2 = env(); const store = book(w2, { stale: true });
  const t = text(await mount(w2, store));
  assert.ok(w2.Portfolio.summary(store).staleCount > 0);
  assert.match(t, new RegExp(`${w2.Portfolio.summary(store).staleCount} holdings? with old prices`));
});

test('Board shows the session box when the session ended while loading', async () => {
  const gone = Object.assign(new Error('unauthenticated'), { code: 'unauthenticated' });
  const w = env({ competitions: gone, errors: [] });
  w.UI.isSessionExpired = (e) => !!e && e.code === 'unauthenticated';
  w.dispatchEvent = () => {};
  const html = await mount(w, book(w));
  assert.match(html, /session expired/);
});

test('Accounting.resultForYear and latestClosedYear', () => {
  const w = env(); const A = w.Accounting;
  const sb = A.parseSaldobalanse(SB);
  assert.strictEqual(A.resultForYear(sb).result, 5500);
  assert.strictEqual(A.resultForYear([{ kontonr: 1920, ub: 5 }]), null, 'no result accounts');
  assert.strictEqual(A.resultForYear([]), null);
  const years = [{ year: 2026 }, { year: 2025 }, { year: 2024 }];
  assert.strictEqual(A.latestClosedYear(years, '2026-10-28').year, 2025);
  assert.strictEqual(A.latestClosedYear([{ year: 2026 }], '2026-10-28'), null);
  assert.strictEqual(A.latestClosedYear([], '2026-10-28'), null);
});

// "What the businesses earn us": KPI rows from the sheet. Alpha holds 10 shares at 12, Beta 10 at 20.
const kpi = (company, period, eps, profit, note = null) => ({ company, period, currency: 'NOK', eps, yourProfitNok: profit, note });
const KPIS = [kpi('Alpha', 'Q2 2026', '2,00 NOK', 100, 'Raised the dividend'), kpi('Beta', 'Q2 2026', '3,00 NOK', 50), kpi('Alpha', 'Q2 2025', '1,00 NOK', 80), kpi('Beta', 'Q2 2025', '1,00 NOK', 70)];

test('Board KPI block: numbers are Portfolio.summary().earnings, "as entered in the sheet", details line, no errors', async () => {
  const errors = [];
  const w = env({ errors }); const store = book(w); store.kpis = KPIS;
  const e = w.Portfolio.summary(store).earnings;
  const html = await mount(w, store); const t = text(html);
  assert.match(t, /What the businesses earn us/);
  assert.ok(t.includes(kr(w, e.earnings)), 'look-through earnings');
  assert.ok(t.includes(w.Fmt.fmtPct(e.yieldPct, false)), 'earnings yield');
  assert.ok(t.includes(kr(w, e.quarter.now)) && t.includes(kr(w, e.quarter.before)), 'quarter vs same quarter last year');
  assert.match(t, /Q2 2026 profit/);
  assert.match(t, new RegExp(`Portfolio P/E ${w.Fmt.fmtDec(e.pe, 1)}\\. Q2 2026 reported for 2 of 2 holdings`));
  assert.match(t, /as entered in the sheet/);
  assert.match(t, /Alpha\s*:\s*Raised the dividend/, 'note next to the holding');
  assert.match(html, /data-info="business-earnings"/);
  assert.deepStrictEqual(errors, []);
});

test('Board KPI block hides when the sheet has no KPI rows or the quarter has no partner; the quarter number alone hides', async () => {
  const w = env(); const none = text(await mount(w, book(w)));
  assert.ok(!/What the businesses earn us/.test(none));
  const w2 = env(); const store = book(w2); store.kpis = KPIS.slice(0, 2);
  const t = text(await mount(w2, store));
  assert.match(t, /What the businesses earn us/);
  assert.ok(!/Q2 2026 profit/.test(t), 'no same quarter last year: the comparison is hidden');
  assert.match(t, /Q2 2026 reported for 2 of 2/, 'freshness stays');
  const w3 = env(); const empty = emptyStore(w3); empty.kpis = KPIS;
  assert.ok(!/What the businesses earn us/.test(text(await mount(w3, empty))), 'empty store');
});

test('Board escapes the Merknad note: no markup reaches the page', async () => {
  const w = env(); const store = book(w);
  store.kpis = [kpi('Alpha', 'Q2 2026', '2,00 NOK', 1, '<img src=x onerror=alert(1)>')];
  const html = await mount(w, store);
  assert.ok(!html.includes('<img'), 'raw tag absent');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('Board notes a trade without an exchange rate', async () => {
  const w = env(); const store = book(w);
  store.transactions.push({ security: 'Alpha', type: 'KJØPT', tradeDate: day(3), bookDate: day(3), qty: 1, amount: -10, currency: 'USD' });
  assert.ok(w.Portfolio.summary(store).missingFx > 0);
  assert.match(text(await mount(w, store)), /foreign currency has no exchange rate yet/);
  const w2 = env(); assert.ok(!/exchange rate/.test(text(await mount(w2, book(w2)))));
});

test('the info buttons in the earnings block have different screen-reader names, and the quarter says "our share"', async () => {
  const w = env(); const store = book(w); store.kpis = KPIS;
  const html = await mount(w, store);
  const block = html.slice(html.indexOf('What the businesses earn us'), html.indexOf('</section>', html.indexOf('What the businesses earn us')));
  const labels = [...block.matchAll(/aria-label="(How is [^"]+)"/g)].map((m) => m[1]);
  assert.ok(labels.length >= 3, labels.join(' | '));
  assert.strictEqual(new Set(labels).size, labels.length, 'no two buttons share a name: ' + labels.join(' | '));
  assert.match(block, /Q2 2026 profit, our share/);
});

test('without an accounting sheet the result tile comes from the calculated books, labelled so', async () => {
  const errors = [];
  const w = env({ errors });
  w.PORTAL_CONFIG.ACCOUNTING_SHEET_ID = '';
  const last = thisYear - 1;
  // A calculated year whose result accounts sum to -1500 (a profit of 1 500).
  w.CalculatedBooks = { load: async () => ({ years: new Map([[last, { sb: [{ kontonr: 1920, ub: 1500 }, { kontonr: 8078, ub: -1500 }] }], [thisYear, { sb: [{ kontonr: 8078, ub: -7 }] }]]) }) };
  w.Sheet.listTabs = async () => { throw new Error('the accounting sheet must not be read'); };
  const store = book(w);
  const t = text(await mount(w, store));
  assert.match(t, /Accounting result/);
  assert.ok(t.includes(kr(w, 1500)), 'the latest closed year, not the running one');
  assert.match(t, new RegExp(`calculated from raw data, ${last}`));
  assert.deepStrictEqual(errors, []);
});
