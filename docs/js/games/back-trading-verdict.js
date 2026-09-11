// Back Trading — was selling a good decision? Pure verdict logic: no DOM, no
// globals. Everything here is driven by an exit (date, price, quantity) and a
// price series, so it is fully unit-testable.
//
// THE DATA PROBLEM, and why this module is shaped the way it is.
// The brief assumed "daily closes for one year after the exit date". The feed
// does not do that: apps-script/Code.gs keeps a sold stock for
// SOLD_TAIL_DAYS = 183 (~6 months) and fetches it only WEEKLY, then marks it
// 'expired' and stops. So:
//   * the 250-day horizon is usually absent, and
//   * a "5 trading days after exit" lookup can land on a close up to a week
//     old, because Prices.valueOn forward-fills without saying so.
// Horizon availability is therefore a first-class result, never assumed, and
// a resolution that had to reach back is flagged `stale` rather than passed
// off as exact. Raising SOLD_TAIL_DAYS and re-running backfill() fills the
// history in retroactively; this module then reports more horizons on its
// own, with no code change.

(function () {
  const HORIZONS = [5, 20, 60, 120, 250];
  // No trading calendar in the browser, and the series may be weekly, so a
  // horizon's target date is approximated from calendar days. The resolved
  // date is always reported, so nothing is hidden behind the approximation.
  const CALENDAR_PER_TRADING_DAY = 7 / 5;
  // How far back a resolution may reach before we call it stale, and before
  // we treat the data as having run out entirely.
  const STALE_AFTER_DAYS = 3;
  const GIVE_UP_AFTER_DAYS = 10;
  // A close this far from the exit price is more likely a split than a move.
  const SPLIT_SUSPICION = 3;

  const DAY = 86400000;
  const addDays = (iso, n) => new Date(Date.parse(iso) + n * DAY).toISOString().slice(0, 10);
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

  function verdictOf(afterReturn) {
    if (afterReturn < -0.02) return 'good-sell';
    if (afterReturn > 0.02) return 'too-early';
    return 'neutral';
  }

  const VERDICT_LABEL = {
    'good-sell': 'Good sell',
    neutral: 'Neutral',
    'too-early': 'Sold too early',
  };

  // Last point on or before `date`, but strictly after the exit.
  function resolveAt(points, date, exitDate) {
    let best = null;
    for (const p of points) {
      if (p.date <= exitDate) continue;
      if (p.date > date) break;
      best = p;
    }
    return best;
  }

  // trade: { exitDate, exitPrice, qty }
  // series: [{ date, price }] ascending, NOK closes
  function verdictFor(trade, series, todayStr) {
    const today = todayStr || new Date().toISOString().slice(0, 10);
    const points = (series || []).filter((p) => p && p.date && Number.isFinite(p.price));
    const out = {
      horizons: [], overall: null, overallDays: null, latest: null, pointsAfter: 0,
      maxAfter: null, minAfter: null,
      missedMoney: null, moneySaved: null, oneYear: null,
      flags: [], coverageTo: null,
    };
    if (!trade || !trade.exitDate || !Number.isFinite(trade.exitPrice) || trade.exitPrice <= 0) {
      out.flags.push('no-exit-price');
      return out;
    }
    const after = points.filter((p) => p.date > trade.exitDate);
    if (!after.length) {
      out.flags.push('no-data-after-exit');
      return out;
    }
    out.coverageTo = after[after.length - 1].date;
    out.pointsAfter = after.length;

    for (const days of HORIZONS) {
      const target = addDays(trade.exitDate, Math.round(days * CALENDAR_PER_TRADING_DAY));
      // Reaches into the future — not a gap in the data, just not yet knowable.
      if (target > today) continue;
      const hit = resolveAt(after, target, trade.exitDate);
      if (!hit) continue;
      const gap = daysBetween(hit.date, target);
      // The data ran out well before this horizon; reporting it would be a
      // guess dressed up as a measurement.
      if (gap > GIVE_UP_AFTER_DAYS) continue;
      const afterReturn = hit.price / trade.exitPrice - 1;
      out.horizons.push({
        days, date: hit.date, targetDate: target, close: hit.price,
        afterReturn, verdict: verdictOf(afterReturn),
        stale: gap > STALE_AFTER_DAYS, staleByDays: gap,
      });
    }

    // The most recent close we actually have after the exit. This is what the
    // headline verdict uses: "has it gone up since you sold?" is the question
    // players are really asking, and it works for every trade rather than only
    // those old enough to have a 60-day horizon.
    const last = after[after.length - 1];
    out.latest = {
      date: last.date,
      close: last.price,
      afterReturn: last.price / trade.exitPrice - 1,
      verdict: verdictOf(last.price / trade.exitPrice - 1),
      daysAfter: daysBetween(trade.exitDate, last.date),
    };
    out.overall = out.latest.verdict;
    out.overallDays = out.latest.daysAfter;

    if (!out.horizons.length) {
      // Still judgeable from the latest close, just with no horizon strip.
      out.flags.push('no-horizon-resolved');
    }

    // Best and worst the price got, across every close we have after the exit.
    let hi = after[0], lo = after[0];
    for (const p of after) {
      if (p.price > hi.price) hi = p;
      if (p.price < lo.price) lo = p;
    }
    out.maxAfter = { value: hi.price / trade.exitPrice - 1, date: hi.date, close: hi.price };
    out.minAfter = { value: lo.price / trade.exitPrice - 1, date: lo.date, close: lo.price };

    const qty = Number.isFinite(trade.qty) ? Math.abs(trade.qty) : 0;
    const notional = qty * trade.exitPrice;
    out.missedMoney = out.maxAfter.value > 0 ? out.maxAfter.value * notional : 0;
    out.moneySaved = out.minAfter.value < 0 ? Math.abs(out.minAfter.value) * notional : 0;

    const yr = out.horizons.find((h) => h.days === 250);
    if (yr) out.oneYear = { pct: yr.afterReturn * 100, money: yr.afterReturn * notional, date: yr.date };

    // TODO: the price service exposes no split-adjustment flag, so this is
    // detection only — a suspicious ratio is surfaced, never silently fixed.
    const wild = out.horizons.some((h) =>
      h.close / trade.exitPrice > SPLIT_SUSPICION || trade.exitPrice / h.close > SPLIT_SUSPICION);
    if (wild) out.flags.push('possible-split');
    if (out.horizons.some((h) => h.stale)) out.flags.push('stale-resolution');

    return out;
  }

  // Did the player call it right? Neutral counts for either answer.
  function scoreAnswer(wouldHold, overall) {
    if (overall === 'neutral') return true;
    return wouldHold ? overall === 'too-early' : overall === 'good-sell';
  }

  // Is there enough post-exit data to judge this sell at all? The 5-day wait
  // is necessary but not sufficient: a stock whose feed expired, or that was
  // never priced, has no closes after the exit and cannot be judged however
  // long ago it was sold. Those are excluded rather than shown unjudgeable.
  const MIN_POINTS_AFTER = 2;
  function isJudgeable(result) {
    return !!(result && result.latest && result.pointsAfter >= MIN_POINTS_AFTER);
  }

  // How many trading days until a trade becomes playable (needs 5 after exit).
  function daysUntilPlayable(exitDate, todayStr) {
    const today = todayStr || new Date().toISOString().slice(0, 10);
    const need = addDays(exitDate, Math.round(5 * CALENDAR_PER_TRADING_DAY));
    const left = daysBetween(today, need);
    return left > 0 ? left : 0;
  }

  window.BackTradingVerdict = {
    HORIZONS, verdictFor, verdictOf, scoreAnswer, daysUntilPlayable, isJudgeable,
    MIN_POINTS_AFTER,
    VERDICT_LABEL, STALE_AFTER_DAYS, GIVE_UP_AFTER_DAYS, CALENDAR_PER_TRADING_DAY,
  };
})();
