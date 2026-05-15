/**
 * Ownership tab in the Google Sheet — the source of truth for active-stock
 * investor attribution. The Admin tab reads and writes through this module.
 *
 * Layout (rows in the sheet):
 *   row 1 — headers: Security | Member | Factor | UpdatedAt
 *   row 2+ — one row per stock (PK = Security; matches Beholdningsverdi.Handel)
 *
 * Stocks that have been fully sold (no current Beholdningsverdi row) keep
 * their attribution in local SQLite only — this module ignores them.
 */

const DEFAULT_TAB = 'Ownership';
const HEADERS = ['Security', 'Member', 'Factor', 'UpdatedAt'];

/**
 * Resolves the tab name to write attribution into. Prefers the explicit
 * gid stored in settings (`google_sheet_owners_gid`) — lets the user point
 * at any existing tab without code changes. Falls back to a tab named
 * "Ownership" which the app will auto-create.
 */
async function resolveOwnershipTab(source, gid) {
  if (gid != null) {
    const byGid = await source.getSheetNameByGid(gid);
    if (byGid) return byGid;
  }
  await source.ensureSheet(DEFAULT_TAB, HEADERS);
  return DEFAULT_TAB;
}

/**
 * Make sure the tab has a header row of *some* kind. We write our default
 * headers only if the tab is completely empty. Otherwise we trust whatever
 * the user typed and use column positions:
 *   col A → Security (PK)   col B → Investors   col C → Factor   col D → UpdatedAt
 *
 * If you want different column meanings, change the column ORDER, not the
 * header text — the app reads/writes by position, not by name.
 */
async function ensureHeaders(source, tabName) {
  const rows = await source.getSheet(tabName);
  if (!rows.length) {
    await source.appendRow(tabName, HEADERS);
  }
}

async function readOwnership(source, tabName) {
  await ensureHeaders(source, tabName);
  const rows = await source.getSheet(tabName);
  const map = new Map();
  if (rows.length < 2) return map;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const security = (row[0] || '').toString().trim();
    if (!security) continue;
    const member = (row[1] || '').toString().trim();
    const factorRaw = row[2];
    const factor = factorRaw == null || factorRaw === '' ? null : Number(factorRaw);
    map.set(security, {
      security,
      member,
      factor: Number.isFinite(factor) ? factor : null,
      rowIndex: i + 1,
    });
  }
  return map;
}

async function upsertOwnership(source, tabName, { security, member, factor }) {
  await ensureHeaders(source, tabName);
  const existing = await readOwnership(source, tabName);
  const now = new Date().toISOString();
  const row = [security, member, factor != null ? Number(factor) : '', now];
  const hit = existing.get(security);
  if (hit) {
    await source.updateRow(tabName, hit.rowIndex, row);
    return { action: 'updated', security, tab: tabName };
  }
  await source.appendRow(tabName, row);
  return { action: 'appended', security, tab: tabName };
}

module.exports = {
  DEFAULT_TAB,
  HEADERS,
  resolveOwnershipTab,
  readOwnership,
  upsertOwnership,
};
