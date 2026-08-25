/**
 * Investor Portal — price feed.
 *
 * Bound Apps Script for the club's Google Sheet. Maintains two tabs:
 *
 *   Securities   — security master: ticker, name, aliases, isin, currency,
 *                  exchange, source, status, soldDate, notes.
 *   StockPrices  — date × ticker matrix of closes in the security's native
 *                  currency, plus FX columns (CUR:USDNOK, CUR:SEKNOK, …).
 *
 * Entry points (run from the Apps Script editor):
 *   setupTabs()    — one-time: create Securities/StockPrices/_scratch/_log
 *                    and seed Securities from the Nordnet transaction log.
 *   resolveTickers() — fill in missing tickers by looking up each row's
 *                    ISIN via Yahoo's search API. Run after setupTabs.
 *   backfill()     — one-time: historical closes per ticker from its first
 *                    transaction date. Idempotent; never overwrites cells.
 *   dailyFetch()   — the trigger entry point. Held stocks daily; sold stocks
 *                    weekly until 6 months after the sale, then stop.
 *   setupTrigger() — one-time: install the daily 18:00 (Oslo) trigger.
 *
 * Only static values are ever written to StockPrices — GOOGLEFINANCE
 * formulas are evaluated in the hidden _scratch tab and replaced by their
 * value, because formulas recalculate and would not preserve history.
 */

var TZ = 'Europe/Oslo';

var TABS = {
  transactions: 'Rådata fra nordnet',
  securities: 'Securities',
  prices: 'StockPrices',
  scratch: '_scratch',
  log: '_log',
};

var SEC_HEADERS = ['ticker', 'name', 'aliases', 'isin', 'currency', 'exchange', 'source', 'status', 'soldDate', 'notes'];

// How long to keep fetching a sold stock, and how often.
var SOLD_TAIL_DAYS = 183; // ~6 months
var SOLD_FETCH_EVERY_DAYS = 7;

// Suggested mappings for securities we already know. Keyed by lowercased
// Nordnet display name. GOOGLEFINANCE has no Oslo Børs coverage, so .OL
// symbols go through Yahoo; Stockholm/Xetra go through GOOGLEFINANCE.
var KNOWN = {
  'equinor': { ticker: 'EQNR.OL', currency: 'NOK', exchange: 'OSL', source: 'yahoo' },
  'dnb bank asa': { ticker: 'DNB.OL', currency: 'NOK', exchange: 'OSL', source: 'yahoo' },
  'dnb bank': { ticker: 'DNB.OL', currency: 'NOK', exchange: 'OSL', source: 'yahoo' },
  'salmar': { ticker: 'SALM.OL', currency: 'NOK', exchange: 'OSL', source: 'yahoo' },
  'kitron': { ticker: 'KIT.OL', currency: 'NOK', exchange: 'OSL', source: 'yahoo' },
  'crayon group holding': { ticker: 'CRAYN.OL', currency: 'NOK', exchange: 'OSL', source: 'yahoo' },
  'bewi': { ticker: 'BEWI.OL', currency: 'NOK', exchange: 'OSL', source: 'yahoo' },
  'storskogen group ab ser. b': { ticker: 'STOR-B.ST', currency: 'SEK', exchange: 'STO', source: 'googlefinance', gfSymbol: 'STO:STOR-B' },
  'storskogen b': { ticker: 'STOR-B.ST', currency: 'SEK', exchange: 'STO', source: 'googlefinance', gfSymbol: 'STO:STOR-B' },
  'hellofresh se': { ticker: 'HFG.DE', currency: 'EUR', exchange: 'ETR', source: 'googlefinance', gfSymbol: 'ETR:HFG' },
  'gentoo media inc.': { ticker: 'G2GGM.OL', currency: 'NOK', exchange: 'OSL', source: 'yahoo' },
  'gentoo media': { ticker: 'G2GGM.OL', currency: 'NOK', exchange: 'OSL', source: 'yahoo' },
};

// FX pairs fetched as CUR:<PAIR> columns whenever any non-expired security
// reports in that currency. Always via GOOGLEFINANCE (solid FX coverage).
var FX_CURRENCIES = ['USD', 'SEK', 'EUR', 'DKK', 'GBP'];

// ─── Entry points ──────────────────────────────────────────────────────────

