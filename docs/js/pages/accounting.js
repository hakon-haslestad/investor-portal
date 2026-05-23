(async function () {
  const { me } = await window.Nav.bootstrap('accounting');
  const { fmtNok, escapeHtml } = window.Fmt;

  const cfg = window.PORTAL_CONFIG;
  const tabs = cfg.ACCOUNTING_TABS;
  const accountingSheetId = cfg.ACCOUNTING_SHEET_ID;
  const currentYear = cfg.ACCOUNTING_CURRENT_YEAR;
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${accountingSheetId}/edit`;

  const root = document.getElementById('root');
  const metaLine = document.getElementById('meta-line');
  metaLine.textContent = `Geysir Invest AS · konsolidert bookkeeping · current year ${currentYear}`;

  let data;
  try {
    data = await window.Sheet.batchGet(
      [tabs.sbCurrent, tabs.hbCurrent, tabs.dnbRaw, tabs.nordnetRaw, tabs.nordnetRealisasjon],
      { sheetId: accountingSheetId }
    );
  } catch (err) {
    // 403 happens when the signed-in member isn't on the accounting sheet's
    // share list. Render a friendly ask-the-admin message instead of a stack.
    const msg = String(err && err.message || err);
    const looksLikePermission = /\b(403|PERMISSION_DENIED|forbidden|not found)\b/i.test(msg);
    root.innerHTML = `
      <div class="flash error" style="max-width:640px">
        <strong>Can't read the accounting sheet.</strong>
        ${looksLikePermission
          ? `Your Google account (${escapeHtml(window.Auth.getEmail() || '')}) doesn't have access to the accounting sheet. Ask an admin to share it with you, then reload.`
          : `Sheet API error: ${escapeHtml(msg)}`}
        <div style="margin-top:10px"><a href="${sheetUrl}" target="_blank" rel="noopener">Open sheet ↗</a></div>
      </div>
    `;
    return;
  }

  const sb = window.Accounting.parseSaldobalanse(data[tabs.sbCurrent] || []);
  const hb = window.Accounting.parseHovedbok(data[tabs.hbCurrent] || []);
  const dnb = window.Accounting.parseDnbRaw(data[tabs.dnbRaw] || []);
  const nordnet = window.Accounting.parseNordnetRaw(data[tabs.nordnetRaw] || []);
  const realisasjon = window.Accounting.parseNordnetRealisasjon(data[tabs.nordnetRealisasjon] || []);

  const status = window.Accounting.computeStatus({
    sb, hb, dnb, nordnet, realisasjon,
    currentYear,
    wipTabName: tabs.sbCurrent,
  });

  root.innerHTML = `
    ${renderWipBanner(status)}
    ${renderKpiGrid(status)}
    <div class="section-title">Saldobalanse (UB) · ${currentYear}</div>
    ${renderSbTable(sb)}
    <p class="text-muted text-small" style="margin-top:18px;max-width:720px">
      Signed in as <strong>${escapeHtml(me.displayName || '')}${me.investorCode ? ` (${escapeHtml(me.investorCode)})` : ''}</strong>.
      All figures are read-only from the accounting sheet.
      <a href="${sheetUrl}" target="_blank" rel="noopener">Open the full workbook ↗</a> for drilldown
      (hovedbok, bank-avstemming, kontoplan).
    </p>
  `;

  function renderWipBanner(s) {
    if (!s.wipIsStale) return '';
    return `
      <div class="flash error" style="margin-bottom:18px">
        <strong>WIP tab is stale.</strong> The current-year tab is still named
        <code>${escapeHtml(s.wipTabName)}</code>. Open the sheet and rename it to
        <code>${escapeHtml(s.wipExpectedName)}</code> (and the matching HB tab) —
        Google Sheets auto-updates the cross-references. Then update
        <code>ACCOUNTING_TABS</code> in <code>docs/js/config.js</code>.
      </div>
    `;
  }

  function renderKpiGrid(s) {
    const ubClass = Math.abs(s.ubSum) < 1 ? 'positive' : 'negative';
    const ubLabel = Math.abs(s.ubSum) < 1 ? 'balanced' : 'check the books';
    const gevinstClass = s.realisasjonNet >= 0 ? 'positive' : 'negative';
    return `
      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="label">SB net (UB sum)</div>
          <div class="value ${ubClass}">${fmtNok(s.ubSum)}</div>
          <div class="sub">${ubLabel} · expected 0</div>
        </div>
        <div class="kpi-card">
          <div class="label">Bilag in HB</div>
          <div class="value">${s.bilagCount}</div>
          <div class="sub">${currentYear} hovedbok</div>
        </div>
        <div class="kpi-card">
          <div class="label">Latest DNB</div>
          <div class="value" style="font-size:1.15rem">${s.lastDnb || '—'}</div>
          <div class="sub">${s.dnbCount} ${currentYear} txns</div>
        </div>
        <div class="kpi-card">
          <div class="label">Latest Nordnet</div>
          <div class="value" style="font-size:1.15rem">${s.lastNordnet || '—'}</div>
          <div class="sub">${s.nordnetCount} ${currentYear} txns</div>
        </div>
        <div class="kpi-card">
          <div class="label">Realisasjon (skatt)</div>
          <div class="value ${gevinstClass}">${fmtNok(s.realisasjonNet)}</div>
          <div class="sub">${s.realisasjonCount} salg ${currentYear}</div>
        </div>
      </div>
    `;
  }

  function renderSbTable(rows) {
    if (!rows.length) {
      return '<p class="text-muted">Saldobalanse is empty — confirm the sheet&apos;s current-year tab is populated.</p>';
    }
    const withUb = rows.filter((r) => r.ub != null && r.ub !== 0);
    const sorted = withUb.slice().sort((a, b) => Math.abs(b.ub) - Math.abs(a.ub));
    return `
      <table>
        <thead><tr>
          <th>Konto</th>
          <th>Navn</th>
          <th class="text-right">IB</th>
          <th class="text-right">UB</th>
        </tr></thead>
        <tbody>
          ${sorted.map((r) => `
            <tr>
              <td>${r.kontonr}</td>
              <td>${escapeHtml(r.kontonavn)}</td>
              <td class="text-right text-muted">${r.ib != null ? fmtNok(r.ib) : '—'}</td>
              <td class="text-right ${r.ub < 0 ? 'negative' : ''}">${fmtNok(r.ub)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }
})();
