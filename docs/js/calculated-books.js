// The calculated books (one sheet): every year's ledger and trial balance
// worked out from the portfolio sheet's raw data (DNB_raw, Rådata fra
// nordnet, StockPrices, Accounting inputs). Shared by the Accounting tab and
// the Board, so both show the same figures. Read-only.

(function () {
  // From the first year in DNB_raw (IB rows) to the last year with data, each
  // year opening with the year before's close. The 31.12 price is the last
  // trading-day close (Portfolio.yearEndPrice) unless a PRICE row gives one.
  function calculate({ dnb, aliases, transactions, inputs, store }) {
    const out = new Map();
    if (!window.Books || !window.Books.calculatedYears || !(dnb || []).length) return out;
    const dnbYears = dnb.map((r) => r.year).filter(Number.isInteger);
    const txYears = (transactions || []).map((t) => Number(String(t.bookDate || t.tradeDate || '').slice(0, 4))).filter(Number.isInteger);
    const firstYear = Math.min(...dnbYears);
    const lastYear = Math.max(...dnbYears, ...txYears);
    const prices = (y) => {
      const P = window.Portfolio;
      return (security, isin) => (P && P.yearEndPrice ? P.yearEndPrice(store, security, isin, `${y}-12-31`) : null);
    };
    try {
      for (const r of window.Books.calculatedYears({ dnb, aliases, transactions, prices, inputs, firstYear, lastYear })) out.set(r.year, r);
    } catch (err) {
      console.error('calculated books failed', err);
    }
    return out;
  }

  // Reads what the calculation needs from the portfolio sheet. Cached for the
  // session; clear() on the Accounting tab's Reload.
  let cache = null;
  function load() {
    if (cache) return cache;
    cache = (async () => {
      const cfg = window.PORTAL_CONFIG, B = window.Books, R = window.BankRules;
      const titles = ((await window.Sheet.listTabs()) || []).map((t) => (typeof t === 'string' ? t : t && t.title));
      const dnbTab = cfg.ACCOUNTING_TABS.dnbRaw;
      if (!titles.includes(dnbTab)) return { years: new Map() };
      const want = [dnbTab, 'Aliases', B.INPUTS_TAB].filter((t) => titles.includes(t));
      const got = await window.Sheet.batchGet(want);
      const store = window.Store && window.Store.hydrate ? await window.Store.hydrate() : null;
      const aliases = got.Aliases ? R.buildAliases(R.parseAliases(got.Aliases))
        : (store && store.members ? R.aliasesFromMembers(store.members) : []);
      const dnb = window.Accounting.parseDnbRaw(got[dnbTab] || []);
      const inputs = B.parseInputs(got[B.INPUTS_TAB] || null);
      const transactions = store ? store.transactions || [] : [];
      return { dnb, aliases, inputs, transactions, store, years: calculate({ dnb, aliases, transactions, inputs, store }) };
    })();
    cache.catch(() => { cache = null; });
    return cache;
  }
  function clear() { cache = null; }

  window.CalculatedBooks = { calculate, load, clear };
})();
