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
    let answers = [];   // [{player, wouldHold, correct}]
    let score = 0;
    let bets = new Map();   // player code -> true (hold) | false (sell)

    // verdictFor needs a price series, which is the expensive part, so each
    // trade is resolved once and reused by the picker, the round and the
    // aggregate.
    const cache = new Map();
    function resolve(trade) {
      if (!cache.has(trade.id)) {
        const series = seriesFor(pool, trade);
        cache.set(trade.id, { series, result: V().verdictFor(trade, series.points, today) });
      }
      return cache.get(trade.id);
    }

    // A stock whose feed expired, or that was never priced, has no closes
    // after the exit — there is nothing to judge the sell against, so it is
    // left out rather than offered and then shrugged at.
    const judgeable = playable.filter((t) => V().isJudgeable(resolve(t).result));
    const unjudgeable = playable.length - judgeable.length;

    function filtered() {
      const base = judgeable;
      if (!onlyMine) return base;
      const me = roster[0] && roster[0].code;
      return base.filter((t) => t.ownerCodes.includes(me));
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
      for (const t of judgeable) {
        const r = resolve(t).result;
        const verdict = r.overall;
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
        ${window.UI.section('Your sell record', { extra: '<span class="text-muted text-small">judged on the latest price available</span>' })}
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
          <p class="bt-ask">Would you have held?</p>
          <div class="bt-bets">
            ${roster.map((p) => {
              const bet = bets.get(p.code);
              return `<div class="bt-bet" data-player="${escapeHtml(p.code)}">
                <span class="bt-bet-who">${escapeHtml(p.name)}</span>
                <span class="bt-bet-buttons">
                  <button type="button" class="preset ${bet === true ? 'active' : ''}" data-bet="hold" aria-pressed="${bet === true}">Hold 💎</button>
                  <button type="button" class="preset ${bet === false ? 'active' : ''}" data-bet="sell" aria-pressed="${bet === false}">Sell ✂️</button>
                </span>
              </div>`;
            }).join('')}
          </div>
          <div class="bt-buttons">
            <button class="btn game-spin" id="bt-reveal" ${bets.size ? '' : 'disabled'}>
              ${bets.size ? `Reveal 👀 (${bets.size}/${roster.length} in)` : 'Everyone place a call first'}
            </button>
          </div>
          <p class="text-muted text-small">Nothing after the sell is shown yet. Players who sit out simply do not score.</p>
        </div>`;
      mountChart('#bt-chart', s, trade, false);
      el.querySelectorAll('.bt-bet [data-bet]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const code = btn.closest('.bt-bet').getAttribute('data-player');
          bets.set(code, btn.getAttribute('data-bet') === 'hold');
          renderAsk(trade); // re-render so the toggle and the counter update
        });
      });
      el.querySelector('#bt-reveal').addEventListener('click', () => reveal(trade));
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

    function reveal(trade) {
      const { series: s, result: r } = resolve(trade);
      // Score every player who placed a call.
      const calls = [...bets.entries()].map(([code, wouldHold]) => {
        const p = roster.find((x) => x.code === code) || { code, name: code };
        const correct = r.overall ? V().scoreAnswer(wouldHold, r.overall) : null;
        if (correct) score += 1;
        answers.push({ player: p.name, wouldHold, correct });
        return { ...p, wouldHold, correct };
      });

      if (history) {
        history.add({
          gameId: 'back-trading',
          competitionId: competitionId || '',
          players: calls.map((c) => c.name),
          summary: `${trade.security} sold ${trade.exitDate} — ${r.overall ? V().VERDICT_LABEL[r.overall] : 'no verdict'}${calls.length ? ` · ${calls.filter((c) => c.correct).length}/${calls.length} called it` : ''}`,
          payload: {
            tradeId: trade.id, verdict: r.overall,
            calls: calls.map((c) => ({ player: c.name, wouldHold: c.wouldHold, correct: c.correct })),
            horizons: r.horizons.map((h) => ({ days: h.days, verdict: h.verdict })),
          },
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
        caveats.push('No one-year figure yet — the feed keeps post-exit prices for a limited window, so the 250-day horizon has no data.');
      }

      const wrong = calls.filter((c) => c.correct === false);
      // Tint the card only when the room agreed: all right, or all wrong.
      const scored = calls.filter((c) => c.correct != null);
      const allRight = !scored.length ? null
        : scored.every((c) => c.correct) ? true
          : scored.every((c) => !c.correct) ? false : null;
      const scoreLine = calls.length
        ? `<div class="bt-calls">${calls.map((c) => `
            <span class="bt-call ${c.correct === true ? 'ok' : c.correct === false ? 'bad' : ''}">
              ${escapeHtml(c.name)} said <strong>${c.wouldHold ? 'hold' : 'sell'}</strong>
              ${c.correct === true ? '✓' : c.correct === false ? '✗' : ''}
            </span>`).join('')}</div>`
        : '<span class="text-muted">Nobody called it.</span>';
      // Running tally across the session, so a streak of good calls shows.
      const judged = answers.filter((a) => a.correct != null).length;
      const tally = judged
        ? `<div class="bt-tally">${score}/${judged} calls right this session</div>` : '';

      el.innerHTML = `
        ${renderPicker(trade)}
        <div class="bt-card">
          <div class="bt-head">
            <span class="bt-sec">${escapeHtml(trade.security)}</span>
            <span class="tag">sold ${escapeHtml(trade.exitDate)} by ${escapeHtml(trade.ownerNames)}</span>
          </div>
          <div class="game-result ${allRight === true ? 'win' : allRight === false ? 'loss' : ''} bt-verdict">
            <div class="verdict">${r.overall ? escapeHtml(V().VERDICT_LABEL[r.overall]) : 'No verdict'}</div>
            <div class="who-state">${r.latest
              ? `by the latest close we have — ${escapeHtml(r.latest.date)}, ${r.latest.daysAfter} days after the sale`
              : ''}</div>
            <div class="pnl">${scoreLine}</div>
            ${tally}
            ${drinkLine(r, trade, wrong)}
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

    // Who drinks: the seller if they got out too early, plus anyone who
    // called it wrong. Sober mode turns both into points.
    function drinkLine(r, trade, wrong) {
      if (soberMode) return '';
      const bits = [];
      if (r.overall === 'too-early') bits.push(`${escapeHtml(trade.ownerNames)} sold too early — drink 🍺`);
      if (wrong.length) bits.push(`${wrong.map((c) => escapeHtml(c.name)).join(', ')} called it wrong — drink 🍺`);
      return bits.length ? `<div class="bt-drink">${bits.join('<br>')}</div>` : '';
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
        </div>
        ${unjudgeable ? `<p class="text-muted text-small bt-excluded">${unjudgeable} closed trade${unjudgeable === 1 ? '' : 's'} left out — no price data after the sale to judge them by.</p>` : ''}`;
    }

    function bindPicker() {
      const sel = el.querySelector('#bt-pick');
      if (sel) sel.addEventListener('change', () => {
        const t = pickTrade(sel.value);
        if (t) { bets = new Map(); renderAsk(t); }
      });
      const mine = el.querySelector('#bt-mine');
      if (mine) mine.addEventListener('change', () => { onlyMine = mine.checked; newRound(); });
      const rnd = el.querySelector('#bt-random');
      if (rnd) rnd.addEventListener('click', () => newRound());
    }

    function newRound() {
      if (dead) return;
      bets = new Map();
      const t = pickTrade(null);
      if (!t) {
        const soonest = waiting.slice().sort((a, b) => a.daysUntilPlayable - b.daysUntilPlayable)[0];
        const why = [];
        if (unjudgeable) why.push(`${unjudgeable} closed trade${unjudgeable === 1 ? '' : 's'} had no price data after the sale, so there is nothing to judge them against.`);
        if (soonest) why.push(`The most recent sell is still too fresh — come back in ${soonest.daysUntilPlayable} days.`);
        if (!why.length) why.push('Widen the period, or turn off "only my trades".');
        el.innerHTML = window.UI.emptyState('No closed trades to replay here', why.join(' '));
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
