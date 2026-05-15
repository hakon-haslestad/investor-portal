// Transaction classification + per-security investor splits.
// Ported from src/portfolio/ledger.js. All inputs come from the hydrated
// `store`; nothing async.

(function () {
  const INVESTOR_CODES = ['HH', 'HS', 'ØS', 'JC', 'HF'];

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

  function splitForSecurity(map, security) {
    if (!security) return [];
    const list = map.get(security);
    if (!list || !list.length) return [];
    return list.filter((x) => INVESTOR_CODES.includes(x.code));
  }

  function evenSplit() {
    return INVESTOR_CODES.map((code) => ({ code, weight: 1 / INVESTOR_CODES.length }));
  }

  window.Ledger = { INVESTOR_CODES, classify, splitForSecurity, evenSplit };
})();
