// Build the 7-slide presentation payload for a scored competition.
// Ported from src/competitions/presentation.js. Drops the dayjs dep —
// uses plain Date arithmetic.

(function () {
  const { canonicalName } = window.Portfolio;
  const { splitForSecurity } = window.Ledger;
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
    const earlyRanks = scoreWithDates(store, c, scored.participants || [], scored.picks || [], c.start_date, earlyEnd);
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
        return {
          code: r.code, name: names[r.code] || r.code,
          teamLabel: r.teamLabel, breakdown: r.breakdown || [], total: sumTotal,
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
      slides: [titleSlide, setupSlide, earlySlide, pivotSlide, positionSlide, standingsSlide, verdictSlide],
    };
  }

  function scoreWithDates(store, c, participants, picks, from, to) {
    const overridden = { ...c, start_date: from, end_date: to };
    const result = window.CompetitionEngine.scoreCompetition(store, overridden, participants, picks);
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
