const db = require('../db');
const {
  classify,
  loadAttributionMap,
  splitForSecurity,
  evenSplit,
  loadTransactions,
  INVESTOR_CODES,
} = require('./ledger');

const NAME_ALIASES = {
  'storskogen group ab ser. b': 'Storskogen B',
  'crayon group holding': 'Crayon Group Holding',
  'dnb bank asa': 'DNB Bank',
  'equinor': 'Equinor',
  'gentoo media inc.': 'Gentoo Media',
  'salmar': 'SalMar',
  'kitron': 'Kitron',
  'bewi': 'BEWi',
  'hellofresh se': 'HelloFresh SE',
};

function canonicalName(security) {
  if (!security) return security;
  const lower = security.trim().toLowerCase();
  if (NAME_ALIASES[lower]) return NAME_ALIASES[lower];
  return security.trim();
}

function snapshotDate() {
  const r = db.prepare('SELECT MAX(snapshot_date) d FROM holdings_snapshot').get();
  return r ? r.d : null;
}

function currentHoldings() {
  const date = snapshotDate();
  if (!date) return [];
  const rows = db
    .prepare(
      `SELECT security, qty, gav, current_price, market_value_nok, currency
       FROM holdings_snapshot
       WHERE snapshot_date = ? AND qty > 0`
    )
    .all(date);
  // Dedup by canonical name (keep highest MV)
  const map = new Map();
  for (const r of rows) {
    const key = canonicalName(r.security);
    const existing = map.get(key);
    if (!existing || (r.market_value_nok || 0) > (existing.market_value_nok || 0)) {
      map.set(key, { ...r, security: key });
    }
  }
  return Array.from(map.values());
}

/**
 * Walk BUY transactions only (excluding BYTTE corporate actions) to derive
 * per-security per-investor average cost. This avoids the corporate-action
 * reset bug that happens when amount=0 BUY/SELL pairs perturb avg cost.
 */
function deriveCostBasis(attrMap) {
  const txs = loadTransactions();
  // perInvestor[code] → Map<security, { qty, costSum }>
  const perInvestor = new Map();
  for (const code of INVESTOR_CODES) perInvestor.set(code, new Map());

  for (const tx of txs) {
    if (!tx.security) continue;
    const cat = classify(tx.type);
    if (cat !== 'BUY' && cat !== 'SELL') continue;
    // Only count rows where there's an actual cash flow (KJØPT/SALG), not BYTTE/SPLITT
    const isPriced = tx.type === 'KJØPT' || tx.type === 'SALG';
    if (!isPriced) continue;
    const split = splitForSecurity(attrMap, tx.security);
    if (!split.length) continue;
    const security = canonicalName(tx.security);
    const qty = tx.qty || 0;
    const amount = tx.amount || 0;
    for (const { code, weight } of split) {
      const bag = perInvestor.get(code);
      if (!bag.has(security)) bag.set(security, { qty: 0, costSum: 0, realized: 0, lastSellPrice: 0 });
      const slot = bag.get(security);
      const wq = qty * weight;
      const wa = amount * weight;
      if (cat === 'BUY') {
        slot.qty += wq;
        slot.costSum += Math.abs(wa);
      } else {
        // SELL
        const avgCost = slot.qty > 0 ? slot.costSum / slot.qty : 0;
        const soldQty = Math.abs(wq);
        slot.realized += wa - avgCost * soldQty;
        // Reduce qty and costSum proportionally
        const fracSold = slot.qty > 0 ? soldQty / slot.qty : 0;
        slot.qty = Math.max(0, slot.qty - soldQty);
        slot.costSum = Math.max(0, slot.costSum - slot.costSum * fracSold);
      }
    }
  }
  return perInvestor;
}

function deriveInvested(attrMap) {
  // Sum of |amount| for KJØPT transactions, weighted by investor share.
  // Represents "total invested" capital per investor across all stocks they've ever held.
  const txs = loadTransactions();
  const perInvestor = new Map();
  for (const code of INVESTOR_CODES) perInvestor.set(code, 0);
  for (const tx of txs) {
    if (tx.type !== 'KJØPT' || !tx.security) continue;
    const split = splitForSecurity(attrMap, tx.security);
    if (!split.length) continue;
    for (const { code, weight } of split) {
      perInvestor.set(code, perInvestor.get(code) + Math.abs(tx.amount || 0) * weight);
    }
  }
  return perInvestor;
}

