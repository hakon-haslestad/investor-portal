// #/play — the phone.
//
// Buttons and nothing else. The question, the stocks and the figures stay on
// the shared screen everyone is looking at, which is both how Kahoot works
// and why no club data ever reaches the rooms endpoint.
//
// The player is already signed in — this is the same member-gated app they
// use on a laptop — so there is no separate join identity to invent.

(function () {
  const esc = (s) => window.UI.esc(s);

  // Mount the board on an already-joined room. Used by the normal route and
  // by the resume path in app.js, which runs before any sign-in — a phone
  // whose Google token has expired can still play out the room it joined.
  function attach(el, room, onLeave) {
    let mine = null;
    let lastRound = -1;

    function renderEnded() {
      el.innerHTML = `
        <div class="play-shell play-ended">
          <h2>That's the game 🎉</h2>
          <p class="text-muted">The host closed the room. Look up at the screen for the result.</p>
          <a class="btn ghost" href="#/play" id="play-again">Join another room</a>
        </div>`;
      const again = el.querySelector('#play-again');
      if (again && onLeave) again.addEventListener('click', onLeave);
    }

    function renderBoard(state) {
      if (state.closed) { renderEnded(); return; }
      const labels = Array.isArray(state.choices)
        ? state.choices
        : [...Array(Number(state.choices) || 4)].map((_, i) => String(i + 1));
      const locked = state.answered;
      el.innerHTML = `
        <div class="play-shell">
          <div class="play-head">
            <span class="play-you">${esc(room.member)}</span>
            <span class="play-room">room ${esc(room.code)}</span>
          </div>
          ${state.error ? `<div class="flash error play-error">${esc(state.error === 'taken' ? 'Someone beat you to that one — pick another.' : state.error)}</div>` : ''}
          <p class="play-prompt">${locked
            ? 'Locked in — look up at the screen.'
            : esc(state.prompt || 'Your call. The question is on the big screen.')}</p>
          <div class="play-buttons n${labels.length} ${locked ? 'locked' : ''}">
            ${labels.map((label, i) => `
              <button type="button" class="play-btn${state.mine === i ? ' chosen' : ''}" data-v="${i}" ${locked ? 'disabled' : ''}>${esc(label)}</button>
            `).join('')}
          </div>
        </div>`;
      el.querySelectorAll('.play-btn').forEach((b) => {
        b.addEventListener('click', async () => {
          const v = Number(b.getAttribute('data-v'));
          el.querySelectorAll('.play-btn').forEach((x) => { x.disabled = true; });
          b.classList.add('chosen');
          try {
            const r = await room.answer(v);
            if (r.ok) { mine = v; renderBoard({ ...state, answered: true, mine: v }); }
            else renderBoard({ ...state, answered: false, mine: null, error: r.error });
          } catch (_e) {
            renderBoard({ ...state, answered: false, mine: null });
          }
        });
      });
    }

    const off = room.onChange((s) => {
      if (s.roundId !== lastRound) { lastRound = s.roundId; mine = null; }
      renderBoard({ ...s, mine, choices: s.choices });
    });
    return () => { off(); room.close(); };
  }

  // Entry point for the resume path: no ctx, no router, no store.
  window.Views.playResumed = function (el, room) {
    attach(el, room, () => { room.forget(); });
  };

  window.Views.play = async function (el, ctx) {
    const { query, navigate } = ctx;
    let room = null;
    let detach = null;

    function renderJoin(code, error) {
      el.innerHTML = `
        <div class="play-shell">
          <h2>Join a room</h2>
          <p class="text-muted">Type the four letters showing on the big screen. Somebody has to be hosting there first — this does not start a game.</p>
          ${error ? `<div class="flash error">${esc(error)}</div>` : ''}
          <input id="play-code" class="play-code-input" value="${esc(code || '')}"
                 maxlength="4" autocapitalize="characters" autocomplete="off"
                 inputmode="text" aria-label="Room code" placeholder="ABCD" />
          <button class="btn game-spin" id="play-join">Join</button>
        </div>`;
      const input = el.querySelector('#play-code');
      const go = () => {
        const v = (input.value || '').trim().toUpperCase();
        if (v.length < 3) { input.focus(); return; }
        join(v);
      };
      el.querySelector('#play-join').addEventListener('click', go);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      if (!code) input.focus();
    }

    async function join(code) {
      el.innerHTML = '<div class="play-shell"><p>Joining…</p></div>';
      try {
        room = await window.GameRoom.joinRoom(code);
      } catch (e) {
        const msg = /no such room/i.test(e.message || '')
          ? `No room "${code}". Check the code on the big screen — rooms also close after a couple of hours.`
          : (e.message || String(e));
        renderJoin(code, msg);
        return;
      }
      navigate(`#/play?code=${code}`);
      // One board, shared with the resume path — a second copy would drift.
      detach = attach(el, room, () => { if (room.forget) room.forget(); });
    }

    if (!window.GameRoom || !window.GameRoom.configured()) {
      el.innerHTML = window.UI.emptyState(
        'Phone play is not set up',
        'The Apps Script web app has not been deployed, or its URL is missing from config.js.');
      return;
    }

    const code = (query.code || '').toUpperCase();
    if (code) join(code); else renderJoin('');

    return () => { if (detach) detach(); };
  };
})();
