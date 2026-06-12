// Portfolio report — trading activity. Pick a period and see every purchase
// and sale in it: a buy/sell dot timeline, a summary, and a trades table.
// Account-wide. Buys = KJØPT-family, sells = SALG-family (via Ledger.classify);
// amounts are NOK (Ledger.amountNok handles FX); attribution via Dim-values.

(async function () {
  const { store } = await window.Nav.bootstrap('report');
  const { fmtNok, fmtQty, escapeHtml } = window.Fmt;
  const { classify, amountNok, splitForSecurity } = window.Ledger;
  const canon = window.Portfolio.canonicalName;
  const root = document.getElementById('root');

  let sheetName = '';
  try { sheetName = await window.Sheet.spreadsheetTitle(); } catch (_e) { sheetName = ''; }

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
    if (current.preset === 'custom' && current.from && current.to) return { from: current.from, to: current.to };
    const minus = (months) => { const d = new Date(today); d.setUTCMonth(d.getUTCMonth() - months); return d.toISOString().slice(0, 10); };
    switch (current.preset) {
      case '1m': return { from: minus(1), to: todayStr };
      case '6m': return { from: minus(6), to: todayStr };
      case '1y': return { from: minus(12), to: todayStr };
      case 'all': return { from: earliestTradeDate(), to: todayStr };
      case 'ytd':
      default: return { from: `${today.getUTCFullYear()}-01-01`, to: todayStr };
    }
  }

  // Buys/sells within [from, to].
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

  refresh();

  function refresh() {
    const win = computeWindow();
    localStorage.setItem('portal.report.range', JSON.stringify(current));
    const trades = tradesIn(win.from, win.to);
    const buys = trades.filter((t) => t.type === 'buy');
    const sells = trades.filter((t) => t.type === 'sell');
    const bought = buys.reduce((a, t) => a + t.amount, 0);
    const sold = sells.reduce((a, t) => a + t.amount, 0);

    root.innerHTML = `
      <div class="hero">
        <div>
          <h2>Trading activity${sheetName ? ` · ${escapeHtml(sheetName)}` : ''}</h2>
          <div class="when">All purchases and sales · ${win.from} → ${win.to}</div>
        </div>
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
      <div style="overflow-x:auto">
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
    `;

    const mount = document.getElementById('trade-chart');
    if (mount) mount.appendChild(window.Charts.tradeScatter({ trades, from: win.from, to: win.to }));
    wirePicker();
  }

  function renderPicker(win) {
    return `
      <div class="range-picker" id="range-picker">
        ${PRESETS.map((p) => `<button class="preset ${win.preset === p.id ? 'active' : ''}" data-preset="${p.id}">${p.label}</button>`).join('')}
        <span class="sep" id="custom-sep" style="display:${win.preset === 'custom' ? 'inline' : 'none'}">·</span>
        <input type="date" id="date-from" value="${win.from || ''}" style="display:${win.preset === 'custom' ? 'inline-block' : 'none'}" />
        <span class="sep" id="custom-sep2" style="display:${win.preset === 'custom' ? 'inline' : 'none'}">→</span>
        <input type="date" id="date-to" value="${win.to || ''}" style="display:${win.preset === 'custom' ? 'inline-block' : 'none'}" />
      </div>
    `;
  }

  function wirePicker() {
    document.querySelectorAll('#range-picker .preset').forEach((btn) => {
      btn.addEventListener('click', () => {
        const p = btn.dataset.preset;
        if (p === 'custom') {
          current.preset = 'custom';
          document.getElementById('custom-sep').style.display = 'inline';
          document.getElementById('custom-sep2').style.display = 'inline';
          document.getElementById('date-from').style.display = 'inline-block';
          document.getElementById('date-to').style.display = 'inline-block';
          document.querySelectorAll('#range-picker .preset').forEach((b) => b.classList.toggle('active', b.dataset.preset === 'custom'));
          return;
        }
        current.preset = p; current.from = null; current.to = null;
        refresh();
      });
    });
    const fromInput = document.getElementById('date-from');
    const toInput = document.getElementById('date-to');
    const onChange = () => {
      if (!fromInput.value || !toInput.value) return;
      current.preset = 'custom'; current.from = fromInput.value; current.to = toInput.value;
      refresh();
    };
    if (fromInput) fromInput.addEventListener('change', onChange);
    if (toInput) toInput.addEventListener('change', onChange);
  }
})();
