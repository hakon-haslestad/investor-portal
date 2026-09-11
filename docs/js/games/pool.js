// Candidate-pool building for the games. Lifted wholesale out of the old
// renderGame closure in views/investors.js so every game draws its trades
// from one place.
//
// A "trade" here is one canonical stock in the selected window, with all
// investors' slices merged (see refinePool). That is the `trades` array
// handed to every game.

(function () {
  // How the period decides the MEASURE. This replaces the old Scope filter,
  // which was never a date control: it chose between scoring only the stocks
  // bought inside the window (competition rules) and scoring every overlapping
  // position over its whole life. On All time the two converge, so:
  //
  //   all         → lifetime result   (everything ever, scored whole-life)
  //   1y/2y/3y/…  → new bets in window (competition rules)
  //   competition → its own window    (competition rules, real buy-ins)
  function measureFor(period) {
    return period === 'all' ? 'lifetime' : 'window';
  }

  function createContext(store) {
    const names = window.Copy.namesFromMembers(store.members);
    const CODES = window.Ledger.INVESTOR_CODES;
    const canon = window.Portfolio.canonicalName;

    const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

    function computeWindow(period, customFrom, customTo) {
      const now = new Date();
      const todayStr = now.toISOString().slice(0, 10);
      let earliest = todayStr;
      for (const t of store.transactions || []) {
        if (t.tradeDate && t.tradeDate < earliest) earliest = t.tradeDate;
      }
      const addYears = (d, n) => {
        const x = new Date(d); x.setUTCFullYear(x.getUTCFullYear() + n); return x.toISOString().slice(0, 10);
      };
      switch (period) {
        case '1y': return { from: addYears(now, -1), to: todayStr };
        case '2y': return { from: addYears(now, -2), to: todayStr };
        case '3y': return { from: addYears(now, -3), to: todayStr };
        case 'custom': return { from: customFrom, to: customTo };
        case 'all': return { from: earliest, to: todayStr };
        case 'ytd':
        default: return { from: `${now.getUTCFullYear()}-01-01`, to: todayStr };
      }
    }

    // First/last BUY-or-SELL date for this security, for this investor.
    function activityDates(security, code) {
      const c = canon(security);
      let first = null, last = null;
      for (const tx of store.transactions || []) {
        if (!tx.security || !tx.tradeDate) continue;
        if (canon(tx.security) !== c) continue;
        const cat = window.Ledger.classify(tx.type);
        if (cat !== 'BUY' && cat !== 'SELL') continue;
        const split = window.Ledger.splitForSecurity(store.attributionMap, tx.security);
        if (code && !split.some((s) => s.code === code)) continue;
        if (!first || tx.tradeDate < first) first = tx.tradeDate;
        if (!last || tx.tradeDate > last) last = tx.tradeDate;
      }
      return { first, last };
    }

    const overlapsWindow = (first, last, from, to) => {
      const f = first || last, l = last || first;
      return f != null && f <= to && l >= from;
    };

    function poolFromScored(scored) {
      const from = scored.competition.start_date;
      const to = scored.competition.end_date;
      const out = [];
      for (const r of scored.ranks || []) {
        for (const b of r.breakdown || []) {
          const heldCost = b.costSum || 0;
          const soldCost = Math.max((b.soldProceeds || 0) - (b.realized || 0), 0);
          const purchaseAmount = heldCost + soldCost;
          const pnlNok = (b.unrealized || 0) + (b.realized || 0) + (b.divs || 0);
          const sold = (b.qty || 0) <= 1e-6 && (b.soldQty || 0) > 0;
          out.push({
            investor: r.code,
            investorName: names[r.code] || r.code,
            security: b.security,
            win: pnlNok >= 0, pnlNok,
            pnlPct: purchaseAmount > 0 ? (pnlNok / purchaseAmount) * 100 : 0,
            purchaseAmount,
            currentOrSoldValue: (b.marketValueAtEnd || 0) + (b.soldProceeds || 0),
            qty: b.qty || 0, soldQty: b.soldQty || 0, soldProceeds: b.soldProceeds || 0,
            sold, from, to,
          });
        }
      }
      return out;
    }

    function poolFromPeriodWindow(from, to) {
      const synthetic = { id: '_game', name: 'Game', start_date: from, end_date: to };
      const participants = CODES.map((code) => ({ investor_code: code, team_label: code, buy_in_nok: 0 }));
      const scored = window.CompetitionEngine.scoreCompetition(store, synthetic, participants);
      scored.competition = synthetic;
      return poolFromScored(scored);
    }

    function poolFromLifetime(from, to, isAll) {
      const dash = window.Portfolio.buildDashboard(store);
      const out = [];
      for (const code of CODES) {
        const inv = dash.perInvestor[code];
        if (!inv) continue;
        for (const h of inv.holdings || []) {
          const { first, last } = activityDates(h.security, code);
          if (!isAll && !overlapsWindow(first, last, from, to)) continue;
          const purchaseAmount = (h.avgCost || 0) * (h.qty || 0);
          const pnlNok = h.unrealized || 0;
          out.push({
            investor: code, investorName: names[code] || code, security: h.security,
            win: pnlNok >= 0, pnlNok,
            pnlPct: purchaseAmount > 0 ? (pnlNok / purchaseAmount) * 100 : 0,
            purchaseAmount, currentOrSoldValue: h.marketValue || 0,
            qty: h.qty || 0, avgCost: h.avgCost || 0,
            firstDate: first, lastDate: last,
            sold: false, from, to,
          });
        }
        for (const p of window.Portfolio.previousHoldings(store, code)) {
          if (!isAll && !overlapsWindow(p.firstDate, p.lastDate, from, to)) continue;
          const pnlNok = p.netResult != null ? p.netResult : (p.realized || 0) + (p.dividends || 0);
          out.push({
            investor: code, investorName: names[code] || code, security: p.security,
            win: pnlNok >= 0, pnlNok,
            pnlPct: (p.invested || 0) > 0 ? (pnlNok / p.invested) * 100 : 0,
            purchaseAmount: p.invested || 0, currentOrSoldValue: p.proceeds || 0,
            proceeds: p.proceeds || 0, realized: p.realized || 0, dividends: p.dividends || 0,
            firstDate: p.firstDate, lastDate: p.lastDate,
            sold: true, from, to,
          });
        }
      }
      return out;
    }

    function isRightsArtifact(name) {
      const s = String(name || '');
      return /\bTR\b/.test(s) || /(tegningsrett|tegningsret|emisjon|fortrinnsrett|rettigheter)/i.test(s);
    }

    // One row per canonical stock, with every investor's slice merged in.
    function refinePool(pool) {
      const byStock = new Map();
      for (const e of pool) {
        if (isRightsArtifact(e.security)) continue;
        const key = canon(e.security);
        let g = byStock.get(key);
        if (!g) {
          g = {
            security: e.security, from: e.from, to: e.to,
            purchaseAmount: 0, pnlNok: 0, currentOrSoldValue: 0, soldAll: true,
            qty: 0, proceeds: 0, realized: 0,
            firstDate: null, lastDate: null,
            owners: new Map(),
          };
          byStock.set(key, g);
        }
        g.purchaseAmount += e.purchaseAmount || 0;
        g.pnlNok += e.pnlNok || 0;
        g.currentOrSoldValue += e.currentOrSoldValue || 0;
        g.qty += e.qty || 0;
        g.proceeds += e.proceeds || e.soldProceeds || 0;
        g.realized += e.realized || 0;
        if (e.firstDate && (!g.firstDate || e.firstDate < g.firstDate)) g.firstDate = e.firstDate;
        if (e.lastDate && (!g.lastDate || e.lastDate > g.lastDate)) g.lastDate = e.lastDate;
        if (!e.sold) g.soldAll = false;
        const o = g.owners.get(e.investor) || { code: e.investor, name: e.investorName, purchaseAmount: 0 };
        o.purchaseAmount += e.purchaseAmount || 0;
        g.owners.set(e.investor, o);
      }
      return [...byStock.values()].map((g) => {
        const owners = [...g.owners.values()].sort((a, b) => b.purchaseAmount - a.purchaseAmount);
        // Trade dates are needed by Odd One Out (same-week, held-under-day)
        // and Back Trading (exit date). Fill them in once, here, rather than
        // making every game re-walk the transaction log.
        let firstDate = g.firstDate, lastDate = g.lastDate;
        if (!firstDate || !lastDate) {
          const d = activityDates(g.security, null);
          firstDate = firstDate || d.first;
          lastDate = lastDate || d.last;
        }
        return {
          security: g.security,
          investors: owners,
          investor: owners[0] ? owners[0].code : '',
          investorName: owners.map((o) => o.name).join(' + '),
          purchaseAmount: g.purchaseAmount,
          pnlNok: g.pnlNok,
          currentOrSoldValue: g.currentOrSoldValue,
          pnlPct: g.purchaseAmount > 0 ? (g.pnlNok / g.purchaseAmount) * 100 : 0,
          win: g.pnlNok >= 0,
          sold: g.soldAll,
          qty: g.qty, proceeds: g.proceeds, realized: g.realized,
          firstDate, lastDate,
          exchange: exchangeFor(g.security),
          from: g.from, to: g.to,
        };
      });
    }

    // Securities has `exchange` but NOT `sector` — see Code.gs SEC_HEADERS.
    // Odd One Out's same-exchange rule uses this; same-sector is deliberately
    // not implemented rather than guessed.
    function exchangeFor(security) {
      const reg = store.registry;
      if (!reg || !reg.forName) return '';
      const s = reg.forName(security);
      return (s && s.exchange) || '';
    }

    function tickerFor(security) {
      const reg = store.registry;
      if (!reg || !reg.forName) return '';
      const s = reg.forName(security);
      return (s && s.ticker) || '';
    }

    // filters: { period, from, to, competitionId }
    function buildPool(filters, compById) {
      let raw;
      if (filters.competitionId) {
        const c = compById && compById.get(filters.competitionId);
        if (!c) return [];
        const scored = window.CompetitionEngine.scoreCompetition(store, c.competition, c.participants);
        scored.competition = c.competition;
        raw = poolFromScored(scored);
      } else {
        const { from, to } = computeWindow(filters.period, filters.from, filters.to);
        raw = measureFor(filters.period) === 'lifetime'
          ? poolFromLifetime(from, to, filters.period === 'all')
          : poolFromPeriodWindow(from, to);
      }
      return refinePool(raw);
    }

    // ── price timeline — real daily closes when the matrix has data ──
    function txPriceNok(tx) {
      const cur = (tx.currency || '').toString().toUpperCase().trim();
      const fx = (!cur || cur === 'NOK') ? 1 : (Number(tx.fxRate) > 0 ? tx.fxRate : 1);
      return tx.price * fx;
    }

    const seriesCache = new Map();
    function priceSeriesForSecurity(security, code, from, to) {
      const key = `${canon(security)}|${Array.isArray(code) ? code.join(',') : code}|${from}|${to}`;
      if (seriesCache.has(key)) return seriesCache.get(key);
      const out = buildPriceSeries(security, code, from, to);
      seriesCache.set(key, out);
      return out;
    }

    function buildPriceSeries(security, code, from, to) {
      const c = canon(security);
      const codes = new Set(Array.isArray(code) ? code : [code]);
      const markers = [];
      for (const tx of store.transactions || []) {
        if (!tx.security || !tx.tradeDate) continue;
        if (tx.tradeDate < from || tx.tradeDate > to) continue;
        if (canon(tx.security) !== c) continue;
        const isTrade = tx.type === 'KJØPT' || tx.type === 'SALG';
        if (!isTrade) continue;
        const split = window.Ledger.splitForSecurity(store.attributionMap, tx.security);
        if (split.some((s) => codes.has(s.code))) {
          markers.push({ date: tx.tradeDate, type: tx.type === 'SALG' ? 'sell' : 'buy' });
        }
      }

      if (window.Portfolio.usePriceMatrix(store)) {
        const daily = window.TimeSeries.buildSecurityPriceSeries(store, security, from, to);
        if (daily.length >= 2) return { points: daily, markers };
      }

      // Fallback for an unpriced ticker: sketch the curve from actual trade
      // prices (better than no chart at all).
      const byDate = new Map();
      for (const tx of store.transactions || []) {
        if (!tx.security || !tx.tradeDate) continue;
        if (tx.tradeDate < from || tx.tradeDate > to) continue;
        if (canon(tx.security) !== c) continue;
        const isTrade = tx.type === 'KJØPT' || tx.type === 'SALG';
        if (isTrade && Number.isFinite(tx.price) && tx.price > 0) {
          byDate.set(tx.tradeDate, { date: tx.tradeDate, price: txPriceNok(tx) });
        }
      }
      const points = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
      return { points, markers };
    }

    function holdingText(entry) {
      const first = entry.firstDate;
      if (!first) return '—';
      const end = entry.sold ? (entry.lastDate || first) : new Date().toISOString().slice(0, 10);
      const days = daysBetween(first, end);
      if (days < 0) return '—';
      if (days < 60) return `${days} days`;
      const months = Math.round(days / 30.4);
      if (months < 24) return `${months} mo`;
      return `${(days / 365).toFixed(1)} yr`;
    }

    // MIN_POINTS is the floor for a stock to appear in any game at all.
    // Individual games tighten it further — guessing needs a chart worth
    // showing (chartable), Back Trading needs closes AFTER the exit.
    const MIN_POINTS = 2;
    function hasPriceData(entry) {
      const s = priceSeriesForSecurity(
        entry.security, (entry.investors || []).map((o) => o.code), entry.from, entry.to);
      return s.points.length >= MIN_POINTS;
    }

    // Split a pool into what is playable and what had too little data, so the
    // caller can say how many were dropped instead of silently shrinking.
    function withPriceData(entries) {
      const kept = [];
      const dropped = [];
      for (const e of entries) (hasPriceData(e) ? kept : dropped).push(e);
      return { kept, dropped };
    }

    function chartable(series) {
      return series.points.length >= 2 &&
        daysBetween(series.points[0].date, series.points[series.points.length - 1].date) >= 30;
    }

    // Everyone who could be a player: the competition's participants when one
    // is selected, otherwise every club member.
    function playersFor(filters, compById) {
      let codes = CODES;
      if (filters.competitionId && compById) {
        const c = compById.get(filters.competitionId);
        if (c) {
          const seen = new Set();
          codes = (c.participants || [])
            .map((p) => p.investor_code)
            .filter((x) => x && !seen.has(x) && seen.add(x));
        }
      }
      return codes.map((code) => ({ code, name: names[code] || code }));
    }

    return {
      computeWindow, activityDates, overlapsWindow, buildPool, refinePool,
      priceSeriesForSecurity, holdingText, chartable, playersFor,
      hasPriceData, withPriceData, MIN_POINTS,
      exchangeFor, tickerFor, daysBetween, names, CODES, canon, measureFor, store,
    };
  }

  window.GamePool = { createContext, measureFor };
})();
