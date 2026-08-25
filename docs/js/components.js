// Shared UI building blocks for the SPA views. Small, string-template based
// — same idiom as the rest of the codebase, just centralized so every view
// renders KPIs, tables, tabs and empty states the same way.

(function () {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // ── KPI tiles ─────────────────────────────────────────────────────────────
  // items: [{label, value, sub?, tone?: 'positive'|'negative'|''}]
  function kpiGrid(items) {
    return `<div class="kpi-grid">${items.map((k) => `
      <div class="kpi-card">
        <div class="label">${esc(k.label)}</div>
        <div class="value ${k.tone || ''}">${k.value}</div>
        ${k.sub ? `<div class="sub">${k.sub}</div>` : ''}
      </div>`).join('')}</div>`;
  }

  // ── Section heading ───────────────────────────────────────────────────────
  function section(title, extraHtml) {
    return `<div class="section-head"><h3 class="section-title">${esc(title)}</h3>${extraHtml || ''}</div>`;
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
  };
})();
