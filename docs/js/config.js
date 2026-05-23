// Public config. Sheet ID and OAuth Client ID are NOT secrets — both are
// safe to commit. Auth is enforced by Google Sign-In + sheet share list.

window.PORTAL_CONFIG = {
  // Google Sheet that holds all club data. Same one used by the old portal.
  SHEET_ID: '1RIkvHAojO1E4B622Li04RdQM9lVZJfJ1oMoRg8sWyE4',

  // Separate sheet for the konsolidert bookkeeping workbook (saldobalanse,
  // hovedbok, raw DNB/Nordnet). Read-only from the portal. Share list is
  // managed in Google Sheets — anyone in Members but not on the share list
  // gets a clean "ask admin" error on the accounting page, the rest of the
  // portal is unaffected.
  ACCOUNTING_SHEET_ID: '1WrftDyn76s5Z1ueDpPxi_VntPRVN7sb6sU9Ssr7zBNs',

  // OAuth 2.0 Client ID (Web application) from Google Cloud Console.
  // Paste yours here. See README for setup instructions.
  OAUTH_CLIENT_ID: '872440185175-io8gmos8q04sq7jdt99ubeb16hbopv47.apps.googleusercontent.com',

  // Scopes — read-only by default (members). Admin pages incrementally
  // request the full read+write scope when needed. openid+email is
  // needed either way so the page can look the user up in the Members tab.
  // Accounting deliberately stays inside spreadsheets.readonly — no Drive scope.
  OAUTH_SCOPE: 'openid email https://www.googleapis.com/auth/spreadsheets.readonly',
  OAUTH_SCOPE_WRITE: 'openid email https://www.googleapis.com/auth/spreadsheets',

  // Sheet tab names.
  TABS: {
    transactions: 'Rådata fra nordnet',
    holdings: 'Beholdningsverdi',
    kpis: 'Offisielle nøkkeltall',
    dimValues: 'Dim-values',
    members: 'Members',
    competitions: 'Competitions',
    participants: 'Competition_Participants',
    picks: 'Competition_Picks',
  },

  // Tab names inside the accounting sheet. The (2) suffix on sbCurrent and
  // hbCurrent is the existing convention for "current year work-in-progress"
  // — yearly rollover is a one-line edit here (rename to SB, 25 / HB, 25 in
  // Google Sheets, then update these strings).
  ACCOUNTING_TABS: {
    index: 'INDEX',
    sbCurrent: 'SB, 24 (2)',
    hbCurrent: 'HB, 24 (2)',
    nordnetCurrent: 'Nordnet 25',
    bankCurrent: 'Bank 25',
    maestro: 'Maestro',
    shortChart: 'Kort kontoplan',
    fullChart: 'Full kontoplan',
    dnbRaw: 'DNB_raw',
    nordnetRaw: 'Nordnet_raw',
    nordnetRealisasjon: 'Nordnet_realisasjon',
  },

  // The year that sbCurrent / hbCurrent / nordnetCurrent / bankCurrent
  // represent. Used by the accounting page to flag staleness when the
  // calendar year moves on past this without a tab rename.
  ACCOUNTING_CURRENT_YEAR: 2025,
};
