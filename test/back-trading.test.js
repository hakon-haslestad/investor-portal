const test = require('node:test');
const assert = require('node:assert');
const { context } = require('./harness');

const V = () => context(['games/back-trading-verdict.js']).BackTradingVerdict;

const DAY = 86400000;
const addDays = (iso, n) => new Date(Date.parse(iso) + n * DAY).toISOString().slice(0, 10);

// A daily series starting the day after exit, priced by a function of day index.
function dailySeries(exitDate, n, priceAt) {
  return [...Array(n)].map((_, i) => ({ date: addDays(exitDate, i + 1), price: priceAt(i + 1) }));
}

test('verdict thresholds sit exactly where the brief puts them', () => {
  const v = V();
  assert.equal(v.verdictOf(-0.05), 'good-sell');
  assert.equal(v.verdictOf(-0.0201), 'good-sell');
  assert.equal(v.verdictOf(-0.02), 'neutral', '-2% is the inclusive edge of neutral');
  assert.equal(v.verdictOf(0), 'neutral');
  assert.equal(v.verdictOf(0.02), 'neutral', '+2% is the inclusive edge of neutral');
  assert.equal(v.verdictOf(0.0201), 'too-early');
  assert.equal(v.verdictOf(0.5), 'too-early');
});

test('a price that kept climbing reads as sold too early', () => {
  const v = V();
  const exitDate = '2024-01-01';
  const series = dailySeries(exitDate, 400, (i) => 100 * (1 + i * 0.002));
  const r = v.verdictFor({ exitDate, exitPrice: 100, qty: 10 }, series, '2025-06-01');
  assert.equal(r.overall, 'too-early');
  // The headline verdict comes from the LATEST close we have, not a fixed
  // horizon — "has it gone up since you sold?" is the question being asked.
  assert.equal(r.overall, r.latest.verdict);
  assert.equal(r.latest.date, series[series.length - 1].date);
  assert.equal(r.overallDays, r.latest.daysAfter);
  assert.deepEqual(r.horizons.map((h) => h.days), [5, 20, 60, 120, 250],
    'the strip still shows every horizon that resolved');
  assert.ok(r.missedMoney > 0, 'there was money left on the table');
  assert.equal(r.moneySaved, 0);
  assert.ok(r.oneYear && r.oneYear.pct > 0);
});

test('a price that collapsed reads as a good sell, and reports money saved', () => {
  const v = V();
  const exitDate = '2024-01-01';
  const series = dailySeries(exitDate, 400, (i) => 100 * (1 - i * 0.001));
  const r = v.verdictFor({ exitDate, exitPrice: 100, qty: 10 }, series, '2025-06-01');
  assert.equal(r.overall, 'good-sell');
  assert.ok(r.moneySaved > 0, 'worst case avoided');
  assert.equal(r.missedMoney, 0, 'nothing was missed — it only went down');
  assert.ok(r.minAfter.value < 0);
});

test('horizons reaching into the future are skipped, not guessed', () => {
  const v = V();
  const exitDate = '2024-01-01';
  // Only ~40 calendar days of data, and "today" is 40 days after exit.
  const series = dailySeries(exitDate, 40, () => 105);
  const r = v.verdictFor({ exitDate, exitPrice: 100, qty: 1 }, series, addDays(exitDate, 40));
  assert.deepEqual(r.horizons.map((h) => h.days), [5, 20], 'only horizons that have happened');
  assert.equal(r.overall, r.latest.verdict, 'still judged, from the latest close');
  assert.equal(r.oneYear, null);
});

test('the verdict can flip across horizons, and the strip shows it', () => {
  const v = V();
  const exitDate = '2024-01-01';
  // Dips early (good sell), recovers strongly later (too early).
  const series = dailySeries(exitDate, 400, (i) => (i < 40 ? 90 : 100 + i * 0.2));
  const r = v.verdictFor({ exitDate, exitPrice: 100, qty: 1 }, series, '2025-06-01');
  const byDays = Object.fromEntries(r.horizons.map((h) => [h.days, h.verdict]));
  assert.equal(byDays[5], 'good-sell');
  assert.equal(byDays[20], 'good-sell');
  assert.equal(byDays[250], 'too-early');
  assert.ok(new Set(r.horizons.map((h) => h.verdict)).size > 1, 'the strip is worth showing');
});

