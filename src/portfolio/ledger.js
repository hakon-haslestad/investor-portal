const db = require('../db');
const { INVESTOR_CODES } = require('../excel/normalizer');

const BUY_TYPES = new Set([
  'KJØPT',
  'BYTTE INNLEGG VP',
  'BYTE INLÄGG VP',
  'TEGNING INNLEGG VP',
  'TEGNING LIKVID',
  'EMISJON INNLEGG VP',
  'TILDELING INNLEGG RE',
  'UTSKILLING FISJON IN',
  'SPLITT INNLEGG VP',
  'UTBYTTE INNLEGG VP',
  'INNLEGG OVERFØRING',
  'INNL. VP LIKVID',
]);

const SELL_TYPES = new Set([
  'SALG',
  'BYTTE UTTAK VP',
  'BYTTE UTTAK VERDIPAPIR',
  'INNLØSN. UTTAK VP',
  'SLETTING UTTAK VP',
  'EMISJON UTTAK VP',
  'SPLITT UTTAK VP',
  'TEGNING UTTAK RETTER',
]);

const DEPOSIT_TYPES = new Set(['INNSKUDD']);
const WITHDRAWAL_TYPES = new Set(['UTTAK INTERNET']);
const DIVIDEND_TYPES = new Set(['UTBYTTE']);
const TAX_TYPES = new Set(['KUPONGSKATT']);
const FEE_TYPES = new Set(['PLATTFORMAVGIFT', 'DEBETRENTE', 'DEBETRENTE KORR']);
const REFUND_TYPES = new Set(['TILBAKEBETALING']);

function classify(type) {
  if (BUY_TYPES.has(type)) return 'BUY';
  if (SELL_TYPES.has(type)) return 'SELL';
  if (DEPOSIT_TYPES.has(type)) return 'DEPOSIT';
  if (WITHDRAWAL_TYPES.has(type)) return 'WITHDRAWAL';
  if (DIVIDEND_TYPES.has(type)) return 'DIVIDEND';
  if (TAX_TYPES.has(type)) return 'TAX';
  if (FEE_TYPES.has(type)) return 'FEE';
  if (REFUND_TYPES.has(type)) return 'REFUND';
  return 'OTHER';
}

function loadAttributionMap() {
  const rows = db.prepare('SELECT security, investor_code, weight FROM security_attribution').all();
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.security)) map.set(r.security, []);
    map.get(r.security).push({ code: r.investor_code, weight: r.weight });
  }
  return map;
}

function splitForSecurity(map, security) {
  if (!security) return [];
  const list = map.get(security);
  if (!list || !list.length) return [];
  return list.filter((x) => INVESTOR_CODES.includes(x.code));
}

function evenSplit() {
  return INVESTOR_CODES.map((code) => ({ code, weight: 1 / INVESTOR_CODES.length }));
}

function loadTransactions() {
  return db
    .prepare(
      `SELECT id, nordnet_id, trade_date, settle_date, type, security, isin,
              qty, price, amount_nok AS amount, currency, fee, source_row, transaction_text AS text
       FROM transactions
       ORDER BY trade_date ASC, id ASC`
    )
    .all();
}

module.exports = {
  classify,
  loadAttributionMap,
  splitForSecurity,
  evenSplit,
  loadTransactions,
  INVESTOR_CODES,
};
