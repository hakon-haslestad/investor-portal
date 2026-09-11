// Cross-device play: the shared screen hosts a room, phones answer into it.
//
// Deliberately outside every game. Changing any filter — even the sober
// toggle — navigates, which remounts the view and destroys the mounted game
// (router.js dispatch → the view's cleanup). A room held inside a game would
// die the first time somebody touched a filter, so the host instance lives
// here at module scope and the view re-attaches to it.
//
// Talks to the Apps Script web app (see apps-script/Code.gs, GAME ROOMS).

(function () {
  const POLL_MS = 1500;
  const BACKOFF_MAX_MS = 15000;

  function url() {
    return (window.PORTAL_CONFIG && window.PORTAL_CONFIG.ROOMS_URL) || '';
  }
  function configured() { return !!url(); }

  // Apps Script web apps do not answer CORS preflight, so the request has to
  // stay "simple": text/plain with a JSON string body. application/json here
  // fails in a way that looks like a network error, which is a miserable hour.
  // A pass stands in for a Google token when answering. Everything else needs
  // a real token, so the host actions cannot be driven by a pass.
  async function post(payload) {
    let auth = {};
    if (payload.pass) auth = { pass: payload.pass };
    else auth = { token: await window.Auth.accessToken() };
    const r = await fetch(url(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...payload, ...auth }),
      redirect: 'follow',
    });
    if (!r.ok) throw new Error(`rooms ${r.status}`);
    return r.json();
  }

  async function get(code) {
    const r = await fetch(`${url()}?code=${encodeURIComponent(code)}`, { redirect: 'follow' });
    if (!r.ok) throw new Error(`rooms ${r.status}`);
    return r.json();
  }

  // A poller that backs off on failure and idles while the tab is hidden —
  // a phone in a pocket should not keep hammering the endpoint.
  function poller(fn, onData, onError) {
    let timer = null;
    let stopped = false;
    let wait = POLL_MS;

    async function tick() {
      if (stopped) return;
      if (typeof document !== 'undefined' && document.hidden) {
        timer = setTimeout(tick, POLL_MS);
        return;
      }
      try {
        const data = await fn();
        wait = POLL_MS;
        if (!stopped) onData(data);
      } catch (e) {
        wait = Math.min(BACKOFF_MAX_MS, Math.round(wait * 1.8));
        if (onError) onError(e);
      }
      if (!stopped) timer = setTimeout(tick, wait);
    }

    tick();
    return { stop() { stopped = true; if (timer) clearTimeout(timer); } };
  }

  // ── Host: the shared screen ───────────────────────────────────────────
  let hosted = null;   // survives view remounts

  async function openHost({ gameId, roster }) {
    const res = await post({ action: 'create', gameId, roster: roster.map((p) => p.code) });
    if (!res.ok) throw new Error(res.error || 'could not open a room');

    const listeners = new Set();
    let state = { joined: [], answers: {}, roundId: 0, rev: 0 };
    let roundId = 0;

    const p = poller(() => get(res.code), (data) => {
      if (!data.ok) return;
      // Only wake the screen when something actually changed.
      if (data.rev === state.rev) return;
      state = { joined: data.joined || [], answers: data.answers || {}, roundId: data.roundId, rev: data.rev };
      listeners.forEach((cb) => cb(state));
    });

    hosted = {
      code: res.code,
      // The room outlives any one game: the host switches games inside it and
      // everybody stays put. This is why it is not keyed by game id.
      gameId,
      get state() { return state; },
      onChange(cb) { listeners.add(cb); cb(state); return () => listeners.delete(cb); },
      // Announcing a round clears the previous answers server-side, so a
      // phone cannot have an answer carried into a question it never saw.
      async setRound(prompt, choices) {
        roundId += 1;
        state = { ...state, answers: {}, roundId };
        listeners.forEach((cb) => cb(state));
        try { await post({ action: 'round', code: res.code, roundId, prompt, choices }); }
        catch (_e) { /* the screen keeps working; phones retry on their poll */ }
        return roundId;
      },
      // Point the room at a different game. Everyone keeps their seat.
      async setGame(id) {
        if (this.gameId === id) return;
        this.gameId = id;
        roundId = 0;
        state = { ...state, answers: {}, roundId: 0 };
        listeners.forEach((cb) => cb(state));
        try { await post({ action: 'game', code: res.code, gameId: id }); } catch (_e) { /* phones retry */ }
      },
      // Tell the phones it is over before we stop listening, so they show an
      // end screen instead of silently going dead.
      async close() {
        try { await post({ action: 'close', code: res.code }); } catch (_e) { /* best effort */ }
        p.stop();
        listeners.clear();
        if (hosted && hosted.code === res.code) hosted = null;
      },
    };
    return hosted;
  }

  // ── Player: the phone ─────────────────────────────────────────────────
  const SESSION_KEY = 'portal.games.room';
  function saveSession(s) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (_e) { /* private mode */ }
  }
  function loadSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (_e) { return null; }
  }
  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch (_e) { /* nothing to do */ }
  }

  // Rejoin from a stored pass, with no Google round trip at all. This is what
  // keeps a phone in the game after its OAuth token has expired or the
  // browser has thrown the tab away.
  async function resume() {
    const s = loadSession();
    if (!s || !s.code || !s.pass) return null;
    const data = await get(s.code);
    if (!data.ok || data.closed) { clearSession(); return null; }
    return attachPlayer(s.code, { member: s.member, pass: s.pass, roundId: data.roundId, gameId: data.gameId });
  }

  async function joinRoom(code) {
    const res = await post({ action: 'join', code });
    if (!res.ok) throw new Error(res.error || 'could not join');
    if (res.pass) saveSession({ code, member: res.member, pass: res.pass });
    return attachPlayer(code, res);
  }

  function attachPlayer(code, res) {

    const listeners = new Set();
    let last = { roundId: res.roundId, answered: false };

    // Declared before the poller so the callback can stop it without relying
    // on the first tick happening to be async.
    let poll = null;
    poll = poller(() => get(code), (data) => {
      if (!data.ok) return;
      if (data.roundId !== last.roundId) {
        // A new question: unlock the buttons.
        last = { roundId: data.roundId, answered: false };
      } else {
        last.answered = Object.prototype.hasOwnProperty.call(data.answers || {}, res.member);
      }
      last.prompt = data.prompt || '';
      last.choices = data.choices || 0;
      last.closed = !!data.closed;
      last.gameId = data.gameId;
      if (last.closed && poll) poll.stop();   // nothing more will change
      listeners.forEach((cb) => cb({ ...last, joined: data.joined }));
    });

    return {
      code,
      member: res.member,
      gameId: res.gameId,
      // True when the host had already stopped before this phone arrived.
      closed: !!res.closed,
      onChange(cb) { listeners.add(cb); cb(last); return () => listeners.delete(cb); },
      async answer(value) {
        // Pass first: it outlives the Google token, which is the whole point.
        const r = await post({ action: 'answer', code, roundId: last.roundId, value, pass: res.pass });
        if (r.ok) { last.answered = true; listeners.forEach((cb) => cb({ ...last })); }
        return r;
      },
      close() { if (poll) poll.stop(); listeners.clear(); },
      forget() { clearSession(); },
    };
  }

  window.GameRoom = {
    configured,
    openHost,
    joinRoom,
    resume,
    savedSession: loadSession,
    clearSession,
    current: () => hosted,
    closeCurrent() { if (hosted) hosted.close(); },
    // exposed for tests
    _poller: poller,
  };
})();
