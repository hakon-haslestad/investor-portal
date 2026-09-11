// Portfolio view — three sub-tabs consolidating the old standalone pages:
//   holdings  — current group holdings from the replay + StockPrices matrix
//               (new page; per-security teal price chart on row click)
//   report    — trading activity (old portfolio-report.js) + the monthly
//               accounting ledger (old reports.js) as a second section
//   explorer  — raw Nordnet grid with flat/pivot modes (old data.js)

(function () {
  window.Views = window.Views || {};

  const SUBTABS = [
    { key: 'holdings', label: 'Holdings', href: '#/portfolio/holdings' },
    { key: 'activity', label: 'Activity', href: '#/portfolio/activity' },
  ];

  window.Views.portfolio = async function (el, ctx) {
    let active = ctx.params[0] || 'holdings';
    // The old Report / Data explorer sub-tabs merged into Activity.
    if (active === 'report' || active === 'explorer') {
      location.replace('#/portfolio/activity');
      return;
    }
    el.innerHTML = `
      <div class="hero">
        <h2>Portfolio</h2>
        <div class="when" id="pf-when"></div>
      </div>
      ${window.UI.subTabs(SUBTABS, active)}
      <div id="pf-body"></div>
    `;
    const body = el.querySelector('#pf-body');
    if (active === 'activity') renderActivity(body, ctx);
    else renderHoldings(body, ctx);
  };

  // ─── Holdings ──────────────────────────────────────────────────────────────

  function priceFreshnessNote(store) {
    if (!window.Portfolio.usePriceMatrix(store)) {
      return `<span class="price-freshness stale">No price data — the StockPrices tab is empty. Install/run the Apps Script feed. ${window.UI.infoIcon('price-freshness')}</span>`;
    }
    const approxCount = window.Portfolio.currentHoldings(store).filter((h) => h.approx).length;
    const approxNote = approxCount
      ? ` · <span class="price-freshness stale">${approxCount} position${approxCount === 1 ? '' : 's'} ≈ at last trade price (FX/market data missing)</span>`
      : '';
    return `<span class="price-freshness">Prices as of ${store.prices.latestDate}${approxNote} ${window.UI.infoIcon('price-freshness')}</span>`;
  }

  function ownersOf(store, security) {
    const split = window.Ledger.splitForSecurity(store.attributionMap, security);
    if (!split.length) return '<span class="text-muted">—</span>';
    return split.map((s) => window.UI.investorChip(s.code)).join(' ');
  }

  function renderHoldings(body, ctx) {
    const { store } = ctx;
    const { fmtNok, fmtPct, fmtQty, pctClass, escapeHtml } = window.Fmt;
    const holdings = window.Portfolio.currentHoldings(store);
    const cash = window.Portfolio.cash.latestSaldo(store);
    const totalMv = holdings.reduce((a, h) => a + (h.marketValueNok || 0), 0);
    const unrealized = holdings.reduce((a, h) => a + (h.returnNok || 0), 0);

    document.getElementById('pf-when').innerHTML = priceFreshnessNote(store);

    // Period comparison: value every KPI against the selected window's start.
    let preset = 'ytd';
    try { preset = JSON.parse(localStorage.getItem('portal.holdings.range') || '{}').preset || 'ytd'; } catch (_e) {}
    const win = window.Portfolio.computeWindow(store, preset);
    const then = window.Portfolio.usePriceMatrix(store) ? window.Portfolio.groupValueAt(store, win.from) : null;
    const delta = (now, was) => {
      if (!then || was == null || !(Math.abs(was) > 0.5)) return null;
      const pct = ((now - was) / Math.abs(was)) * 100;
      return `<span class="${pctClass(pct)}">${fmtPct(pct)}</span> vs ${win.from}`;
    };

    const kpis = window.UI.kpiGrid([
      { label: 'Market value', value: fmtNok(totalMv), sub: delta(totalMv, then && then.mv) || '', info: 'market-value' },
      { label: 'Cash', value: fmtNok(cash), sub: delta(cash, then && then.cash) || 'latest Nordnet saldo', info: 'cash' },
      { label: 'Total value', value: fmtNok(totalMv + cash), sub: delta(totalMv + cash, then && then.total) || '', info: 'total-value' },
      { label: 'Unrealized', value: fmtNok(unrealized), sub: then ? `was ${fmtNok(then.unrealized)} on ${win.from}` : '', tone: unrealized >= 0 ? 'positive' : 'negative', info: 'unrealized' },
    ]);

    const rows = holdings.map((h, i) => {
      const t = store.registry ? store.registry.forName(h.security) : null;
      const noPx = h.priced === false;
      const ap = h.approx ? '<abbr title="Approximate: valued at the club\'s last trade price — market/FX data missing. Run the price-feed backfill for real marks.">≈</abbr> ' : '';
      const dash = '<span class="text-muted" title="No price data yet">—</span>';
      return {
        attrs: `class="row-link" tabindex="0" role="button" aria-expanded="false" data-idx="${i}" data-security="${escapeHtml(h.security)}"`,
        after: (span) => `<tr class="chart-row" hidden><td colspan="${span}"><div class="chart-wrap" data-chart="${i}"></div></td></tr>`,
        cells: [
          escapeHtml(h.security),
          t && t.ticker ? escapeHtml(t.ticker) : '—',
          fmtQty(h.qty),
          h.gav != null ? fmtQty(h.gav) : '—',
          noPx ? dash : `${h.currentPrice != null ? fmtQty(h.currentPrice) : '≈'} <span class="text-muted text-small">${escapeHtml(h.currency || '')}</span>`,
          noPx ? dash : ap + fmtNok(h.marketValueNok),
          noPx || h.returnNok == null ? dash : `<span class="${pctClass(h.returnNok)}">${fmtNok(h.returnNok)}</span>`,
          noPx || h.returnPct == null ? dash : `<span class="${pctClass(h.returnPct)}">${fmtPct(h.returnPct)}</span>`,
          ownersOf(store, h.security),
        ],
      };
    });

    body.innerHTML = `
      <div style="display:flex;justify-content:flex-end;margin-bottom:10px">${window.UI.rangePicker(preset)}</div>
      ${kpis}
      ${window.UI.section('Current holdings', { info: 'holdings-table', extra: '<span class="text-muted text-small">click a row for the price history</span>' })}
      ${holdings.length === 0
        ? window.UI.emptyState('No open positions', 'Buys will appear here once transactions are synced.')
        : window.UI.table([
            { label: 'Security', p: 1 },
            { label: 'Ticker', className: 'text-muted text-small', p: 3 },
            { label: 'Qty', className: 'text-right', p: 2 },
            { label: 'GAV', className: 'text-right', p: 3 },
            { label: 'Price', className: 'text-right', p: 3 },
            { label: 'MV NOK', className: 'text-right', p: 1 },
            { label: 'Return NOK', className: 'text-right', p: 2 },
            { label: 'Return %', className: 'text-right', p: 1 },
            { label: 'Owners', p: 2 },
          ], rows, { wrapClass: 'sticky-first', caption: 'Current holdings' })}
    `;

    window.UI.bindRangePicker(body, (p) => {
      localStorage.setItem('portal.holdings.range', JSON.stringify({ preset: p }));
      renderHoldings(body, ctx);
    });

    // Row → toggle per-security price chart (rendered lazily, once).
    body.querySelectorAll('tr.row-link').forEach((tr) => {
      const toggle = () => {
        const chartRow = window.UI.siblingRow(tr, 'chart-row');
        if (!chartRow) return;
        const open = chartRow.hidden;
        chartRow.hidden = !open;
        tr.setAttribute('aria-expanded', String(open));
        if (open) {
          const mount = chartRow.querySelector('.chart-wrap');
          if (!mount.dataset.rendered) {
            mount.dataset.rendered = '1';
            renderSecurityChart(mount, ctx.store, tr.dataset.security);
          }
        }
      };
      tr.addEventListener('click', toggle);
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
    });
  }

  function renderSecurityChart(mount, store, security) {
    window.UI.renderSecurityDrilldown(mount, store, security);
  }

  // ─── Activity — one view over the transaction log × StockPrices ───────────
  // Merges the old Report (KPIs + trade scatter + monthly ledger) and Data
  // explorer (filterable flat grid) sub-tabs. Filters at the top drive every
  // section; each month row expands into its actual transactions plus the
  // current fate (still held → MV + unrealized; exited → realized) of the
  // securities traded that month.

  const TYPE_PILLS = [
    { id: 'all', label: 'All' },
    { id: 'buys', label: 'Buys' },
    { id: 'sells', label: 'Sells' },
    { id: 'dividends', label: 'Dividends' },
    { id: 'cash', label: 'Deposits/Withdrawals' },
    { id: 'fees', label: 'Fees' },
    { id: 'other', label: 'Other' },
  ];

  function renderActivity(body, ctx) {
    const { store } = ctx;
    const { fmtNok, fmtQty, fmtPct, pctClass, escapeHtml } = window.Fmt;
    const { classify, amountNok, feeNok, isRealizingSell, isPricedBuy, splitForSecurity, INVESTOR_CODES } = window.Ledger;
    const canon = window.Portfolio.canonicalName;
    const ii = window.UI.infoIcon;

    // ── Persisted filter state ───────────────────────────────────────────
    let state = { preset: 'all', from: null, to: null, type: 'all', codes: [], q: '' };
    try {
      const st = JSON.parse(localStorage.getItem('portal.activity') || '{}') || {};
      state = { ...state, ...st, codes: Array.isArray(st.codes) ? st.codes : [] };
    } catch (_e) { /* defaults */ }
    const persist = () => localStorage.setItem('portal.activity', JSON.stringify(state));

    // ── One-pass row prep: NOK amounts, categories, per-sell realized ────
    // Realized P/L is stamped onto each realizing sell by a full-history
    // average-cost replay (canonical names), so filtered sums stay honest.
    const txRows = [];
    {
      window.Ledger.annotateConversionPairs(store.transactions);
      const costMap = new Map();
      const convBucket = new Map();
      const convDrained = new Set();
      const convDrain = (slot, q, id) => {
        if (!slot || convDrained.has(id)) return 0;
        convDrained.add(id);
        const frac = slot.qty > 0 ? Math.min(q / slot.qty, 1) : 0;
        const t = slot.costSum * frac;
        slot.costSum -= t;
        return t;
      };
      const sorted = store.transactions.slice().sort((a, b) => {
        const ak = a.tradeDate || a.bookDate || '';
        const bk = b.tradeDate || b.bookDate || '';
        return ak.localeCompare(bk);
      });
      for (const tx of sorted) {
        const date = tx.tradeDate || tx.bookDate;
        if (!date) continue;
        const cat = classify(tx.type);
        const c = tx.security ? canon(tx.security) : null;
        const row = {
          date, ym: date.slice(0, 7),
          type: tx.type, cat,
          security: c, rawSecurity: tx.security, isin: tx.isin,
          qty: tx.qty, price: tx.price,
          amountNok: amountNok(tx), feeNok: Math.abs(feeNok(tx)),
          saldo: tx.saldo, currency: tx.currency, text: tx.text,
          codes: tx.security ? splitForSecurity(store.attributionMap, tx.security).map((s) => s.code) : INVESTOR_CODES.slice(),
          realizedNok: null,
        };
        if (c && (cat === 'BUY' || cat === 'SELL') && (isPricedBuy(tx) || isRealizingSell(tx.type) || tx._convRole)) {
          if (!costMap.has(c)) costMap.set(c, { qty: 0, costSum: 0 });
          const slot = costMap.get(c);
          const q = Math.abs(tx.qty || 0);
          if (tx._convRole === 'in') {
            slot.qty += q;
            if (convBucket.has(tx._convId)) slot.costSum += convBucket.get(tx._convId);
            else slot.costSum += convDrain(costMap.get(canon(tx._convOther)), q, tx._convId);
          } else if (tx._convRole === 'out') {
            const t = convDrain(slot, q, tx._convId);
            if (t > 0) convBucket.set(tx._convId, t);
            slot.qty = Math.max(0, slot.qty - q);
          } else if (cat === 'BUY') {
            slot.qty += q; slot.costSum += Math.abs(row.amountNok);
          } else {
            const avg = slot.qty > 0 ? slot.costSum / slot.qty : 0;
            row.realizedNok = row.amountNok - avg * q;
            const frac = slot.qty > 0 ? Math.min(q / slot.qty, 1) : 0;
            slot.costSum = Math.max(0, slot.costSum - slot.costSum * frac);
            slot.qty = Math.max(0, slot.qty - q);
          }
        }
        txRows.push(row);
      }
    }
    const minDate = txRows.length ? txRows[0].date : null;
    const holdingsBySec = new Map();
    for (const h of window.Portfolio.currentHoldings(store)) {
      if (!holdingsBySec.has(h.security)) holdingsBySec.set(h.security, h);
    }

    // ── Filter machinery ─────────────────────────────────────────────────
    function windowBounds() {
      const today = new Date();
      const todayStr = today.toISOString().slice(0, 10);
      const minus = (m) => { const d = new Date(today); d.setUTCMonth(d.getUTCMonth() - m); return d.toISOString().slice(0, 10); };
      switch (state.preset) {
        case '1m': return { from: minus(1), to: todayStr };
        case '6m': return { from: minus(6), to: todayStr };
        case 'ytd': return { from: `${today.getUTCFullYear()}-01-01`, to: todayStr };
        case '1y': return { from: minus(12), to: todayStr };
        case 'custom': return { from: state.from || minDate, to: state.to || todayStr };
        case 'all':
        default: return { from: minDate, to: todayStr };
      }
    }
    function typeMatch(row) {
      switch (state.type) {
        case 'buys': return row.cat === 'BUY';
        case 'sells': return row.cat === 'SELL';
        case 'dividends': return row.cat === 'DIVIDEND' || row.cat === 'TAX';
        case 'cash': return row.cat === 'DEPOSIT' || row.cat === 'WITHDRAWAL';
        case 'fees': return row.cat === 'FEE';
        case 'other': return row.cat === 'OTHER' || row.cat === 'REFUND';
        default: return true;
      }
    }
    function matches(row, win) {
      if (row.date < win.from || row.date > win.to) return false;
      if (!typeMatch(row)) return false;
      if (state.codes.length && !row.codes.some((cd) => state.codes.includes(cd))) return false;
      if (state.q) {
        const q = state.q.toLowerCase();
        const hay = `${row.security || ''} ${row.rawSecurity || ''} ${row.isin || ''} ${row.type || ''} ${row.text || ''} ${row.currency || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }
    const nonRangeFilterActive = () => state.type !== 'all' || state.codes.length > 0 || state.q.trim() !== '';

    // ── Month buckets over the filtered set ──────────────────────────────
    function buildBuckets(filtered, win, withValuation) {
      const buckets = new Map();
      const blank = (ym) => ({
        ym, deposits: 0, withdrawals: 0, buys: 0, sells: 0,
        dividends: 0, fees: 0, realized: 0, txCount: 0,
        endingCash: null, endingMv: null, total: null, delta: null,
      });
      const ensure = (ym) => { if (!buckets.has(ym)) buckets.set(ym, blank(ym)); return buckets.get(ym); };
      for (const r of filtered) {
        const b = ensure(r.ym);
        b.txCount += 1;
        if (r.cat === 'BUY' || r.cat === 'SELL') b.fees += r.feeNok;
        if (r.cat === 'FEE') b.fees += Math.abs(r.amountNok);
        if (r.cat === 'BUY' && r.type === 'KJØPT') b.buys += Math.abs(r.amountNok);
        if (r.cat === 'SELL' && isRealizingSell(r.type)) b.sells += r.amountNok;
        if (r.cat === 'DIVIDEND' || r.cat === 'TAX') b.dividends += r.amountNok;
        if (r.cat === 'DEPOSIT') b.deposits += r.amountNok;
        if (r.cat === 'WITHDRAWAL') b.withdrawals += Math.abs(r.amountNok);
        if (r.realizedNok != null) b.realized += r.realizedNok;
      }
      // Fill every month of the window so quiet months still show valuation.
      let ym = win.from.slice(0, 7);
      const endYm = win.to.slice(0, 7);
      let [y, m] = ym.split('-').map(Number);
      while (ym <= endYm) {
        ensure(ym);
        m += 1; if (m > 12) { m = 1; y += 1; }
        ym = `${y}-${String(m).padStart(2, '0')}`;
      }
      const list = Array.from(buckets.keys()).sort();
      if (withValuation) {
        let prevTotal = null;
        for (const k of list) {
          const monthEnd = lastDayOf(k);
          const b = buckets.get(k);
          b.endingCash = window.Portfolio.cash.saldoOnOrBefore(store, monthEnd);
          b.endingMv = monthEndMv(store, monthEnd);
          b.total = (b.endingCash != null && b.endingMv != null) ? b.endingCash + b.endingMv : null;
          b.delta = (b.total != null && prevTotal != null) ? b.total - prevTotal : null;
          if (b.total != null) prevTotal = b.total;
        }
      }
      return list.map((k) => buckets.get(k));
    }

    // Month-end MV: true valuation at the month-end closes from the matrix.
    function monthEndMv(store, monthEnd) {
      if (!window.Portfolio.usePriceMatrix(store)) return null;
      const held = window.Positions.holdingsAt(store, monthEnd);
      if (!held.length) return 0;
      let mv = 0, priced = false;
      for (const h of held) {
        const px = window.Portfolio.nokPriceForSecurity(store, h.security, monthEnd);
        if (px != null) { mv += px * h.qty; priced = true; }
      }
      return priced ? mv : null;
    }
    function lastDayOf(ym) {
      const [y, m] = ym.split('-').map(Number);
      return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    }

    // ── Render ───────────────────────────────────────────────────────────
    refresh();

    function refresh() {
      persist();
      const win = windowBounds();
      const filtered = txRows.filter((r) => matches(r, win));
      const showValuation = !nonRangeFilterActive();
      const months = buildBuckets(filtered, win, showValuation);

      const trades = filtered.filter((r) => r.cat === 'BUY' || r.cat === 'SELL');
      const buys = filtered.filter((r) => r.cat === 'BUY' && r.type === 'KJØPT');
      const sells = filtered.filter((r) => r.cat === 'SELL' && isRealizingSell(r.type));
      const bought = buys.reduce((a, r) => a + Math.abs(r.amountNok), 0);
      const sold = sells.reduce((a, r) => a + r.amountNok, 0);
      const realized = filtered.reduce((a, r) => a + (r.realizedNok || 0), 0);
      const dividends = filtered.filter((r) => r.cat === 'DIVIDEND' || r.cat === 'TAX').reduce((a, r) => a + r.amountNok, 0);
      const fees = filtered.reduce((a, r) => a + ((r.cat === 'BUY' || r.cat === 'SELL') ? r.feeNok : (r.cat === 'FEE' ? Math.abs(r.amountNok) : 0)), 0);

      document.getElementById('pf-when').textContent =
        `${filtered.length} of ${txRows.length} transactions · ${win.from} → ${win.to}`;

      body.innerHTML = `

        <div class="data-toolbar" role="group" aria-label="Activity filters">
          <input type="search" id="act-q" placeholder="Search security / ISIN / text…" aria-label="Search transactions" value="${escapeHtml(state.q)}" />
          <span class="type-pills" role="group" aria-label="Transaction type">
            ${TYPE_PILLS.map((t) => `<button type="button" data-type="${t.id}" class="${state.type === t.id ? 'active' : ''}" aria-pressed="${state.type === t.id}">${t.label}</button>`).join('')}
          </span>
          <span class="code-chips" role="group" aria-label="Investor">
            ${INVESTOR_CODES.map((cd) => `<button type="button" data-code="${cd}" class="${state.codes.includes(cd) ? 'active' : ''}" aria-pressed="${state.codes.includes(cd)}">${cd}</button>`).join('')}
          </span>
          <span class="grow"></span>
          <span class="count">${filtered.length} rows</span>
          ${ii('explorer')}
        </div>
        <div class="range-picker" id="act-range" style="margin-bottom:14px">
          ${['1m', '6m', 'ytd', '1y', 'all', 'custom'].map((pId) =>
            `<button type="button" class="preset ${state.preset === pId ? 'active' : ''}" data-preset="${pId}">${pId === 'custom' ? 'Custom' : pId.toUpperCase()}</button>`).join('')}
          <span class="sep" style="display:${state.preset === 'custom' ? 'inline' : 'none'}">·</span>
          <input type="date" id="act-from" aria-label="From date" value="${state.from || win.from || ''}" style="display:${state.preset === 'custom' ? 'inline-block' : 'none'}" />
          <span class="sep" style="display:${state.preset === 'custom' ? 'inline' : 'none'}">→</span>
          <input type="date" id="act-to" aria-label="To date" value="${state.to || win.to || ''}" style="display:${state.preset === 'custom' ? 'inline-block' : 'none'}" />
        </div>

        <div class="kpi-grid">
          <div class="kpi-card"><div class="label">Bought ${ii('trading-activity')}</div><div class="value positive">${fmtNok(bought)}</div><div class="sub">${buys.length} purchase${buys.length === 1 ? '' : 's'}</div></div>
          <div class="kpi-card"><div class="label">Sold ${ii('trading-activity')}</div><div class="value negative">${fmtNok(sold)}</div><div class="sub">${sells.length} sale${sells.length === 1 ? '' : 's'}</div></div>
          <div class="kpi-card"><div class="label">Net deployed ${ii('trading-activity')}</div><div class="value">${fmtNok(bought - sold)}</div><div class="sub">bought − sold</div></div>
          <div class="kpi-card"><div class="label">Realized P/L ${ii('realized')}</div><div class="value ${pctClass(realized)}">${fmtNok(realized)}</div></div>
          <div class="kpi-card"><div class="label">Dividends ${ii('dividends')}</div><div class="value">${fmtNok(dividends)}</div></div>
          <div class="kpi-card"><div class="label">Fees ${ii('fees')}</div><div class="value text-muted">${fmtNok(fees)}</div></div>
        </div>

        <div class="section-title">Buys &amp; sells ${ii('trade-scatter')} <span class="text-muted text-small">blue = purchase (up), red = sale (down); dot size ∝ amount</span></div>
        <div class="chart-wrap" id="act-scatter"></div>

        ${showValuation ? `
          <div class="section-title">Total value, month by month ${ii('activity-total-trend')}</div>
          <div class="chart-wrap" id="act-trend"></div>
        ` : ''}

        <div class="section-title">By month ${ii('monthly-accounting')} <span class="text-muted text-small">click a month for its transactions</span></div>
        ${nonRangeFilterActive() ? '<p class="text-muted text-small">Valuation columns (End cash / End MV / Total / Δ) are hidden while a security, type or investor filter is active — they are portfolio-level figures.</p>' : ''}
        ${window.UI.table(LEDGER_COLS(showValuation), renderLedgerRows(months, showValuation), {
          className: 'report-table', wrapClass: 'sticky-first', caption: 'Monthly ledger',
        })}

        <details class="all-tx-details">
          <summary>All ${filtered.length} transactions in one table</summary>
          <div id="act-flat"></div>
        </details>
      `;

      // Charts
      const scatterMount = body.querySelector('#act-scatter');
      scatterMount.appendChild(window.Charts.tradeScatter({
        trades: trades.map((r) => ({
          date: r.date, type: r.cat === 'SELL' ? 'sell' : 'buy',
          label: r.security || r.type, amount: Math.abs(r.amountNok), qty: r.qty, codes: r.codes,
        })),
        from: win.from, to: win.to,
      }));
      const trendMount = body.querySelector('#act-trend');
      if (trendMount) {
        const pts = months.filter((mo) => mo.total != null).map((mo) => ({ date: lastDayOf(mo.ym), y: mo.total }));
        if (pts.length >= 2) {
          trendMount.appendChild(window.Charts.multiLine({
            series: [{ name: 'Total value', color: '#1FE0CE', points: pts }],
            title: 'Total value by month', interactive: true,
          }));
        } else {
          trendMount.innerHTML = '<p class="text-muted text-small" style="padding:8px 12px">Not enough priced months to draw the trend yet.</p>';
        }
      }

      wireToolbar(win);
      wireMonthRows(filtered);
      wireFlatTable(filtered);
    }

    // ── Year/month rows ──────────────────────────────────────────────────
    // p1 keeps the month and the three numbers the table is actually read
    // for; the rest of the cash-flow breakdown is one tap away.
    function LEDGER_COLS(withValuation) {
      const cols = [
        { label: 'Month', p: 1 },
        { label: 'Tx', className: 'text-right', p: 3 },
        { label: 'Deposits', className: 'text-right', p: 3 },
        { label: 'Withdrawals', className: 'text-right', p: 3 },
        { label: 'Buys', className: 'text-right', p: 1 },
        { label: 'Sells', className: 'text-right', p: 1 },
        { label: 'Dividends', className: 'text-right', p: 2 },
        { label: 'Fees', className: 'text-right', p: 3 },
        { label: 'Realized P/L', className: 'text-right', p: 1 },
      ];
      if (withValuation) cols.push(
        { label: 'End cash', className: 'text-right', p: 3 },
        { label: 'End MV', className: 'text-right', p: 3 },
        { label: 'Total', className: 'text-right', p: 2 },
        { label: 'Δ', className: 'text-right', p: 2 },
      );
      return cols;
    }

    function renderLedgerRows(months, withValuation) {
      const byYear = new Map();
      for (const m of months) {
        const y = m.ym.slice(0, 4);
        if (!byYear.has(y)) byYear.set(y, []);
        byYear.get(y).push(m);
      }
      const years = Array.from(byYear.keys()).sort().reverse();
      const dash = '—';
      const money = (v, cls) => (v != null ? `<span class="${cls || ''}">${fmtNok(v)}</span>` : dash);

      const sum = (ms) => ms.reduce((a, m) => ({
        txCount: a.txCount + m.txCount,
        deposits: a.deposits + m.deposits, withdrawals: a.withdrawals + m.withdrawals,
        buys: a.buys + m.buys, sells: a.sells + m.sells,
        dividends: a.dividends + m.dividends, fees: a.fees + m.fees, realized: a.realized + m.realized,
      }), { txCount: 0, deposits: 0, withdrawals: 0, buys: 0, sells: 0, dividends: 0, fees: 0, realized: 0 });

      const out = [];
      for (const year of years) {
        const yr = byYear.get(year);
        const s = sum(yr);
        const end = yr[yr.length - 1] || {};
        let dY = null;
        for (const m of yr) if (m.delta != null) dY = (dY || 0) + m.delta;
        out.push({
          attrs: 'class="year-header"',
          expand: false, // a grouping row has nothing of its own to reveal
          cells: [
            `<strong>${year}</strong>`, s.txCount || dash,
            money(s.deposits), money(s.withdrawals), money(s.buys), money(s.sells),
            money(s.dividends), money(s.fees), money(s.realized, pctClass(s.realized)),
            ...(withValuation ? [money(end.endingCash), money(end.endingMv), money(end.total),
              money(dY, dY != null ? pctClass(dY) : '')] : []),
          ],
        });
        for (const m of yr) {
          out.push({
            attrs: `class="month-row" tabindex="0" role="button" aria-expanded="false" data-ym="${m.ym}"`,
            after: (span) => `<tr class="month-detail" hidden><td colspan="${span}" data-detail="${m.ym}"></td></tr>`,
            cells: [
              m.ym,
              m.txCount ? m.txCount : `<span class="text-muted">${dash}</span>`,
              money(m.deposits), money(m.withdrawals, 'text-muted'), money(m.buys), money(m.sells),
              money(m.dividends), money(m.fees, 'text-muted'), money(m.realized, pctClass(m.realized)),
              ...(withValuation ? [money(m.endingCash), money(m.endingMv),
                m.total != null ? `<strong>${fmtNok(m.total)}</strong>` : dash,
                money(m.delta, m.delta != null ? pctClass(m.delta) : '')] : []),
            ],
          });
        }
      }
      return out;
    }

    // ── Month drill-down ─────────────────────────────────────────────────
    function wireMonthRows(filtered) {
      body.querySelectorAll('tr.month-row').forEach((tr) => {
        const toggle = () => {
          const detail = window.UI.siblingRow(tr, 'month-detail');
          if (!detail) return;
          const open = detail.hidden;
          detail.hidden = !open;
          tr.setAttribute('aria-expanded', String(open));
          if (open) {
            const cell = detail.querySelector('[data-detail]');
            if (!cell.dataset.rendered) {
              cell.dataset.rendered = '1';
              cell.innerHTML = monthDetailHtml(tr.dataset.ym, filtered);
            }
          }
        };
        tr.addEventListener('click', toggle);
        tr.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
        });
      });
    }

    function monthDetailHtml(ym, filtered) {
      const rows = filtered.filter((r) => r.ym === ym).sort((a, b) => b.date.localeCompare(a.date));
      if (!rows.length) return '<p class="text-muted text-small" style="margin:0">No matching transactions this month.</p>';

      const txTable = `
        <h5>Transactions (${rows.length})</h5>
        ${window.UI.table([
          { label: 'Date', className: 'text-small', p: 1 },
          { label: 'Type', p: 2 },
          { label: 'Security', p: 1 },
          { label: 'Qty', className: 'text-right', p: 2 },
          { label: 'Price', className: 'text-right', p: 3 },
          { label: 'Amount NOK', className: 'text-right', p: 1 },
          { label: 'Fee', className: 'text-right text-muted', p: 3 },
          { label: 'Saldo', className: 'text-right text-muted', p: 3 },
          { label: 'Investors', className: 'text-muted text-small', p: 2 },
        ], rows.map((r) => [
          r.date,
          `<span class="type-pill type-${escapeHtml(r.type || '')}">${escapeHtml(r.type || '')}</span>`,
          escapeHtml(r.security || ''),
          r.qty != null ? fmtQty(r.qty) : '—',
          r.price != null ? fmtQty(r.price) : '—',
          `<span class="${pctClass(r.amountNok)}">${fmtNok(r.amountNok)}</span>`,
          r.feeNok ? fmtNok(r.feeNok) : '—',
          r.saldo != null ? fmtNok(r.saldo) : '—',
          r.codes.join(', '),
        ]), { caption: `Transactions in ${ym}` })}`;

      // Fate of the securities traded this month: still held → current MV +
      // unrealized; exited → total realized P/L over its lifetime.
      const secs = [...new Set(rows.map((r) => r.security).filter(Boolean))];
      const positions = window.Positions.bySecurity(store);
      const fateRows = secs.map((sec) => {
        const held = holdingsBySec.get(sec);
        if (held) {
          const noPx = held.priced === false;
          return [
            escapeHtml(sec),
            '<span class="tag">still held</span>',
            fmtQty(held.qty),
            noPx ? '—' : fmtNok(held.marketValueNok),
            noPx || held.returnNok == null ? '—' : `<span class="${pctClass(held.returnNok)}">${fmtNok(held.returnNok)}</span>`,
            noPx || held.returnPct == null ? '—' : `<span class="${pctClass(held.returnPct)}">${fmtPct(held.returnPct)}</span>`,
          ];
        }
        const st = positions.get(sec);
        const realizedAll = st ? window.Positions.stateAt(st, '9999-12-31').realized : 0;
        return [
          escapeHtml(sec),
          '<span class="tag">exited</span>',
          '<span class="text-muted">0</span>',
          '<span class="text-muted">—</span>',
          `<span class="${pctClass(realizedAll)}">${fmtNok(realizedAll)}</span>`,
          '<span class="text-muted">realized</span>',
        ];
      });

      const fateTable = secs.length ? `
        <h5>Where those stocks stand today ${ii('holdings-table')}</h5>
        ${window.UI.table([
          { label: 'Security', p: 1 },
          { label: 'Status', p: 2 },
          { label: 'Qty now', className: 'text-right', p: 3 },
          { label: 'MV now', className: 'text-right', p: 1 },
          { label: 'Gain/loss', className: 'text-right', p: 1 },
          { label: '%', className: 'text-right', p: 2 },
        ], fateRows, { caption: 'Where those stocks stand today' })}` : '';

      return txTable + fateTable;
    }

    // ── Flat "all transactions" table (sortable) ─────────────────────────
    let flatSort = { column: 'date', direction: 'desc' };
    function wireFlatTable(filtered) {
      const mount = body.querySelector('#act-flat');
      const details = body.querySelector('.all-tx-details');
      let rendered = false;
      const renderFlat = () => {
        const numeric = ['qty', 'price', 'amountNok', 'feeNok', 'saldo', 'date'];
        const dir = flatSort.direction === 'asc' ? 1 : -1;
        const sorted = filtered.slice().sort((a, b) => {
          const av = a[flatSort.column], bv = b[flatSort.column];
          if (numeric.includes(flatSort.column) && flatSort.column !== 'date') {
            return (((av == null ? -Infinity : Number(av))) - ((bv == null ? -Infinity : Number(bv)))) * dir;
          }
          return String(av || '').localeCompare(String(bv || ''), 'nb') * dir;
        });
        const arrow = (c) => flatSort.column !== c
          ? '<span class="sort-arrow">↕</span>'
          : `<span class="sort-arrow">${flatSort.direction === 'asc' ? '▲' : '▼'}</span>`;
        const NUM = ['qty', 'price', 'amountNok', 'feeNok', 'saldo'];
        const COLS = [
          ['date', 'Date', 1], ['type', 'Type', 2], ['security', 'Security', 1], ['isin', 'ISIN', 3],
          ['qty', 'Qty', 2], ['price', 'Price', 3], ['amountNok', 'Amount NOK', 1], ['feeNok', 'Fee', 3],
          ['saldo', 'Saldo', 3], ['codes', 'Investors', 2],
        ];
        mount.innerHTML = window.UI.table(
          COLS.map(([k, l, p]) => ({
            label: l, p,
            className: NUM.includes(k) ? 'num' : (k === 'isin' || k === 'codes' ? 'text-muted text-small' : ''),
            thClass: `sortable ${flatSort.column === k ? 'sorted' : ''} ${NUM.includes(k) ? 'num' : ''}`,
            thAttrs: `data-sort="${k}"`,
            thExtra: arrow(k),
          })),
          sorted.map((r) => [
            r.date,
            `<span class="type-pill type-${escapeHtml(r.type || '')}">${escapeHtml(r.type || '')}</span>`,
            escapeHtml(r.security || ''),
            escapeHtml(r.isin || ''),
            r.qty != null ? fmtQty(r.qty) : '—',
            r.price != null ? fmtQty(r.price) : '—',
            fmtNok(r.amountNok),
            r.feeNok ? fmtNok(r.feeNok) : '—',
            r.saldo != null ? fmtNok(r.saldo) : '—',
            r.codes.join(', '),
          ]),
          { className: 'data-table', caption: 'All transactions' });
        mount.querySelectorAll('th.sortable').forEach((th) => {
          th.addEventListener('click', () => {
            const c = th.dataset.sort;
            if (flatSort.column === c) flatSort.direction = flatSort.direction === 'asc' ? 'desc' : 'asc';
            else flatSort = { column: c, direction: c === 'date' || ['qty','price','amountNok','feeNok','saldo'].includes(c) ? 'desc' : 'asc' };
            renderFlat();
          });
        });
      };
      details.addEventListener('toggle', () => {
        if (details.open && !rendered) { rendered = true; renderFlat(); }
      });
    }

    // ── Toolbar wiring ───────────────────────────────────────────────────
    function wireToolbar(win) {
      const q = body.querySelector('#act-q');
      let debounce = null;
      q.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => { state.q = q.value; refresh(); }, 250);
      });
      body.querySelectorAll('.type-pills button').forEach((btn) => {
        btn.addEventListener('click', () => { state.type = btn.dataset.type; refresh(); });
      });
      body.querySelectorAll('.code-chips button').forEach((btn) => {
        btn.addEventListener('click', () => {
          const cd = btn.dataset.code;
          const i = state.codes.indexOf(cd);
          if (i >= 0) state.codes.splice(i, 1); else state.codes.push(cd);
          refresh();
        });
      });
      body.querySelectorAll('#act-range .preset').forEach((btn) => {
        btn.addEventListener('click', () => {
          const p = btn.dataset.preset;
          if (p === 'custom') {
            state.preset = 'custom';
            state.from = state.from || win.from;
            state.to = state.to || win.to;
            refresh();
            const from = body.querySelector('#act-from');
            if (from) from.focus();
            return;
          }
          state.preset = p; state.from = null; state.to = null;
          refresh();
        });
      });
      const fromI = body.querySelector('#act-from');
      const toI = body.querySelector('#act-to');
      const onDate = () => {
        if (!fromI.value || !toI.value) return;
        state.preset = 'custom'; state.from = fromI.value; state.to = toI.value;
        refresh();
      };
      if (fromI) fromI.addEventListener('change', onDate);
      if (toI) toI.addEventListener('change', onDate);
    }
  }
})();
