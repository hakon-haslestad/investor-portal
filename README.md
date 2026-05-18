# Geysir Invest AS — Investor Portal

Local web app for the 5-person Geysir investment club. Drop in a fresh
Nordnet export, log in, and check the bag.

## What you get

- Dashboard with group + per-investor KPIs (total value, realized / unrealized
  P/L, dividends, dry powder, return %)
- Built-in leaderboards (all-time, YTD, best single bet, monthly)
- Per-investor drill-down (holdings, transactions, equity story)
- Custom competitions — individual or team, full-portfolio or stock-pick
- Presentation mode: 7-slide deck per competition (title → setup → early
  days → pivot → position breakdown → standings → verdict). Arrow keys to
  navigate.
- Sync directly from a private Google Sheet via the Admin tab — no more
  manual `.xlsx` uploads.

The Fall 2025 competition (HF/Cadeler, HH/Nordea+Strategy A+Scibase,
HS/Humble+Seafire, JC+ØS/Xplora) ships pre-seeded.

## Stack

Vanilla HTML/CSS/JS frontend. Node.js + Express backend. SQLite via
`better-sqlite3`. Excel parsing via `xlsx` (SheetJS). No bundler, no
build step — every file in `public/` is what it looks like.

## Run it

```bash
cd GeysirPortal
npm install
npm run seed        # creates 5 users + imports the xlsx + seeds Fall 2025
npm start
```

Open <http://localhost:3000>. The seed script creates one account per
investor (HH / HS / ØS / JC / HF) using the emails and the default
password defined in `.env`. Set these before running `npm run seed`:

```
DEFAULT_PASSWORD=<pick something>
GEYSIR_USER_EMAILS=HH:you@example.com,HS:friend@example.com,...
```

The app also reads `PORT` and `SESSION_SECRET` from `.env`. Rotate the
default password after first login.

## Refreshing the data

The portal pulls live from a private Google Sheet. **Admin → Sync now**
re-imports `Rådata fra nordnet`, `Beholdningsverdi`, and
`Offisielle nøkkeltall`. Investor attribution (Admin tab) is preserved —
sync only refreshes raw Nordnet data.

### One-time Google Sheets setup

1. **Google Cloud Console → New project** ("Geysir Invest Portal").
2. **APIs & Services → Library** → enable **Google Sheets API**.
3. **IAM & Admin → Service Accounts → Create service account**
   (`geysir-portal-sync`, skip the role grants).
4. Open the service account → **Keys** → Add key → JSON → download. Save
   as `data/google-service-account.json` (gitignored).
5. In `.env`:
   ```
   GOOGLE_SERVICE_ACCOUNT_KEY=./data/google-service-account.json
   ```
   Restart the server.
6. Open your Nordnet Google Sheet → **Share** → paste the service
   account email shown on the Admin tab → role **Editor** → Send.
   (Editor, not Viewer — the app writes the `Ownership` tab back to the
   sheet when you save an investor mapping.)
7. Admin tab → **Test connection** → **Sync now**. (The default sheet
   URL is already pre-configured.)

The sheet must have these tabs:
`Rådata fra nordnet` (transactions), `Beholdningsverdi` (current
holdings), `Offisielle nøkkeltall` (KPIs). `Dim-values` is optional —
the portal manages investor attribution in its own `Ownership` tab.

### Ownership tab

The first time you save an investor mapping in the Admin tab for a
stock that's in `Beholdningsverdi`, the app creates an `Ownership` tab
in the sheet with these columns:

```
Security | Member | Factor | UpdatedAt
```

`Security` is the PK and matches `Beholdningsverdi.Handel`. Edit
ownership in the Admin tab (not directly in the sheet) — each save
upserts the matching row. **Sold-out stocks** (no longer in
Beholdningsverdi) keep their mapping in local SQLite only, since they
have no PK in the sheet to write against.

### CLI bootstrap (optional)

If you have a local `.xlsx`, run `node scripts/import-excel.js
/path/to/file.xlsx` to seed the DB from disk instead. Useful for
initial setup before Google Sheets is wired up.

## Where the numbers come from

- **Transactions**: "Rådata fra nordnet" sheet (336 rows in the current
  export, 2020-02 through 2026-05).
- **Current holdings + prices**: "Beholdningsverdi" sheet (latest
  `snapshot_date`).
- **Security → investor attribution**: "Dim-values" sheet, with manual
  overrides in `src/excel/manual-attribution.js` for name variants and
  spinoffs the sheet doesn't cover.
- **KPIs** (revenue, EPS, P/E per stock): "Offisielle nøkkeltall" sheet.

The portfolio calculator uses Beholdningsverdi as the source of truth for
current qty / price, and replays only `KJØPT`/`SALG`/`UTBYTTE`/`KUPONGSKATT`
to derive cost basis, realized P/L, and dividends per investor. Corporate
actions (`BYTTE`, `SPLITT`, etc.) move shares but don't affect cost basis
— this avoids the cost-reset bug a naive ledger replay would hit.

## File layout

```
GeysirPortal/
├── server.js                       Express boot
├── src/
│   ├── auth.js                     bcrypt + express-session
│   ├── db.js                       SQLite schema + migrations
│   ├── copy.js                     Casual-bro copy bank
│   ├── excel/
│   │   ├── parser.js               Reads xlsx → JS arrays
│   │   ├── normalizer.js           ØF→ØS, etc.
│   │   └── manual-attribution.js   Overrides for name variants
│   ├── portfolio/
│   │   ├── ledger.js               Transaction classification
│   │   └── calculator.js           Dashboard math
│   ├── competitions/
│   │   ├── engine.js               Scoring, CRUD, team aggregation
│   │   └── presentation.js         7-slide payload builder
│   └── routes/
│       ├── auth.js                 /api/login etc.
│       ├── dashboard.js            /api/dashboard, /api/investor/:code
│       ├── competitions.js         /api/competitions CRUD + /:id/presentation
│       └── upload.js               /api/upload (multipart) + /log
├── public/                         All HTML / CSS / vanilla JS
├── scripts/
│   ├── seed-users.js               Creates 5 users
│   ├── import-excel.js             Imports the xlsx
│   └── seed-fall2025.js            Seeds the Fall 2025 competition
├── data/geysir.db                  SQLite (gitignored)
└── uploads/                        Last raw Nordnet xlsx (gitignored)
```

## A note on attribution

Five investors share one Nordnet account. The app assigns each stock to
one or more investors via the **Dim-values** sheet's `Member` and
`Investment factor` columns (e.g. _SalMar = HH/HS at 0.5 each_,
_Morrow Bank = HH/HF/HS at 0.333 each_).

If a security in `Rådata` isn't in `Dim-values`, the importer warns and
the manual overrides in `src/excel/manual-attribution.js` fill the gap.
Open that file to fix any wrong assumptions (currently makes best guesses
for Equinor, Inission B, Smartoptics Group).

Deposits are split evenly across all 5 investors — there's no per-investor
deposit attribution in the source. Per-investor cash is therefore a
display split, not a real allocation; if HH spent more than 1/5 of the
shared pool, their "cash" balance just reflects that.

## Tone

Copy throughout is casual investment-bro: short, slightly chaotic, mostly
English with the occasional Norwegian word. See `src/copy.js` for the
single source of truth — change strings there and they update everywhere.
