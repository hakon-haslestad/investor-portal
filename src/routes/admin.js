const express = require('express');
const db = require('../db');
const { getSetting, setSetting } = require('../db');
const { parseMemberCell, normalizeInvestorCode } = require('../excel/normalizer');
const { parseAll, fetchAllSheets } = require('../parsers/workbook');
const {
  createGoogleSheetsSource,
  extractSheetId,
  getServiceAccountEmail,
  keyFileConfigured,
} = require('../parsers/sources/googleSheetsSource');
const { readOwnership, upsertOwnership, resolveOwnershipTab } = require('../services/ownership');

const router = express.Router();

const MEMBER_OPTIONS = ['HH', 'HS', 'ØS', 'JC', 'HF'];

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Lists every distinct security the system knows about — pulling from
 * transactions, holdings_snapshot, and existing meta — joined with the current
 * meta + attribution rows. Used by the Admin tab.
 */
router.get('/securities', (_req, res) => {
  // Unique stocks come from the raw transactions tab (Rådata fra nordnet).
  // That's the canonical "did we ever trade this" set — everything else
  // (holdings, meta) is derived.
  const fromTx = db
    .prepare(
      `SELECT DISTINCT security FROM transactions
       WHERE security IS NOT NULL AND TRIM(security) != ''`
    )
    .all()
    .map((r) => r.security);

  const all = new Set(fromTx);

  const metaMap = new Map(
    db.prepare('SELECT * FROM security_meta').all().map((r) => [r.security, r])
  );

  const attributionMap = new Map();
  for (const r of db.prepare('SELECT * FROM security_attribution').all()) {
    if (!attributionMap.has(r.security)) attributionMap.set(r.security, []);
    attributionMap.get(r.security).push({
      investorCode: r.investor_code,
      weight: r.weight,
      isin: r.isin,
    });
  }

  // Transaction counts per security to help prioritise the list
  const txCounts = new Map(
    db
      .prepare(
        `SELECT security, COUNT(*) c FROM transactions
         WHERE security IS NOT NULL GROUP BY security`
      )
      .all()
      .map((r) => [r.security, r.c])
  );

  // Holdings qty per security (latest snapshot)
  const latestSnap = db.prepare('SELECT MAX(snapshot_date) d FROM holdings_snapshot').get();
  const currentQtyMap = new Map();
  if (latestSnap && latestSnap.d) {
    for (const r of db
      .prepare('SELECT security, qty FROM holdings_snapshot WHERE snapshot_date = ?')
      .all(latestSnap.d)) {
      currentQtyMap.set(r.security, r.qty);
    }
  }

  const securities = Array.from(all)
    .map((sec) => {
      const meta = metaMap.get(sec) || {};
      const attribs = attributionMap.get(sec) || [];
      return {
        security: sec,
        type: meta.type || 'Stock',
        categoryTick: meta.category_tick || '',
        memberString: meta.member_string || (attribs.length ? attribs.map((a) => a.investorCode).join('/') : ''),
        factor: meta.factor != null ? meta.factor : (attribs[0] ? attribs[0].weight : null),
        isin: meta.isin || (attribs[0] ? attribs[0].isin : null),
        txCount: txCounts.get(sec) || 0,
        currentQty: currentQtyMap.get(sec) || 0,
        attributions: attribs,
        mapped: attribs.length > 0,
      };
    })
    .sort((a, b) => {
      // Unmapped first, then by transaction count desc
      if (a.mapped !== b.mapped) return a.mapped ? 1 : -1;
      return b.txCount - a.txCount;
    });

  res.json({
    securities,
    memberOptions: MEMBER_OPTIONS,
    snapshotDate: latestSnap ? latestSnap.d : null,
  });
});

/**
 * Upsert meta for a single security and rebuild its attribution rows.
 * Body: { type, categoryTick, memberString, factor, isin }
 * The memberString uses the same syntax as the Excel "Member" column:
 *   "HH" — sole owner
 *   "HS/ØS" — split between two
 *   "HH/HF/HS" — three-way
 * If factor is null/blank, we use 1/count.
 */
