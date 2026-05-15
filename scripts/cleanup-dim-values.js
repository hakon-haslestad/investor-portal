/**
 * One-shot fix for the wrongly-positioned rows that migrate-to-sheet.js
 * appended to Dim-values at columns ~76–89 instead of A/B/C.
 *
 * Strategy:
 *   1. Find every "stray" row — i.e. a row where col A is empty but there's
 *      data far to the right (security name at col 77 or 86).
 *   2. Collect their (security, member, factor) tuples.
 *   3. Delete those stray rows.
 *   4. Append each tuple correctly at A/B/C/D (only if the security isn't
 *      already present at col A in a real row).
 *
 * Run:
 *   GOOGLE_SERVICE_ACCOUNT_KEY=./geysir-496416-1f6cfde3578c.json \
 *   node scripts/cleanup-dim-values.js
 */

require('dotenv').config();
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const { getSetting } = require('../src/db');

const SHEET_ID = process.env.SHEET_ID || getSetting('google_sheet_id');
const KEY_PATH = path.resolve(__dirname, '..', process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
const TAB = 'Dim-values';

const creds = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
const sheets = google.sheets({ version: 'v4', auth });

async function main() {
  console.log(`Sheet: ${SHEET_ID}`);

  // Find sheetId for Dim-values (needed for batchUpdate deleteRange)
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
    fields: 'sheets.properties(sheetId,title)',
  });
  const target = (meta.data.sheets || []).find((s) => s.properties.title === TAB);
  if (!target) throw new Error('Dim-values tab not found');
  const sheetId = target.properties.sheetId;

  // Read the whole tab
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID, range: `${TAB}!A1:CZ200`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rows = res.data.values || [];
  console.log(`Dim-values: ${rows.length} rows`);

  // Identify existing securities by col A
  const existingSecs = new Set();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const sec = (row[0] || '').toString().trim();
    if (sec) existingSecs.add(sec);
  }

  // Identify stray rows: col A is empty but there's *any* data later in the row.
  // For each, extract (security, member, factor) by scanning for the first
  // non-"Stock" string (security), the next non-"Stock" string (member),
  // and the first number (factor) after both are found.
  const strays = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    if ((row[0] || '').toString().trim()) continue; // not stray, has data at A
    const hasAnyData = row.some((c) => c !== '' && c != null);
    if (!hasAnyData) continue; // empty row, ignore
    let security = null, member = null, factor = null;
    for (let j = 1; j < row.length; j++) {
      const cell = row[j];
      if (typeof cell === 'string' && cell.trim() && cell !== 'Stock') {
        if (!security) security = cell.trim();
        else if (!member) member = cell.trim();
      } else if (typeof cell === 'number' && security && member && factor == null) {
        factor = cell;
      }
    }
    strays.push({ rowIndex0Based: i, security, member, factor });
  }
  console.log(`Found ${strays.length} stray rows`);
  for (const s of strays) console.log(` row ${s.rowIndex0Based + 1}: ${s.security} | ${s.member} | ${s.factor}`);

  if (!strays.length) {
    console.log('Nothing to clean up.');
    return;
  }

  // Delete stray rows BOTTOM-UP so indices stay valid
  const deleteRequests = strays
    .slice()
    .sort((a, b) => b.rowIndex0Based - a.rowIndex0Based)
    .map((s) => ({
      deleteDimension: {
        range: {
          sheetId,
          dimension: 'ROWS',
          startIndex: s.rowIndex0Based,
          endIndex: s.rowIndex0Based + 1,
        },
      },
    }));

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests: deleteRequests },
  });
  console.log(`✓ Deleted ${deleteRequests.length} stray rows`);

  // Re-append correctly at A/B/C/D
  const now = new Date().toISOString();
  let appended = 0;
  for (const s of strays) {
    if (!s.security) {
      console.log(`  skip row ${s.rowIndex0Based + 1} — no security name to recover`);
      continue;
    }
    if (existingSecs.has(s.security)) {
      console.log(`  skip ${s.security} — already present at col A`);
      continue;
    }
    // A=Name B=Investor C=Factor D=UpdatedAt E=UpdatedBy
    const row = [s.security, s.member, s.factor != null ? s.factor : '', now, 'cleanup-script'];
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: TAB,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });
    existingSecs.add(s.security);
    appended += 1;
    console.log(`  + ${s.security} → ${s.member} @ ${s.factor}`);
  }
  console.log(`\nRe-appended ${appended} entries at correct columns.`);
  console.log('✅ Done.');
}

main().catch((err) => {
  console.error('\n❌ Failed:', err.message);
  if (err.errors) console.error(err.errors);
  process.exit(1);
});