test('weekly data is flagged stale rather than passed off as exact', () => {
  const v = V();
  const exitDate = '2024-01-01';
  // One close a week — what the feed actually stores for a sold stock. The
  // fetch runs on a fixed weekday, so the points do not line up with horizons
  // measured from an arbitrary exit date.
  const series = [...Array(30)].map((_, i) => ({ date: addDays(exitDate, 3 + i * 7), price: 110 }));
  const r = v.verdictFor({ exitDate, exitPrice: 100, qty: 1 }, series, '2025-06-01');
  assert.ok(r.horizons.length > 0);
  assert.ok(r.flags.includes('stale-resolution'), 'the staleness is surfaced');
  const h5 = r.horizons.find((h) => h.days === 5);
  assert.ok(h5, '5-day horizon still resolves');
  assert.ok(h5.date <= h5.targetDate, 'resolved on or before the target');
  assert.ok(h5.stale, 'and says it had to reach back for the close');
  assert.ok(h5.staleByDays > 0);
});

test('a horizon beyond where the data stops is dropped, not resolved to a stale close', () => {
  const v = V();
  const exitDate = '2024-01-01';
  // Six months of daily data, then nothing — the feed's expiry behaviour.
  const series = dailySeries(exitDate, 183, () => 130);
  const r = v.verdictFor({ exitDate, exitPrice: 100, qty: 1 }, series, '2025-06-01');
  const days = r.horizons.map((h) => h.days);
  assert.ok(days.includes(120), '120 days is within the ~183 available');
  assert.ok(!days.includes(250), '250 days is past the data and must not be reported');
  assert.equal(r.oneYear, null, 'no one-year panel without one-year data');
  assert.equal(r.coverageTo, addDays(exitDate, 183));
});

test('no data after the exit yields a flag, not a crash', () => {
  const v = V();
  const r = v.verdictFor({ exitDate: '2024-01-01', exitPrice: 100, qty: 1 }, [], '2025-01-01');
  assert.deepEqual(r.horizons, []);
  assert.ok(r.flags.includes('no-data-after-exit'));
  assert.equal(r.overall, null);

  const before = [{ date: '2023-06-01', price: 90 }];
  const r2 = v.verdictFor({ exitDate: '2024-01-01', exitPrice: 100, qty: 1 }, before, '2025-01-01');
  assert.ok(r2.flags.includes('no-data-after-exit'), 'prices before the exit do not count');
});

test('a missing or nonsense exit price is refused rather than divided by', () => {
  const v = V();
  for (const bad of [undefined, 0, -5, NaN]) {
    const r = v.verdictFor({ exitDate: '2024-01-01', exitPrice: bad, qty: 1 }, [{ date: '2024-02-01', price: 10 }]);
    assert.ok(r.flags.includes('no-exit-price'), `exitPrice ${bad}`);
    assert.deepEqual(r.horizons, []);
  }
  assert.ok(v.verdictFor(null, []).flags.includes('no-exit-price'));
});

test('a wild price ratio is flagged as a possible split, never silently corrected', () => {
  const v = V();
  const exitDate = '2024-01-01';
  const series = dailySeries(exitDate, 200, () => 25); // 100 -> 25 looks like a 4:1 split
  const r = v.verdictFor({ exitDate, exitPrice: 100, qty: 1 }, series, '2025-06-01');
  assert.ok(r.flags.includes('possible-split'));
  assert.equal(r.overall, 'good-sell', 'the number is still reported, with the caveat attached');
});

test('scoring: neutral is correct either way', () => {
  const v = V();
  assert.equal(v.scoreAnswer(true, 'too-early'), true, 'held, and it ran — right');
  assert.equal(v.scoreAnswer(false, 'too-early'), false);
  assert.equal(v.scoreAnswer(false, 'good-sell'), true, 'sold, and it fell — right');
  assert.equal(v.scoreAnswer(true, 'good-sell'), false);
  assert.equal(v.scoreAnswer(true, 'neutral'), true);
  assert.equal(v.scoreAnswer(false, 'neutral'), true);
});