function setupTabs() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sec = ensureTab_(ss, TABS.securities, SEC_HEADERS);
  ensureTab_(ss, TABS.prices, ['date']);
  ensureTab_(ss, TABS.scratch, null, true);
  ensureTab_(ss, TABS.log, ['timestamp', 'context', 'ticker', 'message'], true);
  seedSecurities_(ss, sec);
}

// Resolve missing tickers from ISINs via Yahoo's search endpoint. Fills
// ticker/exchange/currency on every Securities row that has an ISIN but no
// ticker, and stamps notes with what happened. Safe to re-run — it never
// touches a row that already has a ticker.
function resolveTickers() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TABS.securities);
  var securities = readSecurities_(ss);
  var resolved = 0, missed = 0;
  securities.forEach(function (s) {
    if (s.ticker || !s.isin) return;
    try {
      var hit = yahooLookupByIsin_(s.isin);
      if (hit) {
        // ticker | name | aliases | isin | currency | exchange | source | status | soldDate | notes
        sheet.getRange(s.row, 1).setValue(hit.symbol);
        var cur = currencyForSymbol_(hit.symbol);
        if (cur) sheet.getRange(s.row, 5).setValue(cur);
        if (hit.exchange) sheet.getRange(s.row, 6).setValue(hit.exchange);
        sheet.getRange(s.row, 7).setValue(yahooCoveredByGf_(hit) ? 'googlefinance' : 'yahoo');
        sheet.getRange(s.row, 10).setValue('auto-resolved from ISIN (' + (hit.name || '') + ') — verify');
        resolved++;
      } else {
        sheet.getRange(s.row, 10).setValue('REVIEW: ISIN ' + s.isin + ' not found on Yahoo — fill ticker manually');
        missed++;
      }
      Utilities.sleep(400); // be polite to the search endpoint
    } catch (e) {
      log_(ss, 'resolveTickers', s.name, String(e));
      missed++;
    }
  });
  log_(ss, 'resolveTickers', '', resolved + ' resolved, ' + missed + ' need manual review');
}

function yahooLookupByIsin_(isin) {
  var url = 'https://query1.finance.yahoo.com/v1/finance/search?q=' + encodeURIComponent(isin) +
    '&quotesCount=6&newsCount=0';
  var resp = UrlFetchApp.fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new Error('Yahoo search HTTP ' + resp.getResponseCode());
  var quotes = (JSON.parse(resp.getContentText()).quotes || []).filter(function (q) {
    return q.symbol && (q.quoteType === 'EQUITY' || !q.quoteType);
  });
  if (!quotes.length) return null;
  // Prefer the listing on the security's home exchange (ISIN prefix ~ country):
  // NO→.OL, SE→.ST, DK→.CO, DE→.DE/.F, FI→.HE. Fall back to the first hit.
  var SUFFIX = { NO: '.OL', SE: '.ST', DK: '.CO', DE: '.DE', FI: '.HE' };
  var want = SUFFIX[isin.slice(0, 2).toUpperCase()];
  var best = want ? quotes.filter(function (q) { return q.symbol.slice(-want.length) === want; })[0] : null;
  var q = best || quotes[0];
  return { symbol: q.symbol, exchange: q.exchange || '', name: q.shortname || q.longname || '' };
}

// GOOGLEFINANCE covers Stockholm/Xetra/Copenhagen/Helsinki but not Oslo Børs.
function yahooCoveredByGf_(hit) {
  var sym = hit.symbol || '';
  return /\.(ST|DE|F|CO|HE)$/.test(sym);
}

// Quote currency implied by the Yahoo symbol's exchange suffix. A bare
// symbol (no suffix) is a US listing → USD.
function currencyForSymbol_(symbol) {
  var m = /\.([A-Z]+)$/.exec(symbol || '');
  if (!m) return 'USD';
  return { OL: 'NOK', ST: 'SEK', CO: 'DKK', DE: 'EUR', F: 'EUR', HE: 'EUR', L: 'GBP' }[m[1]] || '';
}

