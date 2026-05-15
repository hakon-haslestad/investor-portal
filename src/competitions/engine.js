const db = require('../db');
const { canonicalName } = require('../portfolio/calculator');
const {
  classify,
  loadAttributionMap,
  splitForSecurity,
  loadTransactions,
  INVESTOR_CODES,
} = require('../portfolio/ledger');

/**
 * Returns the current price (NOK) for a security from the latest holdings snapshot.
 * Falls back to last priced transaction.
 */
function priceLookup() {
  const latest = db.prepare('SELECT MAX(snapshot_date) d FROM holdings_snapshot').get();
  const map = new Map();
  if (latest && latest.d) {
    const rows = db
      .prepare(
        `SELECT security, current_price, market_value_nok, qty
         FROM holdings_snapshot WHERE snapshot_date = ?`
      )
      .all(latest.d);
    for (const r of rows) {
      const key = canonicalName(r.security);
      if (!map.has(key) && r.current_price != null) {
        map.set(key, {
          price: r.current_price,
          marketValueNok: r.market_value_nok,
          qty: r.qty,
        });
      }
    }
  }
  return map;
}

/**
 * Computes performance for a competition: how the assigned-picks (or full
 * portfolios) of each participant performed between start_date and end_date.
 *
 * For mode 'assigned_picks':
 *   - Score each participant by the sum of their picks' (currentValue + dividends - cost)
 *     for transactions in the window. cost = buys in window + (value at start_date for shares
 *     held entering the window).
 * For mode 'full_portfolio':
 *   - Score by total realized + unrealized + dividends inside the window for any security
 *     attributed to them.
 *
 * Returns: { id, name, type, mode, start_date, end_date, participants, picks, ranks: [{code, pct, absolute, label, team}], teams: [...] }
 */
