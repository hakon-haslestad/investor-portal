// Investors view — #/investors (overview), #/investors/game (The Game),
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
    const { store } = ctx;
    const { fmtNok, fmtPct, pctClass } = window.Fmt;
    const UI = window.UI;
    const names = window.Copy.namesFromMembers(store.members);
    const dash = window.Portfolio.buildDashboard(store);
    const codes = window.Ledger.INVESTOR_CODES.slice()
      .sort((a, b) => (dash.perInvestor[b].totalReturnPct || 0) - (dash.perInvestor[a].totalReturnPct || 0));

    const rows = codes.map((code) => {
      const s = dash.perInvestor[code];
      return {
        attrs: `class="row-link" data-code="${UI.esc(code)}" tabindex="0" role="link" aria-label="Open ${UI.esc(names[code] || code)}"`,
        cells: [
          `${UI.investorChip(code)} <span class="text-muted">${UI.esc(names[code] || '')}</span>`,
          `<span class="text-right">${fmtNok(s.totalValue)}</span>`,
          fmtNok(s.marketValue),
          `<span class="${pctClass(s.realized)}">${fmtNok(s.realized)}</span>`,
          `<span class="${pctClass(s.unrealized)}">${fmtNok(s.unrealized)}</span>`,
          fmtNok(s.dividends),
          `<strong class="${pctClass(s.portfolioReturnPct)}">${fmtPct(s.portfolioReturnPct)}</strong>`,
          `${s.holdings.length}`,
        ],
      };
    });

    el.innerHTML = `
      <div class="hero"><h2>Investors ${UI.infoIcon('investor-kpis')}</h2>
        <div class="when">Every krone attributed via Dim-values — argue with the sheet, not the portal.</div>
      </div>
      ${SUBTABS('overview')}
      ${UI.table([
        { label: 'Investor' },
        { label: 'Total value', className: 'text-right' },
        { label: 'Stocks MV', className: 'text-right' },
        { label: 'Realized', className: 'text-right' },
        { label: 'Unrealized', className: 'text-right' },
        { label: 'Dividends', className: 'text-right' },
        { label: 'Return %', className: 'text-right' },
        { label: 'Positions', className: 'text-right' },
      ], rows, { caption: 'Per-investor summary' })}
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

    el.innerHTML = `
      ${SUBTABS('overview')}
      <div class="hero">
        <h2>${UI.investorChip(code)} ${UI.esc(displayName)}</h2>
        <div class="when"><a href="#/investors">← all investors</a></div>
      </div>
      <div class="flash success">${verdict}</div>

      ${UI.kpiGrid([
        { label: 'Total value', value: fmtNok(s.totalValue), info: 'investor-kpis' },
        { label: 'Stocks MV', value: fmtNok(s.marketValue), info: 'market-value' },
        { label: 'Dry powder (share)', value: fmtNok(s.cash), info: 'cash' },
        { label: 'Total invested', value: fmtNok(s.invested), info: 'invested' },
        { label: 'Realized', value: fmtNok(s.realized), tone: pctClass(s.realized), info: 'realized' },
        { label: 'Unrealized', value: fmtNok(s.unrealized), tone: pctClass(s.unrealized), info: 'unrealized' },
        { label: 'Dividends', value: fmtNok(s.dividends), info: 'dividends' },
        { label: 'Return %', value: `<strong>${fmtPct(s.portfolioReturnPct)}</strong>`, tone: pctClass(s.portfolioReturnPct), info: 'return-pct' },
      ])}

      <div id="equity-chart"></div>

      ${UI.section(`Current holdings (${s.holdings.length})`, { info: 'holdings-table' })}
      ${s.holdings.length === 0
        ? '<p class="text-muted">No active positions. All cashed out.</p>'
        : UI.table([
            { label: 'Security' },
            { label: 'Qty', className: 'text-right' },
            { label: 'Avg cost', className: 'text-right' },
            { label: 'Current px', className: 'text-right' },
            { label: 'Market value', className: 'text-right' },
            { label: 'Unrealized', className: 'text-right' },
            { label: 'U/L %', className: 'text-right' },
            { label: 'Realized so far', className: 'text-right' },
            { label: 'Research', className: 'links' },
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
          { label: 'Security' },
          { label: 'Invested', className: 'text-right' },
          { label: 'Proceeds', className: 'text-right' },
          { label: 'Dividends', className: 'text-right' },
          { label: 'Realized', className: 'text-right' },
          { label: 'Net result', className: 'text-right' },
          { label: 'Return %', className: 'text-right' },
          { label: 'First → last' },
          { label: 'Research', className: 'links' },
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
        { label: 'Date' },
        { label: 'Type' },
        { label: 'Security' },
        { label: 'Qty (share)', className: 'text-right' },
        { label: 'Price', className: 'text-right' },
        { label: 'Amount (share)', className: 'text-right' },
      ], detail.recent.map((t) => [
        `<span class="text-small">${t.tradeDate || ''}</span>`,
        `<span class="tag">${UI.esc(t.type)}</span>`,
        t.security ? UI.esc(t.security) : '<span class="text-muted">—</span>',
        fmtQty(t.qty),
        fmtNok(t.price),
        `<span class="${pctClass(t.amount)}">${fmtNok(t.amount)}</span>`,
      ]), { empty: 'No transactions attributed yet.' })}
    `;

    // Daily equity curve for this investor (needs the price matrix).
    if (window.Portfolio.usePriceMatrix(store)) {
      const series = window.TimeSeries.buildPortfolioValueSeries(store)
        .map((p) => ({ date: p.date, y: p.perInvestor[code] || 0 }))
        .filter((p) => p.y > 0);
      if (series.length >= 2) {
        const mount = el.querySelector('#equity-chart');
        mount.className = 'chart-wrap';
        const head = document.createElement('div');
        head.className = 'section-head';
        head.innerHTML = `<h3 class="section-title">Equity curve ${UI.infoIcon('equity-curve')}</h3>`;
        mount.appendChild(head);
        mount.appendChild(window.Charts.multiLine({
          series: [{ name: displayName, color: window.Ledger.INVESTOR_COLORS[code] || '#1FE0CE', points: series }],
          width: 1180, height: 300, interactive: true,
          title: 'Portfolio value (NOK, daily)',
        }));
      }
    }
  }

  // ─── The Game ─────────────────────────────────────────────────────────────

  async function renderGame(el, ctx) {
    const { store } = ctx;
    const { fmtNok, fmtPct, escapeHtml, pctClass } = window.Fmt;
    const names = window.Copy.namesFromMembers(store.members);
    const CODES = window.Ledger.INVESTOR_CODES;
    const canon = window.Portfolio.canonicalName;
    let dead = false; // set by cleanup when the view unmounts mid-spin

    let competitions = [];
    try { competitions = await window.CompetitionsData.listCompetitions(); }
    catch (_e) { /* optional */ }
    const compById = new Map(competitions.map((c) => [c.competition.id, c]));

    const _today = new Date();
    const _todayStr = _today.toISOString().slice(0, 10);
    const _yearAgo = new Date(_today); _yearAgo.setUTCFullYear(_yearAgo.getUTCFullYear() - 1);

    const state = {
      source: 'all', scope: 'window', guess: false,
      customFrom: _yearAgo.toISOString().slice(0, 10),
      customTo: _todayStr,
      lastKey: null, picked: new Set(),
    };

    function computeWindow(preset) {
      const now = new Date();
      const todayStr = now.toISOString().slice(0, 10);
      let earliest = todayStr;
      for (const t of store.transactions || []) {
        if (t.tradeDate && t.tradeDate < earliest) earliest = t.tradeDate;
      }
      const addYears = (d, n) => {
        const x = new Date(d); x.setUTCFullYear(x.getUTCFullYear() + n); return x.toISOString().slice(0, 10);
      };
      switch (preset) {
        case '1y': return { from: addYears(now, -1), to: todayStr };
        case '2y': return { from: addYears(now, -2), to: todayStr };
        case '3y': return { from: addYears(now, -3), to: todayStr };
        case 'custom': return { from: state.customFrom, to: state.customTo };
        case 'all': return { from: earliest, to: todayStr };
        case 'ytd':
        default: return { from: `${now.getUTCFullYear()}-01-01`, to: todayStr };
      }
    }

    const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

    function activityDates(security, code) {
      const c = canon(security);
      let first = null, last = null;
      for (const tx of store.transactions || []) {
        if (!tx.security || !tx.tradeDate) continue;
        if (canon(tx.security) !== c) continue;
        const cat = window.Ledger.classify(tx.type);
        if (cat !== 'BUY' && cat !== 'SELL') continue;
        const split = window.Ledger.splitForSecurity(store.attributionMap, tx.security);
        if (!split.some((s) => s.code === code)) continue;
        if (!first || tx.tradeDate < first) first = tx.tradeDate;
        if (!last || tx.tradeDate > last) last = tx.tradeDate;
      }
      return { first, last };
    }

    const overlapsWindow = (first, last, from, to) => {
      const f = first || last, l = last || first;
      return f != null && f <= to && l >= from;
    };

    function poolFromScored(scored) {
      const from = scored.competition.start_date;
      const to = scored.competition.end_date;
      const out = [];
      for (const r of scored.ranks || []) {
        for (const b of r.breakdown || []) {
          const heldCost = b.costSum || 0;
          const soldCost = Math.max((b.soldProceeds || 0) - (b.realized || 0), 0);
          const purchaseAmount = heldCost + soldCost;
          const pnlNok = (b.unrealized || 0) + (b.realized || 0) + (b.divs || 0);
          const sold = (b.qty || 0) <= 1e-6 && (b.soldQty || 0) > 0;
          out.push({
            investor: r.code,
            investorName: names[r.code] || r.code,
            security: b.security,
            win: pnlNok >= 0, pnlNok,
            pnlPct: purchaseAmount > 0 ? (pnlNok / purchaseAmount) * 100 : 0,
            purchaseAmount,
            currentOrSoldValue: (b.marketValueAtEnd || 0) + (b.soldProceeds || 0),
            sold, from, to,
          });
        }
      }
      return out;
    }

    function poolFromPeriodWindow(from, to) {
      const synthetic = { id: '_game', name: 'Game', start_date: from, end_date: to };
      const participants = CODES.map((code) => ({ investor_code: code, team_label: code, buy_in_nok: 0 }));
      const scored = window.CompetitionEngine.scoreCompetition(store, synthetic, participants);
      scored.competition = synthetic;
      return poolFromScored(scored);
    }

    function poolFromLifetime(from, to, isAll) {
      const dash = window.Portfolio.buildDashboard(store);
      const out = [];
      for (const code of CODES) {
        const inv = dash.perInvestor[code];
        if (!inv) continue;
        for (const h of inv.holdings || []) {
          if (!isAll) {
            const { first, last } = activityDates(h.security, code);
            if (!overlapsWindow(first, last, from, to)) continue;
          }
          const purchaseAmount = (h.avgCost || 0) * (h.qty || 0);
          const pnlNok = h.unrealized || 0;
          out.push({
            investor: code, investorName: names[code] || code, security: h.security,
            win: pnlNok >= 0, pnlNok,
            pnlPct: purchaseAmount > 0 ? (pnlNok / purchaseAmount) * 100 : 0,
            purchaseAmount, currentOrSoldValue: h.marketValue || 0,
            sold: false, from, to,
          });
        }
        for (const p of window.Portfolio.previousHoldings(store, code)) {
          if (!isAll && !overlapsWindow(p.firstDate, p.lastDate, from, to)) continue;
          const pnlNok = p.netResult != null ? p.netResult : (p.realized || 0) + (p.dividends || 0);
          out.push({
            investor: code, investorName: names[code] || code, security: p.security,
            win: pnlNok >= 0, pnlNok,
            pnlPct: (p.invested || 0) > 0 ? (pnlNok / p.invested) * 100 : 0,
            purchaseAmount: p.invested || 0, currentOrSoldValue: p.proceeds || 0,
            sold: true, from, to,
          });
        }
      }
      return out;
    }

    function isRightsArtifact(name) {
      const s = String(name || '');
      return /\bTR\b/.test(s) || /(tegningsrett|tegningsret|emisjon|fortrinnsrett|rettigheter)/i.test(s);
    }

    function refinePool(pool) {
      const byStock = new Map();
      for (const e of pool) {
        if (isRightsArtifact(e.security)) continue;
        const key = canon(e.security);
        let g = byStock.get(key);
        if (!g) {
          g = {
            security: e.security, from: e.from, to: e.to,
            purchaseAmount: 0, pnlNok: 0, currentOrSoldValue: 0, soldAll: true,
            owners: new Map(),
          };
          byStock.set(key, g);
        }
        g.purchaseAmount += e.purchaseAmount || 0;
        g.pnlNok += e.pnlNok || 0;
        g.currentOrSoldValue += e.currentOrSoldValue || 0;
        if (!e.sold) g.soldAll = false;
        const o = g.owners.get(e.investor) || { code: e.investor, name: e.investorName, purchaseAmount: 0 };
        o.purchaseAmount += e.purchaseAmount || 0;
        g.owners.set(e.investor, o);
      }
      return [...byStock.values()].map((g) => {
        const owners = [...g.owners.values()].sort((a, b) => b.purchaseAmount - a.purchaseAmount);
        return {
          security: g.security,
          investors: owners,
          investor: owners[0] ? owners[0].code : '',
          investorName: owners.map((o) => o.name).join(' + '),
          purchaseAmount: g.purchaseAmount,
          pnlNok: g.pnlNok,
          currentOrSoldValue: g.currentOrSoldValue,
          pnlPct: g.purchaseAmount > 0 ? (g.pnlNok / g.purchaseAmount) * 100 : 0,
          win: g.pnlNok >= 0,
          sold: g.soldAll,
          from: g.from, to: g.to,
        };
      });
    }

    function buildPool() {
      let raw;
      if (state.source.startsWith('comp:')) {
        const c = compById.get(state.source.slice(5));
        if (!c) return [];
        const scored = window.CompetitionEngine.scoreCompetition(store, c.competition, c.participants);
        scored.competition = c.competition;
        raw = poolFromScored(scored);
      } else {
        const { from, to } = computeWindow(state.source);
        raw = state.scope === 'lifetime'
          ? poolFromLifetime(from, to, state.source === 'all')
          : poolFromPeriodWindow(from, to);
      }
      return refinePool(raw);
    }

    // ── price timeline — real daily closes when the price matrix has data ──
    function txPriceNok(tx) {
      const cur = (tx.currency || '').toString().toUpperCase().trim();
      const fx = (!cur || cur === 'NOK') ? 1 : (Number(tx.fxRate) > 0 ? tx.fxRate : 1);
      return tx.price * fx;
    }

    function priceSeriesForSecurity(security, code, from, to) {
      const c = canon(security);
      const codes = new Set(Array.isArray(code) ? code : [code]);
      const markers = [];
      for (const tx of store.transactions || []) {
        if (!tx.security || !tx.tradeDate) continue;
        if (tx.tradeDate < from || tx.tradeDate > to) continue;
        if (canon(tx.security) !== c) continue;
        const isTrade = tx.type === 'KJØPT' || tx.type === 'SALG';
        if (!isTrade) continue;
        const split = window.Ledger.splitForSecurity(store.attributionMap, tx.security);
        if (split.some((s) => codes.has(s.code))) {
          markers.push({ date: tx.tradeDate, type: tx.type === 'SALG' ? 'sell' : 'buy' });
        }
      }

      // Genuine daily closes from StockPrices when available.
      if (window.Portfolio.usePriceMatrix(store)) {
        const daily = window.TimeSeries.buildSecurityPriceSeries(store, security, from, to);
        if (daily.length >= 2) return { points: daily, markers };
      }

      // Fallback for an unpriced ticker: sketch the curve from the actual
      // in-window trade prices (better than no chart at all).
      const byDate = new Map();
      for (const tx of store.transactions || []) {
        if (!tx.security || !tx.tradeDate) continue;
        if (tx.tradeDate < from || tx.tradeDate > to) continue;
        if (canon(tx.security) !== c) continue;
        const isTrade = tx.type === 'KJØPT' || tx.type === 'SALG';
        if (isTrade && Number.isFinite(tx.price) && tx.price > 0) {
          byDate.set(tx.tradeDate, { date: tx.tradeDate, price: txPriceNok(tx) });
        }
      }
      const points = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
      return { points, markers };
    }

    function holdingText(entry) {
      const { first, last } = activityDates(entry.security, entry.investor);
      if (!first) return '—';
      const end = entry.sold ? (last || first) : new Date().toISOString().slice(0, 10);
      const days = daysBetween(first, end);
      if (days < 0) return '—';
      if (days < 60) return `${days} days`;
      const months = Math.round(days / 30.4);
      if (months < 24) return `${months} mo`;
      return `${(days / 365).toFixed(1)} yr`;
    }

    function spin(pool) {
      if (!pool.length) return null;
      const keyOf = (e) => e.investor + '|' + e.security;
      let available = pool.filter((e) => !state.picked.has(keyOf(e)));
      if (!available.length) {
        state.picked.clear();
        available = pool.filter((e) => keyOf(e) !== state.lastKey);
        if (!available.length) available = pool;
      }
      const pick = available[Math.floor(Math.random() * available.length)];
      const key = keyOf(pick);
      state.picked.add(key);
      state.lastKey = key;
      return pick;
    }

    function chartable(series) {
      return series.points.length >= 2 &&
        daysBetween(series.points[0].date, series.points[series.points.length - 1].date) >= 30;
    }

    const mountEl = () => el.querySelector('#game-mount');

    function renderResult(entry, opts = {}) {
      const mount = mountEl();
      if (dead || !mount) return;
      if (!entry) {
        mount.innerHTML =
          '<div class="flash">No positions in this selection. Try <strong>All time</strong>, switch the scope, or pick another competition.</div>';
        return;
      }
      const cls = entry.win ? 'win' : 'loss';
      const verdict = entry.win ? 'Hand out a shot 🥃' : 'Take a shot 🥃';
      const valueLabel = entry.sold ? 'Sold for' : "Today's value";
      const series = priceSeriesForSecurity(entry.security, (entry.investors || []).map((o) => o.code), entry.from, entry.to);
      const note = opts.note ? `<div class="guess-note">${escapeHtml(opts.note)}</div>` : '';

      mount.innerHTML = `
        <div class="game-result ${cls}">
          ${note}
          <div class="verdict">${escapeHtml(verdict)}</div>
          <div class="who"><span class="who-name">${escapeHtml(entry.investorName)}</span></div>
          <div class="stock">${escapeHtml(entry.security)} <span class="who-state">· ${entry.sold ? 'sold' : 'holding'}</span></div>
          <div class="pnl ${pctClass(entry.pnlNok)}">${fmtNok(entry.pnlNok)} · ${fmtPct(entry.pnlPct, true)}</div>
          <div class="detail-grid">
            <div class="kpi-card"><div class="label">Put in</div><div class="value">${fmtNok(entry.purchaseAmount)}</div></div>
            <div class="kpi-card"><div class="label">${escapeHtml(valueLabel)}</div><div class="value">${fmtNok(entry.currentOrSoldValue)}</div></div>
            <div class="kpi-card"><div class="label">Held</div><div class="value">${escapeHtml(holdingText(entry))}</div></div>
          </div>
          <div id="game-chart"></div>
        </div>`;
      if (chartable(series)) {
        mount.querySelector('#game-chart').appendChild(
          window.Charts.priceChart({ points: series.points, markers: series.markers, yUnit: 'NOK', invested: entry.purchaseAmount })
        );
      }
    }

    function renderGuess(entry) {
      const mount = mountEl();
      if (dead || !mount) return;
      const series = priceSeriesForSecurity(entry.security, (entry.investors || []).map((o) => o.code), entry.from, entry.to);
      mount.innerHTML = `
        <div class="game-result guess">
          <div class="guess-prompt">Guess the stock 🤔</div>
          <div class="who-state">Whose is it? Up or down? Call it before the reveal.</div>
          <div id="game-chart"></div>
          <div style="margin-top:16px"><button class="btn game-spin" id="reveal">Reveal 👀</button></div>
        </div>`;
      mount.querySelector('#game-chart').appendChild(
        window.Charts.priceChart({ points: series.points, markers: series.markers, yUnit: 'NOK' })
      );
      mount.querySelector('#reveal').addEventListener('click', () => renderResult(entry));
    }

    function doSpin() {
      const pool = buildPool();
      if (!pool.length) { renderResult(null); return; }
      const final = spin(pool);
      const guess = state.guess;
      const mount = mountEl();
      if (!mount) return;
      const btn = el.querySelector('#spin');
      if (btn) { btn.disabled = true; }

      mount.innerHTML = `
        <div class="game-result spinning">
          <div class="verdict"><span class="spin-dice">🎲</span></div>
          <div class="who"><span class="who-name" id="spin-name">${guess ? 'Mystery stock' : ''}</span></div>
          <div class="stock" id="spin-stock"></div>
        </div>`;
      const nameEl = guess ? null : mount.querySelector('#spin-name');
      const stockEl = mount.querySelector('#spin-stock');
      const mask = (s) => '▓'.repeat(Math.max(3, Math.min(10, (s || '').length)));

      const finish = () => {
        if (dead || !mountEl()) return;
        if (btn) { btn.disabled = false; }
        if (!guess) { renderResult(final); return; }
        const series = priceSeriesForSecurity(final.security, (final.investors || []).map((o) => o.code), final.from, final.to);
        if (chartable(series)) renderGuess(final);
        else renderResult(final, { note: 'Not enough price history to guess — here\'s the answer.' });
      };

      const delays = [55, 55, 60, 70, 85, 105, 130, 160, 195, 235, 280, 330];
      let i = 0;
      const tick = () => {
        if (dead || !mountEl()) return; // view unmounted mid-spin
        const rnd = pool[Math.floor(Math.random() * pool.length)];
        if (nameEl) nameEl.textContent = rnd.investorName;
        if (stockEl) stockEl.textContent = guess ? mask(rnd.security) : rnd.security;
        if (i >= delays.length) { finish(); return; }
        setTimeout(tick, delays[i++]);
      };
      tick();
    }

    function compOptions() {
      if (!competitions.length) return '';
      const opts = competitions
        .slice()
        .sort((a, b) => (b.competition.start_date || '').localeCompare(a.competition.start_date || ''))
        .map((c) => {
          const id = c.competition.id;
          const label = `${c.competition.name} (${c.competition.start_date || '?'} → ${c.competition.end_date || '?'})`;
          const sel = state.source === `comp:${id}` ? ' selected' : '';
          return `<option value="comp:${escapeHtml(id)}"${sel}>${escapeHtml(label)}</option>`;
        }).join('');
      return `<select id="comp-select" class="preset" aria-label="Competition"><option value="">— competition —</option>${opts}</select>`;
    }

    function render() {
      if (dead) return;
      const isComp = state.source.startsWith('comp:');
      const periods = [
        { id: 'all', label: 'All time' },
        { id: '1y', label: '1 Year' },
        { id: '2y', label: '2 Years' },
        { id: '3y', label: '3 Years' },
        { id: 'ytd', label: 'YTD' },
        { id: 'custom', label: 'Custom' },
      ];
      el.innerHTML = `
        <div class="hero">
          <h2>The Game 🎲🍺 ${window.UI.infoIcon('the-game')}</h2>
          <div class="when">Spin to draw a random stock. Green = hand out a shot. Red = take a shot.</div>
        </div>

        <div class="section-title" id="source-label">Source</div>
        <div class="range-picker" id="source-picker" role="group" aria-labelledby="source-label">
          ${periods.map((p) =>
            `<button class="preset ${!isComp && state.source === p.id ? 'active' : ''}" data-period="${p.id}" aria-pressed="${!isComp && state.source === p.id}">${p.label}</button>`
          ).join('')}
          ${state.source === 'custom' ? `
            <input type="date" id="custom-from" aria-label="From date" value="${state.customFrom}" max="${state.customTo}" />
            <span class="sep">→</span>
            <input type="date" id="custom-to" aria-label="To date" value="${state.customTo}" min="${state.customFrom}" />
          ` : ''}
          ${compOptions()}
        </div>

        <div id="scope-section" style="${isComp ? 'display:none' : ''}">
          <div class="section-title" id="scope-label">Scope</div>
          <div class="range-picker" id="scope-picker" role="group" aria-labelledby="scope-label">
            <button class="preset ${state.scope === 'window' ? 'active' : ''}" data-scope="window" aria-pressed="${state.scope === 'window'}">New bets in window</button>
            <button class="preset ${state.scope === 'lifetime' ? 'active' : ''}" data-scope="lifetime" aria-pressed="${state.scope === 'lifetime'}">Lifetime result</button>
          </div>
        </div>

        <div class="section-title" id="guess-label">Guess first</div>
        <div class="range-picker" id="guess-picker" role="group" aria-labelledby="guess-label">
          <button class="preset ${!state.guess ? 'active' : ''}" data-guess="off" aria-pressed="${!state.guess}">Instant reveal</button>
          <button class="preset ${state.guess ? 'active' : ''}" data-guess="on" aria-pressed="${state.guess}">Guess the stock 🤔</button>
        </div>

        <div style="margin:18px 0">
          <button class="btn game-spin" id="spin">🎲 Spin</button>
        </div>
        <div id="game-mount"></div>
      `;

      el.querySelectorAll('#source-picker [data-period]').forEach((btn) => {
        btn.addEventListener('click', () => {
          state.source = btn.getAttribute('data-period');
          state.lastKey = null; state.picked.clear();
          render();
        });
      });
      const cf = el.querySelector('#custom-from');
      const ct = el.querySelector('#custom-to');
      if (cf) cf.addEventListener('change', () => {
        if (cf.value) { state.customFrom = cf.value; state.lastKey = null; state.picked.clear(); if (ct) ct.min = cf.value; }
      });
      if (ct) ct.addEventListener('change', () => {
        if (ct.value) { state.customTo = ct.value; state.lastKey = null; state.picked.clear(); if (cf) cf.max = ct.value; }
      });
      const sel = el.querySelector('#comp-select');
      if (sel) {
        sel.addEventListener('change', () => {
          if (sel.value) { state.source = sel.value; state.lastKey = null; state.picked.clear(); render(); }
        });
      }
      el.querySelectorAll('#scope-picker [data-scope]').forEach((btn) => {
        btn.addEventListener('click', () => {
          state.scope = btn.getAttribute('data-scope');
          state.lastKey = null; state.picked.clear();
          render();
        });
      });
      el.querySelectorAll('#guess-picker [data-guess]').forEach((btn) => {
        btn.addEventListener('click', () => {
          state.guess = btn.getAttribute('data-guess') === 'on';
          render();
        });
      });
      el.querySelector('#spin').addEventListener('click', doSpin);
    }

    render();
    return () => { dead = true; };
  }

  // ─── Entry point ──────────────────────────────────────────────────────────

  window.Views.investors = async function (el, ctx) {
    const sub = (ctx.params[0] || '').trim();
    if (!sub) { renderOverview(el, ctx); return; }
    if (sub.toLowerCase() === 'game') { location.replace('#/game'); return; }
    renderDetail(el, ctx, decodeURIComponent(sub).toUpperCase());
  };

  // The Game is its own top-level tab.
  window.Views.game = async function (el, ctx) {
    return renderGame(el, ctx);
  };
})();