function dailyFetch() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // Self-maintenance: a security bought since the last run gets seeded from
  // its ISIN, its ticker resolved, and its history backfilled — no manual
  // setupTabs/resolveTickers/backfill needed for new buys. Both helpers are
  // cheap no-ops when there's nothing new.
  seedSecurities_(ss, ss.getSheetByName(TABS.securities));
  resolveTickers();

  var securities = readSecurities_(ss);
  refreshSoldState_(ss, securities);
  var today = isoDate_(new Date());

  // Auto-backfill columns that have no history yet (newly resolved tickers,
  // and their FX pair if it's new too). Capped per run for time safety —
  // leftovers are picked up tomorrow.
  autoBackfillNew_(ss, securities);

  var list = fetchListFor_(ss, securities, today);
  if (!list.length) { log_(ss, 'dailyFetch', '', 'nothing to fetch today'); return; }
  var values = {};
  list.forEach(function (item) {
    try {
      var px = fetchQuote_(item);
      if (px != null) values[item.column] = px;
      else log_(ss, 'dailyFetch', item.column, 'no value from ' + item.source);
    } catch (e) {
      log_(ss, 'dailyFetch', item.column, String(e));
    }
  });
  writeRow_(ss, today, values);
  var misses = list.length - Object.keys(values).length;
  if (misses > 0) log_(ss, 'dailyFetch', '', misses + '/' + list.length + ' fetches failed');
}

var AUTO_BACKFILL_MAX_PER_RUN = 4;

function autoBackfillNew_(ss, securities) {
  var firstVals = firstValueDates_(ss);
  var firstTx = firstTransactionDates_(ss);
  var done = 0;
  for (var i = 0; i < securities.length && done < AUTO_BACKFILL_MAX_PER_RUN; i++) {
    var s = securities[i];
    if (!s.ticker || s.status === 'expired') continue;
    if (firstVals[s.ticker]) continue; // column already has data
    var start = firstTx[s.ticker] || firstTx['*'];
    if (!start) continue;
    try {
      mergeSeries_(ss, s.ticker, fetchHistory_(s, start));
      log_(ss, 'dailyFetch', s.ticker, 'auto-backfilled new security from ' + start);
      done++;
      var cur = (s.currency || 'NOK').toUpperCase();
      if (cur !== 'NOK' && !firstVals['CUR:' + cur + 'NOK']) {
        mergeSeries_(ss, 'CUR:' + cur + 'NOK', fetchFxHistory_(cur, start));
        log_(ss, 'dailyFetch', 'CUR:' + cur + 'NOK', 'auto-backfilled new FX pair');
      }
    } catch (e) {
      log_(ss, 'dailyFetch', s.ticker, 'auto-backfill failed: ' + e);
    }
  }
  if (done > 0) sortPricesByDate_(ss);
}

// Resumable: skips any column whose history is already backfilled (its
// earliest StockPrices value sits within BACKFILL_DONE_SLACK_DAYS of the
// intended start), and stops cleanly before Apps Script's 6-minute cap.
// Just run it again until it logs "backfill complete".
var BACKFILL_TIME_BUDGET_MS = 4.5 * 60 * 1000;
var BACKFILL_DONE_SLACK_DAYS = 10; // start can land on a weekend/holiday

function backfill() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var t0 = Date.now();
  var securities = readSecurities_(ss);
  var firstTx = firstTransactionDates_(ss);
  var firstVals = firstValueDates_(ss);
  var done = 0, skipped = 0, outOfTime = false;

  function isDone(column, start) {
    var first = firstVals[column];
    return first && daysBetween_(start, first) <= BACKFILL_DONE_SLACK_DAYS;
  }
  function timeLeft() { return Date.now() - t0 < BACKFILL_TIME_BUDGET_MS; }

  // Build the work list first (stocks + FX), then chew through it until
  // finished or out of time.
  var jobs = [];
  var globalStart = null;
  securities.forEach(function (s) {
    if (!s.ticker || s.status === 'expired') return;
    var start = firstTx[s.ticker] || firstTx['*'];
    if (!start) return;
    if (!globalStart || start < globalStart) globalStart = start;
    jobs.push({ column: s.ticker, start: start, fetch: function () { return fetchHistory_(s, start); } });
  });
  if (globalStart) {
    activeCurrencies_(securities).forEach(function (cur) {
      var col = 'CUR:' + cur + 'NOK';
      jobs.push({ column: col, start: globalStart, fetch: function () { return fetchFxHistory_(cur, globalStart); } });
    });
  }

  for (var i = 0; i < jobs.length; i++) {
    var job = jobs[i];
    if (isDone(job.column, job.start)) { skipped++; continue; }
    if (!timeLeft()) { outOfTime = true; break; }
    try {
      var series = job.fetch();
      mergeSeries_(ss, job.column, series);
      log_(ss, 'backfill', job.column, series.length + ' points from ' + job.start);
      done++;
    } catch (e) {
      log_(ss, 'backfill', job.column, String(e));
    }
  }

  sortPricesByDate_(ss);
  if (outOfTime) {
    log_(ss, 'backfill', '', 'time budget reached after ' + done + ' fetched, ' + skipped +
      ' already done — RUN backfill AGAIN to continue');
  } else {
    log_(ss, 'backfill', '', 'backfill complete: ' + done + ' fetched, ' + skipped + ' already done');
  }
}

