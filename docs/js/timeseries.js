// Time-series builders for the dashboard charts.
// Replays the sorted transaction log and emits sparse samples — one per
// unique transaction date — with per-investor breakdowns.
//
// Three series exposed:
//   buildPortfolioValueSeries  — stacked-area input: per-investor book value
//                                over time, lifted by unrealized P/L at the
//                                final sample.
//   buildCumulativePnlSeries   — multi-line input: running realized + divs
//                                − attributed fees per investor.
//   buildCapitalVsReturnSeries — two-line input: group-level invested capital
//                                vs total net return.
//
// All math reuses the same classification + attribution helpers as the rest
// of the portfolio module so the numbers reconcile.

(function () {
  const { INVESTOR_CODES, classify, splitForSecurity, evenSplit, isRealizingSell, amountNok } = window.Ledger;
  const canonicalName = window.Portfolio.canonicalName;

  function emptyPerInvestor(init) {
    const m = {};
    for (const code of INVESTOR_CODES) m[code] = init;
    return m;
  }

  // Attribution split for non-security cash flows (deposits, fees, withdrawals):
  // even across all 5 investors. Mirrors the dashboard's per-investor cash split.
  function flowSplit() { return evenSplit(); }

  // Walk transactions chronologically and build a per-date state map.
  // Returns an array of { date, state } where state is a deep clone snapshot.
  // To keep the SVG light we only emit one snapshot per unique trade date.
  function replay(store, mutate) {
    const txs = store.transactions.slice().sort((a, b) => {
      const ak = a.tradeDate || a.bookDate || '';
      const bk = b.tradeDate || b.bookDate || '';
      return ak.localeCompare(bk);
    });
    const samples = [];
    let lastDate = null;
    const state = {
      perInvestor: {},
      costPerSec: {},
    };
    for (const code of INVESTOR_CODES) {
      state.perInvestor[code] = {
        cost: 0, realized: 0, dividends: 0, fees: 0, deposits: 0, withdrawals: 0,
      };
      state.costPerSec[code] = new Map();
    }
    for (const tx of txs) {
      const date = tx.tradeDate || tx.bookDate;
      if (!date) continue;
      mutate(state, tx);
      if (lastDate && date !== lastDate) {
        samples.push({ date: lastDate, state: snapshot(state) });
      }
      lastDate = date;
    }
    if (lastDate) samples.push({ date: lastDate, state: snapshot(state) });
    return samples;
  }

  function snapshot(state) {
    const out = { perInvestor: {} };
    for (const code of INVESTOR_CODES) {
      out.perInvestor[code] = { ...state.perInvestor[code] };
    }
    return out;
  }

  // Common mutator: updates cost basis, realized, dividends, fees, deposits.
  function applyTx(state, tx, attrMap) {
    const cat = classify(tx.type);
    const amount = amountNok(tx);
    const qty = tx.qty || 0;
    const security = tx.security ? canonicalName(tx.security) : null;

    if (cat === 'DEPOSIT') {
      for (const { code, weight } of flowSplit()) {
        state.perInvestor[code].deposits += amount * weight;
      }
      return;
    }
    if (cat === 'WITHDRAWAL') {
      for (const { code, weight } of flowSplit()) {
        state.perInvestor[code].withdrawals += Math.abs(amount) * weight;
      }
      return;
    }
    if (cat === 'FEE') {
      for (const { code, weight } of flowSplit()) {
        state.perInvestor[code].fees += Math.abs(amount) * weight;
      }
      return;
    }
    if (!security) return;
    const split = splitForSecurity(attrMap, security);
    if (!split.length) return;
    if (cat === 'DIVIDEND' || cat === 'TAX') {
      for (const { code, weight } of split) {
        state.perInvestor[code].dividends += amount * weight;
      }
      return;
    }
    if (cat !== 'BUY' && cat !== 'SELL') return;
    const isPriced = tx.type === 'KJØPT' || isRealizingSell(tx.type);
    if (!isPriced) return;
    for (const { code, weight } of split) {
      const bag = state.costPerSec[code];
      if (!bag.has(security)) bag.set(security, { qty: 0, costSum: 0 });
      const slot = bag.get(security);
      const wq = qty * weight;
      const wa = amount * weight;
      const inv = state.perInvestor[code];
      if (cat === 'BUY') {
        slot.qty += wq;
        slot.costSum += Math.abs(wa);
        inv.cost += Math.abs(wa);
      } else {
        const avg = slot.qty > 0 ? slot.costSum / slot.qty : 0;
        const sold = Math.abs(wq);
        const realized = wa - avg * sold;
        inv.realized += realized;
        inv.cost -= avg * sold;
        const fracSold = slot.qty > 0 ? sold / slot.qty : 0;
        slot.costSum = Math.max(0, slot.costSum - slot.costSum * fracSold);
        slot.qty = Math.max(0, slot.qty - sold);
      }
    }
  }

  // ─── Public builders ──────────────────────────────────────────────────────

  // Portfolio book value per investor = cost basis of held positions
  //   + (deposits + realized + dividends − withdrawals − fees − bought + sold)
  // Simpler form: bookValue = deposits − withdrawals + realized + dividends − fees
  //                            + (cost basis of currently held positions − net buys)
  // Since cost basis already excludes sold qty, the cleanest is:
  //   bookValue ≈ cost + (deposits − withdrawals + realized + dividends − fees − costPurchased)
  // To stay honest and uncomplicated, plot:
  //   bookValue = cost + deposits − withdrawals + realized + dividends − fees − totalSpentOnBuys
  // where totalSpentOnBuys = running sum of |amount| on BUYs.
  //
  // Equivalent simpler rephrasing that matches what investors see in their
  // statement: bookValue = deposits − withdrawals − fees + dividends + realized
  //                      + cost  − cost   (cost cancels)  + unrealized at end
  // …which collapses to deposits − withdrawals − fees + dividends + realized
  // for in-flight points and adds the unrealized lift at the final sample.
  // Portfolio value per investor — a true daily series from the StockPrices
  // matrix: for every price date, Σ qtyOn(date) × nokPriceOn(ticker, date)
  // per security, attributed by Dim-values weight. Downsampled to ≤ MAX_PTS
  // points so the SVG stays light. Falls back to the sparse Beholdningsverdi
  // snapshots until the price matrix has data.
  const MAX_PTS = 400;

  function sampleDates(dates) {
    if (dates.length <= MAX_PTS) return dates;
    const step = Math.ceil(dates.length / MAX_PTS);
    const out = [];
    for (let i = 0; i < dates.length; i += step) out.push(dates[i]);
    if (out[out.length - 1] !== dates[dates.length - 1]) out.push(dates[dates.length - 1]);
    return out;
  }

  function buildPortfolioValueSeries(store, opts = {}) {
    if (!window.Portfolio.usePriceMatrix(store)) return legacyPortfolioValueSeries(store);
    const attrMap = store.attributionMap;
    const from = opts.from || store.prices.dates[0];
    const to = opts.to || store.prices.latestDate;
    const dates = sampleDates(window.Prices.datesBetween(store.prices, from, to));
    return dates.map((date) => {
      const perInvestor = {};
      for (const code of INVESTOR_CODES) perInvestor[code] = 0;
      for (const h of window.Positions.holdingsAt(store, date)) {
        const nok = window.Portfolio.nokPriceForSecurity(store, h.security, date);
        if (nok == null) continue;
        const split = splitForSecurity(attrMap, h.security);
        for (const { code, weight } of split) {
          perInvestor[code] += nok * h.qty * weight;
        }
      }
      return { date, perInvestor };
    });
  }

  // NOK close series for one security — a genuine daily price chart input.
  // Returns [{date, price}] within [from, to] (both optional).
  function buildSecurityPriceSeries(store, security, from, to) {
    if (!window.Portfolio.usePriceMatrix(store)) return [];
    const sec = store.registry.forName(security);
    if (!sec || !sec.ticker) return [];
    const points = store.prices.series.get(sec.ticker) || [];
    const out = [];
    for (const p of points) {
      if (from && p.d < from) continue;
      if (to && p.d > to) continue;
      const fx = window.Prices.fxOn(store.prices, sec.currency, p.d);
      if (fx == null) continue;
      out.push({ date: p.d, price: p.v * fx });
    }
    return out;
  }

  function legacyPortfolioValueSeries(store) {
    const attrMap = store.attributionMap;
    const byDate = new Map();
    for (const h of store.holdings) {
      if (!h.snapshotDate || h.marketValueNok == null) continue;
      if (!byDate.has(h.snapshotDate)) byDate.set(h.snapshotDate, []);
      byDate.get(h.snapshotDate).push(h);
    }
    const dates = Array.from(byDate.keys()).sort();
    return dates.map((date) => {
      const perInvestor = {};
      for (const code of INVESTOR_CODES) perInvestor[code] = 0;
      for (const h of byDate.get(date)) {
        const security = canonicalName(h.security);
        const split = splitForSecurity(attrMap, security);
        if (!split.length) continue;
        for (const { code, weight } of split) {
          perInvestor[code] += (h.marketValueNok || 0) * weight;
        }
      }
      return { date, perInvestor };
    });
  }

  function buildCumulativePnlSeries(store) {
    const attrMap = store.attributionMap;
    const samples = replay(store, (state, tx) => applyTx(state, tx, attrMap));
    return samples.map(({ date, state }) => {
      const perInvestor = {};
      for (const code of INVESTOR_CODES) {
        const s = state.perInvestor[code];
        perInvestor[code] = s.realized + s.dividends - s.fees;
      }
      return { date, perInvestor };
    });
  }

  function buildCapitalVsReturnSeries(store) {
    const attrMap = store.attributionMap;
    const samples = replay(store, (state, tx) => applyTx(state, tx, attrMap));
    const series = samples.map(({ date, state }) => {
      let invested = 0, netReturn = 0;
      for (const code of INVESTOR_CODES) {
        const s = state.perInvestor[code];
        invested += s.deposits - s.withdrawals;
        netReturn += s.realized + s.dividends - s.fees;
      }
      return { date, invested, netReturn };
    });
    if (series.length) {
      const dash = window.Portfolio.buildDashboard(store);
      const unrealized = dash.group.unrealized || 0;
      series[series.length - 1].netReturn += unrealized;
    }
    return series;
  }

  window.TimeSeries = {
    buildPortfolioValueSeries,
    buildSecurityPriceSeries,
    buildCumulativePnlSeries,
    buildCapitalVsReturnSeries,
  };
})();
