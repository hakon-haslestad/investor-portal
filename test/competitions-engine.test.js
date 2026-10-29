const test = require('node:test');
const assert = require('node:assert');
const { context, load } = require('./harness');

// Ledger/Portfolio stand-ins: each security belongs to one investor (named in
// `owners`), amounts are NOK as on Nordnet (buys negative, sells positive), and
// end prices are NOK per share.
function engine(owners, endPrices) {
  const w = context([], {
    Ledger: {
      INVESTOR_CODES: ['HH', 'HS', 'ØS', 'JC', 'HF'],
      classify: (type) => (type === 'UTBYTTE' ? 'DIVIDEND' : type),
      splitForSecurity: (map, sec) => [{ code: owners[sec], weight: 1 }],
      amountNok: (tx) => tx.amount,
    },
    Portfolio: {
      canonicalName: (s) => s,
      pricesAtDate: () => new Map(Object.entries(endPrices).map(([sec, price]) => [sec, { price }])),
      snapshotForDate: (store, d) => d,
    },
  });
  load(w, 'competitions-engine.js');
  return w.CompetitionEngine;
}

const buy = (security, qty, amount, tradeDate = '2026-01-10') => ({ type: 'KJØPT', security, qty, amount: -amount, tradeDate });
const sell = (security, qty, amount, tradeDate = '2026-02-10') => ({ type: 'SALG', security, qty, amount, tradeDate });
const comp = { id: 'c1', start_date: '2026-01-01', end_date: '2026-03-31' };
const solo = (code, buyIn) => ({ investor_code: code, team_label: code, buy_in_nok: buyIn });

test('the winner is the highest gain on the budget, not on what was invested', () => {
  // HH invests 5k of 50k and gains 1k (+20 % on invested, +2 % on budget).
  // HS invests the full 50k and gains 8k (+16 % on invested, +16 % on budget).
  const { scoreCompetition } = engine({ A: 'HH', B: 'HS' }, { A: 60, B: 116 });
  const store = { attributionMap: {}, transactions: [buy('A', 100, 5000), buy('B', 500, 50000)] };
  const s = scoreCompetition(store, comp, [solo('HH', 50000), solo('HS', 50000)]);

  assert.strictEqual(s.ranks.map((r) => r.code).join(), 'HS,HH');
  assert.strictEqual(s.teams.map((t) => t.label).join(), 'HS,HH');
  assert.strictEqual(Math.round(s.teams[0].pct * 10) / 10, 16);
  assert.strictEqual(Math.round(s.teams[1].pct * 10) / 10, 2);
  assert.strictEqual(s.teams[0].pctBase, 'buyIn');
  // Net invested is still reported, just not the ranking base.
  assert.strictEqual(s.ranks[1].amountSpent, 5000);
});

test('a team is measured on its shared budget once', () => {
  const { scoreCompetition } = engine({ A: 'JC', B: 'ØS' }, { A: 120, B: 110 });
  const store = { attributionMap: {}, transactions: [buy('A', 100, 10000), buy('B', 100, 10000)] };
  const team = (code) => ({ investor_code: code, team_label: 'JC+ØS', buy_in_nok: 50000 });
  const s = scoreCompetition(store, comp, [team('JC'), team('ØS')]);

  const t = s.teams[0];
  assert.strictEqual(t.buyIn, 50000);
  assert.strictEqual(t.netPnl, 3000);
  assert.strictEqual(t.pct, 6); // 3 000 / 50 000, not / 20 000 invested
});

test('over budget is still divided by the budget, and flagged', () => {
  const { scoreCompetition } = engine({ A: 'HF' }, { A: 66 });
  const store = { attributionMap: {}, transactions: [buy('A', 1000, 60000)] };
  const s = scoreCompetition(store, comp, [solo('HF', 50000)]);

  const t = s.teams[0];
  assert.strictEqual(t.overSpent, true);
  assert.strictEqual(t.overSpentBy, 10000);
  assert.strictEqual(t.pct, 12); // 6 000 / 50 000
});

test('with no budget set, the return falls back to net invested', () => {
  const { scoreCompetition } = engine({ A: 'HH' }, { A: 110 });
  const store = { attributionMap: {}, transactions: [buy('A', 100, 10000)] };
  const s = scoreCompetition(store, comp, [solo('HH', 0)]);

  assert.strictEqual(s.teams[0].pctBase, 'invested');
  assert.strictEqual(s.ranks[0].pctBase, 'invested');
  assert.strictEqual(s.teams[0].pct, 10);
});

test('a net seller is measured on the budget too', () => {
  // Buys 10k, sells everything for 15k: net invested is 0, gain 5k.
  const { scoreCompetition } = engine({ A: 'HS' }, { A: 150 });
  const store = { attributionMap: {}, transactions: [buy('A', 100, 10000), sell('A', 100, 15000)] };
  const s = scoreCompetition(store, comp, [solo('HS', 50000)]);

  assert.strictEqual(s.ranks[0].amountSpent, 0);
  assert.strictEqual(s.ranks[0].netPnl, 5000);
  assert.strictEqual(s.ranks[0].pct, 10);
});

