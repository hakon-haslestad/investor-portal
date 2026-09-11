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

  window.Views.play = async function (el, ctx) {
    const { query, navigate } = ctx;
    let room = null;
    let off = null;

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

    function renderEnded() {
      el.innerHTML = `
        <div class="play-shell play-ended">
          <h2>That's the game 🎉</h2>
          <p class="text-muted">The host closed the room. Look up at the screen for the result.</p>
          <a class="btn ghost" href="#/play">Join another room</a>
        </div>`;
    }

    function renderBoard(state) {
      // The host stopped: say so rather than leaving dead buttons on screen.
      if (state.closed) { renderEnded(); return; }
      // A number means plain 1..n; an array means the game gave the buttons
      // names. Either way these are game words, never club data.
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
          <p class="play-prompt">${locked
            ? 'Answer in — look up at the screen.'
            : esc(state.prompt || 'Your call. The question is on the big screen.')}</p>
          <div class="play-buttons ${locked ? 'locked' : ''}${labels.length === 2 ? ' two' : ''}">
            ${labels.map((label, i) => `
              <button type="button" class="play-btn${state.mine === i ? ' chosen' : ''}" data-v="${i}" ${locked ? 'disabled' : ''}>${esc(label)}</button>
            `).join('')}
          </div>
          <p class="text-muted text-small play-foot">Nothing is shown here on purpose — everyone watches the same screen.</p>
        </div>`;
      el.querySelectorAll('.play-btn').forEach((b) => {
        b.addEventListener('click', async () => {
          const v = Number(b.getAttribute('data-v'));
          el.querySelectorAll('.play-btn').forEach((x) => { x.disabled = true; });
          b.classList.add('chosen');
          try {
            const r = await room.answer(v);
            if (!r.ok) renderBoard({ ...state, answered: false, mine: null, error: r.error });
          } catch (_e) {
            // A failed send must not leave the buttons dead.
            renderBoard({ ...state, answered: false, mine: null });
          }
        });
      });
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
      if (room.closed) { renderEnded(); return; }
      navigate(`#/play?code=${code}`);
      let mine = null;
      let lastRound = -1;
      off = room.onChange((s) => {
        if (s.roundId !== lastRound) { lastRound = s.roundId; mine = null; }
        renderBoard({ ...s, mine, choices: s.choices });
      });
    }

    if (!window.GameRoom || !window.GameRoom.configured()) {
      el.innerHTML = window.UI.emptyState(
        'Phone play is not set up',
        'The Apps Script web app has not been deployed, or its URL is missing from config.js.');
      return;
    }

    const code = (query.code || '').toUpperCase();
    if (code) join(code); else renderJoin('');

    return () => { if (off) off(); if (room) room.close(); };
  };
})();