// Earliest date with a value, per StockPrices column.
function firstValueDates_(ss) {
  var sheet = ss.getSheetByName(TABS.prices);
  if (!sheet) return {};
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return {};
  var headers = data[0].map(String);
  var out = {};
  for (var c = 1; c < headers.length; c++) {
    if (!headers[c]) continue;
    for (var r = 1; r < data.length; r++) {
      if (data[r][c] !== '' && data[r][c] != null) { out[headers[c]] = isoDate_(data[r][0]); break; }
    }
  }
  return out;
}

function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyFetch') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyFetch').timeBased().everyDays(1).atHour(18).create();
}

// ─── Securities master ─────────────────────────────────────────────────────

function readSecurities_(ss) {
  var sheet = ss.getSheetByName(TABS.securities);
  if (!sheet) throw new Error('Run setupTabs() first — no Securities tab');
  var rows = sheet.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (!r[0] && !r[1]) continue;
    out.push({
      row: i + 1,
      ticker: String(r[0] || '').trim(),
      name: String(r[1] || '').trim(),
      aliases: String(r[2] || '').split(';').map(function (a) { return a.trim().toLowerCase(); }).filter(String),
      isin: String(r[3] || '').trim(),
      currency: String(r[4] || 'NOK').trim().toUpperCase(),
      exchange: String(r[5] || '').trim(),
      source: String(r[6] || 'yahoo').trim().toLowerCase(),
      status: String(r[7] || 'held').trim().toLowerCase(),
      soldDate: r[8] ? isoDate_(r[8]) : '',
      notes: String(r[9] || ''),
    });
  }
  return out;
}

