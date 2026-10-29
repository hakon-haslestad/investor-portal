const test = require('node:test');
const assert = require('node:assert');
const { context } = require('./harness');

// Leaderboards rank realized profit (sell price minus average cost) plus
// dividends, never sell proceeds. Synthetic store, fixed `now`.
const { Portfolio } = context(['ledger.js', 'portfolio.js']);
const { buildYtdLeaderboard, buildBestPicks, buildMonthlyLeaderboard } = Portfolio._debug;
const NOW = new Date('2026-06-15T12:00:00Z');
const own = (code) => [{ code, weight: 1 }];
const attributionMap = new Map([
  ['Loser', own('HS')], ['Winner', own('HH')], ['Flat', own('HF')], ['Old', own('ØS')],
  ['Big', own('HS')], ['Small', own('HS')], ['Unpriced', own('JC')],
]);
const tx = (security, type, tradeDate, qty, amount) => ({ security, type, tradeDate, qty, amount, currency: 'NOK' });
const store = {
  attributionMap,
  transactions: [
    tx('Loser', 'KJØPT', '2025-11-01', 100, -110000),
    tx('Loser', 'SALG', '2026-05-10', 100, 100000), // proceeds 100k, profit -10k
    tx('Winner', 'KJØPT', '2025-11-01', 10, -5000),
    tx('Winner', 'SALG', '2026-05-12', 10, 10000), // proceeds 10k, profit +5k
    tx('Winner', 'UTBYTTE', '2026-04-02', 0, 1000),
    tx('Flat', 'KJØPT', '2026-01-05', 50, -50000),
    tx('Flat', 'SALG', '2026-05-20', 50, 50000), // at cost: 0
    tx('Old', 'KJØPT', '2024-01-05', 10, -1000),
    tx('Old', 'SALG', '2025-12-31', 10, 9000), // last year: not YTD
    tx('Big', 'KJØPT', '2026-01-05', 100, -100000),
    tx('Small', 'KJØPT', '2026-01-05', 10, -1000),
    tx('Unpriced', 'KJØPT', '2026-01-05', 10, -10000),
  ],
};
const perInvestor = Object.fromEntries(['HH', 'HS', 'ØS', 'JC', 'HF'].map((c) => [c, { deposits: 100000 }]));
const codes = (rows) => rows.map((r) => r.code);

test('YTD ranks realized profit + dividends as % of deposits, not proceeds', () => {
  const ytd = buildYtdLeaderboard(store, perInvestor, NOW);
  assert.strictEqual(codes(ytd)[0], 'HH');
  assert.strictEqual(codes(ytd).at(-1), 'HS');
  const v = Object.fromEntries(ytd.map((r) => [r.code, r.value]));
  assert.strictEqual(v.HH, 6); // (+5k profit +1k dividend) / 100k
  assert.strictEqual(v.HS, -10); // sold 100k but lost 10k
  assert.strictEqual(v.HF, 0); // sale at cost
  assert.strictEqual(v['ØS'], 0); // last year's sale left out
});

test('monthly ranks by realized profit + dividends in NOK and carries % of deposits', () => {
  const months = buildMonthlyLeaderboard(store, perInvestor, NOW);
  assert.deepStrictEqual([...months.map((m) => m.month)], ['2026-06', '2026-05', '2026-04', '2026-03', '2026-02', '2026-01']);
  const may = months[1].ranks;
  assert.deepStrictEqual([may[0].code, may.at(-1).code], ['HH', 'HS']);
  assert.deepStrictEqual([may[0].value, may[0].pct], [5000, 5]);
  assert.strictEqual(may.at(-1).value, -10000);
  assert.strictEqual(months[2].ranks[0].value, 1000); // April: the dividend
  assert.ok(!months.some((m) => m.month === '2025-12'));
});

test('best single bet ranks by %, skips an unpriced holding, null pick sorts last', () => {
  const holdings = [
    { security: 'Big', market_value_nok: 150000, priced: true }, // +50k = 50%
    { security: 'Small', market_value_nok: 3000, priced: true }, // +2k = 200%
    { security: 'Unpriced', market_value_nok: null, priced: false },
  ];
  const picks = buildBestPicks(store, holdings);
  const hs = picks.find((p) => p.code === 'HS').pick;
  assert.strictEqual(hs.security, 'Small');
  assert.strictEqual(hs.pct, 200);
  assert.strictEqual(picks.find((p) => p.code === 'JC').pick, null); // only an unpriced holding
  assert.deepStrictEqual([...codes(picks)], ['ØS', 'HS', 'HH', 'HF', 'JC']); // 800, 200, 120, 0 %, none
  assert.strictEqual(picks.at(-1).pick, null);
});

test('partial sell uses average cost; a split trade is shared by weight', () => {
  const shared = {
    attributionMap: new Map([['Shared', [{ code: 'HH', weight: 0.5 }, { code: 'HS', weight: 0.5 }]]]),
    transactions: [
      tx('Shared', 'KJØPT', '2026-01-05', 10, -1000),
      tx('Shared', 'KJØPT', '2026-02-05', 10, -3000), // average cost 200 a share
      tx('Shared', 'SALG', '2026-03-05', 5, 1500), // 1500 - 5 x 200 = +500
      tx('Shared', 'SALG', '2026-07-01', 5, 9999), // dated after now: left out
    ],
  };
  const v = Object.fromEntries(buildYtdLeaderboard(shared, perInvestor, NOW).map((r) => [r.code, r.value]));
  assert.strictEqual(v.HH, 0.25); // +250 of 100k
  assert.strictEqual(v.HS, 0.25);
  assert.strictEqual(v.JC, 0);
});

test('deposits of 0 or NaN give 0 % for YTD and monthly', () => {
  for (const deposits of [0, NaN]) {
    const bad = Object.fromEntries(Object.keys(perInvestor).map((c) => [c, { deposits }]));
    assert.ok(buildYtdLeaderboard(store, bad, NOW).every((r) => r.value === 0));
    assert.ok(buildMonthlyLeaderboard(store, bad, NOW).every((m) => m.ranks.every((r) => r.pct === 0)));
  }
});
