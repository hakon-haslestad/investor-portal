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

  const _today = new Date();
  const _todayStr = _today.toISOString().slice(0, 10);
  const _yearAgo = new Date(_today); _yearAgo.setUTCFullYear(_yearAgo.getUTCFullYear() - 1);

  const state = {
    source: 'all',     // 'all' | '1y' | '2y' | '3y' | 'ytd' | 'custom' | 'comp:<id>'
    scope: 'window',   // 'window' | 'lifetime' (ignored when a competition is the source)
    guess: false,      // guess-the-stock-first flow (opt-in)
    customFrom: _yearAgo.toISOString().slice(0, 10),
    customTo: _todayStr,
    lastKey: null,
    picked: new Set(), // keys drawn this round — draw without replacement
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
      case '2y': return { from: addYears(today, -2), to: todayStr };
      case '3y': return { from: addYears(today, -3), to: todayStr };
      case 'custom': return { from: state.customFrom, to: state.customTo };
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

  // Subscription rights / rights-issue artifacts that Nordnet lists as their
  // own "security" (e.g. "Seafire AB TR", "SEAFIRE TR SELL", emisjon lines).
  // They aren't real stocks, so keep them out of the game.
  function isRightsArtifact(name) {
    const s = String(name || '');
    return /\bTR\b/.test(s) || /(tegningsrett|tegningsret|emisjon|fortrinnsrett|rettigheter)/i.test(s);
  }

  // Drop rights artifacts and collapse to unique stocks. When several investors
  // share a stock, keep the most-invested owner (they're the one who drinks).
  function refinePool(pool) {
    const byStock = new Map();
    for (const e of pool) {
      if (isRightsArtifact(e.security)) continue;
      const key = canon(e.security);
      const cur = byStock.get(key);
      if (!cur || (e.purchaseAmount || 0) > (cur.purchaseAmount || 0)) byStock.set(key, e);
    }
    return [...byStock.values()];
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

  // ─── price timeline ─────────────────────────────────────────────────────────
  // Per-share price in NOK from a trade (Kurs × FX) — so the chart's y-axis is
  // always NOK even for USD/SEK-denominated stocks.
  function txPriceNok(tx) {
    const cur = (tx.currency || '').toString().toUpperCase().trim();
    const fx = (!cur || cur === 'NOK') ? 1 : (Number(tx.fxRate) > 0 ? tx.fxRate : 1);
    return tx.price * fx;
  }
  function priceSeriesForSecurity(security, code, from, to) {
    const c = canon(security);
    const byDate = new Map();
    const markers = [];
    // Every in-window trade contributes its Kurs (in NOK) as a price point, and
    // marks this investor's own buys/sells.
    for (const tx of store.transactions || []) {
      if (!tx.security || !tx.tradeDate) continue;
      if (tx.tradeDate < from || tx.tradeDate > to) continue;
      if (canon(tx.security) !== c) continue;
      const isTrade = tx.type === 'KJØPT' || tx.type === 'SALG';
      if (isTrade && Number.isFinite(tx.price) && tx.price > 0) {
        byDate.set(tx.tradeDate, { date: tx.tradeDate, price: txPriceNok(tx) });
      }
      if (isTrade) {
        const split = window.Ledger.splitForSecurity(store.attributionMap, tx.security);
        if (split.some((s) => s.code === code)) {
          markers.push({ date: tx.tradeDate, type: tx.type === 'SALG' ? 'sell' : 'buy' });
        }
      }
    }
    // Snapshot prices (NOK = marketValueNok / qty) take precedence on a shared date.
    for (const h of store.holdings || []) {
      if (!h.snapshotDate || h.currentPrice == null) continue;
      if (h.snapshotDate < from || h.snapshotDate > to) continue;
      if (canon(h.security) !== c) continue;
      const priceNok = (h.qty && h.marketValueNok != null && h.qty !== 0)
        ? h.marketValueNok / h.qty : h.currentPrice;
      byDate.set(h.snapshotDate, { date: h.snapshotDate, price: priceNok });
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

  // ─── selection ───────────────────────────────────────────────────────────────
  // Draw without replacement: never pick a stock that's already come up this
  // round. When every entry has been drawn, the round resets and the full pool
  // is available again (avoiding an immediate repeat of the very last pick).
  function spin(pool) {
    if (!pool.length) return null;
    const keyOf = (e) => e.investor + '|' + e.security;
    let available = pool.filter((e) => !state.picked.has(keyOf(e)));
    if (!available.length) {
      state.picked.clear();
      available = pool.filter((e) => keyOf(e) !== state.lastKey);
      if (!available.length) available = pool; // pool of 1
    }
    const pick = available[Math.floor(Math.random() * available.length)];
    const key = keyOf(pick);
    state.picked.add(key);
    state.lastKey = key;
    return pick;
  }

  // ─── rendering ────────────────────────────────────────────────────────────────
  // A series is worth charting only with at least a couple of points spanning
  // a real stretch of time — otherwise there's nothing to read (or guess) off.
  function chartable(series) {
    return series.points.length >= 2 &&
      daysBetween(series.points[0].date, series.points[series.points.length - 1].date) >= 30;
  }

  function renderResult(entry, opts = {}) {
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
      document.getElementById('game-chart').appendChild(
        window.Charts.priceChart({ points: series.points, markers: series.markers, yUnit: 'NOK', invested: entry.purchaseAmount })
      );
    }
  }

  // Guess-first: show only the price line (no markers, no name/P/L, no win/loss
  // colour). A Reveal button then renders the full result.
  function renderGuess(entry) {
    const mount = document.getElementById('game-mount');
    const series = priceSeriesForSecurity(entry.security, entry.investor, entry.from, entry.to);
    mount.innerHTML = `
      <div class="game-result guess">
        <div class="guess-prompt">Guess the stock 🤔</div>
        <div class="who-state">Whose is it? Up or down? Call it before the reveal.</div>
        <div id="game-chart"></div>
        <div style="margin-top:16px"><button class="btn game-spin" id="reveal">Reveal 👀</button></div>
      </div>`;
    document.getElementById('game-chart').appendChild(
      window.Charts.priceChart({ points: series.points, markers: [], yUnit: 'NOK' })
    );
    document.getElementById('reveal').addEventListener('click', () => renderResult(entry));
  }

  function doSpin() {
    const pool = buildPool();
    if (!pool.length) { renderResult(null); return; }
    const final = spin(pool);
    const guess = state.guess;
    const mount = document.getElementById('game-mount');
    const btn = document.getElementById('spin');
    if (btn) { btn.disabled = true; }

    // Same slot-machine spin in both modes. In guess mode the answer must stay
    // hidden, so the labels are masked (shuffling blocks, no name/ticker).
    mount.innerHTML = `
      <div class="game-result spinning">
        <div class="verdict"><span class="spin-dice">🎲</span></div>
        <div class="who"><span class="who-name" id="spin-name">${guess ? 'Mystery stock' : ''}</span></div>
        <div class="stock" id="spin-stock"></div>
      </div>`;
    const nameEl = guess ? null : document.getElementById('spin-name');
    const stockEl = document.getElementById('spin-stock');
    const mask = (s) => '▓'.repeat(Math.max(3, Math.min(10, (s || '').length)));

    const finish = () => {
      if (btn) { btn.disabled = false; }
      if (!guess) { renderResult(final); return; }
      const series = priceSeriesForSecurity(final.security, final.investor, final.from, final.to);
      if (chartable(series)) renderGuess(final);
      else renderResult(final, { note: 'Not enough price history to guess — here\'s the answer.' });
    };

    // Intervals grow → the cycle visibly slows before landing (~1.6s total).
    const delays = [55, 55, 60, 70, 85, 105, 130, 160, 195, 235, 280, 330];
    let i = 0;
    const tick = () => {
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
    return `<select id="comp-select" class="preset"><option value="">— competition —</option>${opts}</select>`;
  }

  function render() {
    const root = document.getElementById('root');
    const isComp = state.source.startsWith('comp:');
    const periods = [
      { id: 'all', label: 'All time' },
      { id: '1y', label: '1 Year' },
      { id: '2y', label: '2 Years' },
      { id: '3y', label: '3 Years' },
      { id: 'ytd', label: 'YTD' },
      { id: 'custom', label: 'Custom' },
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
        ${state.source === 'custom' ? `
          <input type="date" id="custom-from" value="${state.customFrom}" max="${state.customTo}" />
          <span class="sep">→</span>
          <input type="date" id="custom-to" value="${state.customTo}" min="${state.customFrom}" />
        ` : ''}
        ${compOptions()}
      </div>

      <div id="scope-section" style="${isComp ? 'display:none' : ''}">
        <div class="section-title">Scope</div>
        <div class="range-picker" id="scope-picker">
          <button class="preset ${state.scope === 'window' ? 'active' : ''}" data-scope="window">New bets in window</button>
          <button class="preset ${state.scope === 'lifetime' ? 'active' : ''}" data-scope="lifetime">Lifetime result</button>
        </div>
      </div>

      <div class="section-title">Guess first</div>
      <div class="range-picker" id="guess-picker">
        <button class="preset ${!state.guess ? 'active' : ''}" data-guess="off">Instant reveal</button>
        <button class="preset ${state.guess ? 'active' : ''}" data-guess="on">Guess the stock 🤔</button>
      </div>

      <div style="margin:18px 0">
        <button class="btn game-spin" id="spin">🎲 Spin</button>
      </div>
      <div id="game-mount"></div>
    `;

    document.querySelectorAll('#source-picker [data-period]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.source = btn.getAttribute('data-period');
        state.lastKey = null; state.picked.clear();
        render();
      });
    });
    // Custom range: update state on change (no re-render, so the inputs keep focus).
    const cf = document.getElementById('custom-from');
    const ct = document.getElementById('custom-to');
    if (cf) cf.addEventListener('change', () => {
      if (cf.value) { state.customFrom = cf.value; state.lastKey = null; state.picked.clear(); if (ct) ct.min = cf.value; }
    });
    if (ct) ct.addEventListener('change', () => {
      if (ct.value) { state.customTo = ct.value; state.lastKey = null; state.picked.clear(); if (cf) cf.max = ct.value; }
    });
    const sel = document.getElementById('comp-select');
    if (sel) {
      sel.addEventListener('change', () => {
        if (sel.value) { state.source = sel.value; state.lastKey = null; state.picked.clear(); render(); }
      });
    }
    document.querySelectorAll('#scope-picker [data-scope]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.scope = btn.getAttribute('data-scope');
        state.lastKey = null; state.picked.clear();
        render();
      });
    });
    document.querySelectorAll('#guess-picker [data-guess]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.guess = btn.getAttribute('data-guess') === 'on';
        render();
      });
    });
    document.getElementById('spin').addEventListener('click', doSpin);
  }

  render();
})();