test('a trade closed days ago reports how long until it is playable', () => {
  const v = V();
  const today = '2024-03-10';
  assert.equal(v.daysUntilPlayable('2024-03-09', today), 6);
  assert.equal(v.daysUntilPlayable('2024-01-01', today), 0, 'long-closed trades are playable now');
});

test('missed money and money saved scale with quantity and exit price', () => {
  const v = V();
  const exitDate = '2024-01-01';
  const series = dailySeries(exitDate, 200, (i) => (i < 100 ? 150 : 50));
  const r = v.verdictFor({ exitDate, exitPrice: 100, qty: 10 }, series, '2025-06-01');
  // Peak +50% on a 10 x 100 = 1000 notional.
  assert.ok(Math.abs(r.missedMoney - 500) < 1, `missed ${r.missedMoney}`);
  assert.ok(Math.abs(r.moneySaved - 500) < 1, `saved ${r.moneySaved}`);
  assert.equal(r.maxAfter.date, addDays(exitDate, 1));
});

// ── closedTrades: one trade per realizing sell ──────────────────────────────
const { load } = require('./harness');

function btCtx(transactions) {
  const w = context(['games/back-trading-verdict.js'], {
    // back-trading.js destructures these at load, as every view in this repo
    // does; in the browser they are loaded before the games.
    Fmt: {
      fmtNok: (n) => String(n), fmtPct: (n) => String(n),
      escapeHtml: (s) => String(s), pctClass: () => '',
    },
    Positions: {
      bySecurity: () => new Map([['alpha', 'STATE']]),
      // Average cost of 80 before any sell.
      stateAt: () => ({ qty: 100, costSum: 8000, realized: 0 }),
    },
    Ledger: {
      isRealizingSell: (t) => t === 'SALG',
      splitForSecurity: () => [{ code: 'HH', weight: 1 }],
    },
  });
  load(w, 'games/back-trading.js');
  const pool = {
    store: { transactions, attributionMap: {} },
    canon: (s) => String(s).toLowerCase(),
    names: { HH: 'Hakon' },
  };
  return w.GameBackTrading.closedTrades(pool, '2025-01-01');
}

test('each realizing sell becomes its own trade, so partial exits both count', () => {
  const trades = btCtx([
    { tradeDate: '2024-02-01', type: 'KJØPT', security: 'Alpha', qty: 100, price: 80, currency: 'NOK' },
    { tradeDate: '2024-05-01', type: 'SALG', security: 'Alpha', qty: -40, price: 120, currency: 'NOK', nordnetId: 'a' },
    { tradeDate: '2024-08-01', type: 'SALG', security: 'Alpha', qty: -60, price: 90, currency: 'NOK', nordnetId: 'b' },
  ]);
  assert.equal(trades.length, 2, 'two sells, two trades');
  assert.deepEqual(trades.map((t) => t.exitDate), ['2024-08-01', '2024-05-01'], 'newest first');
  assert.equal(trades[1].qty, 40, 'the sold quantity, not the position size');
  assert.equal(trades[0].qty, 60);
  assert.equal(trades[1].exitPrice, 120);
  assert.equal(trades[1].entryPrice, 80, 'average cost from the position replay');
  assert.ok(Math.abs(trades[1].realizedPct - 50) < 1e-9);
});

test('a foreign-currency sell is converted to NOK', () => {
  const trades = btCtx([
    { tradeDate: '2024-05-01', type: 'SALG', security: 'Alpha', qty: -10, price: 100, currency: 'USD', fxRate: 10 },
  ]);
  assert.equal(trades[0].exitPrice, 1000, 'price x fx');
});

test('buys, dividends and zero-quantity rows are not trades', () => {
  const trades = btCtx([
    { tradeDate: '2024-02-01', type: 'KJØPT', security: 'Alpha', qty: 100, price: 80, currency: 'NOK' },
    { tradeDate: '2024-03-01', type: 'UTBYTTE', security: 'Alpha', qty: 0, price: 0, currency: 'NOK' },
    { tradeDate: '2024-04-01', type: 'SALG', security: 'Alpha', qty: 0, price: 100, currency: 'NOK' },
    { tradeDate: '2024-04-02', type: 'SALG', security: 'Alpha', qty: -10, price: 0, currency: 'NOK' },
  ]);
  assert.equal(trades.length, 0, 'only real realizing sells with a quantity and a price');
});

