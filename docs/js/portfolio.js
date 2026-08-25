// Portfolio calculator. Same public API as the original (buildDashboard,
// investorDetail, pricesAtDate, canonicalName, …) — prices come from the
// StockPrices date×ticker matrix (window.Prices) and quantities from the
// transaction replay (window.Positions). If the price matrix is empty the
// helpers return empty results and the views surface a "price feed not
// active" notice.

(function () {
  const { INVESTOR_CODES, classify, splitForSecurity, isRealizingSell, isCashLeg, isPricedBuy, amountNok } = window.Ledger;

  // Legacy fallback aliases — used only until the Securities registry is
  // populated (it carries aliases per security and supersedes this map).
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

  // The Securities registry is attached at hydration (Store.hydrate).
  let registry = null;
  function _setRegistry(r) { registry = r; }

  function canonicalName(security) {
    if (!security) return security;
    if (registry) {
      const hit = registry.forName(security);
      if (hit) return hit.name;
    }
    const lower = String(security).trim().toLowerCase();
    if (NAME_ALIASES[lower]) return NAME_ALIASES[lower];
    return String(security).trim();
  }

  function usePriceMatrix(store) {
    return !!(store.prices && store.prices.hasData && registry);
  }

  // ─── Price maps ──────────────────────────────────────────────────────────
  // Shape kept from the snapshot era: Map(security → {price, marketValueNok,
  // qty}) where price is native currency and marketValueNok/qty gives the
  // NOK per-share value. Group-level qty.

  function today() { return new Date().toISOString().slice(0, 10); }

  function snapshotDate(store) {
    return usePriceMatrix(store) ? store.prices.latestDate : null;
  }

  function pricesAtDate(store, date) {
    const map = new Map();
    if (!usePriceMatrix(store)) return map;
    for (const h of window.Positions.holdingsAt(store, date)) {
      const sec = registry.forName(h.security);
      if (sec && sec.status === 'ignore') continue;
      // nokPriceAround: for dates before the backfilled history, value at the
      // earliest known close rather than dropping the position — a missing
      // entry reads as price 0 in windowMetrics and fabricates P/L.
      const nok = window.Prices.nokPriceAround(store.prices, sec, date);
      if (nok == null) continue;
      const native = sec ? window.Prices.priceOn(store.prices, sec.ticker, date) : nok;
      map.set(h.security, { price: native, marketValueNok: nok * h.qty, qty: h.qty });
    }
    return map;
  }

  function currentPrices(store) {
    return pricesAtDate(store, today());
  }

  function nokPerShare(px) {
    if (!px) return 0;
    return (px.marketValueNok != null && px.qty) ? px.marketValueNok / px.qty : (px.price || 0);
  }

  // NOK close for one security on a date (null when unknown). Handy for
  // per-stock charts; forward-fills via the price matrix.
  function nokPriceForSecurity(store, security, date) {
    if (!usePriceMatrix(store)) return null;
    const sec = registry.forName(security);
    // Historical lookup: real closes first, the club's own trade prices for
    // securities the market no longer quotes (delisted/bankrupt).
    return window.Prices.nokPriceHist(store.prices, sec, date);
  }

  // Current holdings, derived from the replay + latest prices. Field names
  // match the old snapshot rows (both camelCase and the snake_case aliases
  // the dashboard-era code used) so consumers keep working.
  function currentHoldings(store) {
    if (!usePriceMatrix(store)) return [];
    const date = today();
    const out = [];
    for (const h of window.Positions.holdingsAt(store, date)) {
      const sec = registry.forName(h.security);
      // 'ignore' = deliberately untracked residue (expired subscription
      // rights, acceptance lines) — keep it out of holdings and KPIs.
      if (sec && sec.status === 'ignore') continue;
      const nok = window.Prices.nokPriceOn(store.prices, sec, date);
      const native = sec && sec.ticker ? window.Prices.priceOn(store.prices, sec.ticker, date) : null;
      const mv = nok != null ? nok * h.qty : null;
      const returnNok = mv != null ? mv - h.costSum : null;
      out.push({
        snapshotDate: store.prices.latestDate,
        security: h.security,
        isin: sec ? sec.isin : null,
        currency: sec ? sec.currency : h.currency,
        qty: h.qty,
        gav: h.avgCost,
        currentPrice: native,
        current_price: native,
        marketValueNok: mv,
        market_value_nok: mv,
        returnNok,
        returnPct: h.costSum > 0 && returnNok != null ? (returnNok / h.costSum) * 100 : null,
        priced: nok != null,
      });
    }
    return out.sort((a, b) => (b.marketValueNok || 0) - (a.marketValueNok || 0));
  }

  // ─── Cost basis / cashflow / dividends ───────────────────────────────────

  function deriveCostBasis(store) {
    const attrMap = store.attributionMap;
    const perInvestor = new Map();
    for (const code of INVESTOR_CODES) perInvestor.set(code, new Map());
    // Conversion cost transfer, keyed per (investor, pair id).
    const convBucket = new Map();
    const convDrained = new Set();
    const drainFrom = (slot, q, key) => {
      if (!slot || convDrained.has(key)) return 0;
      convDrained.add(key);
      const frac = slot.qty > 0 ? Math.min(q / slot.qty, 1) : 0;
      const t = slot.costSum * frac;
      slot.costSum -= t;
      return t;
    };

    for (const tx of store.transactions) {
      if (!tx.security) continue;
      const cat = classify(tx.type);
      if (cat !== 'BUY' && cat !== 'SELL') continue;
      if (isCashLeg(tx.type)) continue; // cash settlement — no share movement
      // Corporate actions (BYTTE, SPLITT, spinoffs) move qty but never touch
      // cost: a split halves avg cost implicitly, a spinoff parent keeps its
      // basis. Only KJØPT adds cost; only realizing sells remove it.
      const split = splitForSecurity(attrMap, tx.security);
      if (!split.length) continue;
      const security = canonicalName(tx.security);
      const qty = Math.abs(tx.qty || 0);
      const amount = amountNok(tx);
      for (const { code, weight } of split) {
        const bag = perInvestor.get(code);
        if (!bag.has(security)) bag.set(security, { qty: 0, costSum: 0, realized: 0 });
        const slot = bag.get(security);
        const wq = qty * weight;
        if (cat === 'BUY') {
          slot.qty += wq;
          if (isPricedBuy(tx)) slot.costSum += Math.abs(amount * weight);
          if (tx._convRole === 'in') {
            const key = code + '|' + tx._convId;
            if (convBucket.has(key)) slot.costSum += convBucket.get(key);
            else slot.costSum += drainFrom(bag.get(canonicalName(tx._convOther)), wq, key);
          }
        } else {
          if (tx._convRole === 'out') {
            const key = code + '|' + tx._convId;
            const t = drainFrom(slot, wq, key);
            if (t > 0) convBucket.set(key, t);
          }
          if (isRealizingSell(tx.type)) {
            const avgCost = slot.qty > 0 ? slot.costSum / slot.qty : 0;
            slot.realized += amount * weight - avgCost * wq;
            const fracSold = slot.qty > 0 ? Math.min(wq / slot.qty, 1) : 0;
            slot.costSum = Math.max(0, slot.costSum - slot.costSum * fracSold);
          }
          slot.qty = Math.max(0, slot.qty - wq);
        }
      }
    }
    return perInvestor;
  }

  function deriveInvested(store) {
    const attrMap = store.attributionMap;
    const perInvestor = new Map();
    for (const code of INVESTOR_CODES) perInvestor.set(code, 0);
    for (const tx of store.transactions) {
      if (!tx.security || !isPricedBuy(tx)) continue;
      const split = splitForSecurity(attrMap, tx.security);
      if (!split.length) continue;
      for (const { code, weight } of split) {
        perInvestor.set(code, perInvestor.get(code) + Math.abs(amountNok(tx)) * weight);
      }
    }
    return perInvestor;
  }

  function deriveDividends(store) {
    const attrMap = store.attributionMap;
    const perInvestor = new Map();
    for (const code of INVESTOR_CODES) perInvestor.set(code, 0);
    for (const tx of store.transactions) {
      const cat = classify(tx.type);
      if (cat !== 'DIVIDEND' && cat !== 'TAX') continue;
      const split = splitForSecurity(attrMap, tx.security);
      if (!split.length) continue;
      for (const { code, weight } of split) {
        perInvestor.set(code, perInvestor.get(code) + amountNok(tx) * weight);
      }
    }
    return perInvestor;
  }

  // Nordnet's running "Saldo" is the authoritative cash figure.
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
    let totalDeposits = 0, totalWithdrawals = 0, totalFees = 0, netDividends = 0, totalBuys = 0, totalSells = 0;
    for (const tx of store.transactions) {
      const cat = classify(tx.type);
      const amount = amountNok(tx);
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
          // Keep null when unpriced — coercing to 0 would book a phantom
          // 100% loss into every KPI downstream.
          marketValueNok: h.market_value_nok != null ? h.market_value_nok * weight : null,
          priced: h.priced !== false && h.market_value_nok != null,
          weight,
          currency: h.currency,
        });
      }
    }
    return perInvestor;
  }

  // ─── Window picker ───────────────────────────────────────────────────────

  function computeWindow(store, preset) {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
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
      case '1m': return { from: addMonths(now, -1), to: todayStr };
      case '6m': return { from: addMonths(now, -6), to: todayStr };
      case '1y': return { from: addYears(now, -1), to: todayStr };
      case 'all': return { from: earliest, to: todayStr };
      case 'ytd':
      default:    return { from: `${now.getUTCFullYear()}-01-01`, to: todayStr };
    }
  }

  // Window metrics — start and end market values are now priced with the
  // actual closes on those dates (the old code priced both ends with
  // today's snapshot, which made "unrealized delta in window" a fiction).
  function windowMetrics(store, from, to) {
    const attrMap = store.attributionMap;
    const txs = store.transactions;
    const pricesStart = pricesAtDate(store, from);
    const pricesEnd = pricesAtDate(store, to);

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
    // Conversion cost transfer (see deriveCostBasis) — buckets persist across
    // the pre-window and in-window passes since a pair can straddle `from`.
    const convBucket = new Map();
    const convDrained = new Set();
    const convDrain = (slot, q, key) => {
      if (!slot || convDrained.has(key)) return 0;
      convDrained.add(key);
      const frac = slot.qty > 0 ? Math.min(q / slot.qty, 1) : 0;
      const t = slot.costSum * frac;
      slot.costSum -= t;
      return t;
    };
    const convApply = (state, slot, tx, q, code) => {
      if (tx._convRole === 'in') {
        const key = code + '|' + tx._convId;
        if (convBucket.has(key)) slot.costSum += convBucket.get(key);
        else slot.costSum += convDrain(state.perSec.get(canonicalName(tx._convOther)), q, key);
      } else if (tx._convRole === 'out') {
        const key = code + '|' + tx._convId;
        const t = convDrain(slot, q, key);
        if (t > 0) convBucket.set(key, t);
      }
    };

    // Pre-window replay. Corporate actions (BYTTE/SPLITT/…) move qty but
    // not cost, same rules as Positions — otherwise the endpoint market
    // values are wrong for any security that split or was spun off.
    for (const tx of txs) {
      if (!tx.security) continue;
      if ((tx.tradeDate || '') >= from) break;
      const preCat = classify(tx.type);
      if (preCat !== 'BUY' && preCat !== 'SELL') continue;
      if (isCashLeg(tx.type)) continue; // cash settlement — no share movement
      const split = splitForSecurity(attrMap, tx.security);
      if (!split.length) continue;
      const security = canonicalName(tx.security);
      for (const { code, weight } of split) {
        const state = states.get(code);
        const slot = ensureSec(state, security);
        const amt = amountNok(tx) * weight;
        const q = Math.abs(tx.qty || 0) * weight;
        convApply(state, slot, tx, q, code);
        if (preCat === 'BUY') {
          slot.qty += q;
          if (isPricedBuy(tx)) slot.costSum += Math.abs(amt);
        } else {
          if (isRealizingSell(tx.type)) {
            const fracSold = slot.qty > 0 ? Math.min(q / slot.qty, 1) : 0;
            slot.costSum = Math.max(0, slot.costSum - slot.costSum * fracSold);
          }
          slot.qty = Math.max(0, slot.qty - q);
        }
      }
    }
    for (const code of INVESTOR_CODES) {
      const state = states.get(code);
      let cost = 0, mv = 0;
      for (const [security, slot] of state.perSec.entries()) {
        // An open position with no price is unknowable — excluding only its
        // MV would book a phantom full-cost loss, so exclude cost too.
        const px = pricesStart.get(security);
        if (slot.qty > 0 && !px) continue;
        cost += slot.costSum;
        mv += slot.qty * nokPerShare(px);
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
          const amt = amountNok(tx) * weight;
          slot.divs += amt;
          state.dividendsInWindow += amt;
        }
      } else if (isPricedBuy(tx) || isRealizingSell(tx.type)) {
        const split = splitForSecurity(attrMap, tx.security);
        if (!split.length) continue;
        const security = canonicalName(tx.security);
        for (const { code, weight } of split) {
          const state = states.get(code);
          const slot = ensureSec(state, security);
          const amt = amountNok(tx) * weight;
          const q = (tx.qty || 0) * weight;
          if (isPricedBuy(tx)) {
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
      } else if ((cat === 'BUY' || cat === 'SELL') && !isCashLeg(tx.type)) {
        // In-window corporate action: qty moves, no cost/realized/counters.
        const split = splitForSecurity(attrMap, tx.security);
        if (!split.length) continue;
        const security = canonicalName(tx.security);
        for (const { code, weight } of split) {
          const state = states.get(code);
          const slot = ensureSec(state, security);
          const q = Math.abs(tx.qty || 0) * weight;
          convApply(state, slot, tx, q, code);
          if (cat === 'BUY') slot.qty += q;
          else slot.qty = Math.max(0, slot.qty - q);
        }
      }
    }

    for (const code of INVESTOR_CODES) {
      const state = states.get(code);
      let cost = 0, mv = 0;
      for (const [security, slot] of state.perSec.entries()) {
        const px = pricesEnd.get(security);
        if (slot.qty > 0 && !px) continue;
        cost += slot.costSum;
        mv += slot.qty * nokPerShare(px);
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
      const unrealizedDelta = (state.mvAtEnd - state.costAtEnd) - (state.mvAtStart - state.costAtStart);
      const netPnl = state.realizedInWindow + state.dividendsInWindow + unrealizedDelta;
      const base = Math.max(state.costAtStart + state.buysInWindow, 1);
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
        periodReturnPct: (netPnl / base) * 100,
      };
      group.realizedInWindow += state.realizedInWindow;
      group.dividendsInWindow += state.dividendsInWindow;
      group.buysInWindow += state.buysInWindow;
      group.sellsInWindow += state.sellsInWindow;
      group.buyCount += state.buyCount;
      group.sellCount += state.sellCount;
      group.unrealizedDeltaInWindow += unrealizedDelta;
      group.netPnlInWindow += netPnl;
      group.base += Math.max(state.costAtStart + state.buysInWindow, 1);
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
        // Unpriced holding (no ticker / no data yet): contributes nothing to
        // MV or unrealized instead of a fabricated full-cost loss.
        const unrealizedH = h.priced === false ? 0 : (h.marketValueNok || 0) - avgCost * h.qty;
        const unrealizedPct = h.priced === false ? null
          : (avgCost > 0 ? (unrealizedH / (avgCost * h.qty)) * 100 : 0);
        holdings.push({
          security: h.security, qty: h.qty,
          avgCost, currentPrice: h.currentPrice,
          marketValue: h.marketValueNok,
          unrealized: h.priced === false ? null : unrealizedH,
          unrealizedPct,
          priced: h.priced !== false,
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

    return {
      allTime,
      ytd: buildYtdLeaderboard(store, perInvestor),
      bestPicks: buildBestPicks(store),
      monthly: buildMonthlyLeaderboard(store),
    };
  }

  function buildYtdLeaderboard(store, perInvestor) {
    const attrMap = store.attributionMap;
    const txs = store.transactions;
    const yearStart = `${new Date().getUTCFullYear()}-01-01`;
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
        if (cat === 'SELL' && isRealizingSell(tx.type)) realizedYtd += amountNok(tx) * slot.weight;
        else if (cat === 'DIVIDEND' || cat === 'TAX') divsYtd += amountNok(tx) * slot.weight;
      }
      const base = perInvestor[code].deposits || 1;
      result.push({ code, value: ((divsYtd + realizedYtd) / base) * 100 });
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
        const amt = amountNok(tx) * weight;
        const qty = (tx.qty || 0) * weight;
        if (cat === 'BUY' && tx.type === 'KJØPT') { slot.invested += Math.abs(amt); slot.qty += qty; }
        else if (cat === 'SELL' && isRealizingSell(tx.type)) { slot.returned += amt; slot.qty = Math.max(0, slot.qty - Math.abs(qty)); }
        else if (cat === 'DIVIDEND' || cat === 'TAX') { slot.returned += amt; }
      }
    }
    const priceMap = new Map();
    for (const h of currentHoldings(store)) priceMap.set(h.security, h);

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
    out.sort((a, b) => {
      const ar = a.pick ? a.pick.return : -Infinity;
      const br = b.pick ? b.pick.return : -Infinity;
      return br - ar;
    });
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
          pnl += amountNok(tx) * slot.weight;
        }
        return { code, value: pnl };
      });
      ranks.sort((a, b) => b.value - a.value);
      result.push({ month: ym, ranks });
    }
    return result.reverse();
  }

  // Previously-held securities — fully exited positions for one investor.
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
          security, weight: w, invested: 0, proceeds: 0, dividends: 0,
          realized: 0, firstDate: null, lastDate: null,
        });
      }
      const m = bySec.get(security);
      const amt = amountNok(tx) * w;
      if (cat === 'BUY' && tx.type === 'KJØPT') m.invested += Math.abs(amt);
      else if (cat === 'SELL' && isRealizingSell(tx.type)) m.proceeds += amt;
      else if (cat === 'DIVIDEND' || cat === 'TAX') m.dividends += amt;
      if (tx.tradeDate) {
        if (!m.firstDate || tx.tradeDate < m.firstDate) m.firstDate = tx.tradeDate;
        if (!m.lastDate || tx.tradeDate > m.lastDate) m.lastDate = tx.tradeDate;
      }
    }

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
    const win = opts.from && opts.to ? { from: opts.from, to: opts.to } : computeWindow(store, opts.preset || 'ytd');
    const wm = windowMetrics(store, win.from, win.to);
    const base = buildDashboardSnapshot(store);
    return {
      ...base,
      window: { ...win, preset: opts.preset || 'ytd' },
      windowMetrics: wm,
      leaderboards: { ...base.leaderboards, period: wm.periodRanks },
    };
  }

  function investorDetail(store, code) {
    const dashboard = buildDashboard(store);
    const summary = dashboard.perInvestor[code];
    if (!summary) return null;
    const attrMap = store.attributionMap;
    const recent = [];
    for (const tx of store.transactions.slice().reverse()) {
      if (!tx.security) continue;
      const split = splitForSecurity(attrMap, tx.security);
      if (!split.length) continue;
      const slot = split.find((s) => s.code === code);
      if (!slot) continue;
      recent.push({
        tradeDate: tx.tradeDate, type: tx.type, security: canonicalName(tx.security),
        qty: tx.qty != null ? tx.qty * slot.weight : null, price: tx.price,
        amount: amountNok(tx) * slot.weight, weight: slot.weight,
      });
      if (recent.length >= 50) break;
    }
    return { code, summary, recent, previous: previousHoldings(store, code) };
  }

  window.Portfolio = {
    buildDashboard, investorDetail, canonicalName,
    currentHoldings, previousHoldings, snapshotDate,
    pricesAtDate,
    // "Which date are these prices actually from?" — the last price row on
    // or before `date`.
    snapshotForDate: (store, date) => {
      if (!usePriceMatrix(store)) return null;
      let best = null;
      for (const d of store.prices.dates) { if (d <= date) best = d; else break; }
      return best;
    },
    nokPriceForSecurity, computeWindow, windowMetrics, usePriceMatrix,
    cash: { latestSaldo, saldoOnOrBefore },
    _setRegistry,
    _debug: { deriveCashFlow, deriveCostBasis, deriveDividends, deriveInvested },
  };
})();
