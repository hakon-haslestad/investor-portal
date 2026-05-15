const db = require('../db');
const dayjs = require('dayjs');
const { NAMES, formatNok, formatPct, podium, verdictFromReturn } = require('../copy');
const { canonicalName } = require('../portfolio/calculator');
const {
  classify,
  loadAttributionMap,
  splitForSecurity,
  loadTransactions,
  INVESTOR_CODES,
} = require('../portfolio/ledger');

/**
 * Builds slide payload for a scored competition.
 * The frontend renders these slides — we keep the data shape language-agnostic so
 * we can tweak copy / layouts later without touching the engine.
 */
function buildPresentation(scored) {
  const c = scored.competition;
  const ranks = scored.ranks;
  const narrative = c.narrative_json ? JSON.parse(c.narrative_json) : {};

  const participantsLine = ranks
    .map((r) => `${r.code}${r.teamLabel ? ` (${r.teamLabel})` : ''}`)
    .join(' · ');

  // Slide 1 — title
  const titleSlide = {
    type: 'title',
    title: c.name,
    subtitle: narrative.subtitle || `${c.start_date} → ${c.end_date}`,
    chips: [
      c.type === 'team' ? 'Team mode' : 'Individual',
      c.mode === 'assigned_picks' ? 'Assigned picks' : 'Full portfolio',
    ],
    participantsLine,
  };

  // Slide 2 — setup (who picked what)
  const setupSlide = {
    type: 'setup',
    title: 'The setup',
    teaser: narrative.setup_teaser || 'Each crew brings their bag. The market does its thing. Numbers don\'t lie.',
    rows: ranks.map((r) => ({
      code: r.code,
      name: NAMES[r.code] || r.code,
      team: r.teamLabel,
      buyIn: r.buyIn,
      picks: (scored.picksByInvestor[r.code] || []),
    })),
  };

  // Slide 3 — early days
  const earlyEnd = dayjs(c.start_date).add(30, 'day').format('YYYY-MM-DD');
  const earlyScore = pseudoSnapshotPnl(c, scored, c.start_date, earlyEnd);
  const earlySlide = {
    type: 'early',
    title: 'First 30 days',
    teaser: narrative.early_teaser || 'Who came out swinging? Who needed time?',
    asOf: earlyEnd,
    ranks: earlyScore,
  };

  // Slide 4 — the pivot
  const pivotSlide = {
    type: 'pivot',
    title: narrative.pivot_title || 'The plot twist',
    teaser: narrative.pivot_teaser || 'Some pivot. Some don\'t. Some pivots actually work.',
    trades: extractPivotTrades(c, scored),
  };

  // Slide 5 — position breakdown
  const positionSlide = {
    type: 'positions',
    title: 'Position by position',
    teaser: 'Every stock told its own story. Here\'s the receipt.',
    rows: ranks.flatMap((r) => {
      const sumTotal = (r.breakdown || []).reduce(
        (acc, b) => ({
          mv: acc.mv + (b.marketValue || 0),
          costSum: acc.costSum + (b.costSum || 0),
          divs: acc.divs + (b.divs || 0),
          unrealized: acc.unrealized + (b.unrealized || 0),
        }),
        { mv: 0, costSum: 0, divs: 0, unrealized: 0 }
      );
      return [{
        code: r.code,
        name: NAMES[r.code] || r.code,
        teamLabel: r.teamLabel,
        breakdown: r.breakdown || [],
        total: sumTotal,
      }];
    }),
  };

  // Slide 6 — final standings
  const standingsSlide = {
    type: 'standings',
    title: 'Final standings',
    individual: ranks.map((r, i) => ({
      rank: i + 1,
      podium: podium[i] || '',
      code: r.code,
      name: NAMES[r.code] || r.code,
      teamLabel: r.teamLabel,
      pct: r.pct,
      netPnl: r.netPnl,
      mv: r.mvAtEnd,
    })),
    teams: scored.teams ? scored.teams.map((t, i) => ({
      rank: i + 1,
      podium: podium[i] || '',
      label: t.label,
      members: t.members,
      pct: t.pct,
      netPnl: t.netPnl,
      buyIn: t.buyIn,
    })) : null,
  };

  // Slide 7 — verdict
  let verdictLine = narrative.verdict || '';
  if (!verdictLine && ranks.length) {
    const top = ranks[0];
    const last = ranks[ranks.length - 1];
    verdictLine = `${top.code} cooked the rest with ${formatPct(top.pct)}. ${last.code} bringing up the rear at ${formatPct(last.pct)}.`;
    if (top.pct > 30) verdictLine += ' Pure cooking. 🔥';
    if (last.pct < -10) verdictLine += ' RIP 💀';
  }
  const verdictSlide = {
    type: 'verdict',
    title: 'Verdict',
    teaser: verdictLine,
    runnerUps: ranks.slice(0, 3).map((r) => verdictFromReturn(NAMES[r.code] || r.code, r.pct)),
  };

  return {
    competition: c,
    slides: [titleSlide, setupSlide, earlySlide, pivotSlide, positionSlide, standingsSlide, verdictSlide],
  };
}

function pseudoSnapshotPnl(c, scored, fromDate, toDate) {
  // For early-days slide: re-score within a narrowed window using a temp competition.
  // Cheap implementation: reuse engine logic but with overridden dates.
  const overridden = { ...c, start_date: fromDate, end_date: toDate };
  // We import lazily to avoid circular dep.
  const { scoreCompetition } = require('./engine');
  const result = scoreCompetition({ ...overridden });
  return result.ranks.map((r) => ({
    code: r.code,
    teamLabel: r.teamLabel,
    pct: r.pct,
    netPnl: r.netPnl,
  }));
}

function extractPivotTrades(c, scored) {
  // Pivot trades = KJØPT / SALG inside the window, attributed to participants.
  // Heuristic: trades in the *second half* of the window for assigned-picks competitions
  // are considered "pivot" moves. We surface them ranked by absolute amount.
  const attrMap = loadAttributionMap();
  const txs = loadTransactions();
  const start = dayjs(c.start_date);
  const end = dayjs(c.end_date);
  const mid = start.add(end.diff(start, 'day') / 2, 'day');
  const pickedSecsByCode = scored.picksByInvestor || {};

  const out = [];
  const participantCodes = new Set(scored.ranks.map((r) => r.code));
  for (const tx of txs) {
    if (!tx.security || !tx.trade_date) continue;
    if (tx.type !== 'KJØPT' && tx.type !== 'SALG') continue;
    if (tx.trade_date < c.start_date || tx.trade_date > c.end_date) continue;
    if (tx.trade_date < mid.format('YYYY-MM-DD')) continue; // only second-half trades
    const split = splitForSecurity(attrMap, tx.security);
    for (const { code, weight } of split) {
      if (!participantCodes.has(code)) continue;
      // For assigned_picks: only count trades on the picks
      if (c.mode === 'assigned_picks') {
        const picks = pickedSecsByCode[code] || [];
        if (!picks.includes(canonicalName(tx.security))) continue;
      }
      out.push({
        date: tx.trade_date,
        code,
        type: tx.type,
        security: canonicalName(tx.security),
        qty: (tx.qty || 0) * weight,
        amount: (tx.amount || 0) * weight,
      });
    }
  }
  out.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  return out.slice(0, 12);
}

module.exports = { buildPresentation };
