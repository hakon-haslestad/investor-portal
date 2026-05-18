(async function () {
  const me = await fetchMe();
  if (!me) return;
  document.getElementById('nav-mount').innerHTML = buildNav('home', me.displayName);
  applyChartDefaults();

  const PRESETS = [
    { id: '1m',  label: '1M' },
    { id: '6m',  label: '6M' },
    { id: 'ytd', label: 'YTD' },
    { id: '1y',  label: '1Y' },
    { id: 'all', label: 'All' },
    { id: 'custom', label: 'Custom' },
  ];

  // Persist the picker in localStorage so it survives reloads
  const stored = JSON.parse(localStorage.getItem('geysir.range') || '{}');
  let current = {
    preset: stored.preset || 'ytd',
    from: stored.from || null,
    to: stored.to || null,
  };

  await refresh();

  async function refresh() {
    const qs = current.preset === 'custom' && current.from && current.to
      ? `?from=${current.from}&to=${current.to}`
      : `?preset=${current.preset}`;
    const d = await api('/api/dashboard' + qs);
    if (!d) return;
    if (!current.from || !current.to) {
      current.from = d.window.from;
      current.to = d.window.to;
    }
    localStorage.setItem('geysir.range', JSON.stringify(current));
    paint(d);
    // Fetch + render timelines in parallel with the rest of the dashboard
    // (KPIs are already painted; charts slot in once data lands).
    const tqs = `?from=${d.window.from}&to=${d.window.to}`;
    api('/api/dashboard/timeline' + tqs).then(paintTimelines).catch(() => {});
  }

  function paint(d) {
    const wm = d.windowMetrics;
    const root = document.getElementById('root');
    root.innerHTML = `
      <div class="hero">
        <div>
          <h2>Yo ${me.displayName} — what's the bag doing?</h2>
          <div class="when">Snapshot: ${d.snapshotDate || '—'}</div>
        </div>
        ${renderPicker(d.window)}
      </div>

      <div class="section-title">Right now (current snapshot)</div>
      <div class="kpi-grid">
        <div class="kpi-card"><div class="label">Total bag</div><div class="value">${fmtNok(d.group.totalValue)}</div><div class="sub">stocks + dry powder</div></div>
        <div class="kpi-card"><div class="label">Holdings MV</div><div class="value">${fmtNok(d.group.marketValue)}</div><div class="sub">what's currently riding</div></div>
        <div class="kpi-card"><div class="label">Dry powder</div><div class="value">${fmtNok(d.group.cash)}</div><div class="sub">ready to fire</div></div>
        <div class="kpi-card"><div class="label">Paper money</div><div class="value ${pctClass(d.group.unrealized)}">${fmtNok(d.group.unrealized)}</div><div class="sub">unrealized P/L</div></div>
      </div>

      <div class="section-title">In this window <span class="text-muted text-small">${prettyRange(d.window)}</span></div>
      <div class="kpi-grid">
        <div class="kpi-card"><div class="label">Period return</div><div class="value ${pctClass(wm.group.periodReturnPct)}">${fmtPct(wm.group.periodReturnPct)}</div><div class="sub">realized + dividends + price delta</div></div>
        <div class="kpi-card"><div class="label">Banked profit</div><div class="value ${pctClass(wm.group.realizedInWindow)}">${fmtNok(wm.group.realizedInWindow)}</div><div class="sub">${wm.group.sellCount} sells</div></div>
        <div class="kpi-card"><div class="label">Free money</div><div class="value">${fmtNok(wm.group.dividendsInWindow)}</div><div class="sub">utbytte in window</div></div>
        <div class="kpi-card"><div class="label">Bought</div><div class="value">${fmtNok(wm.group.buysInWindow)}</div><div class="sub">${wm.group.buyCount} buys</div></div>
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
              <tr class="row-link" onclick="location.href='/investor.html?code=${encodeURIComponent(code)}'">
                <td><strong>${code}</strong> <span class="text-muted text-small">${d.names[code] || ''}</span></td>
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

      <div class="section-title">Timelines <span class="text-muted text-small">(${prettyRange(d.window)})</span></div>
      <div class="timeline-grid">
        <div class="chart-wrap">
          <div class="chart-title">Equity story <span class="text-muted text-small">— money in vs banked profit</span></div>
          <div class="chart-canvas-host"><canvas id="chart-equity"></canvas></div>
          <div class="chart-note">Net deposits vs cumulative realized + dividends. Doesn't include unrealized — those numbers are in the cards above.</div>
        </div>
        <div class="chart-wrap">
          <div class="chart-title">Monthly P/L <span class="text-muted text-small">— realized + dividends</span></div>
          <div class="chart-canvas-host"><canvas id="chart-monthly"></canvas></div>
          <div class="chart-note">Green = banked profit. Yellow = dividends. Red = realized losses.</div>
        </div>
        <div class="chart-wrap chart-wide">
          <div class="chart-title">Who's cooking <span class="text-muted text-small">— cumulative net P/L per investor</span></div>
          <div class="chart-canvas-host"><canvas id="chart-perinvestor"></canvas></div>
          <div class="chart-note">Realized + dividends only. Lines diverge when someone has a big sell or dividend month.</div>
        </div>
      </div>

      <div class="section-title">Leaderboards</div>
      <div class="leaderboard">
        <div class="lb-card">
          <h3>This period</h3>
          ${d.leaderboards.period.map((r, i) => `
            <div class="row"><span class="who">${PODIUM[i]} ${r.code} <span class="text-muted text-small">${d.names[r.code] || ''}</span></span><span class="v ${pctClass(r.value)}">${fmtPct(r.value)}</span></div>
          `).join('')}
        </div>
        <div class="lb-card">
          <h3>All-time GOAT 🐐</h3>
          ${d.leaderboards.allTime.map((r, i) => `
            <div class="row"><span class="who">${PODIUM[i]} ${r.code}</span><span class="v ${pctClass(r.value)}">${fmtPct(r.value)}</span></div>
          `).join('')}
        </div>
        <div class="lb-card">
          <h3>Best single bet (all-time)</h3>
          ${d.leaderboards.bestPicks.map((r) => {
            if (!r.pick) return `<div class="row"><span class="who">${r.code}</span><span class="v text-muted">no picks</span></div>`;
            return `<div class="row"><span class="who">${r.code} <span class="text-muted text-small">${r.pick.security}</span></span><span class="v positive">${fmtNok(r.pick.return)} (${fmtPct(r.pick.pct)})</span></div>`;
          }).join('')}
        </div>
        <div class="lb-card">
          <h3>Last 6 months — who cooked?</h3>
          ${d.leaderboards.monthly.map((m) => `
            <div class="row"><span class="who">${m.month}</span><span class="v">${m.ranks.slice(0,3).map((r,i)=>`${PODIUM[i]} ${r.code}`).join(' · ')}</span></div>
          `).join('')}
        </div>
      </div>
    `;
    wirePicker();
  }

  function paintTimelines(t) {
    if (typeof Chart === 'undefined') {
      document.querySelectorAll('.timeline-grid .chart-canvas-host').forEach((host) => {
        host.innerHTML = '<div class="text-muted text-small" style="padding:24px 0">Chart library failed to load. Check your connection.</div>';
      });
      return;
    }
    if (!t || !t.months || !t.months.length) {
      document.querySelectorAll('.timeline-grid .chart-canvas-host').forEach((host) => {
        host.innerHTML = '<div class="text-muted text-small" style="padding:24px 0">No transactions in this window.</div>';
      });
      return;
    }
    renderEquityStory('chart-equity', t);
    renderMonthlyPnl('chart-monthly', t);
    renderPerInvestorCumulative('chart-perinvestor', t);
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
          // Reveal date inputs
          document.getElementById('custom-sep').style.display = 'inline';
          document.getElementById('custom-sep2').style.display = 'inline';
          document.getElementById('date-from').style.display = 'inline-block';
          document.getElementById('date-to').style.display = 'inline-block';
          document.querySelectorAll('#range-picker .preset').forEach((b) => {
            b.classList.toggle('active', b.dataset.preset === 'custom');
          });
          return; // wait for user to pick dates and trigger change
        }
        current.preset = p;
        current.from = null;
        current.to = null;
        refresh();
      });
    });
    const fromInput = document.getElementById('date-from');
    const toInput = document.getElementById('date-to');
    const onChange = () => {
      const from = fromInput.value;
      const to = toInput.value;
      if (!from || !to) return;
      current.preset = 'custom';
      current.from = from;
      current.to = to;
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
