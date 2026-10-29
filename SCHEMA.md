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
| `aliases`  | string | `equinor;EQNR` | `;`-separated Nordnet display-name variants. A retired **ISIN** here merges that era into this row (re-listings, ticker changes). |
| `isin`     | string | `NO0010096985` | Optional.                                                     |
| `currency` | string | `NOK`          | The ticker's native quote currency.                           |
| `exchange` | string | `OSL`          | Informational; GF symbol derives from it when needed.         |
| `source`   | enum   | `yahoo`        | `yahoo` (Oslo Børs) or `googlefinance` (STO/ETR/FX).          |
| `status`   | enum   | `held`         | `held` / `sold` / `expired` (script-maintained) / `ignore` (manual: excluded from fetching AND from portal holdings — expired subscription rights, acceptance lines) / `delisted` (manual: bankrupt or struck off; not fetched, and the calculated books value it at 0 at year-end). The script never overwrites `ignore` or `delisted`. |
| `soldDate` | date   | `2026-05-02`   | Set when the replay hits qty 0; drives the 6-month tail.      |
| `notes`    | string |                | **Script-maintained health message** (empty = healthy; `REVIEW`/`⚠ fetch failed`/`expired`); a manual `gf=EXCH:SYM` token is preserved. |
| `lastChecked` | string | `2026-08-27 18:02` | Stamped on every row each `dailyFetch` run — when the script last evaluated it. |

## 3. `StockPrices` — daily close matrix (NEW)

Written exclusively by the Apps Script. Row 1 is the header:
`date | <ticker…> | CUR:USDNOK | CUR:SEKNOK | … | IDX:OSEBX`. One row per fetched
date (`yyyy-mm-dd`), values are closes in the ticker's **native
currency**; FX pairs are ordinary columns, and so is `IDX:OSEBX` (the Oslo
Børs index level; optional, the portal hides its OSEBX benchmark without it). Held stocks get a value per
trading day; sold stocks weekly until 6 months after the sale. Holes are
fine — the portal forward-fills every lookup. Never put formulas here.

## 4. `Beholdningsverdi` — RETIRED

