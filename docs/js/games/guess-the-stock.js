// Guess the stock — five candidates, one chart, which is it?
//
// Used to be honour-system: mask the name, show the chart, say it out loud,
// press Reveal. Nothing was scored. It is now proper multiple choice, which
// is what lets phones answer it: the names go on the shared screen, numbered,
// and a phone shows 1-5.
//
// The wrong answers are other real holdings from the same filtered pool, so
// they are plausible rather than obviously padding.

(function () {
  const { fmtNok, fmtPct, escapeHtml, pctClass } = window.Fmt;
  const OPTIONS = 5;

  function mount(el, props) {
    const { trades, players, soberMode, rng, pool, history, competitionId, room } = props;
    let dead = false;
    let round = null;        // { entry, options[], answer }
    let revealed = false;
    let rounds = 0;
    let correct = 0;
    let played = 0;
    let streak = 0;
    let best = 0;
    const scores = new Map();
    let turn = 0;
    const picked = new Set();

    const roster = players && players.length ? players : [{ code: '', name: 'Player' }];
    const solo = roster.length === 1;

    // Only stocks with enough history to draw are worth dealing; the view
    // already filters the pool, this narrows to what makes a chart.
    const seriesCache = new Map();
    function seriesOf(t) {
      if (!seriesCache.has(t.security)) {
        seriesCache.set(t.security, pool.priceSeriesForSecurity(
          t.security, (t.investors || []).map((o) => o.code), t.from, t.to));
      }
      return seriesCache.get(t.security);
    }
    const drawable = trades.filter((t) => pool.chartable(seriesOf(t)));

    const rnd = window.GameRounds.create({
      room, roster,
      onChange: ({ changed }) => { if (changed && !dead) onAnswers(); },
    });

    function currentPlayer() {
      for (let k = 0; k < roster.length; k++) {
        const p = roster[(turn + k) % roster.length];
        if (!rnd.picks.has(p.code)) return p;
      }
      return roster[turn % roster.length];
    }

    function newRound() {
      if (dead) return;
      revealed = false;
      if (drawable.length < 2) { round = null; render(); return; }

      // Draw without replacement so the same stock does not come up twice
      // in a row while others are unused.
      let pool_ = drawable.filter((t) => !picked.has(t.security));
      if (!pool_.length) { picked.clear(); pool_ = drawable; }
      const entry = rng.pick(pool_);
      picked.add(entry.security);

      // Four plausible wrong answers: other real holdings.
      const others = rng.shuffle(trades.filter((t) => t.security !== entry.security))
        .slice(0, OPTIONS - 1);
      const options = rng.shuffle([entry, ...others]);
      round = { entry, options, answer: options.indexOf(entry) };

      rnd.open({
        prompt: 'Which stock is this?',
        labels: options.map((_, i) => String(i + 1)),
        key: `${rounds}|${entry.security}`,
      });
      render();
    }

    function onAnswers() {
      if (revealed || !round) return;
      if (rnd.complete) resolve(); else render();
    }

    function answer(i, code) {
      if (revealed || !round) return;
      const who = code || currentPlayer().code;
      if (!rnd.set(who, i)) return;
      if (rnd.complete) resolve(); else render();
    }

    function resolve() {
      if (revealed) return;
      revealed = true;
      rounds += 1;
      for (const [c, pick] of rnd.picks) {
        played += 1;
        if (pick === round.answer) { correct += 1; scores.set(c, (scores.get(c) || 0) + 1); }
      }
      const allRight = [...rnd.picks.values()].every((p) => p === round.answer);
      if (allRight) { streak += 1; best = Math.max(best, streak); } else streak = 0;
      turn += 1;
      render();
    }

    function factStrip() {
      const rows = solo
        ? [['Correct', `${correct}/${played}`], [soberMode ? 'Points' : 'Streak', String(streak)], ['Best', String(best)]]
        : [['Round', String(rounds + 1)], ['Correct', `${correct}/${played}`],
          [soberMode ? 'Points' : 'Streak', String(streak)], ['Best', String(best)]];
      return `<div class="game-facts">${rows.map(([k, v]) => `
        <div class="game-fact"><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}</div>`;
    }

    function playerRow() {
      if (solo) return '';
      const active = currentPlayer();
      return `<div class="game-players">${roster.map((p) => {
        const pick = rnd.valueFor(p.code);
        const isTurn = !revealed && p.code === active.code;
        const right = revealed && pick != null ? pick === round.answer : null;
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
          'Not enough stocks to guess between',
          'This needs a few holdings with enough price history to draw. Try a wider period.');
        return;
      }
      const e = round.entry;
      el.innerHTML = `
        <div class="guess">
          ${factStrip()}
          ${playerRow()}
          <p class="ooo-prompt">${revealed
            ? `It was <strong>${escapeHtml(e.security)}</strong>.`
            : 'Which stock is this? The chart is the only clue.'}</p>
          <div id="guess-chart" class="chart-wrap"></div>
          <div class="guess-options">
            ${round.options.map((o, i) => {
              const isAnswer = revealed && i === round.answer;
              const chosen = [...rnd.picks.values()].includes(i);
              return `<button type="button" class="guess-option${isAnswer ? ' is-answer' : ''}${revealed && chosen && !isAnswer ? ' is-wrong' : ''}"
                data-i="${i}" ${revealed ? 'disabled' : ''}>
                <span class="guess-num">${i + 1}</span>
                <span class="guess-name">${escapeHtml(o.security)}</span>
              </button>`;
            }).join('')}
          </div>
          <div id="guess-result"></div>
        </div>`;

      const s = seriesOf(e);
      const mountEl = el.querySelector('#guess-chart');
      if (mountEl && s.points.length >= 2) {
        mountEl.appendChild(window.Charts.priceChart({
          points: s.points, markers: revealed ? s.markers : [], yUnit: 'NOK',
        }));
      }
      el.querySelectorAll('.guess-option').forEach((b) => {
        b.addEventListener('click', () => answer(Number(b.getAttribute('data-i'))));
      });
      if (revealed) renderVerdict();
    }

    function renderVerdict() {
      const mountEl = el.querySelector('#guess-result');
      if (!mountEl) return;
      const e = round.entry;
      const rightOnes = roster.filter((p) => rnd.valueFor(p.code) === round.answer);
      const wrong = roster.filter((p) => rnd.valueFor(p.code) !== round.answer);
      const allRight = wrong.length === 0;
      const drink = soberMode
        ? (solo ? (allRight ? '+1 point' : 'no point') : `${rightOnes.length} point${rightOnes.length === 1 ? '' : 's'} awarded`)
        : (allRight ? (solo ? 'Nobody drinks' : 'Nobody drinks 🎉')
          : (solo ? 'Drink 🍺' : `${wrong.map((p) => escapeHtml(p.name)).join(', ')} drink${wrong.length === 1 ? 's' : ''} 🍺`));

      mountEl.innerHTML = `
        <div class="game-result ${allRight ? 'win' : 'loss'} ooo-verdict">
          <div class="verdict">${solo
            ? (allRight ? 'Correct 🎯' : 'Wrong 💀')
            : (allRight ? 'All correct 🎯' : `${rightOnes.length}/${roster.length} got it`)}</div>
          <div class="who-state">${escapeHtml(e.investorName)} · ${e.sold ? 'sold' : 'holding'}</div>
          <div class="pnl ${pctClass(e.pnlNok)}">${fmtNok(e.pnlNok)} · ${fmtPct(e.pnlPct, true)}</div>
          <div class="pnl">${drink}</div>
          <div style="margin-top:14px"><button class="btn game-spin" id="guess-next">Next stock</button></div>
        </div>`;
      mountEl.querySelector('#guess-next').addEventListener('click', newRound);
    }

    newRound();

    return {
      newRound,
      destroy() {
        dead = true;
        rnd.destroy();
        if (rounds > 0 && history) {
          history.add({
            gameId: 'guess-the-stock',
            competitionId: competitionId || '',
            players: roster.map((p) => p.name),
            summary: `${rounds} round${rounds === 1 ? '' : 's'} · ${correct}/${played} correct`,
            payload: { rounds, played, correct, best, sober: soberMode, scores: Object.fromEntries(scores) },
          });
        }
      },
    };
  }

  window.GameGuessTheStock = { mount };
})();
