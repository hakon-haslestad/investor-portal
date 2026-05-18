require('dotenv').config();
const { createUser } = require('../src/auth');

const DEFAULT_PASSWORD = process.env.DEFAULT_PASSWORD;
if (!DEFAULT_PASSWORD) {
  console.error('DEFAULT_PASSWORD is not set in .env');
  process.exit(1);
}

// Map investor codes to real emails via env, e.g.
//   GEYSIR_USER_EMAILS=HH:a@example.com,HS:b@example.com,ØS:...
const EMAIL_MAP = Object.fromEntries(
  (process.env.GEYSIR_USER_EMAILS || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const idx = p.indexOf(':');
      return [p.slice(0, idx).trim(), p.slice(idx + 1).trim()];
    })
);

const USERS = [
  { code: 'HH', name: 'Investor HH' },
  { code: 'HS', name: 'Investor HS' },
  { code: 'ØS', name: 'Investor ØS' },
  { code: 'JC', name: 'Investor JC' },
  { code: 'HF', name: 'Investor HF' },
].map((u) => ({ ...u, email: EMAIL_MAP[u.code] || `${u.code.toLowerCase()}@example.local` }));

(async () => {
  console.log(`Seeding 5 investor accounts (default password: ${DEFAULT_PASSWORD})…`);
  for (const u of USERS) {
    const result = await createUser({
      email: u.email,
      password: DEFAULT_PASSWORD,
      investorCode: u.code,
      displayName: u.name,
    });
    console.log(`  ${result.updated ? 'updated' : 'created'}: ${u.code} (${u.name}) → ${u.email}`);
  }
  console.log('Done. Log in with any of these emails + the default password.');
})();
