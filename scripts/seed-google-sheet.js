require('dotenv').config();
const { getSetting, setSetting } = require('../src/db');
const { extractSheetId, extractGid } = require('../src/parsers/sources/googleSheetsSource');

const DEFAULT_URL = 'https://docs.google.com/spreadsheets/d/1RIkvHAojO1E4B622Li04RdQM9lVZJfJ1oMoRg8sWyE4/edit?gid=1085340634#gid=1085340634';
const OWNERS_TAB_URL = 'https://docs.google.com/spreadsheets/d/1RIkvHAojO1E4B622Li04RdQM9lVZJfJ1oMoRg8sWyE4/edit?gid=1599375129#gid=1599375129';

const id = extractSheetId(DEFAULT_URL);
const ownersGid = extractGid(OWNERS_TAB_URL);

// URL/ID are upsert-safe — re-running keeps them current. Owners gid is the
// canonical pointer to the attribution tab inside the spreadsheet.
setSetting('google_sheet_url', DEFAULT_URL);
setSetting('google_sheet_id', id);
if (ownersGid != null) setSetting('google_sheet_owners_gid', String(ownersGid));

console.log(`Seeded Google Sheet config:`);
console.log(`  URL:        ${DEFAULT_URL}`);
console.log(`  ID:         ${id}`);
console.log(`  Owners gid: ${ownersGid}`);
console.log('Attribution edits in the Admin tab will be written to that tab.');
