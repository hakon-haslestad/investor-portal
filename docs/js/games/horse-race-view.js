// The race itself: track, runners, timeline, commentary and the animation
// loop. Lifted out of games/horse-race.js so the competition deck can run the
// same race without dragging in the games shell.
//
// Depends only on Fmt, HorseRaceEngine and the DOM — no UI, no pool, no
// registry. That independence is what lets presentation.html load it.
//
//   HorseRaceView.create(el, {
//     race,        // HorseRaceEngine.buildRace(...) output
//     duration,    // ms
//     autoStart,   // false leaves them under starter's orders
//     rng, audio, onFinish, onEvent,
//   }) -> { start, pause, skip, destroy, isRunning, isFinished }
//
// Lanes are labelled, never tickered: the game passes ticker/player, the deck
// passes investor code/name, and this file does not care which.

(function () {
  const { fmtPct, escapeHtml } = window.Fmt;
  const E = () => window.HorseRaceEngine;
  const NS = 'http://www.w3.org/2000/svg';

  const LANE_H = 54;
  const VIEW_W = 1000;
  // The name gutter is off the track entirely: the runners live to the right
  // of NAME_W, so a negative return has somewhere to go without covering the
  // label that says whose it is.
  const NAME_W = 150;
  const LEFT_X = NAME_W + 24;   // hard left stop for a runner
  const START_X = 300;          // the start line, with room to fall back to
  const RIGHT_X = 960;
  const FILLER_EVERY_MS = 6500;

  function svgEl(name, attrs) {
    const el = document.createElementNS(NS, name);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  function reducedMotion() {
    return typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function create(el, opts) {
    const race = opts.race;
    const duration = opts.duration || 60000;
    const rng = opts.rng || { pick: (a) => a[Math.floor(Math.random() * a.length)] };
    const audio = opts.audio || null;
    let dead = false;
    let raf = null;
    let paused = false;
    let started = false;
    let finished = false;
    let t0 = 0, pausedAt = 0, offset = 0;

    const h = race.lanes.length * LANE_H + 50;
    // Lanes are indexed by step, so the animation already assumes the points
    // line up across runners. The timeline shows lane 0's dates on that same
    // basis, trimmed to the shortest lane.
    const dates = (race.lanes[0].dates || []).slice(0, race.steps);
    const ticks = dates.map((d, i) => {
      const pct = dates.length > 1 ? (i / (dates.length - 1)) * 100 : 0;
      return `<span class="hr-tl-tick" style="left:${pct.toFixed(2)}%" title="${escapeHtml(String(d))}"></span>`;
    }).join('');

    el.innerHTML = `
      <div class="hr-race">
        <div class="hr-commentary" id="hr-say" role="status" aria-live="polite">They're under starter's orders…</div>
        <div class="hr-track-wrap">
          <svg id="hr-svg" viewBox="0 0 ${VIEW_W} ${h}" role="img" aria-label="Race track"></svg>
        </div>
        <div class="hr-timeline">
          <div class="hr-tl-track">
            <div class="hr-tl-fill" id="hr-tl-fill"></div>
            ${ticks}
            <div class="hr-tl-head" id="hr-tl-head"></div>
          </div>
          <div class="hr-tl-labels">
            <span class="hr-tl-end">${escapeHtml(String(dates[0] || ''))}</span>
            <span class="hr-tl-now" id="hr-tl-now">${escapeHtml(String(dates[0] || ''))}</span>
            <span class="hr-tl-end">${escapeHtml(String(dates[dates.length - 1] || ''))}</span>
          </div>
        </div>
        <div class="hr-controls">
          <button class="btn game-spin" id="hr-go"${opts.autoStart ? ' hidden' : ''}>🏁 They're off</button>
          <button class="btn ghost small" id="hr-pause"${opts.autoStart ? '' : ' hidden'}>Pause</button>
          <button class="btn ghost small" id="hr-skip"${opts.autoStart ? '' : ' hidden'}>Skip to finish</button>
          ${audio ? `<button class="btn ghost small" id="hr-mute" aria-pressed="${audio.isMuted()}">${audio.isMuted() ? '🔇 Sound off' : '🔊 Sound on'}</button>` : ''}
        </div>
      </div>`;

    const svg = el.querySelector('#hr-svg');
    const say = el.querySelector('#hr-say');
    const fill = el.querySelector('#hr-tl-fill');
    const head = el.querySelector('#hr-tl-head');
    const now = el.querySelector('#hr-tl-now');
    const goBtn = el.querySelector('#hr-go');
    const pauseBtn = el.querySelector('#hr-pause');
    const skipBtn = el.querySelector('#hr-skip');
    const muteBtn = el.querySelector('#hr-mute');

    race.lanes.forEach((l, i) => {
      const y = 30 + i * LANE_H;
      svg.appendChild(svgEl('rect', {
        x: NAME_W, y: y - 24, width: VIEW_W - NAME_W, height: LANE_H - 6,
        fill: i % 2 ? 'rgba(255,255,255,0.02)' : 'transparent',
      }));
      // Silk swatch + name, in the gutter, never overlapped by a runner.
      if (l.colour) {
        svg.appendChild(svgEl('rect', {
          x: 6, y: y - 8, width: 10, height: 16, rx: 3, fill: l.colour,
        }));
      }
      const label = svgEl('text', {
        x: l.colour ? 22 : 6, y: y + 5, fill: '#e7e9ee', 'font-size': '15', 'font-weight': '600',
      });
      label.textContent = l.label || '';
      svg.appendChild(label);
      if (l.sublabel) {
        const sub = svgEl('text', { x: l.colour ? 22 : 6, y: y + 20, fill: '#8a92a6', 'font-size': '11' });
        sub.textContent = l.sublabel;
        svg.appendChild(sub);
      }
    });
    svg.appendChild(svgEl('line', {
      x1: START_X, x2: START_X, y1: 10, y2: h - 10,
      stroke: '#3a3a3a', 'stroke-width': '2', 'stroke-dasharray': '4 4',
    }));

    const horses = race.lanes.map((l, i) => {
      const y = 30 + i * LANE_H;
      const g = svgEl('g', {});
      // A ring behind the runner, lit only for whoever is in front.
      const halo = svgEl('circle', {
        cx: START_X, cy: y, r: 17, fill: 'none', stroke: 'transparent', 'stroke-width': '2',
      });
      // The 🏇 glyph faces left in several fonts, so it is mirrored here with
      // a transform instead of being trusted to point the right way. The text
      // sits at the origin and the wrapper carries both position and flip.
      const horseG = svgEl('g', { transform: `translate(${START_X},${y + 9}) scale(-1,1)` });
      const horse = svgEl('text', { x: 0, y: 0, 'font-size': '26', 'text-anchor': 'middle' });
      horse.textContent = '🏇';
      horseG.appendChild(horse);
      const txt = svgEl('text', {
        x: START_X, y: y - 14, fill: '#e7e9ee', 'font-size': '12',
        'font-weight': '600', 'text-anchor': 'middle',
      });
      g.appendChild(halo); g.appendChild(horseG); g.appendChild(txt);
      svg.appendChild(g);
      return { lane: l, halo, horseG, txt, y, seed: 0.13 + i * 0.19 };
    });

    function setTime(t) {
      const pct = Math.max(0, Math.min(1, t)) * 100;
      if (fill) fill.style.width = pct.toFixed(2) + '%';
      if (head) head.style.left = pct.toFixed(2) + '%';
      if (now && dates.length) {
        const i = Math.round(Math.max(0, Math.min(1, t)) * (dates.length - 1));
        now.textContent = String(dates[i] || '');
      }
    }

    // The leader sits near the right edge throughout, so the scale expands as
    // the race opens up — the camera following the leader — and it lands with
    // the best final position exactly at the right edge.
    function place(t) {
      const positions = horses.map((hh) => E().interpolate(hh.lane.positions, t, hh.seed));
      const maxPos = Math.max(1e-4, ...positions);
      const minPos = Math.min(0, ...positions);
      // Each side of the start line gets its own scale: the leader always runs
      // to the right edge, and the worst always falls back to the left one.
      // A single shared scale would squash the whole field whenever one person
      // was deeply under water, and a horse pinned to an edge says nothing
      // about how far ahead or behind it actually is.
      //
      // The track is therefore not linear across zero — but it is monotonic on
      // each side, so the ORDER is always honest, and every runner carries its
      // own percentage anyway.
      const posScale = (RIGHT_X - START_X) / maxPos;
      const negScale = minPos < 0 ? (START_X - LEFT_X) / Math.abs(minPos) : 0;
      positions.forEach((pos, i) => {
        const raw = START_X + pos * (pos >= 0 ? posScale : negScale);
        const x = Math.max(LEFT_X, Math.min(VIEW_W - 14, raw));
        const hh = horses[i];
        hh.halo.setAttribute('cx', x.toFixed(1));
        hh.horseG.setAttribute('transform', `translate(${x.toFixed(1)},${hh.y + 9}) scale(-1,1)`);
        hh.txt.setAttribute('x', x.toFixed(1));
        hh.txt.textContent = fmtPct(pos * 100, true);
        // The emoji cannot be recoloured, so the running total carries the
        // green/red instead.
        hh.txt.setAttribute('fill', pos >= 0 ? '#3ee07f' : '#ff7a7a');
      });
      const lead = positions.indexOf(Math.max(...positions));
      horses.forEach((hh, i) => hh.halo.setAttribute('stroke', i === lead ? '#ffc94f' : 'transparent'));
      setTime(t);
    }

    const seen = new Set();
    let lastFiller = 0;
    function fireEvents(step, elapsed) {
      for (const ev of race.events || []) {
        if (ev.step <= step && !seen.has(ev.step + ev.text)) {
          seen.add(ev.step + ev.text);
          say.textContent = ev.text;
          lastFiller = elapsed;
          if (opts.onEvent) opts.onEvent(ev);
          return;
        }
      }
      if (elapsed - lastFiller > FILLER_EVERY_MS) {
        lastFiller = elapsed;
        say.textContent = rng.pick(E().FILLER);
      }
    }

    function showControls(running) {
      if (goBtn) goBtn.hidden = running;
      if (pauseBtn) pauseBtn.hidden = !running;
      if (skipBtn) skipBtn.hidden = !running;
    }

    function finish() {
      if (finished) return;
      finished = true;
      place(1);
      if (audio) audio.stop();
      showControls(false);
      if (goBtn) goBtn.hidden = true;
      if (opts.onFinish) opts.onFinish(race);
    }

    const frame = (ts) => {
      if (dead || paused) return;
      const elapsed = ts - t0 - offset;
      const t = Math.min(1, elapsed / duration);
      place(t);
      fireEvents(Math.floor(t * ((race.steps || 2) - 1)), elapsed);
      if (t >= 1) { finish(); return; }
      raf = requestAnimationFrame(frame);
    };

    function start() {
      if (dead || started || finished) return;
      started = true;
      // Reduced motion: no animation, no sound — there is no race to score.
      if (reducedMotion()) {
        place(1);
        say.textContent = 'Race finished.';
        finish();
        return;
      }
      showControls(true);
      // Started HERE, inside the user gesture that started the race — audio
      // begun any other way is blocked by the browser.
      if (audio) audio.start();
      say.textContent = "And they're off!";
      t0 = performance.now();
      raf = requestAnimationFrame(frame);
    }

    function pause() {
      if (dead || !started || finished) return;
      paused = !paused;
      if (pauseBtn) pauseBtn.textContent = paused ? 'Resume' : 'Pause';
      if (audio) audio.suspend(paused);
      if (paused) { pausedAt = performance.now(); if (raf) cancelAnimationFrame(raf); }
      else { offset += performance.now() - pausedAt; raf = requestAnimationFrame(frame); }
    }

    function skip() {
      if (dead || finished) return;
      paused = true;
      if (raf) cancelAnimationFrame(raf);
      finish();
    }

    function toggleMute() {
      if (!audio) return;
      const next = !audio.isMuted();
      audio.mute(next);
      if (muteBtn) {
        muteBtn.textContent = next ? '🔇 Sound off' : '🔊 Sound on';
        muteBtn.setAttribute('aria-pressed', String(next));
      }
    }

    if (goBtn) goBtn.addEventListener('click', start);
    if (pauseBtn) pauseBtn.addEventListener('click', pause);
    if (skipBtn) skipBtn.addEventListener('click', skip);
    if (muteBtn) muteBtn.addEventListener('click', toggleMute);

    place(0);
    if (opts.autoStart) start();

    return {
      start, pause, skip, toggleMute,
      isRunning: () => started && !paused && !finished,
      isStarted: () => started,
      isPaused: () => paused,
      isFinished: () => finished,
      // Everything the race owns dies here: the frame loop AND the audio.
      // The deck rebuilds its DOM on every navigation without telling anyone,
      // so a loop or an oscillator left running would outlive its slide.
      destroy() {
        dead = true;
        if (raf) cancelAnimationFrame(raf);
        raf = null;
        if (audio) audio.stop();
      },
    };
  }

  window.HorseRaceView = { create, LANE_H, VIEW_W, START_X, RIGHT_X };
})();
