/**
 * One-shot migration: copy local SQLite-only state into the Google Sheet
 * so the new static portal can run from the sheet as the single source of truth.
 *
 * Idempotent: safe to re-run. If a tab already exists, only missing rows are appended.
 *
 * Run:
 *   GOOGLE_SERVICE_ACCOUNT_KEY=./data/google-service-account.json \
 *   node scripts/migrate-to-sheet.js
 *
 * After it succeeds, delete this file and the service account JSON.
 */

require('dotenv').config();
const db = require('../src/db');
const { getSetting } = require('../src/db');
const {
  createGoogleSheetsSource,
  keyFileConfigured,
  getServiceAccountEmail,
} = require('../src/parsers/sources/googleSheetsSource');
const { MANUAL_ATTRIBUTION } = require('../src/excel/manual-attribution');

// ──────────────────────────────────────────────────────────────────────────────
// Config

const SHEET_ID = process.env.SHEET_ID || getSetting('google_sheet_id');
const NOW_ISO = new Date().toISOString();
const MIGRATOR = `migrate-script (${getServiceAccountEmail() || 'service-account'})`;

if (!keyFileConfigured()) {
  console.error('GOOGLE_SERVICE_ACCOUNT_KEY is not set or the file is missing.');
  process.exit(1);
}
if (!SHEET_ID) {
  console.error('No sheet ID — set SHEET_ID env var or seed local settings first.');
  process.exit(1);
}

const TABS = {
  members: 'Members',
  competitions: 'Competitions',
  participants: 'Competition_Participants',
  picks: 'Competition_Picks',
  dimValues: 'Dim-values',
};

// ──────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Sheet ID: ${SHEET_ID}`);
  console.log(`Service account: ${getServiceAccountEmail()}`);
  const source = createGoogleSheetsSource({ spreadsheetId: SHEET_ID });

  await migrateMembers(source);
  await migrateCompetitions(source);
  await migrateParticipants(source);
  await migratePicks(source);
  await migrateManualAttribution(source);

  console.log('\n✅ Migration complete. Next steps:');
  console.log('   1. Open the sheet, replace any "*.local" emails in Members with real Google addresses.');
  console.log('   2. Share the sheet with each member (Editor) if not already.');
  console.log('   3. Delete scripts/migrate-to-sheet.js and the service account JSON.');
}

// ──────────────────────────────────────────────────────────────────────────────
// Members

