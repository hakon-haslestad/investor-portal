# Sheet Schema

The portal reads from — and in two places writes to — a single Google
Sheet. This document describes every tab, every column, and the
contract the portal expects. To stand up a fresh deployment you need to
either create a sheet with these tabs, or point `docs/js/config.js`
`TABS` at whatever names you actually use.

All column positions below are **0-indexed** unless a header row is
explicitly described.

---

## 1. `Rådata fra nordnet` — transactions

Source of truth for every cash movement and trade. Exported as-is from
Nordnet → "Last ned transaksjoner" (`transactions-and-notes-export.csv`).
The parser keys columns by **header name**, so column order can change
without breaking anything as long as the headers stay.

**Export format** (verified against a real 2026 export): the download is
a **UTF-16 LE file with BOM, tab-separated** (despite the `.csv` name),
with **decimal commas** (`0,0275`), ISO dates (`2026-06-18`), and empty
cells for missing values. Google Sheets handles all of this on paste /
File → Import; the portal's `numOrNull`/`excelDateToISO` normalize both
comma-decimals and serials, so appending rows to the tab as-is is safe.

The full current header row is:

```
Id  Bokføringsdag  Handelsdag  Oppgjørsdag  Portefølje  Transaksjonstype
Verdipapir  ISIN  Antall  Kurs  Rente  Totale Avgifter  Valuta  Beløp
Valuta  Kjøpsverdi  Valuta  Resultat  Valuta  Totalt antall  Saldo
Vekslingskurs  Transaksjonstekst  Makuleringsdato  Sluttseddelnummer
Verifikationsnummer  Kurtasje  Valuta  Valutakurs  Innledende rente
```

Note there are **five separate `Valuta` columns** — one after each money
column (`Totale Avgifter`, `Beløp`, `Kjøpsverdi`, `Resultat`,
`Kurtasje`). The parser resolves the ambiguity by taking the `Valuta`
column **immediately to the right of `Beløp`** as the cash-amount
currency.

Columns the portal actually reads:

| Header                | Type    | Example          | Notes                                    |
| --------------------- | ------- | ---------------- | ---------------------------------------- |
| `Id`                  | string  | `2583783747`     | Nordnet's row id. Required.              |
| `Bokføringsdag`       | date    | `2026-06-22`     | Booking date.                            |
| `Handelsdag`          | date    | `2026-06-22`     | Trade date. Used for ordering.           |
| `Oppgjørsdag`         | date    | `2026-06-24`     | Settlement date.                         |
| `Transaksjonstype`    | enum    | `KJØPT`          | See enum table below.                    |
| `Verdipapir`          | string  | `Tomra Systems`  | Security name. Free text — variants are reconciled via ISIN. |
| `ISIN`                | string  | `NO0012470089`   | **The stable security key.** Drives Securities seeding and ticker resolution. |
| `Antall`              | number  | `398`            | Quantity (shares).                       |
| `Kurs`                | number  | `96,85`          | Per-unit price (decimal comma).          |
| `Totale Avgifter`     | number  | `29`             | Fees.                                    |
| `Beløp`               | number  | `38517,3`        | Cash amount. Negative = outflow.         |
| `Valuta` (after Beløp)| string  | `NOK`            | Currency of `Beløp`.                     |
| `Saldo`               | number  | `128485,83`      | Running balance (NOK).                   |
| `Vekslingskurs`       | number  | `1,0089`         | FX rate when foreign trade.              |
| `Transaksjonstekst`   | string  | `FÖRSÄLJNING …`  | Free-text notes.                         |

Ignored by the portal (kept in the tab, harmless): `Portefølje`
(account id), `Rente`, `Kjøpsverdi`, `Resultat` (+ their `Valuta`
columns), `Totalt antall`, `Makuleringsdato`, `Sluttseddelnummer`,
`Verifikationsnummer`, `Kurtasje`, `Valutakurs`, `Innledende rente`.

### `Transaksjonstype` enum

The portfolio engine treats types differently:

| Type           | Effect on portfolio                                          |
| -------------- | ------------------------------------------------------------ |
| `KJØPT`        | Buy. Adds qty, increases cost basis.                         |
| `SALG`         | Sell. Reduces qty, realizes P/L vs. avg cost.                |
| `UTBYTTE`      | Dividend. Adds to dividends bucket.                          |
| `KUPONGSKATT`  | Withholding tax on dividend. Adds to dividends bucket.       |
| `INNSKUDD`     | Deposit. Adds to dry powder, split evenly across investors.  |
| `UTTAK`        | Withdrawal. Reduces dry powder.                              |
| `BYTTE`        | Corporate action — share swap. Moves qty, **no cost reset**. |
| `SPLITT`       | Split. Moves qty, no cost reset.                             |
| (anything else)| Ignored by the calculator.                                   |

