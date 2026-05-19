// Reports — monthly financial ledger. Buckets every transaction by YYYY-MM
// of its booking date, summarises the headline accounting metrics, and
// renders a per-year-grouped table with a totals row per fiscal year.
//
// The "Debt-to-equity proxy" column is the share of capital that is NOT
// deployed into stocks — cash / (cash + MV). It's our stand-in for the
// cash-drag ratio investors track when reviewing strategic allocation.

(async function () {
  const { store } = await window.Nav.bootstrap('reports');
  const { fmtNok, fmtPct, pctClass } = window.Fmt;
  const { classify } = window.Ledger;
  const root = document.getElementById('root');

  const months = buildMonthlyLedger(store);

  root.innerHTML = `
    <div class="hero">
      <h2>Monthly accounting</h2>
      <div class="when">Formal ledger — net result, fees, dividends, deposits, ending balance.</div>
    </div>
    <p class="text-muted text-small">
      Every row is one calendar month. Net result = realized P/L + dividends − fees − withholding tax.
      Ending cash is the latest Nordnet <code>Saldo</code> recorded in that month;
      ending MV is the closest <code>Beholdningsverdi</code> snapshot on or before month-end.
      D/E proxy = cash / (cash + MV) — a higher number means more idle capital.
    </p>
    <div class="chart-wrap" style="overflow-x:auto">
      <table class="report-table">
        <thead><tr>
          <th>Month</th>
          <th class="text-right">Net result</th>
          <th class="text-right">Realized</th>
          <th class="text-right">Dividends</th>
          <th class="text-right">Tx fees</th>
          <th class="text-right">Withholding tax</th>
          <th class="text-right">Deposits</th>
          <th class="text-right">Withdrawals</th>
          <th class="text-right">Ending cash</th>
          <th class="text-right">Ending MV</th>
          <th class="text-right">D/E proxy</th>
        </tr></thead>
        <tbody>
          ${renderRows(months)}
        </tbody>
      </table>
    </div>
  `;

  function buildMonthlyLedger(store) {
    const buckets = new Map();
    for (const tx of store.transactions) {
      const date = tx.bookDate || tx.tradeDate;
      if (!date) continue;
      const ym = date.slice(0, 7);
      if (!buckets.has(ym)) buckets.set(ym, blank(ym));
      const b = buckets.get(ym);
      const cat = classify(tx.type);
      const amt = tx.amount || 0;
      const fee = Math.abs(tx.fee || 0);
      if (cat === 'BUY' || cat === 'SELL') b.fees += fee;
      if (cat === 'FEE') b.fees += Math.abs(amt);
      if (cat === 'DIVIDEND') b.dividends += amt;
      if (cat === 'TAX') b.tax += amt;
      if (cat === 'DEPOSIT') b.deposits += amt;
      if (cat === 'WITHDRAWAL') b.withdrawals += Math.abs(amt);
      if (cat === 'SELL' && tx.type === 'SALG') {
        // Realized P/L is approximated as the realized share computed across
        // the full ledger. For a clean monthly view we replay the cost basis
        // up to and through this row.
      }
    }
    // Compute monthly realized P/L by replaying cost basis chronologically.
    const realizedByMonth = monthlyRealized(store);
    for (const [ym, val] of realizedByMonth.entries()) {
      if (!buckets.has(ym)) buckets.set(ym, blank(ym));
      buckets.get(ym).realized = val;
    }

    // Ending cash (last Saldo on or before month-end) and ending MV
    const monthList = Array.from(buckets.keys()).sort();
    for (const ym of monthList) {
      const monthEnd = lastDayOf(ym);
      const cash = window.Portfolio.cash.saldoOnOrBefore(store, monthEnd);
      const snap = window.Portfolio.snapshotForDate(store, monthEnd);
      let mv = 0;
      if (snap) {
        for (const h of store.holdings) {
          if (h.snapshotDate !== snap) continue;
          mv += h.marketValueNok || 0;
        }
      }
      const b = buckets.get(ym);
      b.endingCash = cash;
      b.endingMv = snap ? mv : null;
      b.netResult = b.realized + b.dividends - b.fees + b.tax; // tax is signed negative already
      if (b.endingCash != null && b.endingMv != null && (b.endingCash + b.endingMv) > 0) {
        b.deProxy = b.endingCash / (b.endingCash + b.endingMv);
      } else {
        b.deProxy = null;
      }
    }
    return monthList.map((ym) => buckets.get(ym)).reverse(); // newest first
  }

  function monthlyRealized(store) {
    const out = new Map();
    const costMap = new Map(); // security → { qty, costSum }
    for (const tx of store.transactions.slice().sort((a, b) => {
      const ak = a.tradeDate || a.bookDate || '';
      const bk = b.tradeDate || b.bookDate || '';
      return ak.localeCompare(bk);
    })) {
      const cat = classify(tx.type);
      if (cat !== 'BUY' && cat !== 'SELL') continue;
      if (tx.type !== 'KJØPT' && tx.type !== 'SALG') continue;
      const security = tx.security;
      if (!security) continue;
      const qty = tx.qty || 0;
      const amount = tx.amount || 0;
      if (!costMap.has(security)) costMap.set(security, { qty: 0, costSum: 0 });
      const slot = costMap.get(security);
      if (cat === 'BUY') {
        slot.qty += qty;
        slot.costSum += Math.abs(amount);
      } else {
        const avg = slot.qty > 0 ? slot.costSum / slot.qty : 0;
        const sold = Math.abs(qty);
        const realized = amount - avg * sold;
        const ym = (tx.bookDate || tx.tradeDate || '').slice(0, 7);
        if (ym) out.set(ym, (out.get(ym) || 0) + realized);
        const fracSold = slot.qty > 0 ? sold / slot.qty : 0;
        slot.costSum = Math.max(0, slot.costSum - slot.costSum * fracSold);
        slot.qty = Math.max(0, slot.qty - sold);
      }
    }
    return out;
  }

  function blank(ym) {
    return {
      ym,
      realized: 0, dividends: 0, fees: 0, tax: 0,
      deposits: 0, withdrawals: 0,
      endingCash: null, endingMv: null, deProxy: null, netResult: 0,
    };
  }

  function lastDayOf(ym) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(Date.UTC(y, m, 0));
    return d.toISOString().slice(0, 10);
  }

  function sumMonths(months) {
    return months.reduce((acc, m) => ({
      netResult: acc.netResult + m.netResult,
      realized: acc.realized + m.realized,
      dividends: acc.dividends + m.dividends,
      fees: acc.fees + m.fees,
      tax: acc.tax + m.tax,
      deposits: acc.deposits + m.deposits,
      withdrawals: acc.withdrawals + m.withdrawals,
    }), { netResult: 0, realized: 0, dividends: 0, fees: 0, tax: 0, deposits: 0, withdrawals: 0 });
  }

  // Pick the most recent month's ending cash/MV/DE for the year — months are
  // sorted newest-first, so the first row of each year IS year-end.
  function yearEndSnapshot(monthsOfYear) {
    const latest = monthsOfYear[0];
    return latest ? { endingCash: latest.endingCash, endingMv: latest.endingMv, deProxy: latest.deProxy } : { endingCash: null, endingMv: null, deProxy: null };
  }

  function renderRows(months) {
    const byYear = new Map();
    for (const m of months) {
      const y = m.ym.slice(0, 4);
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push(m);
    }
    let lastYear = null;
    return months.map((m) => {
      const year = m.ym.slice(0, 4);
      let header = '';
      if (year !== lastYear) {
        const yr = byYear.get(year);
        const sum = sumMonths(yr);
        const end = yearEndSnapshot(yr);
        header = `
          <tr class="year-header"><td colspan="11">${year}</td></tr>
          <tr class="year-totals">
            <td><strong>${year} total</strong></td>
            <td class="text-right ${pctClass(sum.netResult)}"><strong>${fmtNok(sum.netResult)}</strong></td>
            <td class="text-right ${pctClass(sum.realized)}">${fmtNok(sum.realized)}</td>
            <td class="text-right">${fmtNok(sum.dividends)}</td>
            <td class="text-right text-muted">${fmtNok(sum.fees)}</td>
            <td class="text-right text-muted">${fmtNok(sum.tax)}</td>
            <td class="text-right">${fmtNok(sum.deposits)}</td>
            <td class="text-right text-muted">${fmtNok(sum.withdrawals)}</td>
            <td class="text-right">${end.endingCash != null ? fmtNok(end.endingCash) : '—'}</td>
            <td class="text-right">${end.endingMv != null ? fmtNok(end.endingMv) : '—'}</td>
            <td class="text-right">${end.deProxy != null ? fmtPct(end.deProxy * 100, false) : '—'}</td>
          </tr>
        `;
      }
      lastYear = year;
      return header + `
        <tr>
          <td>${m.ym}</td>
          <td class="text-right ${pctClass(m.netResult)}"><strong>${fmtNok(m.netResult)}</strong></td>
          <td class="text-right ${pctClass(m.realized)}">${fmtNok(m.realized)}</td>
          <td class="text-right">${fmtNok(m.dividends)}</td>
          <td class="text-right text-muted">${fmtNok(m.fees)}</td>
          <td class="text-right text-muted">${fmtNok(m.tax)}</td>
          <td class="text-right">${fmtNok(m.deposits)}</td>
          <td class="text-right text-muted">${fmtNok(m.withdrawals)}</td>
          <td class="text-right">${m.endingCash != null ? fmtNok(m.endingCash) : '—'}</td>
          <td class="text-right">${m.endingMv != null ? fmtNok(m.endingMv) : '—'}</td>
          <td class="text-right">${m.deProxy != null ? fmtPct(m.deProxy * 100, false) : '—'}</td>
        </tr>
      `;
    }).join('');
  }
})();
