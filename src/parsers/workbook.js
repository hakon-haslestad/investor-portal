/**
 * Source-agnostic workbook parser. Consumes a `sheetMap` object of the form
 *   { '<sheet name>': rows2D, ... }
 * where rows2D is an array of arrays (header-row index 0).
 *
 * Sources (XLSX file, Google Sheets) materialize that map and hand it off.
 */
const {
  normalizeInvestorCode,
  normalizeSecurityName,
  parseMemberCell,
  excelDateToISO,
} = require('../excel/normalizer');
const { MANUAL_ATTRIBUTION } = require('../excel/manual-attribution');

const SHEET_NAMES = {
  transactions: 'Rådata fra nordnet',
  dim: 'Dim-values',
  holdings: 'Beholdningsverdi',
  kpis: 'Offisielle nøkkeltall',
};

function rowsOf(sheetMap, name) {
  return sheetMap[name] || [];
}

function parseTransactions(sheetMap) {
  const rows = rowsOf(sheetMap, SHEET_NAMES.transactions);
  if (rows.length < 2) return [];
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

function parseSecurityAttribution(sheetMap) {
  const rows = rowsOf(sheetMap, SHEET_NAMES.dim);
  const attributions = [];
  const meta = [];
  const seenAttr = new Set();
  const seenMeta = new Set();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const type = row[6] ? String(row[6]).trim() : null;
    const name = normalizeSecurityName(row[7]);
    const tick = row[8] ? String(row[8]).trim() : null;
    const member = row[9];
    const factor = numOrNull(row[10]);
    const isin = row[14] ? String(row[14]).trim() : null;
    if (!name || !member) continue;
    const parsed = parseMemberCell(member);
    if (!parsed.length) continue;
    const weight = factor != null ? factor : parsed[0].weight;
    if (!seenMeta.has(name)) {
      seenMeta.add(name);
      meta.push({
        security: name,
        type,
        categoryTick: tick,
        memberString: String(member).trim(),
        factor: weight,
        isin: isin || null,
      });
    }
    for (const m of parsed) {
      const code = normalizeInvestorCode(m.code) || m.code;
      const key = `${name}|${code}`;
      if (seenAttr.has(key)) continue;
      seenAttr.add(key);
      attributions.push({
        security: name,
        isin: isin || null,
        investorCode: code,
        weight,
        notes: member,
      });
    }
  }
  for (const [security, owners] of Object.entries(MANUAL_ATTRIBUTION)) {
    const memberCodes = owners.map((o) => o.code).join('/');
    if (!seenMeta.has(security)) {
      seenMeta.add(security);
      meta.push({
        security,
        type: 'Stock',
        categoryTick: null,
        memberString: memberCodes,
        factor: owners[0].weight,
        isin: null,
      });
    }
    for (const { code, weight } of owners) {
      const key = `${security}|${code}`;
      if (seenAttr.has(key)) continue;
      seenAttr.add(key);
      attributions.push({
        security,
        isin: null,
        investorCode: code,
        weight,
        notes: 'manual override',
      });
    }
  }
  return { attributions, meta };
}

function parseHoldings(sheetMap) {
  const rows = rowsOf(sheetMap, SHEET_NAMES.holdings);
  if (rows.length < 2) return [];
  const holdings = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row[1] == null) continue;
    const security = normalizeSecurityName(row[1]);
    if (!security) continue;
    holdings.push({
      snapshotDate: excelDateToISO(row[0]),
      security,
      isin: null,
      currency: row[2] ? String(row[2]).trim() : null,
      qty: numOrNull(row[3]),
      gav: numOrNull(row[4]),
      currentPrice: numOrNull(row[6]),
      marketValueNok: numOrNull(row[8]),
      marginValue: numOrNull(row[7]),
      returnPct: numOrNull(row[9]),
      returnNok: numOrNull(row[10]),
    });
  }
  return holdings;
}

function parseKpis(sheetMap) {
  const rows = rowsOf(sheetMap, SHEET_NAMES.kpis);
  if (rows.length < 4) return [];
  const out = [];
  for (let r = 3; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row[0] == null || row[1] == null) continue;
    out.push({
      year: numOrNull(row[0]),
      company: String(row[1]).trim(),
      revenue: row[2] != null ? String(row[2]) : null,
      ourShareRev: numOrNull(row[3]),
      eat: row[4] != null ? String(row[4]) : null,
      ourShareEat: numOrNull(row[5]),
      price: row[6] != null ? String(row[6]) : null,
      eps: row[7] != null ? String(row[7]) : null,
      pe: numOrNull(row[8]),
    });
  }
  return out;
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/\s/g, '').replace(/,/g, '.'));
  return Number.isFinite(n) ? n : null;
}

function parseAll(sheetMap) {
  const attrPack = parseSecurityAttribution(sheetMap);
  return {
    transactions: parseTransactions(sheetMap),
    attributions: attrPack.attributions,
    meta: attrPack.meta,
    holdings: parseHoldings(sheetMap),
    kpis: parseKpis(sheetMap),
  };
}

async function fetchAllSheets(source) {
  const names = Object.values(SHEET_NAMES);
  const results = await Promise.all(names.map((n) => Promise.resolve(source.getSheet(n))));
  const sheetMap = {};
  names.forEach((n, i) => { sheetMap[n] = results[i] || []; });
  return sheetMap;
}

module.exports = {
  SHEET_NAMES,
  parseAll,
  parseTransactions,
  parseSecurityAttribution,
  parseHoldings,
  parseKpis,
  fetchAllSheets,
};
