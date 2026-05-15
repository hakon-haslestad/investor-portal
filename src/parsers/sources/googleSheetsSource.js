const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// Full read/write scope so the Admin tab can persist ownership edits back to the sheet.
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

function resolveKeyPath() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) return null;
  return path.isAbsolute(raw) ? raw : path.join(__dirname, '..', '..', '..', raw);
}

function readKeyJson() {
  const p = resolveKeyPath();
  if (!p) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY env var not set');
  if (!fs.existsSync(p)) throw new Error(`Service account key file not found: ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function getServiceAccountEmail() {
  try {
    return readKeyJson().client_email || null;
  } catch (_err) {
    return null;
  }
}

function keyFileConfigured() {
  const p = resolveKeyPath();
  return Boolean(p && fs.existsSync(p));
}

/**
 * Accepts a raw sheet ID (44+ char string) or a Google Sheets URL and returns
 * just the ID. Throws on garbage input.
 */
function extractSheetId(input) {
  if (!input) throw new Error('No sheet URL or ID provided');
  const s = String(input).trim();
  const urlMatch = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (urlMatch) return urlMatch[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(s)) return s;
  throw new Error('Could not extract a sheet ID from that input');
}

/** Extracts the numeric `gid` (per-tab sheet ID) from a Google Sheets URL. */
function extractGid(input) {
  if (!input) return null;
  const s = String(input);
  const m = s.match(/[?#&]gid=(\d+)/);
  return m ? Number(m[1]) : null;
}

let _sheetsClient = null;
function getSheetsClient() {
  if (_sheetsClient) return _sheetsClient;
  const credentials = readKeyJson();
  const auth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
  _sheetsClient = google.sheets({ version: 'v4', auth });
  return _sheetsClient;
}

/**
 * Pads each row to the header (row 0) length with null. Google omits trailing
 * empty cells, but the parsers index by column so we need uniform widths.
 */
function padRows(rows) {
  if (!rows.length) return rows;
  const headerLen = rows[0].length;
  for (const r of rows) {
    while (r.length < headerLen) r.push(null);
  }
  return rows;
}

function createGoogleSheetsSource({ spreadsheetId }) {
  if (!spreadsheetId) throw new Error('spreadsheetId is required');
  const sheets = getSheetsClient();
  return {
    type: 'google',
    spreadsheetId,
    async getSheet(name) {
      try {
        const res = await sheets.spreadsheets.values.get({
          spreadsheetId,
          range: name,
          valueRenderOption: 'UNFORMATTED_VALUE',
          dateTimeRenderOption: 'SERIAL_NUMBER',
        });
        const values = res.data.values || [];
        return padRows(values);
      } catch (err) {
        // Treat "sheet doesn't exist" as empty rather than fatal
        if (err.code === 400 && /Unable to parse range/i.test(err.message || '')) return [];
        throw err;
      }
    },
    async hasSheet(name) {
      const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
      return (meta.data.sheets || []).some((s) => s.properties && s.properties.title === name);
    },
    async getSheetNameByGid(gid) {
      const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties(sheetId,title)' });
      const match = (meta.data.sheets || []).find((s) => s.properties && Number(s.properties.sheetId) === Number(gid));
      return match ? match.properties.title : null;
    },
    async ensureSheet(name, headers) {
      const exists = await this.hasSheet(name);
      if (exists) return false;
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: name } } }] },
      });
      if (headers && headers.length) {
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `${name}!A1`,
          valueInputOption: 'RAW',
          requestBody: { values: [headers] },
        });
      }
      return true;
    },
    async appendRow(name, row) {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: name,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [row] },
      });
    },
    async updateRow(name, rowIndex1Based, row) {
      // rowIndex1Based: 1-based sheet row (e.g. header = 1, first data row = 2)
      const lastCol = String.fromCharCode(65 + row.length - 1); // A,B,C…
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${name}!A${rowIndex1Based}:${lastCol}${rowIndex1Based}`,
        valueInputOption: 'RAW',
        requestBody: { values: [row] },
      });
    },
  };
}

module.exports = {
  createGoogleSheetsSource,
  extractSheetId,
  extractGid,
  getServiceAccountEmail,
  keyFileConfigured,
};
