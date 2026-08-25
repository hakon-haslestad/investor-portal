// One-per-session hydration of the Google Sheet into a plain JS object.
// Calculator, ledger, views read from this — no further async calls.
// The SPA hydrates once and navigates freely; refresh() re-fetches.

(function () {
  let cached = null;

  async function hydrate(opts = {}) {
    if (cached && !opts.force) return cached;
    const T = window.PORTAL_CONFIG.TABS;
    const tabs = [
      T.transactions, T.kpis, T.dimValues, T.members,
      T.securities, T.stockPrices,
      T.competitions, T.participants,
    ];
    if (T.holdings) tabs.push(T.holdings); // legacy fallback during migration

    let result;
    try {
      result = await window.Sheet.batchGet(tabs);
    } catch (err) {
      // batchGet fails entirely if any one tab doesn't exist yet (Securities
      // and StockPrices land in Phase 1). Fall back to per-tab fetches.
      result = {};
      await Promise.all(tabs.map(async (t) => {
        try { result[t] = await window.Sheet.getValues(t); }
        catch (_e) { result[t] = []; }
      }));
    }

    const securitiesList = window.Securities.parseSecurities(result[T.securities] || []);
    const registry = window.Securities.buildRegistry(securitiesList);
    window.Portfolio._setRegistry(registry);

    const dim = window.Parsers.parseDimValues(result[T.dimValues] || []);
    const attributionMap = new Map();
    for (const a of dim.attributions) {
      if (!attributionMap.has(a.security)) attributionMap.set(a.security, []);
      attributionMap.get(a.security).push({ code: a.investorCode, weight: a.weight });
    }

    cached = {
      transactions: window.Parsers.parseTransactions(result[T.transactions] || []),
      holdings: T.holdings ? window.Parsers.parseHoldings(result[T.holdings] || []) : [],
      kpis: window.Parsers.parseKpis(result[T.kpis] || []),
      attributions: dim.attributions,
      meta: dim.meta,
      attributionMap,
      members: window.Parsers.parseMembers(result[T.members] || []),
      securities: securitiesList,
      registry,
      prices: window.Prices.build(result[T.stockPrices] || []),
      competitionsRaw: result[T.competitions] || [],
      participantsRaw: result[T.participants] || [],
      raw: result,
    };
    return cached;
  }

  function clear() { cached = null; }

  async function refresh() {
    clear();
    return hydrate({ force: true });
  }

  // Look up the current signed-in member's profile from the Members tab.
  function whoami(store) {
    const email = (window.Auth.getEmail() || '').toLowerCase();
    if (!email) return null;
    return store.members.find((m) => m.email === email) || null;
  }

  window.Store = { hydrate, clear, refresh, whoami };
})();
