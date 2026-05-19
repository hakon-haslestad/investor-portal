(async function () {
  const { store, me } = await window.Nav.bootstrap('home');
  const { fmtNok, fmtPct, fmtQty, pctClass } = window.Fmt;
  const names = window.Copy.namesFromMembers(store.members);

  const params = new URLSearchParams(location.search);
  const code = params.get('code') || me.investorCode;
  const detail = window.Portfolio.investorDetail(store, code);
  const root = document.getElementById('root');
  if (!detail) {
    root.innerHTML = `<div class="flash error">No data for investor code ${code}.</div>`;
    return;
  }
  const displayName = names[code] || code;
  const s = detail.summary;

  const verdict = window.Copy.verdictFromReturn(displayName, s.portfolioReturnPct);

  root.innerHTML = `
    <div class="hero">
      <h2>${displayName} <span class="text-muted">(${detail.code})</span></h2>
      <div class="when"><a href="./index.html">← back to dashboard</a></div>
    </div>
    <div class="flash success">${verdict}</div>

    <div class="kpi-grid">
      <div class="kpi-card"><div class="label">Total value</div><div class="value">${fmtNok(s.totalValue)}</div></div>
      <div class="kpi-card"><div class="label">Stocks MV</div><div class="value">${fmtNok(s.marketValue)}</div></div>
      <div class="kpi-card"><div class="label">Dry powder (share)</div><div class="value">${fmtNok(s.cash)}</div></div>
      <div class="kpi-card"><div class="label">Total invested</div><div class="value">${fmtNok(s.invested)}</div></div>
      <div class="kpi-card"><div class="label">Realized</div><div class="value ${pctClass(s.realized)}">${fmtNok(s.realized)}</div></div>
      <div class="kpi-card"><div class="label">Unrealized</div><div class="value ${pctClass(s.unrealized)}">${fmtNok(s.unrealized)}</div></div>
      <div class="kpi-card"><div class="label">Dividends</div><div class="value">${fmtNok(s.dividends)}</div></div>
      <div class="kpi-card"><div class="label">Return %</div><div class="value ${pctClass(s.portfolioReturnPct)}"><strong>${fmtPct(s.portfolioReturnPct)}</strong></div></div>
    </div>

    <div class="section-title">Current holdings (${s.holdings.length})</div>
    ${s.holdings.length === 0 ? '<p class="text-muted">No active positions. All cashed out.</p>' : `
    <table>
      <thead><tr>
        <th>Security</th>
        <th class="text-right">Qty</th>
        <th class="text-right">Avg cost</th>
        <th class="text-right">Current px</th>
        <th class="text-right">Market value</th>
        <th class="text-right">Unrealized</th>
        <th class="text-right">U/L %</th>
        <th>Research</th>
      </tr></thead>
      <tbody>
        ${s.holdings.map((h) => {
          const q = encodeURIComponent(h.security);
          const ir = encodeURIComponent(h.security + ' investor relations');
          return `
          <tr>
            <td>${h.security} ${h.weight < 1 ? `<span class="tag">${(h.weight*100).toFixed(0)}% share</span>` : ''}</td>
            <td class="text-right">${fmtQty(h.qty)}</td>
            <td class="text-right">${fmtNok(h.avgCost)}</td>
            <td class="text-right">${fmtNok(h.currentPrice)}</td>
            <td class="text-right">${fmtNok(h.marketValue)}</td>
            <td class="text-right ${pctClass(h.unrealized)}">${fmtNok(h.unrealized)}</td>
            <td class="text-right ${pctClass(h.unrealizedPct)}">${fmtPct(h.unrealizedPct)}</td>
            <td class="links">
              <a target="_blank" rel="noopener" href="https://www.nordnet.no/market/search?query=${q}">Nordnet</a>
              · <a target="_blank" rel="noopener" href="https://finance.yahoo.com/lookup?s=${q}">Yahoo</a>
              · <a target="_blank" rel="noopener" href="https://www.google.com/search?q=${ir}">IR</a>
            </td>
          </tr>
        `;
        }).join('')}
      </tbody>
    </table>
    `}

    ${detail.previous.length === 0 ? '' : `
    <div class="section-title">Previous holdings (${detail.previous.length}) <span class="text-muted text-small">closed positions</span></div>
    <table>
      <thead><tr>
        <th>Security</th>
        <th class="text-right">Invested</th>
        <th class="text-right">Proceeds</th>
        <th class="text-right">Dividends</th>
        <th class="text-right">Realized</th>
        <th class="text-right">Net result</th>
        <th class="text-right">Return %</th>
        <th>First → last</th>
        <th>Research</th>
      </tr></thead>
      <tbody>
        ${detail.previous.map((p) => {
          const q = encodeURIComponent(p.security);
          const ir = encodeURIComponent(p.security + ' investor relations');
          return `
          <tr>
            <td>${p.security}</td>
            <td class="text-right text-muted">${fmtNok(p.invested)}</td>
            <td class="text-right text-muted">${fmtNok(p.proceeds)}</td>
            <td class="text-right">${fmtNok(p.dividends)}</td>
            <td class="text-right ${pctClass(p.realized)}">${fmtNok(p.realized)}</td>
            <td class="text-right ${pctClass(p.netResult)}"><strong>${fmtNok(p.netResult)}</strong></td>
            <td class="text-right ${pctClass(p.returnPct)}">${fmtPct(p.returnPct)}</td>
            <td class="text-small text-muted">${p.firstDate || '—'} → ${p.lastDate || '—'}</td>
            <td class="links">
              <a target="_blank" rel="noopener" href="https://www.nordnet.no/market/search?query=${q}">Nordnet</a>
              · <a target="_blank" rel="noopener" href="https://finance.yahoo.com/lookup?s=${q}">Yahoo</a>
              · <a target="_blank" rel="noopener" href="https://www.google.com/search?q=${ir}">IR</a>
            </td>
          </tr>
        `;
        }).join('')}
      </tbody>
    </table>
    `}

    <div class="section-title">Recent transactions (last ${detail.recent.length})</div>
    <table>
      <thead><tr>
        <th>Date</th><th>Type</th><th>Security</th>
        <th class="text-right">Qty (share)</th><th class="text-right">Price</th>
        <th class="text-right">Amount (share)</th>
      </tr></thead>
      <tbody>
        ${detail.recent.map((t) => `
          <tr>
            <td class="text-small">${t.tradeDate || ''}</td>
            <td class="text-small"><span class="tag">${t.type}</span></td>
            <td>${t.security || '<span class="text-muted">—</span>'}</td>
            <td class="text-right">${fmtQty(t.qty)}</td>
            <td class="text-right">${fmtNok(t.price)}</td>
            <td class="text-right ${pctClass(t.amount)}">${fmtNok(t.amount)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
})();
