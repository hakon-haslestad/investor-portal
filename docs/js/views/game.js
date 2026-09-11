// #/games — the catalogue, and #/games/<id> — one game inside the shell.
//
// Filters live in the query string, so changing one navigates; the router
// remounts this view and the game's round resets, which is the specified
// behaviour. Games never see the filter bar — they get `trades` already
// filtered and render only into #game-board.

(function () {
  window.Views.games = async function (el, ctx) {
    const { store, query, params, navigate } = ctx;
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
    const trades = pool.buildPool(filters, compById);
    const players = pool.playersFor(filters, compById);
    const gameId = (params[0] || '').trim();
    const game = gameId ? window.Games.byId(gameId) : null;

    // Unknown game id → back to the grid rather than a blank screen.
    if (gameId && !game) { navigate(S.hashFor(null, filters)); return; }

    let active = null; // the mounted game instance

    function mountGame() {
      const summary = S.filterSummary(filters, pool, compById);
      const recent = S.renderRecent(filters.competitionId, game.id);
      el.innerHTML = `
        <div class="hero">
          <h2>Games 🎲🍺 ${window.UI.infoIcon('the-game')}</h2>
        </div>
        ${S.renderFilterBar(filters, competitions)}
        ${S.renderShell(game, filters, summary, recent)}`;
      S.bindFilterBar(el, filters, navigate, game.id, () => mountGame());

      const board = el.querySelector('#game-board');
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

      active = game.component.mount(board, {
        trades, players,
        soberMode: S.soberMode(),
        pool, rng: window.GameRng(window.GameRng.randomSeed()),
        history: liveHistory,
        competitionId: filters.competitionId,
      });

      const nr = el.querySelector('#new-round');
      if (nr) nr.addEventListener('click', () => {
        if (active && typeof active.newRound === 'function') active.newRound();
      });
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
          <div class="when">${trades.length} stock${trades.length === 1 ? '' : 's'} in this selection</div>
        </div>
        ${S.renderFilterBar(filters, competitions)}
        ${S.renderGrid(window.Games.registry, trades, filters)}`;
      S.bindFilterBar(el, filters, navigate, null, () => mountGrid());
      S.bindGrid(el, filters, navigate);
    }

    if (game) mountGame(); else mountGrid();

    return () => { if (active && typeof active.destroy === 'function') active.destroy(); };
  };
})();
