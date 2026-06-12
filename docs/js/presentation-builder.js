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

  function buildPresentation(store, scored) {
    const c = scored.competition;
    const ranks = scored.ranks;
    const names = namesFromMembers(store.members);
    const participants = scored.participants || [];

    // This engine scores only stocks BOUGHT inside the window. If nobody
    // bought anything in range, every metric is zero — flag it so slides can
    // show a clear explanation instead of a wall of 0 kr / 0.0%.
    const noActivity = ranks.every((r) => (r.amountSpent || 0) === 0);
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

    const earlyEnd = addDays(c.start_date, 30);
    const earlyRanks = scoreWithDates(store, c, scored.participants || [], c.start_date, earlyEnd);
    const earlySlide = {
      type: 'early',
      title: 'First 30 days',
      teaser: 'Who came out swinging? Who needed time?',
      asOf: earlyEnd,
      ranks: earlyRanks.map((r) => ({
        code: r.code, teamLabel: r.teamLabel, pct: r.pct, netPnl: r.netPnl,
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
          }),
          { mv: 0, costSum: 0, divs: 0, unrealized: 0 }
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

    let verdictLine = '';
    if (ranks.length) {
      const top = ranks[0]; const last = ranks[ranks.length - 1];
      verdictLine = `${top.code} takes the win at ${fmtPct(top.pct)}. ${last.code} brings up the rear at ${fmtPct(last.pct)}.`;
      if (top.pct > 30) verdictLine += ' A vintage run.';
      if (last.pct < -10) verdictLine += ' Better luck next round.';
    }
    const verdictSlide = {
      type: 'verdict',
      title: 'Verdict',
      teaser: verdictLine,
      runnerUps: ranks.slice(0, 3).map((r) => verdictFromReturn(names[r.code] || r.code, r.pct)),
    };

    return {
      competition: c,
      slides: [
        titleSlide, summarySlide, setupSlide, earlySlide, curveSlide,
        picksSlide, pivotSlide, positionSlide, standingsSlide, verdictSlide,
      ],
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

  // One price chart per chosen pick: each participant's best in-window pick,
  // plus the largest buys by amount, deduped (code+security) and capped at 6.
  function buildPicksSlide(store, c, scored, names, noActivity, emptyNote) {
    const candidates = [];
    for (const r of scored.ranks || []) {
      let best = null;
      for (const b of r.breakdown || []) {
        const gain = (b.unrealized || 0) + (b.realized || 0) + (b.divs || 0);
        const cand = { code: r.code, security: b.security, gain, amount: b.costSum || 0 };
        candidates.push(cand);
        if (!best || gain > best.gain) best = cand;
      }
      if (best) best.bestForParticipant = true;
    }
    const seen = new Set();
    const chosen = [];
    const add = (x) => {
      const k = x.code + '|' + x.security;
      if (!seen.has(k)) { seen.add(k); chosen.push(x); }
    };
    candidates.filter((x) => x.bestForParticipant).forEach(add);
    [...candidates].sort((a, b) => b.amount - a.amount).forEach((x) => { if (chosen.length < 6) add(x); });

    const charts = chosen.slice(0, 6).map((x) => buildPriceSeries(store, x, c.start_date, c.end_date, names));
    return { type: 'picks', title: 'The picks, charted', charts, noActivity, emptyNote };
  }

  // Build a {points, markers} price series for one (participant, security) pick.
  function buildPriceSeries(store, pick, start, end, names) {
    const canon = canonicalName(pick.security);
    const byDate = new Map();
    for (const h of store.holdings || []) {
      if (!h.snapshotDate || h.currentPrice == null) continue;
      if (h.snapshotDate < start || h.snapshotDate > end) continue;
      if (canonicalName(h.security) !== canon) continue;
      byDate.set(h.snapshotDate, { date: h.snapshotDate, price: h.currentPrice });
    }
    const points = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

    const markers = [];
    for (const tx of store.transactions || []) {
      if (!tx.security || !tx.tradeDate) continue;
      if (tx.tradeDate < start || tx.tradeDate > end) continue;
      if (tx.type !== 'KJØPT' && tx.type !== 'SALG') continue;
      if (canonicalName(tx.security) !== canon) continue;
      const split = splitForSecurity(store.attributionMap, tx.security);
      if (!split.some((s) => s.code === pick.code)) continue;
      markers.push({ date: tx.tradeDate, type: tx.type === 'SALG' ? 'sell' : 'buy' });
    }
    return {
      code: pick.code, name: names[pick.code] || pick.code,
      security: canon, gain: pick.gain, points, markers,
    };
  }

  // ─── Equity-curve slide ─────────────────────────────────────────────────────

  // Sample the competition window at ~14 points and re-score [start → sample]
  // each time, producing one return-% line per participant. NOTE: if
  // Beholdningsverdi holds only the current snapshot, pricesAtDate falls back
  // to latest prices for interior dates, so the curve reflects cumulative
  // realized + dividends + (latest-price) unrealized as buys accrue — directionally
  // right, but interior unrealized MV is not historically priced.
  function buildCurveSlide(store, c, participants, names, noActivity, emptyNote) {
    const dates = sampleDates(c.start_date, c.end_date, 14);
    // pctByDate[code] = array of {date, y} aligned to `dates`.
    const acc = {};
    for (const d of dates) {
      const r = scoreWithDates(store, c, participants, c.start_date, d);
      for (const row of r) {
        (acc[row.code] = acc[row.code] || []).push({ date: d, y: row.pct });
      }
    }
    let i = 0;
    const palette = ['#4ade80', '#60a5fa', '#fbbf24', '#f472b6', '#a78bfa', '#34d399', '#f87171'];
    const series = Object.keys(acc).map((code) => ({
      name: `${code}${names[code] ? ' ' + names[code] : ''}`,
      color: INVESTOR_COLORS[code] || palette[i++ % palette.length],
      points: acc[code],
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

  function extractPivotTrades(store, c, scored) {
    const attrMap = store.attributionMap;
    const txs = store.transactions;
    const start = c.start_date;
    const end = c.end_date;
    const mid = midDate(start, end);
    const participantCodes = new Set(scored.ranks.map((r) => r.code));

    const out = [];
    for (const tx of txs) {
      if (!tx.security || !tx.tradeDate) continue;
      if (tx.type !== 'KJØPT' && tx.type !== 'SALG') continue;
      if (tx.tradeDate < start || tx.tradeDate > end) continue;
      if (tx.tradeDate < mid) continue;
      const split = splitForSecurity(attrMap, tx.security);
      for (const { code, weight } of split) {
        if (!participantCodes.has(code)) continue;
        out.push({
          date: tx.tradeDate, code, type: tx.type,
          security: canonicalName(tx.security),
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
