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
  // cols: [{label, className?}], rows: array of arrays of HTML strings.
  // Wrap in .table-scroll so wide tables scroll inside the card, not the page.
  function table(cols, rows, opts = {}) {
    const head = cols.map((c) => `<th class="${c.className || ''}" scope="col">${esc(c.label)}</th>`).join('');
    const body = rows.length
      ? rows.map((r) => {
          const attrs = r.attrs || '';
          const cells = (r.cells || r).map((cell, i) =>
            `<td class="${cols[i] && cols[i].className || ''}">${cell}</td>`).join('');
          return `<tr ${attrs}>${cells}</tr>`;
        }).join('')
      : `<tr><td colspan="${cols.length}" class="empty-cell">${esc(opts.empty || 'Nothing here yet.')}</td></tr>`;
    return `<div class="table-scroll"><table>${opts.caption ? `<caption class="sr-only">${esc(opts.caption)}</caption>` : ''}<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
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

  window.UI = {
    esc, kpiGrid, section, table, subTabs,
    rangePicker, bindRangePicker, RANGE_PRESETS,
    flash, emptyState, investorChip,
    infoIcon, enableInfoPopovers,
  };
})();
