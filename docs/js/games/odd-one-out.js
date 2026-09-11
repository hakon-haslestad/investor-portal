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
    // Hot-seat: one device passed around.
    let turn = 0;
    const roster = players && players.length ? players : [{ code: '', name: 'Player' }];

    function currentPlayer() { return roster[turn % roster.length]; }

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

    function render() {
      if (dead) return;
      if (!round) {
        el.innerHTML = window.UI.emptyState(
          'No round could be built from these trades',
          'Every rule needs three stocks that share something and one that does not. Widen the period and try again.');
        return;
      }
      const scoreLabel = soberMode ? 'points' : 'streak';
      el.innerHTML = `
        <div class="ooo">
          <div class="ooo-bar">
            <span class="ooo-turn">${roster.length > 1 ? `${escapeHtml(currentPlayer().name)}'s turn` : ''}</span>
            <span class="ooo-score">🔥 ${scoreLabel} ${streak} · best ${best}</span>
          </div>
          <p class="ooo-prompt">Three of these belong together. Which one doesn't?</p>
          <div class="ooo-cards">
            ${round.cards.map((t, i) => `
              <button type="button" class="ooo-card" data-i="${i}" ${answered ? 'disabled' : ''}>
                <span class="ooo-name">${escapeHtml(t.security)}</span>
                <dl class="ooo-fields">${cardFields(t, round.hideFields)}</dl>
              </button>`).join('')}
          </div>
          <div id="ooo-result"></div>
        </div>`;
      el.querySelectorAll('.ooo-card').forEach((btn) => {
        btn.addEventListener('click', () => answer(Number(btn.getAttribute('data-i'))));
      });
    }

    function answer(i) {
      if (answered || !round) return;
      answered = true;
      played += 1;
      const right = i === round.answer;
      if (right) { correct += 1; streak += 1; best = Math.max(best, streak); }
      else streak = 0;

      el.querySelectorAll('.ooo-card').forEach((btn, idx) => {
        btn.disabled = true;
        if (idx === round.answer) btn.classList.add('is-answer');
        if (idx === i && !right) btn.classList.add('is-wrong');
      });

      const who = roster.length > 1 ? `${escapeHtml(currentPlayer().name)} — ` : '';
      const drink = soberMode
        ? (right ? '+1 point' : 'no point')
        : (right ? 'nobody drinks' : 'drink 🍺');
      el.querySelector('#ooo-result').innerHTML = `
        <div class="game-result ${right ? 'win' : 'loss'} ooo-verdict">
          <div class="verdict">${who}${right ? 'Correct 🎯' : 'Wrong 💀'}</div>
          <div class="who-state">${escapeHtml(round.description)}</div>
          <div class="pnl">${drink}</div>
          <div style="margin-top:14px"><button class="btn game-spin" id="ooo-next">Next round</button></div>
        </div>`;
      el.querySelector('#ooo-next').addEventListener('click', () => {
        turn += 1;
        newRound();
      });
    }

    function newRound() {
      if (dead) return;
      round = window.OddOneOutRules.buildRound(trades, rng, lastRuleId);
      if (round) lastRuleId = round.ruleId;
      answered = false;
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
            summary: `${correct}/${played} correct · best ${scoreWord(best)}`,
            payload: { played, correct, best, sober: soberMode },
          });
        }
      },
    };

    function scoreWord(n) { return soberMode ? `${n} points` : `streak ${n}`; }
  }

  window.GameOddOneOut = { mount };
})();