router.put('/securities/:security', async (req, res) => {
  const security = decodeURIComponent(req.params.security);
  const { type, categoryTick, memberString, factor, isin } = req.body || {};
  if (!memberString || !String(memberString).trim()) {
    return res.status(400).json({ error: 'member_required' });
  }
  const parsed = parseMemberCell(memberString)
    .map((m) => ({ code: normalizeInvestorCode(m.code) || m.code, weight: m.weight }))
    .filter((m) => MEMBER_OPTIONS.includes(m.code));

  if (!parsed.length) {
    return res.status(400).json({ error: 'no_valid_members' });
  }

  const explicitFactor = factor != null && factor !== '' && Number.isFinite(Number(factor))
    ? Number(factor)
    : (1 / parsed.length);

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM security_meta WHERE security = ?').run(security);
    db.prepare(`
      INSERT INTO security_meta (security, type, category_tick, member_string, factor, isin, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(security, type || 'Stock', categoryTick || null, String(memberString).trim(), explicitFactor, isin || null);

    db.prepare('DELETE FROM security_attribution WHERE security = ?').run(security);
    const insAttr = db.prepare(`
      INSERT INTO security_attribution (security, isin, investor_code, weight, notes)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const m of parsed) {
      insAttr.run(security, isin || null, m.code, explicitFactor, 'admin');
    }
  });
  tx();

  // Always push the mapping to the configured Ownership tab in Google.
  // Sheet is the source of truth — local SQLite is just the warm cache.
  let sheetSync = { written: false };
  const sheetId = getSetting('google_sheet_id');
  if (sheetId && keyFileConfigured()) {
    try {
      const source = createGoogleSheetsSource({ spreadsheetId: sheetId });
      const ownersGid = numOrNull(getSetting('google_sheet_owners_gid'));
      const ownersTab = await resolveOwnershipTab(source, ownersGid);
      const result = await upsertOwnership(source, ownersTab, {
        security,
        member: String(memberString).trim(),
        factor: explicitFactor,
      });
      sheetSync = { written: true, action: result.action, tab: result.tab };
    } catch (err) {
      sheetSync = { written: false, error: err.message };
    }
  }

  res.json({
    ok: true,
    security,
    members: parsed.map((m) => m.code),
    factor: explicitFactor,
    sheetSync,
  });
});

router.delete('/securities/:security', (req, res) => {
  const security = decodeURIComponent(req.params.security);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM security_meta WHERE security = ?').run(security);
    db.prepare('DELETE FROM security_attribution WHERE security = ?').run(security);
  });
  tx();
  res.json({ ok: true });
});

// ─── Google Sheets sync ────────────────────────────────────────────────────────

router.get('/sheet-config', (_req, res) => {
  res.json({
    sheetId: getSetting('google_sheet_id'),
    sheetUrl: getSetting('google_sheet_url'),
    lastSyncAt: getSetting('last_sync_at'),
    serviceAccountEmail: getServiceAccountEmail(),
    keyFileConfigured: keyFileConfigured(),
  });
});

router.put('/sheet-config', (req, res) => {
  const { sheetUrl } = req.body || {};
  if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl_required' });
  let id;
  try {
    id = extractSheetId(sheetUrl);
  } catch (err) {
    return res.status(400).json({ error: 'bad_sheet_url', message: err.message });
  }
  setSetting('google_sheet_id', id);
  setSetting('google_sheet_url', String(sheetUrl).trim());
  res.json({ ok: true, sheetId: id });
});

function mapGoogleError(err) {
  const msg = String(err && err.message || err);
  const code = err && err.code;
  if (!keyFileConfigured()) return { http: 400, body: { error: 'no_key_file', message: 'GOOGLE_SERVICE_ACCOUNT_KEY is not configured. Set it in .env and restart the server.' } };
  if (code === 403 || /PERMISSION_DENIED/i.test(msg)) {
    const email = getServiceAccountEmail();
    return { http: 403, body: { error: 'not_shared', message: `Share the sheet with ${email || 'the service account'} as Viewer.` } };
  }
  if (code === 404 || /not found/i.test(msg)) {
    return { http: 404, body: { error: 'bad_sheet_id', message: 'No sheet found at that ID — double-check the URL.' } };
  }
  return { http: 500, body: { error: 'google_error', message: msg } };
}

router.post('/test-connection', async (_req, res) => {
  const sheetId = getSetting('google_sheet_id');
  if (!sheetId) return res.status(400).json({ error: 'no_sheet_id', message: 'Save a sheet URL first.' });
  try {
    const source = createGoogleSheetsSource({ spreadsheetId: sheetId });
    const rows = await source.getSheet('Rådata fra nordnet');
    res.json({ ok: true, headerRow: rows[0] || [], rowCount: rows.length });
  } catch (err) {
    const mapped = mapGoogleError(err);
    res.status(mapped.http).json(mapped.body);
  }
});