The `BYTTE` / `SPLITT` rule is deliberate: replaying these as cost
events would zero out the original basis on spinoffs (e.g. Kongsberg
Maritime out of Kongsberg Gruppen). Cost basis is preserved by intent.

----

## 2. `Securities` — security master (NEW)

Created and seeded by the Apps Script (`setupTabs`). Header-keyed,
order-tolerant. One row per security ever traded.

| Header     | Type   | Example        | Notes                                                        |
| ---------- | ------ | -------------- | ------------------------------------------------------------ |
| `ticker`   | string | `EQNR.OL`      | Yahoo-style symbol. StockPrices column key. Required to price.|
| `name`     | string | `Equinor`      | Canonical display name.                                       |
| `aliases`  | string | `equinor;EQNR` | `;`-separated Nordnet display-name variants.                  |
| `isin`     | string | `NO0010096985` | Optional.                                                     |
| `currency` | string | `NOK`          | The ticker's native quote currency.                           |
| `exchange` | string | `OSL`          | Informational; GF symbol derives from it when needed.         |
| `source`   | enum   | `yahoo`        | `yahoo` (Oslo Børs) or `googlefinance` (STO/ETR/FX).          |
| `status`   | enum   | `held`         | `held` / `sold` / `expired`. Maintained by the script.        |
| `soldDate` | date   | `2026-05-02`   | Set when the replay hits qty 0; drives the 6-month tail.      |
| `notes`    | string |                | Free text. `REVIEW` marks unmapped seeds; `gf=EXCH:SYM` overrides the GF symbol. |

## 3. `StockPrices` — daily close matrix (NEW)

Written exclusively by the Apps Script. Row 1 is the header:
`date | <ticker…> | CUR:USDNOK | CUR:SEKNOK | …`. One row per fetched
date (`yyyy-mm-dd`), values are closes in the ticker's **native
currency**; FX pairs are ordinary columns. Held stocks get a value per
trading day; sold stocks weekly until 6 months after the sale. Holes are
fine — the portal forward-fills every lookup. Never put formulas here.

## 4. `Beholdningsverdi` — RETIRED

The manual holdings snapshot is no longer maintained. The portal reads
it only as a fallback while `StockPrices` is empty (set `TABS.holdings`
to `null` in config.js to stop fetching it). Quantity and cost basis are
derived by replaying `Rådata fra nordnet`: quantity moves on every
BUY/SELL-classified type including corporate actions (`BYTTE`,
`SPLITT`), cost moves only on `KJØPT` and realizing sells — so a split
halves average cost implicitly and a spinoff parent keeps its basis.

## 5. `Offisielle nøkkeltall` — per-stock KPIs

Per-company × per-period fundamentals, one row per (company, period). The
sheet is **header-driven**: the parser finds the column-name row (the one
containing `Period` + `Selskap`, which may sit a row or two down behind
stylistic header rows) and maps columns by name, so column order can change.

| Header              | Field           | Type         | Notes                                              |
| ------------------- | --------------- | ------------ | -------------------------------------------------- |
| `Period`            | `period`        | string       | `2025`, `Q1 2026`, …                               |
| `Selskap`           | `company`       | string       | Company name (matched via `canonicalName`).        |
| `Val.`              | `currency`      | string       | Reporting currency.                                |
| `Antall`            | `shares`        | number       | Your number of shares.                             |
| `Aksjer ute (mill)` | `sharesOut`     | number       | Shares outstanding, millions.                      |
| `Offisiell Revenue` | `revenue`       | string (raw) | Official revenue (carries units).                  |
| `Offisiell EAT (Oper.)` | `eat`       | string (raw) | Official earnings after tax / operating.           |
| `Kurs NOK/val`      | `fxRate`        | number       | FX rate, NOK per reporting currency.               |
| `Din Rev (NOK)`     | `yourRevNok`    | number       | **Your share of revenue, final NOK.**              |
| `Din EAT Q1 (NOK)`  | `yourProfitNok` | number       | **Your share of profit, final NOK.**               |
| `Kurs i dag`        | `priceToday`    | number       | Current price.                                     |
| `Verdi NOK`         | `valueNok`      | number       | Your holding value, NOK.                           |
| `EPS TTM`           | `eps`           | string (raw) | Trailing-twelve-month EPS.                         |
| `P/E`               | `pe`            | number       | Indicative P/E.                                    |
| `Merknad`           | `note`          | string       | Free-text per-company comment (shown in the report).|

The portal does **no** FX/unit math — `yourRevNok` / `yourProfitNok` /
`valueNok` are taken as the final NOK numbers entered in the sheet. The
Portfolio report (`portfolio-report.html`) uses the latest period per
company, compares periods where more than one exists, and renders the
`Merknad` comments.

