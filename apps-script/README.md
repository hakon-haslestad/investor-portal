# Price feed — Google Apps Script

Free, serverless price ingestion for the portal. A script bound to the club's
Google Sheet fetches closes daily and stores them in the `StockPrices` tab
(rows = dates, columns = tickers, values = close in the security's native
currency; FX rates as `CUR:USDNOK`-style columns).

Cadence: **held** stocks daily; **sold** stocks weekly for 6 months after the
sale (`soldDate + 183 days`), then the ticker is marked `expired` and fetching
stops. Sold-state is derived automatically by replaying the Nordnet
transaction log.

Sources: GOOGLEFINANCE where it covers the symbol (Stockholm, Xetra, FX);
Yahoo Finance chart API for Oslo Børs (GOOGLEFINANCE has no OSE coverage).
Only static values are written — GOOGLEFINANCE formulas are evaluated in the
hidden `_scratch` tab and replaced by their value, since formulas recalculate
and would not preserve history.

## Install (one-time, ~10 minutes)

1. Open the portfolio Google Sheet → **Extensions → Apps Script**.
2. Replace the default `Code.gs` content with this folder's `Code.gs`. Save.
3. In the editor's function dropdown, run **`setupTabs`**. First run asks for
   authorization (spreadsheet + external requests) — accept.
   - This creates `Securities`, `StockPrices`, `_scratch`, `_log` and seeds
     `Securities` from `Rådata fra nordnet`, **keyed by ISIN**: one row per
     ISIN, with every name variant the log ever used (old short codes like
     `SALM`, newer full names) collected into the `aliases` column. Only
     names with no ISIN anywhere in the log need manual attention.
4. Run **`resolveTickers`** — fills in missing tickers by looking up each
   row's ISIN (taken from the Nordnet log) via Yahoo's search API, picking
   the home-exchange listing (NO→`.OL`, SE→`.ST`, DK→`.CO`, DE→`.DE`,
   FI→`.HE`) and setting `source` accordingly. Resolved rows get an
   "auto-resolved from ISIN (…) — verify" note; skim that the matched
   company names look right. Safe to re-run.
5. **Review the remaining `Securities` rows.** Anything still noted
   `REVIEW` (no ISIN in the log, or not found on Yahoo) needs a ticker,
   currency and source filled in by hand:
   - `ticker` — Yahoo-style symbol (`EQNR.OL`, `STOR-B.ST`, `HFG.DE`). This
     becomes the column header in `StockPrices` and the key the portal uses.
   - `source` — `yahoo` for Oslo Børs, `googlefinance` where GF covers it.
   - `aliases` — extra Nordnet display-name variants, `;`-separated (old
     exports used short codes like `SALM`; newer ones use full names).
   - For a `googlefinance` row whose GF symbol differs from
     `exchange:ticker`, put `gf=EXCH:SYM` in `notes`.
6. Run **`backfill`** — fetches historical closes per ticker from its first
   transaction date, plus FX history. **Resumable:** Apps Script kills any
   run at 6 minutes, so backfill stops itself at ~4.5 and logs
   "RUN backfill AGAIN to continue" — just run it repeatedly until `_log`
   says "backfill complete". Already-fetched tickers are skipped, and it
   never overwrites an existing cell.
7. Run **`dailyFetch`** manually once and check:
   - `StockPrices` has today's row with a value per held ticker + FX columns.
   - `_log` (unhide via right-click a tab → Show) has no errors.
   - Run `dailyFetch` again — the same row is updated, not duplicated.
8. Run **`setupTrigger`** — installs the daily 18:00 Europe/Oslo trigger.

## Operations

- **New stock bought** — `dailyFetch` won't know its ticker: the seeded row
  appears after the next `setupTabs` run, or simply add a `Securities` row
  yourself (ticker, name, alias = the Nordnet `Verdipapir` text, currency,
  source). Backfill it with one `backfill` run.
- **Fetch failures** land in `_log` and leave a hole in the matrix — safe,
  the portal forward-fills the last known close.
- **Force-refresh sold state** — `dailyFetch` does it on every run; nothing
  to maintain by hand. `status`/`soldDate` can be overridden manually.
- The portal's Admin tab shows the `Securities` registry and recent `_log`
  entries, so day-to-day you rarely need the Apps Script editor.