function deriveDividends(attrMap) {
  const txs = loadTransactions();
  const perInvestor = new Map();
  for (const code of INVESTOR_CODES) perInvestor.set(code, 0);
  for (const tx of txs) {
    const cat = classify(tx.type);
    if (cat !== 'DIVIDEND' && cat !== 'TAX') continue;
    const split = splitForSecurity(attrMap, tx.security);
    if (!split.length) continue;
    for (const { code, weight } of split) {
      perInvestor.set(code, perInvestor.get(code) + (tx.amount || 0) * weight);
    }
  }
  return perInvestor;
}

function deriveCashFlow() {
  const txs = loadTransactions();
  let totalDeposits = 0;
  let totalWithdrawals = 0;
  let totalFees = 0;
  let netDividends = 0;
  let totalBuys = 0;
  let totalSells = 0;
  for (const tx of txs) {
    const cat = classify(tx.type);
    const amount = tx.amount || 0;
    if (cat === 'DEPOSIT') totalDeposits += amount;
    else if (cat === 'WITHDRAWAL') totalWithdrawals += Math.abs(amount);
    else if (cat === 'FEE') totalFees += Math.abs(amount);
    else if (cat === 'DIVIDEND' || cat === 'TAX') netDividends += amount;
    else if (cat === 'BUY' && (tx.type === 'KJØPT')) totalBuys += Math.abs(amount);
    else if (cat === 'SELL' && (tx.type === 'SALG')) totalSells += amount;
  }
  return { totalDeposits, totalWithdrawals, totalFees, netDividends, totalBuys, totalSells };
}

function attributeCurrentHoldings(attrMap) {
  const holdings = currentHoldings();
  // perInvestor[code] → [ { security, qty, currentPrice, marketValueNok, weight } ]
  const perInvestor = new Map();
  for (const code of INVESTOR_CODES) perInvestor.set(code, []);
  for (const h of holdings) {
    const split = splitForSecurity(attrMap, h.security);
    if (!split.length) continue;
    for (const { code, weight } of split) {
      perInvestor.get(code).push({
        security: h.security,
        qty: (h.qty || 0) * weight,
        currentPrice: h.current_price,
        marketValueNok: (h.market_value_nok || 0) * weight,
        weight,
        currency: h.currency,
      });
    }
  }
  return perInvestor;
}

function currentPrices() {
  const map = new Map();
  for (const h of currentHoldings()) {
    if (h.current_price != null) map.set(canonicalName(h.security), { price: h.current_price });
  }
  return map;
}

function computeWindow(preset) {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const minDateRow = db.prepare('SELECT MIN(trade_date) d FROM transactions').get();
  const earliest = (minDateRow && minDateRow.d) || '2020-01-01';
  const addMonths = (d, n) => {
    const x = new Date(d);
    x.setUTCMonth(x.getUTCMonth() + n);
    return x.toISOString().slice(0, 10);
  };
  const addYears = (d, n) => {
    const x = new Date(d);
    x.setUTCFullYear(x.getUTCFullYear() + n);
    return x.toISOString().slice(0, 10);
  };
  switch (preset) {
    case '1m': return { from: addMonths(today, -1),  to: todayStr };
    case '6m': return { from: addMonths(today, -6),  to: todayStr };
    case '1y': return { from: addYears(today, -1),   to: todayStr };
    case 'all': return { from: earliest,              to: todayStr };
    case 'ytd':
    default:    return { from: `${today.getUTCFullYear()}-01-01`, to: todayStr };
  }
}

/**
 * Compute realized, dividends, buys, sells, and "period return %" for a
 * date window per investor and for the group.
 *
 * "Period return %" = (realized + dividends + unrealized_delta) / starting_cost_basis
 *   where unrealized_delta is approximated as: current_unrealized - unrealized_at_start.
 *   unrealized_at_start uses CURRENT price × qty_at_start (we don't store historical
 *   prices), so for stocks held entering the window, attributing all the unrealized
 *   change to the window over-counts. Documented in README.
 */
