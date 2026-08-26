// Build the presentation deck payload for a scored competition.
// Ported from src/competitions/presentation.js. Drops the dayjs dep —
// uses plain Date arithmetic.

(function () {
  const { canonicalName } = window.Portfolio;
  const { splitForSecurity, INVESTOR_COLORS } = window.Ledger;
  const { fmtNok, fmtPct, PODIUM } = window.Fmt;
  const { NAMES, verdictFromReturn, namesFromMembers } = window.Copy;

  function addDays(isoDate, days) {
    const d = new Date(isoDate + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  function midDate(start, end) {
    const s = new Date(start + 'T00:00:00Z').getTime();
    const e = new Date(end + 'T00:00:00Z').getTime();
    return new Date(s + (e - s) / 2).toISOString().slice(0, 10);
  }

  // End date for the "first ~N days" view. Picks the StockPrices date
  // closest to start+targetDays, within [start+loDays, start+hiDays]
  // (clamped to the competition end). Falls back to start+targetDays (capped
  // at the end date) when no price row lands in that band.
  function nearestSnapshotEnd(store, c, targetDays, loDays, hiDays) {
    const end = c.end_date;
    const clampEnd = (d) => (d < end ? d : end);
    const target = clampEnd(addDays(c.start_date, targetDays));
    const lo = addDays(c.start_date, loDays);
    const hi = clampEnd(addDays(c.start_date, hiDays));
    const tTs = Date.parse(target);
    let best = target, bestDiff = Infinity;
    for (const d of (store.prices && store.prices.dates) || []) {
      if (d < lo || d > hi) continue;
      const diff = Math.abs(Date.parse(d) - tTs);
      if (diff < bestDiff) { bestDiff = diff; best = d; }
    }
    return best;
  }

  function buildPresentation(store, scored) {
    const c = scored.competition;
    const ranks = scored.ranks;
    const names = namesFromMembers(store.members);
    const participants = scored.participants || [];

    // This engine scores only stocks BOUGHT inside the window. If nobody
    // bought anything in range, every metric is zero — flag it so slides can
    // show a clear explanation instead of a wall of 0 kr / 0.0%.
    const noActivity = ranks.every((r) => (r.grossBought || 0) === 0);
    const emptyNote = `No purchases recorded between ${c.start_date} and ${c.end_date}. `
      + 'This competition scores only stocks bought inside the window — pick a window with '
      + 'buys, or check the security attribution in Dim-values.';

    // Fundamentals (P/E, EPS) keyed by canonical security name, latest year.
    const kpiBySecurity = buildKpiLookup(store.kpis || []);

    const participantsLine = ranks
      .map((r) => `${r.code}${r.teamLabel ? ` (${r.teamLabel})` : ''}`)
      .join(' · ');

    const hasMultiMember = (scored.teams || []).some((t) => (t.members || []).length > 1);
    const snapNote = scored.snapshotUsed ? ` · MV snapshot ${scored.snapshotUsed}` : '';
    const titleSlide = {
      type: 'title',
      title: c.name,
      subtitle: `${c.start_date} → ${c.end_date}` + snapNote,
      chips: hasMultiMember ? ['Mixed team / solo'] : ['Solo'],
      participantsLine,
    };

    const summarySlide = buildSummarySlide(scored, noActivity, emptyNote);
    const curveSlide = buildCurveSlide(store, c, participants, names, noActivity, emptyNote);
    const picksSlide = buildPicksSlide(store, c, scored, names, noActivity, emptyNote);

    // Setup slide groups by team_label so the budget appears once per team.
    const setupSlide = {
      type: 'setup',
      title: 'The setup',
      teaser: 'Each crew brings their bag. The market does its thing. Numbers don\'t lie.',
      rows: (scored.teams || []).map((t) => ({
        label: t.label,
        members: t.members,
        buyIn: t.buyIn,
        amountSpent: t.amountSpent,
        overSpent: !!t.overSpent,
        overSpentBy: t.overSpentBy || 0,
      })),
    };

    // First 30 days: re-score the competition over [start, ~30 days] so it
    // follows the same rules (only stocks bought in-window count). netPnl
    // already combines realised (from rådata sells/dividends) and unrealised
    // (last close) — surfaced per-row below. Rather than a hard
    // day-30 cutoff (which can land between snapshots and mis-mark the
    // unrealised value), snap to the actual StockPrices row date
    // closest to day 30, within a 20–60 day band (clamped to the window).
    const earlyEnd = nearestSnapshotEnd(store, c, 30, 20, 60);
    const earlyRanks = scoreWithDates(store, c, scored.participants || [], c.start_date, earlyEnd);
    const earlySlide = {
      type: 'early',
      title: 'First 30 days',
      teaser: 'Who came out swinging? Who needed time?',
      asOf: earlyEnd,
      ranks: earlyRanks.map((r) => ({
        code: r.code, teamLabel: r.teamLabel, pct: r.pct, netPnl: r.netPnl,
        realized: r.realizedInWindow, unrealized: r.unrealizedAtEnd, divs: r.divsInWindow,
      })),
    };

    const pivotSlide = {
      type: 'pivot',
      title: 'The plot twist',
      teaser: 'Some pivot. Some don\'t. Some pivots actually work.',
      trades: extractPivotTrades(store, c, scored),
    };

    const positionSlide = {
      type: 'positions',
      title: 'Position by position',
      teaser: 'Every stock told its own story. Here\'s the receipt.',
      noActivity,
      emptyNote,
      rows: ranks.map((r) => {
        const sumTotal = (r.breakdown || []).reduce(
          (acc, b) => ({
            mv: acc.mv + (b.marketValue || 0),
            costSum: acc.costSum + (b.costSum || 0),
            divs: acc.divs + (b.divs || 0),
            unrealized: acc.unrealized + (b.unrealized || 0),
            realized: acc.realized + (b.realized || 0),
          }),
          { mv: 0, costSum: 0, divs: 0, unrealized: 0, realized: 0 }
        );
        // Attach fundamentals (P/E, EPS) where the security exists in the
        // Offisielle nøkkeltall tab.
        const breakdown = (r.breakdown || []).map((b) => {
          const k = kpiBySecurity.get(canonicalName(b.security));
          return { ...b, pe: k ? k.pe : null, eps: k ? k.eps : null };
        });
        return {
          code: r.code, name: names[r.code] || r.code,
          teamLabel: r.teamLabel, breakdown, total: sumTotal,
        };
      }),
    };

    const standingsSlide = {
      type: 'standings',
      title: 'Final standings',
      individual: ranks.map((r, i) => ({
        rank: i + 1, podium: PODIUM[i] || '', code: r.code,
        name: names[r.code] || r.code, teamLabel: r.teamLabel,
        pct: r.pct, netPnl: r.netPnl, mv: r.mvAtEnd,
      })),
      teams: scored.teams ? scored.teams.map((t, i) => ({
        rank: i + 1, podium: PODIUM[i] || '',
        label: t.label, members: t.members,
        pct: t.pct, netPnl: t.netPnl, buyIn: t.buyIn,
        amountSpent: t.amountSpent, overSpent: !!t.overSpent, overSpentBy: t.overSpentBy || 0,
      })) : null,
    };

    // Verdict speaks to the actual standings — teams when it's a team
    // competition, otherwise the individual codes — so it matches Final standings.
    const standings = (scored.teams && scored.teams.length)
      ? scored.teams.map((t) => ({ label: t.label, pct: t.pct }))
      : ranks.map((r) => ({ label: r.code, pct: r.pct }));
    let verdictLine = '';
    if (standings.length) {
      const top = standings[0]; const last = standings[standings.length - 1];
      verdictLine = `${top.label} takes the win at ${fmtPct(top.pct)}. ${last.label} brings up the rear at ${fmtPct(last.pct)}.`;
      if (top.pct > 30) verdictLine += ' A vintage run.';
      if (last.pct < -10) verdictLine += ' Better luck next round.';
    }
    const verdictSlide = {
      type: 'verdict',
      title: 'Verdict',
      teaser: verdictLine,
      runnerUps: standings.slice(0, 3).map((t) => verdictFromReturn(t.label, t.pct)),
    };

    const companySlide = buildCompanySlide(scored, noActivity, emptyNote);

    return {
      competition: c,
      slides: [
        titleSlide, setupSlide, earlySlide, curveSlide, picksSlide,
        pivotSlide, summarySlide, positionSlide, standingsSlide, companySlide, verdictSlide,
      ],
    };
  }

  // ─── "Did Geysir profit?" slide ─────────────────────────────────────────────
  // Aggregate net P/L across all competition positions (realised + dividends +
  // unrealised). Did the club make money on this competition, and the one-line why.
  function buildCompanySlide(scored, noActivity, emptyNote) {
    const ranks = scored.ranks || [];
    const sum = (fn) => ranks.reduce((a, r) => a + (fn(r) || 0), 0);
    const realized = sum((r) => r.realizedInWindow);
    const divs = sum((r) => r.divsInWindow);
    const unrealized = sum((r) => r.unrealizedAtEnd);
    const net = sum((r) => r.netPnl);
    const spent = sum((r) => r.amountSpent);
    const pct = spent > 0 ? (net / spent) * 100 : 0;
    const profited = net >= 0;

    // Biggest mover among the three P/L components — drives the "why".
    const parts = [
      { gain: 'realised trading gains', loss: 'realised trading losses', v: realized },
      { gain: 'dividends', loss: 'a dividend shortfall', v: divs },
      { gain: 'unrealised gains on open positions', loss: 'unrealised losses on open positions', v: unrealized },
    ];
    const driver = parts.reduce((a, b) => (Math.abs(b.v) > Math.abs(a.v) ? b : a));
    const driverText = `${driver.v >= 0 ? driver.gain : driver.loss} (${fmtNok(driver.v)})`;

    let why;
    if (noActivity) {
      why = 'No stocks were bought inside the window, so the competition moved nothing on the books.';
    } else if (profited) {
      why = `Yes — the club is up ${fmtNok(net)} (${fmtPct(pct)}) across the competition stocks, led by ${driverText}.`;
    } else {
      why = `No — the club is down ${fmtNok(net)} (${fmtPct(pct)}) across the competition stocks, dragged by ${driverText}.`;
    }

    return {
      type: 'company', title: 'Did Geysir profit?',
      profited, net, pct, realized, divs, unrealized, why, noActivity, emptyNote,
    };
  }

  // ─── Summary KPI slide ─────────────────────────────────────────────────────

  function buildSummarySlide(scored, noActivity, emptyNote) {
    const ranks = scored.ranks || [];
    const sum = (fn) => ranks.reduce((a, r) => a + (fn(r) || 0), 0);
    const totalPnl = sum((r) => r.netPnl);
    const totalSpent = sum((r) => r.amountSpent);
    const totalDivs = sum((r) => r.divsInWindow);
    const totalBuyIn = sum((r) => r.buyIn);

    // Best single position across everyone (realized + unrealized + dividends).
    let best = null;
    for (const r of ranks) {
      for (const b of r.breakdown || []) {
        const gain = (b.unrealized || 0) + (b.realized || 0) + (b.divs || 0);
        if (!best || gain > best.gain) best = { gain, security: b.security, code: r.code };
      }
    }

    const winner = ranks[0];
    const cards = [
      { label: 'Leader', value: winner ? winner.code : '—',
        sub: winner ? fmtPct(winner.pct) : '', cls: winner ? pctCls(winner.pct) : '' },
      { label: 'Net P/L (window)', value: fmtNok(totalPnl), cls: pctCls(totalPnl) },
      { label: 'Capital deployed', value: fmtNok(totalSpent),
        sub: totalBuyIn > 0 ? `of ${fmtNok(totalBuyIn)} budget` : '' },
      { label: 'Dividends captured', value: fmtNok(totalDivs) },
      { label: 'Best single pick',
        value: best && best.gain > 0 ? best.security : '—',
        sub: best && best.gain > 0 ? `${best.code} · ${fmtNok(best.gain)}` : '' },
      { label: 'Players', value: String(ranks.length) },
    ];

    return { type: 'summary', title: 'By the numbers', cards, noActivity, emptyNote };
  }

  // ─── Picks price-chart slide ────────────────────────────────────────────────

  // One price chart per stock in the competition — deduped by SECURITY (a stock
  // shared between investors is charted once, attributed to whoever put the most
  // in), and every pick is shown (no cap). Sorted by amount invested.
  function buildPicksSlide(store, c, scored, names, noActivity, emptyNote) {
    const bySecurity = new Map();
    for (const r of scored.ranks || []) {
      for (const b of r.breakdown || []) {
        const key = canonicalName(b.security);
        const gain = (b.unrealized || 0) + (b.realized || 0) + (b.divs || 0);
        // What this participant actually put into the stock. costSum is the
        // remaining held cost; add back the cost of any in-window sells.
        const amount = (b.costSum || 0) + Math.max((b.soldProceeds || 0) - (b.realized || 0), 0);
        const cur = bySecurity.get(key);
        if (!cur || amount > cur.amount) bySecurity.set(key, { code: r.code, security: key, gain, amount });
      }
    }
    const chosen = [...bySecurity.values()].sort((a, b) => b.amount - a.amount);
    const charts = chosen.map((x) => buildPriceSeries(store, x, c.start_date, c.end_date, names));
    return { type: 'picks', title: 'The picks, charted', charts, noActivity, emptyNote };
  }

  // Build a {points, markers} price series for one (participant, security) pick.
  function buildPriceSeries(store, pick, start, end, names) {
    const canon = canonicalName(pick.security);
    const { points, markers } = priceSeries(store, canon, start, end, pick.code);
    return {
      code: pick.code, name: names[pick.code] || pick.code,
      security: canon, gain: pick.gain, points, markers,
    };
  }

  // Build a price line for one security over [start, end] using every
  // datapoint we have: the Kurs from each in-window trade AND every
  // StockPrices daily closes (matrix wins on a shared date). Markers
  // mark the given participant's own buys/sells.
  function priceSeries(store, canon, start, end, code) {
    const byDate = new Map();
    const markers = [];
    for (const tx of store.transactions || []) {
      if (!tx.security || !tx.tradeDate) continue;
      if (tx.tradeDate < start || tx.tradeDate > end) continue;
      if (canonicalName(tx.security) !== canon) continue;
      const isTrade = tx.type === 'KJØPT' || tx.type === 'SALG';
      if (isTrade && Number.isFinite(tx.price) && tx.price > 0) {
        byDate.set(tx.tradeDate, { date: tx.tradeDate, price: tx.price });
      }
      if (isTrade && code != null) {
        const split = splitForSecurity(store.attributionMap, tx.security);
        if (split.some((s) => s.code === code)) {
          markers.push({ date: tx.tradeDate, type: tx.type === 'SALG' ? 'sell' : 'buy' });
        }
      }
    }
    // Daily closes from the price matrix take precedence — genuine history
    // beats the sparse trade-price sketch.
    const sec = store.registry && store.registry.forName(canon);
    if (sec && sec.ticker && store.prices) {
      for (const p of store.prices.series.get(sec.ticker) || []) {
        if (p.d < start || p.d > end) continue;
        byDate.set(p.d, { date: p.d, price: p.v });
      }
    }
    const points = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    return { points, markers };
  }

  // ─── Equity-curve slide ─────────────────────────────────────────────────────

  // Sample the competition window at ~14 points and re-score [start → sample]
  // each time, producing one return-% line per participant. Every interior
  // point is priced with the actual closes on that date via pricesAtDate.
  function buildCurveSlide(store, c, participants, names, noActivity, emptyNote) {
    // Sample at real StockPrices dates inside the window (thinned to ~14) so
    // every interior point is priced by actual closes. Fall back to even
    // spacing when the matrix has no in-window dates. Always include the end,
    // and anchor each line at 0% on the start date (return is 0 at entry).
    const priceDates = ((store.prices && store.prices.dates) || [])
      .filter((d) => d > c.start_date && d <= c.end_date);
    // Daily status: keep every trading day up to ~130 points (a 6-month
    // window stays fully daily; longer windows thin evenly).
    const step = Math.max(1, Math.ceil(priceDates.length / 130));
    const thinned = priceDates.filter((_, i) => i % step === 0);
    const interior = thinned.length
      ? thinned
      : sampleDates(c.start_date, c.end_date, 14).filter((d) => d > c.start_date && d <= c.end_date);
    const dates = interior.includes(c.end_date) ? interior : [...interior, c.end_date];

    // Buy/sell markers per participant: their attributed in-window trades,
    // rendered in the same style as The Game's chart.
    const { classify, isRealizingSell } = window.Ledger;
    const markersByCode = {};
    for (const tx of store.transactions || []) {
      if (!tx.security || !tx.tradeDate) continue;
      if (tx.tradeDate < c.start_date || tx.tradeDate > c.end_date) continue;
      const cat = classify(tx.type);
      const isBuy = cat === 'BUY' && tx.type === 'KJØPT';
      const isSell = cat === 'SELL' && isRealizingSell(tx.type);
      if (!isBuy && !isSell) continue;
      for (const sp of splitForSecurity(store.attributionMap, tx.security)) {
        const amt = Math.abs(window.Ledger.amountNok(tx)) * sp.weight;
        (markersByCode[sp.code] = markersByCode[sp.code] || []).push({
          date: tx.tradeDate, type: isSell ? 'sell' : 'buy',
          label: `${sp.code} ${isSell ? 'sold' : 'bought'} ${canonicalName(tx.security)} · ${fmtNok(amt)}`,
        });
      }
    }

    const acc = {};
    for (const d of dates) {
      const r = scoreWithDates(store, c, participants, c.start_date, d);
      for (const row of r) {
        (acc[row.code] = acc[row.code] || []).push({
          date: d, y: row.pct,
          // Hover shows the actual money: realized + unrealized + dividends.
          tipValue: `${fmtNok(row.netPnl)} (${fmtPct(row.pct)})`,
        });
      }
    }
    for (const code of Object.keys(acc)) acc[code].unshift({ date: c.start_date, y: 0, tipValue: '0 kr (0.0%)' });
    let i = 0;
    const palette = ['#4ade80', '#60a5fa', '#fbbf24', '#f472b6', '#a78bfa', '#34d399', '#f87171'];
    const series = Object.keys(acc).map((code) => ({
      name: `${code}${names[code] ? ' ' + names[code] : ''}`,
      color: INVESTOR_COLORS[code] || palette[i++ % palette.length],
      points: acc[code],
      markers: markersByCode[code] || [],
    }));
    return { type: 'curve', title: 'Return over the window', series, asOf: c.end_date, noActivity, emptyNote };
  }

  // Evenly spaced ISO dates from start..end inclusive (at most `n`, at least 2).
  function sampleDates(start, end, n) {
    const s = new Date(start + 'T00:00:00Z').getTime();
    const e = new Date(end + 'T00:00:00Z').getTime();
    if (!(e > s)) return [start, end];
    const days = Math.round((e - s) / 86400000);
    const count = Math.max(2, Math.min(n, days + 1));
    const out = [];
    for (let k = 0; k < count; k++) {
      const t = s + ((e - s) * k) / (count - 1);
      out.push(new Date(t).toISOString().slice(0, 10));
    }
    return out;
  }

  // Map canonical security name → most-recent-year KPI row {pe, eps, ...}.
  function buildKpiLookup(kpis) {
    const map = new Map();
    for (const k of kpis) {
      if (!k || !k.company) continue;
      const key = canonicalName(k.company);
      const prev = map.get(key);
      if (!prev || (k.year || 0) > (prev.year || 0)) map.set(key, k);
    }
    return map;
  }

  function pctCls(n) {
    return n > 0.5 ? 'positive' : n < -0.5 ? 'negative' : 'text-muted';
  }

  function scoreWithDates(store, c, participants, from, to) {
    const overridden = { ...c, start_date: from, end_date: to };
    const result = window.CompetitionEngine.scoreCompetition(store, overridden, participants);
    return result.ranks;
  }

  // Late-window trades, but only ones that follow the competition rules:
  // a trade counts only if it's on a security the participant actually holds
  // in the competition — i.e. a position opened by an in-window KJØPT (those
  // are exactly the securities in their scored breakdown). This excludes sells
  // of pre-window holdings and trades on stocks that aren't part of the
  // competition, which the old version wrongly included.
  function extractPivotTrades(store, c, scored) {
    const attrMap = store.attributionMap;
    const txs = store.transactions;
    const start = c.start_date;
    const end = c.end_date;
    const mid = midDate(start, end);

    // code → set of canonical securities that are part of that participant's
    // competition (opened by an in-window buy).
    const compSecsByCode = new Map();
    for (const r of scored.ranks || []) {
      compSecsByCode.set(r.code, new Set((r.breakdown || []).map((b) => canonicalName(b.security))));
    }

    const out = [];
    for (const tx of txs) {
      if (!tx.security || !tx.tradeDate) continue;
      if (tx.type !== 'KJØPT' && tx.type !== 'SALG') continue;
      if (tx.tradeDate < start || tx.tradeDate > end) continue;
      if (tx.tradeDate < mid) continue;
      const sec = canonicalName(tx.security);
      const split = splitForSecurity(attrMap, tx.security);
      for (const { code, weight } of split) {
        const secs = compSecsByCode.get(code);
        if (!secs || !secs.has(sec)) continue; // not a competition position for this participant
        out.push({
          date: tx.tradeDate, code, type: tx.type,
          security: sec,
          qty: (tx.qty || 0) * weight,
          amount: (tx.amount || 0) * weight,
        });
      }
    }
    out.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
    return out.slice(0, 12);
  }

  window.PresentationBuilder = { buildPresentation };
})();
