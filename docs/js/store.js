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

    let result;
    try {
      result = await window.Sheet.batchGet(tabs);
    } catch (err) {
      // batchGet fails entirely if any one tab doesn't exist yet (Securities
      // and StockPrices land in Phase 1). Fall back to per-tab fetches — but
      // only to paper over MISSING tabs. If the core tabs fail too, this is
      // a real API/auth error: rethrow it instead of hydrating an empty
      // store (which would masquerade as "you're not in the Members tab").
      result = {};
      await Promise.all(tabs.map(async (t) => {
        try { result[t] = await window.Sheet.getValues(t); }
        catch (_e) { result[t] = null; }
      }));
      if (result[T.transactions] == null && result[T.members] == null) throw err;
      for (const t of tabs) if (result[t] == null) result[t] = [];
    }

    const securitiesList = window.Securities.parseSecurities(result[T.securities] || []);
    const registry = window.Securities.buildRegistry(securitiesList);
    window.Portfolio._setRegistry(registry);

    const transactions = window.Parsers.parseTransactions(result[T.transactions] || []);
    // Nordnet exports carry ISINs but no tickers, and names drift across
    // eras — teach the registry any name variant whose ISIN it knows, so
    // every replay joins on one canonical security.
    for (const tx of transactions) {
      if (!tx.security || !tx.isin) continue;
      if (registry.forName(tx.security)) continue;
      const byIsin = registry.forIsin(tx.isin);
      if (byIsin) registry.learnAlias(tx.security, byIsin);
    }

    const dim = window.Parsers.parseDimValues(result[T.dimValues] || []);
    const attributionMap = new Map();
    for (const a of dim.attributions) {
      if (!attributionMap.has(a.security)) attributionMap.set(a.security, []);
      attributionMap.get(a.security).push({ code: a.investorCode, weight: a.weight });
    }

    cached = {
      transactions,
      kpis: window.Parsers.parseKpis(result[T.kpis] || []),
      attributions: dim.attributions,
      meta: dim.meta,
      attributionMap,
      members: window.Parsers.parseMembers(result[T.members] || []),
      securities: securitiesList,
      registry,
      prices: buildPricesWithTradeFallback(result[T.stockPrices] || [], transactions, registry),
      competitionsRaw: result[T.competitions] || [],
      participantsRaw: result[T.participants] || [],
      raw: result,
    };
    return cached;
  }

  // Build the price matrix, then synthesize own-trade NOK series
  // ('TX:<name>') for securities with no market data — delisted or bankrupt
  // names Yahoo no longer serves. Points = |NOK amount| ÷ shares on actual
  // KJØPT / realizing-sell rows. Historical valuation only.
  function buildPricesWithTradeFallback(rows, transactions, registry) {
    const matrix = window.Prices.build(rows);
    const { classify, isRealizingSell, amountNok } = window.Ledger;
    const byName = new Map();
    for (const tx of transactions) {
      if (!tx.security || !tx.qty) continue;
      const cat = classify(tx.type);
      if (!(tx.type === 'KJØPT' || (cat === 'SELL' && isRealizingSell(tx.type)))) continue;
      const sec = registry.forName(tx.security);
      if (!sec) continue;
      if (sec.ticker && matrix.series.has(sec.ticker)) continue; // market data exists
      const date = tx.tradeDate || tx.bookDate;
      const qty = Math.abs(tx.qty);
      const amt = Math.abs(amountNok(tx));
      if (!date || !(qty > 0) || !(amt > 0)) continue;
      if (!byName.has(sec.name)) byName.set(sec.name, new Map());
      byName.get(sec.name).set(date, { d: date, v: amt / qty });
    }
    for (const [name, pts] of byName.entries()) {
      matrix.series.set('TX:' + name, [...pts.values()].sort((a, b) => a.d.localeCompare(b.d)));
    }
    return matrix;
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
