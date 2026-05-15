// Casual investment-bro copy bank. Single source of truth for tone.
// Ported from src/copy.js. NAMES is also derived from the Members tab at
// runtime if present, but kept here as a fallback.

(function () {
  const NAMES = {
    HH: 'Haslestad',
    HS: 'Sundland',
    ØS: 'Stubberud',
    JC: 'Curran',
    HF: 'Førsund',
  };

  const verdictPhrases = {
    bigWinner: (name, pct) => `${name} ate. Up ${pct}%. Pure cooking.`,
    modestWin: (name, pct) => `${name} grinding — ${pct}% in the green`,
    flat: (name) => `${name} doing nothing. Neither winning nor losing. Just vibes.`,
    modestLoss: (name, pct) => `${name} down ${pct}%. It happens.`,
    bigLoss: (name, pct) => `${name} cooked. ${pct}% down. RIP. 💀`,
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

  // Build a NAMES map from store members (preferred over the hardcoded one).
  function namesFromMembers(members) {
    const out = { ...NAMES };
    for (const m of members || []) {
      if (m.investorCode && m.displayName) out[m.investorCode] = m.displayName;
    }
    return out;
  }

  window.Copy = { NAMES, verdictPhrases, verdictFromReturn, namesFromMembers };
})();