// Seed Securities from the transaction log, keyed by ISIN. Nordnet exports
// carry no tickers, and the same security shows up under different names
// across eras (short codes like "SALM" in old exports, "SalMar" in new
// ones) — the ISIN is the stable identity. One row per ISIN; every name
// variant seen in the log becomes an alias. Names without an ISIN seed one
// row per distinct name. Existing rows are left untouched (new name
// variants of an already-seeded ISIN are appended to its aliases).
function seedSecurities_(ss, sheet) {
  var existing = readSecurities_(ss);
  var seenName = {}, byIsinRow = {};
  existing.forEach(function (s) {
    seenName[s.name.toLowerCase()] = true;
    s.aliases.forEach(function (a) { seenName[a] = true; });
    if (s.isin) byIsinRow[s.isin.toUpperCase()] = s;
  });

  // Group log names by ISIN, keeping the order variants first appeared.
  var byIsin = {}, noIsin = {};
  readTransactions_(ss).forEach(function (t) {
    if (!t.security) return;
    var isin = (t.isin || '').toUpperCase();
    if (isin) {
      var g = byIsin[isin] || (byIsin[isin] = { names: [], seen: {} });
      if (!g.seen[t.security.toLowerCase()]) { g.seen[t.security.toLowerCase()] = true; g.names.push(t.security); }
    } else if (!noIsin[t.security.toLowerCase()]) {
      noIsin[t.security.toLowerCase()] = t.security;
    }
  });

  var appended = 0, aliased = 0;
  Object.keys(byIsin).forEach(function (isin) {
    var names = byIsin[isin].names;
    var row = byIsinRow[isin];
    if (row) {
      // ISIN already seeded — just add any new name variants as aliases.
      var fresh = names.filter(function (n) {
        var k = n.toLowerCase();
        return k !== row.name.toLowerCase() && row.aliases.indexOf(k) === -1;
      });
      if (fresh.length) {
        var all = row.aliases.concat(fresh.map(function (n) { return n.toLowerCase(); }));
        sheet.getRange(row.sourceRow || row.row, 3).setValue(all.join(';'));
        aliased += fresh.length;
      }
      return;
    }
    // Prefer the longest name as the display name (full names beat codes);
    // every other variant becomes an alias.
    var display = names.slice().sort(function (a, b) { return b.length - a.length; })[0];
    var aliases = names.filter(function (n) { return n !== display; })
      .map(function (n) { return n.toLowerCase(); });
    var known = null;
    names.forEach(function (n) { if (!known && KNOWN[n.toLowerCase()]) known = KNOWN[n.toLowerCase()]; });
    known = known || {};
    sheet.appendRow([
      known.ticker || '',
      display,
      aliases.join(';'),
      isin,
      known.currency || 'NOK',
      known.exchange || '',
      known.source || 'yahoo',
      'held',
      '',
      known.ticker ? '' : 'run resolveTickers to fill ticker from ISIN',
    ]);
    appended++;
  });

  // Names with no ISIN anywhere in the log — seed per name, needs manual fill.
  Object.keys(noIsin).forEach(function (key) {
    if (seenName[key]) return;
    var known = KNOWN[key] || {};
    sheet.appendRow([
      known.ticker || '', noIsin[key], '', '',
      known.currency || 'NOK', known.exchange || '', known.source || 'yahoo',
      'held', '',
      known.ticker ? '' : 'REVIEW: no ISIN in log — fill ticker/currency/source',
    ]);
    appended++;
  });
  log_(ss, 'setupTabs', '', 'seeded ' + appended + ' securities (' + aliased + ' aliases added); now run resolveTickers');
}

// Transaction-type classification — MUST mirror docs/js/ledger.js exactly,
// otherwise the Apps Script's held/sold view drifts from the portal's.
var BUY_TYPES = ['KJØPT', 'BYTTE INNLEGG VP', 'BYTE INLÄGG VP', 'TEGNING INNLEGG VP',
  'TEGNING LIKVID', 'EMISJON INNLEGG VP', 'TILDELING INNLEGG RE', 'UTSKILLING FISJON IN',
  'SPLITT INNLEGG VP', 'UTBYTTE INNLEGG VP', 'INNLEGG OVERFØRING', 'INNL. VP LIKVID'];
var SELL_TYPES = ['SALG', 'BYTTE UTTAK VP', 'BYTTE UTTAK VERDIPAPIR', 'INNLØSN. UTTAK VP',
  'SLETTING UTTAK VP', 'EMISJON UTTAK VP', 'SPLITT UTTAK VP', 'TEGNING UTTAK RETTER'];
var REALIZING_SELL_TYPES = ['SALG', 'INNLØSN. UTTAK VP', 'SLETTING UTTAK VP'];

// Replay the Nordnet log per security to maintain status/soldDate.
// qty reaches 0 → sold (soldDate = last realizing sell date);
// sold more than SOLD_TAIL_DAYS ago → expired; bought again → held.
function refreshSoldState_(ss, securities) {
  var txs = readTransactions_(ss);
  var byTicker = {};
  var match = matcherFor_(securities);
  txs.forEach(function (t) {
    var s = match(t);
    if (!s) return;
    var b = byTicker[s.ticker] || (byTicker[s.ticker] = { qty: 0, lastSell: '' });
    var type = String(t.type || '').toUpperCase();
    var qty = Math.abs(Number(t.qty) || 0);
    if (BUY_TYPES.indexOf(type) !== -1) b.qty += qty;
    if (SELL_TYPES.indexOf(type) !== -1) {
      b.qty -= qty;
      if (REALIZING_SELL_TYPES.indexOf(type) !== -1 && t.date) b.lastSell = t.date;
    }
  });
  var sheet = ss.getSheetByName(TABS.securities);
  var today = new Date();
  securities.forEach(function (s) {
    if (!s.ticker) return;
    var b = byTicker[s.ticker];
    if (!b) return;
    var held = b.qty > 0.0001;
    var next = s.status, nextSold = s.soldDate;
    if (held && s.status !== 'held') { next = 'held'; nextSold = ''; }
    if (!held && s.status === 'held') { next = 'sold'; nextSold = b.lastSell || isoDate_(today); }
    if (!held && nextSold && daysBetween_(nextSold, isoDate_(today)) > SOLD_TAIL_DAYS) next = 'expired';
    if (next !== s.status || nextSold !== s.soldDate) {
      sheet.getRange(s.row, 8, 1, 2).setValues([[next, nextSold]]);
      s.status = next; s.soldDate = nextSold;
    }
  });
}

