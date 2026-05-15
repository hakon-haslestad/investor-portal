// Public config. Sheet ID and OAuth Client ID are NOT secrets — both are
// safe to commit. Auth is enforced by Google Sign-In + sheet share list.

window.GEYSIR_CONFIG = {
  // Google Sheet that holds all club data. Same one used by the old portal.
  SHEET_ID: '1RIkvHAojO1E4B622Li04RdQM9lVZJfJ1oMoRg8sWyE4',

  // OAuth 2.0 Client ID (Web application) from Google Cloud Console.
  // Paste yours here. See README for setup instructions.
  OAUTH_CLIENT_ID: '872440185175-io8gmos8q04sq7jdt99ubeb16hbopv47.apps.googleusercontent.com',

  // Scopes: read+write Sheets the user already has access to, plus
  // openid+email so the page can look the signed-in user up in the Members tab.
  OAUTH_SCOPE: 'openid email https://www.googleapis.com/auth/spreadsheets',

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
};
