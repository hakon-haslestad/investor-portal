const test = require('node:test');
const assert = require('node:assert');
const { context, load } = require('./harness');

function fakeEl() {
  return {
    innerHTML: '',
    querySelector: () => ({ addEventListener() {}, appendChild() {}, disabled: false, textContent: '', value: '' }),
    querySelectorAll: () => [],
    addEventListener() {},
    insertAdjacentHTML(_pos, html) { this.innerHTML += html; },
  };
}

const TX = [
  { tradeDate: '2024-01-10', type: 'KJØPT', security: 'Alpha', qty: 100, price: 80, currency: 'NOK' },
  { tradeDate: '2024-05-01', type: 'SALG', security: 'Alpha', qty: -50, price: 120, currency: 'NOK', nordnetId: 'a' },
];

function mountAsk(players) {
  const w = context(['games/back-trading-verdict.js'], {
    Fmt: {
      fmtNok: (n) => `${Math.round(n)} kr`, fmtPct: (n) => `${Number(n).toFixed(1)}%`,
      escapeHtml: (s) => String(s), pctClass: () => 'positive',
    },
    UI: { emptyState: (t) => `EMPTY:${t}`, table: () => '<table></table>', section: () => '' },
    Charts: { priceChart: () => ({}) },
    Positions: {
      bySecurity: () => new Map([['alpha', { dates: ['2024-01-10', '2024-05-01'] }]]),
      stateAt: () => ({ qty: 100, costSum: 8000, realized: 0 }),
    },
    Ledger: { isRealizingSell: (t) => t === 'SALG', splitForSecurity: () => [{ code: 'HH' }] },
  });
  load(w, 'games/back-trading.js');
  const el = fakeEl();
  // A long, healthy post-exit series so the trade is judgeable.
  const points = [...Array(200)].map((_, i) => ({
    date: new Date(Date.UTC(2024, 4, 2 + i)).toISOString().slice(0, 10), price: 130,
  }));
  w.GameBackTrading.mount(el, {
    players,
    soberMode: false,
    rng: { pick: (a) => a[0] },
    pool: {
      store: { transactions: TX, attributionMap: {} },
      canon: (s) => String(s).toLowerCase(),
      names: { HH: 'Hakon', JC: 'Jonas', 'ØS': 'Øystein' },
      priceSeriesForSecurity: () => ({ points, markers: [] }),
      holdingText: () => '4 mo',
    },
    history: { add() {}, list: () => [] },
    competitionId: '',
  });
  return el.innerHTML;
}

const ROSTER = [{ code: 'HH', name: 'Hakon' }, { code: 'JC', name: 'Jonas' }, { code: 'ØS', name: 'Øystein' }];

test('the trade facts render as one horizontal strip, not a grid of cards', () => {
  const html = mountAsk(ROSTER);
  assert.match(html, /class="bt-facts"/, 'the strip is there');
  assert.ok(!html.includes('detail-grid'), 'the old card grid is gone');
  assert.ok(!html.includes('kpi-card'), 'and so are the KPI cards it held');
  for (const label of ['Entry', 'Exit', 'Realised', 'Held', 'Sold by']) {
    assert.ok(html.includes(`<dt>${label}</dt>`), `${label} is on the strip`);
  }
});

test('every player gets their own column, with both choices under their name', () => {
  const html = mountAsk(ROSTER);
  const cols = html.match(/class="bt-bet [a-z]+" data-player=/g) || [];
  assert.equal(cols.length, 3, 'one column per player');
  for (const p of ROSTER) {
    assert.ok(html.includes(`data-player="${p.code}"`), `${p.code} has a column`);
    assert.ok(html.includes(`<div class="bt-bet-who">${p.name}</div>`),
      `${p.name} is the heading of their own column`);
  }
  // Two choices each, and the name comes BEFORE them in the markup.
  assert.equal((html.match(/data-bet="hold"/g) || []).length, 3);
  assert.equal((html.match(/data-bet="sell"/g) || []).length, 3);
  assert.ok(html.indexOf('bt-bet-who') < html.indexOf('data-bet='),
    'the player name sits above their choice');
});

test('a column shows whether that player has called it yet', () => {
  const html = mountAsk(ROSTER);
  assert.equal((html.match(/class="bt-bet waiting"/g) || []).length, 3,
    'nobody has called it at the start');
  assert.ok(!html.includes('class="bt-bet in"'));
});

test('the choices are real buttons with labels, not bare pills', () => {
  const html = mountAsk(ROSTER);
  assert.match(html, /class="bt-choice"[^>]*data-bet="hold"/);
  assert.match(html, /<span class="bt-choice-label">Hold<\/span>/);
  assert.match(html, /<span class="bt-choice-label">Sell<\/span>/);
  assert.ok(!/data-bet="[a-z]+"[^>]*class="preset/.test(html), 'not reusing the filter-pill style');
});

test('a single player still gets a column rather than a degenerate layout', () => {
  const html = mountAsk([{ code: 'HH', name: 'Hakon' }]);
  assert.equal((html.match(/data-player=/g) || []).length, 1);
  assert.match(html, /class="bt-facts"/);
});

test('reveal is gated until somebody has called it', () => {
  const html = mountAsk(ROSTER);
  assert.match(html, /id="bt-reveal" disabled/);
  assert.ok(html.includes('Everyone place a call first'));
});
