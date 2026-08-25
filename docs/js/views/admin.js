// Admin view — three sub-tabs:
//   ownership   (default) Dim-values attribution editor, ported from
//               pages/admin.js: dirty-tracking, optimistic concurrency via
//               UpdatedAt, write-scope upgrade before saving.
//   securities  Read-only Securities registry (the tab the Apps Script price
//               feed maintains); rows still marked REVIEW are highlighted.
//   feed        Price-feed health: freshness KPIs from store.prices plus the
//               last 50 rows of the _log tab.
// Router gates the whole view to role === 'admin'.

(function () {
  const STYLE_ID = 'admin-view-style';
  // Styles that used to live inline in admin.html.
  const STYLE = `
    .sheet-card {
      background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
      padding: 18px 20px; margin-bottom: 18px; box-shadow: var(--shadow);
    }
    .sheet-card h3 { margin: 0 0 8px; font-size: 1.05rem; }
    .sheet-card .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 10px; }
    .sheet-card .setup-line { color: var(--muted); font-size: 0.88rem; line-height: 1.5; }
    .admin-table { font-size: 0.9rem; }
    .admin-table input { padding: 6px 8px; font-size: 0.9rem; background: var(--bg); }
    .admin-table td { padding: 8px 10px; vertical-align: middle; }
    .admin-table .unmapped { background: rgba(255, 91, 91, 0.07); }
    .badge-unmapped { background: var(--danger); color: white; padding: 2px 8px; border-radius: 999px; font-size: 0.7rem; font-weight: 600; }
    .badge-mapped { background: rgba(62, 224, 127, 0.15); color: var(--positive); padding: 2px 8px; border-radius: 999px; font-size: 0.7rem; font-weight: 600; }
    .investor-chips { display: flex; gap: 4px; flex-wrap: wrap; }
    .investor-chip {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 4px 9px; border-radius: 999px;
      background: var(--panel-2); border: 1px solid var(--border);
      color: var(--muted); font-size: 0.82rem; font-weight: 500;
      cursor: pointer; user-select: none; transition: all 0.12s;
    }
    .investor-chip input { position: absolute; opacity: 0; pointer-events: none; }
    .investor-chip:hover { border-color: var(--accent); color: var(--text); }
    .investor-chip:focus-within { outline: 2px solid var(--link); outline-offset: 2px; }
    .investor-chip.checked { background: var(--accent); color: #051a0a; border-color: var(--accent); }
    .admin-toolbar { display: flex; gap: 12px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
    .admin-toolbar input[type="search"] { max-width: 260px; }
    .admin-toolbar button:disabled { opacity: 0.4; cursor: not-allowed; }
    .admin-table tr.dirty { background: rgba(255, 201, 79, 0.06); }
    .admin-table tr.dirty td:nth-child(2) { border-left: 3px solid var(--accent-2); padding-left: 7px; }
    .admin-table th.sortable { cursor: pointer; user-select: none; white-space: nowrap; }
    .admin-table th.sortable:hover { color: var(--text); }
    .admin-table th .sort-arrow { display: inline-block; width: 10px; margin-left: 4px; color: var(--muted); font-size: 0.75rem; }
    .admin-table th.sorted .sort-arrow { color: var(--accent); }
    .sec-table tr.needs-review td { background: rgba(255, 91, 91, 0.07); }
  `;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  const TABS = (active) => window.UI.subTabs([
    { key: 'ownership', label: 'Ownership', href: '#/admin' },
    { key: 'securities', label: 'Securities', href: '#/admin/securities' },
    { key: 'feed', label: 'Price feed', href: '#/admin/feed' },
  ], active);

  window.Views.admin = async function (el, ctx) {
    ensureStyle();
    const sub = ctx.params[0] || 'ownership';
    if (sub === 'securities') return renderSecurities(el, ctx);
    if (sub === 'feed') return renderFeed(el, ctx);
    return renderOwnership(el, ctx);
  };

  // ─── Sub-tab: Securities registry (read-only) ─────────────────────────────

  function renderSecurities(el, ctx) {
    const { esc, table, emptyState } = window.UI;
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${window.PORTAL_CONFIG.SHEET_ID}`;
    const list = ctx.store.securities || [];
    const reviewCount = list.filter((s) => /review/i.test(s.notes || '')).length;

    const rows = list.map((s) => ({
      attrs: /review/i.test(s.notes || '') ? 'class="needs-review"' : '',
      cells: [
        `<strong>${esc(s.ticker || '—')}</strong>`,
        esc(s.name),
        esc(s.aliases.join('; ')),
        esc(s.isin || '—'),
        esc(s.currency),
        esc(s.exchange || '—'),
        esc(s.source),
        `<span class="tag">${esc(s.status)}</span>`,
        esc(s.soldDate || '—'),
        esc(s.notes || ''),
        `<span class="text-muted text-small">${esc(s.lastChecked || '—')}</span>`,
      ],
    }));

    el.innerHTML = `
      <div class="hero"><h2>Admin ${window.UI.infoIcon('securities-registry')}</h2><div class="when">${list.length} securities${reviewCount ? ` · ${reviewCount} need review` : ''}</div></div>
      ${TABS('securities')}
      <p class="text-muted text-small" style="max-width:720px">
        The security master lives in the <strong>Securities</strong> tab of the sheet —
        it maps every Nordnet name to a ticker, currency and price source, and drives
        which prices the Apps Script feed fetches. Edit it directly in
        <a href="${sheetUrl}" target="_blank" rel="noopener">the sheet ↗</a>;
        <code>status</code> and <code>soldDate</code> are maintained automatically by
        the feed (held → sold → expired 6 months after the sale).
      </p>
      ${list.length
        ? table(
            [
              { label: 'Ticker' }, { label: 'Name' }, { label: 'Aliases' },
              { label: 'ISIN' }, { label: 'Cur' }, { label: 'Exchange' },
              { label: 'Source' }, { label: 'Status' }, { label: 'Sold' }, { label: 'Notes' },
              { label: 'Last checked' },
            ],
            rows,
            { caption: 'Securities registry' },
          )
        : emptyState('No Securities tab yet',
            'Install the Apps Script price feed and run <code>setupTabs()</code> — see <code>apps-script/README.md</code> in the repo.')}
    `;
  }

  // ─── Sub-tab: Price-feed health ───────────────────────────────────────────

  function renderFeed(el, ctx) {
    const { esc, table, kpiGrid, emptyState } = window.UI;
    const prices = ctx.store.prices;

    const tickerRows = [];
    if (prices && prices.hasData) {
      for (const [col, points] of prices.series.entries()) {
        const last = points[points.length - 1];
        tickerRows.push({ col, lastDate: last.d, lastValue: last.v, count: points.length });
      }
      tickerRows.sort((a, b) => a.col.localeCompare(b.col));
    }

    el.innerHTML = `
      <div class="hero"><h2>Admin ${window.UI.infoIcon('feed-health')}</h2><div class="when">price feed</div></div>
      ${TABS('feed')}
      ${prices && prices.hasData ? kpiGrid([
        { label: 'Latest price date', value: esc(prices.latestDate || '—'), info: 'price-freshness' },
        { label: 'Columns with data', value: String(prices.series.size), sub: 'tickers + FX', info: 'feed-health' },
        { label: 'Price rows', value: String(prices.dates.length), sub: 'days in StockPrices' },
      ]) : emptyState('No price data yet',
        'The StockPrices tab is empty or missing. Install the Apps Script feed and run <code>backfill()</code> — see <code>apps-script/README.md</code>.')}
      ${tickerRows.length ? `
        <h3 class="section-title">Per-column freshness</h3>
        ${table(
          [{ label: 'Column' }, { label: 'Last value', className: 'text-right' }, { label: 'Last date' }, { label: 'Points', className: 'text-right' }],
          tickerRows.map((r) => ({ cells: [
            `<strong>${esc(r.col)}</strong>`,
            String(r.lastValue),
            esc(r.lastDate),
            String(r.count),
          ] })),
          { caption: 'Per-ticker price freshness' },
        )}` : ''}
      <h3 class="section-title">Feed log</h3>
      <div id="feed-log"><p class="text-muted">Loading log…</p></div>
    `;

    const mount = el.querySelector('#feed-log');
    (async () => {
      let rows = null;
      try {
        rows = await window.Sheet.getValues(window.PORTAL_CONFIG.TABS.priceLog);
      } catch (_e) {
        mount.innerHTML = emptyState('No _log tab',
          'The Apps Script feed isn\'t installed yet (it creates <code>_log</code> on first run). See <code>apps-script/README.md</code>.');
        return;
      }
      const entries = (rows || []).slice(1)
        .filter((r) => r && r.length)
        .slice(-50)
        .reverse();
      if (!entries.length) {
        mount.innerHTML = '<p class="text-muted">Log is empty — no errors reported. 🎉</p>';
        return;
      }
      mount.innerHTML = table(
        [{ label: 'Timestamp' }, { label: 'Context' }, { label: 'Ticker' }, { label: 'Message' }],
        entries.map((r) => ({ cells: [
          esc(String(r[0] || '')), esc(String(r[1] || '')), esc(String(r[2] || '')), esc(String(r[3] || '')),
        ] })),
        { caption: 'Price feed log (newest first)', empty: 'Log is empty.' },
      );
    })();
  }

  // ─── Sub-tab: Ownership (Dim-values editor) ───────────────────────────────

  async function renderOwnership(el, ctx) {
    const { store, me } = ctx;
    const { escapeHtml } = window.Fmt;
    const MEMBER_OPTIONS = window.Ledger.INVESTOR_CODES;

    el.innerHTML = `
      <div class="hero">
        <h2>Admin ${window.UI.infoIcon('ownership')}</h2>
        <div class="when" id="meta-line"></div>
      </div>
      ${TABS('ownership')}
      <div id="sheet-card"></div>
      <p class="text-muted text-small" style="max-width: 720px">
        Each security gets mapped to one or more investors. Use the Member field with the same syntax as the sheet:
        <code>HH</code>, <code>HS/ØS</code>, <code>HH/HF/HS</code>, etc. Leave Factor blank to auto-split evenly.
        Edits write back to the <strong>Dim-values</strong> tab in the Google Sheet.
      </p>
      <div class="admin-toolbar">
        <input type="search" id="filter" placeholder="Filter by name / investor…" aria-label="Filter securities" />
        <label class="text-small text-muted" style="text-transform:none">
          <input type="checkbox" id="only-unmapped" style="width:auto;margin-right:6px" /> only unmapped
        </label>
        <span style="flex:1"></span>
        <button type="button" class="btn" id="save-all" disabled>Save changes</button>
        <button type="button" class="btn ghost" id="discard-all" disabled>Discard</button>
      </div>
      <div id="status" role="status" aria-live="polite"></div>
      <div id="admin-root">Loading…</div>
    `;
    const root = el.querySelector('#admin-root');
    const metaLine = el.querySelector('#meta-line');
    const statusEl = el.querySelector('#status');

    // Admin needs read+write Sheets access — consent prompt on first visit,
    // silent once the broader scope is cached.
    try { await window.Auth.requestWriteAccess(); }
    catch (e) {
      root.innerHTML =
        `<div class="flash error">Admin needs write access to the sheet. ${escapeHtml(e.message || String(e))} · <a href="#/admin" onclick="location.reload()">Try again</a></div>`;
      return;
    }

    // Fresh Dim-values index so we have UpdatedAt for the soft-guard.
    let dimIndex = await window.DimValues.readIndex();
    let securities = buildSecuritiesList(store, dimIndex.map);

    const dirty = new Map(); // security → { memberString, factor, expectedUpdatedAt }
    let sortBy = { column: 'security', direction: 'asc' };

    renderSheetCard();

    const filter = el.querySelector('#filter');
    const onlyUnmapped = el.querySelector('#only-unmapped');
    const saveAllBtn = el.querySelector('#save-all');
    const discardAllBtn = el.querySelector('#discard-all');
    filter.addEventListener('input', render);
    onlyUnmapped.addEventListener('change', render);
    saveAllBtn.addEventListener('click', saveAll);
    discardAllBtn.addEventListener('click', () => { dirty.clear(); render(); });

    render();

    // ── Build the displayed list ────────────────────────────────────────────
    function buildSecuritiesList(store, dimMap) {
      const txCounts = new Map();
      for (const t of store.transactions) {
        if (!t.security) continue;
        txCounts.set(t.security, (txCounts.get(t.security) || 0) + 1);
      }

      // Current qty from the transaction replay (works with or without the
      // price matrix; the old page read the manual snapshot instead).
      const currentQty = new Map();
      for (const h of window.Positions.holdingsAt(store)) {
        currentQty.set(h.security, h.qty);
      }

      const all = new Set();
      for (const k of txCounts.keys()) all.add(k);
      for (const k of currentQty.keys()) all.add(k);
      for (const k of dimMap.keys()) all.add(k);

      return Array.from(all).map((security) => {
        const dim = dimMap.get(security);
        const canonical = window.Portfolio.canonicalName(security);
        return {
          security,
          type: dim ? (dim.type || 'Stock') : 'Stock',
          categoryTick: dim ? dim.categoryTick : '',
          memberString: dim ? dim.member : '',
          factor: dim ? dim.factor : null,
          isin: dim ? dim.isin : null,
          txCount: txCounts.get(security) || 0,
          currentQty: currentQty.get(security) || currentQty.get(canonical) || 0,
          updatedAt: dim ? dim.updatedAt : '',
          updatedBy: dim ? dim.updatedBy : '',
          mapped: Boolean(dim && dim.member),
        };
      });
    }

    // ── Sheet card ──────────────────────────────────────────────────────────
    function renderSheetCard() {
      const mount = el.querySelector('#sheet-card');
      const sheetUrl = `https://docs.google.com/spreadsheets/d/${window.PORTAL_CONFIG.SHEET_ID}/edit`;
      mount.innerHTML = `
        <div class="sheet-card">
          <h3>Live from Google Sheets</h3>
          <div class="setup-line">
            Signed in as <strong>${escapeHtml(me.displayName)} (${me.investorCode})</strong> · ${escapeHtml(window.Auth.getEmail() || '')}.
            Edits in this tab write straight into the <strong>Dim-values</strong> tab.
          </div>
          <div class="row">
            <a href="${sheetUrl}" target="_blank" rel="noopener" class="btn ghost">Open sheet ↗</a>
            <button type="button" class="btn ghost" id="reload-data">Reload from sheet</button>
          </div>
        </div>
      `;
      mount.querySelector('#reload-data').addEventListener('click', reloadAll);
    }

    async function reloadAll() {
      flash('info', 'Reloading from Google…');
      const fresh = await window.Store.refresh();
      Object.assign(store, fresh);
      dimIndex = await window.DimValues.readIndex();
      securities = buildSecuritiesList(store, dimIndex.map);
      dirty.clear();
      render();
      flash('success', 'Reloaded.');
    }

    // ── Main table render ───────────────────────────────────────────────────
    function visibleRows() {
      const f = filter.value.trim().toLowerCase();
      const filtered = securities.filter((s) => {
        if (onlyUnmapped.checked && s.mapped) return false;
        if (!f) return true;
        return (
          s.security.toLowerCase().includes(f)
          || (s.memberString || '').toLowerCase().includes(f)
          || (s.categoryTick || '').toLowerCase().includes(f)
          || (s.type || '').toLowerCase().includes(f)
        );
      });
      return filtered.sort(compareRows);
    }

    function compareRows(a, b) {
      const dir = sortBy.direction === 'asc' ? 1 : -1;
      const av = sortValue(a); const bv = sortValue(b);
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return a.security.localeCompare(b.security, 'nb');
    }

    function sortValue(s) {
      switch (sortBy.column) {
        case 'mapped': return s.mapped ? 1 : 0;
        case 'security': return (s.security || '').toLowerCase();
        case 'memberString': return (s.memberString || '').toLowerCase();
        case 'factor': return s.factor == null ? -Infinity : Number(s.factor);
        case 'currentQty': return s.currentQty == null ? -Infinity : Number(s.currentQty);
        default: return 0;
      }
    }

    function sortArrow(column) {
      if (sortBy.column !== column) return '<span class="sort-arrow">↕</span>';
      return `<span class="sort-arrow">${sortBy.direction === 'asc' ? '▲' : '▼'}</span>`;
    }

    function thClass(column) {
      return 'sortable' + (sortBy.column === column ? ' sorted' : '');
    }

    function render() {
      const rows = visibleRows();
      const totalUnmapped = securities.filter((s) => !s.mapped).length;
      metaLine.textContent = `${securities.length} securities · ${totalUnmapped} unmapped`;
      if (!rows.length) {
        root.innerHTML = '<p class="text-muted">Nothing matches. Try a different filter.</p>';
        return;
      }
      root.innerHTML = `
        <div class="table-scroll"><table class="admin-table">
          <thead><tr>
            <th scope="col" class="${thClass('mapped')}" data-sort="mapped">Status${sortArrow('mapped')}</th>
            <th scope="col" class="${thClass('security')}" data-sort="security">Stock${sortArrow('security')}</th>
            <th scope="col" class="${thClass('memberString')}" data-sort="memberString">Investors${sortArrow('memberString')}</th>
            <th scope="col" class="${thClass('factor')}" data-sort="factor">Factor${sortArrow('factor')}</th>
            <th scope="col" class="${thClass('currentQty')} text-right text-small" data-sort="currentQty">Qty now${sortArrow('currentQty')}</th>
          </tr></thead>
          <tbody>
            ${rows.map(renderRow).join('')}
          </tbody>
        </table></div>
      `;
      root.querySelectorAll('th.sortable').forEach((th) => {
        th.addEventListener('click', () => {
          const col = th.dataset.sort;
          if (sortBy.column === col) sortBy.direction = sortBy.direction === 'asc' ? 'desc' : 'asc';
          else sortBy = { column: col, direction: 'asc' };
          render();
        });
      });
      root.querySelectorAll('tr[data-sec]').forEach((tr) => {
        const sec = tr.dataset.sec;
        tr.querySelectorAll('.investor-chip input').forEach((cb) => {
          cb.addEventListener('change', () => {
            cb.closest('.investor-chip').classList.toggle('checked', cb.checked);
            autoFillFactor(tr);
            markDirty(tr, sec);
          });
        });
        tr.querySelector('[name=factor]').addEventListener('input', () => markDirty(tr, sec));
      });
      updateSaveAllButton();
    }

    function renderRow(s) {
      // Pending (unsaved / failed / conflicted) edits overlay the sheet
      // state so a re-render never wipes what the user typed.
      const pending = dirty.get(s.security);
      const memberString = pending ? pending.memberString : s.memberString;
      const factor = pending ? pending.factor : s.factor;
      const selected = new Set(parseMembers(memberString));
      return `
        <tr data-sec="${escapeHtml(s.security)}" class="${s.mapped ? '' : 'unmapped'}${pending ? ' dirty' : ''}">
          <td>${s.mapped ? '<span class="badge-mapped">mapped</span>' : '<span class="badge-unmapped">unmapped</span>'}</td>
          <td><strong>${escapeHtml(s.security)}</strong></td>
          <td>
            <div class="investor-chips">
              ${MEMBER_OPTIONS.map((m) => `
                <label class="investor-chip ${selected.has(m) ? 'checked' : ''}">
                  <input type="checkbox" value="${m}" ${selected.has(m) ? 'checked' : ''} /> ${m}
                </label>
              `).join('')}
            </div>
          </td>
          <td><input name="factor" value="${factor != null ? factor : ''}" placeholder="auto" aria-label="Investment factor for ${escapeHtml(s.security)}" style="width:70px" /></td>
          <td class="text-right text-small text-muted">${s.currentQty ? Number(s.currentQty).toFixed(0) : '—'}</td>
        </tr>
      `;
    }

    function parseMembers(str) {
      if (!str) return [];
      return String(str).split(/[\/+,]/).map((s) => s.trim()).filter(Boolean);
    }

    function selectedMembersFromRow(tr) {
      return Array.from(tr.querySelectorAll('.investor-chip input:checked')).map((cb) => cb.value);
    }

    function autoFillFactor(tr) {
      const sel = selectedMembersFromRow(tr);
      const factorEl = tr.querySelector('[name=factor]');
      if (!factorEl) return;
      factorEl.value = sel.length ? formatFactor(1 / sel.length) : '';
      factorEl.placeholder = sel.length ? formatFactor(1 / sel.length) : 'auto';
    }

    function formatFactor(n) {
      return Number(n).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    }

    function markDirty(tr, sec) {
      const memberString = selectedMembersFromRow(tr).join('/');
      const factor = tr.querySelector('[name=factor]').value.trim() || null;
      const expectedUpdatedAt = (dimIndex.map.get(sec) || {}).updatedAt || '';
      dirty.set(sec, { memberString, factor, expectedUpdatedAt });
      tr.classList.add('dirty');
      updateSaveAllButton();
    }

    function updateSaveAllButton() {
      const n = dirty.size;
      saveAllBtn.disabled = n === 0;
      discardAllBtn.disabled = n === 0;
      saveAllBtn.textContent = n === 0 ? 'Save changes' : `Save changes (${n})`;
    }

    async function saveAll() {
      if (!dirty.size) return;
      const total = dirty.size;
      let ok = 0; const conflicts = []; const failed = [];
      saveAllBtn.disabled = true;
      saveAllBtn.textContent = `Saving 0/${total}…`;
      for (const [security, payload] of dirty.entries()) {
        if (!payload.memberString) {
          failed.push(`${security}: no investors selected`);
          continue;
        }
        try {
          const res = await window.DimValues.upsert({
            security,
            member: payload.memberString,
            factor: payload.factor,
            signedInEmail: window.Auth.getEmail(),
            expectedUpdatedAt: payload.expectedUpdatedAt || null,
          });
          if (res.action === 'conflict') conflicts.push({ security, other: res.existing.updatedBy, at: res.existing.updatedAt });
          else { ok += 1; dirty.delete(security); }
        } catch (err) {
          failed.push(`${security}: ${err.message}`);
        }
        saveAllBtn.textContent = `Saving ${ok}/${total}…`;
      }

      // Only successfully saved rows leave the dirty set — failed and
      // conflicted edits stay pending so the user's input isn't wiped.
      dimIndex = await window.DimValues.readIndex();
      securities = buildSecuritiesList(store, dimIndex.map);
      render();

      if (conflicts.length) {
        const lines = conflicts.map((c) => `${escapeHtml(c.security)} — last edited by ${escapeHtml(c.other || 'someone')} at ${escapeHtml(c.at)}`).join('<br>');
        flash('error', `⚠ ${conflicts.length} conflict(s) — values not saved. Reload and try again:<br>${lines}`);
      } else if (failed.length) {
        flash('error', `Saved ${ok}/${total}. Failed: ${escapeHtml(failed.join(' · '))}`);
      } else {
        flash('success', `✅ Saved ${ok} mapping${ok === 1 ? '' : 's'} to Dim-values.`);
      }
    }

    function flash(kind, msg) {
      statusEl.innerHTML = `<div class="flash ${kind === 'success' ? 'success' : kind === 'error' ? 'error' : ''}">${msg}</div>`;
    }
  }
})();
