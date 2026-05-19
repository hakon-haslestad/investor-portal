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
  let selectedCodes = (localStorage.getItem('portal.filter') || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  const INVESTOR_COLORS = {
    HH: '#4ade80', HS: '#60a5fa', 'ØS': '#fbbf24', JC: '#f472b6', HF: '#a78bfa',
  };
  const INVESTOR_CODES = ['HH', 'HS', 'ØS', 'JC', 'HF'];

  function toggleFilter(code) {
    const idx = selectedCodes.indexOf(code);
    if (idx >= 0) selectedCodes.splice(idx, 1);
    else selectedCodes.push(code);
    if (selectedCodes.length) localStorage.setItem('portal.filter', selectedCodes.join(','));
    else localStorage.removeItem('portal.filter');
    refresh();
  }
  window.__clearFilter = () => { selectedCodes = []; localStorage.removeItem('portal.filter'); refresh(); };

  // Aggregate per-investor values across the current selection. Returns
  // either the group totals (no selection), a single investor's record
  // (one code), or summed values (multi).
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

  // Slice an all-time per-investor series down to the selected window.
  //   rebase=true  → subtract the baseline-at-`from` so the chart starts at 0
  //                  (good for cumulative P/L: shows gains DURING this period).
  //   rebase=false → keep absolute values (good for portfolio value).
  function windowSlice(samples, from, to, { rebase = true } = {}) {
    if (!from || !to) return samples;
    let baseline = null;
    for (const s of samples) {
      if (s.date <= from) baseline = s;
      else break;
    }
    const base = rebase && baseline ? baseline.perInvestor : null;
    const out = [];
    if (rebase && (!samples.length || samples[0].date > from)) {
      out.push({ date: from, perInvestor: emptyPerInvestor() });
    } else if (!rebase && baseline) {
      out.push({ date: from, perInvestor: { ...baseline.perInvestor } });
    }
    for (const s of samples) {
      if (s.date < from) continue;
      if (s.date > to) break;
      const next = { date: s.date, perInvestor: {} };
      for (const code of INVESTOR_CODES) {
        const v = s.perInvestor[code] || 0;
        next.perInvestor[code] = base ? v - (base[code] || 0) : v;
      }
      out.push(next);
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
    const from = win && win.from, to = win && win.to;
    const pnlAll = window.TimeSeries.buildCumulativePnlSeries(store);
    const mvAll = window.TimeSeries.buildPortfolioValueSeries(store);
    const tsPnl = windowSlice(pnlAll, from, to, { rebase: true });
    const tsMv = windowSlice(mvAll, from, to, { rebase: false });

    const toSeries = (samples) => INVESTOR_CODES.map((code) => ({
      code,
      name: `${code} ${names[code] || ''}`.trim(),
      color: INVESTOR_COLORS[code],
      points: samples.map((s) => ({ date: s.date, y: s.perInvestor[code] || 0 })),
    }));
    const pnlSeriesAll = toSeries(tsPnl);
    const mvSeriesAll = toSeries(tsMv);
    const filt = (all) => selectedCodes.length ? all.filter((s) => selectedCodes.includes(s.code)) : all;

    const pnlEl = document.getElementById('chart-pnl');
    const mvEl = document.getElementById('chart-mv');
    const legendEl = document.getElementById('chart-legend');
    if (!pnlEl || !mvEl || !legendEl) return;
    pnlEl.innerHTML = '';
    mvEl.innerHTML = '';
    legendEl.innerHTML = '';

    const isMobile = window.matchMedia('(max-width: 720px)').matches;
    const W = isMobile ? 540 : 900;
    const H = isMobile ? 216 : 192; // 40% shorter than the previous 360/320

    const filterTag = selectedCodes.length ? ` · ${selectedCodes.join(', ')}` : '';
    pnlEl.appendChild(window.Charts.multiLine({
      series: filt(pnlSeriesAll), width: W, height: H,
      title: selectedCodes.length
        ? `Cumulative P/L${filterTag}`
        : 'Cumulative realized P/L + dividends − fees',
      interactive: true,
    }));
    mvEl.appendChild(window.Charts.multiLine({
      series: filt(mvSeriesAll), width: W, height: H,
      title: selectedCodes.length
        ? `Portfolio value${filterTag}`
        : 'Portfolio value per investor',
      interactive: true,
    }));

    const investorLegend = pnlSeriesAll.map((s) => {
      const lastPnl = s.points.slice(-1)[0];
      return {
        code: s.code,
        name: `${s.code} · ${names[s.code] || ''}`,
        color: s.color,
        valueText: lastPnl ? fmtNok(lastPnl.y) : '',
      };
    });
    legendEl.appendChild(window.Charts.legend({
      series: investorLegend,
      selectedCodes,
      onSelect: toggleFilter,
    }));
  }

  function paint(d) {
    const wm = d.windowMetrics;
    const root = document.getElementById('root');
    const rn = aggregateRn(d);
    const win = aggregateWin(wm);
    const filterLabel = selectedCodes.length
      ? `<span class="filter-chip">Filtered: <strong>${selectedCodes.join(', ')}</strong> <a href="#" onclick="event.preventDefault(); window.__clearFilter();">clear ×</a></span>`
      : '';
    const rnTitle = `Right now (${d.snapshotDate || '—'})`;
    const winTitle = selectedCodes.length ? `In this window · ${selectedCodes.join(', ')}` : 'In this window';
    const dateOrNone = d.snapshotDate || '—';
    root.innerHTML = `
      <div class="hero">
        <div>
          <h2>Welcome back, ${me.displayName}. Here's the book.</h2>
          <div class="when">Snapshot: ${dateOrNone} ${filterLabel}</div>
        </div>
        ${renderPicker(d.window)}
      </div>

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

      <div class="section-title">Timelines per investor <span class="text-muted text-small">click investors to filter (multi-select)</span></div>
      <div id="chart-legend"></div>
      <div class="chart-wrap" id="chart-pnl"></div>
      <div class="chart-wrap" id="chart-mv"></div>

      <div class="section-title">${rnTitle}</div>
      <div class="kpi-grid">
        <div class="kpi-card"><div class="label">Total portfolio</div><div class="value">${fmtNok(rn.totalValue)}</div><div class="sub">positions + cash</div></div>
        <div class="kpi-card"><div class="label">Holdings MV</div><div class="value">${fmtNok(rn.marketValue)}</div><div class="sub">active positions</div></div>
        <div class="kpi-card"><div class="label">Dry powder</div><div class="value">${fmtNok(rn.cash)}</div><div class="sub">${selectedCodes.length ? 'investor share' : 'uncommitted cash'}</div></div>
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
            const rowClass = selectedCodes.length
              ? (selectedCodes.includes(code) ? 'row-link selected-row' : 'row-link dimmed-row')
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
