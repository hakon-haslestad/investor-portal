// Board overview - one screen, plain words, for the five members to read or
// print. Every number comes from Portfolio.summary (club level); the view only
// formats. Competitions and the accounting result are optional: each block
// hides itself when its data is missing or its load fails.

(function () {
  window.Views = window.Views || {};

  window.Views.board = async function (el, ctx) {
    const { store } = ctx;
    const { fmtNok, fmtPct, escapeHtml: esc } = window.Fmt;
    const ii = window.UI.infoIcon;
    const sum = window.Portfolio.summary(store);

    // Optional loads. A failed load hides its block; an ended session does not.
    let competitions = null, books = null;
    try {
      [competitions, books] = await Promise.all([loadCompetitions(), loadBooks()]);
    } catch (err) {
      el.innerHTML = window.UI.loadError(err, 'the board overview');
      return;
    }

    async function swallow(fn) {
      try { return await fn(); } catch (err) {
        if (window.UI.isSessionExpired(err)) throw err;
        return null;
      }
    }
    // Last finished competition and the one running now, scored by the engine.
    function loadCompetitions() {
      return swallow(async () => {
        const list = await window.CompetitionsData.listCompetitions();
        const scored = list.map((e) => window.CompetitionEngine.scoreCompetition(store, e.competition, e.participants));
        const finished = scored.filter((s) => s.competition.end_date < sum.asOf)
          .sort((a, b) => b.competition.end_date.localeCompare(a.competition.end_date))[0] || null;
        const live = scored.filter((s) => s.competition.start_date <= sum.asOf && s.competition.end_date >= sum.asOf)[0] || null;
        return finished || live ? { finished, live } : null;
      });
    }
    // Result of the latest closed year: the accountant's SB tab while the
    // accounting sheet is set, otherwise the books calculated from raw data.
    function loadBooks() {
      return swallow(async () => {
        const A = window.Accounting;
        const sheetId = window.PORTAL_CONFIG.ACCOUNTING_SHEET_ID;
        if (!sheetId) {
          if (window.Lazy) await window.Lazy.load('books');
          const { years } = await window.CalculatedBooks.load();
          const y = [...years.keys()].filter((k) => k < Number(String(sum.asOf).slice(0, 4))).sort((a, b) => b - a)[0];
          const r = y ? A.resultForYear(years.get(y).sb) : null;
          return r ? { year: y, result: r.result, calculated: true } : null;
        }
        const entry = A.latestClosedYear(A.discoverYears(await window.Sheet.listTabs({ sheetId })), sum.asOf);
        if (!entry) return null;
        const data = await window.Sheet.batchGet([entry.sb], { sheetId });
        const r = A.resultForYear(A.parseSaldobalanse(data[entry.sb] || []));
        return r ? { year: entry.year, result: r.result } : null;
      });
    }

    const tone = (n) => (n < 0 ? 'negative' : n > 0 ? 'positive' : '');
    const tile = (label, value, sub, info, toneName) => `
      <div class="kpi-card">
        <div class="label">${esc(label)}${info ? ' ' + ii(info, label) : ''}</div>
        <div class="value ${toneName || ''}">${value}</div>
        <div class="sub">${sub}</div>
      </div>`;

    function pricesChip() {
      if (!sum.hasData) return '';
      return sum.staleCount > 0
        ? `<span class="stale-chip">${sum.staleCount} holding${sum.staleCount === 1 ? '' : 's'} with old prices</span>`
        : '<span class="board-fresh">Prices up to date</span>';
    }

    function teamLine(s, label) {
      const c = s.competition;
      const outcome = window.Fmt.competitionOutcome(s);
      const lead = s.teams && s.teams[0];
      if (outcome.noContest || !lead) return `<li>${label} <strong>${esc(c.name)}</strong>: ${esc(window.Fmt.noWinnerText(outcome))}</li>`;
      return `<li>${label} <strong>${esc(c.name)}</strong>: ${esc(lead.label)}, ${fmtPct(lead.pct)} ${esc(window.Fmt.pctBasisLabel(lead.pctBase))}</li>`;
    }

    const tiles = [];
    if (sum.hasData) {
      tiles.push(tile('Company value', fmtNok(sum.value.total), `Stocks ${fmtNok(sum.value.marketValue)} + cash ${fmtNok(sum.value.cash)}`, 'total-value'));
      tiles.push(tile('Profit, total', fmtNok(sum.profit.total), `${fmtPct(sum.returnPct)} of total bought`, 'return-pct', tone(sum.profit.total)));
      tiles.push(tile('Profit this year', fmtNok(sum.profit.ytd), `1 Jan ${esc(sum.asOf.slice(0, 4))} to ${esc(sum.asOf)}`, 'window-metrics', tone(sum.profit.ytd)));
    }
    if (books) {
      tiles.push(tile('Accounting result', fmtNok(books.result), `${books.calculated ? 'calculated from raw data' : 'per the books'}, ${books.year} (Norwegian: resultat)`, 'accounting-kpis', tone(books.result)));
    }

    const cashBar = sum.hasData && sum.cashPct != null ? `
      <section class="board-card">
        <h3 class="section-title">Cash vs invested ${ii('cash')}</h3>
        <div class="board-bar" role="img" aria-label="Cash ${fmtPct(sum.cashPct, false)}, stocks ${fmtPct(sum.stocksPct, false)}">
          <span class="board-bar-stocks" style="width:${Math.round(Math.max(0, Math.min(100, sum.stocksPct)))}%"></span>
        </div>
        <div class="board-legend"><span><i class="board-swatch board-swatch-stocks" aria-hidden="true"></i>Stocks ${fmtPct(sum.stocksPct, false)} (${fmtNok(sum.value.marketValue)})</span><span><i class="board-swatch board-swatch-cash" aria-hidden="true"></i>Cash ${fmtPct(sum.cashPct, false)} (${fmtNok(sum.value.cash)})</span></div>
      </section>` : '';

    const top = sum.top.length ? `
      <section class="board-card">
        <h3 class="section-title">Top holdings, share of stocks ${ii('holdings-table')}</h3>
        <ol class="board-top">${sum.top.map((h) => `
          <li><span class="board-top-name">${esc(h.security)}</span>
            <span class="board-top-bar" aria-hidden="true"><span style="width:${Math.round(Math.max(0, Math.min(100, h.weightPct)))}%"></span></span>
            <span class="board-top-pct">${fmtPct(h.weightPct, false)}</span></li>`).join('')}
        </ol>
      </section>` : '';

    const comps = competitions ? `
      <section class="board-card board-wide">
        <h3 class="section-title">Competitions ${ii('competition-scoring')}</h3>
        <ul class="board-list">
          ${competitions.finished ? teamLine(competitions.finished, 'Last finished:') : ''}
          ${competitions.live ? teamLine(competitions.live, 'Live now, leader:') : ''}
        </ul>
      </section>` : '';

    // What the businesses earn us: the KPI tab's numbers, as entered in the
    // sheet. Three headline numbers at most; the rest sits in one details line.
    function earningsBlock(e) {
      if (!e) return '';
      const q = e.quarter;
      const cards = [tile('Look-through earnings', fmtNok(e.earnings), 'a year, our share, as entered in the sheet', 'business-earnings', tone(e.earnings))];
      if (e.yieldPct != null) cards.push(tile('Earnings yield', fmtPct(e.yieldPct, false), 'of the value of the holdings that report', 'business-earnings'));
      if (q) cards.push(tile(`${q.label} profit, our share`, fmtNok(q.now), `${q.priorLabel}: ${fmtNok(q.before)}${q.changePct != null ? ', ' + fmtPct(q.changePct) : ''} (${q.companies} companies)`, 'business-earnings', tone(q.now)));
      const details = [];
      if (e.pe != null) details.push(`Portfolio P/E ${window.Fmt.fmtDec(e.pe, 1)}`);
      if (e.freshness) details.push(`${esc(e.freshness.label)} reported for ${e.freshness.reported} of ${e.freshness.of} holdings`);
      const notes = e.notes.length ? `<ul class="board-list board-notes">${e.notes.map((n) => `<li><strong>${esc(n.security)}</strong>: ${esc(n.note)}</li>`).join('')}</ul>` : '';
      return `
      <section class="board-card board-wide">
        <h3 class="section-title">What the businesses earn us ${ii('business-earnings')}</h3>
        <div class="kpi-grid board-tiles">${cards.join('')}</div>
        ${details.length ? `<p class="text-muted text-small">${details.join('. ')}.</p>` : ''}${notes}
      </section>`;
    }
    const earn = sum.hasData ? earningsBlock(sum.earnings) : '';
    const fxNote = sum.hasData && sum.missingFx > 0
      ? `<p class="text-muted text-small">${sum.missingFx} trade${sum.missingFx === 1 ? '' : 's'} in a foreign currency ${sum.missingFx === 1 ? 'has' : 'have'} no exchange rate yet and ${sum.missingFx === 1 ? 'is' : 'are'} left out of the company value.</p>` : '';

    const body = [tiles.length ? `<div class="kpi-grid board-tiles">${tiles.join('')}</div>` : '', cashBar || top ? `<div class="board-row">${cashBar}${top}</div>` : '', earn, comps, fxNote].join('');

    el.innerHTML = `
      <div class="board">
        <div class="hero">
          <h2>Board overview</h2>
          <div class="when">as of ${esc(sum.asOf)} ${pricesChip()}
            <button type="button" class="btn small board-print" data-act="print">Print</button></div>
        </div>
        ${body || window.UI.emptyState('Nothing to show yet', 'There are no transactions in the sheet yet.')}
        ${body && !sum.hasData ? '<p class="text-muted text-small">There are no transactions in the sheet yet, so the club numbers are not shown.</p>' : ''}
        <p class="board-foot text-muted text-small">Source: the club's Google Sheet, club level.<span class="board-defs"> Definitions: value ${ii('total-value')}, profit ${ii('return-pct')}, prices ${ii('price-freshness')}.</span></p>
      </div>`;

    const btn = el.querySelector('[data-act="print"]');
    if (btn) btn.addEventListener('click', () => window.print());
  };
})();
