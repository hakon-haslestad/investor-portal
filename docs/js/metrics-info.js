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
      calc: `Σ over open positions: quantity × latest NOK close.<br><br>${QTY}<br><br>${PRICE}<br><br>${ATTRIB} A position with a price but no usable FX rate (or a delisted name) is valued at the club's own last trade price and marked ≈; one with no data at all shows "—" and is excluded rather than counted as zero.`,
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
      calc: `On every realizing sell: sale proceeds (NOK) − average cost at that moment × shares sold, accumulated over all time.<br><br><strong>Includes partial sells of positions still held</strong> — so total realized can be positive even when every fully-exited position lost money (the "Realized so far" column on still-held positions shows where it came from). ${COST} Foreign-currency amounts are converted with the row\'s own <em>Vekslingskurs</em>. ${ATTRIB}`,
    },
    'dividends': {
      title: 'Dividends',
      source: 'Rådata — UTBYTTE and KUPONGSKATT rows.',
      calc: `Σ of dividend amounts minus withholding tax (KUPONGSKATT rows are negative), converted to NOK with each row\'s <em>Vekslingskurs</em>. ${ATTRIB}`,
    },
    'fees': {
      title: 'Fees',
      source: 'Rådata — the <em>Totale Avgifter</em> column on every buy/sell, plus standalone fee rows (PLATTFORMAVGIFT, DEBETRENTE).',
      calc: 'Σ per-trade commissions + platform/interest charges, NOK-converted. Informational: Nordnet already embeds trade fees in each row\'s <em>Beløp</em>, so realized P/L and cost basis are net of them — this total is what trading has cost, not an extra deduction from returns.',
    },
    'invested': {
      title: 'Invested',
      source: 'Rådata — KJØPT rows.',
      calc: `Σ |amount| of every KJØPT ever made (NOK, fx-converted), attributed by Dim-values weight. This is gross capital put into stocks — sells don\'t reduce it.`,
    },
    'return-pct': {
      title: 'Profit / total bought',
      source: 'Derived from Realized + Unrealized + Dividends vs Invested.',
      calc: 'Net return = realized P/L + unrealized P/L + dividends.<br>Profit / total bought = net return ÷ invested (gross KJØPT sum). Same formula per investor and for the group.<br><br>Sells never reduce the denominator, so when the club sells and buys again the figure understates the return on the money at work. For a return that adjusts for deposits and timing, see <em>TWR</em> and <em>XIRR</em> (club level).',
    },
    'twr': {
      title: 'TWR (time-weighted return)',
      source: 'Rådata (deposits, withdrawals, cash), StockPrices (daily closes + FX), Dim-values.',
      calc: 'Daily total value = market value + cash, for every day with a price row in the window. Each day: r = V<sub>t</sub> ÷ (V<sub>t-1</sub> + F<sub>t</sub>) − 1, where F is deposits minus withdrawals, counted at the start of the day. TWR = the product of (1 + r) − 1.<br><br>It ignores how much money was in the club when, so it measures the investing, not the timing of deposits. Club level only: deposits are split evenly across the investors, so a per-investor TWR is not possible.',
    },
    'xirr': {
      title: 'XIRR (annualised, money-weighted)',
      source: 'Rådata (deposits, withdrawals), StockPrices (value at the start and end of the window).',
      calc: 'The yearly rate that makes the value at the window start plus every deposit (minus withdrawals), compounded to the end date, equal the end value. Uses actual dates (365-day year). Shown as "—" when there is no solution, for example when nothing was ever put in. Short windows annualise to large numbers; read them with care.',
    },
    'benchmark': {
      title: 'OSEBX (benchmark)',
      source: 'StockPrices, column IDX:OSEBX (written by the Apps Script price feed).',
      calc: 'The Oslo Børs benchmark index over the same window, indexed to 100 on the club line\'s first day (last close at or before it, forward-filled). It is the index price series; if the feed cannot supply total return, dividends are not included. Without the IDX:OSEBX column (feed not updated yet) the card and the line are hidden.',
    },
    'window-metrics': {
      title: 'Window metrics',
      source: 'Rådata (replayed twice: before the window and inside it), StockPrices (closes at the window\'s two endpoint dates).',
      calc: `The transaction log is replayed up to the window start, then through the window.<br><br>· <strong>Start / end market value</strong> use the actual closes on those dates (forward-filled) — not today\'s.<br>· <strong>Unrealized Δ</strong> = (end MV − end cost) − (start MV − start cost).<br>· <strong>Net P/L</strong> = realized in window + dividends in window + unrealized Δ.<br>· <strong>Period return %</strong> = net P/L ÷ (cost at start + buys in window).<br><br>Positions with no price data are excluded from both endpoints (cost and MV) so they can\'t fake a loss.`,
    },
    'price-freshness': {
      title: 'Price freshness',
      source: 'StockPrices — the last date row.',
      calc: 'The newest date in the StockPrices matrix, and the newest FX date. The Apps Script fetches held stocks daily at 18:00 Oslo. A price is "stale" when it is more than 3 weekdays old, so a Friday close is fine over a weekend; each holding row shows a "price N days old" chip when its own ticker is stale (check Admin → Feed).',
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
      title: 'Realized profit YTD (% of deposits)',
      source: 'Rådata rows dated this calendar year.',
      calc: 'Per investor: (profit on shares sold since 1 Jan + net dividends since 1 Jan) ÷ the investor\'s share of total deposits, as a percentage. Profit on a sale = sale amount minus average cost, so selling at a loss counts as a loss however large the sale. Unrealized moves don\'t count here.',
    },
    'lb-bestpicks': {
      title: 'Best single bet',
      source: 'Rådata (full history per security), StockPrices (current value of what\'s still held), Dim-values.',
      calc: 'Per investor and security: total return % = (sell proceeds + dividends + current value of remaining shares − invested) ÷ invested. Each investor\'s best security is shown, ranked by that percentage. A holding with no price yet is left out, not counted as a loss.',
    },
    'lb-monthly': {
      title: 'Realized profit by month',
      source: 'Rådata rows in each of the last 6 calendar months.',
      calc: 'Per month and investor: profit on shares sold that month (sale amount minus average cost) + net dividends booked that month, in NOK (attributed), also shown as % of deposits. Paper gains don\'t move it.',
    },

    // ── Charts ─────────────────────────────────────────────────────────────
    'chart-value': {
      title: 'Portfolio value over time',
      source: 'Rådata (quantities per date), StockPrices (closes + FX per date), Dim-values.',
      calc: `One point per StockPrices date (thinned to ≤400 points): Σ qty-on-that-date × NOK close-on-that-date per security, attributed per investor. ${QTY}<br><br>Delisted securities (bankruptcies, buyouts) have no market data — while held, they are valued at the club's own trade prices from Rådata, forward-filled between trades.`,
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
    'allocation': {
      title: 'Allocation',
      source: 'Rådata (quantities), StockPrices (closes + FX), Securities (ISIN, currency), Rådata Saldo (cash).',
      calc: `Shares of today\'s market value of the priced open positions. <strong>Top 5</strong> = the five biggest positions ÷ holdings value; <strong>Biggest position</strong> = the largest one ÷ holdings value; <strong>Cash</strong> = latest Saldo ÷ (holdings value + cash). <strong>Currency</strong> is the security\'s trading currency; <strong>country</strong> is the first two letters of its ISIN ("Unknown" when the Securities tab has no ISIN). Each split adds up to 100%. Positions with no price are left out. ${PRICE}`,
    },
    'fx-split': {
      title: 'Price effect and currency effect',
      source: 'Rådata (foreign-currency buys with their <em>Vekslingskurs</em>), StockPrices (closes + FX).',
      calc: 'For foreign-currency positions only. Cost uses the average-cost method in the trading currency and the average rate paid on the buys. <strong>Price effect</strong> = (value now − cost, in the trading currency) × rate at purchase. <strong>Currency effect</strong> = value now in the trading currency × (rate now − rate at purchase). The two add up to about the unrealized P/L of those positions (the average-cost basis here can differ slightly from the transaction-replay basis, for example with free shares or conversion pairs). Shown only when every foreign position has a price, a current rate and a rate on its buys.',
    },
    'dividends-table': {
      title: 'Dividends by security',
      source: 'Rådata — UTBYTTE and KUPONGSKATT rows, KJØPT rows for cost.',
      calc: 'All time, not affected by the filters above. <strong>Gross</strong> = Σ UTBYTTE; <strong>Tax</strong> = Σ KUPONGSKATT (withholding tax); <strong>Net</strong> = gross − tax. <strong>Yield on cost</strong> = gross ÷ everything the club paid for that security (Σ KJØPT, NOK); shown as "—" when there are no buys. All amounts in NOK with each row\'s <em>Vekslingskurs</em>. The totals row equals the Dividends figure on the dashboard.',
    },
    'trades-csv': {
      title: 'Trade list (CSV)',
      source: 'Rådata — the buys and sells matching the filters above.',
      calc: 'One row per buy or sell in the current filter: ISO date, type, security, ISIN, quantity, price, currency, amount and fee in NOK, and realized P/L (sells, average cost). UTF-8 with a byte-order mark so Excel reads æøå.',
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

    'look-through': {
      title: 'Look-through fundamental value',
      source: 'Offisielle nøkkeltall (EPS, revenue, shares out, P/E, optional BVPS) × your LIVE share counts from the transaction replay.',
      calc: 'Per company, the latest ANNUAL period is used; a company with only quarterly rows is annualized ×4 and marked ≈.<br><br>· <strong>Your earnings/yr</strong> = EPS (NOK; parsed with its currency, or price ÷ P/E as fallback) × shares held.<br>· <strong>Your revenue/yr</strong> = revenue ÷ shares outstanding × fx × shares held.<br>· <strong>Your book value</strong> = BVPS × shares held (needs the BVPS column).<br>· <strong>Fundamental value</strong> = Σ earnings × the P/E multiple you set — compare it to market value to see what the market pays for those earnings.<br>· <strong>Portfolio P/E</strong> = market value ÷ Σ earnings (only positions with earnings data count on both sides).',
    },
    'fundamentals': {
      title: 'Fundamentals',
      source: 'The Offisielle nøkkeltall tab — maintained by hand per company per period.',
      calc: 'Official revenue and earnings-after-tax as reported (with units as typed), EPS TTM and indicative P/E, plus your share of revenue/profit in final NOK — taken verbatim from the sheet, the portal does no FX or unit math on them. All available periods are listed, oldest first.',
    },

    // ── Investors ──────────────────────────────────────────────────────────
    'investor-kpis': {
      title: 'Investor KPIs',
      source: 'Same engine as the dashboard, filtered to this investor\'s Dim-values weights.',
      calc: `All amounts are the investor\'s attributed share: qty × weight, amounts × weight. ${ATTRIB} Cash and deposits are the group figures ÷ 5.`,
    },
    'mv-change': {
      title: 'Market-value change (Change columns, incl. deposits)',
      source: 'Rådata (attributed share counts per date), StockPrices (closes + FX per date).',
      calc: 'Per horizon: the investor\'s attributed market value today vs on the horizon start date (positions × that date\'s NOK closes, forward-filled; own-trade prices for delisted names). NOTE: this is raw MV change — buys ADD to it and sells subtract, so it is not a pure return figure; use Period return for flow-adjusted performance.',
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

    // ── Board ──────────────────────────────────────────────────────────────
    'business-earnings': {
      title: 'What the businesses earn us',
      source: 'Offisielle nøkkeltall, one row per company and period (EPS TTM, P/E, "Din EAT" per quarter), and our share counts from Rådata.',
      calc: 'Look-through earnings = EPS per share as entered in the sheet × the shares we own, summed over the holdings that report. Earnings yield = those earnings ÷ the market value of the same holdings. Portfolio P/E is the inverse. The quarter figure sums "Din EAT" for the latest quarter and the same quarter a year earlier, only for companies that have both rows. The portal does no currency or unit math on these fields: figures are as entered in the sheet.',
    },

    // ── Accounting ─────────────────────────────────────────────────────────
    'accounting-kpis': {
      title: 'Accounting figures',
      source: 'The separate konsolidert bookkeeping sheet (saldobalanse, hovedbok, DNB/Nordnet raw tabs) — not the portfolio sheet. The Board result is minus the closing balance (UB) of accounts 3000-8999 in the latest closed year.',
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
