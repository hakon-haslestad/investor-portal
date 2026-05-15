require('dotenv').config();
const db = require('../src/db');
const { createCompetition } = require('../src/competitions/engine');

const NAME = 'Fall 2025: The Comeback';

// Reset prior Fall 2025 entries so re-running is idempotent
const existing = db.prepare('SELECT id FROM competitions WHERE name = ?').all(NAME);
for (const e of existing) {
  db.prepare('DELETE FROM competitions WHERE id = ?').run(e.id);
}

// Participants — JC + ØS form a team, the rest fly solo. All bet 50k each (Spring 2026 style)
const participants = [
  { investor_code: 'HF', team_label: 'HF',     buy_in_nok: 50000 },
  { investor_code: 'HH', team_label: 'HH',     buy_in_nok: 50000 },
  { investor_code: 'HS', team_label: 'HS',     buy_in_nok: 50000 },
  { investor_code: 'JC', team_label: 'JC+ØS',  buy_in_nok: 50000 },
  { investor_code: 'ØS', team_label: 'JC+ØS',  buy_in_nok: 50000 },
];

const picks = [
  { investor_code: 'HF', security: 'Cadeler' },
  { investor_code: 'HH', security: 'Nordea Bank' },
  { investor_code: 'HH', security: 'Strategy A' },
  { investor_code: 'HH', security: 'Scibase Holding' },
  { investor_code: 'HS', security: 'Humble Group' },
  { investor_code: 'HS', security: 'Seafire' },
  { investor_code: 'JC', security: 'Xplora Technologies' },
  { investor_code: 'ØS', security: 'Xplora Technologies' },
];

const narrative = {
  subtitle: 'Started November 2025. Buy-in: 50k per head. Mode: stock-pick.',
  setup_teaser: 'Each picked their bet. HF rode Cadeler. HH spread it across Nordea + Strategy + Scibase. HS doubled up on Humble & Seafire. JC + ØS teamed on Xplora.',
  early_teaser: 'First month — feeling each other out, no big moves.',
  pivot_title: 'The pivot (HH & HS chase HF)',
  pivot_teaser: 'Cadeler started running. HH and HS panic-pivoted hard. Did the gamble pay off? Receipts below.',
  verdict: '', // will be auto-generated
};

const id = createCompetition({
  name: NAME,
  description: 'Five-way stock-pick comp seeded from the original Fall 2025 spec.',
  type: 'team',
  mode: 'assigned_picks',
  metric: 'return_pct',
  start_date: '2025-11-01',
  end_date: '2026-05-13', // through latest snapshot
  participants,
  picks,
  narrative,
});

console.log(`Seeded competition "${NAME}" → id=${id}`);
