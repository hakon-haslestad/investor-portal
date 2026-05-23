(async function () {
  const { me } = await window.Nav.bootstrap('accounting');
  const { fmtNok, escapeHtml } = window.Fmt;
  const A = window.Accounting;

  const cfg = window.PORTAL_CONFIG;
  const accountingSheetId = cfg.ACCOUNTING_SHEET_ID;
  const fallbackYear = cfg.ACCOUNTING_CURRENT_YEAR;
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${accountingSheetId}/edit`;

  const root = document.getElementById('root');
  const pickerMount = document.getElementById('year-picker-mount');
  const metaLine = document.getElementById('meta-line');

  // ─── Initial load: cross-year tabs + tab listing for discovery ──────────
  let crossYear, tabs;
  try {
    [crossYear, tabs] = await Promise.all([
      window.Sheet.batchGet(
        [cfg.ACCOUNTING_TABS.dnbRaw, cfg.ACCOUNTING_TABS.nordnetRaw],
        { sheetId: accountingSheetId },
      ),
      window.Sheet.listTabs({ sheetId: accountingSheetId }),
    ]);
  } catch (err) {
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

  const dnb = A.parseDnbRaw(crossYear[cfg.ACCOUNTING_TABS.dnbRaw] || []);
  const nordnetRaw = A.parseNordnetRaw(crossYear[cfg.ACCOUNTING_TABS.nordnetRaw] || []);

  const years = A.discoverYears(tabs);
  if (!years.length) {
    root.innerHTML = `
      <div class="flash error" style="max-width:640px">
        <strong>No year tabs found.</strong> The accounting sheet needs at least
        one matched set of tabs named like <code>SB, 25</code> / <code>HB, 25</code>
        (and optionally <code>Nordnet 25</code>) before this page can show anything.
        <div style="margin-top:10px"><a href="${sheetUrl}" target="_blank" rel="noopener">Open sheet ↗</a></div>
      </div>
    `;
    return;
  }

  // ─── Year selection (persisted) ─────────────────────────────────────────
  const STORAGE_KEY = 'portal.accounting.year';
  const stored = Number(localStorage.getItem(STORAGE_KEY));
  let selectedYear = years.find((y) => y.year === stored) ? stored
    : (years.find((y) => y.year === fallbackYear) ? fallbackYear : years[0].year);

  metaLine.textContent = `${years.length} year${years.length === 1 ? '' : 's'} available · signed in as ${me.displayName || ''}${me.investorCode ? ` (${me.investorCode})` : ''}`;

  // Year picker — reuses .range-picker .preset styling from data.html
  pickerMount.innerHTML = `
    <div class="range-picker" id="year-picker">
      ${years.map((y) => `
        <button class="preset ${y.year === selectedYear ? 'active' : ''}" data-year="${y.year}">${y.year}</button>
      `).join('')}
      <span class="sep">·</span>
      <button class="preset" id="reload-btn" title="Refetch from Google Sheets">↻ Reload</button>
    </div>
  `;
  pickerMount.querySelectorAll('button[data-year]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const y = Number(btn.dataset.year);
      if (y === selectedYear) return;
      selectedYear = y;
      localStorage.setItem(STORAGE_KEY, String(y));
      pickerMount.querySelectorAll('button[data-year]').forEach((b) => {
        b.classList.toggle('active', Number(b.dataset.year) === y);
      });
      loadYear(y);
    });
  });
  document.getElementById('reload-btn').addEventListener('click', () => {
    yearCache.clear();
    loadYear(selectedYear);
  });

  // ─── Per-year fetch + cache ─────────────────────────────────────────────
  const yearCache = new Map(); // year -> { entry, sb, hb, nordnet }

  async function loadYear(year) {
    const entry = years.find((y) => y.year === year);
    if (!entry) return;
    root.innerHTML = '<p class="text-muted">Loading…</p>';
    let bundle = yearCache.get(year);
    if (!bundle) {
      const wanted = [entry.sb, entry.hb];
      if (entry.nordnet) wanted.push(entry.nordnet);
      let data;
      try {
        data = await window.Sheet.batchGet(wanted, { sheetId: accountingSheetId });
      } catch (err) {
        root.innerHTML = `<div class="flash error">Couldn't load ${year}: ${escapeHtml(err.message || err)}</div>`;
        return;
      }
      bundle = {
        entry,
        sb: A.parseSaldobalanse(data[entry.sb] || []),
        hb: A.parseHovedbok(data[entry.hb] || []),
        nordnet: entry.nordnet ? A.parseNordnetYear(data[entry.nordnet] || []) : [],
      };
      yearCache.set(year, bundle);
    }
    renderYear(bundle);
  }

  // ─── Render ─────────────────────────────────────────────────────────────
  // HB sort + filter state — survives within the page session, resets on
  // year change since the underlying data changes shape.
  let hbSort = { column: 'date', direction: 'asc' };
  let hbFilter = '';

  function renderYear({ entry, sb, hb, nordnet }) {
    // Realisasjon for the year = sum of 'Realisert gevinst/tap' across stocks
    // in the per-year Nordnet tab. Same number as the (now-removed)
    // Nordnet_realisasjon tab would have totaled.
    const realisertSum = (nordnet || []).reduce((acc, r) => acc + (r.realisert || 0), 0);
    const realisertStocks = (nordnet || []).filter((r) => r.realisert).length;
    const status = A.computeStatus({
      sb, hb, dnb, nordnet: nordnetRaw, realisasjon: [],
      currentYear: entry.year,
      wipTabName: entry.sb,
    });
    status.realisasjonNet = realisertSum;
    status.realisasjonCount = realisertStocks;
    hbSort = { column: 'date', direction: 'asc' };
    hbFilter = '';

    root.innerHTML = `
      ${renderWipBanner(status)}
      ${renderKpiGrid(status, entry, nordnet)}
      ${renderSbSection(sb, entry.year)}
      ${renderHbSection(hb, entry.year)}
      ${renderNordnetSection(nordnet, entry.year)}
      <p class="text-muted text-small" style="margin-top:18px;max-width:720px">
        Source: <code>${escapeHtml(entry.sb)}</code> / <code>${escapeHtml(entry.hb)}</code>${entry.nordnet ? ` / <code>${escapeHtml(entry.nordnet)}</code>` : ''} in the
        <a href="${sheetUrl}" target="_blank" rel="noopener">accounting sheet ↗</a>.
        Read-only — edits stay in Google Sheets.
      </p>
    `;
    bindSectionHandlers(sb, hb, nordnet, entry.year);
  }

  function renderWipBanner(s) {
    if (!s.wipIsStale) return '';
    return `
      <div class="flash error" style="margin-bottom:18px">
        <strong>WIP tab name is stale.</strong> The current-year tab is still
        <code>${escapeHtml(s.wipTabName)}</code>. Open the sheet and rename it to
        <code>${escapeHtml(s.wipExpectedName)}</code> (and the matching HB tab) —
        Google Sheets auto-updates the cross-references, and this page picks up
        the new name on next reload.
      </div>
    `;
  }

  function renderKpiGrid(s, entry, nordnetStocks) {
    const ubClass = Math.abs(s.ubSum) < 1 ? 'positive' : 'negative';
    const ubLabel = Math.abs(s.ubSum) < 1 ? 'balanced' : 'check the books';
    const gevinstClass = s.realisasjonNet >= 0 ? 'positive' : 'negative';
    return `
      <div class="kpi-grid" style="margin-bottom:18px">
        <div class="kpi-card">
          <div class="label">SB net (UB sum)</div>
          <div class="value ${ubClass}">${fmtNok(s.ubSum)}</div>
          <div class="sub">${ubLabel} · expected 0</div>
        </div>
        <div class="kpi-card">
          <div class="label">Bilag in HB</div>
          <div class="value">${s.bilagCount}</div>
          <div class="sub">${entry.year} hovedbok</div>
        </div>
        <div class="kpi-card">
          <div class="label">Aksjer tracked</div>
          <div class="value">${(nordnetStocks || []).length}</div>
          <div class="sub">in Nordnet ${entry.year}</div>
        </div>
        <div class="kpi-card">
          <div class="label">Latest DNB</div>
          <div class="value" style="font-size:1.15rem">${s.lastDnb || '—'}</div>
          <div class="sub">${s.dnbCount} ${entry.year} txns</div>
        </div>
        <div class="kpi-card">
          <div class="label">Realisasjon (skatt)</div>
          <div class="value ${gevinstClass}">${fmtNok(s.realisasjonNet)}</div>
          <div class="sub">${s.realisasjonCount} aksjer m/ salg ${entry.year}</div>
        </div>
      </div>
    `;
  }

  // ─── Saldobalanse ───────────────────────────────────────────────────────
  function renderSbSection(rows, year) {
    return `
      <div class="section-title" style="display:flex;align-items:baseline;gap:12px">
        <span>Saldobalanse · ${year}</span>
        <button class="btn ghost small" data-csv="sb">↓ CSV</button>
      </div>
      ${rows.length ? renderSbTable(rows) : '<p class="text-muted">No saldobalanse data for this year.</p>'}
    `;
  }

  function renderSbTable(rows) {
    const withUb = rows.filter((r) => r.ub != null && r.ub !== 0);
    const sorted = withUb.slice().sort((a, b) => Math.abs(b.ub) - Math.abs(a.ub));
    return `
      <div class="data-table-wrap"><table class="data-table">
        <thead><tr>
          <th>Konto</th>
          <th>Navn</th>
          <th class="num">IB</th>
          <th class="num">UB</th>
        </tr></thead>
        <tbody>
          ${sorted.map((r) => `
            <tr>
              <td>${r.kontonr}</td>
              <td>${escapeHtml(r.kontonavn)}</td>
              <td class="num text-muted">${r.ib != null ? fmtNok(r.ib) : '—'}</td>
              <td class="num ${r.ub < 0 ? 'negative' : ''}">${fmtNok(r.ub)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table></div>
    `;
  }

  // ─── Hovedbok ───────────────────────────────────────────────────────────
  function renderHbSection(rows, year) {
    return `
      <div class="section-title" style="display:flex;align-items:baseline;gap:12px;margin-top:24px">
        <span>Hovedbok · ${year}</span>
        <button class="btn ghost small" data-csv="hb">↓ CSV</button>
        <span class="grow" style="flex:1"></span>
        <input type="search" id="hb-filter" placeholder="Filter bilag / konto / kommentar…" style="max-width:280px" />
      </div>
      <div id="hb-table-mount">${renderHbTable(rows)}</div>
    `;
  }

  function visibleHbRows(rows) {
    const f = hbFilter.trim().toLowerCase();
    const filtered = !f ? rows : rows.filter((r) => {
      return (r.bilagsnr || '').toLowerCase().includes(f)
        || String(r.kontonr || '').includes(f)
        || (r.kontonavn || '').toLowerCase().includes(f)
        || (r.kommentar || '').toLowerCase().includes(f);
    });
    const dir = hbSort.direction === 'asc' ? 1 : -1;
    const key = hbSort.column;
    return filtered.slice().sort((a, b) => {
      const av = a[key], bv = b[key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return 0;
    });
  }

  function sortArrow(col) {
    if (hbSort.column !== col) return '<span class="sort-arrow">↕</span>';
    return `<span class="sort-arrow">${hbSort.direction === 'asc' ? '▲' : '▼'}</span>`;
  }
  const thClass = (col, num) => `sortable ${num ? 'num' : ''} ${hbSort.column === col ? 'sorted' : ''}`;

  function renderHbTable(rows) {
    const visible = visibleHbRows(rows);
    if (!visible.length) return '<p class="text-muted">No hovedbok rows match.</p>';
    return `
      <div class="data-table-wrap"><table class="data-table fit">
        <thead><tr>
          <th class="${thClass('bilagsnr')}" data-sort="bilagsnr">Bilag${sortArrow('bilagsnr')}</th>
          <th class="${thClass('date')}" data-sort="date">Dato${sortArrow('date')}</th>
          <th class="${thClass('kontonr', true)}" data-sort="kontonr">Konto${sortArrow('kontonr')}</th>
          <th class="wrap">Navn</th>
          <th class="wrap">Kommentar</th>
          <th class="${thClass('debet', true)}" data-sort="debet">Debet${sortArrow('debet')}</th>
          <th class="${thClass('kredit', true)}" data-sort="kredit">Kredit${sortArrow('kredit')}</th>
        </tr></thead>
        <tbody>
          ${visible.map((r) => `
            <tr>
              <td>${escapeHtml(r.bilagsnr)}</td>
              <td>${r.date || ''}</td>
              <td class="num">${r.kontonr != null ? r.kontonr : ''}</td>
              <td class="wrap">${escapeHtml(r.kontonavn || '')}</td>
              <td class="wrap">${escapeHtml(r.kommentar || '')}</td>
              <td class="num">${r.debet != null ? fmtNok(r.debet) : ''}</td>
              <td class="num">${r.kredit != null ? fmtNok(r.kredit) : ''}</td>
            </tr>
          `).join('')}
        </tbody>
      </table></div>
    `;
  }

  // ─── Nordnet per-stock ──────────────────────────────────────────────────
  function renderNordnetSection(rows, year) {
    return `
      <div class="section-title" style="display:flex;align-items:baseline;gap:12px;margin-top:24px">
        <span>Nordnet aksjer · ${year}</span>
        <button class="btn ghost small" data-csv="nordnet"${rows.length ? '' : ' disabled'}>↓ CSV</button>
      </div>
      ${rows.length ? renderNordnetTable(rows)
        : '<p class="text-muted">No per-stock data for this year (no <code>Nordnet ' + String(year).slice(-2) + '</code> tab found).</p>'}
    `;
  }

  function renderNordnetTable(rows) {
    const sorted = rows.slice().sort((a, b) => (b.markedsverdi || 0) - (a.markedsverdi || 0));
    return `
      <div class="data-table-wrap"><table class="data-table">
        <thead><tr>
          <th>Verdipapir</th>
          <th class="num">Kostpris</th>
          <th class="num">Markedsverdi</th>
          <th class="num">Urealisert</th>
          <th class="num">Realisert</th>
          <th class="num">Utbytte</th>
        </tr></thead>
        <tbody>
          ${sorted.map((r) => `
            <tr>
              <td><strong>${escapeHtml(r.security)}</strong></td>
              <td class="num text-muted">${r.kostpris != null ? fmtNok(r.kostpris) : '—'}</td>
              <td class="num">${r.markedsverdi != null ? fmtNok(r.markedsverdi) : '—'}</td>
              <td class="num ${r.urealisert > 0 ? 'positive' : (r.urealisert < 0 ? 'negative' : '')}">${r.urealisert != null ? fmtNok(r.urealisert) : '—'}</td>
              <td class="num ${r.realisert > 0 ? 'positive' : (r.realisert < 0 ? 'negative' : '')}">${r.realisert != null ? fmtNok(r.realisert) : '—'}</td>
              <td class="num">${r.utbytte != null ? fmtNok(r.utbytte) : '—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table></div>
    `;
  }

  // ─── Event wiring per year render ───────────────────────────────────────
  function bindSectionHandlers(sb, hb, nordnet, year) {
    const yy = String(year);
    root.querySelectorAll('button[data-csv]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const kind = btn.dataset.csv;
        if (kind === 'sb') {
          A.downloadCsv(`geysir-saldobalanse-${yy}.csv`, [
            ['Kontonr', 'Kontonavn', 'IB', 'UB'],
            ...sb.map((r) => [r.kontonr, r.kontonavn, r.ib, r.ub]),
          ]);
        } else if (kind === 'hb') {
          A.downloadCsv(`geysir-hovedbok-${yy}.csv`, [
            ['Bilagsnr', 'Bilagsdato', 'Kontonr', 'Kontonavn', 'Kommentar', 'Debet', 'Kredit'],
            ...hb.map((r) => [r.bilagsnr, r.date, r.kontonr, r.kontonavn, r.kommentar, r.debet, r.kredit]),
          ]);
        } else if (kind === 'nordnet') {
          A.downloadCsv(`geysir-nordnet-aksjer-${yy}.csv`, [
            ['Verdipapir', 'Kostpris', 'Markedsverdi', 'Urealisert', 'Realisert', 'Utbytte'],
            ...nordnet.map((r) => [r.security, r.kostpris, r.markedsverdi, r.urealisert, r.realisert, r.utbytte]),
          ]);
        }
      });
    });

    const filterEl = document.getElementById('hb-filter');
    if (filterEl) {
      filterEl.value = hbFilter;
      filterEl.addEventListener('input', () => {
        hbFilter = filterEl.value;
        document.getElementById('hb-table-mount').innerHTML = renderHbTable(hb);
        bindHbHeaders(hb);
      });
    }
    bindHbHeaders(hb);
  }

  function bindHbHeaders(hb) {
    root.querySelectorAll('#hb-table-mount th.sortable').forEach((th) => {
      th.addEventListener('click', () => {
        const col = th.dataset.sort;
        if (hbSort.column === col) hbSort.direction = hbSort.direction === 'asc' ? 'desc' : 'asc';
        else hbSort = { column: col, direction: 'asc' };
        document.getElementById('hb-table-mount').innerHTML = renderHbTable(hb);
        bindHbHeaders(hb);
      });
    });
  }

  loadYear(selectedYear);
})();
