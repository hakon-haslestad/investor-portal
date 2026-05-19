// Portfolio calculator. Ported verbatim from src/portfolio/calculator.js,
// with every `db.prepare(...).all()` replaced by reads from a hydrated `store`.
// Synchronous — pass `store` (from window.Store.hydrate()) and you're done.

(function () {
  const { INVESTOR_CODES, classify, splitForSecurity, isRealizingSell } = window.Ledger;

  // Stable canonicalization for stocks that show up under slightly different
  // names across Beholdningsverdi and Rådata. Same map as the original.
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
    const lower = String(security).trim().toLowerCase();
    if (NAME_ALIASES[lower]) return NAME_ALIASES[lower];
    return String(security).trim();
  }

  // ─── Snapshot / holdings helpers ─────────────────────────────────────────

  function snapshotDate(store) {
    let max = null;
    for (const h of store.holdings) {
      if (h.snapshotDate && (!max || h.snapshotDate > max)) max = h.snapshotDate;
    }
    return max;
  }

  function currentHoldings(store) {
    const date = snapshotDate(store);
    if (!date) return [];
    const rows = store.holdings.filter((h) => h.snapshotDate === date && (h.qty || 0) > 0);
    const map = new Map();
    for (const r of rows) {
      const key = canonicalName(r.security);
      const existing = map.get(key);
      if (!existing || (r.marketValueNok || 0) > (existing.marketValueNok || 0)) {
        // Keep the original keys the rest of the file uses (current_price, market_value_nok)
        map.set(key, {
          ...r,
          security: key,
          current_price: r.currentPrice,
          market_value_nok: r.marketValueNok,
        });
      }
    }
    return Array.from(map.values());
  }

  function currentPrices(store) {
    const map = new Map();
    for (const h of currentHoldings(store)) {
      if (h.current_price != null) map.set(canonicalName(h.security), { price: h.current_price });
    }
    return map;
  }

  // Find the Beholdningsverdi snapshot date <= the given date (closest before).
  // Returns null if no snapshots exist on or before the date.
  function snapshotForDate(store, date) {
    let best = null;
    for (const h of store.holdings) {
      if (!h.snapshotDate) continue;
      if (h.snapshotDate > date) continue;
      if (!best || h.snapshotDate > best) best = h.snapshotDate;
    }
    return best;
  }

  // Price map for a specific date, using the closest snapshot on or before it.
  // Falls back to currentPrices if no historical snapshot is available.
  function pricesAtDate(store, date) {
    const snap = snapshotForDate(store, date);
    if (!snap) return currentPrices(store);
    const map = new Map();
    for (const h of store.holdings) {
      if (h.snapshotDate !== snap) continue;
      const key = canonicalName(h.security);
      if (!map.has(key) && h.currentPrice != null) {
        map.set(key, { price: h.currentPrice, marketValueNok: h.marketValueNok, qty: h.qty });
      }
    }
    return map;
  }

  // ─── Cost basis / cashflow / dividends ───────────────────────────────────

  function deriveCostBasis(store) {
    const attrMap = store.attributionMap;
    const txs = store.transactions;
    const perInvestor = new Map();
    for (const code of INVESTOR_CODES) perInvestor.set(code, new Map());

    for (const tx of txs) {
      if (!tx.security) continue;
      const cat = classify(tx.type);
      if (cat !== 'BUY' && cat !== 'SELL') continue;
      const isPriced = tx.type === 'KJØPT' || isRealizingSell(tx.type);
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
          const avgCost = slot.qty > 0 ? slot.costSum / slot.qty : 0;
          const soldQty = Math.abs(wq);
          slot.realized += wa - avgCost * soldQty;
          const fracSold = slot.qty > 0 ? soldQty / slot.qty : 0;
          slot.qty = Math.max(0, slot.qty - soldQty);
          slot.costSum = Math.max(0, slot.costSum - slot.costSum * fracSold);
        }
      }
    }
    return perInvestor;
  }

  function deriveInvested(store) {
    const attrMap = store.attributionMap;
    const txs = store.transactions;
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

  function deriveDividends(store) {
    const attrMap = store.attributionMap;
    const txs = store.transactions;
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

  // Nordnet records a running cash balance ("Saldo") on every transaction row.
  // That balance — not our additive replay — is the authoritative cash figure.
  function latestSaldo(store) {
    let best = null;
    for (const t of store.transactions) {
      if (t.saldo == null || Number.isNaN(t.saldo)) continue;
      const key = t.bookDate || t.tradeDate || '';
      if (!best || key > best.key) best = { key, saldo: t.saldo };
    }
    return best ? best.saldo : 0;
  }

  function saldoOnOrBefore(store, dateStr) {
    let best = null;
    for (const t of store.transactions) {
      if (t.saldo == null || Number.isNaN(t.saldo)) continue;
      const key = t.bookDate || t.tradeDate || '';
      if (!key || key > dateStr) continue;
      if (!best || key > best.key) best = { key, saldo: t.saldo };
    }
    return best ? best.saldo : null;
  }

  function deriveCashFlow(store) {
    const txs = store.transactions;
    let totalDeposits = 0, totalWithdrawals = 0, totalFees = 0, netDividends = 0, totalBuys = 0, totalSells = 0;
    for (const tx of txs) {
      const cat = classify(tx.type);
      const amount = tx.amount || 0;
      if (cat === 'DEPOSIT') totalDeposits += amount;
      else if (cat === 'WITHDRAWAL') totalWithdrawals += Math.abs(amount);
      else if (cat === 'FEE') totalFees += Math.abs(amount);
      else if (cat === 'DIVIDEND' || cat === 'TAX') netDividends += amount;
      else if (cat === 'BUY' && tx.type === 'KJØPT') totalBuys += Math.abs(amount);
      else if (cat === 'SELL' && isRealizingSell(tx.type)) totalSells += amount;
    }
    return { totalDeposits, totalWithdrawals, totalFees, netDividends, totalBuys, totalSells };
  }

  function attributeCurrentHoldings(store) {
    const attrMap = store.attributionMap;
    const holdings = currentHoldings(store);
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

  // ─── Window picker ───────────────────────────────────────────────────────

  function computeWindow(store, preset) {
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    let earliest = '2020-01-01';
    for (const t of store.transactions) {
      if (t.tradeDate && (earliest === '2020-01-01' || t.tradeDate < earliest)) earliest = t.tradeDate;
    }
    const addMonths = (d, n) => {
      const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10);
    };
    const addYears = (d, n) => {
      const x = new Date(d); x.setUTCFullYear(x.getUTCFullYear() + n); return x.toISOString().slice(0, 10);
    };
    switch (preset) {
      case '1m': return { from: addMonths(today, -1), to: todayStr };
      case '6m': return { from: addMonths(today, -6), to: todayStr };
      case '1y': return { from: addYears(today, -1), to: todayStr };
      case 'all': return { from: earliest, to: todayStr };
      case 'ytd':
      default:    return { from: `${today.getUTCFullYear()}-01-01`, to: todayStr };
    }
  }

  function windowMetrics(store, from, to) {
    const attrMap = store.attributionMap;
    const txs = store.transactions;
    const prices = currentPrices(store);

    const states = new Map();
    for (const code of INVESTOR_CODES) {
      states.set(code, {
        realizedInWindow: 0, dividendsInWindow: 0,
        buysInWindow: 0, sellsInWindow: 0,
        buyCount: 0, sellCount: 0,
        costAtStart: 0, mvAtStart: 0,
        costAtEnd: 0, mvAtEnd: 0,
        perSec: new Map(),
      });
    }
    const ensureSec = (state, security) => {
      if (!state.perSec.has(security)) {
        state.perSec.set(security, { qty: 0, costSum: 0, realized: 0, divs: 0, boughtInWindow: 0, soldInWindow: 0 });
      }
      return state.perSec.get(security);
    };

    // Pre-window replay
    for (const tx of txs) {
      if (!tx.security) continue;
      if ((tx.tradeDate || '') >= from) break;
      if (tx.type !== 'KJØPT' && !isRealizingSell(tx.type)) continue;
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
    for (const code of INVESTOR_CODES) {
      const state = states.get(code);
      let cost = 0, mv = 0;
      for (const [security, slot] of state.perSec.entries()) {
        cost += slot.costSum;
        const px = prices.get(security);
        mv += slot.qty * ((px && px.price) || 0);
      }
      state.costAtStart = cost; state.mvAtStart = mv;
    }

    // In-window pass
    for (const tx of txs) {
      if (!tx.security && !(tx.type === 'INNSKUDD' || tx.type === 'UTTAK INTERNET' || tx.type === 'PLATTFORMAVGIFT')) continue;
      if ((tx.tradeDate || '') < from || (tx.tradeDate || '') > to) continue;
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
      } else if (tx.type === 'KJØPT' || isRealizingSell(tx.type)) {
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

    for (const code of INVESTOR_CODES) {
      const state = states.get(code);
      let cost = 0, mv = 0;
      for (const [security, slot] of state.perSec.entries()) {
        cost += slot.costSum;
        const px = prices.get(security);
        mv += slot.qty * ((px && px.price) || 0);
      }
      state.costAtEnd = cost; state.mvAtEnd = mv;
    }

    const perInvestor = {};
    let group = {
      realizedInWindow: 0, dividendsInWindow: 0,
      buysInWindow: 0, sellsInWindow: 0,
      buyCount: 0, sellCount: 0,
      unrealizedDeltaInWindow: 0, netPnlInWindow: 0, base: 0,
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

    const periodRanks = INVESTOR_CODES
      .map((code) => ({ code, value: perInvestor[code].periodReturnPct }))
      .sort((a, b) => b.value - a.value);

    return { from, to, perInvestor, group, periodRanks };
  }

  // ─── Snapshot / leaderboards ─────────────────────────────────────────────

  function buildDashboardSnapshot(store) {
    const heldByInvestor = attributeCurrentHoldings(store);
    const costByInvestor = deriveCostBasis(store);
    const divsByInvestor = deriveDividends(store);
    const cashFlow = deriveCashFlow(store);
    const groupCash = latestSaldo(store);
    const perInvestorCash = groupCash / INVESTOR_CODES.length;
    const perInvestorDeposits = cashFlow.totalDeposits / INVESTOR_CODES.length;

    const perInvestor = {};
    let group = {
      marketValue: 0, cash: groupCash, dividends: 0, realized: 0, unrealized: 0,
      deposits: cashFlow.totalDeposits, withdrawals: cashFlow.totalWithdrawals,
      fees: cashFlow.totalFees, totalValue: 0,
    };
    const investedByInvestor = deriveInvested(store);

    for (const code of INVESTOR_CODES) {
      const held = heldByInvestor.get(code);
      const costBag = costByInvestor.get(code);
      let mv = 0, realized = 0, unrealized = 0;
      const holdings = [];
      for (const h of held) {
        const cost = costBag.get(h.security);
        const avgCost = cost && cost.qty > 0 ? cost.costSum / cost.qty : (h.currentPrice || 0);
        const unrealizedH = (h.marketValueNok || 0) - avgCost * h.qty;
        const unrealizedPct = avgCost > 0 ? (unrealizedH / (avgCost * h.qty)) * 100 : 0;
        holdings.push({
          security: h.security, qty: h.qty,
          avgCost, currentPrice: h.currentPrice,
          marketValue: h.marketValueNok,
          unrealized: unrealizedH, unrealizedPct,
          weight: h.weight,
        });
        mv += h.marketValueNok || 0;
        unrealized += unrealizedH;
      }
      for (const cost of costBag.values()) realized += cost.realized;

      const dividends = divsByInvestor.get(code) || 0;
      const invested = investedByInvestor.get(code) || 0;
      const totalValue = mv + perInvestorCash;
      const netReturn = realized + unrealized + dividends;
      const portfolioReturnPct = invested > 0 ? (netReturn / invested) * 100 : 0;
      perInvestor[code] = {
        marketValue: mv, cash: perInvestorCash,
        dividends, realized, unrealized, invested,
        deposits: perInvestorDeposits,
        withdrawals: cashFlow.totalWithdrawals / INVESTOR_CODES.length,
        totalValue, netReturn, portfolioReturnPct,
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
    group.netDeposits = group.deposits - group.withdrawals;
    group.totalReturnPct = group.portfolioReturnPct;

    return {
      snapshotDate: snapshotDate(store),
      perInvestor,
      group,
      leaderboards: buildLeaderboards(store, perInvestor),
    };
  }

  function buildLeaderboards(store, perInvestor) {
    const allTime = INVESTOR_CODES.map((code) => ({
      code, value: perInvestor[code].totalReturnPct,
      totalValue: perInvestor[code].totalValue,
    })).sort((a, b) => b.value - a.value);

    const ytd = buildYtdLeaderboard(store, perInvestor);
    const bestPicks = buildBestPicks(store);
    const monthly = buildMonthlyLeaderboard(store);

    return { allTime, ytd, bestPicks, monthly };
  }

  function buildYtdLeaderboard(store, perInvestor) {
    const attrMap = store.attributionMap;
    const txs = store.transactions;
    const year = new Date().getUTCFullYear();
    const yearStart = `${year}-01-01`;
    const result = [];
    for (const code of INVESTOR_CODES) {
      let realizedYtd = 0, divsYtd = 0;
      for (const tx of txs) {
        if ((tx.tradeDate || '') < yearStart) continue;
        const cat = classify(tx.type);
        if (cat !== 'SELL' && cat !== 'DIVIDEND' && cat !== 'TAX') continue;
        const split = splitForSecurity(attrMap, tx.security);
        if (!split.length) continue;
        const slot = split.find((s) => s.code === code);
        if (!slot) continue;
        const w = slot.weight;
        if (cat === 'SELL' && isRealizingSell(tx.type)) realizedYtd += (tx.amount || 0) * w * 0.1;
        else if (cat === 'DIVIDEND' || cat === 'TAX') divsYtd += (tx.amount || 0) * w;
      }
      const base = perInvestor[code].deposits || 1;
      const value = ((divsYtd + realizedYtd) / base) * 100;
      result.push({ code, value });
    }
    return result.sort((a, b) => b.value - a.value);
  }

  function buildBestPicks(store) {
    const attrMap = store.attributionMap;
    const txs = store.transactions;
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
        if (cat === 'BUY' && tx.type === 'KJØPT') { slot.invested += Math.abs(amt); slot.qty += qty; }
        else if (cat === 'SELL' && isRealizingSell(tx.type)) { slot.returned += amt; slot.qty = Math.max(0, slot.qty - Math.abs(qty)); }
        else if (cat === 'DIVIDEND' || cat === 'TAX') { slot.returned += amt; }
      }
    }
    const holdings = currentHoldings(store);
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

  function buildMonthlyLeaderboard(store) {
    const attrMap = store.attributionMap;
    const txs = store.transactions;
    const now = new Date();
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      months.push(d.toISOString().slice(0, 7));
    }
    const result = [];
    for (const ym of months) {
      const ranks = INVESTOR_CODES.map((code) => {
        let pnl = 0;
        for (const tx of txs) {
          if (!tx.tradeDate || tx.tradeDate.slice(0, 7) !== ym) continue;
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

  // Previously-held securities — positions this investor used to own but
  // has fully exited. Walks transactions, attributes per the investor's
  // weight, and reuses the cost-basis bag for realized P/L.
  function previousHoldings(store, code) {
    const attrMap = store.attributionMap;
    const txs = store.transactions;
    const heldNow = new Set();
    for (const h of currentHoldings(store)) heldNow.add(canonicalName(h.security));

    const bySec = new Map();
    for (const tx of txs) {
      if (!tx.security) continue;
      const cat = classify(tx.type);
      if (cat !== 'BUY' && cat !== 'SELL' && cat !== 'DIVIDEND' && cat !== 'TAX') continue;
      const split = splitForSecurity(attrMap, tx.security);
      if (!split.length) continue;
      const slot = split.find((s) => s.code === code);
      if (!slot) continue;
      const w = slot.weight;
      const security = canonicalName(tx.security);
      if (!bySec.has(security)) {
        bySec.set(security, {
          security, invested: 0, proceeds: 0, dividends: 0,
          realized: 0, firstDate: null, lastDate: null,
        });
      }
      const m = bySec.get(security);
      const amt = (tx.amount || 0) * w;
      if (cat === 'BUY' && tx.type === 'KJØPT') m.invested += Math.abs(amt);
      else if (cat === 'SELL' && isRealizingSell(tx.type)) m.proceeds += amt;
      else if (cat === 'DIVIDEND' || cat === 'TAX') m.dividends += amt;
      if (tx.tradeDate) {
        if (!m.firstDate || tx.tradeDate < m.firstDate) m.firstDate = tx.tradeDate;
        if (!m.lastDate || tx.tradeDate > m.lastDate) m.lastDate = tx.tradeDate;
      }
    }

    // Pull authoritative realized from the cost-basis replay.
    const costBag = deriveCostBasis(store).get(code) || new Map();
    for (const [security, m] of bySec.entries()) {
      const slot = costBag.get(security);
      m.realized = slot ? slot.realized : (m.proceeds - m.invested);
    }

    const out = [];
    for (const [security, m] of bySec.entries()) {
      if (heldNow.has(security)) continue;
      if (m.invested === 0 && m.dividends === 0) continue;
      m.netResult = m.realized + m.dividends;
      m.returnPct = m.invested > 0 ? (m.netResult / m.invested) * 100 : 0;
      out.push(m);
    }
    out.sort((a, b) => (b.lastDate || '').localeCompare(a.lastDate || ''));
    return out;
  }

  // ─── Public entry points ─────────────────────────────────────────────────

  function buildDashboard(store, opts = {}) {
    const window = opts.from && opts.to ? { from: opts.from, to: opts.to } : computeWindow(store, opts.preset || 'ytd');
    const wm = windowMetrics(store, window.from, window.to);
    const base = buildDashboardSnapshot(store);
    return {
      ...base,
      window: { ...window, preset: opts.preset || 'ytd' },
      windowMetrics: wm,
      leaderboards: { ...base.leaderboards, period: wm.periodRanks },
    };
  }

  function investorDetail(store, code) {
    const dashboard = buildDashboard(store);
    const summary = dashboard.perInvestor[code];
    if (!summary) return null;
    const attrMap = store.attributionMap;
    const txs = store.transactions;
    const recent = [];
    for (const tx of txs.slice().reverse()) {
      if (!tx.security) continue;
      const split = splitForSecurity(attrMap, tx.security);
      if (!split.length) continue;
      const slot = split.find((s) => s.code === code);
      if (!slot) continue;
      const w = slot.weight;
      recent.push({
        tradeDate: tx.tradeDate, type: tx.type, security: canonicalName(tx.security),
        qty: tx.qty != null ? tx.qty * w : null, price: tx.price,
        amount: (tx.amount || 0) * w, weight: w,
      });
      if (recent.length >= 50) break;
    }
    return { code, summary, recent, previous: previousHoldings(store, code) };
  }

  window.Portfolio = {
    buildDashboard, investorDetail, canonicalName,
    currentHoldings, snapshotDate,
    pricesAtDate, snapshotForDate,
    cash: { latestSaldo, saldoOnOrBefore },
    _debug: { deriveCashFlow, deriveCostBasis, deriveDividends, deriveInvested },
  };
})();
