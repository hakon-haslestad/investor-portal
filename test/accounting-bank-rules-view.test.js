const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const { baseWindow, load } = require('./harness');

// Mounts the real Accounting view with a closed synthetic year (2019) and
// checks the "Test the rules against the books" panel. Made-up names only.
const Y = 2031; // the "current" year of the stub; 2019 is closed
const SB_HEAD = ['Kontonr', 'Kontonavn', 'IB', 'UB'];
const HB_HEAD = ['Kontonr', 'Kontonavn', 'Bilagsnr', 'Bilagsdato', 'Kommentar', 'Debet', 'Kredit'];
const DNB_HEAD = ['Year', 'Bokført dato', 'Transaksjonstype', 'Forklarende tekst', 'Ut', 'Inn'];
const bilag = (nr, date, amt, counter, out) => (out
  ? [[counter, 'x', nr, date, '', amt, ''], [1920, 'Bank', nr, date, '', '', amt]]
  : [[1920, 'Bank', nr, date, '', amt, ''], [counter, 'x', nr, date, '', '', amt]]);

const dnb = [DNB_HEAD,
  [2019, '2019-01-10', 'Giro', 'Alva Testsen', '', 1500],
  [2019, '2019-01-11', 'Giro', 'Dag <b>Utenfor</b>', '', 700],
  [2019, '2019-01-12', 'Omkostninger', 'Gebyr', 20, ''],
  [2019, '2019-01-13', 'Giro', 'Overf Nordnt', 400, ''],
  [2031, '2031-01-10', 'Giro', 'Alva Testsen', '', 1500]];
const hb19 = [HB_HEAD, ...bilag('B1', '2019-01-10', 1500, 2250), ...bilag('B2', '2019-01-11', 700, 2250),
  ...bilag('B3', '2019-01-12', 20, 8179, true), ...bilag('B4', '2019-01-13', 400, 1921, true)];

const tabsData = {
  'SB, 31': [SB_HEAD, [1920, 'Bank', 0, 5]], 'HB, 31': [HB_HEAD],
  'SB, 19': [SB_HEAD, [1920, 'Bank', 0, 5]], 'HB, 19': hb19,
  'SB, 18': [SB_HEAD, [1920, 'Bank', 0, 5]], 'HB, 18': [HB_HEAD],
  DNB_raw: dnb,
  Aliases: [['Code', 'Alias'], ['AT', 'Alva Testsen']],
};

async function mount({ year, omit = [] }) {
  const data = { ...tabsData, 'DNB_raw': [...dnb, [2018, '2018-05-05', 'Giro', 'Alva Testsen', '', 100]] };
  const tabs = Object.keys(data).filter((t) => !omit.includes(t)).map((title) => ({ title }));
  const w = baseWindow({
    Views: {},
    PORTAL_CONFIG: { ACCOUNTING_SHEET_ID: 's', ACCOUNTING_TABS: { dnbRaw: 'DNB_raw', nordnetRaw: 'Nordnet_raw' }, ACCOUNTING_CURRENT_YEAR: Y },
    Auth: { getEmail: () => 'test@example.test' },
    UI: { skeleton: () => '<div class="skeleton-wrap">Loading…</div>', infoIcon: () => '', table: (cols, rows) => `<table>${rows.map((r) => `<tr>${r.join('|')}</tr>`).join('')}</table>` },
    Sheet: { listTabs: async () => tabs, batchGet: async (names) => Object.fromEntries(names.map((n) => [n, data[n]])) },
  });
  vm.createContext(w);
  load(w, 'parsers.js', 'format.js', 'bank-rules.js', 'accounting.js', 'books.js', 'calculated-books.js', 'views/accounting.js');
  w.localStorage.setItem('portal.accounting.year', String(year));
  const node = () => ({ innerHTML: '', textContent: '', style: {}, querySelectorAll: () => [], querySelector: () => ({ addEventListener() {} }) });
  const kids = { '#acc-root': node(), '#year-picker-mount': node(), '#meta-line': node() };
  await w.Views.accounting({ innerHTML: '', querySelector: (s) => kids[s] }, { me: { displayName: 'Tester' } });
  for (let i = 0; i < 50 && /Loading/.test(kids['#acc-root'].innerHTML); i++) await new Promise((r) => setImmediate(r));
  return kids['#acc-root'].innerHTML;
}

test('closed year: N of M, label, scope note and the mismatch under its cause', async () => {
  const html = await mount({ year: 2019 });
  assert.match(html, /Test the rules against the books/);
  assert.match(html, /2 of 4 bank lines go to the same account as the books/);
  assert.match(html, /Automatic rules, not accountant-reviewed/);
  assert.match(html, /Covers bank lines only\. Nordnet and year-end entries come in later steps\./);
  const unknown = html.slice(html.indexOf('Unknown payer'), html.indexOf('Fee account'));
  assert.match(unknown, /2019-01-11[^]*700/);
  assert.match(html.slice(html.indexOf('Fee account')), /fee account to confirm[^]*2019-01-12[^]*7700[^]*8179/i);
  assert.doesNotMatch(unknown, /2019-01-10/);
});

test('bank text is escaped', async () => {
  const html = await mount({ year: 2019 });
  assert.match(html, /Dag &lt;b&gt;Utenfor&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>Utenfor/);
});

test('without the Aliases tab nobody is a known payer, and the view still renders', async () => {
  const html = await mount({ year: 2019, omit: ['Aliases'] });
  assert.match(html, /1 of 4 bank lines go to the same account/);
});

test('a closed year without ledger rows says so', async () => {
  const html = await mount({ year: 2018 });
  assert.match(html, /No ledger for this year/);
  assert.doesNotMatch(html, /bank lines go to the same account/);
});

test('the current year gets no panel', async () => {
  const html = await mount({ year: 2031 });
  assert.doesNotMatch(html, /Test the rules against the books/);
});
