/**
 * One-shot: copy every row from the Ownership tab into Dim-values
 * (the new single source of truth for attribution), then delete the
 * Ownership tab.
 *
 * Ownership layout (4 cols):
 *   A Security | B Member | C Factor | D UpdatedAt
 *
 * Dim-values layout (existing Nordnet-style):
 *   G(6) Type | H(7) Security | I(8) CategoryTick | J(9) Member | K(10) Factor
 *   O(14) ISIN | P(15) UpdatedAt (new) | Q(16) UpdatedBy (new)
 *
 * Idempotent: safe to re-run. If a security already exists in Dim-values,
 * its Member / Factor / UpdatedAt / UpdatedBy get overwritten with the
 * Ownership row's values (Ownership is treated as the more recent truth).
 *
 * Run:
 *   GOOGLE_SERVICE_ACCOUNT_KEY=./geysir-496416-1f6cfde3578c.json \
 *   node scripts/merge-ownership-into-dim.js
 */

require('dotenv').config();
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const { getSetting } = require('../src/db');

const SHEET_ID = process.env.SHEET_ID || getSetting('google_sheet_id');
const KEY_PATH = path.resolve(__dirname, '..', process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
const OWNERSHIP_TAB = 'Ownership';
const DIM_TAB = 'Dim-values';

if (!SHEET_ID) { console.error('No sheet ID'); process.exit(1); }
if (!fs.existsSync(KEY_PATH)) { console.error('Service account key missing:', KEY_PATH); process.exit(1); }

const creds = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
const sheets = google.sheets({ version: 'v4', auth });

const MIGRATOR_EMAIL = `migrate-script (${creds.client_email})`;
const ROW_WIDTH = 17;
const COL = { TYPE: 6, SECURITY: 7, TICK: 8, MEMBER: 9, FACTOR: 10, ISIN: 14, UPDATED_AT: 15, UPDATED_BY: 16 };

async function main() {
  console.log(`Sheet: ${SHEET_ID}`);

  // ── Read Ownership ────────────────────────────────────────────────────────
  let ownershipRows;
  try {
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID, range: OWNERSHIP_TAB,
      valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER',
    });
    ownershipRows = r.data.values || [];
  } catch (err) {
    if (/Unable to parse range/i.test(err.message || '')) {
      console.log('No Ownership tab found. Nothing to merge.');
      return;
    }
    throw err;
  }
  console.log(`Ownership tab: ${Math.max(0, ownershipRows.length - 1)} data rows`);
  if (ownershipRows.length < 2) {
    console.log('Ownership has no data rows. Skipping merge, will still delete the tab.');
  }

  // ── Read Dim-values index ─────────────────────────────────────────────────
  const dimRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID, range: DIM_TAB,
    valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER',
  });
  const dimRows = dimRes.data.values || [];
  const dimIndex = new Map(); // security → { rowIndex (1-based), rowArray }
  for (let i = 1; i < dimRows.length; i++) {
    const r = dimRows[i] || [];
    const sec = (r[COL.SECURITY] || '').toString().trim();
    if (!sec) continue;
    dimIndex.set(sec, { rowIndex: i + 1, rowArray: r.slice() });
  }
  console.log(`Dim-values has ${dimIndex.size} mapped securities`);

  // ── Merge Ownership rows into Dim-values ─────────────────────────────────
  let merged = 0, appended = 0;
  for (let i = 1; i < ownershipRows.length; i++) {
    const row = ownershipRows[i] || [];
    const security = (row[0] || '').toString().trim();
    const member = (row[1] || '').toString().trim();
    const factorRaw = row[2];
    const updatedAt = (row[3] || '').toString();
    if (!security || !member) {
      console.log(`  skip ownership row ${i + 1}: missing security/member`);
      continue;
    }
    const factor = factorRaw === '' || factorRaw == null ? '' : Number(factorRaw);

    const existing = dimIndex.get(security);
    if (existing) {
      // Overwrite Member / Factor / UpdatedAt / UpdatedBy in place
      const out = existing.rowArray.slice();
      while (out.length < ROW_WIDTH) out.push('');
      out[COL.MEMBER] = member;
      out[COL.FACTOR] = factor;
      out[COL.UPDATED_AT] = updatedAt || new Date().toISOString();
      out[COL.UPDATED_BY] = MIGRATOR_EMAIL;
      const lastCol = String.fromCharCode(65 + out.length - 1);
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${DIM_TAB}!A${existing.rowIndex}:${lastCol}${existing.rowIndex}`,
        valueInputOption: 'RAW',
        requestBody: { values: [out] },
      });
      merged += 1;
      console.log(`  ~ ${security}: updated Dim-values row ${existing.rowIndex}`);
    } else {
      // Append a fresh row
      const out = new Array(ROW_WIDTH).fill('');
      out[COL.TYPE] = 'Stock';
      out[COL.SECURITY] = security;
      out[COL.MEMBER] = member;
      out[COL.FACTOR] = factor;
      out[COL.UPDATED_AT] = updatedAt || new Date().toISOString();
      out[COL.UPDATED_BY] = MIGRATOR_EMAIL;
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: DIM_TAB,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [out] },
      });
      appended += 1;
      console.log(`  + ${security}: appended to Dim-values`);
    }
  }
  console.log(`\nMerge done. Updated ${merged}, appended ${appended}.`);

  // ── Delete the Ownership tab ─────────────────────────────────────────────
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
    fields: 'sheets.properties(sheetId,title)',
  });
  const target = (meta.data.sheets || []).find((s) => s.properties.title === OWNERSHIP_TAB);
  if (target) {
    console.log(`\nDeleting Ownership tab (sheetId=${target.properties.sheetId})…`);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ deleteSheet: { sheetId: target.properties.sheetId } }] },
    });
    console.log('✓ Ownership tab deleted.');
  } else {
    console.log('Ownership tab not found (already deleted?).');
  }

  console.log('\n✅ Done. Reload the Admin page — it should now show all mappings.');
}

main().catch((err) => {
  console.error('\n❌ Failed:', err.message);
  if (err.errors) console.error(err.errors);
  process.exit(1);
});
