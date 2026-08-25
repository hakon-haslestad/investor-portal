// Pure parser functions for the portal's Google Sheet tabs.
// Ported from src/excel/normalizer.js + src/parsers/workbook.js + src/excel/manual-attribution.js.
// No DOM, no fetch — just (sheetMap → JS objects). Safe to unit-test.

(function () {
  const INVESTOR_CODES = ['HH', 'HS', 'ØS', 'JC', 'HF'];

  // ─── Normalizer ──────────────────────────────────────────────────────────

  function normalizeInvestorCode(raw) {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!s) return null;
    if (s === 'ØF') return 'ØS';
    if (s === 'OS') return 'ØS';
    return s;
  }

  function normalizeSecurityName(raw) {
    if (raw == null) return null;
    return String(raw).trim() || null;
  }

  function parseMemberCell(cell) {
    if (cell == null) return [];
    const s = String(cell).trim();
    if (!s) return [];
    if (s === 'Deposit' || s === 'NA' || s === 'Alle') return [{ code: s, weight: 1.0 }];
    const codes = s.split(/[\/+]/).map(normalizeInvestorCode).filter(Boolean);
    if (!codes.length) return [];
    const weight = 1.0 / codes.length;
    return codes.map((c) => ({ code: c, weight }));
  }

  // Returns the calendar date as YYYY-MM-DD. Timezone-stable: a date cell must
  // render as the day shown in the sheet regardless of the viewer's timezone.
  // (The old code ran local-parsed dates through toISOString(), which shifts a
  // local-midnight date to the previous UTC day for viewers east of UTC.)
  function excelDateToISO(v) {
    if (v == null || v === '') return null;
    const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : ymd(v);
    if (typeof v === 'number') {
      // Google Sheets serial: day 0 = 1899-12-30. The integer part is the
      // calendar day; floor() drops any time component so it never drifts.
      const ms = Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000;
      return new Date(ms).toISOString().slice(0, 10);
    }
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

    // Norwegian / English month-name text, e.g. "19.jun. 2026", "19. juni 2026",
    // "1 mars 2026". Keyed by the first 3 letters of the month (NB + EN).
    const MONTHS = {
      jan: 1, feb: 2, mar: 3, apr: 4, mai: 5, may: 5, jun: 6,
      jul: 7, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, des: 12, dec: 12,
    };
    const nm = s.toLowerCase().match(/^(\d{1,2})[.\s]*([a-zæøå]{3,})[.\s]*(\d{4})$/);
    if (nm) {
      const mon = MONTHS[nm[2].slice(0, 3)];
      if (mon) return `${nm[3]}-${String(mon).padStart(2, '0')}-${nm[1].padStart(2, '0')}`;
    }
    // Numeric day-first, e.g. "19.06.2026" or "19/06/2026".
    const dmy = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
    if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;

    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return ymd(d);
    return null;
  }

  function numOrNull(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const n = Number(String(v).replace(/\s/g, '').replace(/,/g, '.'));
    return Number.isFinite(n) ? n : null;
  }

  // ─── Tab parsers ─────────────────────────────────────────────────────────

  function parseTransactions(rows) {
    if (!rows || rows.length < 2) return [];
    const header = rows[0];
    const idx = {
      id: header.indexOf('Id'),
      book: header.indexOf('Bokføringsdag'),
      trade: header.indexOf('Handelsdag'),
      settle: header.indexOf('Oppgjørsdag'),
      type: header.indexOf('Transaksjonstype'),
      sec: header.indexOf('Verdipapir'),
      isin: header.indexOf('ISIN'),
      qty: header.indexOf('Antall'),
      price: header.indexOf('Kurs'),
      fee: header.indexOf('Totale Avgifter'),
      amount: header.indexOf('Beløp'),
      saldo: header.indexOf('Saldo'),
      fx: header.indexOf('Vekslingskurs'),
      text: header.indexOf('Transaksjonstekst'),
    };
    const currencyCol = idx.amount >= 0 && header[idx.amount + 1] === 'Valuta'
      ? idx.amount + 1
      : header.indexOf('Valuta');

    const txs = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row[idx.id] == null) continue;
      txs.push({
        sourceRow: r + 1,
        nordnetId: row[idx.id] != null ? String(row[idx.id]) : null,
        bookDate: excelDateToISO(row[idx.book]),
        tradeDate: excelDateToISO(row[idx.trade]),
        settleDate: excelDateToISO(row[idx.settle]),
        type: row[idx.type] ? String(row[idx.type]).trim() : null,
        security: normalizeSecurityName(row[idx.sec]),
        isin: row[idx.isin] ? String(row[idx.isin]).trim() : null,
        qty: numOrNull(row[idx.qty]),
        price: numOrNull(row[idx.price]),
        fee: numOrNull(row[idx.fee]),
        amount: numOrNull(row[idx.amount]),
        currency: currencyCol >= 0 ? (row[currencyCol] || null) : null,
        saldo: numOrNull(row[idx.saldo]),
        fxRate: numOrNull(row[idx.fx]),
        text: row[idx.text] ? String(row[idx.text]).trim() : null,
      });
    }
    return txs.sort((a, b) => (a.tradeDate || '').localeCompare(b.tradeDate || ''));
  }

  // Dim-values layout:
  //   A(0) Name   B(1) Investor (member string)   C(2) Investment factor
  //   D(3) UpdatedAt  (new — written by the portal)
  //   E(4) UpdatedBy  (new — written by the portal)
  function parseDimValues(rows) {
    const attributions = [];
    const meta = [];
    const seenAttr = new Set();
    const seenMeta = new Set();
    if (rows) {
      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        if (!row) continue;
        const name = normalizeSecurityName(row[0]);
        const member = row[1];
        const factor = numOrNull(row[2]);
        if (!name || !member) continue;
        const parsed = parseMemberCell(member);
        if (!parsed.length) continue;
        const weight = factor != null ? factor : parsed[0].weight;
        if (!seenMeta.has(name)) {
          seenMeta.add(name);
          meta.push({
            security: name,
            type: 'Stock', categoryTick: null,
            memberString: String(member).trim(),
            factor: weight,
            isin: null,
          });
        }
        for (const m of parsed) {
          const code = normalizeInvestorCode(m.code) || m.code;
          const key = `${name}|${code}`;
          if (seenAttr.has(key)) continue;
          seenAttr.add(key);
          attributions.push({ security: name, isin: null, investorCode: code, weight });
        }
      }
    }
    // Dim-values is the single source of truth for attribution.
    return { attributions, meta };
  }

  // Offisielle nøkkeltall is header-driven (the header spans the first rows;
  // the real column-name row is whichever one holds "Period" + "Selskap").
  // Columns: Period | Selskap | Val. | Antall | Aksjer ute (mill) |
  // Offisiell Revenue | Offisiell EAT (Oper.) | Kurs NOK/val | Din Rev (NOK) |
  // Din EAT Q1 (NOK) | Kurs i dag | Verdi NOK | EPS TTM | P/E | Merknad.
  // Din Rev / Din EAT are the user's share in final NOK (no FX/unit math here).
  function parseKpis(rows) {
    if (!rows || !rows.length) return [];
    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();

    // Locate the column-name row within the first few rows.
    let hi = -1;
    for (let i = 0; i < Math.min(rows.length, 5); i++) {
      const cells = (rows[i] || []).map(norm);
      if (cells.some((c) => c.includes('period')) && cells.some((c) => c.includes('selskap'))) { hi = i; break; }
    }
    if (hi < 0) return [];
    const header = (rows[hi] || []).map(norm);
    const find = (pred) => header.findIndex(pred);
    const idx = {
      period: find((c) => c.includes('period')),
      company: find((c) => c.includes('selskap')),
      currency: find((c) => c === 'val.' || c === 'val'),
      shares: find((c) => c.includes('antall')),
      sharesOut: find((c) => c.includes('aksjer ute')),
      revenue: find((c) => c.includes('revenue')),
      eat: find((c) => c.includes('eat') && (c.includes('oper') || c.includes('offisiell'))),
      fxRate: find((c) => c.includes('kurs') && c.includes('/val')),
      yourRevNok: find((c) => c.includes('din rev')),
      yourProfitNok: find((c) => c.includes('din eat')),
      priceToday: find((c) => c.includes('kurs i dag')),
      valueNok: find((c) => c.includes('verdi')),
      eps: find((c) => c.includes('eps')),
      pe: find((c) => c === 'p/e' || c.includes('p/e')),
      note: find((c) => c.includes('merknad')),
    };
    const at = (row, i) => (i >= 0 ? row[i] : null);
    const str = (v) => (v != null && String(v).trim() !== '' ? String(v).trim() : null);

    const out = [];
    for (let r = hi + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || at(row, idx.company) == null || String(at(row, idx.company)).trim() === '') continue;
      out.push({
        period: str(at(row, idx.period)) || '',
        company: String(at(row, idx.company)).trim(),
        currency: str(at(row, idx.currency)),
        shares: numOrNull(at(row, idx.shares)),
        sharesOut: numOrNull(at(row, idx.sharesOut)),
        revenue: str(at(row, idx.revenue)),
        eat: str(at(row, idx.eat)),
        fxRate: numOrNull(at(row, idx.fxRate)),
        yourRevNok: numOrNull(at(row, idx.yourRevNok)),
        yourProfitNok: numOrNull(at(row, idx.yourProfitNok)),
        priceToday: numOrNull(at(row, idx.priceToday)),
        valueNok: numOrNull(at(row, idx.valueNok)),
        eps: str(at(row, idx.eps)),
        pe: numOrNull(at(row, idx.pe)),
        note: str(at(row, idx.note)),
      });
    }
    return out;
  }

  function parseMembers(rows) {
    if (!rows || rows.length < 2) return [];
    const header = rows[0].map((h) => String(h || '').trim().toLowerCase());
    const idx = {
      email: header.indexOf('email'),
      code: header.indexOf('investorcode'),
      name: header.indexOf('displayname'),
      role: header.indexOf('role'),
    };
    const out = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || !row[idx.email]) continue;
      out.push({
        email: String(row[idx.email]).trim().toLowerCase(),
        investorCode: row[idx.code] ? String(row[idx.code]).trim() : null,
        displayName: row[idx.name] ? String(row[idx.name]).trim() : null,
        role: row[idx.role] ? String(row[idx.role]).trim() : 'member',
      });
    }
    return out;
  }

  window.Parsers = {
    INVESTOR_CODES,
    parseTransactions,
    parseDimValues,
    parseKpis,
    parseMembers,
    parseMemberCell,
    normalizeInvestorCode,
    normalizeSecurityName,
    excelDateToISO,
    numOrNull,
  };
})();