// Edge cases: what the window does and does not count.
const run = (owners, prices, txs, parts = [solo('HH', 50000)]) =>
  engine(owners, prices).scoreCompetition({ attributionMap: {}, transactions: txs }, comp, parts);

test('a buy before the window, and its sell inside it, are ignored', () => {
  const s = run({ A: 'HH' }, { A: 150 }, [buy('A', 100, 10000, '2025-12-01'), sell('A', 100, 15000)]);
  assert.strictEqual(s.ranks[0].grossBought, 0);
  assert.strictEqual(s.ranks[0].sellProceeds, 0);
  assert.strictEqual(s.ranks[0].netPnl, 0);
});

test('a sell larger than the in-window lot counts only the in-window share, pro-rata', () => {
  // Buys 100 for 10 000, sells 150 for 18 000: 100 of the 150 count, so 12 000 comes back.
  const s = run({ A: 'HH' }, { A: 100 }, [buy('A', 100, 10000), sell('A', 150, 18000)]);
  assert.strictEqual(s.ranks[0].sellProceeds, 12000);
  assert.strictEqual(s.ranks[0].realizedInWindow, 2000);
});

test('a dividend counts only while the shares are held', () => {
  const div = (d, amount) => ({ type: 'UTBYTTE', security: 'A', qty: 0, amount, tradeDate: d });
  const s = run({ A: 'HH' }, { A: 100 }, [
    div('2026-01-05', 700),                      // before the buy
    buy('A', 100, 10000),
    div('2026-02-01', 300),                      // held
    sell('A', 100, 10000, '2026-02-20'),
    div('2026-03-01', 500),                      // after the sale
  ]);
  assert.strictEqual(s.ranks[0].divsInWindow, 300);
});

test('a lot with no end price is valued at cost: neutral, 0 %', () => {
  const s = run({ A: 'HH' }, {}, [buy('A', 100, 10000)]);
  assert.strictEqual(s.ranks[0].unrealizedAtEnd, 0);
  assert.strictEqual(s.teams[0].pct, 0);
});

test('a 0.0 % tie keeps participant order and does not crash', () => {
  const s = run({ A: 'HH', B: 'HS' }, { A: 100, B: 100 },
    [buy('A', 100, 10000), buy('B', 100, 10000)], [solo('HS', 50000), solo('HH', 50000)]);
  assert.deepEqual(s.ranks.map((r) => r.code), ['HS', 'HH']);
  assert.deepEqual(s.teams.map((t) => t.label), ['HS', 'HH']);
});

test('when every team is down, the winner is the least negative', () => {
  const s = run({ A: 'HH', B: 'HS' }, { A: 90, B: 70 },
    [buy('A', 100, 10000), buy('B', 100, 10000)], [solo('HS', 50000), solo('HH', 50000)]);
  assert.deepEqual(s.teams.map((t) => t.label), ['HH', 'HS']);
  assert.ok(s.teams[0].pct < 0 && s.teams[0].pct > s.teams[1].pct);
});

test('trade count: in-window buys and sells, a sell of pre-window shares does not count', () => {
  const { scoreCompetition } = engine({ A: 'HH', B: 'HH' }, { A: 110, B: 100 });
  const store = { attributionMap: {}, transactions: [
    buy('A', 100, 10000), buy('A', 50, 5000, '2026-01-20'), sell('A', 50, 5500),
    sell('B', 10, 1000), // B was never bought in the window
    buy('A', 10, 1000, '2025-12-01'), // before the window
  ] };
  const s = scoreCompetition(store, comp, [solo('HH', 50000)]);
  assert.strictEqual(s.ranks[0].trades, 3);
  assert.strictEqual(s.teams[0].trades, 3);
});

test('trade count: a team counts a trade shared by its members once', () => {
  const w = context([], {
    Ledger: {
      INVESTOR_CODES: ['HH', 'HS', 'ØS', 'JC', 'HF'],
      classify: (type) => type,
      splitForSecurity: () => [{ code: 'JC', weight: 0.5 }, { code: 'ØS', weight: 0.5 }],
      amountNok: (tx) => tx.amount,
    },
    Portfolio: { canonicalName: (s) => s, pricesAtDate: () => new Map([['A', { price: 100 }]]), snapshotForDate: (st, d) => d },
  });
  load(w, 'competitions-engine.js');
  const store = { attributionMap: {}, transactions: [buy('A', 100, 10000), buy('A', 20, 2000, '2026-02-01')] };
  const team = (code) => ({ investor_code: code, team_label: 'JC+ØS', buy_in_nok: 50000 });
  const s = w.CompetitionEngine.scoreCompetition(store, comp, [team('JC'), team('ØS')]);
  assert.strictEqual(s.ranks.map((r) => r.trades).join(), '2,2');
  assert.strictEqual(s.teams[0].trades, 2);
});
