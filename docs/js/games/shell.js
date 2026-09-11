// Shared furniture for the games page: the filter bar, the card grid, the
// per-game shell, sober mode, and the game-history store.
//
// Filters live in the URL query string (#/games?period=1y&comp=…), so a link
// is shareable and changing a filter remounts the view — which is also what
// resets the current game's round.

(function () {
  const esc = window.UI.esc;

  // ── Sober mode ───────────────────────────────────────────────────────────
  const SOBER_KEY = 'portal.games.sober';
  function soberMode() {
    try { return localStorage.getItem(SOBER_KEY) === '1'; } catch (_e) { return false; }
  }
  function setSoberMode(on) {
    try { localStorage.setItem(SOBER_KEY, on ? '1' : '0'); } catch (_e) { /* private mode */ }
  }

  // ── Game history ─────────────────────────────────────────────────────────
  // Deliberately a small interface with one localStorage implementation, so
  // swapping in a sheet-backed store later is contained. Sheet-backed would
  // need the write scope on every player, which is why it is not the default.
  const HISTORY_CAP = 50;
  const historyKey = (competitionId) => `portal.games.history.${competitionId || '_none'}`;

  const history = {
    list(competitionId, gameId, limit = 5) {
      let all = [];
      try { all = JSON.parse(localStorage.getItem(historyKey(competitionId)) || '[]'); }
      catch (_e) { return []; }
      if (!Array.isArray(all)) return [];
      // Storage order is append order, so reversing gives newest-first. Do NOT
      // sort on playedAt: two rounds finished in the same millisecond compare
      // equal and a stable sort then leaves them oldest-first.
      return all
        .filter((r) => !gameId || r.gameId === gameId)
        .reverse()
        .slice(0, limit);
    },
    add(result) {
      const key = historyKey(result.competitionId);
      let all = [];
      try { all = JSON.parse(localStorage.getItem(key) || '[]'); } catch (_e) { all = []; }
      if (!Array.isArray(all)) all = [];
      all.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        playedAt: new Date().toISOString(),
        ...result,
      });
      // Newest kept; oldest dropped once over the cap.
      if (all.length > HISTORY_CAP) all = all.slice(all.length - HISTORY_CAP);
      try { localStorage.setItem(key, JSON.stringify(all)); } catch (_e) { /* quota/private */ }
    },
  };

  // ── Filters ──────────────────────────────────────────────────────────────
  const PERIODS = [
    { id: 'all', label: 'All time' },
    { id: '1y', label: '1 Year' },
    { id: '2y', label: '2 Years' },
    { id: '3y', label: '3 Years' },
    { id: 'ytd', label: 'YTD' },
    { id: 'custom', label: 'Custom' },
  ];

  function defaultFrom() {
    const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - 1);
    return d.toISOString().slice(0, 10);
  }

  // Read the filter set out of the route's query object.
  function filtersFromQuery(query) {
    const q = query || {};
    const period = PERIODS.some((p) => p.id === q.period) ? q.period : 'all';
    return {
      period,
      from: q.from || defaultFrom(),
      to: q.to || new Date().toISOString().slice(0, 10),
      competitionId: q.comp || '',
      tags: (q.tags || '').split(',').filter(Boolean),
    };
  }

  // Build a hash for the grid or a game, carrying the filters along.
  function hashFor(gameId, filters) {
    const p = new URLSearchParams();
    if (filters.competitionId) p.set('comp', filters.competitionId);
    else {
      if (filters.period && filters.period !== 'all') p.set('period', filters.period);
      if (filters.period === 'custom') { p.set('from', filters.from); p.set('to', filters.to); }
    }
    if (filters.tags && filters.tags.length) p.set('tags', filters.tags.join(','));
    const qs = p.toString();
    return `#/games${gameId ? '/' + gameId : ''}${qs ? '?' + qs : ''}`;
  }

  // One-line summary of what the filters currently select, for the game shell.
  function filterSummary(filters, pool, compById) {
    if (filters.competitionId) {
      const c = compById && compById.get(filters.competitionId);
      return c ? `${c.competition.name} · ${c.competition.start_date} → ${c.competition.end_date}`
        : 'Unknown competition';
    }
    const label = (PERIODS.find((p) => p.id === filters.period) || {}).label || filters.period;
    const w = pool.computeWindow(filters.period, filters.from, filters.to);
    const measure = window.GamePool.measureFor(filters.period) === 'lifetime'
      ? 'lifetime result' : 'new bets in window';
    return `${label} · ${w.from} → ${w.to} · ${measure}`;
  }

  function renderFilterBar(filters, competitions) {
    const isComp = !!filters.competitionId;
    const compOpts = competitions.slice()
      .sort((a, b) => (b.competition.start_date || '').localeCompare(a.competition.start_date || ''))
      .map((c) => {
        const id = c.competition.id;
        const label = `${c.competition.name} (${c.competition.start_date || '?'} → ${c.competition.end_date || '?'})`;
        return `<option value="${esc(id)}"${filters.competitionId === id ? ' selected' : ''}>${esc(label)}</option>`;
      }).join('');

    return `
      <div class="section-title" id="period-label">Period</div>
      <div class="range-picker" id="period-picker" role="group" aria-labelledby="period-label">
        ${PERIODS.map((p) => `<button class="preset ${!isComp && filters.period === p.id ? 'active' : ''}" data-period="${p.id}" aria-pressed="${!isComp && filters.period === p.id}">${p.label}</button>`).join('')}
        ${!isComp && filters.period === 'custom' ? `
          <input type="date" id="custom-from" aria-label="From date" value="${esc(filters.from)}" max="${esc(filters.to)}" />
          <span class="sep">→</span>
          <input type="date" id="custom-to" aria-label="To date" value="${esc(filters.to)}" min="${esc(filters.from)}" />
        ` : ''}
        ${competitions.length ? `<select id="comp-select" class="preset" aria-label="Competition">
          <option value="">— competition —</option>${compOpts}
        </select>` : ''}
        <label class="sober-toggle">
          <input type="checkbox" id="sober-toggle" ${soberMode() ? 'checked' : ''} />
          Sober mode
        </label>
      </div>`;
  }

  // Wire the filter bar. Every change navigates, so the view remounts and the
  // current round resets — which is the specified behaviour.
  function bindFilterBar(el, filters, navigate, gameId, onSober) {
    el.querySelectorAll('#period-picker [data-period]').forEach((btn) => {
      btn.addEventListener('click', () => {
        navigate(hashFor(gameId, { ...filters, period: btn.getAttribute('data-period'), competitionId: '' }));
      });
    });
    const cf = el.querySelector('#custom-from');
    const ct = el.querySelector('#custom-to');
    if (cf) cf.addEventListener('change', () => {
      if (cf.value) navigate(hashFor(gameId, { ...filters, period: 'custom', from: cf.value, competitionId: '' }));
    });
    if (ct) ct.addEventListener('change', () => {
      if (ct.value) navigate(hashFor(gameId, { ...filters, period: 'custom', to: ct.value, competitionId: '' }));
    });
    const sel = el.querySelector('#comp-select');
    if (sel) sel.addEventListener('change', () => {
      navigate(hashFor(gameId, { ...filters, competitionId: sel.value }));
    });
    const sober = el.querySelector('#sober-toggle');
    if (sober) sober.addEventListener('change', () => {
      setSoberMode(sober.checked);
      if (onSober) onSober(sober.checked);
    });
  }

  // ── Card grid ────────────────────────────────────────────────────────────
  const TAGS = [
    { id: 'party', label: 'Party' },
    { id: 'skill', label: 'Skill' },
    { id: 'recurring', label: 'Recurring' },
  ];

  function renderGrid(games, trades, filters) {
    const active = new Set(filters.tags || []);
    const shown = active.size
      ? games.filter((g) => g.tags.some((t) => active.has(t)))
      : games;

    const chips = `
      <div class="type-pills game-tags" id="tag-chips" role="group" aria-label="Filter games by tag">
        ${TAGS.map((t) => `<button type="button" data-tag="${t.id}" class="${active.has(t.id) ? 'active' : ''}" aria-pressed="${active.has(t.id)}">${t.label}</button>`).join('')}
      </div>`;

    if (!shown.length) {
      return chips + window.UI.emptyState('No games match those tags', 'Clear a chip to see the rest.');
    }

    const sober = soberMode();
    const cards = shown.map((g) => {
      const playable = trades.length >= g.minTrades;
      return `
        <div class="game-card${playable ? '' : ' disabled'}">
          <div class="game-card-icon" aria-hidden="true">${g.icon || '🎲'}</div>
          <h3>${esc(g.name)}</h3>
          <p class="game-card-tagline">${esc(g.tagline)}</p>
          <div class="game-card-tags">
            ${g.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
            <span class="tag players">${esc(g.players)} player${g.players === '1' ? '' : 's'}</span>
          </div>
          ${!sober && g.drinkingRule ? `<p class="game-card-drink">🍺 ${esc(g.drinkingRule)}</p>` : ''}
          ${playable
            ? `<a class="btn small" href="${hashFor(g.id, filters)}">Play</a>`
            : `<p class="game-card-gate">Needs at least ${g.minTrades} trades in this period</p>`}
        </div>`;
    }).join('');

    return `${chips}<div class="game-grid">${cards}</div>`;
  }

  function bindGrid(el, filters, navigate) {
    el.querySelectorAll('#tag-chips [data-tag]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tag = btn.getAttribute('data-tag');
        const next = new Set(filters.tags || []);
        if (next.has(tag)) next.delete(tag); else next.add(tag);
        navigate(hashFor(null, { ...filters, tags: [...next] }));
      });
    });
  }

  // ── Game shell ───────────────────────────────────────────────────────────
  // Back link, name, collapsible rules, filter summary, New round, and the
  // board mount. Games only ever render inside #game-board.
  function renderShell(game, filters, summary, recent) {
    const sober = soberMode();
    return `
      <div class="game-shell-head">
        <a class="game-back" href="${hashFor(null, filters)}">← All games</a>
        <h2>${game.icon || '🎲'} ${esc(game.name)}</h2>
        <button type="button" class="btn small" id="new-round">New round</button>
      </div>
      <p class="game-shell-filters">${esc(summary)}</p>
      <details class="rules-info game-rules">
        <summary><span class="info-icon" aria-hidden="true">i</span> How to play</summary>
        <div class="rules-body">
          ${game.rules}
          ${!sober && game.drinkingRule ? `<p><strong>🍺 ${esc(game.drinkingRule)}</strong></p>` : ''}
          ${sober ? '<p class="text-muted text-small">Sober mode is on — drinks are points.</p>' : ''}
        </div>
      </details>
      <div id="game-board"></div>
      <details class="rules-info game-recent" id="recent-wrap"${recent ? '' : ' hidden'}>
        <summary><span class="info-icon" aria-hidden="true">i</span> Recent rounds</summary>
        <div class="rules-body" id="recent-body">${recent || ''}</div>
      </details>
    `;
  }

  // The last few rounds of one game, for the shell's collapsed section.
  function renderRecent(competitionId, gameId, limit = 5) {
    const rows = history.list(competitionId, gameId, limit);
    if (!rows.length) return '';
    return `<ul class="recent-rounds">${rows.map((r) => {
      const when = String(r.playedAt || '').slice(0, 16).replace('T', ' ');
      return `<li><span class="text-muted text-small">${esc(when)}</span> · ${esc(r.summary || '')}</li>`;
    }).join('')}</ul>`;
  }

  window.GameShell = {
    PERIODS, TAGS,
    soberMode, setSoberMode,
    history,
    filtersFromQuery, hashFor, filterSummary,
    renderFilterBar, bindFilterBar,
    renderGrid, bindGrid,
    renderShell, renderRecent,
  };
})();
