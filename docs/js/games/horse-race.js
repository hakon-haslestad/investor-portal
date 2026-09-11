// Horse Race — each player picks a ticker, then a past price window is
// replayed as a race. Race maths lives in horse-race-engine.js; this is the
// setup screen, the SVG animation and the result.

(function () {
  const { fmtPct, escapeHtml, pctClass } = window.Fmt;
  const E = () => window.HorseRaceEngine;
  const NS = 'http://www.w3.org/2000/svg';

  const WINDOWS = [
    { id: '5', label: 'Last 5 trading days', days: 5 },
    { id: '20', label: 'Last 20 trading days', days: 20 },
    { id: '60', label: 'Last 60 trading days', days: 60 },
    { id: 'comp', label: 'Competition to date', days: 60 },
  ];
  const MAX_HORSES = 8;
  const LANE_H = 46;
  const VIEW_W = 1000;
  const START_X = 90;
  const RIGHT_X = 930;

  const DAY = 86400000;
  const addDays = (iso, n) => new Date(Date.parse(iso) + n * DAY).toISOString().slice(0, 10);

  function svgEl(name, attrs) {
    const el = document.createElementNS(NS, name);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  function reducedMotion() {
    return typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function mount(el, props) {
    const { trades, players, soberMode, pool, rng, history, competitionId } = props;
    let dead = false;
    let raf = null;
    let windowId = '5';
    let hardMode = false;
    const picks = new Map(); // playerCode -> ticker
    const roster = (players && players.length ? players : []).slice(0, MAX_HORSES);

    // One runner per distinct ticker in the filtered trades.
    const runners = [];
    const seen = new Set();
    for (const t of trades) {
      const ticker = pool.tickerFor(t.security) || t.security;
      if (seen.has(ticker)) continue;
      seen.add(ticker);
      runners.push({ ticker, name: t.security });
    }

    function windowRange() {
      const w = WINDOWS.find((x) => x.id === windowId) || WINDOWS[0];
      const to = new Date().toISOString().slice(0, 10);
      if (windowId === 'comp' && trades.length) {
        return { from: trades[0].from, to: trades[0].to || to, days: 60 };
      }
      // Trading days -> calendar days; the series is filtered to real closes.
      return { from: addDays(to, -Math.round(w.days * 1.5) - 5), to, days: w.days };
    }

    function pointsFor(name, from, to) {
      const s = pool.priceSeriesForSecurity(name, [], from, to);
      return (s.points || []).filter((p) => p.date >= from && p.date <= to)
        .map((p) => ({ date: p.date, price: p.price }));
    }

    // ── Setup ────────────────────────────────────────────────────────────
    function renderSetup(message) {
      if (dead) return;
      const { from, to } = windowRange();
      // Odds come from the window BEFORE the race, so they cannot encode its
      // outcome. Cosmetic either way — they never affect the running.
      const withOdds = runners.map((r) => ({
        ...r,
        odds: E().oddsFor(E().volatility(pointsFor(r.name, addDays(from, -60), from))),
      }));
      const taken = new Set(picks.values());

      el.innerHTML = `
        ${message ? `<div class="flash">${escapeHtml(message)}</div>` : ''}
        <div class="section-title">Race window</div>
        <div class="range-picker">
          ${WINDOWS.map((w) => `<button class="preset ${windowId === w.id ? 'active' : ''}" data-window="${w.id}" aria-pressed="${windowId === w.id}">${w.label}</button>`).join('')}
        </div>
        <p class="text-muted text-small">Daily closes only — there is no intraday data, so the shortest race is five days.</p>

        <div class="section-title">Pick your horse</div>
        ${roster.length ? `<div class="hr-picks">
          ${roster.map((p) => `
            <label class="hr-pick">
              <span class="hr-pick-who">${escapeHtml(p.name)}</span>
              <select data-player="${escapeHtml(p.code)}" aria-label="Horse for ${escapeHtml(p.name)}">
                <option value="">— sitting out —</option>
                ${withOdds.map((r) => {
                  const mine = picks.get(p.code) === r.ticker;
                  const blocked = taken.has(r.ticker) && !mine;
                  return `<option value="${escapeHtml(r.ticker)}"${mine ? ' selected' : ''}${blocked ? ' disabled' : ''}>${escapeHtml(r.ticker)} · ${escapeHtml(r.name)} · ${r.odds.toFixed(1)}</option>`;
                }).join('')}
              </select>
            </label>`).join('')}
        </div>` : window.UI.emptyState('No players', 'Pick a competition with participants, or add members to the sheet.')}

        <div class="range-picker hr-options">
          <label class="sober-toggle">
            <input type="checkbox" id="hr-hard" ${hardMode ? 'checked' : ''} /> Harder mode
          </label>
          <span class="text-muted text-small">${soberMode ? 'Podium scores 3-2-1.' : hardMode ? 'Everyone drinks once per horse that beat theirs.' : 'Last place drinks.'}</span>
        </div>

        <div style="margin:16px 0">
          <button class="btn game-spin" id="hr-start" ${picks.size < 2 ? 'disabled' : ''}>
            🏇 ${picks.size < 2 ? 'Pick at least two horses' : 'Start the race'}
          </button>
        </div>
        <p class="text-muted text-small">Window: ${escapeHtml(from)} → ${escapeHtml(to)}</p>`;

      el.querySelectorAll('[data-window]').forEach((b) => b.addEventListener('click', () => {
        windowId = b.getAttribute('data-window'); renderSetup();
      }));
      el.querySelectorAll('[data-player]').forEach((sel) => sel.addEventListener('change', () => {
        const code = sel.getAttribute('data-player');
        if (sel.value) picks.set(code, sel.value); else picks.delete(code);
        renderSetup();
      }));
      const hard = el.querySelector('#hr-hard');
      if (hard) hard.addEventListener('change', () => { hardMode = hard.checked; renderSetup(); });
      const start = el.querySelector('#hr-start');
      if (start) start.addEventListener('click', startRace);
    }

    // ── Race ─────────────────────────────────────────────────────────────
    function startRace() {
      const { from, to, days } = windowRange();
      const horses = [];
      for (const [code, ticker] of picks) {
        const r = runners.find((x) => x.ticker === ticker);
        if (!r) continue;
        const player = (roster.find((p) => p.code === code) || {}).name || code;
        horses.push({
          ticker, name: r.name, player,
          odds: E().oddsFor(E().volatility(pointsFor(r.name, addDays(from, -60), from))),
          points: pointsFor(r.name, from, to),
        });
      }
      const race = E().buildRace(horses);
      // Exclusions are reported BEFORE the race, never mid-race.
      if (!race.ok) {
        renderSetup(race.excluded.length
          ? `Not enough runners with prices for this window: ${race.excluded.map((h) => h.ticker).join(', ')} had no data.`
          : 'Need at least two horses with price data for this window.');
        return;
      }
      if (race.excluded.length) {
        renderSetup(`Excluded before the off: ${race.excluded.map((h) => h.ticker).join(', ')} — no prices for this window.`);
        // Fall through: the setup screen now shows the warning; the user restarts.
        return;
      }
      runRace(race, days);
    }

    function renderTrack(race) {
      const h = race.lanes.length * LANE_H + 50;
      el.innerHTML = `
        <div class="hr-race">
          <div class="hr-commentary" id="hr-say" role="status" aria-live="polite">They're under starter's orders…</div>
          <div class="hr-track-wrap">
            <svg id="hr-svg" viewBox="0 0 ${VIEW_W} ${h}" role="img" aria-label="Race track"></svg>
          </div>
          <div class="hr-controls">
            <button class="btn ghost small" id="hr-pause">Pause</button>
            <button class="btn ghost small" id="hr-skip">Skip to finish</button>
          </div>
        </div>`;
      const svg = el.querySelector('#hr-svg');
      // Lanes
      race.lanes.forEach((l, i) => {
        const y = 30 + i * LANE_H;
        svg.appendChild(svgEl('rect', {
          x: 0, y: y - 16, width: VIEW_W, height: LANE_H - 6,
          fill: i % 2 ? 'rgba(255,255,255,0.02)' : 'transparent',
        }));
        const label = svgEl('text', { x: 6, y: y + 4, fill: '#8a92a6', 'font-size': '13' });
        label.textContent = `${l.player} · ${l.ticker}`;
        svg.appendChild(label);
      });
      // Start line
      svg.appendChild(svgEl('line', {
        x1: START_X, x2: START_X, y1: 10, y2: h - 10,
        stroke: '#3a3a3a', 'stroke-width': '2', 'stroke-dasharray': '4 4',
      }));
      return svg;
    }

    function runRace(race, days) {
      const svg = renderTrack(race);
      const horses = race.lanes.map((l, i) => {
        const y = 30 + i * LANE_H;
        const g = svgEl('g', {});
        const dot = svgEl('circle', { cx: START_X, cy: y, r: 11, fill: '#2D5BFF', stroke: '#0e0f13', 'stroke-width': '2' });
        const txt = svgEl('text', { x: START_X, y: y - 16, fill: '#e7e9ee', 'font-size': '12', 'text-anchor': 'middle' });
        g.appendChild(dot); g.appendChild(txt);
        svg.appendChild(g);
        return { lane: l, dot, txt, y, seed: 0.13 + i * 0.19 };
      });

      const say = el.querySelector('#hr-say');
      const seen = new Set();
      let lastFiller = 0;

      // The leader sits near the right edge throughout, so the scale expands
      // as the race opens up — that is the camera following the leader, and it
      // lands with the best final return exactly at the right edge.
      function place(t) {
        const positions = horses.map((hh) => E().interpolate(hh.lane.positions, t, hh.seed));
        const maxPos = Math.max(1e-4, ...positions);
        const scale = (RIGHT_X - START_X) / maxPos;
        positions.forEach((pos, i) => {
          const x = Math.max(4, Math.min(VIEW_W - 4, START_X + pos * scale));
          horses[i].dot.setAttribute('cx', x.toFixed(1));
          horses[i].txt.setAttribute('x', x.toFixed(1));
          horses[i].txt.textContent = fmtPct(pos * 100, true);
          horses[i].dot.setAttribute('fill', pos >= 0 ? '#3ee07f' : '#ff5b5b');
        });
        const lead = positions.indexOf(Math.max(...positions));
        horses.forEach((hh, i) => hh.dot.setAttribute('stroke', i === lead ? '#ffc94f' : '#0e0f13'));
      }

      function fireEvents(step, elapsed) {
        for (const ev of race.events) {
          if (ev.step <= step && !seen.has(ev.step + ev.text)) {
            seen.add(ev.step + ev.text);
            say.textContent = ev.text;
            lastFiller = elapsed;
            return;
          }
        }
        if (elapsed - lastFiller > 4000) {
          lastFiller = elapsed;
          say.textContent = rng.pick(E().FILLER);
        }
      }

      function finish() {
        place(1);
        renderResult(race);
      }

      if (reducedMotion()) {
        // No animation at all: show the finish, offer a replay.
        place(1);
        say.textContent = 'Race finished.';
        renderResult(race, true);
        return;
      }

      const duration = E().durationFor(days);
      const t0 = performance.now();
      let paused = false;
      let pausedAt = 0;
      let offset = 0;

      const frame = (now) => {
        if (dead) return;
        if (paused) return;
        const elapsed = now - t0 - offset;
        const t = Math.min(1, elapsed / duration);
        place(t);
        fireEvents(Math.floor(t * (race.steps - 1)), elapsed);
        if (t >= 1) { finish(); return; }
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);

      el.querySelector('#hr-pause').addEventListener('click', (e) => {
        paused = !paused;
        e.target.textContent = paused ? 'Resume' : 'Pause';
        if (paused) { pausedAt = performance.now(); if (raf) cancelAnimationFrame(raf); }
        else { offset += performance.now() - pausedAt; raf = requestAnimationFrame(frame); }
      });
      el.querySelector('#hr-skip').addEventListener('click', () => {
        paused = true;
        if (raf) cancelAnimationFrame(raf);
        finish();
      });
    }

    // ── Result ───────────────────────────────────────────────────────────
    function renderResult(race, viaReducedMotion) {
      if (dead) return;
      const rank = race.ranking;
      const medals = ['🥇', '🥈', '🥉'];
      const last = rank[rank.length - 1];

      const drink = soberMode
        ? 'Podium scores 3-2-1.'
        : hardMode
          ? 'Everyone drinks once per horse that beat theirs.'
          : `${last.player} came last — drink 🍺`;

      history.add({
        gameId: 'horse-race',
        competitionId: competitionId || '',
        players: rank.map((l) => l.player),
        summary: `${rank[0].player}'s ${rank[0].ticker} won (${fmtPct(rank[0].finalPos * 100, true)})`,
        payload: {
          window: windowId,
          horses: rank.map((l) => ({ player: l.player, ticker: l.ticker, finalPos: l.finalPos })),
        },
      });

      const podium = rank.slice(0, 3).map((l, i) => `
        <div class="hr-podium-slot">
          <div class="hr-medal">${medals[i]}</div>
          <div class="hr-podium-who">${escapeHtml(l.player)}</div>
          <div class="hr-podium-ticker">${escapeHtml(l.ticker)}</div>
          <div class="hr-podium-pct ${pctClass(l.finalPos * 100)}">${fmtPct(l.finalPos * 100, true)}</div>
        </div>`).join('');

      const rows = rank.map((l, i) => [
        `${i + 1}`, escapeHtml(l.player), escapeHtml(l.ticker),
        `<span class="${pctClass(l.finalPos * 100)}">${fmtPct(l.finalPos * 100, true)}</span>`,
        soberMode ? String(Math.max(0, 3 - i)) : '',
      ]);

      el.insertAdjacentHTML('beforeend', `
        <div class="hr-result">
          ${viaReducedMotion ? '<p class="text-muted text-small">Animation skipped — you have reduced motion turned on.</p>' : ''}
          <div class="hr-podium">${podium}</div>
          ${window.UI.table([
            { label: '#', p: 1 },
            { label: 'Player', p: 1 },
            { label: 'Horse', p: 1 },
            { label: 'Return', className: 'text-right', p: 1 },
            { label: 'Points', className: 'text-right', p: soberMode ? 2 : 3 },
          ], rows, { caption: 'Final standings' })}
          <p class="hr-drink">${escapeHtml(drink)}</p>
          <div class="hr-controls">
            <button class="btn game-spin" id="hr-again">Race again</button>
            ${viaReducedMotion ? '<button class="btn ghost" id="hr-replay">Replay animation</button>' : ''}
          </div>
        </div>`);

      // "Race again" keeps the horses and lets the window change.
      el.querySelector('#hr-again').addEventListener('click', () => renderSetup());
      const replay = el.querySelector('#hr-replay');
      if (replay) replay.addEventListener('click', () => runRaceIgnoringMotion(race));
    }

    function runRaceIgnoringMotion(race) {
      // Explicit opt-in overrides the reduced-motion default.
      const orig = window.matchMedia;
      window.matchMedia = () => ({ matches: false });
      try { runRace(race, windowRange().days); } finally { window.matchMedia = orig; }
    }

    renderSetup();

    return {
      newRound: () => renderSetup(),
      destroy() { dead = true; if (raf) cancelAnimationFrame(raf); },
    };
  }

  window.GameHorseRace = { mount, WINDOWS, MAX_HORSES };
})();
