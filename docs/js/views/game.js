// #/games — the catalogue, and #/games/<id> — one game inside the shell.
//
// Filters live in the query string, so changing one navigates; the router
// remounts this view and the game's round resets, which is the specified
// behaviour. Games never see the filter bar — they get `trades` already
// filtered and render only into #game-board.

(function () {
  window.Views.games = async function (el, ctx) {
    const { store, me, query, params, navigate } = ctx;
    const S = window.GameShell;

    let competitions = [];
    try { competitions = await window.CompetitionsData.listCompetitions(); }
    catch (_e) { /* optional — the period filter still works without them */ }
    const compById = new Map(competitions.map((c) => [c.competition.id, c]));

    const filters = S.filtersFromQuery(query);
    // A competition id in the URL that no longer exists would otherwise give
    // an empty pool with no explanation.
    if (filters.competitionId && !compById.has(filters.competitionId)) filters.competitionId = '';

    const pool = window.GamePool.createContext(store);
    // Every game gets the same baseline: a stock with no price history cannot
    // be charted, raced or judged, so it is dropped once here rather than in
    // each game. Games that need MORE than the baseline narrow it further.
    const all = pool.buildPool(filters, compById);
    const { kept: trades, dropped } = pool.withPriceData(all);
    // The full roster the competition (or the member list) defines, then
    // narrowed to whoever the player picker says is actually in the room.
    const roster = pool.playersFor(filters, compById);
    const players = S.activePlayers(roster, filters);
    const gameId = (params[0] || '').trim();
    const game = gameId ? window.Games.byId(gameId) : null;

    // Unknown game id → back to the grid rather than a blank screen.
    if (gameId && !game) { navigate(S.hashFor(null, filters)); return; }

    let active = null; // the mounted game instance

    function mountGame() {
      // A game can ask for the full viewport (the race track does). The
      // router removes this class on every dispatch, so it is scoped to here.
      if (game.wide) el.classList.add('wide');
      const summary = S.filterSummary(filters, pool, compById);
      const recent = S.renderRecent(filters.competitionId, game.id);
      el.innerHTML = `
        <div class="hero">
          <h2>Games 🎲🍺 ${window.UI.infoIcon('the-game')}</h2>
        </div>
        ${S.renderFilterBar(filters, competitions, roster)}
        ${renderHostBanner(game)}
        ${S.renderShell(game, filters, summary + droppedNote(), recent)}`;
      S.bindFilterBar(el, filters, navigate, game.id, () => mountGame(), { roster });
      bindHostBanner(game);

      const board = el.querySelector('#game-board');
      const needed = game.players === '3+' ? 3 : game.players === '2+' ? 2 : 1;
      if (players.length < needed) {
        board.innerHTML = window.UI.emptyState(
          `${game.name} needs ${needed} players`,
          `${players.length} selected. Add players above, or pick a game that works solo.`);
        const nr0 = el.querySelector('#new-round');
        if (nr0) nr0.disabled = true;
        return;
      }
      if (trades.length < game.minTrades) {
        board.innerHTML = window.UI.emptyState(
          `Needs at least ${game.minTrades} trades in this period`,
          'Widen the period, or pick another competition.');
        const nr = el.querySelector('#new-round');
        if (nr) nr.disabled = true;
        return;
      }

      // Wrap the store so writing a result refreshes the shell's "Recent
      // rounds" in place — otherwise it would only update on remount.
      const liveHistory = {
        list: (c, g, n) => S.history.list(c, g, n),
        add: (r) => { S.history.add(r); refreshRecent(); },
      };

      // A live room is held at module scope in GameRoom, NOT here: every
      // filter change remounts this view, and a room owned by the view would
      // die the first time someone touched a filter.
      const room = currentRoom();
      // The room follows the host between games; tell it which one is on.
      if (room && typeof room.setGame === 'function') room.setGame(game.id);

      active = game.component.mount(board, {
        trades, players, me,
        soberMode: S.soberMode(),
        pool, rng: window.GameRng(window.GameRng.randomSeed()),
        history: liveHistory,
        competitionId: filters.competitionId,
        room,
      });

      // Repaint the seat chips as phones join and answer.
      if (room) {
        const off = room.onChange(() => {
          const banner = el.querySelector('#host-banner');
          if (!banner) { off(); return; }
          banner.outerHTML = renderHostBanner(game);
          bindHostBanner(game);
        });
      }

      const nr = el.querySelector('#new-round');
      if (nr) nr.addEventListener('click', () => {
        if (active && typeof active.newRound === 'function') active.newRound();
      });
    }

    // Named so the count is explained rather than just being a smaller number.
    function droppedNote() {
      if (!dropped.length) return '';
      return ` · ${dropped.length} left out, no price history`;
    }

    // A game can be hosted only if it collects an answer per player and the
    // web app is configured. Spin and Guess score nothing, so there is
    // nothing for a phone to send.
    // A room can be opened from the grid (no game yet) or inside a hosted
    // game. Games that score nothing have nothing for a phone to send.
    function canHost(g) {
      if (!window.GameRoom || !window.GameRoom.configured()) return false;
      return g ? !!g.hosted : true;
    }

    // One room for the whole session. Opened from the grid and kept as the
    // host moves between games — everyone stays in their seat, only the
    // question changes.
    function currentRoom() {
      return (window.GameRoom && window.GameRoom.current()) || null;
    }

    async function startHosting(g) {
      const banner = el.querySelector('#host-banner');
      if (banner) banner.innerHTML = '<span class="text-muted">Opening a room…</span>';
      try {
        await window.GameRoom.openHost({ gameId: g ? g.id : '', roster: players });
        if (g) mountGame(); else mountGrid();
      } catch (e) {
        if (banner) banner.innerHTML = `<span class="flash error">Could not open a room: ${window.UI.esc(e.message || e)}</span>`;
      }
    }

    async function stopHosting(g) {
      const room = currentRoom();
      if (room) await room.close();
      if (g) mountGame(); else mountGrid();
    }

    function renderHostBanner(g) {
      if (!canHost(g)) return '';
      const room = currentRoom();
      if (!room) {
        // "Host" and "Join" must be visibly different things. With only one
        // button, every phone that found this screen opened its own room
        // instead of joining the one on the wall.
        return `<div id="host-banner" class="host-bar">
          <button type="button" class="btn small" id="host-start">📺 Host on this screen</button>
          <a class="btn ghost small" href="#/play">📱 Join a room</a>
          <span class="text-muted text-small">One room for the whole evening — open it here and it follows you from game to game.</span>
        </div>`;
      }
      const joinUrl = `${location.origin}${location.pathname}#/play?code=${room.code}`;
      const st = room.state || { joined: [], answers: {} };
      const waiting = players.filter((p) => !(st.joined || []).includes(p.code));
      return `<div id="host-banner" class="host-bar hosting">
        <div class="host-code"><span class="host-code-label">Room code</span><strong>${window.UI.esc(room.code)}</strong></div>
        <div class="host-how">
          <div class="host-how-step">On each phone: open this portal → <strong>Games</strong> → <strong>Join a room</strong> → type <strong>${window.UI.esc(room.code)}</strong></div>
          <div class="host-how-url">${window.UI.esc(joinUrl)}
            <button type="button" class="btn ghost small" id="host-copy">Copy link</button></div>
        </div>
        <div class="host-seats">${players.map((p) => {
          const joined = (st.joined || []).includes(p.code);
          const answered = Object.prototype.hasOwnProperty.call(st.answers || {}, p.code);
          return `<span class="host-seat ${answered ? 'answered' : joined ? 'joined' : ''}" title="${answered ? 'answered' : joined ? 'joined' : 'not joined yet'}">${window.UI.esc(p.code)}</span>`;
        }).join('')}</div>
        <div class="host-waiting">${waiting.length
          ? `waiting for ${waiting.map((p) => window.UI.esc(p.name)).join(', ')}`
          : 'everyone is in'}</div>
        <button type="button" class="btn ghost small" id="host-stop">Stop hosting</button>
      </div>`;
    }

    function bindHostBanner(g) {
      const start = el.querySelector('#host-start');
      if (start) start.addEventListener('click', () => startHosting(g));
      const copy = el.querySelector('#host-copy');
      if (copy) copy.addEventListener('click', async () => {
        const room = currentRoom();
        if (!room) return;
        const link = `${location.origin}${location.pathname}#/play?code=${room.code}`;
        try { await navigator.clipboard.writeText(link); copy.textContent = 'Copied ✓'; }
        catch (_e) { copy.textContent = 'Select the link above'; }
      });
      const stop = el.querySelector('#host-stop');
      if (stop) stop.addEventListener('click', () => stopHosting(g));
    }

    function refreshRecent() {
      const wrap = el.querySelector('#recent-wrap');
      const body = el.querySelector('#recent-body');
      if (!wrap || !body || !game) return;
      const html = S.renderRecent(filters.competitionId, game.id);
      body.innerHTML = html;
      wrap.hidden = !html;
    }

    function mountGrid() {
      el.innerHTML = `
        <div class="hero">
          <h2>Games 🎲🍺 ${window.UI.infoIcon('the-game')}</h2>
          <div class="when">${trades.length} stock${trades.length === 1 ? '' : 's'} in play${droppedNote()} · ${players.length} player${players.length === 1 ? '' : 's'}</div>
        </div>
        ${S.renderFilterBar(filters, competitions, roster)}
        ${renderHostBanner(null)}
        ${S.renderGrid(window.Games.registry, trades, filters, players.length)}`;
      S.bindFilterBar(el, filters, navigate, null, () => mountGrid(), { roster });
      S.bindGrid(el, filters, navigate);
      bindHostBanner(null);
      // Repaint the seats as phones join, without rebuilding the grid.
      const gridRoom = currentRoom();
      if (gridRoom) {
        const off = gridRoom.onChange(() => {
          const banner = el.querySelector('#host-banner');
          if (!banner) { off(); return; }
          banner.outerHTML = renderHostBanner(null);
          bindHostBanner(null);
        });
      }
    }

    if (game) mountGame(); else mountGrid();

    return () => { if (active && typeof active.destroy === 'function') active.destroy(); };
  };
})();
