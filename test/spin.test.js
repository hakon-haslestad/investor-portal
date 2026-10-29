const test = require('node:test');
const assert = require('node:assert');
const { context, load } = require('./harness');

// A DOM stub just rich enough for the spin/guess mount path.
function fakeEl() {
  const el = {
    innerHTML: '',
    _handlers: {},
    querySelector: () => ({ addEventListener() {}, appendChild() {}, disabled: false, textContent: '' }),
    querySelectorAll: () => [],
    addEventListener() {},
  };
  return el;
}

function spinCtx(chartableSecurities) {
  const w = context([], {
    Fmt: { fmtNok: String, fmtPct: String, escapeHtml: String, pctClass: () => '' },
    UI: { esc: String, emptyState: (t, h) => `EMPTY:${t}|${h}` },
    Charts: { priceChart: () => ({}) },
  });
  load(w, 'games/spin-the-stock.js');
  const pool = {
    priceSeriesForSecurity: (sec) => ({ points: [], markers: [], sec }),
    // Only the named securities have enough history to chart.
    chartable: (s) => chartableSecurities.includes(s.sec),
    holdingText: () => '1 yr',
  };
  return { w, pool };
}

const T = (security) => ({
  security, investors: [{ code: 'HH', name: 'H' }], investorName: 'H',
  pnlNok: 1, pnlPct: 1, purchaseAmount: 100, currentOrSoldValue: 101,
  sold: false, from: '2024-01-01', to: '2024-12-31', win: true, investor: 'HH',
});

test('Guess the stock only draws stocks it can actually show a chart for', () => {
  const { w, pool } = spinCtx(['Alpha']);
  const el = fakeEl();
  const game = w.GameSpinTheStock({ guess: true });
  game.mount(el, {
    trades: [T('Alpha'), T('Beta'), T('Gamma')],
    pool, rng: w.window.GameRng ? w.GameRng(1) : { pick: (a) => a[0] },
    soberMode: false,
  });
  // Two of the three had no usable history and are reported as left out.
  assert.match(el.innerHTML, /2 stocks left out/);
  assert.match(el.innerHTML, /not enough price history to guess from/);
});

test('Guess the stock says so plainly when nothing in the period is chartable', () => {
  const { w, pool } = spinCtx([]);
  const el = fakeEl();
  const game = w.GameSpinTheStock({ guess: true });
  const inst = game.mount(el, {
    trades: [T('Alpha'), T('Beta')],
    pool, rng: { pick: (a) => a[0] }, soberMode: false,
  });
  assert.match(el.innerHTML, /^EMPTY:Nothing to guess from in this period/);
  assert.equal(typeof inst.destroy, 'function', 'still returns a usable instance');
});

test('Spin the stock is NOT filtered — a chartless stock is still a fine draw', () => {
  const { w, pool } = spinCtx([]);
  const el = fakeEl();
  const game = w.GameSpinTheStock({ guess: false });
  game.mount(el, {
    trades: [T('Alpha'), T('Beta')],
    pool, rng: { pick: (a) => a[0] }, soberMode: false,
  });
  assert.ok(!el.innerHTML.startsWith('EMPTY:'), 'spin still works without charts');
  assert.ok(!/left out/.test(el.innerHTML), 'and says nothing about exclusions');
});