test('a sell inside the 5-day window reports the wait rather than being playable', () => {
  const trades = btCtx([
    { tradeDate: '2024-12-30', type: 'SALG', security: 'Alpha', qty: -10, price: 100, currency: 'NOK' },
    { tradeDate: '2024-01-02', type: 'SALG', security: 'Alpha', qty: -10, price: 100, currency: 'NOK' },
  ]);
  const fresh = trades.find((t) => t.exitDate === '2024-12-30');
  const old = trades.find((t) => t.exitDate === '2024-01-02');
  assert.ok(fresh.daysUntilPlayable > 0, 'too fresh to judge');
  assert.equal(old.daysUntilPlayable, 0, 'long closed, playable now');
});

test('closedTrades survives an empty or malformed ledger', () => {
  assert.deepEqual(btCtx([]), []);
  assert.deepEqual(btCtx([{ type: 'SALG' }]), [], 'no date, no security, no crash');
});

// ── Judged on the latest available close ───────────────────────────────────
test('a trade too young for any horizon is still judged from the latest close', () => {
  const v = V();
  const exitDate = '2024-01-01';
  // Three days of data: no horizon resolves (the 5-day target is 7 days out).
  const series = dailySeries(exitDate, 3, () => 120);
  const r = v.verdictFor({ exitDate, exitPrice: 100, qty: 1 }, series, addDays(exitDate, 3));
  assert.deepEqual(r.horizons, [], 'nothing reached a horizon yet');
  assert.ok(r.latest, 'but there is a latest close');
  assert.equal(r.overall, 'too-early', 'and that is enough to judge the call');
  assert.equal(r.latest.daysAfter, 3);
  assert.ok(r.flags.includes('no-horizon-resolved'), 'the thinness is still reported');
});

test('the latest close is the most recent one, not the last horizon', () => {
  const v = V();
  const exitDate = '2024-01-01';
  // Up through the 60-day mark, then collapses well after it.
  const series = dailySeries(exitDate, 300, (i) => (i < 200 ? 150 : 60));
  const r = v.verdictFor({ exitDate, exitPrice: 100, qty: 1 }, series, '2025-06-01');
  assert.equal(r.horizons.find((h) => h.days === 60).verdict, 'too-early');
  assert.equal(r.latest.verdict, 'good-sell', 'by the latest close it had fallen');
  assert.equal(r.overall, 'good-sell', 'the headline follows the latest close');
});

test('best and worst span every close after the exit, not just to a horizon', () => {
  const v = V();
  const exitDate = '2024-01-01';
  // The peak lands beyond the last resolvable horizon.
  const series = dailySeries(exitDate, 300, (i) => (i === 290 ? 400 : 100));
  const r = v.verdictFor({ exitDate, exitPrice: 100, qty: 1 }, series, '2025-06-01');
  assert.equal(r.maxAfter.date, addDays(exitDate, 290), 'the late peak counts');
  assert.ok(Math.abs(r.maxAfter.value - 3) < 1e-9);
});

test('isJudgeable excludes trades with no usable post-exit prices', () => {
  const v = V();
  const exitDate = '2024-01-01';
  const none = v.verdictFor({ exitDate, exitPrice: 100, qty: 1 }, [], '2025-01-01');
  assert.equal(v.isJudgeable(none), false, 'no data at all');

  const one = v.verdictFor({ exitDate, exitPrice: 100, qty: 1 }, dailySeries(exitDate, 1, () => 110), '2025-01-01');
  assert.equal(v.isJudgeable(one), false, 'a single close is not a trend');

  const enough = v.verdictFor({ exitDate, exitPrice: 100, qty: 1 }, dailySeries(exitDate, 30, () => 110), '2025-01-01');
  assert.equal(v.isJudgeable(enough), true);

  const noPrice = v.verdictFor({ exitDate, exitPrice: 0, qty: 1 }, dailySeries(exitDate, 30, () => 110), '2025-01-01');
  assert.equal(v.isJudgeable(noPrice), false, 'no exit price, nothing to compare to');
  assert.equal(v.isJudgeable(null), false);
});