async function migrateMembers(source) {
  console.log('\n— Members —');
  const headers = ['Email', 'InvestorCode', 'DisplayName', 'Role', 'CreatedAt'];
  const created = await source.ensureSheet(TABS.members, headers);
  console.log(created ? 'Created tab.' : 'Tab already exists.');

  const existingRows = await source.getSheet(TABS.members);
  const existingEmails = new Set(
    existingRows.slice(1).map((r) => (r[0] || '').toString().trim().toLowerCase()).filter(Boolean)
  );

  const users = db
    .prepare('SELECT email, investor_code, display_name, created_at FROM users ORDER BY id')
    .all();

  for (const u of users) {
    const email = (u.email || '').trim().toLowerCase();
    if (!email) continue;
    if (existingEmails.has(email)) {
      console.log(`  skip ${email} (already present)`);
      continue;
    }
    const role = email === 'redacted@example.com' ? 'admin' : 'member';
    await source.appendRow(TABS.members, [
      email, u.investor_code, u.display_name, role, u.created_at || NOW_ISO,
    ]);
    console.log(`  + ${email} → ${u.investor_code}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Competitions

async function migrateCompetitions(source) {
  console.log('\n— Competitions —');
  const headers = ['Id', 'Name', 'Description', 'Type', 'Mode', 'Metric',
                   'StartDate', 'EndDate', 'NarrativeJson', 'CreatedBy', 'CreatedAt'];
  const created = await source.ensureSheet(TABS.competitions, headers);
  console.log(created ? 'Created tab.' : 'Tab already exists.');

  const existing = await source.getSheet(TABS.competitions);
  const seen = new Set(existing.slice(1).map((r) => (r[0] || '').toString()));

  const rows = db.prepare(`
    SELECT id, name, description, type, mode, metric, start_date, end_date,
           narrative_json, created_at
    FROM competitions ORDER BY id
  `).all();

  for (const c of rows) {
    const id = idFromSqliteId(c.id);
    if (seen.has(id)) { console.log(`  skip ${id} (already present)`); continue; }
    await source.appendRow(TABS.competitions, [
      id, c.name, c.description || '', c.type, c.mode, c.metric,
      c.start_date || '', c.end_date || '',
      c.narrative_json || '', MIGRATOR, c.created_at || NOW_ISO,
    ]);
    console.log(`  + ${id} ${c.name}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Competition_Participants

async function migrateParticipants(source) {
  console.log('\n— Competition_Participants —');
  const headers = ['CompetitionId', 'InvestorCode', 'TeamLabel', 'BuyInNok'];
  const created = await source.ensureSheet(TABS.participants, headers);
  console.log(created ? 'Created tab.' : 'Tab already exists.');

  const existing = await source.getSheet(TABS.participants);
  const seen = new Set(existing.slice(1).map((r) => `${r[0]}|${r[1]}`));

  const rows = db.prepare(`
    SELECT competition_id, investor_code, team_label, buy_in_nok
    FROM competition_participants
  `).all();

  for (const p of rows) {
    const compId = idFromSqliteId(p.competition_id);
    const key = `${compId}|${p.investor_code}`;
    if (seen.has(key)) { console.log(`  skip ${key} (already present)`); continue; }
    await source.appendRow(TABS.participants, [
      compId, p.investor_code, p.team_label || '', p.buy_in_nok || 0,
    ]);
    console.log(`  + ${key}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Competition_Picks

async function migratePicks(source) {
  console.log('\n— Competition_Picks —');
  const headers = ['CompetitionId', 'InvestorCode', 'Security', 'Isin', 'Label'];
  const created = await source.ensureSheet(TABS.picks, headers);
  console.log(created ? 'Created tab.' : 'Tab already exists.');

  const existing = await source.getSheet(TABS.picks);
  const seen = new Set(existing.slice(1).map((r) => `${r[0]}|${r[1]}|${r[2]}`));

  const rows = db.prepare(`
    SELECT competition_id, investor_code, security
    FROM competition_picks
  `).all();

  for (const p of rows) {
    const compId = idFromSqliteId(p.competition_id);
    const key = `${compId}|${p.investor_code}|${p.security}`;
    if (seen.has(key)) { console.log(`  skip ${key} (already present)`); continue; }
    await source.appendRow(TABS.picks, [
      compId, p.investor_code, p.security, '', '',
    ]);
    console.log(`  + ${key}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Manual attribution overrides → append to Dim-values
//
// The existing sheet's Dim-values layout has the attribution columns in fixed
// positions: G(type) H(name) I(tick) J(member) K(factor) ... O(isin).
// We write into the same column layout so the existing parser still works.
//
// NOTE: this does NOT add the new UpdatedAt/UpdatedBy columns — that's a
// schema change the user should do once in the sheet UI to avoid clobbering
// any other columns. The static portal stamps those columns on every write
// regardless of whether they exist yet (they'll just go into empty cells).

async function migrateManualAttribution(source) {
  console.log('\n— Dim-values (manual overrides) —');
  const rows = await source.getSheet(TABS.dimValues);
  if (!rows.length) {
    console.log('  Dim-values is empty or missing — skipping.');
    return;
  }
  // Build a set of existing security names (column H, index 7).
  const existing = new Set(
    rows.slice(1)
      .map((r) => (r[7] || '').toString().trim())
      .filter(Boolean)
  );

  const entries = Object.entries(MANUAL_ATTRIBUTION);
  let added = 0;
  for (const [security, owners] of entries) {
    if (existing.has(security)) {
      console.log(`  skip ${security} (already in Dim-values)`);
      continue;
    }
    const member = owners.map((o) => o.code).join('/');
    const factor = owners[0].weight;
    // Pad to 15 columns to land Member at J(9), Factor at K(10), ISIN at O(14).
    const row = new Array(15).fill('');
    row[6] = 'Stock';     // G: Type
    row[7] = security;    // H: Name
    row[9] = member;      // J: Member
    row[10] = factor;     // K: Factor
    // O (14): ISIN left blank
    await source.appendRow(TABS.dimValues, row);
    added += 1;
    console.log(`  + ${security} → ${member} @ ${factor}`);
  }
  console.log(`  Added ${added} manual override${added === 1 ? '' : 's'}.`);
}

// ──────────────────────────────────────────────────────────────────────────────

function idFromSqliteId(n) {
  // Keep the SQLite int as a deterministic short string so cross-tab refs
  // stay consistent across this single migration run.
  return `c_${n}`;
}

main().catch((err) => {
  console.error('\n❌ Migration failed:', err.message);
  if (err.errors) console.error(err.errors);
  process.exit(1);
});