function windowMetrics(from, to) {
  const attrMap = loadAttributionMap();
  const txs = loadTransactions();
  const prices = currentPrices();

  // Per investor: { realized, dividends, buys, sells, costAtStart, qtyAtStartMap, qtyAtEndMap }
  const states = new Map();
  for (const code of INVESTOR_CODES) {
    states.set(code, {
      realizedInWindow: 0,
      dividendsInWindow: 0,
      buysInWindow: 0,
      sellsInWindow: 0,
      buyCount: 0,
      sellCount: 0,
      costAtStart: 0,
      mvAtStart: 0,
      costAtEnd: 0,
      mvAtEnd: 0,
      perSec: new Map(),
    });
  }

  const ensureSec = (state, security) => {
    if (!state.perSec.has(security)) {
      state.perSec.set(security, {
        qty: 0,
        costSum: 0,
        realized: 0,
        divs: 0,
        boughtInWindow: 0,
        soldInWindow: 0,
      });
    }
    return state.perSec.get(security);
  };

  // First pass: replay all KJØPT/SALG up to `from` exclusive to establish entering positions.
  for (const tx of txs) {
    if (!tx.security) continue;
    if ((tx.trade_date || '') >= from) break;
    if (tx.type !== 'KJØPT' && tx.type !== 'SALG') continue;
    const split = splitForSecurity(attrMap, tx.security);
    if (!split.length) continue;
    const security = canonicalName(tx.security);
    for (const { code, weight } of split) {
      const state = states.get(code);
      const slot = ensureSec(state, security);
      const amt = (tx.amount || 0) * weight;
      const q = (tx.qty || 0) * weight;
      if (tx.type === 'KJØPT') {
        slot.qty += q;
        slot.costSum += Math.abs(amt);
      } else {
        const sold = Math.abs(q);
        const fracSold = slot.qty > 0 ? sold / slot.qty : 0;
        slot.costSum = Math.max(0, slot.costSum - slot.costSum * fracSold);
        slot.qty = Math.max(0, slot.qty - sold);
      }
    }
  }
  // Snapshot the entering basis
  for (const code of INVESTOR_CODES) {
    const state = states.get(code);
    let cost = 0, mv = 0;
    for (const [security, slot] of state.perSec.entries()) {
      cost += slot.costSum;
      const px = prices.get(security);
      mv += slot.qty * ((px && px.price) || 0);
    }
    state.costAtStart = cost;
    state.mvAtStart = mv;
  }

  // Second pass: transactions in window
  for (const tx of txs) {
    if (!tx.security && !(tx.type === 'INNSKUDD' || tx.type === 'UTTAK INTERNET' || tx.type === 'PLATTFORMAVGIFT')) continue;
    if ((tx.trade_date || '') < from || (tx.trade_date || '') > to) continue;
    const cat = classify(tx.type);
    if (cat === 'DIVIDEND' || cat === 'TAX') {
      const split = splitForSecurity(attrMap, tx.security);
      if (!split.length) continue;
      const security = canonicalName(tx.security);
      for (const { code, weight } of split) {
        const state = states.get(code);
        const slot = ensureSec(state, security);
        const amt = (tx.amount || 0) * weight;
        slot.divs += amt;
        state.dividendsInWindow += amt;
      }
    } else if (tx.type === 'KJØPT' || tx.type === 'SALG') {
      const split = splitForSecurity(attrMap, tx.security);
      if (!split.length) continue;
      const security = canonicalName(tx.security);
      for (const { code, weight } of split) {
        const state = states.get(code);
        const slot = ensureSec(state, security);
        const amt = (tx.amount || 0) * weight;
        const q = (tx.qty || 0) * weight;
        if (tx.type === 'KJØPT') {
          slot.qty += q;
          slot.costSum += Math.abs(amt);
          slot.boughtInWindow += Math.abs(amt);
          state.buysInWindow += Math.abs(amt);
          state.buyCount += 1;
        } else {
          const avg = slot.qty > 0 ? slot.costSum / slot.qty : 0;
          const sold = Math.abs(q);
          const realized = amt - avg * sold;
          slot.realized += realized;
          slot.soldInWindow += amt;
          const fracSold = slot.qty > 0 ? sold / slot.qty : 0;
          slot.costSum = Math.max(0, slot.costSum - slot.costSum * fracSold);
          slot.qty = Math.max(0, slot.qty - sold);
          state.realizedInWindow += realized;
          state.sellsInWindow += amt;
          state.sellCount += 1;
        }
      }
    }
  }

  // Snapshot the exit basis
  for (const code of INVESTOR_CODES) {
    const state = states.get(code);
    let cost = 0, mv = 0;
    for (const [security, slot] of state.perSec.entries()) {
      cost += slot.costSum;
      const px = prices.get(security);
      mv += slot.qty * ((px && px.price) || 0);
    }
    state.costAtEnd = cost;
    state.mvAtEnd = mv;
  }

  // Build response
  const perInvestor = {};
  let group = {
    realizedInWindow: 0,
    dividendsInWindow: 0,
    buysInWindow: 0,
    sellsInWindow: 0,
    buyCount: 0,
    sellCount: 0,
    unrealizedDeltaInWindow: 0,
    netPnlInWindow: 0,
    base: 0,
  };
  for (const code of INVESTOR_CODES) {
    const state = states.get(code);
    const unrealizedAtStart = state.mvAtStart - state.costAtStart;
    const unrealizedAtEnd = state.mvAtEnd - state.costAtEnd;
    const unrealizedDelta = unrealizedAtEnd - unrealizedAtStart;
    const netPnl = state.realizedInWindow + state.dividendsInWindow + unrealizedDelta;
    const base = Math.max(state.costAtStart + state.buysInWindow, 1);
    const pct = (netPnl / base) * 100;
    perInvestor[code] = {
      realizedInWindow: state.realizedInWindow,
      dividendsInWindow: state.dividendsInWindow,
      buysInWindow: state.buysInWindow,
      sellsInWindow: state.sellsInWindow,
      buyCount: state.buyCount,
      sellCount: state.sellCount,
      unrealizedDeltaInWindow: unrealizedDelta,
      netPnlInWindow: netPnl,
      basis: base,
      periodReturnPct: pct,
    };
    group.realizedInWindow += state.realizedInWindow;
    group.dividendsInWindow += state.dividendsInWindow;
    group.buysInWindow += state.buysInWindow;
    group.sellsInWindow += state.sellsInWindow;
    group.buyCount += state.buyCount;
    group.sellCount += state.sellCount;
    group.unrealizedDeltaInWindow += unrealizedDelta;
    group.netPnlInWindow += netPnl;
    group.base += base;
  }
  group.periodReturnPct = group.base > 0 ? (group.netPnlInWindow / group.base) * 100 : 0;

  // Period leaderboard
  const periodRanks = INVESTOR_CODES
    .map((code) => ({ code, value: perInvestor[code].periodReturnPct }))
    .sort((a, b) => b.value - a.value);

  return { from, to, perInvestor, group, periodRanks };
}