function aliasMap_(securities) {
  var map = {};
  securities.forEach(function (s) {
    if (!s.ticker) return;
    map[s.name.toLowerCase()] = s;
    s.aliases.forEach(function (a) { map[a] = s; });
  });
  return map;
}

// Match a transaction to a Securities row: ISIN first (the stable key in
// Nordnet exports), name/alias as fallback for rows that predate ISINs.
function matcherFor_(securities) {
  var byIsin = {};
  securities.forEach(function (s) {
    if (s.ticker && s.isin) byIsin[s.isin.toUpperCase()] = s;
  });
  var byName = aliasMap_(securities);
  return function (t) {
    if (t.isin && byIsin[String(t.isin).toUpperCase()]) return byIsin[String(t.isin).toUpperCase()];
    return byName[String(t.security || '').trim().toLowerCase()] || null;
  };
}

function activeCurrencies_(securities) {
  var set = {};
  securities.forEach(function (s) {
    if (s.status === 'expired' || !s.ticker) return;
    if (s.currency && s.currency !== 'NOK' && FX_CURRENCIES.indexOf(s.currency) !== -1) set[s.currency] = true;
  });
  return Object.keys(set);
}

// ─── Fetch-list / cadence ──────────────────────────────────────────────────

function fetchListFor_(ss, securities, today) {
  var lastByCol = lastValueDates_(ss);
  var list = [];
  securities.forEach(function (s) {
    if (!s.ticker || s.status === 'expired') return;
    if (s.status === 'sold') {
      var last = lastByCol[s.ticker];
      if (last && daysBetween_(last, today) < SOLD_FETCH_EVERY_DAYS) return;
      if (s.soldDate && daysBetween_(s.soldDate, today) > SOLD_TAIL_DAYS) return;
    }
    list.push({ column: s.ticker, source: s.source, ticker: s.ticker, gfSymbol: gfSymbolFor_(s) });
  });
  activeCurrencies_(securities).forEach(function (cur) {
    list.push({ column: 'CUR:' + cur + 'NOK', source: 'googlefinance', ticker: cur + 'NOK', gfSymbol: 'CURRENCY:' + cur + 'NOK' });
  });
  return list;
}

function gfSymbolFor_(s) {
  // notes column may carry "gf=STO:STOR-B" to override; else derive.
  var m = /gf=([^\s;]+)/.exec(s.notes || '');
  if (m) return m[1];
  if (KNOWN[s.name.toLowerCase()] && KNOWN[s.name.toLowerCase()].gfSymbol) return KNOWN[s.name.toLowerCase()].gfSymbol;
  return s.exchange ? s.exchange + ':' + s.ticker.replace(/\.[A-Z]+$/, '') : s.ticker;
}

// ─── Quote fetching ────────────────────────────────────────────────────────

function fetchQuote_(item) {
  if (item.source === 'googlefinance') {
    var v = evalGoogleFinance_('=GOOGLEFINANCE("' + item.gfSymbol + '", "price")');
    if (typeof v === 'number' && isFinite(v)) return v;
    // fall through to Yahoo for stocks (not FX)
    if (item.column.indexOf('CUR:') === 0) return null;
  }
  return yahooQuote_(item.ticker);
}

function evalGoogleFinance_(formula) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cell = ss.getSheetByName(TABS.scratch).getRange('A1');
  try {
    cell.setFormula(formula);
    SpreadsheetApp.flush();
    for (var i = 0; i < 5; i++) {
      var v = cell.getValue();
      if (typeof v === 'number' && isFinite(v)) return v;
      Utilities.sleep(1000);
    }
    return cell.getValue();
  } finally {
    cell.clearContent();
    SpreadsheetApp.flush();
  }
}

