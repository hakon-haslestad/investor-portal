// Back Trading — take a closed trade, ask whether selling was right, then
// show what the price did afterwards.
//
// Verdict maths lives in back-trading-verdict.js. This file builds the list of
// closed trades from the ledger, runs the replay, and renders the aggregate
// "sell record".

(function () {
  const { fmtNok, fmtPct, escapeHtml, pctClass } = window.Fmt;
  const V = () => window.BackTradingVerdict;

  const DAY = 86400000;
  const addDays = (iso, n) => new Date(Date.parse(iso) + n * DAY).toISOString().slice(0, 10);

  // One realizing sell = one trade, per the brief's "treat each sell as its
  // own trade with the sold quantity". Entry price is the position's average
  // cost the day before the sell, from the existing replay in Positions.
  function closedTrades(pool, todayStr) {
    const store = pool.store;
    const today = todayStr || new Date().toISOString().slice(0, 10);
    const positions = window.Positions.bySecurity(store);
    const out = [];
    for (const tx of store.transactions || []) {
      if (!tx.security || !tx.tradeDate) continue;
      if (!window.Ledger.isRealizingSell(tx.type)) continue;
      const qty = Math.abs(Number(tx.qty) || 0);
      const price = Number(tx.price);
      if (!(qty > 0) || !Number.isFinite(price) || price <= 0) continue;

      const cur = (tx.currency || '').toUpperCase().trim();
      const fx = (!cur || cur === 'NOK') ? 1 : (Number(tx.fxRate) > 0 ? tx.fxRate : 1);
      const exitPrice = price * fx;

      const st = positions.get(pool.canon(tx.security)) || positions.get(tx.security);
      let entryPrice = null;
      if (st) {
        const before = window.Positions.stateAt(st, addDays(tx.tradeDate, -1));
        if (before && before.qty > 0) entryPrice = before.costSum / before.qty;
      }

      const owners = window.Ledger.splitForSecurity(store.attributionMap, tx.security)
        .map((s) => ({ code: s.code, name: pool.names[s.code] || s.code }));

      out.push({
        id: `${tx.tradeDate}|${tx.security}|${tx.nordnetId || tx.sourceRow || qty}`,
        security: tx.security,
        exitDate: tx.tradeDate,
        exitPrice, qty, entryPrice,
        realizedPct: entryPrice ? (exitPrice / entryPrice - 1) * 100 : null,
        owners,
        ownerCodes: owners.map((o) => o.code),
        ownerNames: owners.map((o) => o.name).join(' + '),
        daysUntilPlayable: V().daysUntilPlayable(tx.tradeDate, today),
      });
    }
    return out.sort((a, b) => b.exitDate.localeCompare(a.exitDate));
  }

  function seriesFor(pool, trade, untilDate) {
    // A wide window: entry history for the "before" chart plus a year after.
    const from = addDays(trade.exitDate, -400);
    const to = untilDate || addDays(trade.exitDate, 400);
    return pool.priceSeriesForSecurity(trade.security, trade.ownerCodes, from, to);
  }

  function mount(el, props) {
    const { players, soberMode, rng, pool, history, competitionId } = props;
    let dead = false;
    const today = new Date().toISOString().slice(0, 10);
    const all = closedTrades(pool, today);
    const playable = all.filter((t) => t.daysUntilPlayable === 0);
    const waiting = all.filter((t) => t.daysUntilPlayable > 0);

    const roster = players && players.length ? players : [{ code: '', name: 'Player' }];
    let onlyMine = false;
    let turn = 0;
    let current = null;
    let answers = [];   // [{player, wouldHold, correct}]
    let score = 0, rounds = 0;

    function filtered() {
      if (!onlyMine) return playable;
      const me = roster[0] && roster[0].code;
      return playable.filter((t) => t.ownerCodes.includes(me));
    }

    function pickTrade(id) {
      const list = filtered();
      if (!list.length) return null;
      if (id) return list.find((t) => t.id === id) || null;
      return rng.pick(list);
    }

    // ── Aggregate: the sell record per player ────────────────────────────
    function sellRecord() {
      const byPlayer = new Map();
      for (const t of playable) {
        const r = V().verdictFor(t, seriesFor(pool, t).points, today);
        const sixty = r.horizons.find((h) => h.days === 60);
        const verdict = sixty ? sixty.verdict : null;
        if (!verdict) continue;
        for (const code of t.ownerCodes) {
          if (!byPlayer.has(code)) {
            byPlayer.set(code, {
              code, name: pool.names[code] || code,
              'good-sell': 0, neutral: 0, 'too-early': 0,
              total: 0, missed: 0, saved: 0, oneYear: 0,
            });
          }
          const rec = byPlayer.get(code);
          rec[verdict] += 1;
          rec.total += 1;
          rec.missed += r.missedMoney || 0;
          rec.saved += r.moneySaved || 0;
          if (r.oneYear) rec.oneYear += r.oneYear.money;
        }
      }
      return [...byPlayer.values()];
    }

    function renderAggregate() {
      const recs = sellRecord();
      // Minimum 5 closed trades to appear on the leaderboard, per the brief.
      const board = recs.filter((r) => r.total >= 5)
        .sort((a, b) => (b['good-sell'] / b.total) - (a['good-sell'] / a.total));
      const pct = (r) => (r.total ? (r['good-sell'] / r.total) * 100 : 0);

      const rows = recs.sort((a, b) => b.total - a.total).map((r) => [
        escapeHtml(r.name),
        String(r.total),
        `${pct(r).toFixed(0)}%`,
        String(r.neutral),
        String(r['too-early']),
        fmtNok(r.missed),
        fmtNok(r.saved),
      ]);

      const boardHtml = board.length
        ? `<ol class="bt-board">${board.map((r) =>
            `<li><strong>${escapeHtml(r.name)}</strong> <span class="text-muted">${pct(r).toFixed(0)}% good sells · ${r.total} closed</span></li>`).join('')}</ol>`
        : '<p class="text-muted text-small">Nobody has 5 closed trades in this period yet.</p>';

      return `
        ${window.UI.section('Your sell record', { extra: '<span class="text-muted text-small">at the 60-day horizon</span>' })}
        ${window.UI.table([
          { label: 'Player', p: 1 },
          { label: 'Closed', className: 'text-right', p: 2 },
          { label: 'Good sells', className: 'text-right', p: 1 },
          { label: 'Neutral', className: 'text-right', p: 3 },
          { label: 'Too early', className: 'text-right', p: 2 },
          { label: 'Missed', className: 'text-right', p: 3 },
          { label: 'Saved', className: 'text-right', p: 3 },
        ], rows, { empty: 'No closed trades with post-exit prices yet.', caption: 'Sell record' })}
        ${window.UI.section('Leaderboard')}
        ${boardHtml}`;
    }

    // ── Replay ───────────────────────────────────────────────────────────
    function renderAsk(trade) {
      const s = seriesFor(pool, trade, trade.exitDate); // nothing after the exit
      const who = roster.length > 1 ? roster[turn % roster.length] : null;
      el.innerHTML = `
        ${renderPicker(trade)}
        <div class="bt-card">
          <div class="bt-head">
            <span class="bt-sec">${escapeHtml(trade.security)}</span>
            <span class="tag">sold ${escapeHtml(trade.exitDate)}</span>
          </div>
          <div class="detail-grid">
            <div class="kpi-card"><div class="label">Entry</div><div class="value">${trade.entryPrice ? fmtNok(trade.entryPrice) : '—'}</div></div>
            <div class="kpi-card"><div class="label">Exit</div><div class="value">${fmtNok(trade.exitPrice)}</div></div>
            <div class="kpi-card"><div class="label">Realised</div><div class="value ${trade.realizedPct != null ? pctClass(trade.realizedPct) : ''}">${trade.realizedPct != null ? fmtPct(trade.realizedPct, true) : '—'}</div></div>
            <div class="kpi-card"><div class="label">Sold by</div><div class="value">${escapeHtml(trade.ownerNames)}</div></div>
          </div>
          <div id="bt-chart"></div>
          <p class="bt-ask">${who ? `<strong>${escapeHtml(who.name)}</strong> — w` : 'W'}ould you have held?</p>
          <div class="bt-buttons">
            <button class="btn" id="bt-hold">Hold 💎</button>
            <button class="btn ghost" id="bt-sell">Sell was right ✂️</button>
          </div>
          <p class="text-muted text-small">Nothing after the sell is shown yet.</p>
        </div>`;
      mountChart('#bt-chart', s, trade, false);
      el.querySelector('#bt-hold').addEventListener('click', () => reveal(trade, true));
      el.querySelector('#bt-sell').addEventListener('click', () => reveal(trade, false));
      bindPicker();
    }

    function mountChart(sel, s, trade, showAfter) {
      const mountEl = el.querySelector(sel);
      if (!mountEl || s.points.length < 2) return;
      const markers = [{ date: trade.exitDate, type: 'sell', label: `sold ${fmtNok(trade.exitPrice)}` }];
      mountEl.appendChild(window.Charts.priceChart({
        points: s.points, markers: showAfter ? markers : s.markers, yUnit: 'NOK',
      }));
    }

    function reveal(trade, wouldHold) {
      const s = seriesFor(pool, trade);
      const r = V().verdictFor(trade, s.points, today);
      rounds += 1;
      const right = r.overall ? V().scoreAnswer(wouldHold, r.overall) : null;
      if (right) score += 1;
      answers.push({ player: (roster[turn % roster.length] || {}).name, wouldHold, correct: right });
      turn += 1;

      if (history) {
        history.add({
          gameId: 'back-trading',
          competitionId: competitionId || '',
          players: roster.map((p) => p.name),
          summary: `${trade.security} sold ${trade.exitDate} — ${r.overall ? V().VERDICT_LABEL[r.overall] : 'no verdict'}`,
          payload: { tradeId: trade.id, verdict: r.overall, horizons: r.horizons.map((h) => ({ days: h.days, verdict: h.verdict })) },
        });
      }

      const strip = r.horizons.map((h) => `
        <span class="bt-h ${h.verdict}${h.stale ? ' stale' : ''}" title="${h.stale ? `resolved ${h.staleByDays} days early — nearest close available` : `close on ${h.date}`}">
          <span class="bt-h-days">${h.days}d</span>
          <span class="bt-h-pct">${fmtPct(h.afterReturn * 100, true)}</span>
        </span>`).join('');

      const caveats = [];
      if (r.flags.includes('possible-split')) {
        caveats.push('A price this far from the exit is more likely a stock split than a move — the feed gives no split-adjustment flag, so read this one with suspicion.');
      }
      if (r.flags.includes('stale-resolution')) {
        caveats.push('Some horizons resolved against an older close: sold stocks are only fetched weekly, so the exact day was not available.');
      }
      if (!r.oneYear) {
        caveats.push('No one-year figure: post-exit prices are kept for about six months, so the 250-day horizon has no data yet.');
      }

      const scoreLine = right == null
        ? '<span class="text-muted">No verdict — not enough data after the sell.</span>'
        : (soberMode
          ? (right ? '+1 point' : 'no point')
          : (right ? 'You called it 🎯' : 'Wrong — drink 🍺'));

      el.innerHTML = `
        ${renderPicker(trade)}
        <div class="bt-card">
          <div class="bt-head">
            <span class="bt-sec">${escapeHtml(trade.security)}</span>
            <span class="tag">sold ${escapeHtml(trade.exitDate)} by ${escapeHtml(trade.ownerNames)}</span>
          </div>
          <div class="game-result ${right === true ? 'win' : right === false ? 'loss' : ''} bt-verdict">
            <div class="verdict">${r.overall ? escapeHtml(V().VERDICT_LABEL[r.overall]) : 'No verdict'}</div>
            <div class="who-state">${r.overallDays ? `judged at ${r.overallDays} trading days` : ''}</div>
            <div class="pnl">${scoreLine}</div>
          </div>
          ${strip ? `<div class="bt-strip">${strip}</div>
            <p class="text-muted text-small">Each horizon is what the price did by then. Hover for the close it used.</p>` : ''}
          <div class="detail-grid">
            <div class="kpi-card"><div class="label">Best case if you had held</div>
              <div class="value positive">${r.missedMoney ? fmtNok(r.missedMoney) : '—'}</div>
              <div class="sub">${r.maxAfter ? `peaked ${fmtPct(r.maxAfter.value * 100, true)} on ${escapeHtml(r.maxAfter.date)}` : ''}</div></div>
            <div class="kpi-card"><div class="label">Worst case avoided</div>
              <div class="value">${r.moneySaved ? fmtNok(r.moneySaved) : '—'}</div>
              <div class="sub">${r.minAfter ? `bottomed ${fmtPct(r.minAfter.value * 100, true)} on ${escapeHtml(r.minAfter.date)}` : ''}</div></div>
            ${r.oneYear ? `<div class="kpi-card"><div class="label">If you had held one year</div>
              <div class="value ${pctClass(r.oneYear.pct)}">${fmtPct(r.oneYear.pct, true)}</div>
              <div class="sub">${fmtNok(r.oneYear.money)}</div></div>` : ''}
          </div>
          <div id="bt-chart"></div>
          ${caveats.map((c) => `<p class="bt-caveat">⚠ ${escapeHtml(c)}</p>`).join('')}
          <div style="margin-top:14px"><button class="btn game-spin" id="bt-next">Another trade</button></div>
        </div>
        ${renderAggregate()}`;
      mountChart('#bt-chart', s, trade, true);
      el.querySelector('#bt-next').addEventListener('click', () => newRound());
      bindPicker();
    }

    function renderPicker(trade) {
      const list = filtered();
      const opts = list.slice(0, 200).map((t) =>
        `<option value="${escapeHtml(t.id)}"${trade && t.id === trade.id ? ' selected' : ''}>${escapeHtml(t.security)} · ${escapeHtml(t.exitDate)}</option>`).join('');
      return `
        <div class="range-picker bt-picker">
          <select id="bt-pick" class="preset" aria-label="Pick a trade">${opts}</select>
          <label class="sober-toggle">
            <input type="checkbox" id="bt-mine" ${onlyMine ? 'checked' : ''} /> Only my trades
          </label>
          <button type="button" class="preset" id="bt-random">🎲 Random</button>
        </div>`;
    }

    function bindPicker() {
      const sel = el.querySelector('#bt-pick');
      if (sel) sel.addEventListener('change', () => {
        const t = pickTrade(sel.value);
        if (t) { current = t; renderAsk(t); }
      });
      const mine = el.querySelector('#bt-mine');
      if (mine) mine.addEventListener('change', () => { onlyMine = mine.checked; newRound(); });
      const rnd = el.querySelector('#bt-random');
      if (rnd) rnd.addEventListener('click', () => newRound());
    }

    function newRound() {
      if (dead) return;
      const t = pickTrade(null);
      current = t;
      if (!t) {
        const soonest = waiting.slice().sort((a, b) => a.daysUntilPlayable - b.daysUntilPlayable)[0];
        el.innerHTML = window.UI.emptyState(
          'No closed trades to replay here',
          soonest
            ? `The most recent sell is still too fresh — come back in ${soonest.daysUntilPlayable} days.`
            : 'Widen the period, or turn off "only my trades".');
        return;
      }
      renderAsk(t);
    }

    newRound();

    return {
      newRound,
      destroy() { dead = true; },
      // exposed for tests
      _closedTrades: () => all,
    };
  }

  window.GameBackTrading = { mount, closedTrades };
})();
