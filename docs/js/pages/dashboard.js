(async function () {
  const { store, me } = await window.Nav.bootstrap('home');
  const names = window.Copy.namesFromMembers(store.members);
  const { fmtNok, fmtPct, pctClass, PODIUM } = window.Fmt;

  const PRESETS = [
    { id: '1m', label: '1M' },
    { id: '6m', label: '6M' },
    { id: 'ytd', label: 'YTD' },
    { id: '1y', label: '1Y' },
    { id: 'all', label: 'All' },
    { id: 'custom', label: 'Custom' },
  ];

  const stored = JSON.parse(localStorage.getItem('portal.range') || '{}');
  let current = {
    preset: stored.preset || 'ytd',
    from: stored.from || null,
    to: stored.to || null,
  };

  const INVESTOR_COLORS = {
    HH: '#4ade80', HS: '#60a5fa', 'ØS': '#fbbf24', JC: '#f472b6', HF: '#a78bfa',
  };
  const INVESTOR_CODES = ['HH', 'HS', 'ØS', 'JC', 'HF'];

  refresh();

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
    paint(d);
    paintCharts();
  }

  function paintCharts() {
    const tsValue = window.TimeSeries.buildPortfolioValueSeries(store);
    const tsPnl = window.TimeSeries.buildCumulativePnlSeries(store);
    const tsCap = window.TimeSeries.buildCapitalVsReturnSeries(store);

    const valueSeries = INVESTOR_CODES.map((code) => ({
      name: `${code} ${names[code] || ''}`.trim(),
      color: INVESTOR_COLORS[code],
      points: tsValue.map((s) => ({ date: s.date, y: Math.max(0, s.perInvestor[code] || 0) })),
    }));
    const pnlSeries = INVESTOR_CODES.map((code) => ({
      name: `${code} ${names[code] || ''}`.trim(),
      color: INVESTOR_COLORS[code],
      points: tsPnl.map((s) => ({ date: s.date, y: s.perInvestor[code] || 0 })),
    }));
    const capSeries = [
      {
        name: 'Capital deployed',
        color: '#8a92a6',
        points: tsCap.map((s) => ({ date: s.date, y: s.invested })),
      },
      {
        name: 'Net return',
        color: '#3ee07f',
        points: tsCap.map((s) => ({ date: s.date, y: s.netReturn })),
      },
    ];

    const valueEl = document.getElementById('chart-value');
    const pnlEl = document.getElementById('chart-pnl');
    const capEl = document.getElementById('chart-capital');
    const legendEl = document.getElementById('chart-legend');
    if (!valueEl || !pnlEl || !capEl || !legendEl) return;
    valueEl.innerHTML = '';
    pnlEl.innerHTML = '';
    capEl.innerHTML = '';
    legendEl.innerHTML = '';

    valueEl.appendChild(window.Charts.stackedArea({
      series: valueSeries, width: 900, height: 240,
      title: 'Total portfolio value (book + unrealized lift)',
    }));
    pnlEl.appendChild(window.Charts.multiLine({
      series: pnlSeries, width: 900, height: 240,
      title: 'Cumulative net P/L per investor',
    }));
    capEl.appendChild(window.Charts.multiLine({
      series: capSeries, width: 900, height: 200,
      title: 'Capital deployed vs net return (group)',
    }));

    const investorLegend = INVESTOR_CODES.map((code) => ({
      name: `${code} · ${names[code] || ''}`,
      color: INVESTOR_COLORS[code],
    }));
    legendEl.appendChild(window.Charts.legend({ series: investorLegend }));
  }

  function paint(d) {
    const wm = d.windowMetrics;
    const root = document.getElementById('root');
    root.innerHTML = `
      <div class="hero">
        <div>
          <h2>Welcome back, ${me.displayName}. Here's the book.</h2>
          <div class="when">Snapshot: ${d.snapshotDate || '—'}</div>
        </div>
        ${renderPicker(d.window)}
      </div>

      <div class="section-title">Right now (current snapshot)</div>
      <div class="kpi-grid">
        <div class="kpi-card"><div class="label">Total portfolio</div><div class="value">${fmtNok(d.group.totalValue)}</div><div class="sub">positions + cash</div></div>
        <div class="kpi-card"><div class="label">Holdings MV</div><div class="value">${fmtNok(d.group.marketValue)}</div><div class="sub">active positions</div></div>
        <div class="kpi-card"><div class="label">Dry powder</div><div class="value">${fmtNok(d.group.cash)}</div><div class="sub">uncommitted cash</div></div>
        <div class="kpi-card"><div class="label">Unrealized P/L</div><div class="value ${pctClass(d.group.unrealized)}">${fmtNok(d.group.unrealized)}</div><div class="sub">mark-to-market</div></div>
      </div>

      <div class="section-title">Portfolio over time</div>
      <div class="chart-stack">
        <div class="chart-wrap" id="chart-value"></div>
        <div class="chart-wrap" id="chart-pnl"></div>
        <div class="chart-wrap" id="chart-capital"></div>
      </div>
      <div id="chart-legend"></div>

      <div class="section-title">In this window <span class="text-muted text-small">${prettyRange(d.window)}</span></div>
      <div class="kpi-grid">
        <div class="kpi-card"><div class="label">Period return</div><div class="value ${pctClass(wm.group.periodReturnPct)}">${fmtPct(wm.group.periodReturnPct)}</div><div class="sub">realized + dividends + price delta</div></div>
        <div class="kpi-card"><div class="label">Realized P/L</div><div class="value ${pctClass(wm.group.realizedInWindow)}">${fmtNok(wm.group.realizedInWindow)}</div><div class="sub">${wm.group.sellCount} sells</div></div>
        <div class="kpi-card"><div class="label">Dividends</div><div class="value">${fmtNok(wm.group.dividendsInWindow)}</div><div class="sub">received in window</div></div>
        <div class="kpi-card"><div class="label">Capital deployed</div><div class="value">${fmtNok(wm.group.buysInWindow)}</div><div class="sub">${wm.group.buyCount} buys</div></div>
        <div class="kpi-card"><div class="label">Net P/L</div><div class="value ${pctClass(wm.group.netPnlInWindow)}">${fmtNok(wm.group.netPnlInWindow)}</div><div class="sub">realized + divs + unrealized Δ</div></div>
      </div>

      <div class="section-title">By investor <span class="text-muted text-small">(period stats reflect ${prettyRange(d.window)})</span></div>
      <table>
        <thead><tr>
          <th>Investor</th>
          <th class="text-right">Total value <span class="text-muted text-small">(now)</span></th>
          <th class="text-right">Period return</th>
          <th class="text-right">Realized</th>
          <th class="text-right">Dividends</th>
          <th class="text-right">Bought</th>
          <th class="text-right">Sold</th>
          <th class="text-right">All-time return</th>
        </tr></thead>
        <tbody>
          ${Object.entries(d.perInvestor).map(([code, s]) => {
            const w = wm.perInvestor[code] || {};
            return `
              <tr class="row-link" onclick="location.href='./investor.html?code=${encodeURIComponent(code)}'">
                <td><strong>${code}</strong> <span class="text-muted text-small">${names[code] || ''}</span></td>
                <td class="text-right">${fmtNok(s.totalValue)}</td>
                <td class="text-right ${pctClass(w.periodReturnPct)}"><strong>${fmtPct(w.periodReturnPct)}</strong></td>
                <td class="text-right ${pctClass(w.realizedInWindow)}">${fmtNok(w.realizedInWindow)}</td>
                <td class="text-right">${fmtNok(w.dividendsInWindow)}</td>
                <td class="text-right text-muted">${fmtNok(w.buysInWindow)}</td>
                <td class="text-right text-muted">${fmtNok(w.sellsInWindow)}</td>
                <td class="text-right ${pctClass(s.portfolioReturnPct)}">${fmtPct(s.portfolioReturnPct)}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>

      <div class="section-title">Leaderboards</div>
      <div class="leaderboard">
        <div class="lb-card">
          <h3>This period</h3>
          ${d.leaderboards.period.map((r, i) => `
            <div class="row"><span class="who">${PODIUM[i]} ${r.code} <span class="text-muted text-small">${names[r.code] || ''}</span></span><span class="v ${pctClass(r.value)}">${fmtPct(r.value)}</span></div>
          `).join('')}
        </div>
        <div class="lb-card">
          <h3>All-time, no contest</h3>
          ${d.leaderboards.allTime.map((r, i) => `
            <div class="row"><span class="who">${PODIUM[i]} ${r.code}</span><span class="v ${pctClass(r.value)}">${fmtPct(r.value)}</span></div>
          `).join('')}
        </div>
        <div class="lb-card">
          <h3>Best single position (all-time)</h3>
          ${d.leaderboards.bestPicks.map((r) => {
            if (!r.pick) return `<div class="row"><span class="who">${r.code}</span><span class="v text-muted">no picks</span></div>`;
            return `<div class="row"><span class="who">${r.code} <span class="text-muted text-small">${r.pick.security}</span></span><span class="v positive">${fmtNok(r.pick.return)} (${fmtPct(r.pick.pct)})</span></div>`;
          }).join('')}
        </div>
        <div class="lb-card">
          <h3>Last 6 months — top of the table</h3>
          ${d.leaderboards.monthly.map((m) => `
            <div class="row"><span class="who">${m.month}</span><span class="v">${m.ranks.slice(0,3).map((r,i)=>`${PODIUM[i]} ${r.code}`).join(' · ')}</span></div>
          `).join('')}
        </div>
      </div>
    `;
    wirePicker();
  }

  function renderPicker(win) {
    return `
      <div class="range-picker" id="range-picker">
        ${PRESETS.map((p) => `
          <button class="preset ${win.preset === p.id ? 'active' : ''}" data-preset="${p.id}">${p.label}</button>
        `).join('')}
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
          document.querySelectorAll('#range-picker .preset').forEach((b) => {
            b.classList.toggle('active', b.dataset.preset === 'custom');
          });
          return;
        }
        current.preset = p; current.from = null; current.to = null;
        refresh();
      });
    });
    const fromInput = document.getElementById('date-from');
    const toInput = document.getElementById('date-to');
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
})();