function yahooQuote_(symbol) {
  var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=1d&interval=1d';
  var resp = UrlFetchApp.fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new Error('Yahoo HTTP ' + resp.getResponseCode() + ' for ' + symbol);
  var data = JSON.parse(resp.getContentText());
  var result = data.chart && data.chart.result && data.chart.result[0];
  var px = result && result.meta && result.meta.regularMarketPrice;
  return typeof px === 'number' && isFinite(px) ? px : null;
}

// ─── History (backfill) ────────────────────────────────────────────────────

function fetchHistory_(s, startIso) {
  if (s.source === 'googlefinance') {
    var series = gfHistory_(gfSymbolFor_(s), startIso);
    if (series.length) return series;
  }
  return yahooHistory_(s.ticker, startIso);
}

function fetchFxHistory_(cur, startIso) {
  return gfHistory_('CURRENCY:' + cur + 'NOK', startIso);
}

function gfHistory_(symbol, startIso) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TABS.scratch);
  var d = startIso.split('-');
  var range = sheet.getRange('A1');
  try {
    range.setFormula('=GOOGLEFINANCE("' + symbol + '", "close", DATE(' + Number(d[0]) + ',' + Number(d[1]) + ',' + Number(d[2]) + '), TODAY(), "DAILY")');
    SpreadsheetApp.flush();
    Utilities.sleep(1500);
    var values = sheet.getDataRange().getValues();
    var out = [];
    for (var i = 1; i < values.length; i++) { // row 0 = Date/Close headers
      var date = values[i][0], close = values[i][1];
      if (date instanceof Date && typeof close === 'number' && isFinite(close)) out.push([isoDate_(date), close]);
    }
    return out;
  } finally {
    sheet.clearContents();
    SpreadsheetApp.flush();
  }
}

function yahooHistory_(symbol, startIso) {
  var p1 = Math.floor(new Date(startIso + 'T00:00:00Z').getTime() / 1000);
  var p2 = Math.floor(Date.now() / 1000);
  var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) +
    '?period1=' + p1 + '&period2=' + p2 + '&interval=1d';
  var resp = UrlFetchApp.fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new Error('Yahoo HTTP ' + resp.getResponseCode() + ' for ' + symbol);
  var data = JSON.parse(resp.getContentText());
  var result = data.chart && data.chart.result && data.chart.result[0];
  if (!result || !result.timestamp) return [];
  var closes = result.indicators.quote[0].close;
  var out = [];
  for (var i = 0; i < result.timestamp.length; i++) {
    var c = closes[i];
    if (typeof c === 'number' && isFinite(c)) out.push([isoDate_(new Date(result.timestamp[i] * 1000)), round4_(c)]);
  }
  return out;
}

// ─── StockPrices writes ────────────────────────────────────────────────────

// Write {column: value} into the row for `dateIso`, creating the row and any
// missing ticker columns. Overwrites same-day values (idempotent re-runs).
function writeRow_(ss, dateIso, values) {
  var sheet = ss.getSheetByName(TABS.prices);
  var headers = headerRow_(sheet);
  Object.keys(values).forEach(function (col) {
    if (headers.indexOf(col) === -1) {
      sheet.getRange(1, headers.length + 1).setValue(col);
      headers.push(col);
    }
  });
  var dates = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 1).getValues();
  var rowIdx = -1;
  for (var i = 1; i < dates.length; i++) {
    if (isoDate_(dates[i][0]) === dateIso) { rowIdx = i + 1; break; }
  }
  if (rowIdx === -1) {
    rowIdx = sheet.getLastRow() + 1;
    sheet.getRange(rowIdx, 1).setValue(dateIso);
  }
  Object.keys(values).forEach(function (col) {
    sheet.getRange(rowIdx, headers.indexOf(col) + 1).setValue(values[col]);
  });
}

