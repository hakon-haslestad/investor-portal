# Geysir Invest AS — Investor Portal

Static frontend for the 5-person Geysir investment club. No backend, no
server, no passwords — you sign in with Google and the page reads/writes
a shared Google Sheet on your behalf.

Hosted on GitHub Pages from `docs/`.

## What you get

- Dashboard with group + per-investor KPIs (total value, realized /
  unrealized P/L, dividends, dry powder, return %)
- Built-in leaderboards (all-time, YTD, best single bet, monthly)
- Per-investor drill-down (holdings, transactions, equity story)
- Custom competitions — individual or team, full-portfolio or stock-pick
- Presentation mode: 7-slide deck per competition (title → setup → early
  days → pivot → position breakdown → standings → verdict). Arrow keys
  to navigate.
- Admin tab edits the `Ownership` tab in the sheet directly — no
  out-of-band sync step.

## Stack

Vanilla HTML/CSS/JS. No bundler, no build step, no dependencies. Every
file in `docs/` is what it looks like. Auth is Google Identity Services
(GIS) implicit token flow; data access is the Google Sheets v4 REST API
called from the browser.

## One-time setup

1. **Google Cloud Console → New project** (e.g. "Geysir Invest Portal").
2. **APIs & Services → Library** → enable **Google Sheets API**.
3. **APIs & Services → OAuth consent screen** → External, add the
   investor emails as test users.
4. **APIs & Services → Credentials → Create credentials → OAuth client
   ID → Web application**.
   - **Authorized JavaScript origins**:
     `https://<your-gh-user>.github.io` (and `http://localhost:8080` if
     you want local dev).
5. Copy the OAuth client ID into `docs/js/config.js` (`OAUTH_CLIENT_ID`)
   and the Sheet ID into the same file (`SHEET_ID`).
6. Share the Google Sheet with each investor's Google account (named
   people only — **not** "Anyone with the link"). Role: Editor.

Visit the Pages URL and click **Sign in with Google**.

## Local dev

```bash
npx serve docs        # or any static file server
```

Open <http://localhost:8080>. Make sure `http://localhost:8080` is in
the OAuth client's Authorized JavaScript origins.

## Sheet contract

The portal expects these tabs in the source sheet:

| Tab                     | Purpose                                          |
| ----------------------- | ------------------------------------------------ |
| `Rådata fra nordnet`    | Transaction log (all rows, all time)             |
| `Beholdningsverdi`      | Current holdings + latest prices (snapshot)      |
| `Offisielle nøkkeltall` | Per-stock KPIs (revenue, EPS, P/E)               |
| `Dim-values`            | Default security → investor attribution          |
| `Members`               | Email → investor code + role (member/admin)      |
| `Competitions`          | Competition metadata + narrative JSON            |
| `Competition_Participants` | Per-competition participants and teams        |
| `Competition_Picks`     | Per-competition stock picks                      |
| `Ownership`             | Per-stock attribution overrides (managed by app) |

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
├── presentation.html     7-slide presentation mode
├── data.html             Raw data inspector
├── admin.html            Ownership + sheet management
├── css/                  style.css, presentation.css
└── js/
    ├── config.js                Sheet ID + OAuth client ID
    ├── auth.js                  Google Identity Services wrapper
    ├── sheet.js                 Google Sheets API client
    ├── parsers.js               Tab → typed JS objects
    ├── store.js                 In-memory cache across pages
    ├── nav.js                   Top nav bar
    ├── ledger.js                Transaction classification
    ├── portfolio.js             Dashboard math
    ├── dimvalues.js             Attribution helpers
    ├── competitions-engine.js   Scoring, team aggregation
    ├── competitions-data.js     CRUD against the sheet
    ├── presentation-builder.js  7-slide payload builder
    ├── format.js                Number / currency / date formatters
    ├── copy.js                  Casual-bro copy bank
    └── pages/                   One file per HTML page
```

## Tone

Copy throughout is casual investment-bro: short, slightly chaotic,
mostly English with the occasional Norwegian word. See `docs/js/copy.js`
for the single source of truth.
