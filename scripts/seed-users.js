require('dotenv').config();
const { createUser } = require('../src/auth');

const DEFAULT_PASSWORD = process.env.DEFAULT_PASSWORD || 'geysir2026';

const USERS = [
  { code: 'HH', name: 'Haslestad', email: 'haakon.haslestad@gmail.com' },
  { code: 'HS', name: 'Sundland',  email: 'sundland92@gmail.com' },
  { code: 'ØS', name: 'Stubberud', email: 'os@geysir.local' },
  { code: 'JC', name: 'Curran',    email: 'jc@geysir.local' },
  { code: 'HF', name: 'Førsund',   email: 'hf@geysir.local' },
];

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
