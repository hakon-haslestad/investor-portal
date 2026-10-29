// Portfolio commentary copy bank. Single source of truth for tone:
// measured, dry, with a touch of sass. NAMES is built at runtime from
// the Members tab — the empty object below is just the fallback shape.

(function () {
  const NAMES = {};

  // `b` is the basis, already spaced (" of budget") or empty.
  const verdictPhrases = {
    bigWinner: (name, pct, b = '') => `${name} firing — +${pct}%${b}. Take a bow.`,
    modestWin: (name, pct, b = '') => `${name} +${pct}%${b}. Quietly compounding.`,
    flat: (name) => `${name} flat. Either patience pays or the thesis cracks.`,
    modestLoss: (name, pct, b = '') => `${name} −${pct}%${b}. Goes with the territory.`,
    bigLoss: (name, pct, b = '') => `${name} −${pct}%${b}. Time for an honest re-read.`,
  };

  // Bands are for % of invested (portfolio return) unless a basis label is
  // passed: a competition % of budget is a much smaller number, so its bands
  // are tighter and the label rides along with the figure.
  function verdictFromReturn(name, pct, basis) {
    const p = Number(pct);
    if (!Number.isFinite(p)) return `${name}: TBD`;
    const [big, win, loss, bigLoss] = basis === 'of budget' ? [10, 1, -1, -5] : [50, 5, -5, -20];
    const b = basis ? ` ${basis}` : '';
    if (p >= big) return verdictPhrases.bigWinner(name, window.Fmt.fmtDec(p, 1), b);
    if (p >= win) return verdictPhrases.modestWin(name, window.Fmt.fmtDec(p, 1), b);
    if (p > loss) return verdictPhrases.flat(name);
    if (p > bigLoss) return verdictPhrases.modestLoss(name, window.Fmt.fmtDec(Math.abs(p), 1), b);
    return verdictPhrases.bigLoss(name, window.Fmt.fmtDec(Math.abs(p), 1), b);
  }

  // Build a NAMES map from store members (preferred over the fallback above).
  function namesFromMembers(members) {
    const out = { ...NAMES };
    for (const m of members || []) {
      if (m.investorCode && m.displayName) out[m.investorCode] = m.displayName;
    }
    return out;
  }

  window.Copy = { NAMES, verdictPhrases, verdictFromReturn, namesFromMembers };
})();
