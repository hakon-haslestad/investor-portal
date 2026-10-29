// The evening's scoreboard: points from every game played in one hosted room,
// added up per player.
//
// Module scope on purpose, like GameRoom: a filter change remounts the games
// view and destroys the mounted game, but the evening goes on. Pure data, no
// DOM. The host's games award into it, games/room.js publishes the snapshot to
// the room, and phones compute the same totals from that snapshot, so host and
// phones cannot disagree and a reconnecting phone loses nothing.
//
// Nothing here is written to the Google Sheet.

(function () {
  // Points per game, kept by game id so playing one game twice adds up.
  let games = [];            // [{ id, name, pts: { code: n } }]
  let seen = new WeakSet();  // award keys (round objects) already counted; lets rounds be collected
  const listeners = new Set();

  const emit = () => { const s = snapshot(); listeners.forEach((cb) => cb(s)); };

  // Add points. `key` (optional) identifies the thing being scored, such as the
  // round object: a re-render that scores the same thing again adds nothing.
  function award(gameId, gameName, pts, key) {
    if (key !== undefined && key !== null && (typeof key === 'object' || typeof key === 'function')) {
      if (seen.has(key)) return false;
      seen.add(key);
    }
    let g = games.find((x) => x.id === gameId);
    let changed = false;
    for (const code of Object.keys(pts || {})) {
      const n = Number(pts[code]);
      if (!Number.isFinite(n) || n === 0) continue;
      if (!g) { g = { id: String(gameId), name: String(gameName || gameId), pts: {} }; games.push(g); }
      g.pts[code] = (g.pts[code] || 0) + n;
      changed = true;
    }
    if (changed) emit();
    return changed;
  }

  // For games that score nothing themselves: best three get 3, 2, 1. `order` is
  // player codes, best first. Ties are the caller's call (the engine's order).
  function placing(order) {
    const out = {};
    (order || []).slice(0, 3).forEach((code, i) => { if (code) out[code] = 3 - i; });
    return out;
  }

  const clone = (g) => ({ id: g.id, name: g.name, pts: { ...g.pts } });
  function snapshot() { return { games: games.map(clone) }; }

  // Rows sorted by total, best first. Equal totals share a rank (1, 1, 3) and
  // keep code order, so the board does not shuffle between polls. `snap` lets
  // a phone compute from what the room sent; with none, the live session.
  function totals(snap) {
    // A phone passes what the room sent, which is not to be trusted: only
    // whole numbers count, text is capped, and anything else is skipped.
    const list = snap ? (Array.isArray(snap.games) ? snap.games : []) : games;
    const byCode = new Map();
    for (const g of list) {
      if (!g || typeof g !== 'object' || !g.pts || typeof g.pts !== 'object') continue;
      for (const [code, n] of Object.entries(g.pts)) {
        if (typeof n !== 'number' || !Number.isInteger(n)) continue;
        const c = String(code).slice(0, 8);
        const row = byCode.get(c) || { code: c, total: 0, breakdown: [] };
        row.total += n;
        row.breakdown.push({ id: String(g.id).slice(0, 40), name: String(g.name).slice(0, 40), points: n });
        byCode.set(c, row);
      }
    }
    const rows = [...byCode.values()].sort((a, b) => b.total - a.total || (a.code < b.code ? -1 : 1));
    rows.forEach((r, i) => { r.rank = i && r.total === rows[i - 1].total ? rows[i - 1].rank : i + 1; });
    return rows;
  }

  // The board as HTML, shared by the host screen and the phones so they read
  // the same. `nameOf(code)` gives a display name (phones only know codes) and
  // `esc` is the page's escaper. Empty when nobody has scored.
  function boardHtml(rows, { nameOf, esc, final, me, compact } = {}) {
    const name = (c) => (nameOf ? nameOf(c) : c) || c;
    const list = rows || [];
    // Someone with no points yet is not on the list; say so on their own phone.
    const none = me && list.length && !list.some((r) => r.code === me)
      ? `<p class="session-zero">You: 0 points</p>` : '';
    if (!list.length) return '';
    return `<section class="session-board${final ? ' final' : ''}${compact ? ' compact' : ''}" id="session-board" aria-labelledby="session-board-title">
      <h3 id="session-board-title">${final ? 'Final scores' : 'Scoreboard'}</h3>
      <ol class="session-rows">${list.map((r) => {
        const mine = me && r.code === me;
        return `
        <li class="session-row r${r.rank}${mine ? ' mine' : ''}">
          <span class="session-rank">${r.rank}</span>
          <span class="session-name">${esc(name(r.code))}${mine ? '<span class="session-you"> (you)</span>' : ''}</span>
          <span class="session-total">${esc(r.total)}<span class="sr-only"> points</span></span>
          ${compact ? '' : `<span class="session-parts">${r.breakdown.map((b) => `${esc(b.name)} ${esc(b.points)}`).join(' · ')}</span>`}
        </li>`;
      }).join('')}
      </ol>${none}</section>`;
  }

  function reset() {
    games = [];
    seen = new WeakSet();
    emit();
  }

  function onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }

  window.GameSession = { award, placing, totals, snapshot, boardHtml, reset, onChange, isEmpty: () => !games.length };
})();