function scoreCompetition(competition) {
  const attrMap = loadAttributionMap();
  const txs = loadTransactions();
  const prices = priceLookup();
  const startDate = competition.start_date;
  const endDate = competition.end_date;

  const participants = db
    .prepare('SELECT investor_code, team_label, buy_in_nok FROM competition_participants WHERE competition_id = ?')
    .all(competition.id);

  const picks = db
    .prepare('SELECT investor_code, security, isin, label FROM competition_picks WHERE competition_id = ?')
    .all(competition.id);

  const picksByInvestor = new Map();
  for (const p of picks) {
    if (!picksByInvestor.has(p.investor_code)) picksByInvestor.set(p.investor_code, []);
    picksByInvestor.get(p.investor_code).push(canonicalName(p.security));
  }

  // For each participant compute their performance
  const perParticipant = [];
  for (const p of participants) {
    const code = p.investor_code;
    const assignedSecs = picksByInvestor.get(code);
    const securityFilter = (sec) => {
      if (!sec) return false;
      const c = canonicalName(sec);
      if (competition.mode === 'assigned_picks') {
        return (assignedSecs || []).includes(c);
      }
      // full_portfolio: any security attributed to them
      const split = splitForSecurity(attrMap, sec);
      return split.some((s) => s.code === code);
    };

    // Track per-security: shares-at-start, basis-at-start, buys-in-window, sells-in-window, divs-in-window
    const slots = new Map(); // sec → {qty, costSum, divs, soldQty, soldProceeds}
    const ensure = (sec) => {
      if (!slots.has(sec)) slots.set(sec, { qty: 0, costSum: 0, divs: 0, soldProceeds: 0, soldQty: 0 });
      return slots.get(sec);
    };

    // First pass: replay all KJØPT/SALG before start_date to establish entering position
    for (const tx of txs) {
      if (!tx.security || !securityFilter(tx.security)) continue;
      if ((tx.trade_date || '') >= startDate) break;
      const cat = classify(tx.type);
      const split = splitForSecurity(attrMap, tx.security);
      const slot = split.find((s) => s.code === code);
      if (!slot) continue;
      const w = slot.weight;
      const sec = canonicalName(tx.security);
      const s = ensure(sec);
      const amt = (tx.amount || 0) * w;
      const q = (tx.qty || 0) * w;
      if (tx.type === 'KJØPT') {
        s.qty += q;
        s.costSum += Math.abs(amt);
      } else if (tx.type === 'SALG') {
        const avg = s.qty > 0 ? s.costSum / s.qty : 0;
        const sold = Math.abs(q);
        const fracSold = s.qty > 0 ? sold / s.qty : 0;
        s.costSum = Math.max(0, s.costSum - s.costSum * fracSold);
        s.qty = Math.max(0, s.qty - sold);
      }
    }

    // Second pass: process the window
    let buysInWindow = 0;
    let sellsInWindow = 0;
    let divsInWindow = 0;
    let realizedInWindow = 0;
    for (const tx of txs) {
      if (!tx.security || !securityFilter(tx.security)) continue;
      if ((tx.trade_date || '') < startDate) continue;
      if ((tx.trade_date || '') > endDate) continue;
      const cat = classify(tx.type);
      const split = splitForSecurity(attrMap, tx.security);
      const slot = split.find((s) => s.code === code);
      if (!slot) continue;
      const w = slot.weight;
      const sec = canonicalName(tx.security);
      const s = ensure(sec);
      const amt = (tx.amount || 0) * w;
      const q = (tx.qty || 0) * w;
      if (tx.type === 'KJØPT') {
        s.qty += q;
        s.costSum += Math.abs(amt);
        buysInWindow += Math.abs(amt);
      } else if (tx.type === 'SALG') {
        const avg = s.qty > 0 ? s.costSum / s.qty : 0;
        const sold = Math.abs(q);
        realizedInWindow += amt - avg * sold;
        const fracSold = s.qty > 0 ? sold / s.qty : 0;
        s.costSum = Math.max(0, s.costSum - s.costSum * fracSold);
        s.qty = Math.max(0, s.qty - sold);
        s.soldProceeds += amt;
        s.soldQty += sold;
        sellsInWindow += amt;
      } else if (cat === 'DIVIDEND' || cat === 'TAX') {
        s.divs += amt;
        divsInWindow += amt;
      }
    }

    // Current value of still-held positions
    let unrealizedAtEnd = 0;
    let mvAtEnd = 0;
    const breakdown = [];
    for (const [sec, s] of slots.entries()) {
      const px = prices.get(sec);
      const currentPrice = px ? px.price : 0;
      const mv = s.qty * (currentPrice || 0);
      const unrealized = mv - s.costSum;
      mvAtEnd += mv;
      unrealizedAtEnd += unrealized;
      breakdown.push({
        security: sec,
        qty: s.qty,
        costSum: s.costSum,
        currentPrice,
        marketValue: mv,
        unrealized,
        divs: s.divs,
      });
    }

    // Score = realizedInWindow + unrealizedAtEnd + divsInWindow
    const netPnl = realizedInWindow + unrealizedAtEnd + divsInWindow;
    // Base for % return: buyIn (if set), else invested capital (buys-in-window + entering basis)
    let base = p.buy_in_nok && p.buy_in_nok > 0 ? p.buy_in_nok : 0;
    if (!base) {
      let enteringBasis = 0;
      for (const s of slots.values()) enteringBasis += s.costSum;
      base = Math.max(buysInWindow, enteringBasis, 1);
    }
    const pct = (netPnl / base) * 100;

    perParticipant.push({
      code,
      teamLabel: p.team_label || null,
      buyIn: p.buy_in_nok || 0,
      breakdown,
      buysInWindow,
      sellsInWindow,
      divsInWindow,
      realizedInWindow,
      unrealizedAtEnd,
      mvAtEnd,
      netPnl,
      pct,
    });
  }

  // Sort individual ranks
  const ranks = [...perParticipant].sort((a, b) => b.pct - a.pct);

  // Team aggregation
  let teams = null;
  if (competition.type === 'team') {
    const map = new Map();
    for (const p of perParticipant) {
      const key = p.teamLabel || p.code;
      if (!map.has(key)) map.set(key, { label: key, members: [], buyIn: 0, netPnl: 0 });
      const t = map.get(key);
      t.members.push(p.code);
      t.buyIn += p.buyIn || 0;
      t.netPnl += p.netPnl;
    }
    teams = Array.from(map.values()).map((t) => ({
      ...t,
      pct: t.buyIn > 0 ? (t.netPnl / t.buyIn) * 100 : 0,
    })).sort((a, b) => b.pct - a.pct);
  }

  return {
    competition,
    ranks,
    teams,
    picksByInvestor: Object.fromEntries(picksByInvestor),
  };
}

function listCompetitions() {
  const rows = db
    .prepare('SELECT * FROM competitions ORDER BY start_date DESC')
    .all();
  return rows.map((c) => ({ ...c, _scored: scoreCompetition(c) }));
}

function getCompetition(id) {
  const c = db.prepare('SELECT * FROM competitions WHERE id = ?').get(id);
  if (!c) return null;
  return scoreCompetition(c);
}

function createCompetition({ name, description, type, mode, metric, start_date, end_date, participants, picks, narrative }) {
  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO competitions
         (name, description, type, mode, metric, start_date, end_date, narrative_json, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(name, description || null, type, mode, metric, start_date, end_date,
        narrative ? JSON.stringify(narrative) : null, null);
    const id = info.lastInsertRowid;
    const insP = db.prepare(
      `INSERT INTO competition_participants (competition_id, investor_code, team_label, buy_in_nok)
       VALUES (?, ?, ?, ?)`
    );
    for (const p of participants || []) {
      insP.run(id, p.investor_code, p.team_label || null, p.buy_in_nok || null);
    }
    const insPk = db.prepare(
      `INSERT INTO competition_picks (competition_id, investor_code, security, isin, label)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const pk of picks || []) {
      insPk.run(id, pk.investor_code, pk.security, pk.isin || null, pk.label || null);
    }
    return id;
  });
  return tx();
}

function deleteCompetition(id) {
  return db.prepare('DELETE FROM competitions WHERE id = ?').run(id);
}

module.exports = {
  scoreCompetition,
  listCompetitions,
  getCompetition,
  createCompetition,
  deleteCompetition,
};
