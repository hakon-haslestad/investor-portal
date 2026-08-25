// Metric documentation — the single place that answers "where does this
// number come from and how is it calculated?". Every KPI card, chart and
// table in the portal carries an ⓘ that opens one of these entries.
//
// Conventions used below:
//   · "Rådata"      = the `Rådata fra nordnet` transaction tab
//   · "StockPrices" = the date × ticker matrix written by the Apps Script
//   · "Securities"  = the security master (ISIN → ticker/currency/status)
//   · "Dim-values"  = security → investor attribution weights
//   · Prices forward-fill: a lookup on date D uses the last close on or
//     before D (weekends/holes are bridged automatically).
//   · FX: non-NOK closes are converted with the CUR:<CUR>NOK column for
//     the same date (also forward-filled).

(function () {
  const ATTRIB = 'Each security\'s value is split between investors by its <em>Dim-values</em> weight (e.g. HH/HS at 0.5 each). Deposits, withdrawals, fees and cash are split evenly across all five investors — a display split, not a real allocation.';
  const QTY = 'Share counts come from replaying every Rådata row: all buy/sell-classified types move quantity, <em>including</em> corporate actions (BYTTE, SPLITT, spinoffs).';
  const COST = 'Cost basis uses the average-cost method: only KJØPT adds cost; only realizing sells (SALG, INNLØSN. UTTAK VP, SLETTING UTTAK VP) remove it proportionally. Corporate actions move shares but never touch cost — a split halves average cost implicitly, a spinoff parent keeps its basis.';
  const PRICE = 'Prices are daily closes from StockPrices in the security\'s native currency, converted to NOK with the matching CUR:…NOK rate. Lookups forward-fill from the last available close.';

  window.MetricsInfo = {
    // ── Dashboard / shared KPIs ────────────────────────────────────────────
    'total-value': {
      title: 'Total value',
      source: 'Rådata (quantities + cash balance), StockPrices (closes + FX), Securities (ticker/currency), Dim-values (attribution).',
      calc: `Market value of all open positions + cash.<br><br>Market value = Σ qty × latest NOK close per security. ${QTY} ${PRICE}<br><br>Cash = the latest <em>Saldo</em> Nordnet recorded in Rådata (authoritative, not re-derived). ${ATTRIB}`,
    },
    'market-value': {
      title: 'Market value (stocks)',
      source: 'Rådata (quantities), StockPrices (closes + FX), Securities, Dim-values.',
      calc: `Σ over open positions: quantity × latest NOK close.<br><br>${QTY}<br><br>${PRICE}<br><br>${ATTRIB} A position whose ticker has no price data yet is shown as "—" and excluded rather than counted as zero.`,
    },
    'cash': {
      title: 'Cash / dry powder',
      source: 'Rådata — the <em>Saldo</em> column.',
      calc: `The running balance Nordnet itself records on every transaction row — the portal takes the latest (or, for historical views, the last on or before the date) rather than re-adding flows. Per-investor cash is the group balance divided by 5. ${ATTRIB}`,
    },
    'unrealized': {
      title: 'Unrealized P/L',
      source: 'Rådata (quantities + cost), StockPrices (closes + FX), Dim-values.',
      calc: `Per open position: market value − (average cost × quantity), summed.<br><br>${COST}<br><br>${PRICE} Unpriced positions contribute nothing (shown as "—") instead of a fake full-cost loss.`,
    },
    'realized': {
      title: 'Realized P/L',
      source: 'Rådata (buys and realizing sells), Dim-values.',
      calc: `On every realizing sell: sale proceeds (NOK) − average cost at that moment × shares sold, accumulated over all time.<br><br>${COST} Foreign-currency amounts are converted with the row\'s own <em>Vekslingskurs</em>. ${ATTRIB}`,
    },
    'dividends': {
      title: 'Dividends',
      source: 'Rådata — UTBYTTE and KUPONGSKATT rows.',
      calc: `Σ of dividend amounts minus withholding tax (KUPONGSKATT rows are negative), converted to NOK with each row\'s <em>Vekslingskurs</em>. ${ATTRIB}`,
    },
    'invested': {
      title: 'Invested',
      source: 'Rådata — KJØPT rows.',
      calc: `Σ |amount| of every KJØPT ever made (NOK, fx-converted), attributed by Dim-values weight. This is gross capital put into stocks — sells don\'t reduce it.`,
    },
    'return-pct': {
      title: 'Return %',
      source: 'Derived from Realized + Unrealized + Dividends vs Invested.',
      calc: 'Net return = realized P/L + unrealized P/L + dividends.<br>Return % = net return ÷ invested (gross KJØPT sum). Same formula per investor and for the group.',
    },
    'window-metrics': {
      title: 'Window metrics',
      source: 'Rådata (replayed twice: before the window and inside it), StockPrices (closes at the window\'s two endpoint dates).',
      calc: `The transaction log is replayed up to the window start, then through the window.<br><br>· <strong>Start / end market value</strong> use the actual closes on those dates (forward-filled) — not today\'s.<br>· <strong>Unrealized Δ</strong> = (end MV − end cost) − (start MV − start cost).<br>· <strong>Net P/L</strong> = realized in window + dividends in window + unrealized Δ.<br>· <strong>Period return %</strong> = net P/L ÷ (cost at start + buys in window).<br><br>Positions with no price data are excluded from both endpoints (cost and MV) so they can\'t fake a loss.`,
    },
    'price-freshness': {
      title: 'Price freshness',
      source: 'StockPrices — the last date row.',
      calc: 'The newest date in the StockPrices matrix. The Apps Script fetches held stocks daily at 18:00 Oslo; "stale" appears when the newest row is more than 3 days old (check Admin → Feed).',
    },

    // ── Leaderboards ───────────────────────────────────────────────────────
    'lb-period': {
      title: 'Leaderboard — this window',
      source: 'Window metrics (see its ⓘ).',
      calc: 'Investors ranked by the window\'s period return % — net P/L in the window ÷ (cost basis at window start + buys inside the window).',
    },
    'lb-alltime': {
      title: 'Leaderboard — all time',
      source: 'The all-time KPIs above.',
      calc: 'Investors ranked by total return %: (realized + unrealized + dividends) ÷ invested.',
    },
    'lb-ytd': {
      title: 'Leaderboard — YTD cash returns',
      source: 'Rådata rows dated this calendar year.',
      calc: 'Per investor: (realizing-sell proceeds + net dividends since 1 Jan) ÷ the investor\'s share of total deposits, as a percentage. A cash-flow measure — unrealized moves don\'t count here.',
    },
    'lb-bestpicks': {
      title: 'Best single bet',
      source: 'Rådata (full history per security), StockPrices (current value of what\'s still held), Dim-values.',
      calc: 'Per investor and security: total return = (sell proceeds + dividends + current value of remaining shares) − invested. Each investor\'s best security is shown, ranked by NOK gain.',
    },
    'lb-monthly': {
      title: 'Monthly leaderboard',
      source: 'Rådata rows in each of the last 6 calendar months.',
      calc: 'Per month and investor: Σ of realizing-sell proceeds + net dividends booked that month (NOK, attributed). A realized cash-flow ranking — paper gains don\'t move it.',
    },

    // ── Charts ─────────────────────────────────────────────────────────────
    'chart-value': {
      title: 'Portfolio value over time',
      source: 'Rådata (quantities per date), StockPrices (closes + FX per date), Dim-values.',
      calc: `One point per StockPrices date (thinned to ≤400 points): Σ qty-on-that-date × NOK close-on-that-date per security, attributed per investor. ${QTY}`,
    },
    'chart-pnl': {
      title: 'Cumulative realized P/L',
      source: 'Rådata, replayed chronologically.',
      calc: 'Running total per investor of realized P/L + dividends − attributed fees, one point per trade date. Unrealized value is NOT in this line — it\'s pure booked results.',
    },
    'chart-price': {
      title: 'Price chart',
      source: 'StockPrices (daily closes + FX), Rådata (buy/sell markers).',
      calc: 'The security\'s daily NOK closes. Blue dots mark buys, red dots mark sells, from the actual Rådata rows.',
    },
    'equity-curve': {
      title: 'Equity curve',
      source: 'Same as the portfolio value chart, filtered to one investor.',
      calc: 'The investor\'s attributed share of every position, valued daily: Σ qty × NOK close × Dim-values weight.',
    },

    // ── Portfolio view ─────────────────────────────────────────────────────
    'holdings-table': {
      title: 'Current holdings',
      source: 'Rådata (qty + cost via replay), StockPrices (latest closes + FX), Securities (ticker/currency), Dim-values (owners).',
      calc: `${QTY}<br><br>${COST}<br><br>Price and market value use the latest close (forward-filled). Return = market value − cost basis. Rows without price data show "—" — fix the ticker in the Securities tab.`,
    },
    'gav': {
      title: 'GAV (average cost)',
      source: 'Rådata — KJØPT amounts and realizing sells.',
      calc: `Cost basis ÷ current quantity. ${COST}`,
    },
    'monthly-accounting': {
      title: 'Monthly accounting',
      source: 'Rådata (every flow, bucketed by booking month), StockPrices (month-end valuation).',
      calc: 'Per calendar month, from actual transactions: deposits, withdrawals, buys, sells, dividends (net of withholding), fees, and realized P/L (average-cost, NOK).<br><br><strong>End cash</strong> = the last Nordnet <em>Saldo</em> on or before month-end.<br><strong>End MV</strong> = Σ qty at month-end × NOK close at month-end (forward-filled).<br><strong>Total</strong> = end cash + end MV; Δ shows the month-over-month change.<br><br>The valuation columns hide while a security/type/investor filter is active — they are portfolio-level figures that cannot be filtered honestly. Click a month for its transactions and where those stocks stand today.',
    },
    'trading-activity': {
      title: 'Trading activity',
      source: 'Rådata — KJØPT and realizing-sell rows inside the selected window.',
      calc: 'Bought = Σ |KJØPT amounts|, Sold = Σ realizing-sell proceeds, Net deployed = bought − sold, Trades = row count. All NOK, converted with each row\'s <em>Vekslingskurs</em>.',
    },
    'activity-total-trend': {
      title: 'Total value by month',
      source: 'Rådata (Saldo + quantities), StockPrices (month-end closes + FX).',
      calc: 'One point per month-end: End cash (last Nordnet Saldo on or before month-end) + End MV (holdings at month-end × that date\'s NOK closes, forward-filled). Same numbers as the Total column in the By month table.',
    },
    'trade-scatter': {
      title: 'Trade timeline',
      source: 'Rådata — KJØPT and realizing-sell rows in the selected window.',
      calc: 'Each dot is one actual trade: date on the x-axis, NOK amount on the y-axis (fx-converted). Blue = buy, red = sell.',
    },
    'explorer': {
      title: 'Activity view & filters',
      source: 'Rådata (every transaction, NOK-converted), StockPrices (valuations), Dim-values (investor filter).',
      calc: 'One view over the raw transaction log: the search box matches security/ISIN/type/notes, the type pills and investor chips filter by classification and Dim-values attribution, and the range picker bounds the dates. Every KPI, chart and month bucket below recomputes from the filtered set. Realized P/L per sell is stamped by a full-history average-cost replay, so filtered sums stay consistent.',
    },

    // ── Investors ──────────────────────────────────────────────────────────
    'investor-kpis': {
      title: 'Investor KPIs',
      source: 'Same engine as the dashboard, filtered to this investor\'s Dim-values weights.',
      calc: `All amounts are the investor\'s attributed share: qty × weight, amounts × weight. ${ATTRIB} Cash and deposits are the group figures ÷ 5.`,
    },
    'previous-holdings': {
      title: 'Previous holdings',
      source: 'Rådata — full history of securities the investor no longer holds.',
      calc: 'Per exited security: invested (Σ KJØPT), proceeds (Σ realizing sells), dividends, and realized P/L from the average-cost replay. Return % = (realized + dividends) ÷ invested.',
    },
    'the-game': {
      title: 'The Game',
      source: 'Rådata (real positions and trades), StockPrices (the reveal chart).',
      calc: 'Draws a random real position (or trade window), hides the outcome, and lets you guess before revealing the actual P/L — computed exactly like the rest of the portal.',
    },

    // ── Competitions ───────────────────────────────────────────────────────
    'competition-scoring': {
      title: 'Competition scoring',
      source: 'Rådata rows inside the competition window, StockPrices closes on (or last before) the end date, Competition_Participants (teams + buy-ins).',
      calc: 'Only stocks BOUGHT inside the window count. Per participant: realized P/L on those lots + dividends + unrealized value at the end date\'s closes − cost. Return % is measured against the buy-in. Team rows aggregate their members.',
    },

    // ── Accounting ─────────────────────────────────────────────────────────
    'accounting-kpis': {
      title: 'Accounting figures',
      source: 'The separate konsolidert bookkeeping sheet (saldobalanse, hovedbok, DNB/Nordnet raw tabs) — not the portfolio sheet.',
      calc: 'Read-only mirrors of the bookkeeping workbook produced by the accounting pipeline. The portal parses the year tabs and sums the saldobalanse; nothing here is derived from Rådata or StockPrices.',
    },

    // ── Admin ──────────────────────────────────────────────────────────────
    'feed-health': {
      title: 'Price-feed health',
      source: 'StockPrices (per-column last dates), the hidden _log tab (Apps Script run log).',
      calc: 'Freshness = newest StockPrices row. Per ticker: last date with a value and point count. Held stocks should update daily (18:00 Oslo trigger), sold ones weekly for 6 months after the sale, then stop (status "expired").',
    },
    'ownership': {
      title: 'Ownership (Dim-values)',
      source: 'The Dim-values tab — edited right here.',
      calc: 'Maps each security to investor codes and weights. Empty factor = 1 ÷ number of listed investors. Every per-investor number in the portal multiplies by these weights, so edits here reshape the whole portal.',
    },
    'securities-registry': {
      title: 'Securities registry',
      source: 'The Securities tab, maintained by the Apps Script (seeded from Rådata ISINs, tickers resolved via Yahoo).',
      calc: 'The identity map: ISIN ↔ ticker ↔ name variants (aliases) ↔ currency ↔ held/sold/expired/ignore. Held = fetched daily; sold = weekly for 6 months; expired = no longer fetched; ignore = excluded from the portal entirely.',
    },
  };
})();
