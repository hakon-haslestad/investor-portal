// Spin the stock — the original game. Draws a random real position, runs the
// slot-machine animation, then reveals whose it was and what it did.
//
// `guess: true` is the same draw with the name masked and the chart shown
// first, so the room can call it before the reveal.

(function () {
  const { fmtNok, fmtPct, escapeHtml, pctClass } = window.Fmt;

  function create(opts = {}) {
    const guessFirst = !!opts.guess;

    return {
      mount(el, props) {
        const { trades, pool, rng, soberMode } = props;
        let dead = false;
        // Draw without replacement until the pool is exhausted, then reset —
        // same behaviour the original had.
        const picked = new Set();
        let lastKey = null;

        el.innerHTML = `
          <div style="margin:18px 0">
            <button class="btn game-spin" id="spin">🎲 ${guessFirst ? 'Deal a mystery stock' : 'Spin'}</button>
          </div>
          <div id="game-mount"></div>`;

        const mountEl = () => el.querySelector('#game-mount');

        function draw() {
          if (!trades.length) return null;
          const keyOf = (e) => e.investor + '|' + e.security;
          let available = trades.filter((e) => !picked.has(keyOf(e)));
          if (!available.length) {
            picked.clear();
            available = trades.filter((e) => keyOf(e) !== lastKey);
            if (!available.length) available = trades;
          }
          const pick = rng.pick(available);
          const key = keyOf(pick);
          picked.add(key);
          lastKey = key;
          return pick;
        }

        function renderResult(entry, o = {}) {
          const mount = mountEl();
          if (dead || !mount) return;
          if (!entry) {
            mount.innerHTML = window.UI.emptyState('No positions in this selection',
              'Try <strong>All time</strong> or pick another competition.');
            return;
          }
          const cls = entry.win ? 'win' : 'loss';
          const verdict = soberMode
            ? (entry.win ? 'Winner 🎉' : 'Loser 📉')
            : (entry.win ? 'Hand out a shot 🥃' : 'Take a shot 🥃');
          const valueLabel = entry.sold ? 'Sold for' : "Today's value";
          const series = pool.priceSeriesForSecurity(
            entry.security, (entry.investors || []).map((x) => x.code), entry.from, entry.to);
          const note = o.note ? `<div class="guess-note">${escapeHtml(o.note)}</div>` : '';

          mount.innerHTML = `
            <div class="game-result ${cls}">
              ${note}
              <div class="verdict">${escapeHtml(verdict)}</div>
              <div class="who"><span class="who-name">${escapeHtml(entry.investorName)}</span></div>
              <div class="stock">${escapeHtml(entry.security)} <span class="who-state">· ${entry.sold ? 'sold' : 'holding'}</span></div>
              <div class="pnl ${pctClass(entry.pnlNok)}">${fmtNok(entry.pnlNok)} · ${fmtPct(entry.pnlPct, true)}</div>
              <div class="detail-grid">
                <div class="kpi-card"><div class="label">Put in</div><div class="value">${fmtNok(entry.purchaseAmount)}</div></div>
                <div class="kpi-card"><div class="label">${escapeHtml(valueLabel)}</div><div class="value">${fmtNok(entry.currentOrSoldValue)}</div></div>
                <div class="kpi-card"><div class="label">Held</div><div class="value">${escapeHtml(pool.holdingText(entry))}</div></div>
              </div>
              <div id="game-chart"></div>
            </div>`;
          if (pool.chartable(series)) {
            mount.querySelector('#game-chart').appendChild(window.Charts.priceChart({
              points: series.points, markers: series.markers, yUnit: 'NOK', invested: entry.purchaseAmount,
            }));
          }
        }

        function renderGuess(entry) {
          const mount = mountEl();
          if (dead || !mount) return;
          const series = pool.priceSeriesForSecurity(
            entry.security, (entry.investors || []).map((x) => x.code), entry.from, entry.to);
          mount.innerHTML = `
            <div class="game-result guess">
              <div class="guess-prompt">Guess the stock 🤔</div>
              <div class="who-state">Whose is it? Up or down? Call it before the reveal.</div>
              <div id="game-chart"></div>
              <div style="margin-top:16px"><button class="btn game-spin" id="reveal">Reveal 👀</button></div>
            </div>`;
          mount.querySelector('#game-chart').appendChild(window.Charts.priceChart({
            points: series.points, markers: series.markers, yUnit: 'NOK',
          }));
          mount.querySelector('#reveal').addEventListener('click', () => renderResult(entry));
        }

        function doSpin() {
          if (!trades.length) { renderResult(null); return; }
          const final = draw();
          const mount = mountEl();
          if (!mount) return;
          const btn = el.querySelector('#spin');
          if (btn) btn.disabled = true;

          mount.innerHTML = `
            <div class="game-result spinning">
              <div class="verdict"><span class="spin-dice">🎲</span></div>
              <div class="who"><span class="who-name" id="spin-name">${guessFirst ? 'Mystery stock' : ''}</span></div>
              <div class="stock" id="spin-stock"></div>
            </div>`;
          const nameEl = guessFirst ? null : mount.querySelector('#spin-name');
          const stockEl = mount.querySelector('#spin-stock');
          const mask = (s) => '▓'.repeat(Math.max(3, Math.min(10, (s || '').length)));

          const finish = () => {
            if (dead || !mountEl()) return;
            if (btn) btn.disabled = false;
            if (!guessFirst) { renderResult(final); return; }
            const series = pool.priceSeriesForSecurity(
              final.security, (final.investors || []).map((x) => x.code), final.from, final.to);
            if (pool.chartable(series)) renderGuess(final);
            else renderResult(final, { note: "Not enough price history to guess — here's the answer." });
          };

          const delays = [55, 55, 60, 70, 85, 105, 130, 160, 195, 235, 280, 330];
          let i = 0;
          const tick = () => {
            if (dead || !mountEl()) return; // view unmounted mid-spin
            const rnd = rng.pick(trades);
            if (nameEl) nameEl.textContent = rnd.investorName;
            if (stockEl) stockEl.textContent = guessFirst ? mask(rnd.security) : rnd.security;
            if (i >= delays.length) { finish(); return; }
            setTimeout(tick, delays[i++]);
          };
          tick();
        }

        el.querySelector('#spin').addEventListener('click', doSpin);

        return {
          newRound: doSpin,
          destroy() { dead = true; },
        };
      },
    };
  }

  window.GameSpinTheStock = create;
})();
