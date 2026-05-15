/**
 * Single source of truth for casual "investment bro" copy used throughout the UI.
 * Keep it tight, slightly chaotic, mostly in English with the occasional Norwegian word.
 * Avoid corporate disclaimer-y phrasing.
 */

const NAMES = {
  HH: 'Haslestad',
  HS: 'Sundland',
  ØS: 'Stubberud',
  JC: 'Curran',
  HF: 'Førsund',
};

const greetings = [
  'Yo, $name — ready to count the bag?',
  'What up $name, market\'s open',
  '$name in the building 🔥',
  'Good to see you $name. Numbers don\'t lie.',
];

const dashboardHeadings = {
  totalValue: 'Total bag',
  unrealized: 'Paper money',
  realized: 'Banked profit',
  dividends: 'Free money (utbytte)',
  cash: 'Dry powder',
};

const leaderboardHeadings = {
  inception: 'All-time GOAT 🐐',
  ytd: 'Best this year',
  bestPick: 'Best single bet',
  monthly: 'Last 6 months — who cooked?',
};

const verdictPhrases = {
  bigWinner: (name, pct) => `${name} ate. Up ${pct}%. Pure cooking.`,
  modestWin: (name, pct) => `${name} grinding — ${pct}% in the green`,
  flat: (name) => `${name} doing nothing. Neither winning nor losing. Just vibes.`,
  modestLoss: (name, pct) => `${name} down ${pct}%. It happens.`,
  bigLoss: (name, pct) => `${name} cooked. ${pct}% down. RIP. 💀`,
};

const podium = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];

const emptyStates = {
  noHoldings: 'Nothing here yet. Buy something already.',
  noTransactions: 'No trades. Bro is paper-handed.',
  noCompetitions: 'No competitions running. Start one — make this interesting.',
  noUpload: 'Drop the latest Nordnet export here and we\'ll crunch it.',
};

const nav = {
  dashboard: 'Dashboard',
  competitions: 'Comps',
  upload: 'Upload',
  logout: 'Bounce',
};

const verdictFromReturn = (name, pct) => {
  const p = Number(pct);
  if (!Number.isFinite(p)) return `${name}: TBD`;
  if (p >= 50) return verdictPhrases.bigWinner(name, p.toFixed(1));
  if (p >= 5) return verdictPhrases.modestWin(name, p.toFixed(1));
  if (p > -5) return verdictPhrases.flat(name);
  if (p > -20) return verdictPhrases.modestLoss(name, Math.abs(p).toFixed(1));
  return verdictPhrases.bigLoss(name, Math.abs(p).toFixed(1));
};

const formatNok = (n) => {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Math.round(Number(n));
  return v.toLocaleString('nb-NO') + ' kr';
};

const formatPct = (n) => {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  const sign = v > 0 ? '+' : '';
  return sign + v.toFixed(1) + '%';
};

const randomFrom = (arr) => arr[Math.floor(Math.random() * arr.length)];

module.exports = {
  NAMES,
  greetings,
  dashboardHeadings,
  leaderboardHeadings,
  verdictPhrases,
  verdictFromReturn,
  podium,
  emptyStates,
  nav,
  formatNok,
  formatPct,
  randomFrom,
};
