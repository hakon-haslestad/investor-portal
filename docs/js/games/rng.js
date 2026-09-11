// Seedable RNG for the games. Every game draws from this rather than
// Math.random, so a round can be reproduced from its seed — which is what
// makes the rule/verdict logic testable.

(function () {
  // mulberry32 — small, fast, good enough for shuffling a stock list.
  function rng(seed) {
    let a = (seed >>> 0) || 1;
    const next = () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
      next,                                   // [0, 1)
      int: (n) => Math.floor(next() * n),     // [0, n)
      pick: (arr) => (arr.length ? arr[Math.floor(next() * arr.length)] : null),
      // Fisher-Yates on a copy — callers never expect their array mutated.
      shuffle: (arr) => {
        const a2 = arr.slice();
        for (let i = a2.length - 1; i > 0; i--) {
          const j = Math.floor(next() * (i + 1));
          [a2[i], a2[j]] = [a2[j], a2[i]];
        }
        return a2;
      },
    };
  }

  // A seed for "just play" — callers that want reproducibility pass their own.
  rng.randomSeed = () => (Date.now() ^ Math.floor(Math.random() * 0xFFFFFFFF)) >>> 0;

  window.GameRng = rng;
})();