router.post('/sync', async (req, res) => {
  const sheetId = getSetting('google_sheet_id');
  if (!sheetId) return res.status(400).json({ error: 'no_sheet_id', message: 'Save a sheet URL first.' });

  let parsed;
  let ownershipFromSheet = new Map();
  let source;
  try {
    source = createGoogleSheetsSource({ spreadsheetId: sheetId });
    const sheetMap = await fetchAllSheets(source);
    parsed = parseAll(sheetMap);
    const ownersGid = numOrNull(getSetting('google_sheet_owners_gid'));
    const ownersTab = await resolveOwnershipTab(source, ownersGid);
    ownershipFromSheet = await readOwnership(source, ownersTab);
  } catch (err) {
    const mapped = mapGoogleError(err);
    return res.status(mapped.http).json(mapped.body);
  }

  // Reuse existing attribution rows when figuring out which securities are still unmapped.
  const knownSecs = new Set(
    db.prepare('SELECT DISTINCT security FROM security_attribution').all().map((r) => r.security)
  );
  const unmapped = new Set();
  for (const t of parsed.transactions) {
    if (t.security && !knownSecs.has(t.security)) unmapped.add(t.security);
  }

  const replaceTransactions = db.prepare('DELETE FROM transactions');
  const replaceHoldings = db.prepare('DELETE FROM holdings_snapshot');
  const replaceKpis = db.prepare('DELETE FROM kpi_snapshot');
  const insertTx = db.prepare(`
    INSERT INTO transactions
    (nordnet_id, trade_date, settle_date, book_date, type, security, isin,
     qty, price, amount_nok, currency, fee, running_balance, fx_rate,
     transaction_text, source_row)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertHolding = db.prepare(`
    INSERT INTO holdings_snapshot
    (snapshot_date, security, isin, currency, qty, gav, current_price,
     market_value_nok, margin_value, return_pct, return_nok)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertKpi = db.prepare(`
    INSERT INTO kpi_snapshot (year, company, revenue, our_share_rev, eat, our_share_eat, price, eps, pe)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertLog = db.prepare(`
    INSERT INTO upload_log (filename, uploaded_by, rows_imported, holdings_imported, attributions_imported)
    VALUES (?, ?, ?, ?, ?)
  `);

  // NOTE: security_meta / security_attribution are admin-owned. We DO replace
  // the rows for stocks that appear in the Ownership tab (sheet is source of
  // truth), but we leave alone any local-only rows for fully-sold stocks.
  const upsertMeta = db.prepare(`
    INSERT INTO security_meta (security, type, category_tick, member_string, factor, isin, updated_at)
    VALUES (?, 'Stock', NULL, ?, ?, NULL, datetime('now'))
    ON CONFLICT(security) DO UPDATE SET
      member_string = excluded.member_string,
      factor = excluded.factor,
      updated_at = datetime('now')
  `);
  const deleteAttribs = db.prepare('DELETE FROM security_attribution WHERE security = ?');
  const insertAttrib = db.prepare(`
    INSERT INTO security_attribution (security, isin, investor_code, weight, notes)
    VALUES (?, NULL, ?, ?, 'google-sheet')
  `);

  const tx = db.transaction(() => {
    replaceTransactions.run();
    replaceHoldings.run();
    replaceKpis.run();

    // Merge Ownership-tab rows into local attribution.
    for (const { security, member, factor } of ownershipFromSheet.values()) {
      if (!security || !member) continue;
      const parsedMembers = parseMemberCell(member)
        .map((m) => ({ code: normalizeInvestorCode(m.code) || m.code, weight: m.weight }))
        .filter((m) => MEMBER_OPTIONS.includes(m.code));
      if (!parsedMembers.length) continue;
      const effectiveFactor = (factor != null && Number.isFinite(factor)) ? factor : (1 / parsedMembers.length);
      upsertMeta.run(security, member, effectiveFactor);
      deleteAttribs.run(security);
      for (const m of parsedMembers) {
        insertAttrib.run(security, m.code, effectiveFactor);
      }
    }
    for (const t of parsed.transactions) {
      insertTx.run(t.nordnetId, t.tradeDate, t.settleDate, t.bookDate, t.type, t.security, t.isin,
        t.qty, t.price, t.amount, t.currency, t.fee, t.saldo, t.fxRate, t.text, t.sourceRow);
    }
    for (const h of parsed.holdings) {
      insertHolding.run(h.snapshotDate, h.security, h.isin, h.currency, h.qty, h.gav,
        h.currentPrice, h.marketValueNok, h.marginValue, h.returnPct, h.returnNok);
    }
    for (const k of parsed.kpis) {
      insertKpi.run(k.year, k.company, k.revenue, k.ourShareRev, k.eat, k.ourShareEat, k.price, k.eps, k.pe);
    }
    insertLog.run(`google-sheets:${sheetId}`, req.session.user.investorCode, parsed.transactions.length, parsed.holdings.length, 0);
    setSetting('last_sync_at', new Date().toISOString());
  });
  tx();

  res.json({
    ok: true,
    source: 'google-sheets',
    sheetId,
    rowsImported: parsed.transactions.length,
    holdingsImported: parsed.holdings.length,
    kpisImported: parsed.kpis.length,
    unmappedSecurities: Array.from(unmapped).sort(),
    syncedAt: getSetting('last_sync_at'),
  });
});

module.exports = router;
