# Investor Portal

Static frontend for a small investment club. No backend, no server, no
passwords — you sign in with Google and the page reads/writes a shared
Google Sheet on your behalf.

Hosted on GitHub Pages from `docs/`.

## What you get

- Dashboard with group + per-investor KPIs (total value, realized /
  unrealized P/L, dividends, dry powder, return %)
- Built-in leaderboards (all-time, YTD, best single bet, monthly)
- Per-investor drill-down (holdings, transactions, equity story)
- Custom competitions — individual or team, full-portfolio or stock-pick
- Presentation mode: a deck per competition (title → KPI summary → setup
  → early days → return-over-window chart → pivot → position breakdown
  with P/E·EPS → standings → verdict). Arrow keys to navigate.
- Admin tab edits the `Ownership` tab in the sheet directly — no
  out-of-band sync step.
- Accounting tab — read-only dashboard for the konsolidert bookkeeping
  workbook (SB net, bilag count, latest DNB/Nordnet dates, realisasjon
  gevinst). Lives in a **separate** Google Sheet so the share list can
  be tighter than the portfolio sheet.

## Stack

Vanilla HTML/CSS/JS. No bundler, no build step, no dependencies. Every
file in `docs/` is what it looks like. Auth is Google Identity Services
(GIS) implicit token flow; data access is the Google Sheets v4 REST API
called from the browser.

## One-time setup

1. **Google Cloud Console → New project** (e.g. "Investor Portal").
2. **APIs & Services → Library** → enable **Google Sheets API**.
3. **APIs & Services → OAuth consent screen** → External, add the
   investor emails as test users.
4. **APIs & Services → Credentials → Create credentials → OAuth client
   ID → Web application**.
   - **Authorized JavaScript origins**:
     `https://<your-gh-user>.github.io`
5. Copy the OAuth client ID into `docs/js/config.js` (`OAUTH_CLIENT_ID`)
   and the Sheet ID into the same file (`SHEET_ID`).
6. Share the Google Sheet with each investor's Google account (named
   people only — **not** "Anyone with the link"). Role: Editor.
7. **Accounting** (optional): create a second Google Sheet for the
   konsolidert bookkeeping workbook (produced by `build.py` in the
   companion repo) and paste its ID into `ACCOUNTING_SHEET_ID` in
   `docs/js/config.js`. Share it with the same investor accounts —
   Viewer is enough, the portal never writes to this sheet. **No new
   OAuth scope is needed** — the existing `spreadsheets.readonly` scope
   covers it, members never grant Drive access to the portal.

Visit the Pages URL and click **Sign in with Google**.

## Making changes

Everything in `docs/` is plain HTML/CSS/JS — no build step. Edit a
file, commit, push, GitHub Pages rebuilds in under a minute. There is
deliberately no local server: the only supported runtime is GitHub
Pages + the user's browser + the shared Google Sheet.

**Cache busting:** local `./js/` and `./css/` references in the HTML
pages carry a `?v=YYYYMMDD` query string. When you change a JS/CSS file,
bump this version (find-and-replace the old `?v=` value across `docs/*.html`)
so browsers fetch the new file instead of a stale cached copy.

## Sheet contract

The portal expects seven tabs in the source sheet:

| Tab                        | Purpose                                          |
| -------------------------- | ------------------------------------------------ |
| `Rådata fra nordnet`       | Transaction log (all rows, all time)             |
| `Beholdningsverdi`         | Current holdings + latest prices (snapshot)      |
| `Offisielle nøkkeltall`    | Per-stock KPIs (revenue, EPS, P/E)               |
| `Dim-values`               | Security → investor attribution + overrides     |
| `Members`                  | Email → investor code + role (member/admin)      |
| `Competitions`             | Competition metadata                             |
| `Competition_Participants` | Per-competition participants and teams           |

**Full column-level schema**, including data types, special enum
values, and a replication checklist: see [SCHEMA.md](./SCHEMA.md).

The portfolio calculator uses `Beholdningsverdi` as the source of truth
for current qty / price, and replays only `KJØPT`/`SALG`/`UTBYTTE`/
`KUPONGSKATT` rows from `Rådata` to derive cost basis, realized P/L,
and dividends per investor. Corporate actions (`BYTTE`, `SPLITT`, etc.)
move shares but don't affect cost basis.

## A note on attribution

Five investors share one Nordnet account. Each security is assigned to
one or more investors via `Dim-values` (`Member` + `Investment factor`
columns) — e.g. _SalMar = HH/HS at 0.5 each_. The `Ownership` tab
overrides this per-security when the defaults are wrong.

Deposits are split evenly across all 5 investors — there's no
per-investor deposit attribution in the source. Per-investor cash is
therefore a display split, not a real allocation.

## File layout

```
docs/
├── index.html            Dashboard (default landing)
├── login.html            Google Sign-In
├── investor.html         Per-investor drill-down
├── competitions.html     Competitions list + edit
├── presentation.html     Competition presentation deck
├── data.html             Raw data inspector
├── accounting.html       Read-only accounting dashboard
├── admin.html            Ownership + sheet management
├── css/                  style.css, presentation.css
└── js/
    ├── config.js                Sheet ID + OAuth client ID
    ├── auth.js                  Google Identity Services wrapper
    ├── sheet.js                 Google Sheets API client
    ├── parsers.js               Tab → typed JS objects
    ├── store.js                 In-memory cache across pages
    ├── nav.js                   Top nav bar
    ├── accounting.js            Parsers + status aggregator for the accounting sheet
    ├── ledger.js                Transaction classification
    ├── portfolio.js             Dashboard math
    ├── dimvalues.js             Attribution helpers
    ├── competitions-engine.js   Scoring, team aggregation
    ├── competitions-data.js     CRUD against the sheet
    ├── presentation-builder.js  Presentation deck payload builder
    ├── format.js                Number / currency / date formatters
    ├── copy.js                  Commentary phrases (verdict per investor)
    └── pages/                   One file per HTML page
```

## Tone

Copy throughout aims for a professional investor's register: measured,
dry, with a touch of sass. Norwegian words show up where the source
data is Norwegian (transaction types, sheet tab names). See
`docs/js/copy.js` for the verdict phrases that drive the per-investor
commentary.
