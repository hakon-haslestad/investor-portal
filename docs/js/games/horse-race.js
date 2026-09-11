// Horse Race — each player picks a ticker, then a past price window is
// replayed as a race. Race maths lives in horse-race-engine.js; this is the
// setup screen, the SVG animation and the result.

(function () {
  const { fmtPct, escapeHtml, pctClass } = window.Fmt;
  const E = () => window.HorseRaceEngine;
  const WINDOWS = [
    { id: '5', label: 'Last 5 trading days', days: 5 },
    { id: '20', label: 'Last 20 trading days', days: 20 },
    { id: '60', label: 'Last 60 trading days', days: 60 },
    { id: 'comp', label: 'Competition to date', days: 60 },
  ];
  const MAX_HORSES = 8;

  const DAY = 86400000;
  const addDays = (iso, n) => new Date(Date.parse(iso) + n * DAY).toISOString().slice(0, 10);

  function mount(el, props) {
    const { trades, players, soberMode, pool, rng, history, competitionId } = props;
    let dead = false;
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
      // A horse with no closes in THIS window cannot run, whatever history it
      // has elsewhere. Filter the paddock rather than letting someone pick a
      // horse and then bouncing them back here when the race refuses to start.
      const eligible = runners.filter((r) => pointsFor(r.name, from, to).length >= 2);
      const noData = runners.length - eligible.length;
      // Drop any pick this window has just made ineligible.
      for (const [code, ticker] of [...picks]) {
        if (!eligible.some((r) => r.ticker === ticker)) picks.delete(code);
      }
      const withOdds = eligible.map((r) => ({
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
        <p class="text-muted text-small">Daily closes only — there is no intraday data, so the shortest race is five days.${noData ? ` ${noData} stock${noData === 1 ? '' : 's'} cannot run this window: no prices for it.` : ''}</p>

        <div class="section-title">Pick your horse</div>
        ${!eligible.length ? window.UI.emptyState('No horses can run this window',
          'None of these stocks have prices over that range. Try a longer window.') : ''}
        ${roster.length && eligible.length ? `<div class="hr-picks">
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
      const { from, to } = windowRange();
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
      runRace(race);
    }

    // The race itself lives in HorseRaceView, shared with the competition
    // deck, so there is one animation rather than two that drift apart.
    let view = null;
    function runRace(race) {
      if (view) view.destroy();
      const TRACK = window.HorseRaceAudio.TRACK;
      const audio = window.HorseRaceAudio.supported()
        ? window.HorseRaceAudio.create({ url: TRACK.url }) : null;
      view = window.HorseRaceView.create(el, {
        // Same length as the deck's race, because it is the same soundtrack:
        // the music is cut to the race, so the race is cut to the music.
        race,
        duration: TRACK.ms,
        autoStart: true,
        rng, audio,
        onFinish: (r) => renderResult(r),
      });
    }

    // ── Result ───────────────────────────────────────────────────────────
    function renderResult(race) {
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
          </div>
        </div>`);

      // "Race again" keeps the horses and lets the window change.
      el.querySelector('#hr-again').addEventListener('click', () => renderSetup());
    }

    renderSetup();

    return {
      newRound: () => renderSetup(),
      destroy() { dead = true; if (view) { view.destroy(); view = null; } },
    };
  }

  window.GameHorseRace = { mount, WINDOWS, MAX_HORSES };
})();
