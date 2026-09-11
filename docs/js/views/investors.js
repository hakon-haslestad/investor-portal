// Investors view — #/investors (overview) and #/investors/:code (detail).
// #/investors/<code> (per-investor drill-down). Ports pages/investor.js and
// pages/game.js into the SPA shell.

(function () {
  window.Views = window.Views || {};

  // (The Game lives at #/game in the top-level nav — no sub-tabs needed
  // here, but keep the bar shape in case more investor sub-views arrive.)
  const SUBTABS = (active) => window.UI.subTabs([
    { key: 'overview', label: 'Investors', href: '#/investors' },
  ], active);

  // Best-effort slug for Nordnet's /aksjer/kurser/<slug> URL pattern.
  function nordnetSlug(name) {
    return String(name || '')
      .toLowerCase()
      .replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/å/g, 'a')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function researchLinks(security) {
    const slug = nordnetSlug(security);
    const q = encodeURIComponent(security);
    const ir = encodeURIComponent(security + ' investor relations');
    return `<a target="_blank" rel="noopener" href="https://www.nordnet.no/aksjer/kurser/${slug}">Nordnet</a>
      · <a target="_blank" rel="noopener" href="https://finance.yahoo.com/lookup?s=${q}">Yahoo</a>
      · <a target="_blank" rel="noopener" href="https://www.google.com/search?q=${ir}">IR</a>`;
  }

  // ─── Overview ─────────────────────────────────────────────────────────────

  function renderOverview(el, ctx) {
    el.classList.add('wide'); // wide table — use the full viewport
    const { store } = ctx;
    const { fmtPct, pctClass, escapeHtml } = window.Fmt;
    const UI = window.UI;
    const names = window.Copy.namesFromMembers(store.members);
    const dash = window.Portfolio.buildDashboard(store);
    const codes = window.Ledger.INVESTOR_CODES.slice()
      .sort((a, b) => ((dash.perInvestor[b] || {}).portfolioReturnPct || 0) - ((dash.perInvestor[a] || {}).portfolioReturnPct || 0));

    // Market-value change over fixed horizons (per investor, attributed MV) —
    // always from today's perspective.
    const today = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const back = (days) => { const d = new Date(today); d.setUTCDate(d.getUTCDate() - days); return iso(d); };
    const backM = (months) => { const d = new Date(today); d.setUTCMonth(d.getUTCMonth() - months); return iso(d); };
    let earliest = null;
    for (const t of store.transactions) if (t.tradeDate && (!earliest || t.tradeDate < earliest)) earliest = t.tradeDate;
    // p: column priority (see UI.table). A phone keeps one short horizon, the
    // calendar year and lifetime — the three people actually read.
    const HORIZONS = [
      { key: '1w', label: '1w', from: back(7), p: 3 },
      { key: '1m', label: '1m', from: backM(1), p: 1 },
      { key: '3m', label: '3m', from: backM(3), p: 3 },
      { key: '6m', label: '6m', from: backM(6), p: 3 },
      { key: 'ytd', label: 'YTD', from: `${today.getUTCFullYear()}-01-01`, p: 1 },
      { key: '1y', label: '1y', from: backM(12), p: 3 },
      { key: '3y', label: '3y', from: backM(36), p: 3 },
      { key: 'all', label: 'All', from: earliest || backM(12), p: 1 },
    ];
    // Money is condensed on a phone so the p1 columns fit 360px.
    const money = window.Fmt.fmtNokFit;
    const COLS = [
      { label: 'Investor', p: 1 },
      { label: 'Total value', className: 'text-right', p: 2 },
      { label: 'Market value', className: 'text-right', p: 1 },
      { label: 'Realized', className: 'text-right', p: 2 },
      { label: 'Unrealized', className: 'text-right', p: 2 },
      { label: 'Dividends', className: 'text-right', p: 3 },
      { label: 'All-time return', className: 'text-right', p: 2 },
      ...HORIZONS.map((h) => ({ label: `Δ${h.label}`, className: 'text-right', p: h.p })),
    ];

    const usesMatrix = window.Portfolio.usePriceMatrix(store);
    const mvNow = {}; const mvThen = {};
    for (const code of codes) {
      mvNow[code] = (dash.perInvestor[code] || {}).marketValue || 0;
      mvThen[code] = {};
      if (usesMatrix) {
        for (const h of HORIZONS) mvThen[code][h.key] = window.Portfolio.investorValueAt(store, code, h.from).mv;
      }
    }
    const deltaCell = (code, h) => {
      const was = mvThen[code] ? mvThen[code][h.key] : null;
      if (was == null || !(Math.abs(was) > 0.5)) return '<span class="text-muted">—</span>';
      const pct = ((mvNow[code] - was) / Math.abs(was)) * 100;
      return `<span class="${pctClass(pct)}">${fmtPct(pct)}</span>`;
    };

    el.innerHTML = `
      <div class="hero">
        <h2>Investors ${UI.infoIcon('investor-kpis')}</h2>
        <div class="when">as of today · Δ columns are attributed market-value change ${UI.infoIcon('mv-change')}</div>
      </div>
      ${SUBTABS('overview')}
      ${window.UI.table(COLS, codes.map((code) => {
        const s2 = dash.perInvestor[code];
        return {
          attrs: `class="row-link" tabindex="0" role="link" data-code="${escapeHtml(code)}" aria-label="Open ${escapeHtml(names[code] || code)}"`,
          cells: [
            `${UI.investorChip(code)} <span class="text-muted text-small">${escapeHtml(names[code] || '')}</span>`,
            money(s2.totalValue),
            `<strong>${money(s2.marketValue)}</strong>`,
            `<span class="${pctClass(s2.realized)}">${money(s2.realized)}</span>`,
            `<span class="${pctClass(s2.unrealized)}">${money(s2.unrealized)}</span>`,
            money(s2.dividends),
            `<span class="${pctClass(s2.portfolioReturnPct)}">${fmtPct(s2.portfolioReturnPct)}</span>`,
            ...HORIZONS.map((h) => deltaCell(code, h)),
          ],
        };
      }), { className: 'investor-table compact-table', wrapClass: 'sticky-first', caption: 'Investors, current standing' })}
    `;
    el.querySelectorAll('tr.row-link').forEach((tr) => {
      const go = () => ctx.navigate(`#/investors/${tr.dataset.code}`);
      tr.addEventListener('click', go);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
  }

  // ─── Per-investor drill-down ──────────────────────────────────────────────

  function renderDetail(el, ctx, code) {
    const { store } = ctx;
    const { fmtNok, fmtPct, fmtQty, pctClass } = window.Fmt;
    const UI = window.UI;
    const names = window.Copy.namesFromMembers(store.members);
    const detail = window.Portfolio.investorDetail(store, code);
    if (!detail) {
      el.innerHTML = `${SUBTABS('overview')}${UI.emptyState(`No data for investor code ${UI.esc(code)}.`,
        '<a href="#/investors">← back to investors</a>')}`;
      return;
    }
    const displayName = names[code] || code;
    const s = detail.summary;
    const verdict = window.Copy.verdictFromReturn(displayName, s.portfolioReturnPct);

    // Period comparison against the selected window's start.
    let preset = 'ytd';
    try { preset = JSON.parse(localStorage.getItem('portal.investor.range') || '{}').preset || 'ytd'; } catch (_e) {}
    const win = window.Portfolio.computeWindow(store, preset);
    const usesMatrix = window.Portfolio.usePriceMatrix(store);
    const then = usesMatrix ? window.Portfolio.investorValueAt(store, code, win.from) : null;
    const wm = usesMatrix ? window.Portfolio.windowMetrics(store, win.from, win.to).perInvestor[code] : null;
    const delta = (now, was) => {
      if (!then || was == null || !(Math.abs(was) > 0.5)) return null;
      const pct = ((now - was) / Math.abs(was)) * 100;
      return `<span class="${pctClass(pct)}">${fmtPct(pct)}</span> vs ${win.from}`;
    };

    el.innerHTML = `
      ${SUBTABS('overview')}
      <div class="hero">
        <h2>${UI.investorChip(code)} ${UI.esc(displayName)}</h2>
        <div class="when">${UI.rangePicker(preset)}</div>
      </div>
      <div class="flash success">${verdict} <span class="text-small text-muted">· <a href="#/investors">← all investors</a></span></div>

      ${UI.kpiGrid([
        { label: 'Total value', value: fmtNok(s.totalValue), sub: delta(s.totalValue, then && then.total) || '', info: 'investor-kpis' },
        { label: 'Stocks MV', value: fmtNok(s.marketValue), sub: delta(s.marketValue, then && then.mv) || '', info: 'market-value' },
        { label: 'This period', value: wm ? `<strong>${fmtPct(wm.periodReturnPct)}</strong>` : '—', sub: wm ? `${fmtNok(wm.netPnlInWindow)} net P/L · ${win.from} → ${win.to}` : '', tone: wm ? pctClass(wm.periodReturnPct) : '', info: 'window-metrics' },
        { label: 'Total invested', value: fmtNok(s.invested), info: 'invested' },
        { label: 'Realized', value: fmtNok(s.realized), tone: pctClass(s.realized), info: 'realized' },
        { label: 'Unrealized', value: fmtNok(s.unrealized), sub: then ? `was ${fmtNok(then.unrealized)} on ${win.from}` : '', tone: pctClass(s.unrealized), info: 'unrealized' },
        { label: 'Dividends', value: fmtNok(s.dividends), info: 'dividends' },
        { label: 'Return %', value: `<strong>${fmtPct(s.portfolioReturnPct)}</strong>`, tone: pctClass(s.portfolioReturnPct), info: 'return-pct' },
      ])}

      <div id="equity-chart"></div>

      ${UI.section(`Current holdings (${s.holdings.length})`, { info: 'holdings-table' })}
      ${s.holdings.length === 0
        ? '<p class="text-muted">No active positions. All cashed out.</p>'
        : UI.table([
            { label: 'Security', p: 1 },
            { label: 'Qty', className: 'text-right', p: 2 },
            { label: 'Avg cost', className: 'text-right', p: 2 },
            { label: 'Current px', className: 'text-right', p: 3 },
            { label: 'Market value', className: 'text-right', p: 1 },
            { label: 'Unrealized', className: 'text-right', p: 2 },
            { label: 'U/L %', className: 'text-right', p: 1 },
            { label: 'Realized so far', className: 'text-right', p: 3 },
            { label: 'Research', className: 'links', p: 3 },
          ], s.holdings.map((h) => [
            `${UI.esc(h.security)} ${h.weight < 1 ? `<span class="tag">${(h.weight * 100).toFixed(0)}% share</span>` : ''}`,
            fmtQty(h.qty),
            fmtNok(h.avgCost),
            h.currentPrice != null ? fmtNok(h.currentPrice) : '<span class="text-muted">—</span>',
            h.marketValue != null ? fmtNok(h.marketValue) : '<span class="text-muted">—</span>',
            `<span class="${pctClass(h.unrealized)}">${fmtNok(h.unrealized)}</span>`,
            `<span class="${pctClass(h.unrealizedPct)}">${fmtPct(h.unrealizedPct)}</span>`,
            Math.abs(h.realized || 0) > 0.5
              ? `<span class="${pctClass(h.realized)}" title="Profit already banked on partial sells of this position">${fmtNok(h.realized)}</span>`
              : '<span class="text-muted">—</span>',
            researchLinks(h.security),
          ]))}

      ${detail.previous.length === 0 ? '' : `
        ${UI.section(`Previous holdings (${detail.previous.length})`, { info: 'previous-holdings', extra: '<span class="text-muted text-small">closed positions</span>' })}
        ${UI.table([
          { label: 'Security', p: 1 },
          { label: 'Invested', className: 'text-right', p: 2 },
          { label: 'Proceeds', className: 'text-right', p: 3 },
          { label: 'Dividends', className: 'text-right', p: 3 },
          { label: 'Realized', className: 'text-right', p: 2 },
          { label: 'Net result', className: 'text-right', p: 1 },
          { label: 'Return %', className: 'text-right', p: 1 },
          { label: 'First → last', p: 3 },
          { label: 'Research', className: 'links', p: 3 },
        ], detail.previous.map((p) => [
          `${UI.esc(p.security)} ${p.weight < 1 ? `<span class="tag">${(p.weight * 100).toFixed(0)}% share</span>` : ''}`,
          `<span class="text-muted">${fmtNok(p.invested)}</span>`,
          `<span class="text-muted">${fmtNok(p.proceeds)}</span>`,
          fmtNok(p.dividends),
          `<span class="${pctClass(p.realized)}">${fmtNok(p.realized)}</span>`,
          `<strong class="${pctClass(p.netResult)}">${fmtNok(p.netResult)}</strong>`,
          `<span class="${pctClass(p.returnPct)}">${fmtPct(p.returnPct)}</span>`,
          `<span class="text-small text-muted">${p.firstDate || '—'} → ${p.lastDate || '—'}</span>`,
          researchLinks(p.security),
        ]))}`}

      ${UI.section(`Recent transactions (last ${detail.recent.length})`)}
      ${UI.table([
        { label: 'Date', p: 1 },
        { label: 'Type', p: 2 },
        { label: 'Security', p: 1 },
        { label: 'Qty (share)', className: 'text-right', p: 2 },
        { label: 'Price', className: 'text-right', p: 3 },
        { label: 'Amount (share)', className: 'text-right', p: 1 },
      ], detail.recent.map((t) => [
        `<span class="text-small">${t.tradeDate || ''}</span>`,
        `<span class="tag">${UI.esc(t.type)}</span>`,
        t.security ? UI.esc(t.security) : '<span class="text-muted">—</span>',
        fmtQty(t.qty),
        fmtNok(t.price),
        `<span class="${pctClass(t.amount)}">${fmtNok(t.amount)}</span>`,
      ]), { empty: 'No transactions attributed yet.' })}
    `;

    UI.bindRangePicker(el, (pNew) => {
      localStorage.setItem('portal.investor.range', JSON.stringify({ preset: pNew }));
      renderDetail(el, ctx, code);
    });

    // Daily equity curve for this investor (needs the price matrix).
    if (window.Portfolio.usePriceMatrix(store)) {
      const series = window.TimeSeries.buildPortfolioValueSeries(store)
        .map((p) => ({ date: p.date, y: p.perInvestor[code] || 0 }))
        .filter((p) => p.y > 0);
      if (series.length >= 2) {
        // The investor's own trades as buy/sell markers on the curve —
        // hovering a trade date lists them with the attributed amount.
        const from = series[0].date, to = series[series.length - 1].date;
        const { classify, isRealizingSell, amountNok, splitForSecurity } = window.Ledger;
        const markers = [];
        for (const tx of store.transactions) {
          if (!tx.security || !tx.tradeDate) continue;
          if (tx.tradeDate < from || tx.tradeDate > to) continue;
          const cat = classify(tx.type);
          const isBuy = cat === 'BUY' && tx.type === 'KJØPT';
          const isSell = cat === 'SELL' && isRealizingSell(tx.type);
          if (!isBuy && !isSell) continue;
          const slot = splitForSecurity(store.attributionMap, tx.security).find((x) => x.code === code);
          if (!slot) continue;
          const amt = Math.abs(amountNok(tx)) * slot.weight;
          markers.push({
            date: tx.tradeDate, type: isSell ? 'sell' : 'buy',
            label: `${isSell ? 'sold' : 'bought'} ${window.Portfolio.canonicalName(tx.security)} · ${fmtNok(amt)}`,
          });
        }
        const mount = el.querySelector('#equity-chart');
        mount.className = 'chart-wrap';
        const head = document.createElement('div');
        head.className = 'section-head';
        head.innerHTML = `<h3 class="section-title">Equity curve ${UI.infoIcon('equity-curve')} <span class="text-muted text-small"><span style="color:#2D5BFF">●</span> buy · <span style="color:#FF3B3B">●</span> sell — hover for amounts</span></h3>`;
        mount.appendChild(head);
        mount.appendChild(window.Charts.multiLine({
          series: [{ name: displayName, color: window.Ledger.INVESTOR_COLORS[code] || '#1FE0CE', points: series, markers }],
          width: 1180, height: 300, interactive: true,
          title: 'Portfolio value (NOK, daily)',
        }));
      }
    }
  }

  // ─── Entry point ──────────────────────────────────────────────────────────

  window.Views.investors = async function (el, ctx) {
    const sub = (ctx.params[0] || '').trim();
    if (!sub) { renderOverview(el, ctx); return; }
    if (sub.toLowerCase() === 'game') { location.replace('#/games'); return; }
    renderDetail(el, ctx, decodeURIComponent(sub).toUpperCase());
  };
})();
