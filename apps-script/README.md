# Price feed — Google Apps Script

Free, serverless price ingestion for the portal. A script bound to the club's
Google Sheet fetches closes daily and stores them in the `StockPrices` tab
(rows = dates, columns = tickers, values = close in the security's native
currency; FX rates as `CUR:USDNOK`-style columns).

Cadence: **held** stocks daily; **sold** stocks daily for ~13 months after the
sale (`soldDate + 400 days`), then the ticker is marked `expired` and fetching
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

- **New stock bought** — fully automatic. The next `dailyFetch` run seeds a
  `Securities` row from the transaction's ISIN, resolves its ticker via
  Yahoo, backfills its history (and a new FX pair if needed), and starts
  fetching daily. Manual work only if Yahoo can't resolve the ISIN — the
  row then carries a REVIEW note until you type the ticker in.
- **Stock sold** — automatic: the replay flips it to `sold` on the next
  run, fetches daily for ~13 months, then marks it `expired` and stops.
  The tail is this long because the portal's Back Trading game judges a sell
  at 5, 20, 60, 120 and 250 *trading* days after the exit — roughly 350
  calendar days of closes. It used to be 183 days at weekly cadence, which
  could not answer the longer horizons at all.

  **After changing `SOLD_TAIL_DAYS`, run `backfill()` once.** It refetches
  every non-expired security from its first transaction date, so the post-exit
  history that was never captured is pulled in retroactively. Securities
  already marked `expired` stay skipped — set their `status` back to `sold`
  first if you want their tail filled in too.
- **Fetch failures** land in `_log` and leave a hole in the matrix — safe,
  the portal forward-fills the last known close.
- **Force-refresh sold state** — `dailyFetch` does it on every run; nothing
  to maintain by hand. `status`/`soldDate` can be overridden manually.
- The portal's Admin tab shows the `Securities` registry and recent `_log`
  entries, so day-to-day you rarely need the Apps Script editor.


## Cross-device play (phones answering onto a shared screen)

The same script also serves the portal's game rooms. This half is **optional**
— leave `ROOMS_URL` empty in `docs/js/config.js` and the games stay
single-device; nothing else changes.

### Deploy

1. Paste the current `Code.gs` into the editor (it now ends with a
   `GAME ROOMS` section) and save.
2. **Deploy → New deployment → Web app**
   - *Execute as*: **Me**
   - *Who has access*: **Anyone**
3. Copy the `/exec` URL and paste it into `docs/js/config.js` as `ROOMS_URL`.
4. Commit that, bump the `?v=` cache-bust, and push.

**Editing the script later needs a NEW VERSION**, not just a save: Deploy →
Manage deployments → edit → Version: New version. The `/exec` URL stays the
same. This is the step everyone forgets, and the symptom is the old code
running with no error anywhere.

### Why "Anyone" is not what it sounds like

A phone cannot authenticate *to Apps Script* without authorising the script
itself, which nobody is doing at a party. So the deployment is open at the
HTTP level — but it is not an anonymous write surface:

- every POST carries the caller's Google OAuth access token, verified against
  `oauth2.googleapis.com/tokeninfo`, so an email cannot be forged;
- the token's `aud` must be **our** OAuth client, so a token minted for any
  other Google app cannot be replayed here;
- the email must resolve to a row in the `Members` tab, and be on that room's
  roster.

And the endpoint holds nothing worth taking. Because phones show buttons only,
a live room is investor codes and small integers:

```json
{ "g": "odd-one-out", "r": ["HH","JC"], "j": ["HH"], "q": 3, "a": { "HH": 2 }, "v": 7 }
```

No security names, no prices, no P/L — those never leave the shared screen.
Rooms live in `CacheService` with a 2-hour TTL and never touch the
spreadsheet, so game traffic cannot disturb the club's data.

### Quotas

Each poll is one short execution. A five-player game polling every 1.5s for
half an hour is a few thousand calls — comfortably inside the consumer Apps
Script limits, but it is worth knowing this is the one part of the project
that consumes a shared daily budget. Polling stops when a tab is hidden.
