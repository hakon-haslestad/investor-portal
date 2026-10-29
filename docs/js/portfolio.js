// Portfolio calculator. Same public API as the original (buildDashboard,
// investorDetail, pricesAtDate, canonicalName, …) — prices come from the
// StockPrices date×ticker matrix (window.Prices) and quantities from the
// transaction replay (window.Positions). If the price matrix is empty the
// helpers return empty results and the views surface a "price feed not
// active" notice.

(function () {
  const { INVESTOR_CODES, classify, splitForSecurity, isRealizingSell, isCashLeg, isPricedBuy, amountNok } = window.Ledger;
  // Gain % of invested uses the cost of shares still held, unless that is
  // below this share of everything bought (see buildDashboard).
  const NET_INVESTED_MIN_SHARE = 0.25;

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

  // Year-end price for the calculated books (one-sheet, issue #85): the last
  // trading-day close on or before `date`, in NOK with the FX rate of that
  // day. Never a later price (valueAround would borrow one). A security the
  // market no longer quotes falls back to the club's own last trade price.
  // Returns { nok, date, source } or null. Looked up by ISIN first, then name.
  function yearEndPrice(store, security, isin, date) {
    if (!registry || !store || !store.prices || !store.prices.hasData) return null;
    const P = window.Prices, m = store.prices;
    const sec = (isin && registry.forIsin(isin)) || registry.forName(security);
    if (!sec) return null;
    // status `delisted` (set by hand in Securities): bankrupt or struck off.
    // A year-end while it still traded keeps its close (from the last week of
    // the year); after that, and never from old own trades, it is worth 0.
    const delisted = sec.status === 'delisted';
    if (sec.ticker) {
      const px = P.priceOn(m, sec.ticker, date), fx = P.fxOn(m, sec.currency, date);
      if (px != null && fx != null) {
        const cur = (sec.currency || 'NOK').toUpperCase();
        const fxDate = cur === 'NOK' ? null : P.lastDateOn(m, 'CUR:' + cur + 'NOK', date);
        const pxDate = P.lastDateOn(m, sec.ticker, date);
        const recent = pxDate >= `${String(date).slice(0, 4)}-12-24`;
        if (!delisted || recent) return { nok: px * fx, date: fxDate && fxDate < pxDate ? fxDate : pxDate, source: 'close' };
      }
    }
    if (delisted) return { nok: 0, date: null, source: 'delisted' };
    const syn = m.series.get('TX:' + sec.name);
    const own = syn ? P.valueOn(syn, date) : null;
    if (own != null) return { nok: own, date: P.lastDateOn(m, 'TX:' + sec.name, date), source: 'last own trade' };
    return null;
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
  function currentHoldings(store, now) {
    if (!usePriceMatrix(store)) return [];
    const date = now || today();
    const out = [];
    for (const h of window.Positions.holdingsAt(store, date)) {
      const sec = registry.forName(h.security);
      // 'ignore' = deliberately untracked residue (expired subscription
      // rights, acceptance lines) — keep it out of holdings and KPIs.
      if (sec && sec.status === 'ignore') continue;
      // Strict NOK mark first (real close × real FX); when that's not
      // possible (missing FX pair, delisted name) fall back to the own-trade
      // approximation so big positions don't vanish from the totals — the
      // row is flagged `approx` and rendered with a ≈.
      const strict = window.Prices.nokPriceOn(store.prices, sec, date);
      const nok = strict != null ? strict : window.Prices.nokPriceAround(store.prices, sec, date);
      const native = sec && sec.ticker ? window.Prices.priceOn(store.prices, sec.ticker, date) : null;
      const mv = nok != null ? nok * h.qty : null;
      // This ticker's own newest close, not the matrix-wide newest date.
      const priceDate = sec && sec.ticker ? window.Prices.lastDateOn(store.prices, sec.ticker, date) : null;
      const age = window.Prices.ageInfo(priceDate, date);
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
        priceDate, priceAgeDays: age.days, stale: age.stale,
        priced: nok != null,
        approx: strict == null && nok != null,
      });
    }
    return out.sort((a, b) => (b.marketValueNok || 0) - (a.marketValueNok || 0));
  }

  // ─── Point-in-time valuations (for period-comparison KPIs) ───────────────

  // Group-level book at end of `date`: market value (trade-price fallback
  // for delisted names), cash (last Saldo ≤ date), cost basis, unrealized.
  function groupValueAt(store, date) {
    let mv = 0, cost = 0;
    if (usePriceMatrix(store)) {
      for (const h of window.Positions.holdingsAt(store, date)) {
        const sec = registry.forName(h.security);
        if (sec && sec.status === 'ignore') continue;
        const px = window.Prices.nokPriceAround(store.prices, sec, date);
        if (px == null) continue;
        mv += px * h.qty;
        cost += h.costSum;
      }
    }
    const cash = saldoOnOrBefore(store, date) || 0;
    return { mv, cash, total: mv + cash, cost, unrealized: mv - cost };
  }

  // One investor's attributed slice of the same, plus their 1/5 cash share.
  function investorValueAt(store, code, date) {
    let mv = 0, cost = 0;
    if (usePriceMatrix(store)) {
      for (const h of window.Positions.holdingsAt(store, date)) {
        const sec = registry.forName(h.security);
        if (sec && sec.status === 'ignore') continue;
        const split = splitForSecurity(store.attributionMap, h.security);
        const slot = split.find((x) => x.code === code);
        if (!slot) continue;
        const px = window.Prices.nokPriceAround(store.prices, sec, date);
        if (px == null) continue;
        mv += px * h.qty * slot.weight;
        cost += h.costSum * slot.weight;
      }
    }
    const cash = (saldoOnOrBefore(store, date) || 0) / INVESTOR_CODES.length;
    return { mv, cash, total: mv + cash, cost, unrealized: mv - cost };
  }

  // ─── Cost basis / cashflow / dividends ───────────────────────────────────

  // `onRealized(code, tx, delta)` is called for every realizing sell with the
  // profit it banked (proceeds minus average cost), so period views reuse the
  // same cost replay instead of copying it.
  function deriveCostBasis(store, onRealized) {
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
            const delta = amount * weight - avgCost * wq;
            slot.realized += delta;
            if (onRealized) onRealized(code, tx, delta);
            const fracSold = slot.qty > 0 ? Math.min(wq / slot.qty, 1) : 0;
            slot.costSum = Math.max(0, slot.costSum - slot.costSum * fracSold);
          }
          slot.qty = Math.max(0, slot.qty - wq);
        }
        if (tx.totalAfter != null && Number.isFinite(tx.totalAfter) && tx.totalAfter >= 0) {
          slot.qty = tx.totalAfter * weight;
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
      // Per-trade commissions (Totale Avgifter) count toward the fees total.
      // Informational only: Nordnet embeds them in Beløp, so realized and
      // cost basis already net them — never subtract this from returns.
      if (cat === 'BUY' || cat === 'SELL') totalFees += Math.abs(window.Ledger.feeNok(tx));
      if (cat === 'DEPOSIT') totalDeposits += amount;
      else if (cat === 'WITHDRAWAL') totalWithdrawals += Math.abs(amount);
      else if (cat === 'FEE') totalFees += Math.abs(amount);
      else if (cat === 'DIVIDEND' || cat === 'TAX') netDividends += amount;
      else if (cat === 'BUY' && tx.type === 'KJØPT') totalBuys += Math.abs(amount);
      else if (cat === 'SELL' && isRealizingSell(tx.type)) totalSells += amount;
    }
    return { totalDeposits, totalWithdrawals, totalFees, netDividends, totalBuys, totalSells };
  }

  function attributeCurrentHoldings(store, now) {
    const attrMap = store.attributionMap;
    const holdings = currentHoldings(store, now);
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
        buyTrades: new Set(), sellTrades: new Set(),
        costAtStart: 0, mvAtStart: 0,
        costAtEnd: 0, mvAtEnd: 0,
        perSec: new Map(),
      });
    }
    // A trade split across investors is still one trade: the group counts the
    // transaction objects, each investor counts the ones they took part in.
    const groupBuys = new Set(), groupSells = new Set();
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
            state.buyTrades.add(tx); groupBuys.add(tx);
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
            state.sellTrades.add(tx); groupSells.add(tx);
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
      buyCount: groupBuys.size, sellCount: groupSells.size,
      buyTrades: groupBuys, sellTrades: groupSells,
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
        buyCount: state.buyTrades.size,
        sellCount: state.sellTrades.size,
        buyTrades: state.buyTrades,
        sellTrades: state.sellTrades,
        unrealizedDeltaInWindow: unrealizedDelta,
        netPnlInWindow: netPnl,
        basis: base,
        periodReturnPct: (netPnl / base) * 100,
      };
      group.realizedInWindow += state.realizedInWindow;
      group.dividendsInWindow += state.dividendsInWindow;
      group.buysInWindow += state.buysInWindow;
      group.sellsInWindow += state.sellsInWindow;
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

  // The one club total: every priced position (owned, `Alle` or nobody's)
  // plus the Nordnet saldo. Dashboard, Portfolio and Investors all read this.
  function clubTotal(store, now) {
    let attributed = 0, unattributed = 0;
    const unattributedNames = [];
    for (const h of currentHoldings(store, now)) {
      const mv = h.marketValueNok || 0;
      // Column C is each investor's share: only min(1, sum of weights) of the
      // value has an owner, the rest is unattributed (`Alle` sums to 1).
      const weights = splitForSecurity(store.attributionMap, h.security).reduce((a, x) => a + (Number(x.weight) || 0), 0);
      const owned = mv * Math.min(1, Math.max(0, weights));
      attributed += owned;
      if (mv - owned > 0.005) { unattributed += mv - owned; unattributedNames.push(h.security); }
    }
    const cash = latestSaldo(store);
    return {
      marketValue: attributed + unattributed, attributed, unattributed, cash,
      total: attributed + unattributed + cash, unattributedNames,
      missingFx: window.Ledger.missingFxTxs(store.transactions).length,
    };
  }

  // One plain object with the club's headline numbers at `asOf` (an ISO date
  // or a Date; today when omitted). Built only from clubTotal, the dashboard
  // snapshot and windowMetrics, so every view that shows these numbers can
  // read them from here and agree. For a past `asOf` only transactions traded
  // on or before that day count. Never throws on an empty store or no prices.
  function summary(store, asOf) {
    // Duck-typed: a Date from another realm is not `instanceof Date`.
    const iso = asOf && typeof asOf.toISOString === 'function' ? asOf.toISOString() : String(asOf || '');
    const date = /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : today();
    const txs = store.transactions || [];
    const scoped = asOf && date !== today() ? { ...store, transactions: txs.filter((t) => !t.tradeDate || t.tradeDate <= date) } : store;
    const club = clubTotal(scoped, date);
    const g = buildDashboardSnapshot(scoped, date).group;
    const ytd = windowMetrics(scoped, `${date.slice(0, 4)}-01-01`, date).group.netPnlInWindow;
    const holdings = currentHoldings(scoped, date);
    const top = holdings.filter((h) => h.priced !== false && (h.marketValueNok || 0) > 0).slice(0, 3).map((h) => ({
      security: h.security, marketValue: h.marketValueNok,
      weightPct: club.marketValue > 0 ? (h.marketValueNok / club.marketValue) * 100 : 0,
    }));
    return {
      asOf: date,
      hasData: txs.length > 0,
      value: { total: club.total, marketValue: club.marketValue, cash: club.cash, attributed: club.attributed, unattributed: club.unattributed },
      cashPct: club.total > 0 ? (club.cash / club.total) * 100 : null,
      stocksPct: club.total > 0 ? (club.marketValue / club.total) * 100 : null,
      invested: g.invested,
      profit: { total: g.netReturn, realized: g.realized, unrealized: g.unrealized, dividends: g.dividends, ytd },
      // Profit over total bought, the metric of record today.
      returnPct: g.portfolioReturnPct,
      top,
      staleCount: holdings.filter((h) => h.stale).length,
      missingFx: club.missingFx,
      unattributedNames: club.unattributedNames,
      // Look-through earnings and quarter numbers from the KPI tab, as entered
      // in the sheet; null when there are none (or Fundamentals is not loaded).
      earnings: businessEarnings(scoped),
    };
  }

  function businessEarnings(store) {
    if (!window.Fundamentals || !window.Fundamentals.boardSummary) return null;
    try { return window.Fundamentals.boardSummary(store); } catch (err) { return null; }
  }

  function buildDashboardSnapshot(store, now) {
    const heldByInvestor = attributeCurrentHoldings(store, now);
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
      let mv = 0, realized = 0, unrealized = 0, costHeld = 0;
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
          // Profit already banked on this position's partial sells — the
          // reason the Realized KPI can beat the sum of exited positions.
          realized: cost ? cost.realized : 0,
          priced: h.priced !== false,
          weight: h.weight,
        });
        mv += h.marketValueNok || 0;
        unrealized += unrealizedH;
        costHeld += avgCost * h.qty;
      }
      for (const cost of costBag.values()) realized += cost.realized;

      const dividends = divsByInvestor.get(code) || 0;
      const invested = investedByInvestor.get(code) || 0;
      const totalValue = mv + perInvestorCash;
      const netReturn = realized + unrealized + dividends;
      const portfolioReturnPct = invested > 0 ? (netReturn / invested) * 100 : 0;
      // Gain on what is still invested: total gain / cost of the shares held.
      // After a big sell-off that base gets tiny and the % explodes (a 20k gain
      // on 5k still held is 400%), so below 25% of everything bought the base
      // falls back to everything bought, and says so.
      const netBase = costHeld >= NET_INVESTED_MIN_SHARE * invested && costHeld > 0;
      const gainBase = netBase ? costHeld : invested;
      const gainPct = gainBase > 0 ? (netReturn / gainBase) * 100 : 0;
      perInvestor[code] = {
        marketValue: mv, cash: perInvestorCash,
        dividends, realized, unrealized, invested,
        deposits: perInvestorDeposits,
        withdrawals: cashFlow.totalWithdrawals / INVESTOR_CODES.length,
        totalValue, netReturn, portfolioReturnPct,
        costHeld, gainBase, gainPct, gainBaseKind: netBase ? 'held' : 'bought',
        totalReturnPct: portfolioReturnPct,
        holdings: holdings.sort((a, b) => b.marketValue - a.marketValue),
      };
      group.marketValue += mv;
      group.realized += realized;
      group.unrealized += unrealized;
      group.dividends += dividends;
    }
    // Club level counts what nobody owns too; the five investors do not.
    const club = clubTotal(store, now);
    group.marketValue = club.marketValue;
    group.totalValue = club.total;
    group.club = club;
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

  function buildLeaderboards(store, perInvestor, now = new Date()) {
    const allTime = INVESTOR_CODES.map((code) => ({
      code, value: perInvestor[code].totalReturnPct,
      totalValue: perInvestor[code].totalValue,
    })).sort((a, b) => b.value - a.value);

    return {
      allTime,
      ytd: buildYtdLeaderboard(store, perInvestor, now),
      bestPicks: buildBestPicks(store),
      monthly: buildMonthlyLeaderboard(store, perInvestor, now),
    };
  }

  // Realized profit (sell price minus average cost) plus net dividends and
  // tax, per investor and bucket. `bucketOf(tradeDate)` returns a key, or
  // null to leave the date out.
  function profitByBucket(store, bucketOf) {
    const out = new Map(INVESTOR_CODES.map((code) => [code, new Map()]));
    const add = (code, date, amt) => {
      const key = bucketOf(date || '');
      if (key == null) return;
      out.get(code).set(key, (out.get(code).get(key) || 0) + amt);
    };
    deriveCostBasis(store, (code, tx, delta) => add(code, tx.tradeDate, delta));
    for (const tx of store.transactions) {
      const cat = classify(tx.type);
      if (cat !== 'DIVIDEND' && cat !== 'TAX') continue;
      for (const { code, weight } of splitForSecurity(store.attributionMap, tx.security)) {
        add(code, tx.tradeDate, amountNok(tx) * weight);
      }
    }
    return out;
  }

  const pctOfDeposits = (value, perInvestor, code) => {
    const base = perInvestor[code].deposits;
    return base > 0 ? (value / base) * 100 : 0;
  };

  // Realized profit + dividends since 1 Jan, as % of the investor's deposits.
  function buildYtdLeaderboard(store, perInvestor, now = new Date()) {
    const yearStart = `${now.getUTCFullYear()}-01-01`;
    const today = now.toISOString().slice(0, 10);
    const profit = profitByBucket(store, (d) => (d >= yearStart && d <= today ? 'ytd' : null));
    return INVESTOR_CODES.map((code) => ({
      code, value: pctOfDeposits(profit.get(code).get('ytd') || 0, perInvestor, code),
    })).sort((a, b) => b.value - a.value);
  }

  // Best single bet: the security with the highest total return in % of what
  // was put in. A holding with no price is skipped, never counted as a loss.
  function buildBestPicks(store, holdings = currentHoldings(store)) {
    const attrMap = store.attributionMap;
    const perInvestor = new Map();
    for (const code of INVESTOR_CODES) perInvestor.set(code, new Map());

    for (const tx of store.transactions) {
      if (!tx.security) continue;
      const cat = classify(tx.type);
      if (cat !== 'BUY' && cat !== 'SELL' && cat !== 'DIVIDEND' && cat !== 'TAX') continue;
      const split = splitForSecurity(attrMap, tx.security);
      if (!split.length) continue;
      const security = canonicalName(tx.security);
      for (const { code, weight } of split) {
        const bag = perInvestor.get(code);
        if (!bag.has(security)) bag.set(security, { invested: 0, returned: 0 });
        const slot = bag.get(security);
        const amt = amountNok(tx) * weight;
        if (cat === 'BUY' && tx.type === 'KJØPT') slot.invested += Math.abs(amt);
        else if (cat === 'SELL' && isRealizingSell(tx.type)) slot.returned += amt;
        else if (cat === 'DIVIDEND' || cat === 'TAX') slot.returned += amt;
      }
    }
    const priceMap = new Map();
    for (const h of holdings) priceMap.set(h.security, h);

    const out = [];
    for (const code of INVESTOR_CODES) {
      let best = null;
      for (const [security, slot] of perInvestor.get(code).entries()) {
        if (!(slot.invested > 0)) continue;
        const px = priceMap.get(security);
        if (px && (px.priced === false || px.market_value_nok == null)) continue;
        const split = splitForSecurity(attrMap, security);
        const myW = (split.find((s) => s.code === code) || { weight: 0 }).weight;
        const remainingValue = px ? px.market_value_nok * myW : 0;
        const totalReturn = slot.returned + remainingValue - slot.invested;
        const pct = (totalReturn / slot.invested) * 100;
        if (!best || pct > best.pct) best = { security, invested: slot.invested, return: totalReturn, pct };
      }
      out.push({ code, pick: best });
    }
    return out.sort((a, b) => (b.pick ? b.pick.pct : -Infinity) - (a.pick ? a.pick.pct : -Infinity));
  }

  // Last 6 months, newest first: realized profit + net dividends booked that
  // month (NOK), with the same figure as % of deposits.
  function buildMonthlyLeaderboard(store, perInvestor, now = new Date()) {
    const months = [];
    for (let i = 0; i < 6; i++) {
      months.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
    }
    const profit = profitByBucket(store, (d) => (months.includes(d.slice(0, 7)) ? d.slice(0, 7) : null));
    return months.map((month) => ({
      month,
      ranks: INVESTOR_CODES.map((code) => {
        const value = profit.get(code).get(month) || 0;
        return { code, value, pct: pctOfDeposits(value, perInvestor, code) };
      }).sort((a, b) => b.value - a.value),
    }));
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
    const base = buildDashboardSnapshot(store, opts.now);
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

  // ─── Broker content: allocation, FX split, dividends, trade CSV ──────────
  // Shares are of priced holdings value; cash share is of holdings + cash.
  function splitShares(items, keyOf) {
    const by = new Map();
    for (const h of items) by.set(keyOf(h), (by.get(keyOf(h)) || 0) + h.marketValueNok);
    const total = items.reduce((a, h) => a + h.marketValueNok, 0);
    return [...by].sort((a, b) => b[1] - a[1]).map(([key, value]) => ({ key, value, pct: (value / total) * 100 }));
  }

  function allocation(store, now) {
    const held = currentHoldings(store, now).filter((h) => h.marketValueNok != null && h.marketValueNok > 0);
    if (!held.length) return null;
    const holdingsValue = held.reduce((a, h) => a + h.marketValueNok, 0);
    const cash = Math.max(0, latestSaldo(store));
    const top5 = held.slice(0, 5).reduce((a, h) => a + h.marketValueNok, 0);
    return {
      holdingsValue, cash,
      biggest: { security: held[0].security, pct: (held[0].marketValueNok / holdingsValue) * 100 },
      top5Pct: (top5 / holdingsValue) * 100,
      cashPct: (cash / (holdingsValue + cash)) * 100,
      byCurrency: splitShares(held, (h) => h.currency || 'NOK'),
      byCountry: splitShares(held, (h) => (h.isin ? String(h.isin).slice(0, 2).toUpperCase() : 'Unknown')),
    };
  }

  // Unrealized P/L of foreign holdings split into price effect (at the
  // purchase rate) and currency effect (rate move on today's value). Average
  // cost, Vekslingskurs per buy. Null when there is no foreign holding or any
  // of them lacks a price, a current rate or a rate on its buys.
  function fxSplit(store, now) {
    const foreign = currentHoldings(store, now).filter((h) => h.currency && h.currency !== 'NOK');
    if (!foreign.length) return null;
    let price = 0, currency = 0;
    for (const h of foreign) {
      if (h.marketValueNok == null || h.currentPrice == null || h.approx) return null;
      let qty = 0, native = 0, nok = 0;
      for (const tx of store.transactions) {
        if (!tx.security || canonicalName(tx.security) !== h.security || !isPricedBuy(tx)) continue;
        const fx = Number(tx.fxRate);
        if (!(fx > 0) || !(tx.qty > 0)) return null;
        qty += tx.qty; native += Math.abs(tx.amount); nok += Math.abs(tx.amount) * fx;
      }
      if (!(qty > 0) || !(native > 0)) return null;
      const costNative = (native / qty) * h.qty;
      const fxBuy = nok / native;
      const nowNative = h.qty * h.currentPrice;
      const fxNow = h.marketValueNok / nowNative;
      price += (nowNative - costNative) * fxBuy;
      currency += nowNative * (fxNow - fxBuy);
    }
    return { price, currency, total: price + currency };
  }

  // Dividends per canonical security: gross (UTBYTTE), withholding tax
  // (KUPONGSKATT, as a positive number), net, and gross over the NOK paid
  // for the security's priced buys (yield on cost, null with no buys). The
  // total net equals deriveCashFlow().netDividends.
  function dividendsBySecurity(store) {
    const by = new Map();
    const slot = (name) => { if (!by.has(name)) by.set(name, { security: name, gross: 0, tax: 0, cost: 0 }); return by.get(name); };
    for (const tx of store.transactions) {
      const cat = classify(tx.type);
      const name = tx.security ? canonicalName(tx.security) : 'Unknown';
      if (cat === 'DIVIDEND') slot(name).gross += amountNok(tx);
      else if (cat === 'TAX') slot(name).tax -= amountNok(tx);
      else if (cat === 'BUY' && tx.security && tx.type === 'KJØPT' && isPricedBuy(tx)) slot(name).cost += Math.abs(amountNok(tx));
    }
    const rows = [...by.values()].filter((r) => r.gross !== 0 || r.tax !== 0)
      .map((r) => ({ security: r.security, gross: r.gross, tax: r.tax, net: r.gross - r.tax, yieldOnCost: r.cost > 0 ? (r.gross / r.cost) * 100 : null }))
      .sort((a, b) => b.net - a.net);
    const total = rows.reduce((a, r) => ({ gross: a.gross + r.gross, tax: a.tax + r.tax, net: a.net + r.net }), { gross: 0, tax: 0, net: 0 });
    return { rows, total };
  }

  // CSV rows (header first) for the trades among the Activity rows in view.
  function tradesCsvRows(store, filtered) {
    const out = [['Date', 'Type', 'Security', 'ISIN', 'Quantity', 'Price', 'Currency', 'Amount NOK', 'Fee NOK', 'Realized P/L NOK']];
    for (const r of filtered || []) {
      if (r.cat !== 'BUY' && r.cat !== 'SELL') continue;
      const sec = !r.isin && store.registry && r.security ? store.registry.forName(r.security) : null;
      out.push([r.date, r.type, r.security || '', r.isin || (sec && sec.isin) || '', r.qty, r.price, r.currency || '',
        r.amountNok, r.feeNok, r.realizedNok == null ? '' : r.realizedNok]);
    }
    return out;
  }

  window.Portfolio = {
    allocation, fxSplit, dividendsBySecurity, tradesCsvRows,
    buildDashboard, investorDetail, canonicalName,
    currentHoldings, clubTotal, summary, previousHoldings, snapshotDate,
    pricesAtDate, yearEndPrice,
    // "Which date are these prices actually from?" — the last price row on
    // or before `date`.
    snapshotForDate: (store, date) => {
      if (!usePriceMatrix(store)) return null;
      let best = null;
      for (const d of store.prices.dates) { if (d <= date) best = d; else break; }
      return best;
    },
    nokPriceForSecurity, computeWindow, windowMetrics, usePriceMatrix,
    groupValueAt, investorValueAt,
    cash: { latestSaldo, saldoOnOrBefore },
    _setRegistry,
    _debug: { buildDashboardSnapshot, buildYtdLeaderboard, buildBestPicks, buildMonthlyLeaderboard, deriveCashFlow, deriveCostBasis, deriveDividends, deriveInvested },
  };
})();
