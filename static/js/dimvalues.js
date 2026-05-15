// Read + write the Dim-values tab. Ported from src/services/ownership.js.
// Now Dim-values is the single source of truth for attribution.
//
// Column layout:
//   A(0) Name (Security)  ← PK
//   B(1) Investor (Member string — "HH" / "HS/ØS" / etc.)
//   C(2) Investment factor
//   D(3) UpdatedAt   (new; portal stamps on every write)
//   E(4) UpdatedBy   (new; portal stamps with signed-in email)

(function () {
  const TAB = window.GEYSIR_CONFIG.TABS.dimValues;
  const SECURITY_COL = 0;
  const MEMBER_COL = 1;
  const FACTOR_COL = 2;
  const UPDATED_AT_COL = 3;
  const UPDATED_BY_COL = 4;
  const ROW_WIDTH = 5;

  // Build a map { security → { rowIndex, member, factor, updatedAt } }
  // rowIndex is 1-based to match what updateRow expects.
  async function readIndex() {
    const rows = await window.Sheet.getValues(TAB);
    const map = new Map();
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i] || [];
      const security = (row[SECURITY_COL] || '').toString().trim();
      if (!security) continue;
      map.set(security, {
        security,
        rowIndex: i + 1,
        member: (row[MEMBER_COL] || '').toString().trim(),
        factor: row[FACTOR_COL] === '' || row[FACTOR_COL] == null ? null : Number(row[FACTOR_COL]),
        updatedAt: (row[UPDATED_AT_COL] || '').toString(),
        updatedBy: (row[UPDATED_BY_COL] || '').toString(),
        rawRow: row,
      });
    }
    return { map, rows };
  }

  // Upsert one security. Returns { action, conflict } where `conflict` is set
  // if the row's UpdatedAt changed since `expectedUpdatedAt` (soft guard).
  async function upsert({ security, member, factor, signedInEmail, expectedUpdatedAt }) {
    if (!security || !member) throw new Error('security and member are required');
    const { map } = await readIndex();
    const existing = map.get(security);
    const nowIso = new Date().toISOString();

    if (existing && expectedUpdatedAt != null && existing.updatedAt && existing.updatedAt !== expectedUpdatedAt) {
      return { action: 'conflict', security, existing };
    }

    const row = existing ? existing.rawRow.slice() : [];
    while (row.length < ROW_WIDTH) row.push('');
    row[SECURITY_COL] = security;
    row[MEMBER_COL] = member;
    row[FACTOR_COL] = factor != null && factor !== '' ? Number(factor) : '';
    row[UPDATED_AT_COL] = nowIso;
    row[UPDATED_BY_COL] = signedInEmail || '';

    if (existing) {
      await window.Sheet.updateRow(TAB, existing.rowIndex, row);
      return { action: 'updated', security, updatedAt: nowIso };
    }
    await window.Sheet.appendRow(TAB, row);
    return { action: 'appended', security, updatedAt: nowIso };
  }

  window.DimValues = { TAB, readIndex, upsert };
})();
