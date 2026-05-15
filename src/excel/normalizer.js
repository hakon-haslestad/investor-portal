const INVESTOR_CODES = ['HH', 'HS', 'ØS', 'JC', 'HF'];

function normalizeInvestorCode(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s === 'ØF') return 'ØS';
  if (s === 'OS') return 'ØS';
  return s;
}

function normalizeSecurityName(raw) {
  if (raw == null) return null;
  return String(raw).trim();
}

function parseMemberCell(cell) {
  if (cell == null) return [];
  const s = String(cell).trim();
  if (!s) return [];
  if (s === 'Deposit' || s === 'NA' || s === 'Alle') return [{ code: s, weight: 1.0 }];
  const codes = s.split(/[\/+]/).map((p) => normalizeInvestorCode(p)).filter(Boolean);
  if (!codes.length) return [];
  const weight = 1.0 / codes.length;
  return codes.map((c) => ({ code: c, weight }));
}

function excelDateToISO(v) {
  if (v == null) return null;
  if (v instanceof Date) {
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === 'number') {
    const ms = (v - 25569) * 86400 * 1000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

module.exports = {
  INVESTOR_CODES,
  normalizeInvestorCode,
  normalizeSecurityName,
  parseMemberCell,
  excelDateToISO,
};