function buildDashboard(opts = {}) {
  const window = opts.from && opts.to ? { from: opts.from, to: opts.to } : computeWindow(opts.preset || 'ytd');
  const wm = windowMetrics(window.from, window.to);
  const baseDashboard = buildDashboardSnapshot();
  return {
    ...baseDashboard,
    window: { ...window, preset: opts.preset || 'ytd' },
    windowMetrics: wm,
    leaderboards: {
      ...baseDashboard.leaderboards,
      period: wm.periodRanks,
    },
  };
}

function buildDashboardSnapshot() {
  const attrMap = loadAttributionMap();
  const heldByInvestor = attributeCurrentHoldings(attrMap);
  const costByInvestor = deriveCostBasis(attrMap);
  const divsByInvestor = deriveDividends(attrMap);
  const cashFlow = deriveCashFlow();
  const groupCash = cashFlow.totalDeposits - cashFlow.totalWithdrawals + cashFlow.totalSells + cashFlow.netDividends - cashFlow.totalBuys - cashFlow.totalFees;
  const perInvestorCash = groupCash / INVESTOR_CODES.length; // even split
  const perInvestorDeposits = cashFlow.totalDeposits / INVESTOR_CODES.length;

  const perInvestor = {};
  let group = {
    marketValue: 0,
    cash: groupCash,
    dividends: 0,
    realized: 0,
    unrealized: 0,
    deposits: cashFlow.totalDeposits,
    withdrawals: cashFlow.totalWithdrawals,
    fees: cashFlow.totalFees,
    totalValue: 0,
  };

  const investedByInvestor = deriveInvested(attrMap);

  for (const code of INVESTOR_CODES) {
    const held = heldByInvestor.get(code);
    const costBag = costByInvestor.get(code);
    let mv = 0;
    let realized = 0;
    let unrealized = 0;
    const holdings = [];
    for (const h of held) {
      const cost = costBag.get(h.security);
      const avgCost = cost && cost.qty > 0 ? cost.costSum / cost.qty : (h.currentPrice || 0);
      const unrealizedH = (h.marketValueNok || 0) - avgCost * h.qty;
      const unrealizedPct = avgCost > 0 ? (unrealizedH / (avgCost * h.qty)) * 100 : 0;
      holdings.push({
        security: h.security,
        qty: h.qty,
        avgCost,
        currentPrice: h.currentPrice,
        marketValue: h.marketValueNok,
        unrealized: unrealizedH,
        unrealizedPct,
        weight: h.weight,
      });
      mv += h.marketValueNok || 0;
      unrealized += unrealizedH;
    }
    for (const cost of costBag.values()) realized += cost.realized;

    const dividends = divsByInvestor.get(code) || 0;
    const invested = investedByInvestor.get(code) || 0;
    const totalValue = mv + perInvestorCash;
    // Investor portfolio return: realized + unrealized + dividends, vs total invested in their stocks
    const netReturn = realized + unrealized + dividends;
    const portfolioReturnPct = invested > 0 ? (netReturn / invested) * 100 : 0;
    perInvestor[code] = {
      marketValue: mv,
      cash: perInvestorCash,
      dividends,
      realized,
      unrealized,
      invested,
      deposits: perInvestorDeposits,
      withdrawals: cashFlow.totalWithdrawals / INVESTOR_CODES.length,
      totalValue,
      netReturn,
      portfolioReturnPct,
      totalReturnPct: portfolioReturnPct,
      holdings: holdings.sort((a, b) => b.marketValue - a.marketValue),
    };
    group.marketValue += mv;
    group.realized += realized;
    group.unrealized += unrealized;
    group.dividends += dividends;
  }
  group.totalValue = group.marketValue + group.cash;
  group.invested = Array.from(investedByInvestor.values()).reduce((a, b) => a + b, 0);
  group.netReturn = group.realized + group.unrealized + group.dividends;
  group.portfolioReturnPct = group.invested > 0 ? (group.netReturn / group.invested) * 100 : 0;
  const netGroupDeposits = group.deposits - group.withdrawals;
  group.netDeposits = netGroupDeposits;
  group.totalReturnPct = group.portfolioReturnPct;

  return {
    snapshotDate: snapshotDate(),
    perInvestor,
    group,
    leaderboards: buildLeaderboards(perInvestor, attrMap),
  };
}

