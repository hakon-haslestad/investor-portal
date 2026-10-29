// Accounting view — read-only dashboard for the konsolidert bookkeeping
// workbook (separate Google Sheet, tighter share list). Port of
// pages/accounting.js into the SPA view contract. The accounting sheet is
// fetched lazily on first visit and cached at module level so tab revisits
// are instant; the "↻ Reload" button clears the caches.

(function () {
  // Module-level caches — survive view unmount/remount within the session.
  let initial = null;            // { dnb, nordnetRaw, dnbTab, nordnetTab, aliases, years }
  const yearCache = new Map();   // year -> { entry, sb, hb, nordnet }
  let calcCache = null;          // year -> Books.ledgerYear result (one-sheet step C5)

  // Optional tab with payer names for the bank rules (columns: code, alias).
  // Without it the portfolio sheet's member names are used, when loaded.
  const ALIASES_TAB = 'Aliases';
  async function loadAliases(tabRows) {
    const B = window.BankRules;
    if (tabRows) return B.buildAliases(B.parseAliases(tabRows));
    try {
      const store = window.Store && window.Store.hydrate ? await window.Store.hydrate() : null;
      return store && store.members ? B.aliasesFromMembers(store.members) : [];
    } catch (_e) { return []; }
  }

  window.Views.accounting = async function (el, ctx) {
    const { me } = ctx;
    const { fmtNok, escapeHtml } = window.Fmt;
    const A = window.Accounting;
    const cfg = window.PORTAL_CONFIG;
    const accountingSheetId = cfg.ACCOUNTING_SHEET_ID;
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${accountingSheetId}/edit`;

    el.innerHTML = `
      <div class="hero">
        <h2>Accounting — Geysir Invest AS ${window.UI.infoIcon('accounting-kpis')}</h2>
        <div class="when" id="meta-line"></div>
      </div>
      <div id="year-picker-mount" style="margin-bottom:14px"></div>
      <div id="acc-root">${window.UI.skeleton('block')}</div>
    `;
    const root = el.querySelector('#acc-root');
    const pickerMount = el.querySelector('#year-picker-mount');
    const metaLine = el.querySelector('#meta-line');

    // ─── Initial load: tab listing first, then the cross-year tabs that exist ─
    // Listing first means a missing DNB_raw / Nordnet_raw tab shows up as "To do"
    // in the checklist instead of failing the whole page.
    if (!initial) {
      try {
        // One sheet: raw data and the inputs tab live in the portfolio sheet.
        // The accounting sheet, while it still exists, gives the accountant's
        // year tabs (SB/HB/Nordnet YY) and fills in any raw tab the main
        // sheet does not have yet.
        const titlesOf = (tabs) => (tabs || []).map((t) => (typeof t === 'string' ? t : t && t.title));
        const mainTitles = titlesOf(await window.Sheet.listTabs());
        const accTabs = accountingSheetId ? await window.Sheet.listTabs({ sheetId: accountingSheetId }) : [];
        const accTitles = titlesOf(accTabs);
        const from = (name) => (mainTitles.includes(name) ? 'main' : (accTitles.includes(name) ? 'acc' : null));
        const dnbTab = from(cfg.ACCOUNTING_TABS.dnbRaw) ? cfg.ACCOUNTING_TABS.dnbRaw : null;
        const aliasTab = from(ALIASES_TAB) ? ALIASES_TAB : null;
        const inputsTab = mainTitles.includes(window.Books.INPUTS_TAB) ? window.Books.INPUTS_TAB : null;
        const store = window.Store && window.Store.hydrate ? await window.Store.hydrate().catch(() => null) : null;
        const fromRaadata = store && (store.transactions || []).length ? window.Books.nordnetFromTransactions(store.transactions) : null;
        const nordnetTab = !fromRaadata && accTitles.includes(cfg.ACCOUNTING_TABS.nordnetRaw) ? cfg.ACCOUNTING_TABS.nordnetRaw : null;
        const read = async (names, sheetId) => (names.length ? window.Sheet.batchGet(names, sheetId ? { sheetId } : {}) : {});
        const wanted = { main: [], acc: [] };
        for (const t of [dnbTab, aliasTab].filter(Boolean)) wanted[from(t)].push(t);
        if (inputsTab) wanted.main.push(inputsTab);
        if (nordnetTab) wanted.acc.push(nordnetTab);
        const got = { ...(await read(wanted.main)), ...(await read(wanted.acc, accountingSheetId)) };
        const inputs = window.Books.parseInputs(inputsTab ? got[inputsTab] : null);
        initial = {
          dnb: A.parseDnbRaw(dnbTab ? got[dnbTab] || [] : []),
          nordnetRaw: fromRaadata || A.parseNordnetRaw(nordnetTab ? got[nordnetTab] || [] : []),
          dnbTab,
          nordnetTab: fromRaadata ? 'Rådata fra nordnet' : nordnetTab,
          aliases: await loadAliases(aliasTab ? got[aliasTab] || [] : null),
          inputs,
          transactions: store ? store.transactions || [] : [],
          store,
          years: A.discoverYears(accTabs),
        };
      } catch (err) {
        const msg = String(err && err.message || err);
        if (window.UI.isSessionExpired(err)) { root.innerHTML = window.UI.loadError(err, 'the accounting sheet'); return; }
        const looksLikePermission = /\b(403|PERMISSION_DENIED|forbidden|not found)\b/i.test(msg);
        root.innerHTML = `
          <div class="flash error" style="max-width:640px">
            <strong>Can't read the accounting sheet.</strong>
            ${looksLikePermission
              ? `Your Google account (${escapeHtml(window.Auth.getEmail() || '')}) doesn't have access to the accounting sheet. Ask an admin to share it with you, then reload. The rest of the portal works as usual.`
              : 'We could not read it just now. Try again, or sign in again.'}
            <div class="flash-actions">
              ${looksLikePermission ? '' : '<button type="button" class="btn" data-act="retry">Try again</button> <button type="button" class="btn ghost" data-act="sign-in-again">Sign in again</button>'}
              <a href="${sheetUrl}" target="_blank" rel="noopener">Open sheet ↗</a>
            </div>
            <details class="flash-details"><summary>Technical details</summary><code>${escapeHtml(msg)}</code></details>
          </div>
        `;
        return;
      }
    }
    const { dnb, nordnetRaw, dnbTab, nordnetTab, aliases, inputs, transactions, store } = initial;

    // Calculated books (one-sheet step C5): every year from the first year in
    // DNB_raw, opening with the IB rows, each next year from the last close.
    if (!calcCache) calcCache = window.CalculatedBooks.calculate({ dnb, aliases, transactions, inputs, store });
    // The 31.12 price: the last trading-day close in StockPrices (NOK, FX of
    // the same day), unless a PRICE row gives the books' price.
    function yearEndPrices(y) {
      const P = window.Portfolio;
      return (security, isin) => (P && P.yearEndPrice ? P.yearEndPrice(store, security, isin, `${y}-12-31`) : null);
    }
    const years = [...initial.years];
    for (const y of calcCache.keys()) if (!years.some((e) => e.year === y)) years.push({ year: y, sb: null, hb: null, nordnet: null });
    years.sort((a, b) => b.year - a.year);

    if (!years.length) {
      root.innerHTML = `
        <div class="flash error" style="max-width:640px">
          <strong>No years to show.</strong> The books are calculated from a <code>DNB_raw</code>
          tab in the portfolio sheet${accountingSheetId ? `, or read from tabs named like <code>SB, 25</code> / <code>HB, 25</code>
          in the accounting sheet` : ''}. Add the bank export and reload.
          ${accountingSheetId ? `<div style="margin-top:10px"><a href="${sheetUrl}" target="_blank" rel="noopener">Open sheet ↗</a></div>` : ''}
        </div>
      `;
      return;
    }

    // ─── Year selection (persisted) ─────────────────────────────────────────
    const STORAGE_KEY = 'portal.accounting.year';
    let stored = null;
    try { stored = Number(localStorage.getItem(STORAGE_KEY)); } catch (_e) { /* private mode */ }
    const fallbackYear = cfg.ACCOUNTING_CURRENT_YEAR;
    let selectedYear = years.find((y) => y.year === stored) ? stored
      : (years.find((y) => y.year === fallbackYear) ? fallbackYear : years[0].year);

    // Books (the accountant's tabs) or Calculated (from raw data). Without an
    // accounting sheet there is only Calculated.
    const SOURCE_KEY = 'portal.accounting.source';
    let source = 'books';
    try { source = localStorage.getItem(SOURCE_KEY) === 'calc' ? 'calc' : 'books'; } catch (_e) { /* private mode */ }
    const sourceFor = (year) => {
      const e = years.find((y) => y.year === year);
      const hasBooks = !!(e && e.sb), hasCalc = calcCache.has(year);
      if (!hasBooks) return hasCalc ? 'calc' : 'books';
      return hasCalc && source === 'calc' ? 'calc' : 'books';
    };

    metaLine.textContent = `${years.length} year${years.length === 1 ? '' : 's'} available · signed in as ${me.displayName || ''}${me.investorCode ? ` (${me.investorCode})` : ''}`;

    pickerMount.innerHTML = `
      <div class="range-picker" role="group" aria-label="Accounting year">
        ${years.map((y) => `
          <button type="button" class="preset ${y.year === selectedYear ? 'active' : ''}" data-year="${y.year}" aria-pressed="${y.year === selectedYear}">${y.year}</button>
        `).join('')}
        <span class="sep">·</span>
        <button type="button" class="preset" id="reload-btn" title="Refetch from Google Sheets">↻ Reload</button>
      </div>
      ${calcCache.size && initial.years.length ? `
      <div class="range-picker" role="group" aria-label="Books or calculated" style="margin-top:8px">
        ${[['books', 'Books'], ['calc', 'Calculated']].map(([k, label]) => `
          <button type="button" class="preset ${source === k ? 'active' : ''}" data-source="${k}" aria-pressed="${source === k}">${label}</button>`).join('')}
      </div>` : ''}
    `;
    pickerMount.querySelectorAll('button[data-source]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.source === source) return;
        source = btn.dataset.source;
        try { localStorage.setItem(SOURCE_KEY, source); } catch (_e) { /* ignore */ }
        pickerMount.querySelectorAll('button[data-source]').forEach((b) => {
          const on = b.dataset.source === source;
          b.classList.toggle('active', on);
          b.setAttribute('aria-pressed', String(on));
        });
        loadYear(selectedYear);
      });
    });
    pickerMount.querySelectorAll('button[data-year]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const y = Number(btn.dataset.year);
        if (y === selectedYear) return;
        selectedYear = y;
        try { localStorage.setItem(STORAGE_KEY, String(y)); } catch (_e) { /* ignore */ }
        pickerMount.querySelectorAll('button[data-year]').forEach((b) => {
          const on = Number(b.dataset.year) === y;
          b.classList.toggle('active', on);
          b.setAttribute('aria-pressed', String(on));
        });
        loadYear(y);
      });
    });
    pickerMount.querySelector('#reload-btn').addEventListener('click', async () => {
      yearCache.clear();
      initial = null;
      calcCache = null;
      if (window.CalculatedBooks) window.CalculatedBooks.clear();
      // Rådata fra nordnet, StockPrices and Securities live in the store: refetch them too.
      if (window.Store && window.Store.refresh) { try { await window.Store.refresh(); } catch (_e) { /* the re-entry shows the error */ } }
      window.Views.accounting(el, ctx); // full re-entry refetches everything
    });

    // ─── Per-year fetch + cache ─────────────────────────────────────────────
    async function loadYear(year) {
      const entry = years.find((y) => y.year === year);
      if (!entry) return;
      root.innerHTML = window.UI.skeleton('block');
      const calc = calcCache.get(year) || null;
      let bundle = yearCache.get(year);
      if (!bundle && !entry.sb) {
        renderYear({ entry, sb: calc.sb, hb: calc.hb, nordnet: calc.nordnet.rows, calc, mode: 'calc', booksSb: null });
        return;
      }
      if (!bundle) {
        const wanted = [entry.sb, entry.hb];
        if (entry.nordnet) wanted.push(entry.nordnet);
        let data;
        try {
          data = await window.Sheet.batchGet(wanted, { sheetId: accountingSheetId });
        } catch (err) {
          root.innerHTML = window.UI.loadError(err, String(year));
          return;
        }
        bundle = {
          entry,
          sb: A.parseSaldobalanse(data[entry.sb] || []),
          hb: A.parseHovedbok(data[entry.hb] || []),
          nordnet: entry.nordnet ? A.parseNordnetYear(data[entry.nordnet] || []) : [],
        };
        yearCache.set(year, bundle);
      }
      if (sourceFor(year) === 'calc') {
        renderYear({ entry, sb: calc.sb, hb: calc.hb, nordnet: calc.nordnet.rows, calc, mode: 'calc', booksSb: bundle.sb });
      } else {
        renderYear({ ...bundle, calc, mode: 'books', booksSb: bundle.sb });
      }
    }

    // ─── Render ─────────────────────────────────────────────────────────────
    let hbSort = { column: 'date', direction: 'asc' };
    let hbFilter = '';

    // Calculated from DNB_raw (one-sheet step C2): every bank line of the year
    // as a voucher BA1, BA2, ..., the way the accountant's "Bank YY" tab lists
    // them. Lines no rule or DECIDE input can book are listed with a row to
    // paste into "Accounting inputs".
    function renderBankVouchers(year) {
      if (!window.Books || !window.Books.bankYear) return '';
      const r = window.Books.bankYear(dnb, aliases, inputs, year);
      if (!r.vouchers.length && !r.open.length) return '';
      const acct = (v) => v.lines.filter((l) => l.account !== 1920).map((l) => l.account).join(', ');
      const src = (v) => (v.source === 'manual' ? 'manual' : `${v.rule}${(v.flags || []).length ? ' · ' + v.flags.join(', ') : ''}`);
      const openList = r.open.length ? `
          <p class="text-small" style="margin:12px 0 4px"><strong>${r.open.length} line${r.open.length === 1 ? '' : 's'} need${r.open.length === 1 ? 's' : ''} a decision.</strong> Paste the row into "Accounting inputs" and fill in the account:</p>
          ${window.UI.table([
            { label: 'Bilag' }, { label: 'Date' }, { label: 'Text' }, { label: 'Amount', className: 'text-right' }, { label: 'Row to paste' },
          ], r.open.map((o) => [escapeHtml(o.bilagsnr), escapeHtml(o.date), escapeHtml(o.text || ''), fmtNok(o.amount), `<code>${escapeHtml(o.paste.join('\t'))}</code>`]), { caption: `Bank lines to decide, ${year}` })}` : '';
      const unused = r.unusedDecisions.length
        ? `<p class="text-muted text-small">${r.unusedDecisions.length} DECIDE row${r.unusedDecisions.length === 1 ? '' : 's'} for ${year} matched no bank line (date and amount must match): ${r.unusedDecisions.map((d) => `${escapeHtml(d.date)} ${fmtNok(d.amount)}`).join(', ')}.</p>` : '';
      return `
        <details class="bank-vouchers" style="margin-top:18px">
          <summary class="section-title"><span>Bank vouchers ${year}, calculated · ${r.vouchers.length} booked${r.open.length ? `, ${r.open.length} to decide` : ''}</span></summary>
          <p class="text-muted text-small" style="margin:6px 0 8px">From <code>DNB_raw</code> with the bank rules and your <code>Accounting inputs</code>. Automatic, not accountant-reviewed.</p>
          ${window.UI.table([
            { label: 'Bilag' }, { label: 'Date' }, { label: 'Text' }, { label: 'Account', className: 'text-right' }, { label: 'Amount', className: 'text-right' }, { label: 'Source' },
          ], r.vouchers.map((v) => [escapeHtml(v.bilagsnr), escapeHtml(v.date), escapeHtml(v.text || ''), escapeHtml(acct(v)), fmtNok(v.amount), escapeHtml(src(v))]), { caption: `Bank vouchers ${year}` })}
          ${openList}${unused}
        </details>`;
    }

    // Calculated from Rådata fra nordnet (one-sheet step C3): cost, realised
    // and unrealised gain and dividends per security, FIFO as the books, with
    // the 31.12 value from StockPrices. Checked against the books per account
    // (1810, 1811/1812, 8071, 8078/8178) in step C5, not per row: the
    // accountant's "Nordnet YY" tab does not line up security by security.
    function renderNordnetCalc(year) {
      if (!window.Books || !window.Books.nordnetYear || !(transactions || []).length) return '';
      const r = window.Books.nordnetYear(transactions, yearEndPrices(year), inputs, year);
      if (!r.rows.length && !r.flags.length) return '';
      const cell = (v) => (v == null ? '<span class="text-muted">—</span>' : fmtNok(v));
      const flags = r.flags.length ? `
          <p class="text-small" style="margin:12px 0 4px"><strong>${r.flags.length} to check.</strong> A SPLIT or REALISE row in "Accounting inputs" closes most of these:</p>
          <ul class="text-small">${r.flags.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>` : '';
      return `
        <details class="nordnet-calc" style="margin-top:18px">
          <summary class="section-title"><span>Nordnet ${year}, calculated · ${r.rows.length} ${r.rows.length === 1 ? 'security' : 'securities'}${r.flags.length ? `, ${r.flags.length} to check` : ''}</span></summary>
          <p class="text-muted text-small" style="margin:6px 0 8px">From <code>Rådata fra nordnet</code>, FIFO as the books, 31.12 price = the last trading-day close in <code>StockPrices</code> (or a PRICE row) and your <code>Accounting inputs</code> (SPLIT, REALISE). Automatic, not accountant-reviewed.</p>
          ${window.UI.table([
            { label: 'Security' }, { label: 'Cost', className: 'text-right' }, { label: 'Price 31.12', className: 'text-right' }, { label: 'Price from' },
            { label: 'Value 31.12', className: 'text-right' },
            { label: 'Unrealised', className: 'text-right' }, { label: 'Realised', className: 'text-right' }, { label: 'Dividends', className: 'text-right' },
          ], r.rows.map((x) => [escapeHtml(x.security), cell(x.kostpris), x.pris == null ? cell(null) : escapeHtml(String(Math.round(x.pris * 100) / 100).replace('.', ',')),
            escapeHtml(x.prisKilde === 'PRICE row' || x.prisKilde === 'delisted' ? x.prisKilde : x.prisDato ? `${x.prisKilde === 'last own trade' ? 'own trade' : 'close'} ${x.prisDato}` : ''),
            cell(x.markedsverdi), cell(x.urealisert), cell(x.realisert), cell(x.utbytte)]),
          { caption: `Nordnet ${year}, calculated` })}
          <p class="text-muted text-small">Cash on Nordnet in ${year}: ${fmtNok(r.cash.movement)} (bought ${fmtNok(r.totals.bought)}, sold ${fmtNok(r.totals.sold)}, dividends ${fmtNok(r.cash.dividends)}).</p>
          ${flags}
        </details>`;
    }

    // Calculated vs the books, per account (one-sheet step C5): UB of every
    // account with a balance in either, to the krone. This is the proof that
    // the second sheet can go.
    function renderCompare(calc, booksSb, year) {
      if (!calc || !booksSb || !booksSb.length) return '';
      const theirs = new Map(), ours = new Map(calc.sb.map((r) => [r.kontonr, r]));
      for (const r of booksSb) if (r.kontonr != null && !theirs.has(r.kontonr)) theirs.set(r.kontonr, r);
      const ubOf = (m, a) => (m.get(a) && m.get(a).ub) || 0;
      const accounts = [...new Set([...theirs.keys(), ...ours.keys()])]
        .filter((a) => Math.abs(ubOf(theirs, a)) >= 0.5 || Math.abs(ubOf(ours, a)) >= 0.5).sort((a, b) => a - b);
      const off = accounts.filter((a) => Math.abs(ubOf(ours, a) - ubOf(theirs, a)) >= 0.5);
      const name = (a) => (theirs.get(a) && theirs.get(a).kontonavn) || (ours.get(a) && ours.get(a).kontonavn) || '';
      const all = !off.length;
      return `
        <details class="calc-compare" style="margin-bottom:18px" ${all ? '' : 'open'}>
          <summary class="section-title"><span>Calculated vs the books ${year} · ${accounts.length - off.length} of ${accounts.length} accounts match</span></summary>
          <p class="text-muted text-small" style="margin:6px 0 8px">UB per account, to the krone. ${all
            ? 'Every account with a balance matches the accountant\'s SB.'
            : 'A difference usually means a bank line without a DECIDE row, a spin-off without SPLIT, a redemption the books kept, a year-end entry not yet typed as ENTRY, or (on 1811/1812/8080/8100) a 31.12 price that differs from the books: add a PRICE row.'}</p>
          ${off.length ? window.UI.table([
            { label: 'Konto', className: 'num' }, { label: 'Navn', className: 'wrap' }, { label: 'Books', className: 'num' },
            { label: 'Calculated', className: 'num' }, { label: 'Difference', className: 'num' },
          ], off.map((a) => [a, escapeHtml(name(a)), fmtNok(ubOf(theirs, a)), fmtNok(ubOf(ours, a)), fmtNok(ubOf(ours, a) - ubOf(theirs, a))]),
          { caption: `Accounts that differ, ${year}` }) : ''}
        </details>`;
    }

    function renderCalcBanner(calc) {
      const flags = calc.flags || [];
      return `
        <div class="flash" role="note" style="margin-bottom:18px;max-width:760px">
          <strong>Calculated from raw data, not accountant-reviewed.</strong>
          From <code>DNB_raw</code>, <code>Rådata fra nordnet</code>, <code>StockPrices</code> and your <code>Accounting inputs</code>;
          the year opens with ${calc.year === Math.min(...calcCache.keys()) ? 'the IB rows' : 'last year\'s close'}.
          ${flags.length ? `<details class="flash-details"><summary>${flags.length} to check</summary><ul class="text-small">${flags.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul></details>` : ''}
        </div>`;
    }

    function renderYear({ entry, sb, hb, nordnet, calc = null, mode = 'books', booksSb = null }) {
      const isCalc = mode === 'calc';
      const tabName = isCalc ? `SB, ${String(entry.year).slice(2)}` : entry.sb;
      const realisertSum = (nordnet || []).reduce((acc, r) => acc + (r.realisert || 0), 0);
      const realisertStocks = (nordnet || []).filter((r) => r.realisert).length;
      const status = A.computeStatus({
        sb, hb, dnb, nordnet: nordnetRaw, realisasjon: [],
        currentYear: entry.year,
        wipTabName: tabName,
      });
      status.realisasjonNet = realisertSum;
      status.realisasjonCount = realisertStocks;
      hbSort = { column: 'date', direction: 'asc' };
      hbFilter = '';

      root.innerHTML = `
        ${isCalc ? renderCalcBanner(calc) : renderWipBanner(status)}
        ${renderCompare(calc, booksSb, entry.year)}
        ${renderChecklist(A.reconcile({ sb, dnb, nordnet: nordnetRaw, year: entry.year, wipTabName: tabName, dnbTab, nordnetTab, closed: entry.year !== years[0].year, inputProblems: inputs ? inputs.problems : [] }), entry.year !== years[0].year)}
        ${renderKpiGrid(status, entry, nordnet)}
        ${isCalc ? '' : renderRulesCheck(entry, hb)}
        ${renderResultBlock(sb, nordnet, entry.year)}
        ${renderSbSection(sb, entry.year)}
        ${renderHbSection(hb, entry.year)}
        ${renderNordnetSection(nordnet, entry.year)}
        ${renderBankVouchers(entry.year)}
        ${renderNordnetCalc(entry.year)}
        ${isCalc ? `<p class="text-muted text-small" style="margin-top:18px;max-width:720px">
          Calculated in your browser from the portfolio sheet. Read-only — fix a difference with a row in <code>Accounting inputs</code>.
        </p>` : `<p class="text-muted text-small" style="margin-top:18px;max-width:720px">
          Source: <code>${escapeHtml(entry.sb)}</code> / <code>${escapeHtml(entry.hb)}</code>${entry.nordnet ? ` / <code>${escapeHtml(entry.nordnet)}</code>` : ''} in the
          <a href="${sheetUrl}" target="_blank" rel="noopener">accounting sheet ↗</a>.
          Read-only — edits stay in Google Sheets.
        </p>`}
      `;
      bindSectionHandlers(sb, hb, nordnet, entry.year);
    }

    function renderWipBanner(s) {
      if (!s.wipIsStale) return '';
      return `
        <div class="flash error" style="margin-bottom:18px">
          <strong>WIP tab name is stale.</strong> The current-year tab is still
          <code>${escapeHtml(s.wipTabName)}</code>. Open the sheet and rename it to
          <code>${escapeHtml(s.wipExpectedName)}</code> (and the matching HB tab) —
          Google Sheets auto-updates the cross-references, and this page picks up
          the new name on next reload.
        </div>
      `;
    }

    // Year-end checklist on every year; an older year shows only the number
    // checks and says it is closed. Status is a word plus an icon,
    // never colour alone.
    const CHECK_ICON = { pass: '✓', check: '!', todo: '○' };
    const CHECK_WORD = { pass: 'Pass', check: 'Check', todo: 'To do' };
    function renderChecklist(r, closed) {
      return `
        <div class="section-title"><span>Year-end checklist${closed ? ' · closed year' : ''}</span></div>
        <p class="text-muted text-small" style="margin:0 0 8px">Automatic checks, not accountant-reviewed.</p>
        <p class="checklist-summary" role="status">${escapeHtml(r.text)}</p>
        <ul class="checklist">
          ${r.rows.map((row) => `
            <li class="checklist-row ${row.status}">
              <span class="checklist-status"><span aria-hidden="true">${CHECK_ICON[row.status]}</span> ${CHECK_WORD[row.status]}</span>
              <span class="checklist-label">${escapeHtml(row.label)}</span>
              <span class="checklist-detail text-muted">${escapeHtml(row.detail)}</span>
            </li>`).join('')}
        </ul>
      `;
    }

    function renderKpiGrid(s, entry, nordnetStocks) {
      const ubClass = Math.abs(s.ubSum) < 1 ? 'positive' : 'negative';
      const ubLabel = Math.abs(s.ubSum) < 1 ? 'balanced' : 'check the books';
      const gevinstClass = s.realisasjonNet >= 0 ? 'positive' : 'negative';
      return `
        <div class="kpi-grid" style="margin-bottom:18px">
          <div class="kpi-card">
            <div class="label">SB net (UB sum)</div>
            <div class="value ${ubClass}">${fmtNok(s.ubSum)}</div>
            <div class="sub">${ubLabel} · expected 0</div>
          </div>
          <div class="kpi-card">
            <div class="label">Bilag in HB</div>
            <div class="value">${s.bilagCount}</div>
            <div class="sub">${entry.year} hovedbok</div>
          </div>
          <div class="kpi-card">
            <div class="label">Aksjer tracked</div>
            <div class="value">${(nordnetStocks || []).length}</div>
            <div class="sub">in Nordnet ${entry.year}</div>
          </div>
          <div class="kpi-card">
            <div class="label">Latest DNB</div>
            <div class="value" style="font-size:1.15rem">${s.lastDnb || '—'}</div>
            <div class="sub">${s.dnbCount} ${entry.year} txns</div>
          </div>
          <div class="kpi-card">
            <div class="label">Realisasjon (skatt)</div>
            <div class="value ${gevinstClass}">${fmtNok(s.realisasjonNet)}</div>
            <div class="sub">${s.realisasjonCount} aksjer m/ salg ${entry.year}</div>
          </div>
        </div>
      `;
    }

    // "Test the rules against the books": the bank rules run on a closed year's
    // DNB rows and compared with what the books used. Read-only, nothing is
    // stored or sent. Counts first, then the differences grouped by cause.
    const GROUPS = [
      ['unknownPayer', 'Unknown payer', 'The payer is not in the alias list, so the rules do not book it.'],
      ['fee', 'Fee account', 'Fee account to confirm: the rules use 7700.'],
      ['other', 'Other', 'No bilag found for the line, or a different account for a line the rules only suggest.'],
    ];
    function renderRulesCheck(entry, hb) {
      if (entry.year >= new Date().getFullYear()) return '';
      const rows = (dnb || []).filter((r) => r.year === entry.year);
      if (!rows.length) return '';
      const c = window.BankRules.compareWithBooks(rows, hb, aliases);
      const head = `
        <div class="section-title"><span>Test the rules against the books · ${entry.year}</span></div>
        <p class="text-muted text-small" style="margin:0 0 8px">Automatic rules, not accountant-reviewed. Covers bank lines only. Nordnet and year-end entries come in later steps.</p>`;
      if (c.noLedger) return `${head}<p class="text-muted">No ledger for this year (no <code>${escapeHtml(entry.hb)}</code> rows), so there is nothing to compare with.</p>`;
      const cols = [
        { label: 'Date', p: 2 },
        { label: 'Bank text', className: 'wrap', p: 1 },
        { label: 'Amount', className: 'num', p: 1 },
        { label: 'Our account', p: 2 },
        { label: 'Books', p: 2 },
      ];
      const groups = GROUPS.map(([key, label, note]) => {
        const items = c.groups[key];
        if (!items.length) return '';
        return `
          <details class="all-tx-details" style="margin:6px 0">
            <summary>${label} (${items.length})</summary>
            <p class="text-muted text-small" style="margin:4px 0">${escapeHtml(note)}</p>
            ${window.UI.table(cols, items.map((i) => [
              escapeHtml(i.date || ''), escapeHtml(i.text || ''), fmtNok(i.amount), escapeHtml(i.ours), escapeHtml(i.books),
            ]), { className: 'data-table', caption: label })}
          </details>`;
      }).join('');
      return `
        ${head}
        <p class="checklist-summary" role="status">${c.same} of ${c.total} bank lines go to the same account as the books.</p>
        ${groups}
        ${c.booksOnly.length ? `<p class="text-muted text-small" style="margin:6px 0 18px">${c.booksOnly.length} ledger line${c.booksOnly.length === 1 ? '' : 's'} on 1920 ha${c.booksOnly.length === 1 ? 's' : 've'} no bank row.</p>` : '<div style="margin-bottom:18px"></div>'}
      `;
    }

    // Result and equity from the SB, per the books (not accountant-reviewed).
    // Not rendered when the SB has neither result nor equity accounts.
    function renderResultBlock(sb, nordnet, year) {
      const res = A.resultForYear(sb);
      const eq = A.equityForYear(sb);
      if (!res && !eq) return '';
      const bridge = res ? A.resultBridge(res.result, nordnet) : null;
      const card = (label, v) => `
          <div class="kpi-card">
            <div class="label">${label}</div>
            <div class="value ${v.n >= 0 ? 'positive' : 'negative'}">${fmtNok(v.n)}</div>
            <div class="sub">per the books, ${year} · ${v.accounts} accounts</div>
          </div>`;
      return `
        <div class="section-title"><span>Result and equity, per the books, ${year}</span></div>
        <div class="kpi-grid" style="margin-bottom:8px">
          ${res ? card('Result (profit +)', { n: res.result, accounts: res.accounts }) : ''}
          ${eq ? card('Equity', { n: eq.equity, accounts: eq.accounts }) : ''}
        </div>
        ${bridge ? `<p class="text-muted text-small" style="margin:0 0 18px">
          Result ${fmtNok(res.result)} = realized gains per Nordnet ${fmtNok(bridge.realized)}
          + other (fees, interest, dividends, timing) ${fmtNok(bridge.other)}.
        </p>` : ''}
      `;
    }

    // ─── Saldobalanse ───────────────────────────────────────────────────────
    function renderSbSection(rows, year) {
      return `
        <div class="section-title" style="display:flex;align-items:baseline;gap:12px">
          <span>Saldobalanse · ${year}</span>
          <button type="button" class="btn ghost small" data-csv="sb">↓ CSV</button>
        </div>
        ${rows.length ? renderSbTable(rows) : '<p class="text-muted">No saldobalanse data for this year.</p>'}
      `;
    }

    function renderSbTable(rows) {
      const withUb = rows.filter((r) => r.ub != null && r.ub !== 0);
      const sorted = withUb.slice().sort((a, b) => Math.abs(b.ub) - Math.abs(a.ub));
      return `
        ${window.UI.table([
          { label: 'Konto', p: 1 },
          { label: 'Navn', className: 'wrap', p: 1 },
          { label: 'IB', className: 'num text-muted', p: 2 },
          { label: 'UB', className: 'num', p: 1 },
        ], sorted.map((r) => [
          r.kontonr,
          escapeHtml(r.kontonavn),
          r.ib != null ? fmtNok(r.ib) : '—',
          `<span class="${r.ub < 0 ? 'negative' : ''}">${fmtNok(r.ub)}</span>`,
        ]), { className: 'data-table', caption: 'Saldobalanse' })}
      `;
    }

    // ─── Hovedbok ───────────────────────────────────────────────────────────
    function renderHbSection(rows, year) {
      return `
        <div class="section-title" style="display:flex;align-items:baseline;gap:12px;margin-top:24px">
          <span>Hovedbok · ${year}</span>
          <button type="button" class="btn ghost small" data-csv="hb">↓ CSV</button>
          <span class="grow" style="flex:1"></span>
          <input type="search" id="hb-filter" placeholder="Filter bilag / konto / kommentar…" aria-label="Filter hovedbok" style="max-width:280px" />
        </div>
        <div id="hb-table-mount">${renderHbTable(rows)}</div>
      `;
    }

    function visibleHbRows(rows) {
      const f = hbFilter.trim().toLowerCase();
      const filtered = !f ? rows : rows.filter((r) => {
        return (r.bilagsnr || '').toLowerCase().includes(f)
          || String(r.kontonr || '').includes(f)
          || (r.kontonavn || '').toLowerCase().includes(f)
          || (r.kommentar || '').toLowerCase().includes(f);
      });
      const dir = hbSort.direction === 'asc' ? 1 : -1;
      const key = hbSort.column;
      return filtered.slice().sort((a, b) => {
        const av = a[key], bv = b[key];
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        if (av < bv) return -dir;
        if (av > bv) return dir;
        return 0;
      });
    }

    function sortArrow(col) {
      if (hbSort.column !== col) return '<span class="sort-arrow">↕</span>';
      return `<span class="sort-arrow">${hbSort.direction === 'asc' ? '▲' : '▼'}</span>`;
    }
    const thClass = (col, num) => `sortable ${num ? 'num' : ''} ${hbSort.column === col ? 'sorted' : ''}`;

    function renderHbTable(rows) {
      const visible = visibleHbRows(rows);
      if (!visible.length) return '<p class="text-muted">No hovedbok rows match.</p>';
      return `
        ${window.UI.table([
          { label: 'Bilag', p: 2, thClass: thClass('bilagsnr'), thAttrs: 'data-sort="bilagsnr"', thExtra: sortArrow('bilagsnr') },
          { label: 'Dato', p: 1, thClass: thClass('date'), thAttrs: 'data-sort="date"', thExtra: sortArrow('date') },
          { label: 'Konto', className: 'num', p: 2, thClass: thClass('kontonr', true), thAttrs: 'data-sort="kontonr"', thExtra: sortArrow('kontonr') },
          { label: 'Navn', className: 'wrap', p: 1, thClass: 'wrap' },
          { label: 'Kommentar', className: 'wrap', p: 3, thClass: 'wrap' },
          { label: 'Debet', className: 'num', p: 1, thClass: thClass('debet', true), thAttrs: 'data-sort="debet"', thExtra: sortArrow('debet') },
          { label: 'Kredit', className: 'num', p: 1, thClass: thClass('kredit', true), thAttrs: 'data-sort="kredit"', thExtra: sortArrow('kredit') },
        ], visible.map((r) => [
          escapeHtml(r.bilagsnr),
          r.date || '',
          r.kontonr != null ? r.kontonr : '',
          escapeHtml(r.kontonavn || ''),
          escapeHtml(r.kommentar || ''),
          r.debet != null ? fmtNok(r.debet) : '',
          r.kredit != null ? fmtNok(r.kredit) : '',
        ]), { className: 'data-table', caption: 'Hovedbok' })}
      `;
    }

    // ─── Nordnet per-stock ──────────────────────────────────────────────────
    function renderNordnetSection(rows, year) {
      return `
        <div class="section-title" style="display:flex;align-items:baseline;gap:12px;margin-top:24px">
          <span>Nordnet aksjer · ${year}</span>
          <button type="button" class="btn ghost small" data-csv="nordnet"${rows.length ? '' : ' disabled'}>↓ CSV</button>
        </div>
        ${rows.length ? renderNordnetTable(rows)
          : '<p class="text-muted">No per-stock data for this year (no <code>Nordnet ' + String(year).slice(-2) + '</code> tab found).</p>'}
      `;
    }

    function renderNordnetTable(rows) {
      const sorted = rows.slice().sort((a, b) => (b.markedsverdi || 0) - (a.markedsverdi || 0));
      return `
        ${window.UI.table([
          { label: 'Verdipapir', p: 1 },
          { label: 'Kostpris', className: 'num text-muted', p: 2 },
          { label: 'Markedsverdi', className: 'num', p: 1 },
          { label: 'Urealisert', className: 'num', p: 1 },
          { label: 'Realisert', className: 'num', p: 2 },
          { label: 'Utbytte', className: 'num', p: 3 },
        ], sorted.map((r) => {
          const tone = (v) => (v > 0 ? 'positive' : (v < 0 ? 'negative' : ''));
          return [
            `<strong>${escapeHtml(r.security)}</strong>`,
            r.kostpris != null ? fmtNok(r.kostpris) : '—',
            r.markedsverdi != null ? fmtNok(r.markedsverdi) : '—',
            `<span class="${tone(r.urealisert)}">${r.urealisert != null ? fmtNok(r.urealisert) : '—'}</span>`,
            `<span class="${tone(r.realisert)}">${r.realisert != null ? fmtNok(r.realisert) : '—'}</span>`,
            r.utbytte != null ? fmtNok(r.utbytte) : '—',
          ];
        }), { className: 'data-table', caption: 'Nordnet aksjer' })}
      `;
    }

    // ─── Event wiring per year render ───────────────────────────────────────
    function bindSectionHandlers(sb, hb, nordnet, year) {
      const yy = String(year);
      root.querySelectorAll('button[data-csv]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const kind = btn.dataset.csv;
          if (kind === 'sb') {
            A.downloadCsv(`geysir-saldobalanse-${yy}.csv`, [
              ['Kontonr', 'Kontonavn', 'IB', 'UB'],
              ...sb.map((r) => [r.kontonr, r.kontonavn, r.ib, r.ub]),
            ]);
          } else if (kind === 'hb') {
            A.downloadCsv(`geysir-hovedbok-${yy}.csv`, [
              ['Bilagsnr', 'Bilagsdato', 'Kontonr', 'Kontonavn', 'Kommentar', 'Debet', 'Kredit'],
              ...hb.map((r) => [r.bilagsnr, r.date, r.kontonr, r.kontonavn, r.kommentar, r.debet, r.kredit]),
            ]);
          } else if (kind === 'nordnet') {
            A.downloadCsv(`geysir-nordnet-aksjer-${yy}.csv`, [
              ['Verdipapir', 'Kostpris', 'Markedsverdi', 'Urealisert', 'Realisert', 'Utbytte'],
              ...nordnet.map((r) => [r.security, r.kostpris, r.markedsverdi, r.urealisert, r.realisert, r.utbytte]),
            ]);
          }
        });
      });

      const filterEl = root.querySelector('#hb-filter');
      if (filterEl) {
        filterEl.value = hbFilter;
        filterEl.addEventListener('input', () => {
          hbFilter = filterEl.value;
          root.querySelector('#hb-table-mount').innerHTML = renderHbTable(hb);
          bindHbHeaders(hb);
        });
      }
      bindHbHeaders(hb);
    }

    function bindHbHeaders(hb) {
      root.querySelectorAll('#hb-table-mount th.sortable').forEach((th) => {
        th.addEventListener('click', () => {
          const col = th.dataset.sort;
          if (hbSort.column === col) hbSort.direction = hbSort.direction === 'asc' ? 'desc' : 'asc';
          else hbSort = { column: col, direction: 'asc' };
          root.querySelector('#hb-table-mount').innerHTML = renderHbTable(hb);
          bindHbHeaders(hb);
        });
      });
    }

    loadYear(selectedYear);
  };
})();
