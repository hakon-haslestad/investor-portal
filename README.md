# Investor Portal

Static frontend for a small investment club. No backend, no server, no
passwords — you sign in with Google and the page reads/writes a shared
Google Sheet on your behalf. Prices arrive automatically via a free
Google Apps Script bound to the sheet.

Hosted on GitHub Pages from `docs/`.

## What you get

- Single-page app with six tabs: **Dashboard**, **Portfolio** (holdings /
  report / data explorer), **Investors** (per-investor drill-down + The
  Game), **Competitions**, **Accounting**, **Admin**.
- True daily portfolio-value charts — the `StockPrices` tab holds a
  date × ticker matrix of daily closes, fetched automatically.
- Group + per-investor KPIs (total value, realized / unrealized P/L,
  dividends, dry powder, return %), leaderboards, window metrics priced
  with the actual closes at the window's endpoints.
- Custom competitions — individual or team — with a presentation deck
  per competition (`presentation.html`, arrow keys to navigate).
- Admin tab edits `Dim-values` attribution directly, shows the
  `Securities` registry and the price-feed health log.
- Accounting tab — read-only dashboard for the konsolidert bookkeeping
  workbook (separate Google Sheet with a tighter share list).

## Stack

Vanilla HTML/CSS/JS. No bundler, no build step, no dependencies. Auth is
Google Identity Services (GIS) implicit token flow; data access is the
Google Sheets v4 REST API called from the browser. The only "backend" is
a time-driven Google Apps Script inside the sheet (see
[apps-script/README.md](./apps-script/README.md)) — everything stays on
Google's free tier.

## One-time setup

1. **Google Cloud Console → New project** (e.g. "Investor Portal").
2. **APIs & Services → Library** → enable **Google Sheets API**.
3. **APIs & Services → OAuth consent screen** → External, add the
   investor emails as test users.
4. **APIs & Services → Credentials → Create credentials → OAuth client
   ID → Web application**.
   - **Authorized JavaScript origins**:
     `https://<your-gh-user>.github.io` (add `http://localhost:8000`
     too if you want local development).
5. Copy the OAuth client ID into `docs/js/config.js` (`OAUTH_CLIENT_ID`)
   and the Sheet ID into the same file (`SHEET_ID`).
6. Share the Google Sheet with each investor's Google account (named
   people only — **not** "Anyone with the link"). Role: Editor.
7. **Price feed**: install the Apps Script per
   [apps-script/README.md](./apps-script/README.md) — creates and seeds
   the `Securities` + `StockPrices` tabs, backfills history, and
   installs the daily trigger.
8. **Accounting** (optional): create a second Google Sheet for the
   konsolidert bookkeeping workbook and paste its ID into
   `ACCOUNTING_SHEET_ID` in `docs/js/config.js`. Viewer share is enough.

Visit the Pages URL and click **Sign in with Google**.

## Making changes

Everything in `docs/` is plain HTML/CSS/JS — no build step. Edit a
file, commit, push, GitHub Pages rebuilds in under a minute.

**Cache busting:** local `./js/` and `./css/` references in the HTML
pages carry a `?v=YYYYMMDD` query string. When you change a JS/CSS file,
bump this version (find-and-replace across `docs/*.html`).

## Sheet contract

| Tab                        | Purpose                                                    |
| -------------------------- | ---------------------------------------------------------- |
| `Rådata fra nordnet`       | Transaction log (all rows, all time) — unchanged            |
| `StockPrices`              | Date × ticker matrix of daily closes (written by the script)|
| `Securities`               | Security master: ticker, name, aliases, currency, status    |
| `Offisielle nøkkeltall`    | Per-stock KPIs (revenue, EPS, P/E)                          |
| `Dim-values`               | Security → investor attribution + overrides                 |
| `Members`                  | Email → investor code + role (member/admin)                 |
| `Competitions`             | Competition metadata                                        |
| `Competition_Participants` | Per-competition participants and teams                      |
| `_scratch`, `_log`         | Apps Script working tabs (hidden)                           |

Quantities and cost basis are derived by replaying the transaction log
(corporate actions move shares but never touch cost basis); prices come
from `StockPrices` with forward-fill over weekends/holes. The old
`Beholdningsverdi` snapshot tab is fully retired — the portal never
reads it.

**Full column-level schema**: see [SCHEMA.md](./SCHEMA.md).

## A note on attribution

Five investors share one Nordnet account. Each security is assigned to
one or more investors via `Dim-values` (`Member` + `Investment factor`
columns) — e.g. _SalMar = HH/HS at 0.5 each_. Deposits are split evenly
across all 5 investors; per-investor cash is a display split, not a real
allocation.

## File layout

```
apps-script/
├── Code.gs               Price feed (paste into the sheet's bound script)
└── README.md             Install + operations guide
docs/
├── index.html            SPA shell (auth gate + nav + view mount)
├── presentation.html     Competition presentation deck (standalone, fullscreen)
├── css/                  style.css, presentation.css
└── js/
    ├── config.js                Sheet ID + OAuth client ID + tab names
    ├── auth.js                  Google Identity Services wrapper
    ├── sheet.js                 Google Sheets API client
    ├── parsers.js               Tab → typed JS objects
    ├── securities.js            Securities registry (name/alias → ticker)
    ├── prices.js                StockPrices matrix + forward-fill lookups
    ├── positions.js             Qty/cost replay of the transaction log
    ├── portfolio.js             Dashboard math (prices × positions)
    ├── timeseries.js            Daily value series + per-security series
    ├── store.js                 One-per-session sheet hydration
    ├── router.js                Hash router (#/dashboard, #/portfolio/…)
    ├── components.js            Shared UI helpers (window.UI)
    ├── app.js                   Boot: auth gate → hydrate → router
    ├── ledger.js                Transaction classification
    ├── dimvalues.js             Attribution read/write helpers
    ├── competitions-engine.js   Scoring, team aggregation
    ├── competitions-data.js     CRUD against the sheet
    ├── presentation-builder.js  Presentation deck payload builder
    ├── accounting.js            Accounting-sheet parsers
    ├── format.js  copy.js       Formatters + commentary phrases
    └── views/                   One module per top-level tab
```

## Tone

Copy throughout aims for a professional investor's register: measured,
dry, with a touch of sass. Norwegian words show up where the source
data is Norwegian. See `docs/js/copy.js`.
