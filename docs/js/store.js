// One-page-load hydration of the Google Sheet into a plain JS object.
// Calculator, ledger, etc. read from this — no further async calls.

(function () {
  let cached = null;

  async function hydrate(opts = {}) {
    if (cached && !opts.force) return cached;
    const T = window.GEYSIR_CONFIG.TABS;
    const tabs = [T.transactions, T.holdings, T.kpis, T.dimValues, T.members];
    if (opts.includeCompetitions) {
      tabs.push(T.competitions, T.participants, T.picks);
    }

    let result;
    try {
      result = await window.Sheet.batchGet(tabs);
    } catch (err) {
      // batchGet fails entirely if any one tab doesn't exist yet (Members,
      // Competitions). Fall back to per-tab fetches with tolerance.
      result = {};
      await Promise.all(tabs.map(async (t) => {
        try { result[t] = await window.Sheet.getValues(t); }
        catch (_e) { result[t] = []; }
      }));
    }

    const transactions = window.Parsers.parseTransactions(result[T.transactions] || []);
    const holdings = window.Parsers.parseHoldings(result[T.holdings] || []);
    const kpis = window.Parsers.parseKpis(result[T.kpis] || []);
    const dim = window.Parsers.parseDimValues(result[T.dimValues] || []);
    const members = window.Parsers.parseMembers(result[T.members] || []);

    const attributionMap = new Map();
    for (const a of dim.attributions) {
      if (!attributionMap.has(a.security)) attributionMap.set(a.security, []);
      attributionMap.get(a.security).push({ code: a.investorCode, weight: a.weight });
    }

    cached = {
      transactions,
      holdings,
      kpis,
      attributions: dim.attributions,
      meta: dim.meta,
      attributionMap,
      members,
      raw: result,
    };
    return cached;
  }

  function clear() { cached = null; }

  // Look up the current signed-in member's profile from the Members tab.
  function whoami(store) {
    const email = (window.Auth.getEmail() || '').toLowerCase();
    if (!email) return null;
    const hit = store.members.find((m) => m.email === email);
    return hit || null;
  }

  window.Store = { hydrate, clear, whoami };
})();