// Merge a [[dateIso, value], …] series into one column. Never overwrites an
// existing non-empty cell. Bulk write (one setValues per column).
function mergeSeries_(ss, column, series) {
  if (!series.length) return;
  var sheet = ss.getSheetByName(TABS.prices);
  var headers = headerRow_(sheet);
  var colIdx = headers.indexOf(column);
  if (colIdx === -1) {
    colIdx = headers.length;
    sheet.getRange(1, colIdx + 1).setValue(column);
  }
  var lastRow = Math.max(sheet.getLastRow(), 1);
  var dates = sheet.getRange(1, 1, lastRow, 1).getValues();
  var rowByDate = {};
  for (var i = 1; i < dates.length; i++) rowByDate[isoDate_(dates[i][0])] = i + 1;
  var newDates = [];
  series.forEach(function (p) { if (!rowByDate[p[0]]) newDates.push(p[0]); });
  if (newDates.length) {
    newDates.sort();
    var startRow = lastRow + 1;
    sheet.getRange(startRow, 1, newDates.length, 1).setValues(newDates.map(function (d) { return [d]; }));
    newDates.forEach(function (d, i) { rowByDate[d] = startRow + i; });
    lastRow += newDates.length;
  }
  var colVals = sheet.getRange(1, colIdx + 1, lastRow, 1).getValues();
  series.forEach(function (p) {
    var r = rowByDate[p[0]];
    if (colVals[r - 1][0] === '' || colVals[r - 1][0] == null) colVals[r - 1][0] = p[1];
  });
  sheet.getRange(1, colIdx + 1, lastRow, 1).setValues(colVals);
}

function sortPricesByDate_(ss) {
  var sheet = ss.getSheetByName(TABS.prices);
  if (sheet.getLastRow() > 2) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).sort({ column: 1, ascending: true });
  }
}

// Full header row INCLUDING blank cells — positions must stay aligned with
// sheet columns (index i ↔ column i+1). Never compact this array: a blank
// header would shift every ticker one column left and silently corrupt the
// matrix on the next write.
function headerRow_(sheet) {
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
}

function lastValueDates_(ss) {
  var sheet = ss.getSheetByName(TABS.prices);
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return {};
  var headers = data[0].map(String);
  var out = {};
  for (var c = 1; c < headers.length; c++) {
    if (!headers[c]) continue;
    for (var r = data.length - 1; r >= 1; r--) {
      if (data[r][c] !== '' && data[r][c] != null) { out[headers[c]] = isoDate_(data[r][0]); break; }
    }
  }
  return out;
}

// ─── Transactions ──────────────────────────────────────────────────────────

// Header-keyed read of the Nordnet tab; tolerant of column order changes.
function readTransactions_(ss) {
  var sheet = ss.getSheetByName(TABS.transactions);
  if (!sheet) throw new Error('Missing tab: ' + TABS.transactions);
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  var idx = {};
  data[0].forEach(function (h, i) { idx[String(h).trim().toLowerCase()] = i; });
  function col(row, name) { var i = idx[name]; return i == null ? '' : row[i]; }
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    out.push({
      date: col(r, 'handelsdag') ? isoDate_(col(r, 'handelsdag')) : '',
      type: col(r, 'transaksjonstype'),
      security: String(col(r, 'verdipapir') || '').trim(),
      isin: String(col(r, 'isin') || '').trim(),
      qty: col(r, 'antall'),
    });
  }
  return out;
}

function firstTransactionDates_(ss) {
  var securities = readSecurities_(ss);
  var match = matcherFor_(securities);
  var out = {};
  readTransactions_(ss).forEach(function (t) {
    if (!t.date) return;
    if (!out['*'] || t.date < out['*']) out['*'] = t.date;
    var s = match(t);
    if (s && (!out[s.ticker] || t.date < out[s.ticker])) out[s.ticker] = t.date;
  });
  return out;
}

// ─── Utilities ─────────────────────────────────────────────────────────────

function ensureTab_(ss, name, headers, hidden) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (headers) sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    if (hidden) sheet.hideSheet();
  }
  return sheet;
}

function log_(ss, context, ticker, message) {
  ensureTab_(ss, TABS.log, ['timestamp', 'context', 'ticker', 'message'], true)
    .appendRow([Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'), context, ticker, message]);
}

function isoDate_(d) {
  if (d instanceof Date) return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
  var s = String(d).trim();
  var m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s); // dd.mm.yyyy from Nordnet
  if (m) return m[3] + '-' + m[2] + '-' + m[1];
  return s.slice(0, 10);
}

function daysBetween_(isoA, isoB) {
  return Math.round((new Date(isoB) - new Date(isoA)) / 86400000);
}

function round4_(n) { return Math.round(n * 10000) / 10000; }
