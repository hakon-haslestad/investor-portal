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
    { key: 'report', label: 'Report', href: '#/portfolio/report' },
    { key: 'explorer', label: 'Data explorer', href: '#/portfolio/explorer' },
  ];

  window.Views.portfolio = async function (el, ctx) {
    const active = ctx.params[0] || 'holdings';
    el.innerHTML = `
      <div class="hero">
        <h2>Portfolio</h2>
        <div class="when" id="pf-when"></div>
      </div>
      ${window.UI.subTabs(SUBTABS, active)}
      <div id="pf-body"></div>
    `;
    const body = el.querySelector('#pf-body');
    if (active === 'report') renderReport(body, ctx);
    else if (active === 'explorer') renderExplorer(body, ctx);
    else renderHoldings(body, ctx);
  };

  // ─── Holdings ──────────────────────────────────────────────────────────────

  function priceFreshnessNote(store) {
    if (!window.Portfolio.usePriceMatrix(store)) {
      return '<span class="price-freshness stale">No price data — the StockPrices tab is empty. Install/run the Apps Script feed.</span>';
    }
    return `<span class="price-freshness">Prices as of ${store.prices.latestDate}</span>`;
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

    const kpis = window.UI.kpiGrid([
      { label: 'Market value', value: fmtNok(totalMv) },
      { label: 'Cash', value: fmtNok(cash), sub: 'latest Nordnet saldo' },
      { label: 'Total value', value: fmtNok(totalMv + cash) },
      { label: 'Unrealized', value: fmtNok(unrealized), tone: unrealized >= 0 ? 'positive' : 'negative' },
    ]);

    const COLS = 9;
    const rows = holdings.map((h, i) => {
      const t = store.registry ? store.registry.forName(h.security) : null;
      const noPx = h.priced === false;
      const dash = '<span class="text-muted" title="No price data yet">—</span>';
      return `
        <tr class="row-link" tabindex="0" role="button" aria-expanded="false" data-idx="${i}" data-security="${escapeHtml(h.security)}">
          <td>${escapeHtml(h.security)}</td>
          <td class="text-muted text-small">${t && t.ticker ? escapeHtml(t.ticker) : '—'}</td>
          <td class="text-right">${fmtQty(h.qty)}</td>
          <td class="text-right">${h.gav != null ? fmtQty(h.gav) : '—'}</td>
          <td class="text-right">${noPx ? dash : `${fmtQty(h.currentPrice)} <span class="text-muted text-small">${escapeHtml(h.currency || '')}</span>`}</td>
          <td class="text-right">${noPx ? dash : fmtNok(h.marketValueNok)}</td>
          <td class="text-right ${h.returnNok != null ? pctClass(h.returnNok) : ''}">${noPx || h.returnNok == null ? dash : fmtNok(h.returnNok)}</td>
          <td class="text-right ${h.returnPct != null ? pctClass(h.returnPct) : ''}">${noPx || h.returnPct == null ? dash : fmtPct(h.returnPct)}</td>
          <td>${ownersOf(store, h.security)}</td>
        </tr>
        <tr class="chart-row" hidden><td colspan="${COLS}"><div class="chart-wrap" data-chart="${i}"></div></td></tr>
      `;
    }).join('');

    body.innerHTML = `
      ${kpis}
      ${window.UI.section('Current holdings', '<span class="text-muted text-small">click a row for the price history</span>')}
      ${holdings.length === 0
        ? window.UI.emptyState('No open positions', 'Buys will appear here once transactions are synced.')
        : `<div class="table-scroll"><table>
            <thead><tr>
              <th scope="col">Security</th><th scope="col">Ticker</th>
              <th scope="col" class="text-right">Qty</th><th scope="col" class="text-right">GAV</th>
              <th scope="col" class="text-right">Price</th><th scope="col" class="text-right">MV NOK</th>
              <th scope="col" class="text-right">Return NOK</th><th scope="col" class="text-right">Return %</th>
              <th scope="col">Owners</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table></div>`}
    `;

    // Row → toggle per-security price chart (rendered lazily, once).
    body.querySelectorAll('tr.row-link').forEach((tr) => {
      const toggle = () => {
        const chartRow = tr.nextElementSibling;
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
    const points = window.TimeSeries.buildSecurityPriceSeries(store, security)
      .map((p) => ({ date: p.date, price: p.price }));
    const markers = [];
    if (points.length >= 2) {
      const from = points[0].date, to = points[points.length - 1].date;
      for (const tx of store.transactions) {
        if (!tx.security || !tx.tradeDate) continue;
        if (window.Portfolio.canonicalName(tx.security) !== security) continue;
        if (tx.tradeDate < from || tx.tradeDate > to) continue;
        const cat = window.Ledger.classify(tx.type);
        if (cat === 'BUY' && tx.type === 'KJØPT') markers.push({ date: tx.tradeDate, type: 'buy' });
        else if (cat === 'SELL' && window.Ledger.isRealizingSell(tx.type)) markers.push({ date: tx.tradeDate, type: 'sell' });
      }
    }
    mount.appendChild(window.Charts.priceChart({ points, markers, yUnit: 'NOK' }));
  }

  // ─── Report (trading activity + monthly ledger) ────────────────────────────

  function renderReport(body, ctx) {
    const { store } = ctx;
    const { fmtNok, fmtQty, fmtPct, pctClass, escapeHtml } = window.Fmt;
    const { classify, amountNok, splitForSecurity } = window.Ledger;
    const canon = window.Portfolio.canonicalName;

    document.getElementById('pf-when').textContent = 'All purchases and sales, plus the formal monthly ledger.';

    const PRESETS = [
      { id: '1m', label: '1M' }, { id: '6m', label: '6M' }, { id: 'ytd', label: 'YTD' },
      { id: '1y', label: '1Y' }, { id: 'all', label: 'All' }, { id: 'custom', label: 'Custom' },
    ];
    const stored = JSON.parse(localStorage.getItem('portal.report.range') || '{}');
    const current = { preset: stored.preset || 'ytd', from: stored.from || null, to: stored.to || null };

    function earliestTradeDate() {
      let min = null;
      for (const t of store.transactions || []) {
        if (t.tradeDate && (!min || t.tradeDate < min)) min = t.tradeDate;
      }
      return min || new Date().toISOString().slice(0, 10);
    }
    function computeWindow() {
      const today = new Date();
      const todayStr = today.toISOString().slice(0, 10);
      if (current.preset === 'custom' && current.from && current.to) return { from: current.from, to: current.to, preset: 'custom' };
      const minus = (months) => { const d = new Date(today); d.setUTCMonth(d.getUTCMonth() - months); return d.toISOString().slice(0, 10); };
      switch (current.preset) {
        case '1m': return { from: minus(1), to: todayStr, preset: '1m' };
        case '6m': return { from: minus(6), to: todayStr, preset: '6m' };
        case '1y': return { from: minus(12), to: todayStr, preset: '1y' };
        case 'all': return { from: earliestTradeDate(), to: todayStr, preset: 'all' };
        case 'ytd':
        default: return { from: `${today.getUTCFullYear()}-01-01`, to: todayStr, preset: 'ytd' };
      }
    }

    function tradesIn(from, to) {
      const out = [];
      for (const tx of store.transactions || []) {
        if (!tx.security || !tx.tradeDate) continue;
        if (tx.tradeDate < from || tx.tradeDate > to) continue;
        const cat = classify(tx.type);
        if (cat !== 'BUY' && cat !== 'SELL') continue;
        const codes = splitForSecurity(store.attributionMap, tx.security).map((s) => s.code);
        out.push({
          date: tx.tradeDate,
          type: cat === 'SELL' ? 'sell' : 'buy',
          label: canon(tx.security),
          amount: Math.abs(amountNok(tx)),
          qty: tx.qty,
          codes,
        });
      }
      return out.sort((a, b) => b.date.localeCompare(a.date));
    }

    const months = buildMonthlyLedger(store);

    refresh();

    function refresh() {
      const win = computeWindow();
      localStorage.setItem('portal.report.range', JSON.stringify(current));
      const trades = tradesIn(win.from, win.to);
      const buys = trades.filter((t) => t.type === 'buy');
      const sells = trades.filter((t) => t.type === 'sell');
      const bought = buys.reduce((a, t) => a + t.amount, 0);
      const sold = sells.reduce((a, t) => a + t.amount, 0);

      body.innerHTML = `
        <div class="section-head">
          <h3 class="section-title" style="margin-top:0">Trading activity · ${win.from} → ${win.to}</h3>
          ${renderPicker(win)}
        </div>

        <div class="kpi-grid">
          <div class="kpi-card"><div class="label">Bought</div><div class="value positive">${fmtNok(bought)}</div><div class="sub">${buys.length} purchase${buys.length === 1 ? '' : 's'}</div></div>
          <div class="kpi-card"><div class="label">Sold</div><div class="value negative">${fmtNok(sold)}</div><div class="sub">${sells.length} sale${sells.length === 1 ? '' : 's'}</div></div>
          <div class="kpi-card"><div class="label">Net deployed</div><div class="value">${fmtNok(bought - sold)}</div><div class="sub">bought − sold</div></div>
          <div class="kpi-card"><div class="label">Trades</div><div class="value">${trades.length}</div></div>
        </div>

        <div class="section-title">Buys &amp; sells <span class="text-muted text-small">blue = purchase (up), red = sale (down); dot size ∝ amount; hover for detail</span></div>
        <div class="chart-wrap" id="trade-chart"></div>

        <div class="section-title">All trades</div>
        ${trades.length === 0 ? '<div class="flash">No purchases or sales in this period.</div>' : `
        <div class="table-scroll">
          <table class="investor-table">
            <thead><tr><th>Date</th><th>Security</th><th>Type</th><th class="text-right">Qty</th><th class="text-right">Amount NOK</th><th>Investor</th></tr></thead>
            <tbody>
              ${trades.map((t) => `
                <tr>
                  <td data-label="Date" class="text-small">${t.date}</td>
                  <td data-label="Security">${escapeHtml(t.label)}</td>
                  <td data-label="Type"><span class="tag ${t.type}">${t.type === 'sell' ? 'SALG' : 'KJØPT'}</span></td>
                  <td data-label="Qty" class="text-right">${fmtQty(t.qty)}</td>
                  <td data-label="Amount NOK" class="text-right">${fmtNok(t.amount)}</td>
                  <td data-label="Investor" class="text-muted text-small">${t.codes.join(', ') || '—'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        `}

        <div class="section-title">Monthly accounting</div>
        <p class="text-muted text-small">
          Every row is one calendar month. Net result = realized P/L + dividends − fees − withholding tax.
          Ending cash is the latest Nordnet <code>Saldo</code> recorded in that month;
          ending MV is the portfolio valued at the month-end closes from the price feed.
          D/E proxy = cash / (cash + MV) — a higher number means more idle capital.
        </p>
        <div class="chart-wrap" style="overflow-x:auto">
          <table class="report-table">
            <thead><tr>
              <th>Month</th>
              <th class="text-right">Net result</th>
              <th class="text-right">Realized</th>
              <th class="text-right">Dividends</th>
              <th class="text-right">Tx fees</th>
              <th class="text-right">Withholding tax</th>
              <th class="text-right">Deposits</th>
              <th class="text-right">Withdrawals</th>
              <th class="text-right">Ending cash</th>
              <th class="text-right">Ending MV</th>
              <th class="text-right">D/E proxy</th>
            </tr></thead>
            <tbody>${renderLedgerRows(months)}</tbody>
          </table>
        </div>
      `;

      const mount = body.querySelector('#trade-chart');
      if (mount) mount.appendChild(window.Charts.tradeScatter({ trades, from: win.from, to: win.to }));
      wirePicker();
    }

    function renderPicker(win) {
      return `
        <div class="range-picker" id="range-picker">
          ${PRESETS.map((p) => `<button class="preset ${current.preset === p.id ? 'active' : ''}" data-preset="${p.id}">${p.label}</button>`).join('')}
          <span class="sep" id="custom-sep" style="display:${current.preset === 'custom' ? 'inline' : 'none'}">·</span>
          <input type="date" id="date-from" aria-label="From date" value="${current.from || win.from || ''}" style="display:${current.preset === 'custom' ? 'inline-block' : 'none'}" />
          <span class="sep" id="custom-sep2" style="display:${current.preset === 'custom' ? 'inline' : 'none'}">→</span>
          <input type="date" id="date-to" aria-label="To date" value="${current.to || win.to || ''}" style="display:${current.preset === 'custom' ? 'inline-block' : 'none'}" />
        </div>
      `;
    }

    function wirePicker() {
      body.querySelectorAll('#range-picker .preset').forEach((btn) => {
        btn.addEventListener('click', () => {
          const p = btn.dataset.preset;
          if (p === 'custom') {
            current.preset = 'custom';
            body.querySelector('#custom-sep').style.display = 'inline';
            body.querySelector('#custom-sep2').style.display = 'inline';
            body.querySelector('#date-from').style.display = 'inline-block';
            body.querySelector('#date-to').style.display = 'inline-block';
            body.querySelectorAll('#range-picker .preset').forEach((b) => b.classList.toggle('active', b.dataset.preset === 'custom'));
            return;
          }
          current.preset = p; current.from = null; current.to = null;
          refresh();
        });
      });
      const fromInput = body.querySelector('#date-from');
      const toInput = body.querySelector('#date-to');
      const onChange = () => {
        if (!fromInput.value || !toInput.value) return;
        current.preset = 'custom'; current.from = fromInput.value; current.to = toInput.value;
        refresh();
      };
      if (fromInput) fromInput.addEventListener('change', onChange);
      if (toInput) toInput.addEventListener('change', onChange);
    }

    // ── Monthly ledger (from reports.js) ──────────────────────────────────
    function buildMonthlyLedger(store) {
      const { isRealizingSell, feeNok } = window.Ledger;
      const buckets = new Map();
      for (const tx of store.transactions) {
        const date = tx.bookDate || tx.tradeDate;
        if (!date) continue;
        const ym = date.slice(0, 7);
        if (!buckets.has(ym)) buckets.set(ym, blank(ym));
        const b = buckets.get(ym);
        const cat = classify(tx.type);
        const amt = amountNok(tx);
        const fee = Math.abs(feeNok(tx));
        if (cat === 'BUY' || cat === 'SELL') b.fees += fee;
        if (cat === 'FEE') b.fees += Math.abs(amt);
        if (cat === 'DIVIDEND') b.dividends += amt;
        if (cat === 'TAX') b.tax += amt;
        if (cat === 'DEPOSIT') b.deposits += amt;
        if (cat === 'WITHDRAWAL') b.withdrawals += Math.abs(amt);
      }
      const realizedByMonth = monthlyRealized(store);
      for (const [ym, val] of realizedByMonth.entries()) {
        if (!buckets.has(ym)) buckets.set(ym, blank(ym));
        buckets.get(ym).realized = val;
      }

      const monthList = Array.from(buckets.keys()).sort();
      for (const ym of monthList) {
        const monthEnd = lastDayOf(ym);
        const b = buckets.get(ym);
        b.endingCash = window.Portfolio.cash.saldoOnOrBefore(store, monthEnd);
        b.endingMv = monthEndMv(store, monthEnd);
        b.netResult = b.realized + b.dividends - b.fees + b.tax; // tax is signed negative already
        b.deProxy = (b.endingCash != null && b.endingMv != null && (b.endingCash + b.endingMv) > 0)
          ? b.endingCash / (b.endingCash + b.endingMv)
          : null;
      }
      return monthList.map((ym) => buckets.get(ym)).reverse(); // newest first

      function monthlyRealized(store) {
        const out = new Map();
        const costMap = new Map();
        for (const tx of store.transactions.slice().sort((a, b) => {
          const ak = a.tradeDate || a.bookDate || '';
          const bk = b.tradeDate || b.bookDate || '';
          return ak.localeCompare(bk);
        })) {
          const cat = classify(tx.type);
          if (cat !== 'BUY' && cat !== 'SELL') continue;
          if (tx.type !== 'KJØPT' && !isRealizingSell(tx.type)) continue;
          if (!tx.security) continue;
          // Canonicalize so buys and sells under different Nordnet name
          // variants share one cost slot (else realized P/L is overstated).
          const security = window.Portfolio.canonicalName(tx.security);
          const qty = tx.qty || 0;
          const amount = amountNok(tx);
          if (!costMap.has(security)) costMap.set(security, { qty: 0, costSum: 0 });
          const slot = costMap.get(security);
          if (cat === 'BUY') {
            slot.qty += qty;
            slot.costSum += Math.abs(amount);
          } else {
            const avg = slot.qty > 0 ? slot.costSum / slot.qty : 0;
            const sold = Math.abs(qty);
            const realized = amount - avg * sold;
            const ym = (tx.bookDate || tx.tradeDate || '').slice(0, 7);
            if (ym) out.set(ym, (out.get(ym) || 0) + realized);
            const fracSold = slot.qty > 0 ? sold / slot.qty : 0;
            slot.costSum = Math.max(0, slot.costSum - slot.costSum * fracSold);
            slot.qty = Math.max(0, slot.qty - sold);
          }
        }
        return out;
      }

      // Month-end MV: true valuation at the month-end closes from the
      // price matrix. Null when nothing is priceable yet.
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

      function blank(ym) {
        return {
          ym,
          realized: 0, dividends: 0, fees: 0, tax: 0,
          deposits: 0, withdrawals: 0,
          endingCash: null, endingMv: null, deProxy: null, netResult: 0,
        };
      }

      function lastDayOf(ym) {
        const [y, m] = ym.split('-').map(Number);
        return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      }
    }

    function renderLedgerRows(months) {
      const byYear = new Map();
      for (const m of months) {
        const y = m.ym.slice(0, 4);
        if (!byYear.has(y)) byYear.set(y, []);
        byYear.get(y).push(m);
      }
      const sumMonths = (ms) => ms.reduce((acc, m) => ({
        netResult: acc.netResult + m.netResult,
        realized: acc.realized + m.realized,
        dividends: acc.dividends + m.dividends,
        fees: acc.fees + m.fees,
        tax: acc.tax + m.tax,
        deposits: acc.deposits + m.deposits,
        withdrawals: acc.withdrawals + m.withdrawals,
      }), { netResult: 0, realized: 0, dividends: 0, fees: 0, tax: 0, deposits: 0, withdrawals: 0 });
      const yearEnd = (ms) => ms[0]
        ? { endingCash: ms[0].endingCash, endingMv: ms[0].endingMv, deProxy: ms[0].deProxy }
        : { endingCash: null, endingMv: null, deProxy: null };

      let lastYear = null;
      return months.map((m) => {
        const year = m.ym.slice(0, 4);
        let header = '';
        if (year !== lastYear) {
          const yr = byYear.get(year);
          const sum = sumMonths(yr);
          const end = yearEnd(yr);
          header = `
            <tr class="year-header">
              <td><strong>${year}</strong></td>
              <td class="text-right ${pctClass(sum.netResult)}"><strong>${fmtNok(sum.netResult)}</strong></td>
              <td class="text-right ${pctClass(sum.realized)}">${fmtNok(sum.realized)}</td>
              <td class="text-right">${fmtNok(sum.dividends)}</td>
              <td class="text-right">${fmtNok(sum.fees)}</td>
              <td class="text-right">${fmtNok(sum.tax)}</td>
              <td class="text-right">${fmtNok(sum.deposits)}</td>
              <td class="text-right">${fmtNok(sum.withdrawals)}</td>
              <td class="text-right">${end.endingCash != null ? fmtNok(end.endingCash) : '—'}</td>
              <td class="text-right">${end.endingMv != null ? fmtNok(end.endingMv) : '—'}</td>
              <td class="text-right">${end.deProxy != null ? fmtPct(end.deProxy * 100, false) : '—'}</td>
            </tr>
          `;
        }
        lastYear = year;
        return header + `
          <tr>
            <td>${m.ym}</td>
            <td class="text-right ${pctClass(m.netResult)}"><strong>${fmtNok(m.netResult)}</strong></td>
            <td class="text-right ${pctClass(m.realized)}">${fmtNok(m.realized)}</td>
            <td class="text-right">${fmtNok(m.dividends)}</td>
            <td class="text-right text-muted">${fmtNok(m.fees)}</td>
            <td class="text-right text-muted">${fmtNok(m.tax)}</td>
            <td class="text-right">${fmtNok(m.deposits)}</td>
            <td class="text-right text-muted">${fmtNok(m.withdrawals)}</td>
            <td class="text-right">${m.endingCash != null ? fmtNok(m.endingCash) : '—'}</td>
            <td class="text-right">${m.endingMv != null ? fmtNok(m.endingMv) : '—'}</td>
            <td class="text-right">${m.deProxy != null ? fmtPct(m.deProxy * 100, false) : '—'}</td>
          </tr>
        `;
      }).join('');
    }
  }

  // ─── Data explorer (from data.js) ──────────────────────────────────────────

  // The old data.html carried these styles in its <head>; the SPA shell has a
  // single stylesheet, so they ride along with the view for now (shared-file
  // candidate: move into css/style.css).
  const EXPLORER_CSS = `
    .data-toolbar {
      display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
      margin-bottom: 14px; background: var(--panel);
      border: 1px solid var(--border); border-radius: var(--radius);
      padding: 12px 14px;
    }
    .data-toolbar label {
      display: inline-flex; align-items: center; gap: 6px;
      color: var(--muted); font-size: 0.82rem; text-transform: uppercase;
      letter-spacing: 1px;
    }
    .data-toolbar select, .data-toolbar input[type="search"] {
      background: var(--bg); color: var(--text);
      border: 1px solid var(--border); border-radius: 8px;
      padding: 7px 10px; font-size: 0.9rem; width: auto;
    }
    .data-toolbar .grow { flex: 1; }
    .data-toolbar .count { color: var(--muted); font-size: 0.85rem; }
    .measure-chips { display: inline-flex; gap: 4px; flex-wrap: wrap; align-items: center; }
    .measure-chips .m-chip {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 4px 9px; border-radius: 999px;
      background: var(--bg); border: 1px solid var(--border);
      color: var(--muted); font-size: 0.78rem; font-weight: 500;
      cursor: pointer; user-select: none; transition: all 0.12s;
      text-transform: none; letter-spacing: 0;
    }
    .measure-chips .m-chip input { display: none; }
    .measure-chips .m-chip:hover { border-color: var(--accent); color: var(--text); }
    .measure-chips .m-chip.checked { background: var(--accent); color: #051a0a; border-color: var(--accent); }
    .data-table-wrap {
      width: 100%; overflow-x: auto;
      border: 1px solid var(--border); border-radius: var(--radius);
      background: var(--panel); box-shadow: var(--shadow);
    }
    .data-table {
      font-size: 0.82rem; width: max-content; min-width: 100%;
      border: 0; border-radius: 0; box-shadow: none;
    }
    .data-table th, .data-table td { padding: 6px 10px; white-space: nowrap; }
    .data-table th.sortable { cursor: pointer; user-select: none; white-space: nowrap; }
    .data-table th.sortable:hover { color: var(--text); }
    .data-table th .sort-arrow {
      display: inline-block; width: 10px; margin-left: 4px;
      color: var(--muted); font-size: 0.72rem;
    }
    .data-table th.sorted .sort-arrow { color: var(--accent); }
    .data-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
    .data-table th.num { text-align: right; }
    .data-table tr.summary-top td {
      background: var(--panel-2); border-bottom: 2px solid var(--border);
      font-weight: 600; color: var(--text); position: sticky; top: 0;
    }
    .data-table tr.summary-top td.label { color: var(--muted); text-transform: uppercase; letter-spacing: 1.2px; font-size: 0.78rem; }
    .data-table tr:hover td { background: rgba(106, 209, 255, 0.04); }
    .type-pill {
      display: inline-block; padding: 2px 8px; border-radius: 999px;
      font-size: 0.74rem; font-weight: 600; background: var(--panel-2);
      color: var(--muted); border: 1px solid var(--border);
    }
    .type-KJØPT { color: #ff9da4; border-color: rgba(255, 91, 91, 0.35); }
    .type-SALG, .type-SOLGT { color: var(--positive); border-color: rgba(62, 224, 127, 0.35); }
    .type-UTBYTTE { color: var(--accent-2); border-color: rgba(255, 201, 79, 0.35); }
  `;

  function renderExplorer(el, ctx) {
    const { store, me } = ctx;
    const { canonicalName } = window.Portfolio;
    const Fmt = window.Fmt;

    el.innerHTML = `
      <style>${EXPLORER_CSS}</style>
      <div class="data-toolbar">
        <label>Mode
          <select id="mode">
            <option value="flat">Flat</option>
            <option value="pivot">Pivot</option>
          </select>
        </label>
        <label id="pivot-group-wrap" hidden>Group by
          <select id="pivot-group">
            <option value="security">Stock</option>
            <option value="type">Type</option>
            <option value="year">Year</option>
            <option value="month">Year-month</option>
            <option value="currency">Currency</option>
          </select>
        </label>
        <label id="pivot-group2-wrap" hidden>Then by
          <select id="pivot-group2">
            <option value="">(none)</option>
            <option value="security">Stock</option>
            <option value="type">Type</option>
            <option value="year">Year</option>
            <option value="month">Year-month</option>
            <option value="currency">Currency</option>
          </select>
        </label>
        <span id="pivot-measure-wrap" class="measure-chips" hidden></span>
        <input type="search" id="filter" placeholder="Filter…" aria-label="Filter rows" />
        <span class="grow"></span>
        <span class="count" id="count"></span>
      </div>

      <div class="range-picker" id="range-picker" style="margin-bottom:14px">
        <button class="preset" data-preset="1m">1M</button>
        <button class="preset" data-preset="6m">6M</button>
        <button class="preset" data-preset="ytd">YTD</button>
        <button class="preset" data-preset="1y">1Y</button>
        <button class="preset active" data-preset="all">All</button>
        <button class="preset" data-preset="custom">Custom</button>
        <span class="sep" id="custom-sep" style="display:none">·</span>
        <input type="date" id="date-from" aria-label="From date" style="display:none" />
        <span class="sep" id="custom-sep2" style="display:none">→</span>
        <input type="date" id="date-to" aria-label="To date" style="display:none" />
      </div>

      <div id="root">Loading…</div>
    `;

    const $ = (sel) => el.querySelector(sel);

    // Join keys: current derived holdings + Dim-values.
    const currentHoldings = window.Portfolio.currentHoldings(store);
    const holdingsBySec = new Map();
    let latestSnapTotalMv = 0;
    for (const h of currentHoldings) {
      if (!holdingsBySec.has(h.security)) holdingsBySec.set(h.security, h);
      latestSnapTotalMv += Number(h.marketValueNok) || 0;
    }
    const latestSnap = window.Portfolio.snapshotDate(store);
    const metaBySec = new Map();
    for (const m of store.meta) metaBySec.set(m.security, m);

    const rows = store.transactions.map((t) => {
      const can = canonicalName(t.security);
      const h = holdingsBySec.get(can);
      const m = metaBySec.get(t.security) || metaBySec.get(can);
      return {
        trade_date: t.tradeDate,
        settle_date: t.settleDate,
        type: t.type,
        security: t.security,
        isin: t.isin,
        qty: t.qty,
        price: t.price,
        amount_nok: t.amount,
        currency: t.currency,
        fee: t.fee,
        running_balance: t.saldo,
        transaction_text: t.text,
        member: m ? m.memberString : '',
        factor: m ? m.factor : null,
        current_price: h ? h.currentPrice : null,
        current_qty: h ? h.qty : null,
        market_value_nok: h ? h.marketValueNok : null,
        return_pct: h ? h.returnPct : null,
      };
    });

    const FLAT_COLS = [
      { key: 'trade_date',       label: 'Trade date',  type: 'date' },
      { key: 'type',             label: 'Type',        type: 'pill' },
      { key: 'security',         label: 'Stock',       type: 'string' },
      { key: 'member',           label: 'Investors',   type: 'string' },
      { key: 'factor',           label: 'Factor',      type: 'num' },
      { key: 'qty',              label: 'Tx Qty',      type: 'num' },
      { key: 'price',            label: 'Tx Price',    type: 'num' },
      { key: 'amount_nok',       label: 'Amount NOK',  type: 'money' },
      { key: 'fee',              label: 'Fee',         type: 'money' },
      { key: 'currency',         label: 'Curr',        type: 'string' },
      { key: 'current_price',    label: 'Price now',   type: 'num' },
      { key: 'current_qty',      label: 'Qty now',     type: 'num' },
      { key: 'market_value_nok', label: 'MV now',      type: 'money' },
    ];
    const SUM_COLS = new Set(['qty', 'amount_nok', 'fee', 'market_value_nok']);

    const modeSel = $('#mode');
    const groupSel = $('#pivot-group');
    const group2Sel = $('#pivot-group2');
    const measureWrap = $('#pivot-measure-wrap');
    const groupWrap = $('#pivot-group-wrap');
    const group2Wrap = $('#pivot-group2-wrap');
    const filterEl = $('#filter');
    const countEl = $('#count');
    const fromInput = $('#date-from');
    const toInput = $('#date-to');

    const MEASURES = [
      { id: 'count',      label: 'Count',         type: 'int',   sumField: 'count' },
      { id: 'sum-amount', label: 'Σ Amount NOK',  type: 'money', sumField: 'sumAmount' },
      { id: 'sum-qty',    label: 'Σ Qty',         type: 'num',   sumField: 'sumQty' },
      { id: 'sum-fee',    label: 'Σ Fee',         type: 'money', sumField: 'sumFee' },
      { id: 'sum-mv',     label: 'Σ MV now',      type: 'money', sumField: 'sumMv',  dedupeBy: 'security' },
    ];
    const storedMeasures = JSON.parse(localStorage.getItem('portal.data.measures') || '["count","sum-amount"]');
    const activeMeasures = new Set(storedMeasures);

    measureWrap.innerHTML = MEASURES.map((m) => `
      <label class="m-chip ${activeMeasures.has(m.id) ? 'checked' : ''}">
        <input type="checkbox" value="${m.id}" ${activeMeasures.has(m.id) ? 'checked' : ''}> ${Fmt.escapeHtml(m.label)}
      </label>
    `).join('');
    measureWrap.querySelectorAll('input').forEach((cb) => {
      cb.addEventListener('change', () => {
        cb.closest('.m-chip').classList.toggle('checked', cb.checked);
        if (cb.checked) activeMeasures.add(cb.value); else activeMeasures.delete(cb.value);
        localStorage.setItem('portal.data.measures', JSON.stringify(Array.from(activeMeasures)));
        render();
      });
    });

    let sortBy = { column: 'trade_date', direction: 'desc' };

    let minTradeDate = null, maxTradeDate = null;
    for (const r of rows) {
      if (!r.trade_date) continue;
      if (!minTradeDate || r.trade_date < minTradeDate) minTradeDate = r.trade_date;
      if (!maxTradeDate || r.trade_date > maxTradeDate) maxTradeDate = r.trade_date;
    }
    if (minTradeDate) { fromInput.min = minTradeDate; toInput.min = minTradeDate; }
    if (maxTradeDate) { fromInput.max = maxTradeDate; toInput.max = maxTradeDate; }

    const storedRange = JSON.parse(localStorage.getItem('portal.data.range') || '{"preset":"all"}');
    let range = { preset: storedRange.preset || 'all', from: storedRange.from || null, to: storedRange.to || null };
    if (range.preset === 'custom' && range.from && range.to) {
      fromInput.value = range.from;
      toInput.value = range.to;
      showCustomInputs(true);
    }
    setActivePreset(range.preset);

    function dateBounds(preset) {
      const today = new Date();
      const todayStr = today.toISOString().slice(0, 10);
      const addMonths = (d, n) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };
      const addYears  = (d, n) => { const x = new Date(d); x.setUTCFullYear(x.getUTCFullYear() + n); return x.toISOString().slice(0, 10); };
      switch (preset) {
        case '1m':  return { from: addMonths(today, -1), to: todayStr };
        case '6m':  return { from: addMonths(today, -6), to: todayStr };
        case 'ytd': return { from: `${today.getUTCFullYear()}-01-01`, to: todayStr };
        case '1y':  return { from: addYears(today, -1),  to: todayStr };
        case 'all': return { from: null, to: null };
        default:    return { from: null, to: null };
      }
    }

    function inRange(tradeDate) {
      if (!range.from && !range.to) return true;
      if (!tradeDate) return false;
      if (range.from && tradeDate < range.from) return false;
      if (range.to && tradeDate > range.to) return false;
      return true;
    }

    function setActivePreset(preset) {
      el.querySelectorAll('#range-picker .preset').forEach((b) => {
        b.classList.toggle('active', b.dataset.preset === preset);
      });
    }
    function showCustomInputs(show) {
      $('#custom-sep').style.display  = show ? 'inline' : 'none';
      $('#custom-sep2').style.display = show ? 'inline' : 'none';
      fromInput.style.display = show ? 'inline-block' : 'none';
      toInput.style.display   = show ? 'inline-block' : 'none';
    }

    function persistRange() {
      localStorage.setItem('portal.data.range', JSON.stringify(range));
    }

    el.querySelectorAll('#range-picker .preset').forEach((btn) => {
      btn.addEventListener('click', () => {
        const p = btn.dataset.preset;
        if (p === 'custom') {
          if (!fromInput.value) fromInput.value = range.from || minTradeDate || '';
          if (!toInput.value)   toInput.value   = range.to   || maxTradeDate || '';
          range = { preset: 'custom', from: fromInput.value || null, to: toInput.value || null };
          showCustomInputs(true);
          setActivePreset('custom');
          if (range.from && range.to) { persistRange(); render(); }
          return;
        }
        const b = dateBounds(p);
        range = { preset: p, from: b.from, to: b.to };
        showCustomInputs(false);
        setActivePreset(p);
        persistRange();
        render();
      });
    });
    const onCustomChange = () => {
      if (!fromInput.value || !toInput.value) return;
      range = { preset: 'custom', from: fromInput.value, to: toInput.value };
      persistRange();
      render();
    };
    fromInput.addEventListener('change', onCustomChange);
    toInput.addEventListener('change', onCustomChange);

    document.getElementById('pf-when').textContent =
      `${rows.length} transactions · joined with derived holdings (${latestSnap || 'no prices yet'}) + Dim-values · signed in as ${me.displayName} (${me.investorCode})`;

    for (const sel of [groupSel, group2Sel]) {
      if (sel && !sel.querySelector('option[value="member"]')) {
        const opt = document.createElement('option');
        opt.value = 'member'; opt.textContent = 'Investors';
        sel.appendChild(opt);
      }
    }

    [modeSel, groupSel, group2Sel].forEach((elm) => elm.addEventListener('change', () => {
      if (modeSel.value === 'pivot') {
        const first = [...activeMeasures][0] || 'count';
        sortBy = { column: 'measure:' + first, direction: 'desc' };
      } else {
        sortBy = { column: 'trade_date', direction: 'desc' };
      }
      render();
    }));
    filterEl.addEventListener('input', render);

    render();

    function render() {
      const pivot = modeSel.value === 'pivot';
      groupWrap.hidden = !pivot;
      group2Wrap.hidden = !pivot;
      measureWrap.hidden = !pivot;
      if (pivot) renderPivot(); else renderFlat();
    }

    function renderFlat() {
      const filtered = applyFilter(rows);
      const sorted = filtered.slice().sort(compareFlat);
      countEl.textContent = `${sorted.length} / ${rows.length} rows`;

      const totals = {};
      for (const col of SUM_COLS) totals[col] = 0;
      for (const r of sorted) {
        for (const col of SUM_COLS) {
          if (col === 'market_value_nok') continue;
          const v = Number(r[col]);
          if (Number.isFinite(v)) totals[col] += v;
        }
      }
      totals.market_value_nok = latestSnapTotalMv;

      $('#root').innerHTML = `
        <div class="data-table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                ${FLAT_COLS.map((c) => `
                  <th class="sortable ${sortBy.column === c.key ? 'sorted' : ''} ${c.type === 'num' || c.type === 'money' ? 'num' : ''}"
                      data-sort="${c.key}">
                    ${Fmt.escapeHtml(c.label)}${sortArrow(c.key)}
                  </th>
                `).join('')}
              </tr>
            </thead>
            <tbody>
              <tr class="summary-top">
                <td class="label" colspan="5">Σ Total (${sorted.length})</td>
                ${FLAT_COLS.slice(5).map((c) => `
                  <td class="${c.type === 'num' || c.type === 'money' ? 'num' : ''}">
                    ${SUM_COLS.has(c.key) ? formatCell(totals[c.key], c.type) : ''}
                  </td>
                `).join('')}
              </tr>
              ${sorted.map((r) => `
                <tr>
                  ${FLAT_COLS.map((c) => `<td class="${c.type === 'num' || c.type === 'money' ? 'num' : ''}">${formatCell(r[c.key], c.type)}</td>`).join('')}
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
      wireSort();
    }

    function compareFlat(a, b) {
      const dir = sortBy.direction === 'asc' ? 1 : -1;
      const col = FLAT_COLS.find((c) => c.key === sortBy.column);
      const av = a[sortBy.column]; const bv = b[sortBy.column];
      const numeric = col && (col.type === 'num' || col.type === 'money');
      let cmp;
      if (numeric) {
        const an = av == null ? -Infinity : Number(av);
        const bn = bv == null ? -Infinity : Number(bv);
        cmp = an < bn ? -1 : an > bn ? 1 : 0;
      } else {
        cmp = (av || '').toString().toLowerCase().localeCompare((bv || '').toString().toLowerCase(), 'nb');
      }
      return cmp * dir;
    }

    function renderPivot() {
      const filtered = applyFilter(rows);
      const g1 = groupSel.value;
      const g2 = group2Sel.value;
      const measures = MEASURES.filter((m) => activeMeasures.has(m.id));

      const buckets = new Map();
      function ensure(k1, k2) {
        const key = `${k1}|||${k2}`;
        if (!buckets.has(key)) {
          buckets.set(key, {
            g1: k1, g2: k2, count: 0,
            sumAmount: 0, sumQty: 0, sumFee: 0, sumMv: 0,
            _seenSec: new Set(),
          });
        }
        return buckets.get(key);
      }
      for (const r of filtered) {
        const k1 = groupKey(r, g1);
        const k2 = g2 ? groupKey(r, g2) : '';
        const b = ensure(k1, k2);
        b.count += 1;
        b.sumAmount += Number(r.amount_nok) || 0;
        b.sumQty    += Number(r.qty) || 0;
        b.sumFee    += Number(r.fee) || 0;
        const sec = (r.security || '').toString();
        if (sec && !b._seenSec.has(sec) && r.market_value_nok != null) {
          b._seenSec.add(sec);
          b.sumMv += Number(r.market_value_nok) || 0;
        }
      }

      let pivotRows = Array.from(buckets.values());
      pivotRows.sort((a, b) => {
        const dir = sortBy.direction === 'asc' ? 1 : -1;
        if (sortBy.column === 'g1') return a.g1.toString().localeCompare(b.g1.toString(), 'nb') * dir;
        if (sortBy.column === 'g2') return a.g2.toString().localeCompare(b.g2.toString(), 'nb') * dir;
        if (sortBy.column.startsWith('measure:')) {
          const id = sortBy.column.slice('measure:'.length);
          const m = MEASURES.find((x) => x.id === id);
          if (m) {
            const av = a[m.sumField] || 0;
            const bv = b[m.sumField] || 0;
            return (av - bv) * dir;
          }
        }
        return a.g1.toString().localeCompare(b.g1.toString(), 'nb') * dir;
      });

      countEl.textContent = `${pivotRows.length} groups · ${filtered.length} rows`;

      const totals = { count: 0, sumAmount: 0, sumQty: 0, sumFee: 0, sumMv: latestSnapTotalMv };
      for (const r of filtered) {
        totals.count += 1;
        totals.sumAmount += Number(r.amount_nok) || 0;
        totals.sumQty    += Number(r.qty) || 0;
        totals.sumFee    += Number(r.fee) || 0;
      }

      const showG2 = !!g2;
      const headerCols = [
        { id: 'g1',    label: groupLabel(g1),  num: false },
        ...(showG2 ? [{ id: 'g2', label: groupLabel(g2), num: false }] : []),
        ...measures.map((m) => ({ id: 'measure:' + m.id, label: m.label, num: true, measure: m })),
      ];

      if (!measures.length) {
        $('#root').innerHTML = '<p class="text-muted">Pick at least one measure to see the pivot.</p>';
        return;
      }

      $('#root').innerHTML = `
        <div class="data-table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                ${headerCols.map((c) => `
                  <th class="sortable ${c.num ? 'num' : ''} ${sortBy.column === c.id ? 'sorted' : ''}" data-sort="${c.id}">
                    ${Fmt.escapeHtml(c.label)}${sortArrow(c.id)}
                  </th>
                `).join('')}
              </tr>
            </thead>
            <tbody>
              <tr class="summary-top">
                <td class="label" ${showG2 ? 'colspan="2"' : ''}>Σ Total</td>
                ${measures.map((m) => `<td class="num">${formatCell(totals[m.sumField], m.type)}</td>`).join('')}
              </tr>
              ${pivotRows.map((b) => `
                <tr>
                  <td>${Fmt.escapeHtml(b.g1)}</td>
                  ${showG2 ? `<td>${Fmt.escapeHtml(b.g2)}</td>` : ''}
                  ${measures.map((m) => `<td class="num">${formatCell(b[m.sumField], m.type)}</td>`).join('')}
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
      wireSort();
    }

    function groupKey(r, groupBy) {
      switch (groupBy) {
        case 'security': return r.security || '(blank)';
        case 'type': return r.type || '(blank)';
        case 'currency': return r.currency || '(blank)';
        case 'member': return r.member || '(unmapped)';
        case 'year': return (r.trade_date || '').slice(0, 4) || '(no date)';
        case 'month': return (r.trade_date || '').slice(0, 7) || '(no date)';
        default: return '(blank)';
      }
    }

    function groupLabel(groupBy) {
      return { security: 'Stock', type: 'Type', currency: 'Currency', member: 'Investors', year: 'Year', month: 'Year-month' }[groupBy] || groupBy;
    }

    function applyFilter(arr) {
      const f = filterEl.value.trim().toLowerCase();
      return arr.filter((r) => {
        if (!inRange(r.trade_date)) return false;
        if (!f) return true;
        return (
          (r.security || '').toLowerCase().includes(f)
          || (r.type || '').toLowerCase().includes(f)
          || (r.currency || '').toLowerCase().includes(f)
          || (r.member || '').toLowerCase().includes(f)
          || (r.transaction_text || '').toLowerCase().includes(f)
          || (r.trade_date || '').includes(f)
        );
      });
    }

    function wireSort() {
      el.querySelectorAll('th.sortable').forEach((th) => {
        th.addEventListener('click', () => {
          const col = th.dataset.sort;
          if (sortBy.column === col) sortBy.direction = sortBy.direction === 'asc' ? 'desc' : 'asc';
          else {
            const numericDefaults = ['qty', 'price', 'amount_nok', 'fee', 'running_balance', 'count', 'measure', 'trade_date', 'current_price', 'current_qty', 'market_value_nok', 'factor'];
            sortBy = { column: col, direction: numericDefaults.includes(col) ? 'desc' : 'asc' };
          }
          render();
        });
      });
    }

    function sortArrow(column) {
      if (sortBy.column !== column) return '<span class="sort-arrow">↕</span>';
      return `<span class="sort-arrow">${sortBy.direction === 'asc' ? '▲' : '▼'}</span>`;
    }

    function formatCell(v, type) {
      if (v == null || v === '') return '<span class="text-muted">—</span>';
      switch (type) {
        case 'money': return (Math.round(Number(v))).toLocaleString('nb-NO');
        case 'num':
          return Number.isInteger(Number(v))
            ? Number(v).toLocaleString('nb-NO')
            : Number(v).toLocaleString('nb-NO', { maximumFractionDigits: 4 });
        case 'int': return Math.round(Number(v)).toLocaleString('nb-NO');
        case 'date': return Fmt.escapeHtml(v);
        case 'pill': return `<span class="type-pill type-${Fmt.escapeHtml(v)}">${Fmt.escapeHtml(v)}</span>`;
        default: return Fmt.escapeHtml(v);
      }
    }
  }
})();