function buildLeaderboards(perInvestor, attrMap) {
  const allTime = INVESTOR_CODES.map((code) => ({
    code,
    value: perInvestor[code].totalReturnPct,
    totalValue: perInvestor[code].totalValue,
  })).sort((a, b) => b.value - a.value);

  const ytd = buildYtdLeaderboard(perInvestor, attrMap);
  const bestPicks = buildBestPicks(attrMap);
  const monthly = buildMonthlyLeaderboard(perInvestor, attrMap);

  return { allTime, ytd, bestPicks, monthly };
}

function buildYtdLeaderboard(perInvestor, attrMap) {
  const year = new Date().getUTCFullYear();
  const yearStart = `${year}-01-01`;
  const txs = loadTransactions();

  // Per investor: count YTD dividends + realized + unrealized delta as proxy for YTD return
  // Simpler approach: derive current cost basis as of Jan 1 by replaying only BUYs/SELLs before
  // Jan 1, and current cost basis now. Unrealized delta = current MV - cost-as-of-jan1 - net BUYs YTD.
  // For an MVP, use a simpler heuristic: YTD return = (realized YTD + dividends YTD + unrealized delta YTD) / starting value.
  const result = [];
  for (const code of INVESTOR_CODES) {
    let realizedYtd = 0;
    let divsYtd = 0;
    for (const tx of txs) {
      if ((tx.trade_date || '') < yearStart) continue;
      const cat = classify(tx.type);
      if (cat !== 'SELL' && cat !== 'DIVIDEND' && cat !== 'TAX') continue;
      const split = splitForSecurity(attrMap, tx.security);
      if (!split.length) continue;
      const slot = split.find((s) => s.code === code);
      if (!slot) continue;
      const w = slot.weight;
      if (cat === 'SELL' && tx.type === 'SALG') realizedYtd += (tx.amount || 0) * w * 0.1; // contribution placeholder
      else if (cat === 'DIVIDEND' || cat === 'TAX') divsYtd += (tx.amount || 0) * w;
    }
    // Approximation: YTD return as % = (dividends + realized + estimated unrealized delta) / totalValue
    // For simplicity, just rank by recent dividends + realized contribution against deposit base.
    const base = perInvestor[code].deposits || 1;
    const value = ((divsYtd + realizedYtd) / base) * 100;
    result.push({ code, value });
  }
  return result.sort((a, b) => b.value - a.value);
}