The manual holdings snapshot is fully retired: the portal neither
fetches nor reads it (keep or delete the tab as you wish). Quantity and
cost basis are derived by replaying `Rådata fra nordnet`: quantity moves
on every BUY/SELL-classified type including corporate actions (`BYTTE`,
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
| `Kurs NOK/rapp.val` | `fxRate`        | number       | FX: NOK per reporting-currency unit (revenue/EAT). |
| `Kurs NOK/kursval`  | `fxPrice`       | number       | FX: NOK per unit of the currency the share price + EPS TTM are quoted in. |
| `Din Rev (NOK)`     | `yourRevNok`    | number       | **Your share of revenue, final NOK.**              |
| `Din EAT Q1 (NOK)`  | `yourProfitNok` | number       | **Your share of profit, final NOK.**               |
| `Kurs i dag`        | `priceToday`    | number       | Current price.                                     |
| `Verdi NOK`         | `valueNok`      | number       | Your holding value, NOK.                           |
| `EPS TTM`           | `eps`           | string (raw) | Trailing-twelve-month EPS.                         |
| `P/E`               | `pe`            | number       | Indicative P/E.                                    |
| `P/B`               | `pb`            | number       | Price/book — drives look-through book value (MV ÷ P/B). |
| `P/S`               | `ps`            | number       | Price/sales (shown in drill-downs + look-through). |
| `Merknad`           | `note`          | string       | Free-text per-company comment (shown in the report).|
| `BVPS` *(optional)* | `bvps`          | string (raw) | Book value (bokført egenkapital) per share, e.g. `1,10 EUR` or `45,20 NOK`. Drives P/B and look-through book value on the dashboard; rows without it show —. Header matched on `BVPS`/`bokført`. |

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

## Accounting sheet: optional `Aliases` tab

Lives in the accounting sheet (not the portfolio sheet). One row per way a
member appears in the bank text. Header row with `code` and `alias`; the order
of other columns does not matter, rows with a blank cell are skipped.

| code | alias |
|---|---|
| Investor code, as in `Members` | Name as it reads in the DNB text, any case |

Used by the "Test the rules against the books" panel to recognise payers (a
name with one typo is still matched and marked for review). Without the tab
the `displayName` values of `Members` are used. A payer that matches nobody is
never booked automatically. Use full names as aliases: a bank text that contains every word of an alias counts as that member. An empty `Aliases` tab is used as is (the `Members` names are not added).

---

## One sheet: `DNB_raw` and `Accounting inputs` in the portfolio sheet

The books are calculated from this sheet, so the accountant's separate workbook is optional (see "The switch" below). The Accounting tab and the Board read:

- **`DNB_raw`**: the bank export (`Year`, `Bokført dato`, `Transaksjonstype`, `Forklarende tekst`, `Ut`, `Inn`). The first year in it is the first calculated year.
- **`Aliases`** (optional, see above): from this sheet when it is here.
- **Nordnet rows**: from `Rådata fra nordnet`, which the portal already loads, instead of a `Nordnet_raw` copy. The portal also calculates the `Nordnet YY` figures from it (cost, value at 31.12 from `StockPrices`, unrealised and realised gain, dividends per security). Cost is FIFO per ISIN, as the books; the `Kjøpsverdi` column is read for spin-offs.
- **`Accounting inputs`** (new, optional): what raw data cannot give the calculated books. Column A is the kind, the kind's columns follow, and the last column is a free note. Rows starting with `#`, blank rows and a title row are skipped.

| Kind (A) | Columns B, C, D, E | Meaning |
|---|---|---|
| `IB` | account, amount | Opening balance for the first calculated year, from the accountant's last closed SB (debit +, credit −). |
| `DECIDE` | date, amount, account | A bank line the rules cannot decide: book it to this account. Matched on date and amount. |
| `SPLIT` | security, share (0-1), parent, cost | A spin-off (`UTSKILLING FISJON IN`): the share of the parent's cost that moves to the new security. Give a cost in column D instead of a share when the accountant typed an amount. Without a SPLIT row the portal uses Nordnet's `Kjøpsverdi` and flags it. Security and parent may be names or ISINs. |
| `REALISE` | security, year, (no) | Writes off what is left of a holding at 31.12 of that year (a worthless holding with no Nordnet row). A redemption (`INNLØSN. UTTAK VP`) is realised in its year by default; `no` in column C keeps that year's redemption unrealised instead. |
| `ENTRY` | year, account, debet, kredit | The accountant's year-end entries (tax, accruals, corrections). Each year's rows must balance. |
| `PRICE` | security, year, price | The 31.12 price per share in NOK the books use (from the year-end statement), in place of `StockPrices`. Security may be a name or an ISIN. It also fills a missing price. |

**Books or Calculated.** The Accounting tab works out the books for every year from the first year in `DNB_raw`, which opens with the `IB` rows. Each later year opens with the year before's close. With the accountant's workbook set, a **Books / Calculated** switch picks which one the year page shows, and "Calculated vs the books" compares UB per account to the krone ("N of M accounts match"). The SB and HB CSV buttons export whichever one is shown.

How the calculated books are put together (one year):

- **HB**: the bank vouchers `BA1, BA2, …` (from `DNB_raw`, the bank rules and `DECIDE` rows), one voucher per Nordnet row of the year `NN1, NN2, …`, the revaluation at 31.12 (`GLV`), write-offs from `REALISE` (`GLR`), and the `ENTRY` rows (`GLM<row>`).
- **Nordnet postings**: dividend 1921/8071, withholding 8071/1921, interest 8150/1921, platform fee 8179/1921, a buy 1810/1921, and a sale or redemption 1921 proceeds / 1810 cost / 8078 gain or 8178 loss. Deposits are booked from the bank side (DNB → 1921). A deposit after the last DNB line is booked against 1920 provisionally and flagged.
- **Revaluation**: 1811/8080 for the gross unrealised gains at 31.12 and 1812/8100 for the losses, booked as the change from IB.
- **The 31.12 price**: the last trading-day close on or before 31.12 in `StockPrices`, in NOK with the FX rate of the same day, and never a later price. A security the market no longer quotes uses the club's own last trade price. A `PRICE` row overrides both. "Nordnet <year>, calculated" shows each holding's price, its date and its source, and a price older than 24.12 is listed under "to check".
- **SB**: IB plus the year's movement. UB is before the result transfer, as in the books' SB. The next year opens with this UB, and the result moves to 2050. The first year's IB comes from the `IB` rows.

### Typing the rows

- **One row per input, columns A to F:** A = kind, B to E = the kind's columns in the order above, F = a free note. Leave a column empty when the kind has fewer.
- **Decimal comma.** The sheet uses the Norwegian locale, so type `25,7`, not `25.7`. A dotted decimal can turn into a date (25 July), which reaches the portal as a day number near 46 000. A PRICE row far from that day's close, or one that looks like a date, is listed under "to check".
- **Pasting many rows:** paste them into column A with `|` between the columns, then choose **Data → Split text to columns** with the custom separator `|`.
- **A bankrupt or struck-off holding:** set its `status` to `delisted` in `Securities` (section 2). The year-end value is then 0, with no PRICE row needed.

### The switch, and undoing it

`ACCOUNTING_SHEET_ID` in `docs/js/config.js` names the accountant's workbook.
- **Empty:** the portal reads only this sheet. The Accounting tab shows the calculated books, labelled "not accountant-reviewed", and the Board's "Accounting result" is the latest closed year's calculated result.
- **Set to the workbook's id:** the Accounting tab gets the **Books / Calculated** switch and the per-account comparison back, and the Board shows the accountant's result.

Example (columns A to F):

```
A        B           C        D      E      F (note)
IB       1920        12000
IB       2250        -12000
DECIDE   2031-03-01  250      7798          yearly LEI fee
ENTRY    2031        8300     500           tax estimate
ENTRY    2031        2500             500   tax estimate
```

Accounts must be NS 4102 (1000-8999). A row that does not make sense (unknown kind, not an account, a bad date, a year whose entries do not balance) is not used, and it shows as **To do** in the Accounting tab's year-end checklist with the reason.

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
