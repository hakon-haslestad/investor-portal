// Portfolio report — account-wide analysis.
//
// Holdings (value, shares, return) come from the latest Beholdningsverdi
// snapshot. The fundamentals / "your share" figures come ONLY from the
// Offisielle nøkkeltall tab: per company × period rows where cols D/F hold
// the user's share of revenue / profit as final NOK values (the portal does
// no FX or unit math), and an optional Period column (J) labels "2025",
// "Q1 2026", etc.

(async function () {
  const { store } = await window.Nav.bootstrap('report');
  const { fmtNok, fmtPct, pctClass, escapeHtml } = window.Fmt;
  const { canonicalName } = window.Portfolio;
  const root = document.getElementById('root');

  let sheetName = '';
  try { sheetName = await window.Sheet.spreadsheetTitle(); } catch (_e) { sheetName = ''; }

  // ── Holdings (latest snapshot) ──────────────────────────────────────────
  const holdings = window.Portfolio.currentHoldings(store)
    .slice()
    .sort((a, b) => (b.market_value_nok || 0) - (a.market_value_nok || 0));
  const totalValue = holdings.reduce((a, h) => a + (h.market_value_nok || 0), 0);
  const totalGain = holdings.reduce((a, h) => a + (h.returnNok || 0), 0);
  const invested = totalValue - totalGain;
  const totalPct = invested > 0 ? (totalGain / invested) * 100 : 0;
  const ranked = holdings.filter((h) => Number.isFinite(h.returnPct));
  const best = ranked.slice().sort((a, b) => b.returnPct - a.returnPct)[0];
  const worst = ranked.slice().sort((a, b) => a.returnPct - b.returnPct)[0];

  // ── Fundamentals from Offisielle nøkkeltall ─────────────────────────────
  const kpis = store.kpis || [];
  // Sort key: year*10 + quarter (annual treated as Q4 / end-of-year).
  const periodKey = (period) => {
    const ym = /(\d{4})/.exec(period || '');
    const year = ym ? Number(ym[1]) : 0;
    const qm = /Q\s*([1-4])/i.exec(period || '');
    const q = qm ? Number(qm[1]) : 4;
    return year * 10 + q;
  };
  // Group kpi rows by canonical company.
  const byCompany = new Map();
  for (const k of kpis) {
    if (!k.company) continue;
    const key = canonicalName(k.company);
    if (!byCompany.has(key)) byCompany.set(key, []);
    byCompany.get(key).push(k);
  }
  for (const rows of byCompany.values()) rows.sort((a, b) => periodKey(a.period) - periodKey(b.period));
  // Latest-period row per company (for the headline KPI table + P/E join).
  const latestByCompany = new Map();
  for (const [key, rows] of byCompany) latestByCompany.set(key, rows[rows.length - 1]);

  const peFor = (security) => {
    const k = latestByCompany.get(canonicalName(security));
    return k && Number.isFinite(k.pe) ? k.pe : null;
  };

  // Your-share totals across the latest period of each company.
  const latestRows = Array.from(latestByCompany.values());
  const yourRevTotal = latestRows.reduce((a, k) => a + (k.yourRevNok || 0), 0);
  const yourProfitTotal = latestRows.reduce((a, k) => a + (k.yourProfitNok || 0), 0);

  // Companies with two or more periods → period-compare section.
  const compareCompanies = Array.from(byCompany.entries())
    .filter(([, rows]) => rows.length >= 2)
    .map(([key, rows]) => ({ company: key, rows }));

  // Per-company comments (Merknad), from the latest period that has one.
  const notes = Array.from(byCompany.entries())
    .map(([key, rows]) => {
      const withNote = rows.slice().reverse().find((r) => r.note);
      return withNote ? { company: key, period: withNote.period, note: withNote.note } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.company.localeCompare(b.company));

  render();

  function render() {
    root.innerHTML = `
      <div class="hero">
        <div>
          <h2>Portfolio report</h2>
          <div class="when">${sheetName ? escapeHtml(sheetName) + ' · ' : ''}${holdings.length} positions${snapNote()}</div>
        </div>
      </div>

      <div class="kpi-grid">
        <div class="kpi-card"><div class="label">Portfolio value</div><div class="value">${fmtNok(totalValue)}</div></div>
        <div class="kpi-card"><div class="label">Unrealized gain</div><div class="value ${pctClass(totalGain)}">${fmtNok(totalGain)}</div><div class="sub ${pctClass(totalPct)}">${fmtPct(totalPct)} on invested</div></div>
        <div class="kpi-card"><div class="label">Positions</div><div class="value">${holdings.length}</div></div>
        ${best ? `<div class="kpi-card"><div class="label">Best position</div><div class="value">${escapeHtml(best.security)}</div><div class="sub positive">${fmtPct(best.returnPct)}</div></div>` : ''}
        ${worst ? `<div class="kpi-card"><div class="label">Worst position</div><div class="value">${escapeHtml(worst.security)}</div><div class="sub negative">${fmtPct(worst.returnPct)}</div></div>` : ''}
        ${latestRows.length ? `<div class="kpi-card"><div class="label">Your share of profit</div><div class="value ${pctClass(yourProfitTotal)}">${fmtNok(yourProfitTotal)}</div><div class="sub">rev ${fmtNok(yourRevTotal)}</div></div>` : ''}
      </div>

      <div class="section-title">Holdings</div>
      <div class="chart-wrap" style="overflow-x:auto">
        <table class="report-table">
          <thead><tr><th>Company</th><th class="text-right">Shares</th><th class="text-right">Value NOK</th><th class="text-right">Return</th><th class="text-right">P/E</th></tr></thead>
          <tbody>
            ${holdings.map((h) => `
              <tr>
                <td>${escapeHtml(h.security)}</td>
                <td class="text-right">${fmtShares(h.qty)}</td>
                <td class="text-right">${fmtNok(h.market_value_nok)}</td>
                <td class="text-right ${pctClass(h.returnPct)}">${fmtPct(h.returnPct)}</td>
                <td class="text-right text-muted">${peFor(h.security) != null ? peFor(h.security) : '—'}</td>
              </tr>
            `).join('')}
            <tr class="summary-row">
              <td>Total</td><td></td>
              <td class="text-right">${fmtNok(totalValue)}</td>
              <td class="text-right ${pctClass(totalGain)}">${fmtNok(totalGain)}</td>
              <td></td>
            </tr>
          </tbody>
        </table>
      </div>

      ${latestRows.length ? `
      <div class="section-title">Your share — latest period</div>
      <p class="text-muted text-small">Your share of each company's reported figures, in NOK, as entered in <code>Offisielle nøkkeltall</code>. Indicative — P/E basis varies by company.</p>
      <div class="chart-wrap" style="overflow-x:auto">
        <table class="report-table">
          <thead><tr><th>Company</th><th>Period</th><th>Revenue</th><th>Profit</th><th class="text-right">Your rev (NOK)</th><th class="text-right">Your profit (NOK)</th><th class="text-right">P/E</th></tr></thead>
          <tbody>
            ${latestRows.slice().sort((a, b) => (b.yourRevNok || 0) - (a.yourRevNok || 0)).map((k) => `
              <tr>
                <td>${escapeHtml(canonicalName(k.company))}</td>
                <td class="text-small">${escapeHtml(k.period || '')}</td>
                <td class="text-small">${k.revenue != null ? escapeHtml(k.revenue) : '—'}</td>
                <td class="text-small">${k.eat != null ? escapeHtml(k.eat) : '—'}</td>
                <td class="text-right">${fmtNok(k.yourRevNok)}</td>
                <td class="text-right ${pctClass(k.yourProfitNok)}">${fmtNok(k.yourProfitNok)}</td>
                <td class="text-right text-muted">${Number.isFinite(k.pe) ? k.pe : '—'}</td>
              </tr>
            `).join('')}
            <tr class="summary-row">
              <td>Total</td><td></td><td></td><td></td>
              <td class="text-right">${fmtNok(yourRevTotal)}</td>
              <td class="text-right ${pctClass(yourProfitTotal)}">${fmtNok(yourProfitTotal)}</td>
              <td></td>
            </tr>
          </tbody>
        </table>
      </div>
      ` : ''}

      ${compareCompanies.length ? `
      <div class="section-title">Period comparison</div>
      <p class="text-muted text-small">Companies with more than one reported period in <code>Offisielle nøkkeltall</code> — your share of revenue / profit (NOK) per period.</p>
      <div class="chart-wrap" style="overflow-x:auto">
        <table class="report-table">
          <thead><tr><th>Company</th>${compareHeaderCells()}</tr></thead>
          <tbody>
            ${compareCompanies.map((c) => `
              <tr>
                <td>${escapeHtml(c.company)}</td>
                ${allPeriods().map((p) => {
                  const row = c.rows.find((r) => r.period === p);
                  return `<td class="text-right">${row ? `${fmtNok(row.yourRevNok)}<br><span class="text-small ${pctClass(row.yourProfitNok)}">${fmtNok(row.yourProfitNok)}</span>` : '<span class="text-muted">—</span>'}</td>`;
                }).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      ` : ''}

      ${notes.length ? `
      <div class="section-title">Per-company comments</div>
      <div class="comments">
        ${notes.map((n) => `
          <div class="comment-row">
            <strong>${escapeHtml(n.company)}</strong>
            <span class="text-muted text-small">${escapeHtml(n.period || '')}</span>
            <div class="text-muted">${escapeHtml(n.note)}</div>
          </div>
        `).join('')}
      </div>
      ` : ''}

      <p class="text-muted text-small" style="margin-top:18px">
        Holdings from the latest <code>Beholdningsverdi</code> snapshot. Fundamentals and your-share figures are taken
        verbatim from <code>Offisielle nøkkeltall</code> (no FX or unit math). Not financial advice — an overview tool,
        not a basis for buy/sell decisions.
      </p>
    `;
  }

  // Distinct periods across all compared companies, ordered oldest → newest.
  function allPeriods() {
    const set = new Set();
    for (const c of compareCompanies) for (const r of c.rows) if (r.period) set.add(r.period);
    return Array.from(set).sort((a, b) => periodKey(a) - periodKey(b));
  }
  function compareHeaderCells() {
    return allPeriods().map((p) => `<th class="text-right">${escapeHtml(p)}<br><span class="text-small text-muted">rev / profit</span></th>`).join('');
  }
  function snapNote() {
    const date = holdings.length ? holdings[0].snapshotDate : null;
    return date ? ` · as of ${date}` : '';
  }
  function fmtShares(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    return Math.round(n).toLocaleString('en-US').replace(/,/g, ' ');
  }
})();
