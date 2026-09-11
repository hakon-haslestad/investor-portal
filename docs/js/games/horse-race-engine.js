// Horse Race — pure race maths. No DOM: normalisation, odds, the commentary
// rules and the interpolation the animation plays back. All unit-testable.

(function () {
  // position(t) = close(t) / close(t0) - 1, as a fraction.
  function normalise(points) {
    if (!points || points.length < 2) return null;
    const base = points[0].price;
    if (!Number.isFinite(base) || base <= 0) return null;
    return points.map((p) => ({ date: p.date, pos: p.price / base - 1 }));
  }

  // Realised volatility: stdev of daily log returns over the given closes.
  function volatility(points) {
    if (!points || points.length < 3) return 0;
    const rets = [];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1].price, b = points[i].price;
      if (a > 0 && b > 0) rets.push(Math.log(b / a));
    }
    if (rets.length < 2) return 0;
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const varr = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
    return Math.sqrt(varr);
  }

  // Decimal odds, cosmetic only — they never affect the race. Higher
  // volatility means a longer price, the way a bookmaker would treat an
  // unpredictable runner.
  const ODDS_MIN = 1.2;
  const ODDS_MAX = 25;
  function oddsFor(vol) {
    const raw = 1.4 + (Number.isFinite(vol) ? vol : 0) * 60;
    return Math.round(Math.min(ODDS_MAX, Math.max(ODDS_MIN, raw)) * 10) / 10;
  }

  // Commentary thresholds, straight from the brief.
  const BREAKAWAY_PP = 3;      // gain in one step
  const PHOTO_FINISH_PP = 0.3; // gap between 1st and 2nd at the line

  function rankAt(lanes, step) {
    return lanes
      .map((l, i) => ({ i, ticker: l.ticker, pos: l.positions[Math.min(step, l.positions.length - 1)] }))
      .sort((a, b) => b.pos - a.pos);
  }

  // Events keyed by step, evaluated at each data point.
  function commentary(lanes) {
    if (!lanes || !lanes.length) return [];
    const steps = Math.min(...lanes.map((l) => l.positions.length));
    if (steps < 2) return [];
    const events = [];

    let leader = rankAt(lanes, 0)[0];
    // The single worst step of the race gets one "stumbles" call.
    let worst = { drop: 0, step: -1, ticker: null };

    for (let s = 1; s < steps; s++) {
      const ranked = rankAt(lanes, s);
      if (ranked[0].ticker !== leader.ticker) {
        events.push({ step: s, kind: 'lead', text: `${ranked[0].ticker} takes the lead` });
        leader = ranked[0];
      }
      for (const l of lanes) {
        const delta = (l.positions[s] - l.positions[s - 1]) * 100; // percentage points
        if (delta > BREAKAWAY_PP) {
          events.push({ step: s, kind: 'breakaway', text: `${l.ticker} breaks away` });
        }
        if (delta < worst.drop) worst = { drop: delta, step: s, ticker: l.ticker };
      }
    }

    if (worst.ticker && worst.drop < 0) {
      events.push({ step: worst.step, kind: 'stumble', text: `${worst.ticker} stumbles` });
    }

    const final = rankAt(lanes, steps - 1);
    if (final.length >= 2 && (final[0].pos - final[1].pos) * 100 < PHOTO_FINISH_PP) {
      events.push({ step: steps - 1, kind: 'photo', text: 'Photo finish!' });
    }

    return events.sort((a, b) => a.step - b.step);
  }

  const FILLER = [
    'They\'re off!',
    'Still anyone\'s race.',
    'The field is tightening.',
    'No change at the front.',
    'Plenty of track left.',
    'The crowd is on its feet.',
  ];

  // Duration: about a minute, so a race is something to watch and shout at
  // rather than something that is over before drinks are poured. Longer
  // windows get a little more time because they have more data to cross.
  function durationFor(windowDays) {
    return windowDays <= 5 ? 60000 : 75000;
  }

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  // Position of one lane at a fractional step. Jitter perturbs SPEED only: it
  // is scaled by sin(pi*t), which is zero at both ends, so every data point is
  // hit exactly and the final position is always the real return.
  function interpolate(positions, t, jitterSeed) {
    const n = positions.length;
    if (n === 0) return 0;
    if (n === 1) return positions[0];
    const clamped = Math.max(0, Math.min(1, t));
    const x = clamped * (n - 1);
    const i = Math.min(n - 2, Math.floor(x));
    const frac = x - i;
    let p = easeInOutCubic(frac);
    if (jitterSeed) {
      const wobble = Math.sin((i + 1) * jitterSeed * 12.9898) * 0.18;
      p = Math.max(0, Math.min(1, p + wobble * Math.sin(Math.PI * frac)));
    }
    return positions[i] + (positions[i + 1] - positions[i]) * p;
  }

  // Build the race from picked horses. Horses without usable data are
  // reported so the caller can exclude them BEFORE the race, never mid-race.
  // A runner supplies EITHER raw closes (`points`, normalised here) OR
  // positions that are already returns (`positions` + `dates`). The deck's
  // competition race is the second case: its numbers come out of the scoring
  // engine as return fractions, and encoding them back into fake prices just
  // so normalise() could undo it would be a trap for the next reader.
  function laneFrom(h) {
    if (Array.isArray(h.positions) && h.positions.length >= 2) {
      const dates = h.dates || h.positions.map((_, i) => String(i));
      return h.positions.map((pos, i) => ({ date: dates[i], pos }));
    }
    return normalise(h.points);
  }

  // A competition window often opens weeks before anyone actually buys
  // anything. Racing over that is dead air: every runner sits on the line
  // while the clock burns. Trim the flat opening so the whole duration goes
  // to the part where something happens.
  //
  // One flat step is kept, so the field is still seen standing at the line
  // before it moves. Nothing is trimmed if nobody ever moves.
  const FLAT_EPS = 1e-9;
  // Only a genuinely dead opening is worth cutting. Dropping one or two steps
  // buys no time and makes the timeline start on an odd date for no reason.
  const MIN_SKIP_STEPS = 2;
  function trimLeadingFlat(lanes) {
    if (!lanes.length) return { lanes, skipped: null };
    const steps = Math.min(...lanes.map((l) => l.positions.length));
    let firstMove = -1;
    for (let i = 0; i < steps; i++) {
      if (lanes.some((l) => Math.abs(l.positions[i]) > FLAT_EPS)) { firstMove = i; break; }
    }
    // Never moved at all, or moved straight away: nothing worth cutting.
    if (firstMove < 1) return { lanes, skipped: null };
    const start = firstMove - 1;
    if (start < MIN_SKIP_STEPS) return { lanes, skipped: null };
    const first = lanes[0];
    const skipped = {
      steps: start,
      fromDate: first.dates ? first.dates[0] : null,
      toDate: first.dates ? first.dates[start] : null,
    };
    return {
      lanes: lanes.map((l) => ({
        ...l,
        positions: l.positions.slice(start),
        dates: (l.dates || []).slice(start),
      })),
      skipped,
    };
  }

  function buildRace(horses, opts) {
    const lanes = [];
    const excluded = [];
    for (const h of horses || []) {
      const norm = laneFrom(h);
      if (!norm) { excluded.push({ ...h, reason: 'no price data for this window' }); continue; }
      lanes.push({
        ticker: h.ticker, name: h.name, player: h.player,
        // Deck lanes are labelled by investor; game lanes by ticker.
        label: h.label || h.ticker, sublabel: h.sublabel || h.player,
        colour: h.colour,
        odds: h.odds,
        positions: norm.map((p) => p.pos),
        dates: norm.map((p) => p.date),
        finalPos: norm[norm.length - 1].pos,
      });
    }
    if (lanes.length < 2) return { lanes, excluded, ok: false };
    // Trim before commentary, so event steps index the trimmed lanes.
    const trim = (opts && opts.trimLeadingFlat === false)
      ? { lanes, skipped: null }
      : trimLeadingFlat(lanes);
    const run = trim.lanes;
    return {
      lanes: run, excluded, ok: true, skipped: trim.skipped,
      steps: Math.min(...run.map((l) => l.positions.length)),
      events: commentary(run),
      ranking: run.slice().sort((a, b) => b.finalPos - a.finalPos),
    };
  }

  window.HorseRaceEngine = {
    normalise, volatility, oddsFor, commentary, rankAt, buildRace, laneFrom, trimLeadingFlat,
    MIN_SKIP_STEPS,
    durationFor, easeInOutCubic, interpolate,
    FILLER, BREAKAWAY_PP, PHOTO_FINISH_PP, ODDS_MIN, ODDS_MAX,
  };
})();
