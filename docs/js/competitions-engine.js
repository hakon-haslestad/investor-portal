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
//   • Budget is a recyclable pool: SALG proceeds free up capital to redeploy,
//     so capital used = net invested = gross KJØPT − in-window SALG proceeds.
//     Over-budget is flagged on net invested, not gross buys.
//   • Per-participant return % = netPnl / net invested. Teams aggregate by
//     team_label.
//
// Pure — takes hydrated `store` + competition + participants.

(function () {
  const { INVESTOR_CODES, classify, splitForSecurity, amountNok } = window.Ledger;
  const { canonicalName, pricesAtDate } = window.Portfolio;

  function scoreCompetition(store, competition, participants) {
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

      let grossBought = 0;   // sum of all KJØPT in window
      let sellProceeds = 0;  // sum of in-window SALG proceeds (frees up budget)
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
          const wa = Math.abs(amountNok(tx) * w);
          const lot = ensure(sec);
          lot.qty += wq;
          lot.costSum += wa;
          lot.opened = true;
          grossBought += wa;
        } else if (tx.type === 'SALG') {
          const lot = lots.get(sec);
          // Pre-window-only positions: nothing to do for the competition.
          if (!lot || !lot.opened || lot.qty <= 0) continue;
          const wq = Math.abs((tx.qty || 0) * w);
          const wa = amountNok(tx) * w; // positive proceeds (Nordnet)
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
          sellProceeds += proceedsForSold;
        } else if (cat === 'DIVIDEND' || cat === 'TAX') {
          const lot = lots.get(sec);
          if (!lot || !lot.opened || lot.qty <= 0) continue;
          const wa = amountNok(tx) * w;
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
        // Value in NOK. Beholdningsverdi.currentPrice is in the security's
        // native currency (USD/SEK/…), but marketValueNok is already converted,
        // so derive a NOK-per-share (marketValueNok / qty) — otherwise foreign
        // holdings get marked ~FX-rate too low against their NOK cost basis.
        // Fall back to the raw price only when the snapshot lacks MV/qty.
        const endPrice = px
          ? ((px.marketValueNok != null && px.qty) ? px.marketValueNok / px.qty : (px.price || 0))
          : 0;
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
      // Budget is a recyclable pool: selling returns proceeds you can redeploy,
      // so capital used = gross buys − sell proceeds (net invested). This is also
      // the return-% denominator. Floor at 0; if a participant net-sold (proceeds
      // exceeded buys, e.g. exited at a gain), fall back to gross buys for the
      // denominator so the return % stays meaningful instead of exploding.
      const amountSpent = Math.max(grossBought - sellProceeds, 0);
      const base = amountSpent > 0 ? amountSpent : (grossBought > 0 ? grossBought : 1);
      const pct = (netPnl / base) * 100;

      perParticipant.push({
        code,
        teamLabel: p.team_label || code,
        buyIn: p.buy_in_nok || 0,
        amountSpent,
        grossBought,
        sellProceeds,
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
          buyIn: 0, amountSpent: 0, grossBought: 0, netPnl: 0,
          realized: 0, divs: 0, unrealized: 0, mvAtEnd: 0,
        });
      }
      const t = teamMap.get(key);
      t.members.push(p.code);
      t.buyIn = Math.max(t.buyIn, p.buyIn || 0); // de-double team budget
      t.amountSpent += p.amountSpent; // net invested (buys − sell proceeds)
      t.grossBought += p.grossBought;
      t.netPnl += p.netPnl;
      t.realized += p.realizedInWindow;
      t.divs += p.divsInWindow;
      t.unrealized += p.unrealizedAtEnd;
      t.mvAtEnd += p.mvAtEnd;
    }
    const teams = Array.from(teamMap.values())
      .map((t) => {
        const teamBase = t.amountSpent > 0 ? t.amountSpent : (t.grossBought > 0 ? t.grossBought : 1);
        return {
          ...t,
          pct: (t.netPnl / teamBase) * 100,
          overSpent: t.buyIn > 0 && t.amountSpent > t.buyIn,
          overSpentBy: t.buyIn > 0 ? Math.max(0, t.amountSpent - t.buyIn) : 0,
        };
      })
      .sort((a, b) => b.pct - a.pct);

    return { competition, ranks, teams, snapshotUsed };
  }

  window.CompetitionEngine = { scoreCompetition };
})();