function buildBestPicks(attrMap) {
  // For each investor, the security with the highest cumulative return (realized + remaining MV - invested + divs)
  const txs = loadTransactions();
  const perInvestor = new Map();
  for (const code of INVESTOR_CODES) perInvestor.set(code, new Map());

  for (const tx of txs) {
    if (!tx.security) continue;
    const cat = classify(tx.type);
    if (cat !== 'BUY' && cat !== 'SELL' && cat !== 'DIVIDEND' && cat !== 'TAX') continue;
    const split = splitForSecurity(attrMap, tx.security);
    if (!split.length) continue;
    const security = canonicalName(tx.security);
    for (const { code, weight } of split) {
      const bag = perInvestor.get(code);
      if (!bag.has(security)) bag.set(security, { invested: 0, returned: 0, qty: 0 });
      const slot = bag.get(security);
      const amt = (tx.amount || 0) * weight;
      const qty = (tx.qty || 0) * weight;
      if (cat === 'BUY' && tx.type === 'KJØPT') {
        slot.invested += Math.abs(amt);
        slot.qty += qty;
      } else if (cat === 'SELL' && tx.type === 'SALG') {
        slot.returned += amt;
        slot.qty = Math.max(0, slot.qty - Math.abs(qty));
      } else if (cat === 'DIVIDEND' || cat === 'TAX') {
        slot.returned += amt;
      }
    }
  }
  // Add current MV to returned
  const holdings = currentHoldings();
  const priceMap = new Map();
  for (const h of holdings) priceMap.set(h.security, h);

  const out = [];
  for (const code of INVESTOR_CODES) {
    let best = null;
    for (const [security, slot] of perInvestor.get(code).entries()) {
      const px = priceMap.get(security);
      const split = splitForSecurity(attrMap, security);
      const myW = (split.find((s) => s.code === code) || { weight: 0 }).weight;
      const remainingValue = px ? (px.market_value_nok || 0) * myW : 0;
      const totalReturn = slot.returned + remainingValue - slot.invested;
      const pct = slot.invested > 0 ? (totalReturn / slot.invested) * 100 : 0;
      if (!best || totalReturn > best.return) {
        best = { security, invested: slot.invested, return: totalReturn, pct };
      }
    }
    out.push({ code, pick: best });
  }
  return out;
}

function buildMonthlyLeaderboard(perInvestor, attrMap) {
  // For the last 6 months: ranking by sum of (dividends + realized) per investor that month.
  // This is a simpler proxy than full mark-to-market — easier to compute reliably.
  const txs = loadTransactions();
  const now = new Date();
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const ym = d.toISOString().slice(0, 7);
    months.push(ym);
  }
  const result = [];
  for (const ym of months) {
    const ranks = INVESTOR_CODES.map((code) => {
      let pnl = 0;
      for (const tx of txs) {
        if (!tx.trade_date || tx.trade_date.slice(0, 7) !== ym) continue;
        const cat = classify(tx.type);
        if (cat !== 'SELL' && cat !== 'DIVIDEND' && cat !== 'TAX') continue;
        const split = splitForSecurity(attrMap, tx.security);
        if (!split.length) continue;
        const slot = split.find((s) => s.code === code);
        if (!slot) continue;
        pnl += (tx.amount || 0) * slot.weight;
      }
      return { code, value: pnl };
    });
    ranks.sort((a, b) => b.value - a.value);
    result.push({ month: ym, ranks });
  }
  return result;
}

function investorDetail(code) {
  const dashboard = buildDashboard();
  const summary = dashboard.perInvestor[code];
  if (!summary) return null;
  const attrMap = loadAttributionMap();
  const txs = loadTransactions();
  const recent = [];
  for (const tx of txs.slice().reverse()) {
    const split = splitForSecurity(attrMap, tx.security);
    if (!split.length && tx.security) continue;
    const slot = (split.length ? split.find((s) => s.code === code) : null);
    if (!slot && tx.security) continue;
    const w = slot ? slot.weight : 1.0 / INVESTOR_CODES.length;
    if (!tx.security && classify(tx.type) === 'DEPOSIT') {
      recent.push({
        tradeDate: tx.trade_date,
        type: tx.type,
        security: null,
        qty: null,
        price: null,
        amount: (tx.amount || 0) * w,
        weight: w,
      });
    } else if (tx.security) {
      recent.push({
        tradeDate: tx.trade_date,
        type: tx.type,
        security: canonicalName(tx.security),
        qty: tx.qty != null ? tx.qty * w : null,
        price: tx.price,
        amount: (tx.amount || 0) * w,
        weight: w,
      });
    }
    if (recent.length >= 50) break;
  }
  return { code, summary, recent };
}

module.exports = {
  buildDashboard,
  investorDetail,
  canonicalName,
  currentHoldings,
  snapshotDate,
};
