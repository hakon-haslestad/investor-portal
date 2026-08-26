// Look-through (indirect) fundamentals — what the businesses behind the
// portfolio deliver per owned share, scaled by the club's LIVE replay-derived
// share counts and summarized into a fundamental portfolio value
// (look-through earnings × a chosen P/E multiple).
//
// Sourcing rules:
//   · Per company, the latest ANNUAL period ('YYYY') from Offisielle
//     nøkkeltall wins. If only quarterly rows exist, the quarter is
//     annualized ×4 and the row is flagged `annualized` (rendered with ≈).
//   · EPS: the sheet's eps string parsed with its own currency suffix —
//     NOK as-is, reporting currency × fxRate; fallback priceTodayNok ÷ P/E.
//   · Revenue/share: parse '812 mill EUR' → ×1e6/1e9 → NOK via fxRate →
//     ÷ (sharesOut millions × 1e6).
//   · BVPS: optional sheet column, same money parsing + fx treatment.
//   The portal does the unit/FX math here and nowhere else.

(function () {
  const { parseMoneyish } = window.Parsers;

  function isAnnual(p) { return /^\s*\d{4}(\.0)?\s*$/.test(String(p || '')); }
  function periodKey(p) {
    const y = /(\d{4})/.exec(p || ''); const yr = y ? +y[1] : 0;
    const q = /Q\s*([1-4])/i.exec(p || ''); return yr * 10 + (q ? +q[1] : 5);
  }

  // Pick the fundamentals row to use per company: latest annual, else the
  // latest quarter (annualized ×4).
  function pickRow(rows) {
    const annual = rows.filter((k) => isAnnual(k.period));
    if (annual.length) {
      annual.sort((a, b) => periodKey(a.period) - periodKey(b.period));
      return { row: annual[annual.length - 1], annualized: false };
    }
    const sorted = rows.slice().sort((a, b) => periodKey(a.period) - periodKey(b.period));
    return { row: sorted[sorted.length - 1], annualized: true };
  }

  // NOK conversion of a parsed money string against the row's reporting
  // currency and fxRate (NOK per reporting-currency unit).
  function toNok(parsed, row) {
    if (!parsed) return null;
    const cur = parsed.cur || row.currency || 'NOK';
    if (cur === 'NOK') return parsed.value;
    if (row.fxRate != null && Number.isFinite(row.fxRate) && row.fxRate > 0
        && (!parsed.cur || parsed.cur === (row.currency || '').toUpperCase())) {
      return parsed.value * row.fxRate;
    }
    return null; // foreign figure with no usable rate — show as unknown
  }

  // Unitless revenue figures in the sheet are in MILLIONS of the reporting
  // currency (the quarterly-row convention); explicit mill/mrd wins.
  function scale(unit) { return unit === 'mrd' ? 1e9 : 1e6; }

  // EPS → NOK. Hand-kept rows sometimes mislabel the currency (a row says
  // USD while its price/EPS are plainly NOK), so before applying FX we
  // sanity-check the row's own price against OUR live NOK close:
  //   factor = liveNokClose / rowPrice
  //   · explicit 'NOK' suffix on eps → trust it as NOK.
  //   · factor ≈ 1        → the row is NOK-scaled; use eps as NOK.
  //   · factor ≈ fxRate   → genuinely foreign at today's price; eps × fxRate.
  //   · otherwise (stale price etc.) → the declared-currency path, then
  //     price ÷ P/E as a last resort.
  function epsNok(row, nokClose) {
    const parsed = parseMoneyish(row.eps);
    if (parsed && parsed.cur === 'NOK') return parsed.value;
    const px = parseMoneyish(row.priceToday);
    if (parsed && px && px.value > 0 && nokClose != null && nokClose > 0) {
      const factor = nokClose / px.value;
      if (factor >= 0.8 && factor <= 1.25) return parsed.value;
      if (row.fxRate > 0 && factor >= 0.8 * row.fxRate && factor <= 1.25 * row.fxRate) {
        return parsed.value * row.fxRate;
      }
    }
    const direct = toNok(parsed, row);
    if (direct != null) return direct;
    const pxNok = toNok(px, row);
    if (pxNok != null && row.pe != null && Number.isFinite(row.pe) && row.pe !== 0) {
      return pxNok / row.pe;
    }
    return null;
  }

  function revPerShareNok(row) {
    const parsed = parseMoneyish(row.revenue);
    if (!parsed || row.sharesOut == null || !(row.sharesOut > 0)) return null;
    const totalNok = toNok({ value: parsed.value * scale(parsed.unit), cur: parsed.cur }, row);
    if (totalNok == null) return null;
    return totalNok / (row.sharesOut * 1e6);
  }

  function bvpsNok(row) {
    return toNok(parseMoneyish(row.bvps), row);
  }

  // The look-through build: per current holding, the business numbers the
  // club's shares represent, plus portfolio totals.
  function buildLookThrough(store, opts = {}) {
    const multiple = Number(opts.multiple) > 0 ? Number(opts.multiple) : 15;
    const canon = window.Portfolio.canonicalName;

    const byCompany = new Map();
    for (const k of store.kpis || []) {
      if (!k.company) continue;
      const key = canon(k.company);
      if (!byCompany.has(key)) byCompany.set(key, []);
      byCompany.get(key).push(k);
    }

    const holdings = window.Portfolio.currentHoldings(store);
    const rows = [];
    const missing = [];
    const totals = {
      earnings: 0, revenue: 0, book: 0, marketValue: 0,
      mvWithEarnings: 0, mvWithBook: 0,
      fundamentalValue: 0, multiple,
    };

    for (const h of holdings) {
      const kRows = byCompany.get(h.security);
      if (!kRows || !kRows.length) {
        missing.push({ security: h.security, qty: h.qty, marketValueNok: h.marketValueNok });
        continue;
      }
      const { row: picked, annualized } = pickRow(kRows);
      // Annual rows often lack sharesOut/fxRate that quarterly rows carry —
      // borrow the latest known values from the company's other rows.
      const row = { ...picked };
      if (row.sharesOut == null || !(row.sharesOut > 0)) {
        const alt = kRows.filter((k) => k.sharesOut > 0).sort((a, b) => periodKey(a.period) - periodKey(b.period)).pop();
        if (alt) row.sharesOut = alt.sharesOut;
      }
      if (row.fxRate == null || !(row.fxRate > 0)) {
        const alt = kRows.filter((k) => k.fxRate > 0).sort((a, b) => periodKey(a.period) - periodKey(b.period)).pop();
        if (alt) row.fxRate = alt.fxRate;
      }
      const f = annualized ? 4 : 1;
      const nokClose = window.Portfolio.nokPriceForSecurity(store, h.security, new Date().toISOString().slice(0, 10));
      const eps = epsNok(row, nokClose);
      const rps = revPerShareNok(row);
      const bps = bvpsNok(row);
      const earningsNok = eps != null ? eps * f * h.qty : null;
      const revenueNok = rps != null ? rps * f * h.qty : null;
      const bookNok = bps != null ? bps * h.qty : null; // stock, never annualized
      const mv = h.marketValueNok;
      const pb = bookNok != null && bookNok > 0 && mv != null ? mv / bookNok : null;
      const fundamentalValue = earningsNok != null ? earningsNok * multiple : null;
      const gapPct = fundamentalValue != null && mv != null && fundamentalValue !== 0
        ? ((mv - fundamentalValue) / Math.abs(fundamentalValue)) * 100 : null;
      rows.push({
        security: h.security, qty: h.qty, period: row.period, annualized,
        earningsNok, revenueNok, bookNok, pe: row.pe != null ? row.pe : null, pb,
        fundamentalValue, marketValueNok: mv, approx: h.approx === true, gapPct,
      });
      if (earningsNok != null) { totals.earnings += earningsNok; totals.fundamentalValue += earningsNok * multiple; if (mv != null) totals.mvWithEarnings += mv; }
      if (revenueNok != null) totals.revenue += revenueNok;
      if (bookNok != null) { totals.book += bookNok; if (mv != null) totals.mvWithBook += mv; }
      if (mv != null) totals.marketValue += mv;
    }

    totals.portfolioPe = totals.earnings > 0 ? totals.mvWithEarnings / totals.earnings : null;
    totals.earningsYieldPct = totals.mvWithEarnings > 0 ? (totals.earnings / totals.mvWithEarnings) * 100 : null;
    totals.pb = totals.book > 0 && totals.mvWithBook > 0 ? totals.mvWithBook / totals.book : null;
    totals.gapPct = totals.fundamentalValue > 0
      ? ((totals.mvWithEarnings - totals.fundamentalValue) / totals.fundamentalValue) * 100 : null;

    rows.sort((a, b) => (b.marketValueNok || 0) - (a.marketValueNok || 0));
    return { rows, missing, totals };
  }

  window.Fundamentals = { buildLookThrough, epsNok, revPerShareNok, bvpsNok, pickRow };
})();
