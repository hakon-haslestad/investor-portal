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
    const iNavn = idx['kontonavn'];
    const iBilag = idx['bilagsnr'];
    const iDato = idx['bilagsdato'];
    const iKommentar = idx['kommentar'];
    const iDebet = idx['debet'];
    const iKredit = idx['kredit'];
    const out = [];
    for (let r = headerRow + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const bilag = row[iBilag];
      if (bilag == null || String(bilag).trim() === '') continue;
      out.push({
        kontonr: numOrNull(row[iKonto]),
        kontonavn: iNavn != null && row[iNavn] != null ? String(row[iNavn]).trim() : '',
        bilagsnr: String(bilag).trim(),
        date: excelDateToISO(row[iDato]),
        kommentar: iKommentar != null && row[iKommentar] != null ? String(row[iKommentar]).trim() : '',
        debet: numOrNull(row[iDebet]),
        kredit: numOrNull(row[iKredit]),
      });
    }
    return out;
  }

  // ─── DNB_raw ────────────────────────────────────────────────────────────
  // Header row 4: Year | Registreringsdato | Bokført dato | Rentedato |
  //               Transaksjonstype | Forklarende tekst | Ut | Inn | Arkivref. | …
  function absOrNull(n) { return n == null ? null : Math.abs(n); }

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
        // The bank's own export writes money out as a negative Ut; hand-made
        // sheets often write it positive. Every reader treats Ut and Inn as
        // amounts (out and in), so keep both positive here.
        ut: absOrNull(numOrNull(row[iUt])),
        inn: absOrNull(numOrNull(row[iInn])),
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

  // ─── Nordnet YY (per-stock, calc-engine tab) ────────────────────────────
  // Header row 4 starting at column D:
  //   Kostpris | Urealisert gevinst/tap | Markedsverdi | Realisert gevinst/tap | Utbytte
  // Security name lives one column to the left of Kostpris (no header label).
  function parseNordnetYear(rows) {
    const headerRow = findHeaderRow(rows, ['Kostpris']);
    if (headerRow < 0) return [];
    const idx = indexHeaders(rows[headerRow]);
    const iKost = idx['kostpris'];
    const iUreal = idx['urealisert gevinst/tap'];
    const iMv = idx['markedsverdi'];
    const iReal = idx['realisert gevinst/tap'];
    const iUtb = idx['utbytte'];
    if (iKost == null) return [];
    const iSec = iKost - 1; // security name is the cell immediately left of Kostpris
    const out = [];
    for (let r = headerRow + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const sec = row[iSec];
      if (sec == null || String(sec).trim() === '') continue;
      // A totals row would be counted twice in every sum over the tab.
      if (/^(sum|total|totalt|totalsum)\b/i.test(String(sec).trim())) continue;
      out.push({
        security: String(sec).trim(),
        kostpris: numOrNull(row[iKost]),
        urealisert: iUreal != null ? numOrNull(row[iUreal]) : null,
        markedsverdi: iMv != null ? numOrNull(row[iMv]) : null,
        realisert: iReal != null ? numOrNull(row[iReal]) : null,
        utbytte: iUtb != null ? numOrNull(row[iUtb]) : null,
      });
    }
    return out;
  }

  // ─── Year discovery ─────────────────────────────────────────────────────
  // Pattern-matches the live tab list to figure out which years exist:
  //   SB,YY / HB,YY / Nordnet YY        → year = 2000 + YY
  //   SB,YY (2) / HB,YY (2)             → year = 2000 + YY + 1  (legacy WIP)
  // Returns [{year, sb, hb, nordnet}] sorted year-desc, only entries where
  // both SB and HB exist (Nordnet may be absent for very old years).
  // If both 'SB, 25' and 'SB, 24 (2)' map to the same year, un-suffixed wins.
  function discoverYears(tabs) {
    const titles = (tabs || []).map((t) => (typeof t === 'string' ? t : t && t.title)).filter(Boolean);
    const byYear = new Map(); // year -> { sb, hb, nordnet, sbIsLegacy, hbIsLegacy }
    const ensure = (y) => {
      if (!byYear.has(y)) byYear.set(y, { sb: null, hb: null, nordnet: null, sbIsLegacy: true, hbIsLegacy: true });
      return byYear.get(y);
    };
    const reSb = /^SB,?\s*(\d{2})\s*$/i;
    const reHb = /^HB,?\s*(\d{2})\s*$/i;
    const reNo = /^Nordnet,?\s*(\d{2})\s*$/i;
    const reSbLegacy = /^SB,?\s*(\d{2})\s*\(2\)\s*$/i;
    const reHbLegacy = /^HB,?\s*(\d{2})\s*\(2\)\s*$/i;
    for (const t of titles) {
      let m;
      if ((m = reSb.exec(t))) {
        const y = 2000 + Number(m[1]);
        const e = ensure(y);
        // Un-suffixed name beats a previously-stored legacy '(2)' name.
        if (!e.sb || e.sbIsLegacy) { e.sb = t; e.sbIsLegacy = false; }
      } else if ((m = reHb.exec(t))) {
        const y = 2000 + Number(m[1]);
        const e = ensure(y);
        if (!e.hb || e.hbIsLegacy) { e.hb = t; e.hbIsLegacy = false; }
      } else if ((m = reNo.exec(t))) {
        const y = 2000 + Number(m[1]);
        ensure(y).nordnet = t;
      } else if ((m = reSbLegacy.exec(t))) {
        const y = 2000 + Number(m[1]) + 1;
        const e = ensure(y);
        if (!e.sb) { e.sb = t; e.sbIsLegacy = true; } // don't overwrite un-suffixed
      } else if ((m = reHbLegacy.exec(t))) {
        const y = 2000 + Number(m[1]) + 1;
        const e = ensure(y);
        if (!e.hb) { e.hb = t; e.hbIsLegacy = true; }
      }
    }
    const out = [];
    for (const [year, e] of byYear.entries()) {
      if (!e.sb || !e.hb) continue;
      out.push({ year, sb: e.sb, hb: e.hb, nordnet: e.nordnet });
    }
    out.sort((a, b) => b.year - a.year);
    return out;
  }

  // ─── Result per year (Board overview) ───────────────────────────────────
  // Result accounts are 3000-8999 (NS 4102). The SB books income as credit
  // (negative UB) and cost as debit, so the result is minus the UB sum:
  // positive = profit. Null when the SB has no result account to sum.
  function resultForYear(sb) {
    const rows = (sb || []).filter((r) => r.kontonr >= 3000 && r.kontonr <= 8999 && r.ub != null);
    if (!rows.length) return null;
    const sum = rows.reduce((a, r) => a + r.ub, 0);
    return { result: sum === 0 ? 0 : -sum, accounts: rows.length };
  }

  // Equity is the 2000-2099 accounts (NS 4102). They carry a credit balance
  // (negative UB), so equity is minus the UB sum: positive = equity. Null when
  // the SB has no equity account.
  function equityForYear(sb) {
    const rows = (sb || []).filter((r) => r.kontonr >= 2000 && r.kontonr <= 2099 && r.ub != null);
    if (!rows.length) return null;
    const sum = rows.reduce((a, r) => a + r.ub, 0);
    return { equity: sum === 0 ? 0 : -sum, accounts: rows.length };
  }

  // One-line reconciliation of the books' result with the realized gains the
  // year's Nordnet rows report. `other` is the difference (fees, interest,
  // dividends, timing). Null without a result or without Nordnet rows.
  function resultBridge(result, nordnetRows) {
    if (result == null || !(nordnetRows || []).length) return null;
    const realized = nordnetRows.reduce((a, r) => a + (r.realisert || 0), 0);
    return { realized, other: result - realized };
  }

  // The newest year (from discoverYears, newest first) that has ended before
  // `now` (an ISO date): a year still running is not closed. Null if none.
  function latestClosedYear(years, now) {
    const y = Number(String(now).slice(0, 4));
    return (years || []).find((e) => e.year < y) || null;
  }

  // ─── CSV download ───────────────────────────────────────────────────────
  // Universal RFC-4180 CSV with a UTF-8 BOM so Excel/macOS opens æøå
  // correctly. `rows` is [[header...], [val...], ...]. Numbers go through
  // as-is (dot decimal); dates assumed to be ISO strings already.
  // CSV text with a BOM for Excel. A text cell starting with = + - @ would be
  // run as a formula when opened, so it gets a leading apostrophe; numbers
  // (including negative ones) are left alone.
  function csvText(rows) {
    const escape = (v) => {
      if (v == null) return '';
      let s = String(v);
      if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !Number.isFinite(Number(s.replace(',', '.')))) s = "'" + s;
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return '\ufeff' + (rows || []).map((r) => (r || []).map(escape).join(',')).join('\r\n');
  }

  function downloadCsv(filename, rows) {
    const text = csvText(rows);
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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

  // ─── Year-end reconcile checklist ───────────────────────────────────────
  // Cross-checks the latest year's numbers against each other, using only what
  // is already in the sheet. Each row is Pass / Check / To do; a source that is
  // missing (tab absent, no rows for the year, account not in SB) is To do
  // with a reason, never an error. `dnbTab` / `nordnetTab` are the names of
  // the raw tabs when they exist and falsy when they do not.
  // `closed`: an older year. Its number checks still apply; the tab-name and
  // year-end-entry rows are for the year in progress only.
  function reconcile({ sb, dnb, nordnet, year, wipTabName, dnbTab, nordnetTab, closed = false, inputProblems = [] }) {
    const kr = (n) => (window.Fmt ? window.Fmt.fmtNok(n) : String(Math.round(n)) + ' kr');
    const sum = (arr, f) => arr.reduce((a, r) => a + (f(r) || 0), 0);
    const equal = (a, b) => Math.abs(a - b) < 1; // same tolerance as the SB net KPI
    const dnbYear = dnbTab ? (dnb || []).filter((r) => r.year === year) : [];
    const nnYear = nordnetTab ? (nordnet || []).filter((r) => r.year === year) : [];
    const rows = [];
    const add = (id, label, status, detail) => rows.push({ id, label, status, detail });
    // Movement on one SB account (UB - IB, debit positive), or null if absent.
    const movement = (kontonr) => {
      const hit = (sb || []).filter((r) => String(r.kontonr) === String(kontonr) && r.ub != null);
      return hit.length ? sum(hit, (r) => r.ub) - sum(hit, (r) => r.ib) : null;
    };
    const compare = (id, label, source, sourceName, account, sourceVal, expected) => {
      const mv = movement(account);
      if (!source.length) return add(id, label, 'todo', `No ${sourceName} rows for ${year}.`);
      if (sourceVal == null) return add(id, label, 'todo', `No amounts in ${sourceName} for ${year}.`);
      if (mv == null) return add(id, label, 'todo', `Account ${account} not found in SB ${year}.`);
      const diff = mv - expected;
      if (equal(mv, expected)) return add(id, label, 'pass', `${kr(expected)} in both.`);
      add(id, label, 'check', `Difference ${kr(diff)} (${sourceName} ${kr(expected)}, SB ${account} ${kr(mv)}).`);
    };

    const dnbNet = dnbYear.length ? sum(dnbYear, (r) => r.inn) - sum(dnbYear, (r) => r.ut) : null;
    compare('dnb-1920', 'DNB net vs SB 1920', dnbYear, 'DNB', 1920, dnbNet, dnbNet);
    // A redemption or subscription carries its money on a separate cash row
    // (INNL. VP LIKVID / TEGNING LIKVID); the securities row repeats the
    // amount, but Nordnet's Saldo does not move on it. Count the cash once.
    const NOT_CASH = ['INNLØSN. UTTAK VP', 'TEGNING INNLEGG VP'];
    const amounts = nnYear.filter((r) => r.amount != null && !NOT_CASH.includes(String(r.type || '').trim().toUpperCase()));
    const nnNet = amounts.length ? sum(amounts, (r) => r.amount) : null;
    compare('nordnet-1921', 'Nordnet cash vs SB 1921', nnYear, 'Nordnet', 1921, nnNet, nnNet);
    const dnbIn = dnbYear.length ? sum(dnbYear, (r) => r.inn) : null;
    compare('dnb-2250', 'DNB incoming vs SB 2250', dnbYear, 'DNB', 2250, dnbIn, dnbIn == null ? null : 0 - dnbIn);

    // Deposits Nordnet received should equal what DNB sent them.
    const deposits = sum(nnYear.filter((r) => String(r.type).trim().toUpperCase() === 'INNSKUDD'), (r) => r.amount);
    // Same Nordnet match as the bank rules (bank texts have typos); a plain
    // /nordnet/ missed a misspelt transfer and showed a false difference.
    const toNordnet = window.BankRules && window.BankRules.isNordnet
      ? (text) => window.BankRules.isNordnet(text || '') : (text) => /nordnet/i.test(text || '');
    const sentToNordnet = sum(dnbYear.filter((r) => toNordnet(r.text)), (r) => r.ut);
    if (!dnbYear.length || !nnYear.length) {
      add('transfers', 'Nordnet deposits vs DNB transfers', 'todo', `Needs both DNB and Nordnet rows for ${year}.`);
    } else if (equal(deposits, sentToNordnet)) {
      add('transfers', 'Nordnet deposits vs DNB transfers', 'pass', `${kr(deposits)} in both.`);
    } else {
      add('transfers', 'Nordnet deposits vs DNB transfers', 'check',
        `Difference ${kr(deposits - sentToNordnet)} (Nordnet ${kr(deposits)}, DNB out ${kr(sentToNordnet)}).`);
    }

    // Data should run to the end of the year: a row in its last 14 days.
    const cutoff = `${year}-12-18`;
    const lastDate = (arr) => arr.map((r) => r.date).filter(Boolean).sort().slice(-1)[0] || null;
    const dLast = lastDate(dnbYear);
    const nLast = lastDate(nnYear);
    if (!dLast || !nLast) {
      add('dates', 'Latest data dates', 'todo', `No dated DNB or Nordnet rows for ${year}.`);
    } else if (dLast >= cutoff && nLast >= cutoff) {
      add('dates', 'Latest data dates', 'pass', `DNB ${dLast}, Nordnet ${nLast}.`);
    } else if (closed && [['dnb-1920', dLast], ['nordnet-1921', nLast]].every(([id, last]) =>
      last >= cutoff || (rows.find((x) => x.id === id) || {}).status === 'pass')) {
      // A closed year whose cash already ties out simply had no late activity.
      const quiet = [dLast < cutoff ? `no DNB activity after ${dLast}` : '', nLast < cutoff ? `no Nordnet activity after ${nLast}` : ''].filter(Boolean).join(', ');
      add('dates', 'Latest data dates', 'pass', `DNB ${dLast}, Nordnet ${nLast} (${quiet}; the cash check matches).`);
    } else {
      add('dates', 'Latest data dates', 'check', `Data ends early: DNB ${dLast}, Nordnet ${nLast} (expected on or after ${cutoff}).`);
    }

    // Rows in the "Accounting inputs" tab that could not be used.
    inputProblems.forEach((p, i) => add(`inputs-${i}`, 'Accounting inputs', 'todo', p.reason));

    if (!closed) {
      const wip = computeStatus({ currentYear: year, wipTabName });
      add('wip-tab', 'Year tab name', wip.wipIsStale ? 'check' : 'pass',
        wip.wipIsStale ? `Tab is still "${wipTabName}", rename it to "${wip.wipExpectedName}".` : 'Tab name is current.');
      add('year-end', 'Year-end entries (tax, accruals, dividend)', 'todo', 'Not booked yet.');
    }

    const counts = { pass: 0, check: 0, todo: 0 };
    rows.forEach((r) => { counts[r.status] += 1; });
    return { rows, counts, text: `${counts.pass} pass, ${counts.check} to check, ${counts.todo} to do` };
  }

  window.Accounting = {
    parseSaldobalanse,
    parseHovedbok,
    parseDnbRaw,
    parseNordnetRaw,
    parseNordnetRealisasjon,
    parseNordnetYear,
    discoverYears,
    downloadCsv,
    csvText,
    computeStatus,
    resultForYear,
    equityForYear,
    resultBridge,
    latestClosedYear,
    reconcile,
  };
})();
