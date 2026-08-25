// Dashboard view — SPA port of pages/dashboard.js.
// The shell (app.js) has already authed, hydrated the store, and mounted
// the nav; this module only renders into its view element.

(function () {
  window.Views = window.Views || {};

  window.Views.dashboard = async function (el, ctx) {
    const { store } = ctx;
    const { fmtNok, fmtPct, fmtQty, pctClass, PODIUM, escapeHtml } = window.Fmt;
    const ii = window.UI.infoIcon;
    const INVESTOR_COLORS = window.Ledger.INVESTOR_COLORS;
    const INVESTOR_CODES = window.Ledger.INVESTOR_CODES;
    const names = window.Copy.namesFromMembers(store.members);

    // The spreadsheet's own name, shown in the welcome heading. Best-effort.
    let sheetName = '';
    try { sheetName = await window.Sheet.spreadsheetTitle(); } catch (_e) { sheetName = ''; }

    // Currently-active competition (today inside its window). Best-effort —
    // if the Competitions tab is missing or the network fails, skip the feature.
    let activeCompetition = null;
    try {
      const all = await window.CompetitionsData.listCompetitions();
      const today = new Date().toISOString().slice(0, 10);
      const live = all.filter((c) =>
        c.competition.start_date && c.competition.end_date &&
        c.competition.start_date <= today && c.competition.end_date >= today
      );
      if (live.length) {
        activeCompetition = live.sort((a, b) =>
          b.competition.start_date.localeCompare(a.competition.start_date)
        )[0];
      }
    } catch (_e) { /* competitions optional; ignore */ }

    const PRESETS = [
      { id: '1m', label: '1M' }, { id: '6m', label: '6M' },
      { id: 'ytd', label: 'YTD' }, { id: '1y', label: '1Y' },
      { id: 'all', label: 'All' }, { id: 'custom', label: 'Custom' },
    ];

    let stored = {};
    try { stored = JSON.parse(localStorage.getItem('portal.range') || '{}') || {}; }
    catch (_e) { /* corrupt stored range — fall back to defaults */ }
    let current = {
      preset: stored.preset || 'ytd',
      from: stored.from || null,
      to: stored.to || null,
    };
    let selectedCodes = (localStorage.getItem('portal.filter') || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    let competitionMode = localStorage.getItem('portal.competition_mode') === '1';
    if (competitionMode && !activeCompetition) {
      competitionMode = false;
      localStorage.removeItem('portal.competition_mode');
    }
    if (competitionMode && activeCompetition) {
      current = {
        preset: 'custom',
        from: activeCompetition.competition.start_date,
        to: activeCompetition.competition.end_date,
      };
      selectedCodes = activeCompetition.participants.map((p) => p.investor_code).filter(Boolean);
    }

    function toggleCompetitionMode() {
      if (!activeCompetition) return;
      if (competitionMode) {
        competitionMode = false;
        localStorage.removeItem('portal.competition_mode');
        current = { preset: 'ytd', from: null, to: null };
        selectedCodes = [];
        localStorage.removeItem('portal.filter');
      } else {
        competitionMode = true;
        localStorage.setItem('portal.competition_mode', '1');
        current = {
          preset: 'custom',
          from: activeCompetition.competition.start_date,
          to: activeCompetition.competition.end_date,
        };
        selectedCodes = activeCompetition.participants.map((p) => p.investor_code).filter(Boolean);
        if (selectedCodes.length) localStorage.setItem('portal.filter', selectedCodes.join(','));
      }
      refresh();
    }
    window.__toggleCompetitionMode = toggleCompetitionMode;

    window.__clearFilter = () => { selectedCodes = []; localStorage.removeItem('portal.filter'); refresh(); };

    // Aggregate per-investor values across the current selection.
    function aggregateRn(d) {
      if (!selectedCodes.length) return d.group;
      if (selectedCodes.length === 1 && d.perInvestor[selectedCodes[0]]) return d.perInvestor[selectedCodes[0]];
      const acc = { marketValue: 0, cash: 0, totalValue: 0, dividends: 0, realized: 0, unrealized: 0, invested: 0, netReturn: 0 };
      for (const code of selectedCodes) {
        const inv = d.perInvestor[code]; if (!inv) continue;
        acc.marketValue += inv.marketValue || 0;
        acc.cash += inv.cash || 0;
        acc.totalValue += inv.totalValue || 0;
        acc.dividends += inv.dividends || 0;
        acc.realized += inv.realized || 0;
        acc.unrealized += inv.unrealized || 0;
        acc.invested += inv.invested || 0;
        acc.netReturn += inv.netReturn || 0;
      }
      acc.portfolioReturnPct = acc.invested > 0 ? (acc.netReturn / acc.invested) * 100 : 0;
      return acc;
    }
    function aggregateWin(wm) {
      if (!selectedCodes.length) return wm.group;
      if (selectedCodes.length === 1 && wm.perInvestor[selectedCodes[0]]) return wm.perInvestor[selectedCodes[0]];
      const acc = { realizedInWindow: 0, dividendsInWindow: 0, buysInWindow: 0, sellsInWindow: 0,
                    buyCount: 0, sellCount: 0, netPnlInWindow: 0, periodReturnPct: 0 };
      let n = 0;
      for (const code of selectedCodes) {
        const w = wm.perInvestor[code]; if (!w) continue;
        acc.realizedInWindow += w.realizedInWindow || 0;
        acc.dividendsInWindow += w.dividendsInWindow || 0;
        acc.buysInWindow += w.buysInWindow || 0;
        acc.sellsInWindow += w.sellsInWindow || 0;
        acc.buyCount += w.buyCount || 0;
        acc.sellCount += w.sellCount || 0;
        acc.netPnlInWindow += w.netPnlInWindow || 0;
        acc.periodReturnPct += w.periodReturnPct || 0;
        n++;
      }
      if (n) acc.periodReturnPct /= n;
      return acc;
    }

    function refresh() {
      const opts = current.preset === 'custom' && current.from && current.to
        ? { from: current.from, to: current.to }
        : { preset: current.preset };
      const d = window.Portfolio.buildDashboard(store, opts);
      if (!current.from || !current.to) {
        current.from = d.window.from;
        current.to = d.window.to;
      }
      localStorage.setItem('portal.range', JSON.stringify(current));

      if (competitionMode && activeCompetition && window.CompetitionEngine) {
        try {
          const comp = window.CompetitionEngine.scoreCompetition(
            store, activeCompetition.competition, activeCompetition.participants
          );
          applyCompetitionOverrides(d, comp);
        } catch (_e) { /* fall back to normal dashboard if scoring blows up */ }
      }

      paint(d);
    }

    function applyCompetitionOverrides(d, comp) {
      const byCode = new Map();
      for (const r of comp.ranks) byCode.set(r.code, r);
      const wm = d.windowMetrics;

      let gMV = 0, gCash = 0, gUnreal = 0, gReal = 0, gDiv = 0, gInv = 0, gNet = 0;
      let gBuys = 0, gSells = 0, gBuyCount = 0, gSellCount = 0, gNetPnl = 0;

      for (const code of INVESTOR_CODES) {
        const p = byCode.get(code);
        const cash = p ? Math.max(0, (p.buyIn || 0) - (p.amountSpent || 0)) : 0;
        const sellsProceeds = p ? p.breakdown.reduce((s, b) => s + (b.soldProceeds || 0), 0) : 0;
        const sellCount = p ? p.breakdown.filter((b) => (b.soldQty || 0) > 0).length : 0;
        const buyCount = p ? p.breakdown.length : 0;
        const rn = d.perInvestor[code] || (d.perInvestor[code] = {});
        rn.marketValue = p ? p.mvAtEnd : 0;
        rn.cash = cash;
        rn.totalValue = (rn.marketValue || 0) + (rn.cash || 0);
        rn.unrealized = p ? p.unrealizedAtEnd : 0;
        rn.realized = p ? p.realizedInWindow : 0;
        rn.dividends = p ? p.divsInWindow : 0;
        rn.invested = p ? p.amountSpent : 0;
        rn.netReturn = p ? p.netPnl : 0;
        rn.portfolioReturnPct = p ? p.pct : 0;
        rn.totalReturnPct = rn.portfolioReturnPct;
        gMV += rn.marketValue; gCash += rn.cash; gUnreal += rn.unrealized;
        gReal += rn.realized; gDiv += rn.dividends; gInv += rn.invested;
        gNet += rn.netReturn;

        const w = wm.perInvestor[code] || (wm.perInvestor[code] = {});
        w.realizedInWindow = p ? p.realizedInWindow : 0;
        w.dividendsInWindow = p ? p.divsInWindow : 0;
        w.buysInWindow = p ? p.amountSpent : 0;
        w.sellsInWindow = sellsProceeds;
        w.buyCount = buyCount;
        w.sellCount = sellCount;
        w.netPnlInWindow = p ? p.netPnl : 0;
        w.periodReturnPct = p ? p.pct : 0;
        gBuys += w.buysInWindow; gSells += w.sellsInWindow;
        gBuyCount += w.buyCount; gSellCount += w.sellCount;
        gNetPnl += w.netPnlInWindow;
      }

      d.group.marketValue = gMV;
      d.group.cash = gCash;
      d.group.totalValue = gMV + gCash;
      d.group.unrealized = gUnreal;
      d.group.realized = gReal;
      d.group.dividends = gDiv;
      d.group.invested = gInv;
      d.group.netReturn = gNet;
      d.group.portfolioReturnPct = gInv > 0 ? (gNet / gInv) * 100 : 0;

      wm.group.realizedInWindow = gReal;
      wm.group.dividendsInWindow = gDiv;
      wm.group.buysInWindow = gBuys;
      wm.group.sellsInWindow = gSells;
      wm.group.buyCount = gBuyCount;
      wm.group.sellCount = gSellCount;
      wm.group.netPnlInWindow = gNetPnl;
      wm.group.periodReturnPct = gInv > 0 ? (gNetPnl / gInv) * 100 : 0;

      d.leaderboards.period = comp.ranks.map((r) => ({ code: r.code, value: r.pct }));
    }

    // Slice an all-time per-investor series down to the selected window.
    function periodKey(p) {
      const y = /(\d{4})/.exec(p || ''); const yr = y ? +y[1] : 0;
      const q = /Q\s*([1-4])/i.exec(p || ''); return yr * 10 + (q ? +q[1] : 4);
    }
    function buildInvestorKpis(d) {
      const kpis = store.kpis || [];
      if (!kpis.length) return null;
      const canon = window.Portfolio.canonicalName;
      const periods = [...new Set(kpis.map((k) => k.period).filter(Boolean))].sort((a, b) => periodKey(a) - periodKey(b));
      const show = periods.slice(-2);
      if (!show.length) return null;
      const latest = show[show.length - 1];
      const peByCo = new Map();
      for (const k of kpis) if (k.period === latest && Number.isFinite(k.pe)) peByCo.set(canon(k.company), k.pe);

      const byCode = {};
      for (const code of INVESTOR_CODES) {
        byCode[code] = { rev: {}, profit: {}, pe: null };
        for (const p of show) { byCode[code].rev[p] = 0; byCode[code].profit[p] = 0; }
      }
      for (const k of kpis) {
        if (!show.includes(k.period)) continue;
        const split = window.Ledger.splitForSecurity(store.attributionMap, k.company);
        for (const { code, weight } of split) {
          if (!byCode[code]) continue;
          byCode[code].rev[k.period] += (k.yourRevNok || 0) * weight;
          byCode[code].profit[k.period] += (k.yourProfitNok || 0) * weight;
        }
      }
      for (const code of INVESTOR_CODES) {
        const hs = (d.perInvestor[code] && d.perInvestor[code].holdings) || [];
        let num = 0, den = 0;
        for (const h of hs) {
          const pe = peByCo.get(canon(h.security)); const mv = h.marketValue || 0;
          if (pe != null && mv > 0) { num += pe * mv; den += mv; }
        }
        byCode[code].pe = den > 0 ? num / den : null;
      }
      return { periods: show, byCode };
    }

    // Native-currency price return over a period, from the StockPrices
    // matrix (currency cancels in the ratio). Null → the cell shows "—".
    function periodReturnFor(security, fromDate) {
      const sec = store.registry.forName(security);
      if (!sec || !sec.ticker) return null;
      const today = new Date().toISOString().slice(0, 10);
      const base = window.Prices.priceOn(store.prices, sec.ticker, fromDate);
      const nowPx = window.Prices.priceOn(store.prices, sec.ticker, today);
      if (base == null || nowPx == null || !(base > 0)) return null;
      // Only meaningful if the series actually starts on/before fromDate.
      const series = store.prices.series.get(sec.ticker);
      if (!series || series[0].d > fromDate) return null;
      return ((nowPx - base) / base) * 100;
    }

    // Current portfolio table — replay-derived holdings priced by the matrix.
    function renderCurrentPortfolio() {
      const holds = (window.Portfolio.currentHoldings(store) || [])
        .slice().sort((a, b) => (b.marketValueNok || 0) - (a.marketValueNok || 0));
      if (!holds.length) {
        return window.UI.emptyState('No open positions',
          'Once the Nordnet transaction log has buys that are not fully sold, they show up here.');
      }
      const totalVal = holds.reduce((a, h) => a + (h.marketValueNok || 0), 0);
      const totalGain = holds.reduce((a, h) => a + (h.returnNok || 0), 0);
      const asOf = holds[0].snapshotDate ? ` · prices per ${holds[0].snapshotDate}` : '';
      const NO_PRICE = '<span class="text-muted" title="No price data yet — check Securities tab">—</span>';

      const now = new Date();
      const ytdStart = `${now.getUTCFullYear()}-01-01`;
      const y12 = new Date(now); y12.setUTCFullYear(y12.getUTCFullYear() - 1);
      const y12Start = y12.toISOString().slice(0, 10);
      const pctCell = (v, label) => v == null
        ? `<td class="text-right text-muted" data-label="${label}">—</td>`
        : `<td class="text-right ${pctClass(v)}" data-label="${label}">${fmtPct(v)}</td>`;

      const rows = holds.map((h) => {
        const unpriced = h.priced === false;
        const wgt = totalVal > 0 && !unpriced ? ((h.marketValueNok || 0) / totalVal) * 100 : null;
        return `
          <tr>
            <td data-label="Security"><strong>${escapeHtml(h.security)}</strong></td>
            <td class="text-right" data-label="Qty">${fmtQty(h.qty)}</td>
            <td class="text-right text-muted" data-label="Avg cost">${fmtNok(h.gav)}</td>
            <td class="text-right" data-label="Price">${unpriced ? NO_PRICE : fmtNok(h.currentPrice)}</td>
            <td class="text-right text-muted" data-label="Invested">${fmtNok((h.marketValueNok || 0) - (h.returnNok || 0))}</td>
            <td class="text-right" data-label="Value">${unpriced ? NO_PRICE : fmtNok(h.marketValueNok)}</td>
            <td class="text-right ${unpriced ? '' : pctClass(h.returnNok)}" data-label="Gain/loss">${unpriced ? NO_PRICE : fmtNok(h.returnNok)}</td>
            <td class="text-right ${unpriced ? '' : pctClass(h.returnPct)}" data-label="Return">${unpriced ? NO_PRICE : fmtPct(h.returnPct)}</td>
            ${pctCell(periodReturnFor(h.security, ytdStart), 'YTD')}
            ${pctCell(periodReturnFor(h.security, y12Start), '12m')}
            <td class="text-right text-muted" data-label="Weight">${wgt == null ? '—' : wgt.toFixed(1) + '%'}</td>
          </tr>`;
      }).join('');
      return `
        <div class="section-title">Current portfolio <span class="text-muted text-small">(${holds.length} positions${asOf}; YTD/12m are price return)</span> ${ii('holdings-table')}</div>
        <div style="overflow-x:auto">
          <table class="investor-table">
            <thead><tr>
              <th>Security</th><th class="text-right">Qty</th><th class="text-right">Avg cost</th>
              <th class="text-right">Price</th><th class="text-right">Invested</th><th class="text-right">Value</th>
              <th class="text-right">Gain/loss</th><th class="text-right">Return</th>
              <th class="text-right">YTD</th><th class="text-right">12m</th><th class="text-right">Weight</th>
            </tr></thead>
            <tbody>
              ${rows}
              <tr class="summary-row">
                <td data-label="">Total</td><td></td><td></td><td></td>
                <td class="text-right" data-label="Invested">${fmtNok(totalVal - totalGain)}</td>
                <td class="text-right" data-label="Value">${fmtNok(totalVal)}</td>
                <td class="text-right ${pctClass(totalGain)}" data-label="Gain/loss">${fmtNok(totalGain)}</td>
                <td></td><td></td><td></td><td></td>
              </tr>
            </tbody>
          </table>
        </div>
      `;
    }

    function priceFreshnessLine() {
      if (!window.Portfolio.usePriceMatrix(store)) {
        return `<div class="price-freshness stale">No price data — the StockPrices tab is empty. Install/run the Apps Script feed (see apps-script/README.md). ${ii('price-freshness')}</div>`;
      }
      const latest = store.prices.latestDate;
      const ageDays = Math.round((Date.now() - new Date(latest).getTime()) / 86400000);
      const stale = ageDays > 3;
      return `<div class="price-freshness ${stale ? 'stale' : ''}">Prices per ${latest}${stale ? ' (stale)' : ''} ${ii('price-freshness')}</div>`;
    }

    function paint(d) {
      const wm = d.windowMetrics;
      const ik = buildInvestorKpis(d);
      const rn = aggregateRn(d);
      const win = aggregateWin(wm);
      const filterLabel = selectedCodes.length
        ? `<span class="filter-chip">Filtered: <strong>${selectedCodes.join(', ')}</strong> <a href="#" onclick="event.preventDefault(); window.__clearFilter();">clear ×</a></span>`
        : '';
      const rnTitle = `Right now (${d.snapshotDate || '—'})`;
      const winTitle = selectedCodes.length ? `In this window · ${selectedCodes.join(', ')}` : 'In this window';
      const compBanner = !activeCompetition ? '' : (competitionMode
        ? `<div class="comp-banner active">
             <span>🏁 Competition mode: <strong>${escapeHtml(activeCompetition.competition.name)}</strong>
               <span class="text-muted text-small">(${activeCompetition.competition.start_date} → ${activeCompetition.competition.end_date})</span>
             </span>
             <button class="btn small ghost" onclick="window.__toggleCompetitionMode()">Back to all stats</button>
           </div>`
        : `<div class="comp-banner">
             <span>🏁 Active competition: <strong>${escapeHtml(activeCompetition.competition.name)}</strong>
               <span class="text-muted text-small">(${activeCompetition.competition.start_date} → ${activeCompetition.competition.end_date})</span>
             </span>
             <button class="btn small" onclick="window.__toggleCompetitionMode()">View competition stats</button>
           </div>`);

      const hasTx = (store.transactions || []).length > 0;
      if (!hasTx) {
        el.innerHTML = `
          <div class="hero"><div><h2>Here's the book.</h2></div></div>
          ${window.UI.emptyState('No transactions yet',
            'The Nordnet transaction tab is empty — paste the export into "Rådata fra nordnet" and reload.')}`;
        return;
      }

      el.innerHTML = `
        <div class="hero">
          <div>
            <h2>${sheetName ? `Here is the books for "${escapeHtml(sheetName)}".` : 'Here\'s the book.'}</h2>
            ${priceFreshnessLine()}
          </div>
          ${renderPicker(d.window)}
        </div>
        ${filterLabel ? `<div class="filter-row">${filterLabel}</div>` : ''}

        ${compBanner}

        <div class="section-title">${rnTitle}</div>
        <div class="kpi-grid">
          <div class="kpi-card"><div class="label">Total portfolio ${ii('total-value')}</div><div class="value">${fmtNok(rn.totalValue)}</div><div class="sub">positions + cash</div></div>
          <div class="kpi-card"><div class="label">Holdings MV ${ii('market-value')}</div><div class="value">${fmtNok(rn.marketValue)}</div><div class="sub">active positions</div></div>
          <div class="kpi-card"><div class="label">Dry powder ${ii('cash')}</div><div class="value">${fmtNok(rn.cash)}</div><div class="sub">${selectedCodes.length ? 'investor share' : 'uncommitted cash'}</div></div>
          <div class="kpi-card"><div class="label">Unrealized P/L ${ii('unrealized')}</div><div class="value ${pctClass(rn.unrealized)}">${fmtNok(rn.unrealized)}</div><div class="sub">mark-to-market</div></div>
        </div>

        <div class="section-title">${winTitle} <span class="text-muted text-small">${prettyRange(d.window)}</span> ${ii('window-metrics')}</div>
        <div class="kpi-grid">
          <div class="kpi-card"><div class="label">Period return</div><div class="value ${pctClass(win.periodReturnPct)}">${fmtPct(win.periodReturnPct)}</div><div class="sub">realized + dividends + price delta</div></div>
          <div class="kpi-card"><div class="label">Realized P/L</div><div class="value ${pctClass(win.realizedInWindow)}">${fmtNok(win.realizedInWindow)}</div><div class="sub">${win.sellCount || 0} sells</div></div>
          <div class="kpi-card"><div class="label">Dividends</div><div class="value">${fmtNok(win.dividendsInWindow)}</div><div class="sub">received in window</div></div>
          <div class="kpi-card"><div class="label">Capital deployed</div><div class="value">${fmtNok(win.buysInWindow)}</div><div class="sub">${win.buyCount || 0} buys</div></div>
          <div class="kpi-card"><div class="label">Net P/L</div><div class="value ${pctClass(win.netPnlInWindow)}">${fmtNok(win.netPnlInWindow)}</div><div class="sub">realized + divs + unrealized Δ</div></div>
        </div>

        ${renderCurrentPortfolio()}

        <div class="section-title">By investor <span class="text-muted text-small">(period stats reflect ${prettyRange(d.window)}${ik ? '; revenue/profit/P/E from Offisielle nøkkeltall, your share' : ''})</span> ${ii('investor-kpis')}</div>
        <div style="overflow-x:auto">
        <table class="investor-table">
          <thead><tr>
            <th>Investor</th>
            <th class="text-right">Total value <span class="text-muted text-small">(now)</span></th>
            <th class="text-right">Period return</th>
            <th class="text-right">Realized</th>
            <th class="text-right">Dividends</th>
            <th class="text-right">Bought</th>
            <th class="text-right">Sold</th>
            <th class="text-right">All-time return</th>
            ${ik ? ik.periods.map((p) => `<th class="text-right">Rev ${escapeHtml(p)}</th><th class="text-right">Profit ${escapeHtml(p)}</th>`).join('') + '<th class="text-right">P/E</th>' : ''}
          </tr></thead>
          <tbody>
            ${Object.entries(d.perInvestor).map(([code, s]) => {
              const w = wm.perInvestor[code] || {};
              const rowClass = selectedCodes.length
                ? (selectedCodes.includes(code) ? 'row-link selected-row' : 'row-link dimmed-row')
                : 'row-link';
              return `
                <tr class="${rowClass}" onclick="location.hash='#/investors/${encodeURIComponent(code)}'">
                  <td data-label="Investor"><strong>${code}</strong> <span class="text-muted text-small">${names[code] || ''}</span></td>
                  <td class="text-right" data-label="Total value">${fmtNok(s.totalValue)}</td>
                  <td class="text-right ${pctClass(w.periodReturnPct)}" data-label="Period return"><strong>${fmtPct(w.periodReturnPct)}</strong></td>
                  <td class="text-right ${pctClass(w.realizedInWindow)}" data-label="Realized">${fmtNok(w.realizedInWindow)}</td>
                  <td class="text-right" data-label="Dividends">${fmtNok(w.dividendsInWindow)}</td>
                  <td class="text-right text-muted" data-label="Bought">${fmtNok(w.buysInWindow)}</td>
                  <td class="text-right text-muted" data-label="Sold">${fmtNok(w.sellsInWindow)}</td>
                  <td class="text-right ${pctClass(s.portfolioReturnPct)}" data-label="All-time return">${fmtPct(s.portfolioReturnPct)}</td>
                  ${ik ? (() => { const k = ik.byCode[code] || { rev: {}, profit: {}, pe: null }; return ik.periods.map((p) => `<td class="text-right text-muted" data-label="Rev ${escapeHtml(p)}">${fmtNok(k.rev[p])}</td><td class="text-right ${pctClass(k.profit[p])}" data-label="Profit ${escapeHtml(p)}">${fmtNok(k.profit[p])}</td>`).join('') + `<td class="text-right text-muted" data-label="P/E">${k.pe != null ? k.pe.toFixed(1) : '—'}</td>`; })() : ''}
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
        </div>
      `;
      wirePicker();
    }

    function renderPicker(win) {
      return `
        <div class="range-picker" id="range-picker" role="group" aria-label="Time range">
          ${PRESETS.map((p) => `
            <button class="preset ${win.preset === p.id ? 'active' : ''}" data-preset="${p.id}" aria-pressed="${win.preset === p.id}">${p.label}</button>
          `).join('')}
          <span class="sep" id="custom-sep" style="display:${win.preset === 'custom' ? 'inline' : 'none'}">·</span>
          <input type="date" id="date-from" aria-label="From date" value="${win.from || ''}" style="display:${win.preset === 'custom' ? 'inline-block' : 'none'}" />
          <span class="sep" id="custom-sep2" style="display:${win.preset === 'custom' ? 'inline' : 'none'}">→</span>
          <input type="date" id="date-to" aria-label="To date" value="${win.to || ''}" style="display:${win.preset === 'custom' ? 'inline-block' : 'none'}" />
        </div>
      `;
    }

    function wirePicker() {
      el.querySelectorAll('#range-picker .preset').forEach((btn) => {
        btn.addEventListener('click', () => {
          const p = btn.dataset.preset;
          if (p === 'custom') {
            current.preset = 'custom';
            el.querySelector('#custom-sep').style.display = 'inline';
            el.querySelector('#custom-sep2').style.display = 'inline';
            el.querySelector('#date-from').style.display = 'inline-block';
            el.querySelector('#date-to').style.display = 'inline-block';
            el.querySelectorAll('#range-picker .preset').forEach((b) => {
              b.classList.toggle('active', b.dataset.preset === 'custom');
              b.setAttribute('aria-pressed', String(b.dataset.preset === 'custom'));
            });
            return;
          }
          current.preset = p; current.from = null; current.to = null;
          refresh();
        });
      });
      const fromInput = el.querySelector('#date-from');
      const toInput = el.querySelector('#date-to');
      const onChange = () => {
        const from = fromInput.value; const to = toInput.value;
        if (!from || !to) return;
        current.preset = 'custom'; current.from = from; current.to = to;
        refresh();
      };
      fromInput.addEventListener('change', onChange);
      toInput.addEventListener('change', onChange);
    }

    function prettyRange(win) {
      const map = { '1m': 'last month', '6m': 'last 6 months', 'ytd': 'YTD', '1y': 'last year', 'all': 'all-time', 'custom': `${win.from} → ${win.to}` };
      return map[win.preset] || `${win.from} → ${win.to}`;
    }

    refresh();

    return function cleanup() {
      delete window.__toggleCompetitionMode;
      delete window.__clearFilter;
    };
  };
})();
