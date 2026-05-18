// Portfolio commentary copy bank. Single source of truth for tone:
// measured, dry, with a touch of sass. NAMES is built at runtime from
// the Members tab — the empty object below is just the fallback shape.

(function () {
  const NAMES = {};

  const verdictPhrases = {
    bigWinner: (name, pct) => `${name} firing — +${pct}%. Take a bow.`,
    modestWin: (name, pct) => `${name} +${pct}%. Quietly compounding.`,
    flat: (name) => `${name} flat. Either patience pays or the thesis cracks.`,
    modestLoss: (name, pct) => `${name} −${pct}%. Goes with the territory.`,
    bigLoss: (name, pct) => `${name} −${pct}%. Time for an honest re-read.`,
  };

  function verdictFromReturn(name, pct) {
    const p = Number(pct);
    if (!Number.isFinite(p)) return `${name}: TBD`;
    if (p >= 50) return verdictPhrases.bigWinner(name, p.toFixed(1));
    if (p >= 5) return verdictPhrases.modestWin(name, p.toFixed(1));
    if (p > -5) return verdictPhrases.flat(name);
    if (p > -20) return verdictPhrases.modestLoss(name, Math.abs(p).toFixed(1));
    return verdictPhrases.bigLoss(name, Math.abs(p).toFixed(1));
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
