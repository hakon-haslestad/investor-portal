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
    // 'Kurs NOK/kursval' converts the price-quote currency (EPS TTM shares
    // it) straight to NOK — authoritative when filled AND credible: the
    // row's own price × kursval must land near our live NOK close,
    // otherwise the cell is a data slip (e.g. rapp.val copied into it).
    if (parsed && row.fxPrice != null && row.fxPrice > 0) {
      const px = parseMoneyish(row.priceToday);
      const credible = !(px && px.value > 0 && nokClose != null && nokClose > 0)
        || (() => { const r = nokClose / (px.value * row.fxPrice); return r >= 0.4 && r <= 2.5; })();
      if (credible) return parsed.value * row.fxPrice;
      // fxPrice not credible → if the live close is clearly NOT foreign-
      // scaled vs the row price, the eps is NOK already.
      if (px && px.value > 0 && nokClose != null && nokClose / px.value < row.fxPrice / 2) return parsed.value;
    }
    if (parsed && parsed.cur === 'NOK') return parsed.value;
    const px = parseMoneyish(row.priceToday);
    if (parsed && px && px.value > 0 && nokClose != null && nokClose > 0) {
      // EPS TTM shares the price column's currency. Decide that currency
      // from evidence: if liveClose/rowPrice sits in the fx-rate's band the
      // quote is genuinely foreign (× fxRate); anything else — including a
      // big factor from plain price appreciation — means the quote is NOK.
      const factor = nokClose / px.value;
      if (row.fxRate > 0 && factor >= 0.7 * row.fxRate && factor <= 1.4 * row.fxRate) {
        return parsed.value * row.fxRate;
      }
      return parsed.value; // NOK-quoted (reporting currency ≠ quote currency)
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
      // EPS TTM is already trailing-twelve-months — NEVER annualized ×4.
      // Only period figures (revenue) annualize on quarterly rows.
      const earningsNok = eps != null ? eps * h.qty : null;
      const revenueNok = rps != null ? rps * f * h.qty : null;
      const mv = h.marketValueNok;
      // Book value: legacy BVPS column if present, else derived from the
      // sheet's P/B against today's market value.
      let bookNok = bps != null ? bps * h.qty : null; // stock, never annualized
      if (bookNok == null && row.pb != null && row.pb > 0 && mv != null) bookNok = mv / row.pb;
      const pb = row.pb != null && row.pb > 0 ? row.pb
        : (bookNok != null && bookNok > 0 && mv != null ? mv / bookNok : null);
      const fundamentalValue = earningsNok != null ? earningsNok * multiple : null;
      const gapPct = fundamentalValue != null && mv != null && fundamentalValue !== 0
        ? ((mv - fundamentalValue) / Math.abs(fundamentalValue)) * 100 : null;
      rows.push({
        security: h.security, qty: h.qty, period: row.period, annualized,
        earningsNok, revenueNok, bookNok, pe: row.pe != null ? row.pe : null, pb, ps: row.ps != null ? row.ps : null,
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

  // Quarter label of a period string ('Q2 2026'), else null.
  function quarterOf(p) {
    const m = /^\s*Q\s*([1-4])\s*(\d{4})\s*$/i.exec(p || '');
    return m ? { q: +m[1], y: +m[2], label: `Q${m[1]} ${m[2]}` } : null;
  }

  // The Board's "what the businesses earn us" numbers: look-through totals from
  // buildLookThrough (no second calculation), the latest quarter against the
  // same quarter a year earlier (summed over companies that have both rows),
  // how many holdings reported that quarter, and the sheet's notes for the
  // largest holdings. Figures are as entered in the sheet. Null when the sheet
  // has no KPI rows for the current holdings.
  function boardSummary(store) {
    if (!(store.kpis || []).length) return null;
    const { rows, missing, totals } = buildLookThrough(store);
    if (!rows.some((r) => r.earningsNok != null)) return null;
    const canon = window.Portfolio.canonicalName;
    const names = rows.map((r) => r.security).concat(missing.map((m) => m.security));
    const byCo = new Map(names.map((n) => [n, []]));
    for (const k of store.kpis) { const l = byCo.get(canon(k.company)); if (l) l.push(k); }
    const quarters = new Map(); // security -> Map(label -> row)
    for (const [n, list] of byCo) {
      const m = new Map();
      for (const k of list) { const q = quarterOf(k.period); if (q) m.set(q.label, { ...q, row: k }); }
      quarters.set(n, m);
    }
    let latest = null;
    for (const m of quarters.values()) for (const v of m.values()) if (!latest || v.y * 10 + v.q > latest.y * 10 + latest.q) latest = v;
    let freshness = null, quarter = null;
    if (latest) {
      const priorLabel = `Q${latest.q} ${latest.y - 1}`;
      freshness = { label: latest.label, reported: names.filter((n) => quarters.get(n).has(latest.label)).length, of: names.length };
      let now = 0, before = 0, companies = 0;
      for (const m of quarters.values()) {
        const a = m.get(latest.label), b = m.get(priorLabel);
        if (a && b && a.row.yourProfitNok != null && b.row.yourProfitNok != null) { now += a.row.yourProfitNok; before += b.row.yourProfitNok; companies++; }
      }
      if (companies) {
        quarter = {
          label: latest.label, priorLabel, now, before, companies, reported: freshness.reported, of: names.length,
          changePct: before !== 0 ? ((now - before) / Math.abs(before)) * 100 : null,
        };
      }
    }
    const notes = [];
    for (const r of rows.slice(0, 5)) {
      const withNote = byCo.get(r.security).filter((k) => k.note).sort((a, b) => periodKey(a.period) - periodKey(b.period)).pop();
      if (withNote) notes.push({ security: r.security, note: withNote.note.length > 120 ? withNote.note.slice(0, 120) + '…' : withNote.note });
    }
    return { earnings: totals.earnings, yieldPct: totals.earningsYieldPct, pe: totals.portfolioPe, quarter, freshness, notes };
  }

  // The deck's KPI slides for one competition. `scored` is the engine result
  // (teams with members and buyIn, ranks with breakdown lots: security, qty,
  // endPrice in NOK, marketValue); `win` has start_date and end_date.
  //   owns:   per team, the yearly profit (shares x EPS TTM) behind the lots it
  //           still holds at the end, per 1 000 kr of budget, and the P/E of
  //           those lots. `best` names the team(s) with the most profit per
  //           1 000 kr; a tie names all of them. Null when nothing is covered.
  //   season: per pick, the latest quarter that ended inside the window, with
  //           profit (EAT as entered) vs the previous quarter and a year earlier.
  //   notes:  security -> the newest Merknad.
  // Figures are as entered in the sheet; the winner is still % of budget.
  function deckKpis(kpis, scored, win) {
    const canon = window.Portfolio.canonicalName;
    const byCo = new Map();
    for (const k of kpis || []) {
      if (!k || !k.company) continue;
      const key = canon(k.company);
      if (!byCo.has(key)) byCo.set(key, []);
      byCo.get(key).push(k);
    }
    const lotsOf = new Map((scored.ranks || []).map((r) => [r.code, r.breakdown || []]));

    const teams = (scored.teams || []).map((t) => {
      let earnings = 0, mv = 0, covered = 0, picks = 0;
      for (const code of t.members || []) {
        for (const b of lotsOf.get(code) || []) {
          if (!(b.qty > 0)) continue;
          picks++;
          const rows = byCo.get(canon(b.security));
          if (!rows) continue;
          const eps = epsNok(pickRow(rows).row, b.endPrice);
          if (eps == null) continue;
          earnings += b.qty * eps;
          mv += b.marketValue || 0;
          covered++;
        }
      }
      return {
        label: t.label, members: t.members, covered, picks, earnings: covered ? earnings : null,
        per1000: covered && t.buyIn > 0 ? (earnings / t.buyIn) * 1000 : null,
        pe: covered && earnings > 0 ? mv / earnings : null,
      };
    });
    const scoredTeams = teams.filter((t) => t.per1000 != null);
    let owns = null;
    if (scoredTeams.length) {
      const top = Math.max(...scoredTeams.map((t) => t.per1000));
      const best = scoredTeams.filter((t) => Math.abs(t.per1000 - top) < 1e-9).map((t) => t.label);
      owns = { teams: teams.sort((a, b) => (b.per1000 ?? -Infinity) - (a.per1000 ?? -Infinity)), best: top > 0 ? best : [] };
    }

    const ends = { 1: '03-31', 2: '06-30', 3: '09-30', 4: '12-31' };
    const eat = (row) => { const p = row && window.Parsers.parseMoneyish(row.eat); return p ? p.value : null; };
    const pct = (now, before) => (now != null && before != null && before !== 0 ? ((now - before) / Math.abs(before)) * 100 : null);
    const picked = new Set();
    for (const list of lotsOf.values()) for (const b of list) picked.add(canon(b.security));
    const season = [];
    for (const sec of picked) {
      const qs = new Map();
      for (const k of byCo.get(sec) || []) { const q = quarterOf(k.period); if (q) qs.set(q.label, { ...q, row: k }); }
      const inWin = [...qs.values()].filter((q) => {
        const end = `${q.y}-${ends[q.q]}`;
        return end >= win.start_date && end <= win.end_date;
      }).sort((a, b) => (b.y * 10 + b.q) - (a.y * 10 + a.q));
      const q = inWin[0];
      if (!q) continue;
      const prev = qs.get(q.q === 1 ? `Q4 ${q.y - 1}` : `Q${q.q - 1} ${q.y}`);
      const year = qs.get(`Q${q.q} ${q.y - 1}`);
      const now = eat(q.row);
      if (now == null) continue;
      season.push({ security: sec, label: q.label, profit: now, vsPrevPct: pct(now, eat(prev && prev.row)), vsYearPct: pct(now, eat(year && year.row)) });
    }
    season.sort((a, b) => a.security.localeCompare(b.security));

    const notes = new Map();
    for (const [sec, rows] of byCo) {
      const n = rows.filter((k) => k.note).sort((a, b) => periodKey(a.period) - periodKey(b.period)).pop();
      if (n) notes.set(sec, n.note.length > 120 ? n.note.slice(0, 120) + '…' : n.note);
    }
    return { owns, season, notes };
  }

  window.Fundamentals = { buildLookThrough, boardSummary, deckKpis, epsNok, revPerShareNok, bvpsNok, pickRow };
})();