---

## 6. `Dim-values` — default attribution + ownership overrides

Maps each security to the investor(s) who own it, and at what weight.
Five investors share one Nordnet account, so every transaction needs to
be split into per-investor shares.

| Pos | Field              | Type    | Example       | Notes                                                                                                            |
| --- | ------------------ | ------- | ------------- | ---------------------------------------------------------------------------------------------------------------- |
| A   | `Name`             | string  | `Equinor`     | Must match `Verdipapir` (transactions) and `security` (holdings).                                                 |
| B   | `Investor`         | string  | `HH/HS`       | One investor code, or several joined by `/` or `+`. Special: `Deposit`, `NA`, `Alle`.                            |
| C   | `Investment factor`| number  | `0.5`         | Per-investor share. If empty, defaults to `1 / count(members in cell B)`. So `HH/HS` with empty C ⇒ 0.5 each.    |
| D   | `UpdatedAt`        | string  | `2026-05-15…` | ISO timestamp. Written by the portal when admin edits this row.                                                  |
| E   | `UpdatedBy`        | string  | `hh@…`        | Email of the editor. Written by the portal.                                                                      |

Special values for column B:
- `Deposit` — money entering or leaving the shared cash pool. Split
  evenly across all investors at runtime.
- `NA` or blank — security not attributed to anyone. Won't appear in
  any investor's per-portfolio view.
- `Alle` (Norwegian for "all") — every investor at equal weight.

**Admin tab writes here.** Editing a security's owners in the portal's
Admin page updates row D + E on the matching row of this tab.

---

## 7. `Members` — user accounts

Maps Google accounts to investor codes and roles. This is the **auth
allowlist**: a Google account that signs in but isn't in this tab gets
a "not authorized" message.

The header row is required; columns are read by case-insensitive
header lookup, so order doesn't matter.

| Header         | Type    | Example                 | Notes                                |
| -------------- | ------- | ----------------------- | ------------------------------------ |
| `email`        | string  | `someone@example.com`   | Lowercased before lookup. Required.  |
| `investorcode` | string  | `HH`                    | Two-letter code used everywhere.     |
| `displayname`  | string  | `Investor One`          | Friendly name for the UI.            |
| `role`         | enum    | `admin` / `member`      | `admin` unlocks the Admin tab.       |

To add a new investor: create the row, then share the underlying sheet
with their Google account as Editor.

---

## 8. `Competitions` — competition metadata

One row per competition. Created via the Competitions page in the
portal; the row is appended at the bottom of this tab.

| Header           | Type    | Notes                                                                       |
| ---------------- | ------- | --------------------------------------------------------------------------- |
| `Id`             | string  | Internal id, format `c_XXXXXX`. Primary key.                                |
| `Name`           | string  | Display name.                                                               |
| `StartDate`      | date    | Competition window start.                                                   |
| `EndDate`        | date    | Competition window end.                                                     |
| `CreatedBy`      | string  | Email of creator.                                                           |
| `CreatedAt`      | string  | ISO timestamp.                                                              |

Column order matters: `createCompetition` appends rows positionally, so
the header row above must stay in this exact order.

Delete: removing a competition in the portal hard-deletes its row here
and cascades to its rows in `Competition_Participants` (matched by
competition id).

The presentation mode generates all of its copy from the competition
data and standings — there is no per-competition narrative override field.

---

## 9. `Competition_Participants` — who's in each competition

Read by **position** (no header parsing).

| Pos | Field           | Type    | Notes                                                                       |
| --- | --------------- | ------- | --------------------------------------------------------------------------- |
| A   | `competition_id`| string  | FK to `Competitions.Id`.                                                    |
| B   | `investor_code` | string  | FK to `Members.investorcode`.                                               |
| C   | `team_label`    | string  | Free text. Same label across multiple rows = team. Empty = solo participant.|
| D   | `buy_in_nok`    | number  | Stake amount for this participant.                                          |

A team competition is expressed by giving multiple participant rows
the same `team_label` (e.g. two rows with `team_label = "JC+ØS"`).
Solo participants get a unique `team_label` per row (typically just
their own code).

A participant's competition score is derived from their actual Nordnet
transactions inside the competition window — only new buys made during
the window count.

---

## Quick replication checklist

To stand up a sheet from scratch:

1. Create a new Google Sheet.
2. Add the seven tabs above with their headers (positional tabs only
   need the first header row to exist — the parser skips it).
3. Share with the service email pattern your OAuth client uses, or
   directly with the investors' Google accounts.
4. Copy the Sheet ID into `docs/js/config.js` (`SHEET_ID`).
5. Adjust `TABS` in `docs/js/config.js` if you renamed any tab.
6. Seed `Members` with at least one row, role `admin`, before signing
   in for the first time.
