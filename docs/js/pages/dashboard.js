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
  let selectedCode = localStorage.getItem('portal.filter') || null;

  const INVESTOR_COLORS = {
    HH: '#4ade80', HS: '#60a5fa', 'ØS': '#fbbf24', JC: '#f472b6', HF: '#a78bfa',
  };
  const INVESTOR_CODES = ['HH', 'HS', 'ØS', 'JC', 'HF'];

  function toggleFilter(code) {
    selectedCode = selectedCode === code ? null : code;
    if (selectedCode) localStorage.setItem('portal.filter', selectedCode);
    else localStorage.removeItem('portal.filter');
    refresh();
  }
  window.__clearFilter = () => { selectedCode = null; localStorage.removeItem('portal.filter'); refresh(); };

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
    paintCharts(d.window);
  }

  // Slice the all-time cumulative series down to the selected window and
  // rebase so the chart starts at 0 on the `from` date — the chart then
  // shows "P/L gained DURING this period" rather than absolute lifetime totals.
  function windowSlice(samples, from, to) {
    if (!from || !to) return samples;
    let baseline = null;
    for (const s of samples) {
      if (s.date <= from) baseline = s;
      else break;
    }
    const base = baseline ? baseline.perInvestor : {};
    const out = [];
    if (!samples.length || samples[0].date > from) {
      out.push({ date: from, perInvestor: emptyPerInvestor() });
    }
    for (const s of samples) {
      if (s.date < from) continue;
      if (s.date > to) break;
      const rebased = { date: s.date, perInvestor: {} };
      for (const code of INVESTOR_CODES) {
        rebased.perInvestor[code] = (s.perInvestor[code] || 0) - (base[code] || 0);
      }
      out.push(rebased);
    }
    if (out.length && out[out.length - 1].date < to) {
      out.push({ date: to, perInvestor: { ...out[out.length - 1].perInvestor } });
    }
    return out;
  }

  function emptyPerInvestor() {
    const m = {};
    for (const code of INVESTOR_CODES) m[code] = 0;
    return m;
  }

  function paintCharts(win) {
    const allTime = window.TimeSeries.buildCumulativePnlSeries(store);
    const tsPnl = windowSlice(allTime, win && win.from, win && win.to);
    const allSeries = INVESTOR_CODES.map((code) => ({
      code,
      name: `${code} ${names[code] || ''}`.trim(),
      color: INVESTOR_COLORS[code],
      points: tsPnl.map((s) => ({ date: s.date, y: s.perInvestor[code] || 0 })),
    }));
    const chartSeries = selectedCode
      ? allSeries.filter((s) => s.code === selectedCode)
      : allSeries;

    const pnlEl = document.getElementById('chart-pnl');
    const legendEl = document.getElementById('chart-legend');
    if (!pnlEl || !legendEl) return;
    pnlEl.innerHTML = '';
    legendEl.innerHTML = '';

    const isMobile = window.matchMedia('(max-width: 720px)').matches;
    pnlEl.appendChild(window.Charts.multiLine({
      series: chartSeries,
      width: isMobile ? 540 : 900,
      height: isMobile ? 360 : 320,
      title: selectedCode
        ? `Cumulative P/L · filtered to ${selectedCode}`
        : 'Cumulative realized P/L + dividends − fees',
      interactive: true,
    }));

    const investorLegend = allSeries.map((s) => {
      const last = s.points.slice(-1)[0];
      return {
        code: s.code,
        name: `${s.code} · ${names[s.code] || ''}`,
        color: s.color,
        valueText: last ? fmtNok(last.y) : '',
      };
    });
    legendEl.appendChild(window.Charts.legend({
      series: investorLegend,
      selectedCode,
      onSelect: toggleFilter,
    }));
  }

  function paint(d) {
    const wm = d.windowMetrics;
    const root = document.getElementById('root');
    const rn = selectedCode && d.perInvestor[selectedCode] ? d.perInvestor[selectedCode] : d.group;
    const win = selectedCode && wm.perInvestor[selectedCode] ? wm.perInvestor[selectedCode] : wm.group;
    const filterLabel = selectedCode
      ? `<span class="filter-chip">Filtered: <strong>${selectedCode}</strong> ${names[selectedCode] || ''} <a href="#" onclick="event.preventDefault(); window.__clearFilter();">clear ×</a></span>`
      : '';
    const rnTitle = selectedCode ? `Right now · ${selectedCode}` : 'Right now (current snapshot)';
    const winTitle = selectedCode ? `In this window · ${selectedCode}` : 'In this window';
    root.innerHTML = `
      <div class="hero">
        <div>
          <h2>Welcome back, ${me.displayName}. Here's the book.</h2>
          <div class="when">Snapshot: ${d.snapshotDate || '—'} ${filterLabel}</div>
        </div>
        ${renderPicker(d.window)}
      </div>

      <div class="section-title">Cumulative net P/L per investor <span class="text-muted text-small">click an investor to filter</span></div>
      <div id="chart-legend"></div>
      <div class="chart-wrap" id="chart-pnl"></div>

      <div class="section-title">${rnTitle}</div>
      <div class="kpi-grid">
        <div class="kpi-card"><div class="label">Total portfolio</div><div class="value">${fmtNok(rn.totalValue)}</div><div class="sub">positions + cash</div></div>
        <div class="kpi-card"><div class="label">Holdings MV</div><div class="value">${fmtNok(rn.marketValue)}</div><div class="sub">active positions</div></div>
        <div class="kpi-card"><div class="label">Dry powder</div><div class="value">${fmtNok(rn.cash)}</div><div class="sub">${selectedCode ? 'investor share' : 'uncommitted cash'}</div></div>
        <div class="kpi-card"><div class="label">Unrealized P/L</div><div class="value ${pctClass(rn.unrealized)}">${fmtNok(rn.unrealized)}</div><div class="sub">mark-to-market</div></div>
      </div>

      <div class="section-title">${winTitle} <span class="text-muted text-small">${prettyRange(d.window)}</span></div>
      <div class="kpi-grid">
        <div class="kpi-card"><div class="label">Period return</div><div class="value ${pctClass(win.periodReturnPct)}">${fmtPct(win.periodReturnPct)}</div><div class="sub">realized + dividends + price delta</div></div>
        <div class="kpi-card"><div class="label">Realized P/L</div><div class="value ${pctClass(win.realizedInWindow)}">${fmtNok(win.realizedInWindow)}</div><div class="sub">${win.sellCount || 0} sells</div></div>
        <div class="kpi-card"><div class="label">Dividends</div><div class="value">${fmtNok(win.dividendsInWindow)}</div><div class="sub">received in window</div></div>
        <div class="kpi-card"><div class="label">Capital deployed</div><div class="value">${fmtNok(win.buysInWindow)}</div><div class="sub">${win.buyCount || 0} buys</div></div>
        <div class="kpi-card"><div class="label">Net P/L</div><div class="value ${pctClass(win.netPnlInWindow)}">${fmtNok(win.netPnlInWindow)}</div><div class="sub">realized + divs + unrealized Δ</div></div>
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
            const rowClass = selectedCode
              ? (code === selectedCode ? 'row-link selected-row' : 'row-link dimmed-row')
              : 'row-link';
            return `
              <tr class="${rowClass}" onclick="location.href='./investor.html?code=${encodeURIComponent(code)}'">
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
