// Position replay — derives quantity, cost basis, and realized P/L per
// security by replaying the Nordnet transaction log — the sole source of
// holdings (the manual Beholdningsverdi snapshot is retired).
//
// Rules (same intent as the old calculator, now also authoritative for qty):
//   - Quantity moves on every BUY/SELL-classified type, INCLUDING corporate
//     actions (BYTTE, SPLITT, spinoffs) — shares must track reality.
//   - Cost basis moves only on KJØPT (adds) and realizing sells (removes
//     proportionally + realizes P/L vs average cost). Corporate actions
//     never touch cost — a split halves the average cost implicitly by
//     doubling qty; a spinoff parent keeps its full basis.
//
// Group-level states are computed once per hydration and cached on the
// store. Per-investor figures are the group figures scaled by the
// investor's Dim-values weight (weights are constant per security, so
// scaling is exact).

(function () {
  const { classify, isRealizingSell, isCashLeg, isPricedBuy, amountNok } = window.Ledger;

  // Map(canonicalSecurity → {currency, dates[], qty[], costSum[], realized[]})
  // Arrays are cumulative states AFTER each event date (one entry per event).
  function bySecurity(store) {
    // Memo keyed on the transactions array reference so a Store.refresh()
    // (which replaces store.transactions) invalidates the cache.
    if (store._positionsCache && store._positionsCacheKey === store.transactions) {
      return store._positionsCache;
    }
    const canonical = (s) => window.Portfolio.canonicalName(s);
    const states = new Map();
    // Conversion cost transfer (BTA→shares etc.): cost drained from the
    // source form is parked per pair id and added to the receiving form.
    const convBucket = new Map(); // convId → NOK cost in transit
    const convDrained = new Set();
    const drainFrom = (st, q, id) => {
      if (!st || convDrained.has(id)) return 0;
      convDrained.add(id);
      const frac = st._q > 0 ? Math.min(q / st._q, 1) : 0;
      const t = st._c * frac;
      st._c -= t;
      return t;
    };
    for (const tx of store.transactions) {
      if (!tx.security) continue;
      const cat = classify(tx.type);
      if (cat !== 'BUY' && cat !== 'SELL') continue;
      if (isCashLeg(tx.type)) continue; // cash settlement — no share movement
      const security = canonical(tx.security);
      if (!states.has(security)) {
        states.set(security, {
          currency: tx.currency || 'NOK',
          dates: [], qty: [], costSum: [], realized: [],
          _q: 0, _c: 0, _r: 0,
        });
      }
      const st = states.get(security);
      const q = Math.abs(tx.qty || 0);
      if (cat === 'BUY') {
        st._q += q;
        if (isPricedBuy(tx)) st._c += Math.abs(amountNok(tx));
        if (tx._convRole === 'in') {
          // Receive the converted-away form's cost. If the out row hasn't
          // been replayed yet (row order within the day varies), drain the
          // source slot directly now.
          if (convBucket.has(tx._convId)) st._c += convBucket.get(tx._convId);
          else st._c += drainFrom(states.get(canonical(tx._convOther)), q, tx._convId);
        }
      } else {
        if (tx._convRole === 'out') {
          const t = drainFrom(st, q, tx._convId);
          if (t > 0) convBucket.set(tx._convId, t);
        }
        if (isRealizingSell(tx.type)) {
          const avg = st._q > 0 ? st._c / st._q : 0;
          st._r += amountNok(tx) - avg * q;
          const frac = st._q > 0 ? Math.min(q / st._q, 1) : 0;
          st._c = Math.max(0, st._c - st._c * frac);
        }
        st._q = Math.max(0, st._q - q);
      }
      // Snap to Nordnet's own running total when the row carries one — the
      // broker's number beats our replay (double-booked conversions, odd
      // same-day ordering). Cost basis is never snapped, only share count.
      if (tx.totalAfter != null && Number.isFinite(tx.totalAfter) && tx.totalAfter >= 0) {
        st._q = tx.totalAfter;
      }
      const d = tx.tradeDate || tx.bookDate || '';
      if (st.dates.length && st.dates[st.dates.length - 1] === d) {
        // Same-day events collapse into one state entry.
        st.qty[st.qty.length - 1] = st._q;
        st.costSum[st.costSum.length - 1] = st._c;
        st.realized[st.realized.length - 1] = st._r;
      } else {
        st.dates.push(d);
        st.qty.push(st._q);
        st.costSum.push(st._c);
        st.realized.push(st._r);
      }
    }
    store._positionsCache = states;
    store._positionsCacheKey = store.transactions;
    return states;
  }

  // State (qty, costSum, realized) of one security at end of `date`.
  function stateAt(st, date) {
    if (!st || !st.dates.length) return { qty: 0, costSum: 0, realized: 0 };
    let lo = 0, hi = st.dates.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (st.dates[mid] <= date) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (best < 0) return { qty: 0, costSum: 0, realized: 0 };
    return { qty: st.qty[best], costSum: st.costSum[best], realized: st.realized[best] };
  }

  // Group-level open positions at end of `date` (today when omitted):
  // [{security, currency, qty, costSum, avgCost}], qty > 0 only.
  function holdingsAt(store, date) {
    const d = date || '9999-12-31';
    const out = [];
    for (const [security, st] of bySecurity(store).entries()) {
      const s = stateAt(st, d);
      if (s.qty > 0.0001) {
        out.push({
          security,
          currency: st.currency,
          qty: s.qty,
          costSum: s.costSum,
          avgCost: s.qty > 0 ? s.costSum / s.qty : 0,
        });
      }
    }
    return out;
  }

  window.Positions = { bySecurity, stateAt, holdingsAt };
})();
