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
Nordnet → "Last ned transaksjoner". The parser keys columns by **header
name**, so column order can change without breaking anything as long as
the headers stay.

| Header                | Type    | Example         | Notes                                    |
| --------------------- | ------- | --------------- | ---------------------------------------- |
| `Id`                  | string  | `12345678`      | Nordnet's row id. Required.              |
| `Bokføringsdag`       | date    | `2025-03-04`    | Booking date.                            |
| `Handelsdag`          | date    | `2025-03-03`    | Trade date. Used for ordering.           |
| `Oppgjørsdag`         | date    | `2025-03-05`    | Settlement date.                         |
| `Transaksjonstype`    | enum    | `KJØPT`         | See enum table below.                    |
| `Verdipapir`          | string  | `Equinor`       | Security name. Free text, normalized.    |
| `ISIN`                | string  | `NO0010096985`  | Optional.                                |
| `Antall`              | number  | `100`           | Quantity (shares).                       |
| `Kurs`                | number  | `345.5`         | Per-unit price.                          |
| `Totale Avgifter`     | number  | `99`            | Fees.                                    |
| `Beløp`               | number  | `-34649`        | Cash amount. Negative = outflow.         |
| `Valuta`              | string  | `NOK`           | Should sit immediately right of `Beløp`. |
| `Saldo`               | number  | `12345.67`      | Running balance.                         |
| `Vekslingskurs`       | number  | `10.85`         | FX rate when foreign trade.              |
| `Transaksjonstekst`   | string  | `Ord 12345`     | Free-text notes.                         |

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

---

## 2. `Beholdningsverdi` — current holdings

A snapshot of currently-held positions. One row per security per
snapshot date. The portal uses the **latest snapshot date** as the
source of truth for current qty and price. Columns are read by
**position**, not header — keep this order.

| Pos | Field          | Type   | Example       |
| --- | -------------- | ------ | ------------- |
| A   | `snapshotDate` | date   | `2026-05-15`  |
| B   | `security`     | string | `Equinor`     |
| C   | `currency`     | string | `NOK`         |
| D   | `qty`          | number | `100`         |
| E   | `gav`          | number | `298.4`       |
| F   | (unused)       | —      | —             |
| G   | `currentPrice` | number | `345.5`       |
| H   | `marginValue`  | number | `0`           |
| I   | `marketValue`  | number | `34550`       |
| J   | `returnPct`    | number | `15.81`       |
| K   | `returnNok`    | number | `4710`        |

Header row is required (it's skipped), but the labels themselves are
not parsed.

---

## 3. `Offisielle nøkkeltall` — per-stock KPIs

Per-year fundamentals for each held security. The header occupies
rows 1–3 (yes, three rows — they were stylistic in the original
sheet); data starts at **row 4**. Columns by position:

| Pos | Field          | Type            | Example         |
| --- | -------------- | --------------- | --------------- |
| A   | `year`         | number          | `2024`          |
| B   | `company`      | string          | `Equinor`       |
| C   | `revenue`      | string (raw)    | `1 089 000 MUSD`|
| D   | `ourShareRev`  | number          | `0.0001`        |
| E   | `eat`          | string (raw)    | `8 700 MUSD`    |
| F   | `ourShareEat`  | number          | `0.0001`        |
| G   | `price`        | string (raw)    | `345.5`         |
| H   | `eps`          | string (raw)    | `23.4`          |
| I   | `pe`           | number          | `14.8`          |

The raw-string columns (revenue, EAT, price, EPS) are passed through
verbatim so they can carry units (`MUSD`, `MNOK`). The portal does not
do unit math on these — they're displayed as-is in the data inspector.

---

## 4. `Dim-values` — default attribution + ownership overrides

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

## 5. `Members` — user accounts

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

## 6. `Competitions` — competition metadata

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

The 7-slide presentation mode generates all of its copy from the
competition data and standings — there is no per-competition narrative
override field.

---

## 7. `Competition_Participants` — who's in each competition

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
