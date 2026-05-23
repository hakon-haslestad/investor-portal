// Pure parser + aggregator functions for the konsolidert bookkeeping sheet.
// Read-only; mirrors the tab layout produced by build.py in the companion
// repo. Header row is detected (rather than hardcoded) so a future yearly
// rollover that adds a banner row above the headers doesn't break the page.

(function () {
  const { numOrNull, excelDateToISO } = window.Parsers;

  // Find the row index whose first non-empty cell equals one of `names`.
  // Returns -1 if no match. Lets parsers tolerate a variable preamble
  // (DNB_raw / Nordnet_raw / Nordnet_realisasjon all have 3 banner rows
  // above the actual header row; SB has the header at row 1; Bank YY has
  // a balance summary above the header at row 6).
  function findHeaderRow(rows, names) {
    const wanted = new Set(names.map((n) => String(n).toLowerCase()));
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r] || [];
      for (const cell of row) {
        if (cell == null) continue;
        if (wanted.has(String(cell).trim().toLowerCase())) return r;
      }
    }
    return -1;
  }

  function indexHeaders(headerRow) {
    const idx = {};
    (headerRow || []).forEach((h, i) => {
      if (h == null) return;
      const key = String(h).trim().toLowerCase();
      if (key && !(key in idx)) idx[key] = i;
    });
    return idx;
  }

  // ─── Saldobalanse (SB) ───────────────────────────────────────────────────
  // Header row 1: Kontonr | Kontonavn | IB | UB | ... | UB <prev-year>, før …
  // We only need UB for the current-year net check.
  function parseSaldobalanse(rows) {
    const headerRow = findHeaderRow(rows, ['Kontonr']);
    if (headerRow < 0) return [];
    const idx = indexHeaders(rows[headerRow]);
    const iKonto = idx['kontonr'];
    const iNavn = idx['kontonavn'];
    const iIb = idx['ib'];
    const iUb = idx['ub'];
    if (iKonto == null || iUb == null) return [];
    const out = [];
    for (let r = headerRow + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const kontonr = numOrNull(row[iKonto]);
      if (kontonr == null) continue;
      out.push({
        kontonr,
        kontonavn: row[iNavn] != null ? String(row[iNavn]).trim() : '',
        ib: numOrNull(row[iIb]),
        ub: numOrNull(row[iUb]),
      });
    }
    return out;
  }

  // ─── Hovedbok (HB) ───────────────────────────────────────────────────────
  // Header row 2: Kontonr | Kontonavn | Bilagsnr | Bilagsdato | Kommentar |
  //               Debet | Kredit | Saldo | <Status>
  function parseHovedbok(rows) {
    const headerRow = findHeaderRow(rows, ['Bilagsnr']);
    if (headerRow < 0) return [];
    const idx = indexHeaders(rows[headerRow]);
    const iKonto = idx['kontonr'];
    const iBilag = idx['bilagsnr'];
    const iDato = idx['bilagsdato'];
    const iDebet = idx['debet'];
    const iKredit = idx['kredit'];
    const out = [];
    for (let r = headerRow + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const bilag = row[iBilag];
      if (bilag == null || String(bilag).trim() === '') continue;
      out.push({
        kontonr: numOrNull(row[iKonto]),
        bilagsnr: String(bilag).trim(),
        date: excelDateToISO(row[iDato]),
        debet: numOrNull(row[iDebet]),
        kredit: numOrNull(row[iKredit]),
      });
    }
    return out;
  }

  // ─── DNB_raw ────────────────────────────────────────────────────────────
  // Header row 4: Year | Registreringsdato | Bokført dato | Rentedato |
  //               Transaksjonstype | Forklarende tekst | Ut | Inn | Arkivref. | …
  function parseDnbRaw(rows) {
    const headerRow = findHeaderRow(rows, ['Year']);
    if (headerRow < 0) return [];
    const idx = indexHeaders(rows[headerRow]);
    const iYear = idx['year'];
    const iBokfort = idx['bokført dato'];
    const iType = idx['transaksjonstype'];
    const iText = idx['forklarende tekst'];
    const iUt = idx['ut'];
    const iInn = idx['inn'];
    const iRef = idx['arkivref.'];
    const out = [];
    for (let r = headerRow + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const year = numOrNull(row[iYear]);
      if (year == null) continue;
      out.push({
        year,
        date: excelDateToISO(row[iBokfort]),
        type: row[iType] != null ? String(row[iType]).trim() : '',
        text: row[iText] != null ? String(row[iText]).trim() : '',
        ut: numOrNull(row[iUt]),
        inn: numOrNull(row[iInn]),
        arkivref: iRef != null ? row[iRef] : null,
      });
    }
    return out;
  }

  // ─── Nordnet_raw ────────────────────────────────────────────────────────
  function parseNordnetRaw(rows) {
    const headerRow = findHeaderRow(rows, ['Year']);
    if (headerRow < 0) return [];
    const idx = indexHeaders(rows[headerRow]);
    const iYear = idx['year'];
    const iBokf = idx['bokføringsdag'];
    const iHandel = idx['handelsdag'];
    const iType = idx['transaksjonstype'];
    const iSec = idx['verdipapir'];
    const iQty = idx['antall'];
    const iAmount = idx['beløp'];
    const out = [];
    for (let r = headerRow + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const year = numOrNull(row[iYear]);
      if (year == null) continue;
      out.push({
        year,
        date: excelDateToISO(row[iBokf]) || excelDateToISO(row[iHandel]),
        type: row[iType] != null ? String(row[iType]).trim() : '',
        security: row[iSec] != null ? String(row[iSec]).trim() : null,
        qty: numOrNull(row[iQty]),
        amount: iAmount != null ? numOrNull(row[iAmount]) : null,
      });
    }
    return out;
  }

  // ─── Nordnet_realisasjon ────────────────────────────────────────────────
  // Header row 4: Year | Verdipapir | Antall | Kjøpsdato | Salgsdato |
  //               Kjøpsbeløp NOK | Salgsbeløp NOK | Kjøpskostnader NOK |
  //               Salgskostnader NOK | Gevinst eller tap NOK
  function parseNordnetRealisasjon(rows) {
    const headerRow = findHeaderRow(rows, ['Year']);
    if (headerRow < 0) return [];
    const idx = indexHeaders(rows[headerRow]);
    const iYear = idx['year'];
    const iSec = idx['verdipapir'];
    const iQty = idx['antall'];
    const iSalgsdato = idx['salgsdato'];
    const iGevinst = idx['gevinst eller tap nok'];
    const out = [];
    for (let r = headerRow + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const year = numOrNull(row[iYear]);
      if (year == null) continue;
      out.push({
        year,
        security: row[iSec] != null ? String(row[iSec]).trim() : null,
        qty: numOrNull(row[iQty]),
        salgsdato: excelDateToISO(row[iSalgsdato]),
        gevinst: numOrNull(row[iGevinst]),
      });
    }
    return out;
  }

  // ─── Status aggregator ───────────────────────────────────────────────────
  // Produces the single object the page renders KPI cards from.
  function computeStatus({ sb, hb, dnb, nordnet, realisasjon, currentYear, wipTabName }) {
    const ubSum = (sb || []).reduce((acc, r) => acc + (r.ub || 0), 0);
    const bilagCount = (hb || []).length;
    const dnbThisYear = (dnb || []).filter((r) => r.year === currentYear);
    const nordnetThisYear = (nordnet || []).filter((r) => r.year === currentYear);
    const realisasjonThisYear = (realisasjon || []).filter((r) => r.year === currentYear);
    const realisasjonNet = realisasjonThisYear.reduce((a, r) => a + (r.gevinst || 0), 0);

    const dates = (arr) => arr.map((r) => r.date).filter(Boolean).sort();
    const lastDnb = dates(dnbThisYear).slice(-1)[0] || null;
    const lastNordnet = dates(nordnetThisYear).slice(-1)[0] || null;

    // The WIP tab name is stale whenever it still carries the legacy "(2)"
    // suffix from the source workbook. The PR description recommends
    // renaming it immediately post-upload ('SB, 24 (2)' → 'SB, 25') so
    // cross-sheet refs auto-update in Google Sheets. Once renamed, the
    // config points at the new name and this returns false.
    const wipIsStale = /\(2\)\s*$/.test(wipTabName || '');

    return {
      ubSum,
      bilagCount,
      lastDnb,
      lastNordnet,
      dnbCount: dnbThisYear.length,
      nordnetCount: nordnetThisYear.length,
      realisasjonCount: realisasjonThisYear.length,
      realisasjonNet,
      wipTabName,
      wipIsStale,
      wipExpectedName: wipIsStale ? `SB, ${String(currentYear).slice(-2)}` : null,
    };
  }

  window.Accounting = {
    parseSaldobalanse,
    parseHovedbok,
    parseDnbRaw,
    parseNordnetRaw,
    parseNordnetRealisasjon,
    computeStatus,
  };
})();
