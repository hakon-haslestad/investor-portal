const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'geysir.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = TRUNCATE');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  investor_code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nordnet_id TEXT,
  trade_date TEXT NOT NULL,
  settle_date TEXT,
  book_date TEXT,
  type TEXT NOT NULL,
  security TEXT,
  isin TEXT,
  qty REAL,
  price REAL,
  amount_nok REAL,
  currency TEXT,
  fee REAL,
  running_balance REAL,
  fx_rate REAL,
  transaction_text TEXT,
  source_row INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(trade_date);
CREATE INDEX IF NOT EXISTS idx_tx_isin ON transactions(isin);
CREATE INDEX IF NOT EXISTS idx_tx_security ON transactions(security);

-- Security → investor attribution. One row per (security, investor_code) pair.
-- weight is fractional (1.0 = sole owner, 0.5 = shared, 0.333… = 3-way).
CREATE TABLE IF NOT EXISTS security_attribution (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  security TEXT NOT NULL,
  isin TEXT,
  investor_code TEXT NOT NULL,
  weight REAL NOT NULL,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_sec_attr_sec ON security_attribution(security);
CREATE INDEX IF NOT EXISTS idx_sec_attr_isin ON security_attribution(isin);
CREATE INDEX IF NOT EXISTS idx_sec_attr_inv ON security_attribution(investor_code);

-- Per-security metadata managed via the Admin page (the user-facing equivalent
-- of the "Dim-values" sheet). The expanded (security, investor, weight) rows
-- live in security_attribution.
CREATE TABLE IF NOT EXISTS security_meta (
  security TEXT PRIMARY KEY,
  type TEXT,
  category_tick TEXT,
  member_string TEXT,
  factor REAL,
  isin TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS holdings_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date TEXT NOT NULL,
  security TEXT NOT NULL,
  isin TEXT,
  currency TEXT,
  qty REAL,
  gav REAL,
  current_price REAL,
  market_value_nok REAL,
  margin_value REAL,
  return_pct REAL,
  return_nok REAL
);
CREATE INDEX IF NOT EXISTS idx_holdings_date ON holdings_snapshot(snapshot_date);

CREATE TABLE IF NOT EXISTS kpi_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year INTEGER,
  company TEXT,
  revenue TEXT,
  our_share_rev REAL,
  eat TEXT,
  our_share_eat REAL,
  price TEXT,
  eps TEXT,
  pe REAL
);

CREATE TABLE IF NOT EXISTS competitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL CHECK(type IN ('individual','team')),
  mode TEXT NOT NULL CHECK(mode IN ('full_portfolio','assigned_picks')),
  metric TEXT NOT NULL CHECK(metric IN ('return_pct','absolute_pnl')),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  narrative_json TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS competition_participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  competition_id INTEGER NOT NULL,
  investor_code TEXT NOT NULL,
  team_label TEXT,
  buy_in_nok REAL,
  FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cp_comp ON competition_participants(competition_id);

CREATE TABLE IF NOT EXISTS competition_picks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  competition_id INTEGER NOT NULL,
  investor_code TEXT NOT NULL,
  security TEXT NOT NULL,
  isin TEXT,
  label TEXT,
  FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cpk_comp ON competition_picks(competition_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS upload_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  uploaded_by TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  rows_imported INTEGER,
  holdings_imported INTEGER,
  attributions_imported INTEGER
);
`;

db.exec(SCHEMA);

const _getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const _setSetting = db.prepare(`
  INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
`);

function getSetting(key) {
  const row = _getSetting.get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  _setSetting.run(key, value == null ? null : String(value));
}

module.exports = db;
module.exports.getSetting = getSetting;
module.exports.setSetting = setSetting;
