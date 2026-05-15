// Competition scoring engine — "in-window buys" rules.
//
//   • A position only enters the competition when KJØPT lands inside
//     [start_date, end_date]. Stocks bought BEFORE the window don't count
//     even if sold during it.
//   • SALG during the window reduces in-window inventory only (LIFO-on-bucket:
//     we treat all in-window buys as a single per-security bucket). The portion
//     of a sell that exceeds in-window qty is ignored — it was selling
//     pre-window shares, which aren't in the competition.
//   • UTBYTTE / KUPONGSKATT during the window count if the participant still
//     holds in-window inventory at that time.
//   • End-of-window valuation uses the closest Beholdningsverdi snapshot
//     on-or-before end_date (period-correct, not "now").
//   • Per-participant return % = netPnl / amountSpent (denominator =
//     KJØPT total in window). Teams aggregate by team_label.
//
// Pure — takes hydrated `store` + competition + participants.

(function () {
  const { INVESTOR_CODES, classify, splitForSecurity } = window.Ledger;
  const { canonicalName, pricesAtDate } = window.Portfolio;

  function scoreCompetition(store, competition, participants /*, _legacyPicks */) {
    const attrMap = store.attributionMap;
    const txs = store.transactions;
    const startDate = competition.start_date;
    const endDate = competition.end_date;
    const endPrices = pricesAtDate(store, endDate);
    // Snapshot date actually used (closest in Beholdningsverdi on-or-before end_date).
    const snapshotUsed = window.Portfolio.snapshotForDate(store, endDate);

    const perParticipant = [];
    for (const p of participants) {
      const code = p.investor_code;

      // Per-security lots, opened only by KJØPT in window
      const lots = new Map();
      const ensure = (sec) => {
        if (!lots.has(sec)) {
          lots.set(sec, {
            qty: 0, costSum: 0,
            divs: 0,
            soldQty: 0, soldProceeds: 0,
            realized: 0,
            opened: false,
          });
        }
        return lots.get(sec);
      };

      let amountSpent = 0;
      let realized = 0;
      let divsInWindow = 0;

      for (const tx of txs) {
        if (!tx.security || !tx.tradeDate) continue;
        if (tx.tradeDate < startDate || tx.tradeDate > endDate) continue;
        const split = splitForSecurity(attrMap, tx.security);
        const slot = split.find((s) => s.code === code);
        if (!slot) continue;
        const w = slot.weight;
        const sec = canonicalName(tx.security);
        const cat = classify(tx.type);

        if (tx.type === 'KJØPT') {
          const wq = (tx.qty || 0) * w;
          const wa = Math.abs((tx.amount || 0) * w);
          const lot = ensure(sec);
          lot.qty += wq;
          lot.costSum += wa;
          lot.opened = true;
          amountSpent += wa;
        } else if (tx.type === 'SALG') {
          const lot = lots.get(sec);
          // Pre-window-only positions: nothing to do for the competition.
          if (!lot || !lot.opened || lot.qty <= 0) continue;
          const wq = Math.abs((tx.qty || 0) * w);
          const wa = (tx.amount || 0) * w; // positive proceeds (Nordnet)
          const sold = Math.min(wq, lot.qty);
          // Pro-rate the sell proceeds by how much of the sell hit in-window inventory.
          const proceedsForSold = wq > 0 ? wa * (sold / wq) : 0;
          const fracSold = lot.qty > 0 ? sold / lot.qty : 0;
          const costForSold = lot.costSum * fracSold;
          const pnl = proceedsForSold - costForSold;
          lot.realized += pnl;
          realized += pnl;
          lot.qty -= sold;
          lot.costSum -= costForSold;
          lot.soldQty += sold;
          lot.soldProceeds += proceedsForSold;
        } else if (cat === 'DIVIDEND' || cat === 'TAX') {
          const lot = lots.get(sec);
          if (!lot || !lot.opened || lot.qty <= 0) continue;
          const wa = (tx.amount || 0) * w;
          lot.divs += wa;
          divsInWindow += wa;
        }
      }

      // End-of-window valuation
      let unrealizedAtEnd = 0, mvAtEnd = 0;
      const breakdown = [];
      for (const [sec, lot] of lots.entries()) {
        if (!lot.opened) continue;
        const px = endPrices.get(sec);
        const endPrice = px ? px.price : 0;
        const mv = lot.qty * (endPrice || 0);
        const unrealized = mv - lot.costSum;
        mvAtEnd += mv;
        unrealizedAtEnd += unrealized;
        breakdown.push({
          security: sec,
          qty: lot.qty,
          costSum: lot.costSum,
          endPrice,                  // price from Beholdningsverdi snapshot on-or-before end_date
          marketValueAtEnd: mv,      // qty × endPrice (only the in-window slice)
          // Aliases kept for older slide renderers that referenced these names:
          currentPrice: endPrice,
          marketValue: mv,
          unrealized,
          divs: lot.divs,
          realized: lot.realized,
          soldQty: lot.soldQty,
          soldProceeds: lot.soldProceeds,
        });
      }

      const netPnl = realized + divsInWindow + unrealizedAtEnd;
      // Return % is on what they actually spent, not buy-in.
      const base = Math.max(amountSpent, 1);
      const pct = (netPnl / base) * 100;

      perParticipant.push({
        code,
        teamLabel: p.team_label || code,
        buyIn: p.buy_in_nok || 0,
        amountSpent,
        breakdown,
        realizedInWindow: realized,
        divsInWindow,
        unrealizedAtEnd,
        mvAtEnd,
        netPnl,
        pct,
      });
    }

    const ranks = [...perParticipant].sort((a, b) => b.pct - a.pct);

    // Team aggregation. buyIn is per-team — same value sits on each member's
    // participant row. Use max (they're equal) to avoid double-counting.
    const teamMap = new Map();
    for (const p of perParticipant) {
      const key = p.teamLabel;
      if (!teamMap.has(key)) {
        teamMap.set(key, {
          label: key, members: [],
          buyIn: 0, amountSpent: 0, netPnl: 0,
          realized: 0, divs: 0, unrealized: 0, mvAtEnd: 0,
        });
      }
      const t = teamMap.get(key);
      t.members.push(p.code);
      t.buyIn = Math.max(t.buyIn, p.buyIn || 0); // de-double team budget
      t.amountSpent += p.amountSpent;
      t.netPnl += p.netPnl;
      t.realized += p.realizedInWindow;
      t.divs += p.divsInWindow;
      t.unrealized += p.unrealizedAtEnd;
      t.mvAtEnd += p.mvAtEnd;
    }
    const teams = Array.from(teamMap.values())
      .map((t) => ({
        ...t,
        pct: t.amountSpent > 0 ? (t.netPnl / t.amountSpent) * 100 : 0,
        overSpent: t.buyIn > 0 && t.amountSpent > t.buyIn,
        overSpentBy: t.buyIn > 0 ? Math.max(0, t.amountSpent - t.buyIn) : 0,
      }))
      .sort((a, b) => b.pct - a.pct);

    return { competition, ranks, teams, picksByInvestor: {}, snapshotUsed };
  }

  window.CompetitionEngine = { scoreCompetition };
})();
