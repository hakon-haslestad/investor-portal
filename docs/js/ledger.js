// Transaction classification + per-security investor splits.
// Ported from src/portfolio/ledger.js. All inputs come from the hydrated
// `store`; nothing async.

(function () {
  const INVESTOR_CODES = ['HH', 'HS', 'ØS', 'JC', 'HF'];

  // Per-investor chart/legend colors. Shared so the dashboard and the
  // competition presentation draw the same investor in the same color.
  const INVESTOR_COLORS = {
    HH: '#4ade80', HS: '#60a5fa', 'ØS': '#fbbf24', JC: '#f472b6', HF: '#a78bfa',
  };

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

  // SELL types that represent a real cash realisation, not just a share-
  // shuffle corporate action. SALG is the normal investor-initiated sell.
  // INNLØSN. UTTAK VP fires on mandatory redemptions (Crayon take-private
  // buyout, etc.) and SLETTING UTTAK VP on delistings / bankruptcies
  // (Flyr). Both should hit realized P/L and the cash balance the same
  // way a SALG would.
  const REALIZING_SELL_TYPES = new Set([
    'SALG',
    'INNLØSN. UTTAK VP',
    'SLETTING UTTAK VP',
  ]);
  function isRealizingSell(type) { return REALIZING_SELL_TYPES.has(type); }

  // Cash-settlement legs of corporate actions. Nordnet books a redemption
  // as TWO rows: 'INNL. VP LIKVID' (the cash, quantity merely referenced)
  // + 'INNLØSN. UTTAK VP' (the shares leaving). Treating the LIKVID row as
  // a share inflow doubles the position and it never exits — these types
  // must NEVER move quantity. Same for TEGNING LIKVID (subscription cash).
  const CASH_LEG_TYPES = new Set(['INNL. VP LIKVID', 'TEGNING LIKVID']);
  function isCashLeg(type) { return CASH_LEG_TYPES.has(type); }

  // Conversion pairs: Nordnet books a security changing FORM (BTA → shares
  // after a rights issue, NDR/venue moves) as an UTTAK row + an INNLEGG row
  // on the same date with the same quantity. Quantity handling is already
  // correct, but cost basis must TRAVEL with the shares — otherwise it
  // strands on the retired form and the eventual sale overstates realized
  // P/L. annotateConversionPairs() links such rows; the replays use the
  // links to move cost. True spinoffs (UTSKILLING FISJON, dividends in
  // shares) have no matching UTTAK and are untouched — the parent keeps its
  // basis, as intended.
  const CONV_OUT_TYPES = new Set(['BYTTE UTTAK VP', 'BYTTE UTTAK VERDIPAPIR', 'EMISJON UTTAK VP']);
  const CONV_IN_TYPES = new Set(['BYTTE INNLEGG VP', 'BYTE INLÄGG VP', 'EMISJON INNLEGG VP']);
  function annotateConversionPairs(txs) {
    let nextId = 1;
    const open = []; // unmatched rows seen so far
    for (const tx of txs) {
      if (tx._convId !== undefined) tx._convId = undefined;
      const isOut = CONV_OUT_TYPES.has(tx.type);
      const isIn = CONV_IN_TYPES.has(tx.type);
      if (!isOut && !isIn) continue;
      const date = tx.tradeDate || tx.bookDate || '';
      const qty = Math.abs(tx.qty || 0);
      if (!date || !(qty > 0)) continue;
      const meIsOut = isOut;
      const match = open.findIndex((o) =>
        o.date === date && o.qty === qty && o.isOut !== meIsOut &&
        String(o.tx.security || '') !== String(tx.security || ''));
      if (match >= 0) {
        const other = open.splice(match, 1)[0];
        const id = nextId++;
        tx._convId = id; tx._convRole = meIsOut ? 'out' : 'in';
        tx._convOther = other.tx.security;
        other.tx._convId = id; other.tx._convRole = other.isOut ? 'out' : 'in';
        other.tx._convOther = tx.security;
      } else {
        open.push({ tx, date, qty, isOut: meIsOut });
      }
    }
    return txs;
  }

  // A buy that costs real money adds to cost basis — KJØPT always, but also
  // corporate-action buys that carry cash (e.g. TEGNING INNLEGG VP when a
  // rights issue is exercised: new capital in, not a free share shuffle).
  // Zero-amount corporate buys (splits, spinoffs, allocations) stay costless.
  function isPricedBuy(tx) {
    if (isCashLeg(tx.type)) return false;
    return classify(tx.type) === 'BUY' && amountNok(tx) !== 0;
  }

  // FX helpers. Nordnet records `Beløp` and `Totale Avgifter` in the
  // transaction's trading currency (USD, SEK, EUR, …) plus `Vekslingskurs`
  // — the foreign→NOK rate. Saldo is
  // already NOK, but every other money field needs the multiply. Treats
  // empty / 'NOK' currency, or a missing fx rate, as a 1:1 NOK figure.
  function amountNok(tx) {
    if (!tx) return 0;
    const a = Number(tx.amount) || 0;
    const cur = (tx.currency || '').toString().toUpperCase().trim();
    if (!cur || cur === 'NOK') return a;
    const fx = Number(tx.fxRate);
    return Number.isFinite(fx) && fx > 0 ? a * fx : a;
  }
  function feeNok(tx) {
    if (!tx) return 0;
    const f = Number(tx.fee) || 0;
    const cur = (tx.currency || '').toString().toUpperCase().trim();
    if (!cur || cur === 'NOK') return f;
    const fx = Number(tx.fxRate);
    return Number.isFinite(fx) && fx > 0 ? f * fx : f;
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

  window.Ledger = {
    INVESTOR_CODES, INVESTOR_COLORS, classify, splitForSecurity, evenSplit,
    isRealizingSell, REALIZING_SELL_TYPES,
    isCashLeg, CASH_LEG_TYPES, isPricedBuy, annotateConversionPairs,
    amountNok, feeNok,
  };
})();
