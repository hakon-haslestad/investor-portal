const db = require('../db');
const {
  classify,
  loadAttributionMap,
  splitForSecurity,
  loadTransactions,
  INVESTOR_CODES,
} = require('./ledger');
const { canonicalName } = require('./calculator');

function monthKey(dateStr) {
  return dateStr && dateStr.length >= 7 ? dateStr.slice(0, 7) : null;
}

function addMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function enumerateMonths(fromYm, toYm) {
  const out = [];
  let cur = fromYm;
  while (cur <= toYm) {
    out.push(cur);
    cur = addMonth(cur);
  }
  return out;
}

/**
 * Walks every transaction once and builds monthly series for:
 *   - deposits (group only — depositors aren't tracked per investor)
 *   - withdrawals (group only)
 *   - realized P/L (per investor, derived from cost-basis replay)
 *   - dividends net of withholding tax (per investor)
 *   - buys, sells (per investor)
 *
 * Returns cumulative AND monthly arrays per investor + group, keyed by month.
 * The full window is from the earliest transaction to today; the caller can
 * slice client-side, but we also clip by `from`/`to` if passed.
 */
function buildTimeline({ from, to } = {}) {
  const attrMap = loadAttributionMap();
  const txs = loadTransactions();

  // Figure out month range: full history by default
  const firstTx = txs.find((t) => t.trade_date);
  if (!firstTx) {
    return { months: [], group: {}, perInvestor: {} };
  }
  const today = new Date().toISOString().slice(0, 10);
  const firstYm = monthKey(firstTx.trade_date);
  const lastTx = txs[txs.length - 1];
  const lastYm = monthKey(lastTx.trade_date || today) || monthKey(today);

  const fromYm = from ? monthKey(from) || firstYm : firstYm;
  const toYm = to ? monthKey(to) || lastYm : lastYm;

  const months = enumerateMonths(fromYm < firstYm ? firstYm : fromYm, toYm > lastYm ? lastYm : toYm);
  if (!months.length) {
    return { months: [], group: {}, perInvestor: {} };
  }
  const monthIndex = new Map(months.map((m, i) => [m, i]));

  // Per-investor running cost-basis state for realized P/L derivation
  const stateByInvestor = new Map();
  for (const code of INVESTOR_CODES) {
    stateByInvestor.set(code, new Map()); // security → { qty, costSum }
  }

  const blank = () => Array(months.length).fill(0);
  const groupMonthly = {
    deposits: blank(),
    withdrawals: blank(),
    realized: blank(),
    dividends: blank(),
    buys: blank(),
    sells: blank(),
    fees: blank(),
  };
  const perInvestorMonthly = {};
  for (const code of INVESTOR_CODES) {
    perInvestorMonthly[code] = {
      realized: blank(),
      dividends: blank(),
      buys: blank(),
      sells: blank(),
    };
  }

  const ensureSlot = (state, security) => {
    if (!state.has(security)) state.set(security, { qty: 0, costSum: 0 });
    return state.get(security);
  };

  for (const tx of txs) {
    const ym = monthKey(tx.trade_date);
    if (!ym) continue;
    // We still want to replay cost basis for trades that fall outside the
    // chart window, so the realized number for in-window months is correct.
    // Only skip the bucket assignment if the month isn't on the chart.
    const idx = monthIndex.has(ym) ? monthIndex.get(ym) : -1;
    const cat = classify(tx.type);
    const amount = tx.amount || 0;

    // Group cash-flow buckets (no investor attribution needed)
    if (idx >= 0) {
      if (cat === 'DEPOSIT') groupMonthly.deposits[idx] += amount;
      else if (cat === 'WITHDRAWAL') groupMonthly.withdrawals[idx] += Math.abs(amount);
      else if (cat === 'FEE') groupMonthly.fees[idx] += Math.abs(amount);
    }

    if (!tx.security) continue;

    const split = splitForSecurity(attrMap, tx.security);
    if (!split.length) continue;
    const security = canonicalName(tx.security);

    if (tx.type === 'KJØPT' || tx.type === 'SALG') {
      for (const { code, weight } of split) {
        const state = stateByInvestor.get(code);
        const slot = ensureSlot(state, security);
        const wAmt = amount * weight;
        const wQty = (tx.qty || 0) * weight;
        if (tx.type === 'KJØPT') {
          slot.qty += wQty;
          slot.costSum += Math.abs(wAmt);
          if (idx >= 0) {
            perInvestorMonthly[code].buys[idx] += Math.abs(wAmt);
            groupMonthly.buys[idx] += Math.abs(wAmt);
          }
        } else {
          // SALG
          const avg = slot.qty > 0 ? slot.costSum / slot.qty : 0;
          const sold = Math.abs(wQty);
          const realized = wAmt - avg * sold;
          const fracSold = slot.qty > 0 ? sold / slot.qty : 0;
          slot.costSum = Math.max(0, slot.costSum - slot.costSum * fracSold);
          slot.qty = Math.max(0, slot.qty - sold);
          if (idx >= 0) {
            perInvestorMonthly[code].realized[idx] += realized;
            perInvestorMonthly[code].sells[idx] += wAmt;
            groupMonthly.realized[idx] += realized;
            groupMonthly.sells[idx] += wAmt;
          }
        }
      }
    } else if (cat === 'DIVIDEND' || cat === 'TAX') {
      for (const { code, weight } of split) {
        const wAmt = amount * weight;
        if (idx >= 0) {
          perInvestorMonthly[code].dividends[idx] += wAmt;
          groupMonthly.dividends[idx] += wAmt;
        }
      }
    }
  }

  // Build cumulative arrays
  const cumulate = (arr) => {
    const out = Array(arr.length);
    let acc = 0;
    for (let i = 0; i < arr.length; i++) {
      acc += arr[i];
      out[i] = acc;
    }
    return out;
  };

  const zipSub = (a, b) => a.map((v, i) => v - b[i]);
  const zipAdd = (a, b) => a.map((v, i) => v + b[i]);

  const groupNetDepositsMonthly = zipSub(groupMonthly.deposits, groupMonthly.withdrawals);
  const groupNetPnlMonthly = zipAdd(groupMonthly.realized, groupMonthly.dividends);

  const group = {
    monthly: { ...groupMonthly, netDeposits: groupNetDepositsMonthly, netPnl: groupNetPnlMonthly },
    cumulative: {
      deposits: cumulate(groupMonthly.deposits),
      withdrawals: cumulate(groupMonthly.withdrawals),
      netDeposits: cumulate(groupNetDepositsMonthly),
      realized: cumulate(groupMonthly.realized),
      dividends: cumulate(groupMonthly.dividends),
      netPnl: cumulate(groupNetPnlMonthly),
    },
  };

  const perInvestor = {};
  for (const code of INVESTOR_CODES) {
    const m = perInvestorMonthly[code];
    const netPnlMonthly = zipAdd(m.realized, m.dividends);
    perInvestor[code] = {
      monthly: { ...m, netPnl: netPnlMonthly },
      cumulative: {
        realized: cumulate(m.realized),
        dividends: cumulate(m.dividends),
        netPnl: cumulate(netPnlMonthly),
      },
    };
  }

  return { months, group, perInvestor };
}

module.exports = { buildTimeline };
