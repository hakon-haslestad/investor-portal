// Fetch-based Google Sheets API v4 client.
// Uses the access token from window.Auth.

(function () {
  const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

  function sheetId(override) {
    return override || window.PORTAL_CONFIG.SHEET_ID;
  }

  // Wrap a tab name in single quotes for safe use as a Sheets API range.
  // Required when the tab name contains commas, parentheses, or other
  // special chars (e.g. 'SB, 24 (2)'). Embedded single quotes are doubled
  // per the Sheets quoting rules. Plain names like 'Members' work either
  // quoted or unquoted, so we always quote — single code path.
  function quoteRange(tab, a1) {
    const quoted = "'" + String(tab).replace(/'/g, "''") + "'";
    return a1 ? `${quoted}!${a1}` : quoted;
  }

  async function authedFetch(url, opts = {}) {
    const token = await window.Auth.accessToken();
    const r = await fetch(url, {
      ...opts,
      headers: {
        ...(opts.headers || {}),
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
    });
    if (r.status === 401) {
      // Token may have expired mid-session — clear cache and bubble up so caller can retry.
      sessionStorage.removeItem('portal.token');
      throw new Error('unauthenticated');
    }
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`Sheets API ${r.status}: ${body.slice(0, 200)}`);
    }
    return r.json();
  }

  // Reads a single tab. Returns 2-D array of cells (rows). Empty trailing cells are dropped by Sheets.
  // Pass opts.sheetId to read from a sheet other than the portfolio one (e.g. the accounting sheet).
  async function getValues(tab, opts = {}) {
    const range = encodeURIComponent(quoteRange(tab));
    const params = new URLSearchParams({
      valueRenderOption: opts.valueRenderOption || 'UNFORMATTED_VALUE',
      dateTimeRenderOption: opts.dateTimeRenderOption || 'SERIAL_NUMBER',
    });
    const j = await authedFetch(`${BASE}/${sheetId(opts.sheetId)}/values/${range}?${params}`);
    return j.values || [];
  }

  // Reads multiple tabs in one round-trip. Returns { [tabName]: rows[] }.
  // Pass opts.sheetId to target a different sheet (defaults to PORTAL_CONFIG.SHEET_ID).
  async function batchGet(tabs, opts = {}) {
    const params = new URLSearchParams();
    for (const t of tabs) params.append('ranges', quoteRange(t));
    params.append('valueRenderOption', opts.valueRenderOption || 'UNFORMATTED_VALUE');
    params.append('dateTimeRenderOption', opts.dateTimeRenderOption || 'SERIAL_NUMBER');
    const j = await authedFetch(`${BASE}/${sheetId(opts.sheetId)}/values:batchGet?${params}`);
    const out = {};
    (j.valueRanges || []).forEach((vr, i) => {
      // vr.range looks like 'TabName!A1:Z' — we key by the tab the caller asked for
      out[tabs[i]] = vr.values || [];
    });
    return out;
  }

  // Appends a row to a tab. Sheets handles row insertion atomically.
  async function appendRow(tab, row) {
    const range = encodeURIComponent(quoteRange(tab));
    const params = new URLSearchParams({ valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' });
    return authedFetch(`${BASE}/${sheetId()}/values/${range}:append?${params}`, {
      method: 'POST',
      body: JSON.stringify({ values: [row] }),
    });
  }

  // Updates a single row at row index (1-based, matching the sheet UI).
  async function updateRow(tab, rowIndex1Based, row) {
    const endCol = String.fromCharCode(64 + row.length); // 1→A, 2→B, …
    const range = encodeURIComponent(quoteRange(tab, `A${rowIndex1Based}:${endCol}${rowIndex1Based}`));
    const params = new URLSearchParams({ valueInputOption: 'USER_ENTERED' });
    return authedFetch(`${BASE}/${sheetId()}/values/${range}?${params}`, {
      method: 'PUT',
      body: JSON.stringify({ values: [row] }),
    });
  }

  // Lists tabs for diagnostics ("which tabs does this sheet have?").
  async function listTabs() {
    const params = new URLSearchParams({ fields: 'sheets(properties(sheetId,title))' });
    const j = await authedFetch(`${BASE}/${sheetId()}?${params}`);
    return (j.sheets || []).map((s) => ({ id: s.properties.sheetId, title: s.properties.title }));
  }

  window.Sheet = { getValues, batchGet, appendRow, updateRow, listTabs };
})();
