// Security master — parses the `Securities` tab into a registry that maps
// Nordnet display names (and aliases) to a canonical security identity:
// ticker (StockPrices column key), currency, exchange, status, soldDate.
// Replaces the old hardcoded NAME_ALIASES table in portfolio.js.

(function () {
  // Header: ticker | name | aliases | isin | currency | exchange | source |
  //         status | soldDate | notes   (header-keyed, order-tolerant)
  function parseSecurities(rows) {
    if (!rows || rows.length < 2) return [];
    const header = rows[0].map((h) => String(h || '').trim().toLowerCase());
    // Header-keyed with a positional fallback: the tab has a canonical
    // column order, and one accidentally overwritten header cell must not
    // blank the ticker (= every price) portal-wide.
    const CANON = ['ticker', 'name', 'aliases', 'isin', 'currency', 'exchange', 'source', 'status', 'solddate', 'notes', 'lastchecked'];
    const col = (name) => {
      const i = header.indexOf(name);
      return i >= 0 ? i : CANON.indexOf(name);
    };
    const idx = {
      ticker: col('ticker'), name: col('name'), aliases: col('aliases'),
      isin: col('isin'), currency: col('currency'), exchange: col('exchange'),
      source: col('source'), status: col('status'), soldDate: col('solddate'),
      notes: col('notes'), lastChecked: col('lastchecked'),
    };
    const at = (row, i) => (i >= 0 && row[i] != null ? String(row[i]).trim() : '');
    const out = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row) continue;
      const name = at(row, idx.name);
      const ticker = at(row, idx.ticker);
      if (!name && !ticker) continue;
      out.push({
        sourceRow: r + 1,
        ticker,
        name: name || ticker,
        aliases: at(row, idx.aliases).split(';').map((a) => a.trim()).filter(Boolean),
        isin: at(row, idx.isin) || null,
        currency: (at(row, idx.currency) || 'NOK').toUpperCase(),
        exchange: at(row, idx.exchange) || null,
        source: (at(row, idx.source) || 'yahoo').toLowerCase(),
        status: (at(row, idx.status) || 'held').toLowerCase(),
        soldDate: window.Parsers.excelDateToISO(row[idx.soldDate]) || null,
        notes: at(row, idx.notes) || null,
        lastChecked: at(row, idx.lastChecked) || null,
      });
    }
    return out;
  }

  // Registry with lowercase-name → security lookups.
  function buildRegistry(list) {
    const byKey = new Map();   // lowercased name/alias/ticker → security
    const byTicker = new Map();
    const byIsin = new Map();
    const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
    for (const s of list) {
      if (s.ticker) byTicker.set(s.ticker, s);
      if (s.isin) byIsin.set(s.isin.toUpperCase(), s);
      const keys = [s.name, s.ticker, ...s.aliases];
      for (const k of keys) {
        if (!k) continue;
        byKey.set(k.toLowerCase(), s);
        // A retired ISIN in aliases merges that era into this row.
        if (ISIN_RE.test(k.toUpperCase())) byIsin.set(k.toUpperCase(), s);
      }
    }
    function forName(raw) {
      if (!raw) return null;
      return byKey.get(String(raw).trim().toLowerCase()) || null;
    }
    function forIsin(isin) {
      if (!isin) return null;
      return byIsin.get(String(isin).trim().toUpperCase()) || null;
    }
    // Runtime-only alias: Nordnet name variants unknown to the sheet are
    // learned from transactions via their ISIN at hydration (nothing is
    // written back — the sheet's aliases column stays the durable record).
    function learnAlias(name, security) {
      if (name && security) byKey.set(String(name).trim().toLowerCase(), security);
    }
    return {
      list,
      byTicker,
      forName,
      forIsin,
      learnAlias,
      // Canonical display name for any Nordnet name variant. Falls back to
      // the trimmed input when the security isn't registered (yet).
      canonicalName(raw) {
        const s = forName(raw);
        return s ? s.name : (raw == null ? raw : String(raw).trim());
      },
      tickerFor(raw) {
        const s = forName(raw);
        return s ? s.ticker || null : null;
      },
      currencyFor(raw) {
        const s = forName(raw);
        return s ? s.currency : 'NOK';
      },
    };
  }

  window.Securities = { parseSecurities, buildRegistry };
})();
