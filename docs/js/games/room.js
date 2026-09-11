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
  async function post(payload) {
    const token = await window.Auth.accessToken();
    const r = await fetch(url(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...payload, token }),
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
      close() { p.stop(); listeners.clear(); if (hosted && hosted.code === res.code) hosted = null; },
    };
    return hosted;
  }

  // ── Player: the phone ─────────────────────────────────────────────────
  async function joinRoom(code) {
    const res = await post({ action: 'join', code });
    if (!res.ok) throw new Error(res.error || 'could not join');

    const listeners = new Set();
    let last = { roundId: res.roundId, answered: false };

    const p = poller(() => get(code), (data) => {
      if (!data.ok) return;
      if (data.roundId !== last.roundId) {
        // A new question: unlock the buttons.
        last = { roundId: data.roundId, answered: false };
      } else {
        last.answered = Object.prototype.hasOwnProperty.call(data.answers || {}, res.member);
      }
      last.prompt = data.prompt || '';
      last.choices = data.choices || 0;
      listeners.forEach((cb) => cb({ ...last, gameId: data.gameId, joined: data.joined }));
    });

    return {
      code,
      member: res.member,
      gameId: res.gameId,
      onChange(cb) { listeners.add(cb); cb(last); return () => listeners.delete(cb); },
      async answer(value) {
        const r = await post({ action: 'answer', code, roundId: last.roundId, value });
        if (r.ok) { last.answered = true; listeners.forEach((cb) => cb({ ...last })); }
        return r;
      },
      close() { p.stop(); listeners.clear(); },
    };
  }

  window.GameRoom = {
    configured,
    openHost,
    joinRoom,
    current: () => hosted,
    closeCurrent() { if (hosted) hosted.close(); },
    // exposed for tests
    _poller: poller,
  };
})();
