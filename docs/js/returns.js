// Club-level return measures: time-weighted return (TWR), money-weighted
// return (XIRR) and the OSEBX benchmark. Pure functions over the price
// matrix and the transaction log; no DOM.
//
// Club level only: deposits and withdrawals are split evenly across the five
// investors, so a per-investor TWR would be invented, not measured.

(function () {
  const BENCH_COLUMN = 'IDX:OSEBX';
  const DAY = 86400000;
  const ts = (d) => Date.parse(d);

  // Chain-linked TWR over [{date, value, flow}] in date order. Each day:
  // r = V_t / (V_{t-1} + F_t) - 1, the flow counted at the start of the day.
  // The first row is the base (its own flow is already inside its value).
  // A day whose base is not positive is skipped. Null with fewer than 2 rows.
  function twrChain(days) {
    if (!days || days.length < 2) return null;
    let idx = 100;
    const index = [{ date: days[0].date, y: 100 }];
    for (let i = 1; i < days.length; i++) {
      const base = days[i - 1].value + (days[i].flow || 0);
      if (base > 0) idx *= days[i].value / base;
      index.push({ date: days[i].date, y: idx });
    }
    return { twr: idx / 100 - 1, index };
  }

  // Annualised money-weighted return. `flows` = [{date, amount}] with money
  // put in positive and taken out negative; `endValue` is the value on
  // `endDate`. Newton from 10 % with a bisection fallback. Null when the
  // flows and the end value have no sign change, or there is no time span.
  function xirr(flows, endDate, endValue) {
    if (!flows || !flows.length || !(endValue > 0)) return null;
    const t0 = Math.min(...flows.map((f) => ts(f.date)));
    const tEnd = ts(endDate);
    if (!(tEnd > t0) || !flows.some((f) => f.amount > 0)) return null;
    const yrs = (d) => (d - t0) / (365 * DAY);
    // Value at the end date of everything put in at rate r, minus the end value.
    const npv = (r) => flows.reduce((s, f) => s - f.amount * Math.pow(1 + r, yrs(tEnd) - yrs(ts(f.date))), endValue);
    let r = 0.1;
    for (let i = 0; i < 50; i++) {
      const v = npv(r), h = 1e-6;
      const slope = (npv(r + h) - v) / h;
      if (!isFinite(slope) || slope === 0) break;
      const next = r - v / slope;
      if (!(next > -0.999999)) break;
      if (Math.abs(next - r) < 1e-10) return next;
      r = next;
    }
    let lo = -0.999, hi = 10;
    if (npv(lo) * npv(hi) > 0) return null;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (npv(lo) * npv(mid) <= 0) hi = mid; else lo = mid;
    }
    return (lo + hi) / 2;
  }

  // Club book per priced day in [from, to]: value = market value + cash, flow =
  // deposits minus withdrawals booked since the previous priced day (a weekend
  // flow lands on the next priced day). Returns days, twr, the xirr and its
  // inputs. Null with fewer than 2 priced days.
  function clubSeries(store, from, to) {
    if (!store || !store.prices || !store.prices.hasData) return null;
    const dates = window.Prices.datesBetween(store.prices, from, to);
    if (dates.length < 2) return null;
    const flowOf = (tx) => {
      const k = window.Ledger.classify(tx.type);
      const a = Math.abs(window.Ledger.amountNok(tx));
      return k === 'DEPOSIT' ? a : k === 'WITHDRAWAL' ? -a : 0;
    };
    const days = [];
    const xirrFlows = [];
    let prev = dates[0];
    dates.forEach((d, i) => {
      const value = window.Portfolio.groupValueAt(store, d).total;
      let flow = 0;
      if (i > 0) {
        for (const tx of store.transactions) {
          // Same key as the cash saldo (saldoOnOrBefore): bookDate first.
          const td = tx.bookDate || tx.tradeDate;
          if (td && td > prev && td <= d) {
            const f = flowOf(tx);
            flow += f;
            if (f) xirrFlows.push({ date: td, amount: f });
          }
        }
      }
      days.push({ date: d, value, flow });
      prev = d;
    });
    const t = twrChain(days);
    if (!t) return null;
    const endDate = dates[dates.length - 1];
    const endValue = days[days.length - 1].value;
    xirrFlows.unshift({ date: dates[0], amount: days[0].value });
    return { days, twr: t.twr, index: t.index, xirrFlows, endDate, endValue, xirr: xirr(xirrFlows, endDate, endValue) };
  }

  // OSEBX indexed to 100 at `from` (last close at or before it, forward-fill),
  // carried forward to `to`.
  // Null when the column is missing, there is no close at or before `from`,
  // or fewer than 2 points result: never a flat or invented line.
  function benchmark(store, from, to) {
    const pts = store && store.prices && store.prices.series && store.prices.series.get(BENCH_COLUMN);
    if (!pts || !pts.length) return null;
    const base = window.Prices.valueOn(pts, from);
    if (!(base > 0)) return null;
    const points = [{ date: from, y: 100 }];
    for (const p of pts) if (p.d > from && p.d <= to) points.push({ date: p.d, y: (p.v / base) * 100 });
    if (points.length < 2) return null;
    // Carry the last close to `to`, so a missed index fetch does not shorten the window.
    const last = points[points.length - 1];
    if (last.date < to) points.push({ date: to, y: last.y });
    return { points, pct: points[points.length - 1].y / 100 - 1 };
  }

  window.Returns = { BENCH_COLUMN, xirr, twrChain, clubSeries, benchmark };
})();
