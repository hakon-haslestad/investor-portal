// Shared number/HTML formatters. Ported from public/js/api.js.

(function () {
  // The one number rule: decimal comma, a true minus (U+2212), never "-0,0".
  // Thousands grouping comes from nb-NO. `sign` puts a + on positive numbers.
  function fmtDec(n, digits = 1, sign = false) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    const v = Number(n);
    let t = v.toFixed(digits);
    if (Number(t) === 0) return (0).toFixed(digits).replace('.', ',');
    const neg = t[0] === '-';
    if (neg) t = t.slice(1);
    const [int, frac] = t.split('.');
    const grp = Number(int).toLocaleString('nb-NO');
    return (neg ? '\u2212' : sign ? '+' : '') + grp + (frac ? ',' + frac : '');
  }
  function fmtNok(n) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    return fmtDec(Math.round(Number(n)), 0) + ' kr';
  }
  // A price without the currency: 1 234.
  function fmtPrice(n) {
    return fmtDec(n, 0);
  }
  // Chart month label, "Jan 25". English like the hover dates; fixed table, UTC, no ICU.
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtMonth(d) {
    return MON[d.getUTCMonth()] + ' ' + String(d.getUTCFullYear() % 100).padStart(2, '0');
  }
  // Condensed money for narrow screens: 412 300 kr → 412k. Used by the
  // always-visible (p1) columns of wide tables, which have to fit a phone.
  // `from` is where k starts (chart axes pass 1000: 5k, not 5 000).
  function fmtNokShort(n, from = 10_000) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    const v = Number(n);
    const a = Math.abs(v);
    if (a < from) return fmtDec(Math.round(v), 0);
    if (a < 1_000_000) return fmtDec(v / 1000, 0) + 'k';
    return fmtDec(v / 1_000_000, a < 10_000_000 ? 1 : 0) + 'M';
  }
  // True while the viewport is too narrow for full-length money strings.
  function isNarrow() {
    return typeof window.matchMedia === 'function'
      && window.matchMedia('(max-width: 599px)').matches;
  }
  // fmtNok that condenses itself on a phone.
  function fmtNokFit(n) {
    return isNarrow() ? fmtNokShort(n) : fmtNok(n);
  }

  function fmtPct(n, sign = true) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    return fmtDec(n, 1, sign) + '%'; // a tiny loss reads 0,0%, never −0,0%
  }
  // The one wording for what a competition % is measured against, so every
  // slide and view that shows a return says the same thing.
  function pctBasisLabel(pctBase) {
    return pctBase === 'invested' ? 'of invested' : 'of budget';
  }
  // A full tie: two or more teams on exactly the same return. Nobody won, so
  // no winner, last-place or medal marks.
  function isTie(units) {
    return units.length > 1 && units.every((u) => Math.abs(u.pct - units[0].pct) < 1e-9);
  }
  // What a scored competition says about the club and about who won, in one
  // place for the Competitions view and the deck. The club % is always on the
  // sum of the team budgets; a team without a budget (old competitions) is
  // left out and counted in `leftOut`. With no budget anywhere it falls back
  // to net invested.
  function competitionOutcome(scored) {
    const ranks = scored.ranks || [];
    const teams = scored.teams || [];
    const noActivity = ranks.every((r) => (r.grossBought || 0) === 0);
    const tie = isTie(teams.length ? teams : ranks);
    const budgeted = teams.filter((t) => (t.buyIn || 0) > 0);
    const sum = (list, fn) => list.reduce((a, x) => a + (fn(x) || 0), 0);
    let club;
    if (budgeted.length) {
      const base = sum(budgeted, (t) => t.buyIn);
      const pnl = sum(budgeted, (t) => t.netPnl);
      club = { pnl, base, pct: (pnl / base) * 100, pctBase: 'buyIn', basis: 'of total budget', leftOut: teams.length - budgeted.length };
    } else {
      const base = sum(ranks, (r) => r.amountSpent);
      const pnl = sum(ranks, (r) => r.netPnl);
      club = { pnl, base, pct: base > 0 ? (pnl / base) * 100 : 0, pctBase: 'invested', basis: 'of net invested', leftOut: 0 };
    }
    return { noActivity, tie, noContest: noActivity || tie, club };
  }
  // The one sentence for "nobody won", shared by the Competitions view and the deck.
  function noWinnerText(outcome) {
    return outcome.noActivity ? 'No purchases in the window yet.' : 'All teams are level - no winner.';
  }
  function fmtQty(n) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    const v = Number(n);
    if (Math.abs(v) < 1) return v.toLocaleString('nb-NO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return v.toLocaleString('nb-NO', { maximumFractionDigits: 2 });
  }
  function pctClass(n) {
    if (n == null || !Number.isFinite(Number(n))) return 'text-muted';
    const v = Number(n);
    if (v > 0.5) return 'positive';
    if (v < -0.5) return 'negative';
    return 'text-muted';
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const PODIUM = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];

  window.Fmt = { fmtDec, fmtPrice, fmtMonth, fmtNok, fmtNokShort, fmtNokFit, isNarrow, fmtPct, pctBasisLabel, isTie, competitionOutcome, noWinnerText, fmtQty, pctClass, escapeHtml, PODIUM };
})();
