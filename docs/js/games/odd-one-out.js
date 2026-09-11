// Odd One Out — four cards, three share a hidden property. Tap the one that
// doesn't belong.
//
// The rule logic lives in odd-one-out-rules.js; this file is the board. Cards
// mask whatever the active rule's hideFields names, so a round can never show
// the player its own answer.

(function () {
  const { fmtNok, fmtPct, escapeHtml, pctClass } = window.Fmt;
  const MASK = '<span class="ooo-hidden" title="hidden this round">▓▓▓</span>';

  function mount(el, props) {
    const { trades, players, soberMode, rng, history, competitionId } = props;
    let dead = false;
    let round = null;
    let lastRuleId = null;
    let answered = false;
    let streak = 0;
    let best = 0;
    let correct = 0;
    let played = 0;
    let rounds = 0;
    let picks = new Map();          // this round: player code -> card index
    const scores = new Map();       // whole session: player code -> correct calls
    // Hot-seat: one device passed around.
    let turn = 0;
    const roster = players && players.length ? players : [{ code: '', name: 'Player' }];

    // Whoever is next to call it: the first player, from `turn`, who has not
    // picked yet. `turn` advances each round so the same person does not
    // always go first.
    // Playing alone is the original game: no player row, no turn prompt, no
    // "1/1 got it" — just the cards and a verdict. The multi-player chrome
    // exists to show whose call is whose, which is noise with nobody to tell
    // apart.
    const solo = roster.length === 1;

    function currentPlayer() {
      for (let k = 0; k < roster.length; k++) {
        const p = roster[(turn + k) % roster.length];
        if (!picks.has(p.code)) return p;
      }
      return roster[turn % roster.length];
    }

    function cardFields(t, hide) {
      const h = new Set(hide);
      const rows = [];
      if (!h.has('owner')) rows.push(['Who', escapeHtml(t.investorName)]);
      else rows.push(['Who', MASK]);
      if (!h.has('return')) {
        rows.push(['P/L', `<span class="${pctClass(t.pnlNok)}">${fmtNok(t.pnlNok)} · ${fmtPct(t.pnlPct, true)}</span>`]);
      } else rows.push(['P/L', MASK]);
      if (!h.has('dates')) rows.push(['Opened', escapeHtml(t.firstDate || '—')]);
      else rows.push(['Opened', MASK]);
      if (!h.has('status')) rows.push(['Status', t.sold ? 'closed' : 'still held']);
      else rows.push(['Status', MASK]);
      return rows.map(([k, v]) =>
        `<div class="ooo-field"><dt>${k}</dt><dd>${v}</dd></div>`).join('');
    }

    // Facts on one line, the same strip Back Trading uses.
    function factStrip(rows) {
      return `<div class="game-facts">${rows.map(([label, value, cls]) => `
        <div class="game-fact">
          <dt>${escapeHtml(label)}</dt>
          <dd class="${cls || ''}">${value}</dd>
        </div>`).join('')}</div>`;
    }

    // Players across the page with their pick underneath. Cards are numbered,
    // and a player's column shows the number they went for — so the room can
    // see who has called it and who is still thinking.
    function playerRow() {
      if (solo) return '';
      const active = currentPlayer();
      return `<div class="game-players">${roster.map((p) => {
        const pick = picks.get(p.code);
        const isTurn = !answered && p.code === active.code;
        const right = answered && pick != null ? pick === round.answer : null;
        const cls = ['game-player',
          right === true ? 'correct' : right === false ? 'wrong' : (pick != null ? 'in' : 'waiting'),
          isTurn ? 'active' : ''].filter(Boolean).join(' ');
        return `<div class="${cls}">
          <div class="game-player-who">${escapeHtml(p.name)}</div>
          <div class="ooo-pick">${pick != null
            ? `${pick + 1}${right === true ? ' ✓' : right === false ? ' ✗' : ''}`
            : (isTurn ? '<span class="ooo-pick-turn">your turn</span>' : '—')}</div>
          <div class="ooo-tally">${scores.get(p.code) || 0}</div>
        </div>`;
      }).join('')}</div>`;
    }

    function render() {
      if (dead) return;
      if (!round) {
        el.innerHTML = window.UI.emptyState(
          'No round could be built from these trades',
          'Every rule needs three stocks that share something and one that does not. Widen the period and try again.');
        return;
      }
      const waiting = roster.length - picks.size;
      el.innerHTML = `
        <div class="ooo">
          ${factStrip(solo ? [
            ['Correct', `${correct}/${played}`, ''],
            [soberMode ? 'Points' : 'Streak', String(streak), streak > 0 ? 'positive' : ''],
            ['Best', String(best), ''],
          ] : [
            ['Round', String(rounds + 1), ''],
            ['Correct', `${correct}/${played}`, ''],
            [soberMode ? 'Points' : 'Streak', String(streak), streak > 0 ? 'positive' : ''],
            ['Best', String(best), ''],
          ])}
          ${playerRow()}
          <p class="ooo-prompt">${answered
            ? 'Three of these belonged together.'
            : `Three of these belong together. Which one doesn't? ${roster.length > 1
              ? `<strong>${escapeHtml(currentPlayer().name)}</strong> to pick${waiting > 1 ? ` · ${waiting} still to call` : ''}.`
              : ''}`}</p>
          <div class="ooo-cards">
            ${round.cards.map((t, i) => `
              <button type="button" class="ooo-card" data-i="${i}" ${answered ? 'disabled' : ''}>
                <span class="ooo-num">${i + 1}</span>
                <span class="ooo-name">${escapeHtml(t.security)}</span>
                <dl class="ooo-fields">${cardFields(t, round.hideFields)}</dl>
              </button>`).join('')}
          </div>
          <div id="ooo-result"></div>
        </div>`;
      el.querySelectorAll('.ooo-card').forEach((btn) => {
        btn.addEventListener('click', () => answer(Number(btn.getAttribute('data-i'))));
      });
      if (answered) renderVerdict();
    }

    // One tap is one player's call. The board only reveals once everyone has
    // had theirs, so nobody is answering with the answer already on screen.
    function answer(i) {
      if (answered || !round) return;
      picks.set(currentPlayer().code, i);
      if (picks.size < roster.length) { render(); return; }

      answered = true;
      rounds += 1;
      for (const [code, pick] of picks) {
        played += 1;
        if (pick === round.answer) { correct += 1; scores.set(code, (scores.get(code) || 0) + 1); }
      }
      // The streak belongs to the table as a whole: a round counts when
      // everyone got it.
      const allRight = [...picks.values()].every((p) => p === round.answer);
      if (allRight) { streak += 1; best = Math.max(best, streak); } else streak = 0;
      render();
    }

    function renderVerdict() {
      const mount = el.querySelector('#ooo-result');
      if (!mount) return;
      el.querySelectorAll('.ooo-card').forEach((btn, idx) => {
        btn.disabled = true;
        if (idx === round.answer) btn.classList.add('is-answer');
        if (idx !== round.answer && [...picks.values()].includes(idx)) btn.classList.add('is-wrong');
      });

      const wrong = roster.filter((p) => picks.get(p.code) !== round.answer);
      const rightOnes = roster.filter((p) => picks.get(p.code) === round.answer);
      const allRight = wrong.length === 0;
      const drink = soberMode
        ? (solo
          ? (allRight ? '+1 point' : 'no point')
          : `${rightOnes.length} point${rightOnes.length === 1 ? '' : 's'} awarded`)
        : (allRight
          ? (solo ? 'Nobody drinks' : 'Nobody drinks 🎉')
          : (solo ? 'Drink 🍺' : `${wrong.map((p) => escapeHtml(p.name)).join(', ')} drink${wrong.length === 1 ? 's' : ''} 🍺`));

      mount.innerHTML = `
        <div class="game-result ${allRight ? 'win' : 'loss'} ooo-verdict">
          <div class="verdict">${solo
            ? (allRight ? 'Correct 🎯' : 'Wrong 💀')
            : (allRight ? 'All correct 🎯' : `${rightOnes.length}/${roster.length} got it`)}</div>
          <div class="who-state">${escapeHtml(round.description)}</div>
          <div class="pnl">${drink}</div>
          <div style="margin-top:14px"><button class="btn game-spin" id="ooo-next">Next round</button></div>
        </div>`;
      mount.querySelector('#ooo-next').addEventListener('click', () => {
        turn += 1;
        newRound();
      });
    }

    function newRound() {
      if (dead) return;
      round = window.OddOneOutRules.buildRound(trades, rng, lastRuleId);
      if (round) lastRuleId = round.ruleId;
      answered = false;
      picks = new Map();
      render();
    }

    newRound();

    return {
      newRound,
      destroy() {
        dead = true;
        // One result per session, per the brief.
        if (played > 0 && history) {
          history.add({
            gameId: 'odd-one-out',
            competitionId: competitionId || '',
            players: roster.map((p) => p.name),
            summary: `${rounds} round${rounds === 1 ? '' : 's'} · ${correct}/${played} correct · best ${scoreWord(best)}`,
            payload: {
              rounds, played, correct, best, sober: soberMode,
              scores: Object.fromEntries(scores),
            },
          });
        }
      },
    };

    function scoreWord(n) { return soberMode ? `${n} points` : `streak ${n}`; }
  }

  window.GameOddOneOut = { mount };
})();
