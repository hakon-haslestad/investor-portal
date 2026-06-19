// "The Game" — pick a scope, spin, and find out who drinks.
// Win (green) → hand out a shot. Loss (red) → take a shot.
// All sources/scopes produce the same PoolEntry[] so the result card is
// rendered by one code path.

(async function () {
  const { store } = await window.Nav.bootstrap('game');
  const { fmtNok, fmtPct, escapeHtml, pctClass } = window.Fmt;
  const names = window.Copy.namesFromMembers(store.members);
  const CODES = window.Ledger.INVESTOR_CODES;
  const canon = window.Portfolio.canonicalName;

  // Competitions are optional — if the fetch fails we just offer the periods.
  let competitions = [];
  try { competitions = await window.CompetitionsData.listCompetitions(); }
  catch (_e) { /* optional */ }
  const compById = new Map(competitions.map((c) => [c.competition.id, c]));

  const state = {
    source: 'all',     // 'all' | '1y' | 'ytd' | 'comp:<id>'
    scope: 'window',   // 'window' | 'lifetime' (ignored when a competition is the source)
    lastKey: null,
  };

  // ─── date helpers ──────────────────────────────────────────────────────────
  function computeWindow(preset) {
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    let earliest = todayStr;
    for (const t of store.transactions || []) {
      if (t.tradeDate && t.tradeDate < earliest) earliest = t.tradeDate;
    }
    const addYears = (d, n) => {
      const x = new Date(d); x.setUTCFullYear(x.getUTCFullYear() + n); return x.toISOString().slice(0, 10);
    };
    switch (preset) {
      case '1y': return { from: addYears(today, -1), to: todayStr };
      case 'all': return { from: earliest, to: todayStr };
      case 'ytd':
      default: return { from: `${today.getUTCFullYear()}-01-01`, to: todayStr };
    }
  }

  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

  // First buy / last activity dates for one (investor, security), across all time.
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

  // ─── pool builders (all return PoolEntry[]) ─────────────────────────────────
  // PoolEntry: { investor, investorName, security, win, pnlNok, pnlPct,
  //              purchaseAmount, currentOrSoldValue, sold, from, to }

  function poolFromScored(scored) {
    const from = scored.competition.start_date;
    const to = scored.competition.end_date;
    const out = [];
    for (const r of scored.ranks || []) {
      for (const b of r.breakdown || []) {
        // The engine decrements costSum as it sells, so costSum is only the
        // *remaining held* cost. Reconstruct the sold cost from realized P/L
        // (realized = proceeds − cost ⇒ cost = proceeds − realized).
        const heldCost = b.costSum || 0;
        const soldCost = Math.max((b.soldProceeds || 0) - (b.realized || 0), 0);
        const purchaseAmount = heldCost + soldCost;
        const pnlNok = (b.unrealized || 0) + (b.realized || 0) + (b.divs || 0);
        const sold = (b.qty || 0) <= 1e-6 && (b.soldQty || 0) > 0;
        out.push({
          investor: r.code,
          investorName: names[r.code] || r.code,
          security: b.security,
          win: pnlNok >= 0,
          pnlNok,
          pnlPct: purchaseAmount > 0 ? (pnlNok / purchaseAmount) * 100 : 0,
          purchaseAmount,
          currentOrSoldValue: (b.marketValueAtEnd || 0) + (b.soldProceeds || 0),
          sold,
          from, to,
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
      // Still-held positions (lifetime unrealized). Per-security dividends for
      // held names aren't exposed, so P/L here is unrealized only.
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
      // Closed positions (lifetime realized + dividends).
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

  function buildPool() {
    if (state.source.startsWith('comp:')) {
      const c = compById.get(state.source.slice(5));
      if (!c) return [];
      const scored = window.CompetitionEngine.scoreCompetition(store, c.competition, c.participants);
      scored.competition = c.competition;
      return poolFromScored(scored);
    }
    const { from, to } = computeWindow(state.source);
    if (state.scope === 'lifetime') return poolFromLifetime(from, to, state.source === 'all');
    return poolFromPeriodWindow(from, to);
  }

  // ─── price timeline ─────────────────────────────────────────────────────────
  function priceSeriesForSecurity(security, code, from, to) {
    const c = canon(security);
    const byDate = new Map();
    for (const h of store.holdings || []) {
      if (!h.snapshotDate || h.currentPrice == null) continue;
      if (h.snapshotDate < from || h.snapshotDate > to) continue;
      if (canon(h.security) !== c) continue;
      byDate.set(h.snapshotDate, { date: h.snapshotDate, price: h.currentPrice });
    }
    const points = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    const markers = [];
    for (const tx of store.transactions || []) {
      if (!tx.security || !tx.tradeDate) continue;
      if (tx.tradeDate < from || tx.tradeDate > to) continue;
      if (tx.type !== 'KJØPT' && tx.type !== 'SALG') continue;
      if (canon(tx.security) !== c) continue;
      const split = window.Ledger.splitForSecurity(store.attributionMap, tx.security);
      if (!split.some((s) => s.code === code)) continue;
      markers.push({ date: tx.tradeDate, type: tx.type === 'SALG' ? 'sell' : 'buy' });
    }
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

  // ─── selection ───────────────────────────────────────────────────────────────
  function spin(pool) {
    if (!pool.length) return null;
    if (pool.length === 1) { state.lastKey = pool[0].investor + '|' + pool[0].security; return pool[0]; }
    let pick, key, guard = 0;
    do {
      pick = pool[Math.floor(Math.random() * pool.length)];
      key = pick.investor + '|' + pick.security;
    } while (key === state.lastKey && ++guard < 12);
    state.lastKey = key;
    return pick;
  }

  // ─── rendering ────────────────────────────────────────────────────────────────
  function renderResult(entry) {
    const mount = document.getElementById('game-mount');
    if (!entry) {
      mount.innerHTML =
        '<div class="flash">No positions in this selection. Try <strong>All time</strong>, switch the scope, or pick another competition.</div>';
      return;
    }
    const cls = entry.win ? 'win' : 'loss';
    const verdict = entry.win ? 'Hand out a shot 🥃' : 'Take a shot 🥃';
    const valueLabel = entry.sold ? 'Sold for' : "Today's value";
    const series = priceSeriesForSecurity(entry.security, entry.investor, entry.from, entry.to);
    const showChart = series.points.length >= 2 &&
      daysBetween(series.points[0].date, series.points[series.points.length - 1].date) >= 30;

    mount.innerHTML = `
      <div class="game-result ${cls}">
        <div class="verdict">${escapeHtml(verdict)}</div>
        <div class="stock">${escapeHtml(entry.security)}</div>
        <div class="who">${escapeHtml(entry.investorName)} · ${entry.sold ? 'sold' : 'holding'}</div>
        <div class="pnl ${pctClass(entry.pnlNok)}">${fmtNok(entry.pnlNok)} · ${fmtPct(entry.pnlPct, true)}</div>
        <div class="detail-grid">
          <div class="kpi-card"><div class="label">Put in</div><div class="value">${fmtNok(entry.purchaseAmount)}</div></div>
          <div class="kpi-card"><div class="label">${escapeHtml(valueLabel)}</div><div class="value">${fmtNok(entry.currentOrSoldValue)}</div></div>
          <div class="kpi-card"><div class="label">Held</div><div class="value">${escapeHtml(holdingText(entry))}</div></div>
        </div>
        <div id="game-chart"></div>
      </div>`;
    if (showChart) {
      document.getElementById('game-chart').appendChild(
        window.Charts.priceChart({ points: series.points, markers: series.markers })
      );
    }
  }

  // A short "spinning" teaser before the real reveal.
  function doSpin() {
    const pool = buildPool();
    if (!pool.length) { renderResult(null); return; }
    const final = spin(pool);
    const mount = document.getElementById('game-mount');
    let ticks = 0;
    const iv = setInterval(() => {
      const rnd = pool[Math.floor(Math.random() * pool.length)];
      mount.innerHTML = `
        <div class="game-result spinning">
          <div class="verdict">🎲</div>
          <div class="stock">${escapeHtml(rnd.security)}</div>
          <div class="who">${escapeHtml(rnd.investorName)}</div>
        </div>`;
      if (++ticks >= 8) { clearInterval(iv); renderResult(final); }
    }, 70);
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
    return `<select id="comp-select" class="preset"><option value="">— competition —</option>${opts}</select>`;
  }

  function render() {
    const root = document.getElementById('root');
    const isComp = state.source.startsWith('comp:');
    const periods = [
      { id: 'all', label: 'All time' },
      { id: '1y', label: '1 Year' },
      { id: 'ytd', label: 'YTD' },
    ];
    root.innerHTML = `
      <div class="hero">
        <h2>The Game 🎲🍺</h2>
        <div class="when">Spin to draw a random stock. Green = hand out a shot. Red = take a shot.</div>
      </div>

      <div class="section-title">Source</div>
      <div class="range-picker" id="source-picker">
        ${periods.map((p) =>
          `<button class="preset ${!isComp && state.source === p.id ? 'active' : ''}" data-period="${p.id}">${p.label}</button>`
        ).join('')}
        ${compOptions()}
      </div>

      <div id="scope-section" style="${isComp ? 'display:none' : ''}">
        <div class="section-title">Scope</div>
        <div class="range-picker" id="scope-picker">
          <button class="preset ${state.scope === 'window' ? 'active' : ''}" data-scope="window">New bets in window</button>
          <button class="preset ${state.scope === 'lifetime' ? 'active' : ''}" data-scope="lifetime">Lifetime result</button>
        </div>
      </div>

      <div style="margin:18px 0">
        <button class="btn game-spin" id="spin">🎲 Spin</button>
      </div>
      <div id="game-mount"></div>
    `;

    document.querySelectorAll('#source-picker [data-period]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.source = btn.getAttribute('data-period');
        state.lastKey = null;
        render();
      });
    });
    const sel = document.getElementById('comp-select');
    if (sel) {
      sel.addEventListener('change', () => {
        if (sel.value) { state.source = sel.value; state.lastKey = null; render(); }
      });
    }
    document.querySelectorAll('#scope-picker [data-scope]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.scope = btn.getAttribute('data-scope');
        state.lastKey = null;
        render();
      });
    });
    document.getElementById('spin').addEventListener('click', doSpin);
  }

  render();
})();
