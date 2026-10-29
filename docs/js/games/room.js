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
  const PING_MS = 5000;        // a phone says "still here" this often
  const AWAY_S = 15;           // silent this long and the host shows it reconnecting
  const RETRY_MS = 500;        // base wait between retries of a busy or dropped post

  function url() {
    return (window.PORTAL_CONFIG && window.PORTAL_CONFIG.ROOMS_URL) || '';
  }
  function configured() { return !!url(); }

  // Apps Script web apps do not answer CORS preflight, so the request has to
  // stay "simple": text/plain with a JSON string body. application/json here
  // fails in a way that looks like a network error, which is a miserable hour.
  // A pass stands in for a Google token: the phone's pass for answers and
  // pings, the host pass for round/game/close. Only create and join still need
  // a real token, and a member pass can never host.
  async function post(payload) {
    let auth = {};
    if (payload.pass || payload.hostPass) auth = {};
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

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Post, and try again when the script is busy or the network drops. Anything
  // else (stale round, closed, bad pass) is an answer, not a glitch.
  async function postRetry(payload, tries = 4) {
    let r = { ok: false, error: 'network' };
    for (let i = 0; i < tries; i++) {
      if (i) await sleep(RETRY_MS * i);
      try { r = await post(payload); } catch (_e) { r = { ok: false, error: 'network' }; }
      if (r.error !== 'busy' && r.error !== 'network') return r;
    }
    return r;
  }

  // A poller that backs off on failure and idles while the tab is hidden —
  // a phone in a pocket should not keep hammering the endpoint. A hidden or
  // sleeping tab has its timers throttled, so coming back (visible, online,
  // restored from the page cache, focused) kicks a poll straight away instead
  // of waiting out whatever is left of the timer.
  function poller(fn, onData, onError) {
    let timer = null;
    let stopped = false;
    let wait = POLL_MS;
    let gen = 0;   // a kick starts a newer poll; an older one in flight is ignored
    let flyingSince = 0;   // wake events arrive in bursts; one poll serves them all

    async function tick() {
      if (stopped) return;
      if (typeof document !== 'undefined' && document.hidden) {
        timer = setTimeout(tick, POLL_MS);
        return;
      }
      const mine = ++gen;
      flyingSince = Date.now();
      try {
        const data = await fn();
        if (stopped || mine !== gen) return;
        flyingSince = 0;
        wait = POLL_MS;
        onData(data);
      } catch (e) {
        if (stopped || mine !== gen) return;
        flyingSince = 0;
        wait = Math.min(BACKOFF_MAX_MS, Math.round(wait * 1.8));
        if (onError) onError(e);
      }
      if (!stopped) timer = setTimeout(tick, wait);
    }

    function kick() {
      if (stopped || (typeof document !== 'undefined' && document.hidden)) return;
      if (flyingSince && Date.now() - flyingSince < 2000) return;
      if (timer) clearTimeout(timer);
      wait = POLL_MS;
      tick();
    }
    const wakes = [[typeof document !== 'undefined' ? document : null, 'visibilitychange'],
      [window, 'online'], [window, 'pageshow'], [window, 'focus']];
    wakes.forEach(([t, n]) => { if (t && t.addEventListener) t.addEventListener(n, kick); });

    tick();
    return {
      kick,
      stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
        wakes.forEach(([t, n]) => { if (t && t.removeEventListener) t.removeEventListener(n, kick); });
      },
    };
  }

  // ── Host: the shared screen ───────────────────────────────────────────
  let hosted = null;   // survives view remounts

  async function openHost({ gameId, roster }) {
    const res = await post({ action: 'create', gameId, roster: roster.map((p) => p.code) });
    if (!res.ok) throw new Error(res.error || 'could not open a room');

    const listeners = new Set();
    let state = { joined: [], answers: {}, roundId: 0, rev: 0, away: [] };
    let roundId = 0;
    // The host pass runs the room after the host's own Google token has
    // expired. It lives only in memory: a reloaded host screen is a new room.
    const hostPass = res.hostPass;

    // A new room is a new evening: nothing from an earlier one carries over.
    // Then the evening's points follow the session to the room, so a phone can
    // read the same totals the host shows. Posts are coalesced: one in flight,
    // and the newest snapshot goes next, so a burst cannot reorder.
    const S = window.GameSession;
    if (S) S.reset();
    let sending = null;
    let dirty = false;
    function publishScores() {
      if (!S) return Promise.resolve();
      dirty = true;
      if (sending) return sending;
      // Cleared in a later tick (.then), never inside the async body: a throw
      // before its first await would otherwise clear `sending` and THEN have
      // the finished promise assigned to it, stalling every later publish.
      sending = (async () => {
        while (dirty) {
          dirty = false;
          await postRetry({ action: 'scores', code: res.code, hostPass, scores: S.snapshot() });
        }
      })().catch(() => { /* scores are a nicety: the games carry on */ }).then(() => { sending = null; });
      return sending;
    }
    const offScores = S ? S.onChange(() => { publishScores(); }) : null;

    const p = poller(() => get(res.code), (data) => {
      if (!data.ok) return;
      // Phones that joined but have gone quiet. A ping does not move `rev`, so
      // this is compared on its own.
      const seen = data.seen || {};
      const away = (data.joined || []).filter((c) => seen[c] > AWAY_S).sort();
      // Only wake the screen when something actually changed.
      if (data.rev === state.rev && away.join() === state.away.join()) return;
      state = { joined: data.joined || [], answers: data.answers || {}, roundId: data.roundId, rev: data.rev, away };
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
        // Retried on busy or a dropped network; if it still fails the screen
        // keeps working and the phones stay on the old question.
        await postRetry({ action: 'round', code: res.code, hostPass, roundId, prompt, choices });
        return roundId;
      },
      // Point the room at a different game. Everyone keeps their seat.
      async setGame(id) {
        if (this.gameId === id) return;
        this.gameId = id;
        roundId = 0;
        state = { ...state, answers: {}, roundId: 0 };
        listeners.forEach((cb) => cb(state));
        await postRetry({ action: 'game', code: res.code, hostPass, gameId: id });
      },
      // Tell the phones it is over before we stop listening, so they show an
      // end screen instead of silently going dead.
      async close() {
        // The final board goes up before the room is marked closed, so a phone
        // that sees "closed" already has the last totals.
        if (offScores) offScores();
        if (S && !S.isEmpty()) await publishScores();
        await postRetry({ action: 'close', code: res.code, hostPass }, 2);
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
  // browser has thrown the tab away. A network error is not a verdict: the
  // phone attaches in a reconnecting state and the poller keeps trying. Only
  // the server saying the room is closed or gone ends the seat.
  async function resume() {
    const s = loadSession();
    if (!s || !s.code || !s.pass) return null;
    let data = null;
    try { data = await get(s.code); } catch (_e) { /* offline: attach and retry */ }
    const gone = !!data && !data.ok && /no such room/i.test(data.error || '');
    return attachPlayer(s.code, {
      member: s.member, pass: s.pass,
      roundId: data && data.ok ? data.roundId : undefined,
      gameId: data && data.ok ? data.gameId : undefined,
      closed: !!data && !!data.ok && !!data.closed,
      gone,
      reconnecting: !data || (!data.ok && !gone),
    });
  }

  async function joinRoom(code) {
    const res = await post({ action: 'join', code });
    if (!res.ok) throw new Error(res.error || 'could not join');
    if (res.pass) saveSession({ code, member: res.member, pass: res.pass });
    return attachPlayer(code, res);
  }

  function attachPlayer(code, res) {

    const listeners = new Set();
    let last = {
      roundId: res.roundId, answered: false,
      closed: !!res.closed, gone: !!res.gone, reconnecting: !!res.reconnecting,
    };
    let lastPing = 0;
    const tell = () => listeners.forEach((cb) => cb({ ...last }));
    // The seat is over: stop polling, and the pass is no use to anyone.
    const ended = () => last.closed || last.gone;
    // The saved pass no longer matches this room (the code was reused, or the
    // room was rebuilt): nothing here is ours any more.
    const lost = (error) => /bad pass|not in this room|no such room/i.test(error || '');
    function drop() { last.gone = true; clearSession(); if (poll) poll.stop(); tell(); }
    if (ended()) clearSession();

    // Declared before the poller so the callback can stop it without relying
    // on the first tick happening to be async.
    let poll = null;
    if (!ended()) poll = poller(() => get(code), (data) => {
      if (!data.ok) {
        // "No such room" is final; anything else (busy, a bad reply) is a
        // glitch and the phone keeps trying under a Reconnecting banner.
        if (lost(data.error)) drop();
        else { last.reconnecting = true; tell(); }
        return;
      }
      last.reconnecting = false;
      if (data.roundId !== last.roundId) {
        // A new question: unlock the buttons.
        last = { ...last, roundId: data.roundId, answered: false };
      } else {
        last.answered = Object.prototype.hasOwnProperty.call(data.answers || {}, res.member);
      }
      last.prompt = data.prompt || '';
      last.choices = data.choices || 0;
      last.closed = !!data.closed;
      last.gameId = data.gameId;
      last.scores = data.scores || null;
      if (last.closed) { clearSession(); poll.stop(); }   // nothing more will change
      else if (Date.now() - lastPing >= PING_MS) {
        // Tell the host this phone is still here. Best effort: a missed ping
        // only makes the seat look quiet until the next one.
        lastPing = Date.now();
        post({ action: 'ping', code, pass: res.pass }).then((r) => { if (!r.ok && lost(r.error)) drop(); }).catch(() => {});
      }
      listeners.forEach((cb) => cb({ ...last, joined: data.joined }));
    }, () => { last.reconnecting = true; tell(); });

    return {
      code,
      member: res.member,
      gameId: res.gameId,
      // True when the host had already stopped before this phone arrived.
      closed: !!res.closed,
      onChange(cb) { listeners.add(cb); cb(last); return () => listeners.delete(cb); },
      async answer(value) {
        // Pass first: it outlives the Google token, which is the whole point.
        const r = await postRetry({ action: 'answer', code, roundId: last.roundId, value, pass: res.pass });
        if (r.ok) { last.answered = true; tell(); }
        // The host moved on while this tap was in flight. Never re-send it into
        // a question the player has not seen: fetch the new one instead.
        else if (r.error === 'stale round' && poll) poll.kick();
        else if (lost(r.error)) drop();
        else if (r.error === 'room closed') { last.closed = true; clearSession(); if (poll) poll.stop(); tell(); }
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
