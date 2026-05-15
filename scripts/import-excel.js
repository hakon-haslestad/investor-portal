require('dotenv').config();
const path = require('path');
const fs = require('fs');
const db = require('../src/db');
const { parseAll, fetchAllSheets } = require('../src/parsers/workbook');
const { createXlsxSource } = require('../src/parsers/sources/xlsxSource');

const SOURCE = process.argv[2]
  || path.join(__dirname, '..', '..', 'Geysir Invest AS.xlsx');

if (!fs.existsSync(SOURCE)) {
  console.error(`Source file not found: ${SOURCE}`);
  process.exit(1);
}

console.log(`Importing from ${SOURCE}`);

(async () => {
const sheetMap = await fetchAllSheets(createXlsxSource(SOURCE));
const { transactions, attributions, meta, holdings, kpis } = parseAll(sheetMap);

const replaceTransactions = db.prepare('DELETE FROM transactions');
const replaceAttributions = db.prepare('DELETE FROM security_attribution');
const replaceMeta = db.prepare('DELETE FROM security_meta');
const replaceHoldings = db.prepare('DELETE FROM holdings_snapshot');
const replaceKpis = db.prepare('DELETE FROM kpi_snapshot');

const insertTx = db.prepare(`
  INSERT INTO transactions
  (nordnet_id, trade_date, settle_date, book_date, type, security, isin,
   qty, price, amount_nok, currency, fee, running_balance, fx_rate,
   transaction_text, source_row)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertAttr = db.prepare(`
  INSERT INTO security_attribution
  (security, isin, investor_code, weight, notes)
  VALUES (?, ?, ?, ?, ?)
`);

const insertMeta = db.prepare(`
  INSERT INTO security_meta (security, type, category_tick, member_string, factor, isin)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const insertHolding = db.prepare(`
  INSERT INTO holdings_snapshot
  (snapshot_date, security, isin, currency, qty, gav, current_price,
   market_value_nok, margin_value, return_pct, return_nok)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertKpi = db.prepare(`
  INSERT INTO kpi_snapshot
  (year, company, revenue, our_share_rev, eat, our_share_eat, price, eps, pe)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertLog = db.prepare(`
  INSERT INTO upload_log (filename, uploaded_by, rows_imported, holdings_imported, attributions_imported)
  VALUES (?, ?, ?, ?, ?)
`);

const importAll = db.transaction(() => {
  replaceTransactions.run();
  replaceAttributions.run();
  replaceMeta.run();
  replaceHoldings.run();
  replaceKpis.run();
  for (const t of transactions) {
    insertTx.run(
      t.nordnetId, t.tradeDate, t.settleDate, t.bookDate, t.type, t.security, t.isin,
      t.qty, t.price, t.amount, t.currency, t.fee, t.saldo, t.fxRate, t.text, t.sourceRow
    );
  }
  for (const a of attributions) {
    insertAttr.run(a.security, a.isin, a.investorCode, a.weight, a.notes);
  }
  for (const m of meta) {
    insertMeta.run(m.security, m.type, m.categoryTick, m.memberString, m.factor, m.isin);
  }
  for (const h of holdings) {
    insertHolding.run(
      h.snapshotDate, h.security, h.isin, h.currency, h.qty, h.gav,
      h.currentPrice, h.marketValueNok, h.marginValue, h.returnPct, h.returnNok
    );
  }
  for (const k of kpis) {
    insertKpi.run(k.year, k.company, k.revenue, k.ourShareRev, k.eat, k.ourShareEat, k.price, k.eps, k.pe);
  }
  insertLog.run(path.basename(SOURCE), 'seed-script', transactions.length, holdings.length, attributions.length);
});

importAll();

console.log(`Imported:`);
console.log(`  transactions: ${transactions.length}`);
console.log(`  attributions: ${attributions.length}`);
console.log(`  holdings:     ${holdings.length}`);
console.log(`  KPIs:         ${kpis.length}`);

// Audit: transactions whose security has no attribution match
const securityNames = new Set(attributions.map((a) => a.security));
const unmapped = new Map();
for (const t of transactions) {
  if (!t.security) continue;
  if (!securityNames.has(t.security)) {
    unmapped.set(t.security, (unmapped.get(t.security) || 0) + 1);
  }
}
if (unmapped.size) {
  console.log(`\n⚠ ${unmapped.size} securities in transactions have no attribution in Dim-values:`);
  for (const [sec, count] of unmapped.entries()) {
    console.log(`  • ${sec} (${count} txns)`);
  }
}
})().catch((err) => { console.error(err); process.exit(1); });
