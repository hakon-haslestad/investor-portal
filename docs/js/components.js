// Shared UI building blocks for the SPA views. Small, string-template based
// — same idiom as the rest of the codebase, just centralized so every view
// renders KPIs, tables, tabs and empty states the same way.

(function () {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // ── KPI tiles ─────────────────────────────────────────────────────────────
  // items: [{label, value, sub?, tone?: 'positive'|'negative'|'', info?: MetricsInfo key}]
  function kpiGrid(items) {
    return `<div class="kpi-grid">${items.map((k) => `
      <div class="kpi-card">
        <div class="label">${esc(k.label)}${k.info ? ' ' + infoIcon(k.info) : ''}</div>
        <div class="value ${k.tone || ''}">${k.value}</div>
        ${k.sub ? `<div class="sub">${k.sub}</div>` : ''}
      </div>`).join('')}</div>`;
  }

  // ── Section heading ───────────────────────────────────────────────────────
  // opts: string (extra HTML, legacy) or {extra?, info?: MetricsInfo key}
  function section(title, opts) {
    const o = typeof opts === 'string' ? { extra: opts } : (opts || {});
    return `<div class="section-head"><h3 class="section-title">${esc(title)}${o.info ? ' ' + infoIcon(o.info) : ''}</h3>${o.extra || ''}</div>`;
  }

  // ── Table ────────────────────────────────────────────────────────────────
  // The one table primitive. Every table in the app goes through here.
  //
  // cols: [{label, className?, p?}]  rows: arrays of HTML strings, or
  //       {cells, attrs?, after?} where `after` is extra markup (or a
  //       fn(colspan)) inserted as a sibling row — used by the views that
  //       expand a row into a chart.
  //
  // `p` is the column's PRIORITY, which is how tables fit a phone:
  //   1 (default) always visible — identity plus the number that matters
  //   2           from 600px up  — the normal desktop reading set
  //   3           from 960px up  — completeness / audit columns
  // Columns are hidden by CSS on [data-p], never removed from the DOM, so the
  // expander below can recover them without the view re-rendering anything.
  function table(cols, rows, opts = {}) {
    const pri = (c) => Number(c.p) || 1;
    const maxP = cols.reduce((m, c) => Math.max(m, pri(c)), 1);
    // Nothing to reveal means no chevron column at all.
    const expandable = opts.expandable !== false && maxP > 1 && rows.length > 0;
    const span = cols.length + (expandable ? 1 : 0);

    const expandTh = expandable
      ? '<th class="col-expand" scope="col"><span class="sr-only">Show hidden columns</span></th>' : '';
    // c.thAttrs / c.thExtra let sortable tables put their own attributes and
    // sort arrows in the header without abandoning the primitive.
    const head = expandTh + cols.map((c) =>
      `<th class="${c.className || ''}${c.thClass ? ' ' + c.thClass : ''}" data-p="${pri(c)}" scope="col" ${c.thAttrs || ''}>${esc(c.label)}${c.thExtra || ''}</th>`).join('');

    const body = rows.length
      ? rows.map((r) => {
          const attrs = r.attrs || '';
          // Grouping rows (year headers and the like) pass expand:false —
          // they keep the chevron column's width but get no button or panel.
          const rowExpand = expandable && r.expand !== false;
          const expandTd = expandable
            ? (rowExpand
              ? '<td class="col-expand"><button type="button" class="row-expand" aria-expanded="false" aria-label="Show hidden columns"></button></td>'
              : '<td class="col-expand"></td>') : '';
          const cells = (r.cells || r).map((cell, i) => {
            const c = cols[i] || {};
            return `<td class="${c.className || ''}" data-p="${pri(c)}" data-label="${esc(c.label || '')}">${cell}</td>`;
          }).join('');
          const detail = rowExpand
            ? `<tr class="row-detail" hidden><td colspan="${span}"></td></tr>` : '';
          const after = typeof r.after === 'function' ? r.after(span) : (r.after || '');
          return `<tr ${attrs}>${expandTd}${cells}</tr>${detail}${after}`;
        }).join('')
      : `<tr><td colspan="${span}" class="empty-cell">${esc(opts.empty || 'Nothing here yet.')}</td></tr>`;

    // opts.foot: a totals row. Cells carry the same priority as their column
    // so the summary hides and reveals in step with the data above it.
    const foot = opts.foot
      ? `<tfoot><tr class="summary-row">${expandable ? '<td class="col-expand"></td>' : ''}${
          opts.foot.map((cell, i) => {
            const c = cols[i] || {};
            return `<td class="${c.className || ''}" data-p="${pri(c)}" data-label="${esc(c.label || '')}">${cell == null ? '' : cell}</td>`;
          }).join('')}</tr></tfoot>`
      : '';

    const cls = ['table-scroll', opts.wrapClass].filter(Boolean).join(' ');
    const tcls = [opts.className].filter(Boolean).join(' ');
    return `<div class="${cls}"><table class="${tcls}" data-maxp="${maxP}">${opts.caption ? `<caption class="sr-only">${esc(opts.caption)}</caption>` : ''}<thead><tr>${head}</tr></thead><tbody>${body}</tbody>${foot}</table></div>`;
  }

  // The row a view appended after its data row (a chart, a month drill-down).
  // UI.table may insert its own .row-detail panel in between, so never reach
  // for nextElementSibling directly — walk to the row you actually want.
  function siblingRow(tr, className) {
    let n = tr.nextElementSibling;
    while (n && !n.classList.contains(className)) {
      if (!n.classList.contains('row-detail')) return null;
      n = n.nextElementSibling;
    }
    return n;
  }

  // Fill a row's detail panel from the cells the current viewport is hiding.
  // Derived from the DOM rather than from the data, so there is exactly one
  // source of truth for a cell's contents.
  function fillRowDetail(tr) {
    const detail = tr.nextElementSibling;
    if (!detail || !detail.classList.contains('row-detail')) return 0;
    const hidden = Array.from(tr.children).filter((td) =>
      td.dataset.label && getComputedStyle(td).display === 'none');
    detail.firstElementChild.innerHTML = hidden.length
      ? `<dl class="row-detail-list">${hidden.map((td) =>
          `<div><dt>${esc(td.dataset.label)}</dt><dd class="${td.className}">${td.innerHTML}</dd></div>`).join('')}</dl>`
      : '<p class="text-muted text-small" style="margin:0">Nothing more to show at this width.</p>';
    return hidden.length;
  }

  // One delegated handler for every expander in the view. Bound by the router
  // after each render, so views get this for free.
  //
  // The chevron is its own button in its own cell — NOT a row handler —
  // because three tables already own the row tap (Investors overview
  // navigates, Portfolio holdings and Dashboard holdings expand a chart).
  function bindRowExpanders(root) {
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('.row-expand');
      if (!btn || !root.contains(btn)) return;
      e.preventDefault();
      e.stopPropagation(); // never also trigger the row's own action
      const tr = btn.closest('tr');
      const detail = tr.nextElementSibling;
      const open = btn.getAttribute('aria-expanded') === 'true';
      if (!open) fillRowDetail(tr);
      btn.setAttribute('aria-expanded', String(!open));
      detail.hidden = open;
    });

    // Rotating the phone changes which columns are hidden. Re-derive open
    // panels rather than leaving them showing stale columns.
    let t = null;
    const onResize = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        root.querySelectorAll('.row-expand[aria-expanded="true"]').forEach((btn) => {
          const tr = btn.closest('tr');
          if (fillRowDetail(tr) === 0) {
            btn.setAttribute('aria-expanded', 'false');
            tr.nextElementSibling.hidden = true;
          }
        });
      }, 150);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }

  // ── Sub-tab bar ──────────────────────────────────────────────────────────
  // tabs: [{key, label, href}] — plain links so back/forward and middle-click
  // work; the active one is derived from the current hash.
  function subTabs(tabs, activeKey) {
    return `<nav class="subtabs" aria-label="Section tabs">${tabs.map((t) =>
      `<a href="${t.href}" class="${t.key === activeKey ? 'active' : ''}" ${t.key === activeKey ? 'aria-current="page"' : ''}>${esc(t.label)}</a>`
    ).join('')}</nav>`;
  }

  // ── Range preset picker ──────────────────────────────────────────────────
  // Returns HTML; call bindRangePicker(el, onChange) after inserting.
  const RANGE_PRESETS = [
    { key: '1m', label: '1M' }, { key: '6m', label: '6M' },
    { key: 'ytd', label: 'YTD' }, { key: '1y', label: '1Y' },
    { key: 'all', label: 'All' },
  ];
  function rangePicker(activeKey) {
    return `<div class="range-picker" role="group" aria-label="Time range">${RANGE_PRESETS.map((p) =>
      `<button type="button" class="preset ${p.key === activeKey ? 'active' : ''}" data-preset="${p.key}" aria-pressed="${p.key === activeKey}">${p.label}</button>`
    ).join('')}</div>`;
  }
  function bindRangePicker(container, onChange) {
    container.querySelectorAll('.range-picker .preset').forEach((btn) => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('.range-picker .preset').forEach((b) => {
          b.classList.toggle('active', b === btn);
          b.setAttribute('aria-pressed', String(b === btn));
        });
        onChange(btn.dataset.preset);
      });
    });
  }

  // ── Metric info popovers ─────────────────────────────────────────────────
  // infoIcon('total-value') renders a small ⓘ button; clicking it opens a
  // panel with the metric's data source and calculation, looked up in
  // window.MetricsInfo. One document-level handler serves every icon —
  // views just sprinkle icons, no wiring needed.
  function infoIcon(key) {
    const def = (window.MetricsInfo || {})[key];
    if (!def) return '';
    return `<button type="button" class="info-dot" data-info="${esc(key)}" aria-haspopup="dialog" aria-label="How is ${esc(def.title)} calculated?" title="Where is this from?">i</button>`;
  }

  let infoPanel = null;
  function closeInfo() {
    if (infoPanel) { infoPanel.remove(); infoPanel = null; }
  }
  function openInfo(key, anchor) {
    closeInfo();
    const def = (window.MetricsInfo || {})[key];
    if (!def) return;
    infoPanel = document.createElement('div');
    infoPanel.className = 'info-popover';
    infoPanel.setAttribute('role', 'dialog');
    infoPanel.setAttribute('aria-label', def.title);
    infoPanel.innerHTML = `
      <div class="info-popover-head">
        <strong>${esc(def.title)}</strong>
        <button type="button" class="info-close" aria-label="Close">×</button>
      </div>
      <div class="info-popover-body">
        <h5>Data source</h5>
        <p>${def.source}</p>
        <h5>How it's calculated</h5>
        <p>${def.calc}</p>
      </div>`;
    document.body.appendChild(infoPanel);
    // Position near the anchor, clamped to the viewport.
    const r = anchor.getBoundingClientRect();
    const pw = Math.min(420, window.innerWidth - 24);
    infoPanel.style.width = pw + 'px';
    let left = Math.min(Math.max(12, r.left + window.scrollX - 40), window.scrollX + window.innerWidth - pw - 12);
    infoPanel.style.left = left + 'px';
    infoPanel.style.top = (r.bottom + window.scrollY + 8) + 'px';
    infoPanel.querySelector('.info-close').addEventListener('click', closeInfo);
    infoPanel.querySelector('.info-close').focus();
  }

  function enableInfoPopovers() {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-info]');
      if (btn) {
        e.preventDefault();
        e.stopPropagation();
        if (infoPanel && infoPanel.dataset.for === btn.dataset.info) { closeInfo(); return; }
        openInfo(btn.dataset.info, btn);
        if (infoPanel) infoPanel.dataset.for = btn.dataset.info;
        return;
      }
      if (infoPanel && !e.target.closest('.info-popover')) closeInfo();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeInfo();
    });
    window.addEventListener('hashchange', closeInfo);
  }

  // ── Misc ─────────────────────────────────────────────────────────────────
  function flash(kind, html) {
    return `<div class="flash ${kind}">${html}</div>`;
  }

  function emptyState(title, hint) {
    return `<div class="empty-state"><strong>${esc(title)}</strong>${hint ? `<p>${hint}</p>` : ''}</div>`;
  }

  // Investor chip with the shared per-investor color as a leading dot —
  // color is never the only signal, the code is always printed.
  function investorChip(code) {
    const color = (window.Ledger.INVESTOR_COLORS || {})[code] || 'var(--muted)';
    return `<span class="inv-chip"><span class="dot" style="background:${color}" aria-hidden="true"></span>${esc(code)}</span>`;
  }

  // All quarterly/annual fundamentals rows for one security from the
  // Offisielle nøkkeltall tab — every available period, oldest first.
  function fundamentalsTable(store, security) {
    const canon = window.Portfolio.canonicalName;
    const key = canon(security);
    const rows = (store.kpis || []).filter((k) => canon(k.company) === key);
    if (!rows.length) return '';
    const pKey = (p) => {
      const y = /(\d{4})/.exec(p || ''); const yr = y ? +y[1] : 0;
      const q = /Q\s*([1-4])/i.exec(p || ''); return yr * 10 + (q ? +q[1] : 5);
    };
    rows.sort((a, b) => pKey(a.period) - pKey(b.period));
    const F = window.Fmt;
    const cell = (v) => (v == null || v === '' ? '<span class="text-muted">—</span>' : esc(v));
    const nok = (v) => (v == null ? '<span class="text-muted">—</span>' : F.fmtNok(v));
    return `
      <h5 class="section-title text-small" style="margin-top:14px">Fundamentals — Offisielle nøkkeltall ${infoIcon('fundamentals')}</h5>
      ${table([
        { label: 'Period', p: 1 },
        { label: 'Revenue', className: 'text-right', p: 1 },
        { label: 'EAT', className: 'text-right', p: 2 },
        { label: 'EPS', className: 'text-right', p: 1 },
        { label: 'P/E', className: 'text-right', p: 2 },
        { label: 'P/B', className: 'text-right', p: 3 },
        { label: 'P/S', className: 'text-right', p: 3 },
        { label: 'Your rev (NOK)', className: 'text-right', p: 3 },
        { label: 'Your EAT (NOK)', className: 'text-right', p: 2 },
        { label: 'Note', className: 'text-small text-muted wrap', p: 3 },
      ], rows.map((k) => [
        `<strong>${esc(k.period)}</strong> <span class="text-muted text-small">${esc(k.currency || '')}</span>`,
        cell(k.revenue),
        cell(k.eat),
        cell(k.eps),
        k.pe != null ? Number(k.pe).toFixed(1) : '<span class="text-muted">—</span>',
        k.pb != null ? Number(k.pb).toFixed(2) : '<span class="text-muted">—</span>',
        k.ps != null ? Number(k.ps).toFixed(2) : '<span class="text-muted">—</span>',
        nok(k.yourRevNok),
        k.yourProfitNok != null ? `<span class="${F.pctClass(k.yourProfitNok)}">${nok(k.yourProfitNok)}</span>` : nok(k.yourProfitNok),
        esc(k.note || ''),
      ]), { caption: 'Fundamentals' })}`;
  }

  // The one security drill-down used everywhere (dashboard + portfolio):
  // teal price chart with the club's buy/sell markers, then all available
  // fundamentals periods. Renders into `mount`.
  function renderSecurityDrilldown(mount, store, security) {
    const canon = window.Portfolio.canonicalName;
    const points = window.TimeSeries.buildSecurityPriceSeries(store, security)
      .map((p) => ({ date: p.date, price: p.price }));
    let any = false;
    if (points.length >= 2) {
      const from = points[0].date, to = points[points.length - 1].date;
      const markers = [];
      for (const tx of store.transactions) {
        if (!tx.security || !tx.tradeDate) continue;
        if (canon(tx.security) !== canon(security)) continue;
        if (tx.tradeDate < from || tx.tradeDate > to) continue;
        const cat = window.Ledger.classify(tx.type);
        const isBuy = cat === 'BUY' && tx.type === 'KJØPT';
        const isSell = cat === 'SELL' && window.Ledger.isRealizingSell(tx.type);
        if (!isBuy && !isSell) continue;
        const amt = Math.abs(window.Ledger.amountNok(tx));
        markers.push({
          date: tx.tradeDate, type: isSell ? 'sell' : 'buy',
          label: `${isSell ? 'sold' : 'bought'} ${tx.qty != null ? Math.abs(tx.qty) + ' stk · ' : ''}${window.Fmt.fmtNok(amt)}`,
        });
      }
      const wrap = document.createElement('div');
      wrap.className = 'chart-wrap';
      wrap.appendChild(window.Charts.priceChart({ points, markers, yUnit: 'NOK' }));
      mount.appendChild(wrap);
      any = true;
    }
    const fx = fundamentalsTable(store, security);
    if (fx) {
      const div = document.createElement('div');
      div.innerHTML = fx;
      mount.appendChild(div);
      any = true;
    }
    if (!any) {
      mount.innerHTML = '<p class="text-muted text-small" style="margin:8px 0">No price history or fundamentals for this security yet.</p>';
    }
  }

  // ── Write-access gate ────────────────────────────────────────────────────
  // Upgrading to the read+write Sheets scope is a full-page redirect, so an
  // in-flight edit cannot survive it. Call this when an editing surface OPENS,
  // not when Save is pressed: the user grants access first and their work is
  // never thrown away mid-form.
  //
  // Returns true when the session can already write. Otherwise renders an
  // "Enable editing" prompt into `mount` and returns false.
  function writeGate(mount, what) {
    if (!mount) return window.Auth.hasWriteScope();
    if (window.Auth.hasWriteScope()) { mount.innerHTML = ''; return true; }
    mount.innerHTML = `<div class="flash write-gate">
      <div><strong>Editing needs write access.</strong> ${esc(what || 'This action')} writes to the club\'s Google Sheet. You will bounce through Google once and land back here.</div>
      <button type="button" class="btn" data-write-gate>Enable editing</button>
    </div>`;
    mount.querySelector('[data-write-gate]').addEventListener('click', () => {
      // Navigates away; consumeRedirectToken() restores this hash on return.
      window.Auth.requestWriteAccess();
    });
    return false;
  }

  window.UI = {
    esc, kpiGrid, section, table, subTabs, bindRowExpanders, siblingRow,
    rangePicker, bindRangePicker, RANGE_PRESETS,
    flash, emptyState, investorChip,
    infoIcon, enableInfoPopovers, fundamentalsTable, renderSecurityDrilldown,
    writeGate,
  };
})();
