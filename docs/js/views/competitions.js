// Competitions view — list + live standings, scoring rules, create/delete.
// Ported from pages/competitions-page.js. Scoring runs client-side through
// CompetitionEngine; its price inputs come from the rewritten Portfolio
// (StockPrices matrix) automatically.

(function () {
  const MEMBERS = ['HH', 'HS', 'ØS', 'JC', 'HF'];

  // Team-builder styles lived in competitions.html's <style> block in the
  // old multi-page layout; the SPA view carries them itself.
  const VIEW_CSS = `
    .team-row {
      display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
      padding: 8px 10px; margin-bottom: 6px;
      background: var(--panel-2); border: 1px solid var(--border); border-radius: 10px;
    }
    .team-row .team-label { flex: 1; min-width: 160px; max-width: 240px; }
    .team-row .team-amount { width: 130px; }
    .team-row .member-chips { display: inline-flex; gap: 4px; flex-wrap: wrap; }
    .team-row .m-chip {
      position: relative; display: inline-flex; align-items: center; padding: 4px 9px; border-radius: 999px;
      background: var(--bg); border: 1px solid var(--border); color: var(--muted);
      font-size: 0.82rem; font-weight: 500; cursor: pointer; user-select: none;
      text-transform: none; letter-spacing: 0; transition: all 0.12s;
    }
    .team-row .m-chip input { position: absolute; opacity: 0; pointer-events: none; }
    .team-row .m-chip:hover, .team-row .m-chip:has(:focus-visible) { border-color: var(--accent); color: var(--text); }
    /* Keyboard focus only: a mouse click no longer leaves a ring behind. */
    .team-row .m-chip:has(:focus-visible) { outline: 2px solid var(--link); outline-offset: 2px; }
    .team-row .m-chip.checked { background: var(--accent); color: #051a0a; border-color: var(--accent); }
  `;

  // Newest competition on top: by start date, then end date, then when it was created.
  function newestFirst(list) {
    const key = (e) => [e.competition.start_date || '', e.competition.end_date || '', e.competition.created_at || ''];
    return [...(list || [])].sort((x, y) => {
      const a = key(x), b = key(y);
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? 1 : -1;
      return 0;
    });
  }

  window.Views.competitions = async function (el, ctx) {
    const { store } = ctx;
    const { fmtNok, fmtPct, pctClass, escapeHtml } = window.Fmt;

    let scored;
    // The create form sits behind the button; it stays open across re-renders
    // (after a create) so its confirmation line is visible.
    let formOpen = false;
    try {
      // Store.hydrate already read both tabs: the first paint needs no second round trip.
      // (Without them in the store, read the sheet.)
      const D = window.CompetitionsData;
      const fromStore = Array.isArray(store.competitionsRaw) && Array.isArray(store.participantsRaw);
      const list = newestFirst(fromStore ? D.fromRows(store.competitionsRaw, store.participantsRaw) : await D.listCompetitions());
      scored = scoreAll(list);
    } catch (err) {
      el.innerHTML = window.UI.loadError(err, 'competitions');
      return;
    }

    render();

    // Function declarations, not consts: render() above runs before these lines.
    function scoreAll(list) {
      return list.map((entry) => {
        const s = window.CompetitionEngine.scoreCompetition(store, entry.competition, entry.participants);
        return { ...s, participants: entry.participants };
      });
    }
    function pctBasis(t) { return window.Fmt.pctBasisLabel(t.pctBase); }
    // A competition still running is marked to the newest price: say which day.
    function priceDateNote(c) {
      const d = store.prices && store.prices.latestDate;
      return d && c.end_date >= new Date().toISOString().slice(0, 10) ? ` · prices per ${escapeHtml(d)}` : '';
    }
    function tradesLabel(n) { n = n || 0; return `${n} trade${n === 1 ? '' : 's'}`; }

    function renderCompetition(s) {
      const c = s.competition;
      const hasMultiMember = (s.teams || []).some((t) => (t.members || []).length > 1);
      // A full tie, or no purchases at all, has no winner: no trophy, no medals.
      const outcome = window.Fmt.competitionOutcome(s);
      const open = !outcome.noContest;
      const verdict = (!s.teams || !s.teams.length)
        ? 'No participants yet.'
        : !open
          ? window.Fmt.noWinnerText(outcome)
          : `Leader: ${escapeHtml(s.teams[0].label)} → ${fmtPct(s.teams[0].pct)} ${pctBasis(s.teams[0])}`;
      return `
        <div class="competition-card">
          <h3>${escapeHtml(c.name)} ${(() => {
            // Competition summary: did the club as a whole make or lose money?
            // The shared club figure (also on the deck): % of the total budget.
            const { pnl: totPnl, pct: totPct, basis: totBasis } = outcome.club;
            const winner = (s.teams && s.teams[0]) || (s.ranks && s.ranks[0]) || null;
            const live = c.end_date >= new Date().toISOString().slice(0, 10);
            return `<span class="comp-sum ${totPnl >= 0 ? 'positive' : 'negative'}" title="Everyone's competition P/L combined (realized + unrealized + dividends)">
              ${totPnl >= 0 ? '▲' : '▼'} ${fmtNok(totPnl)} (${fmtPct(totPct)} ${totBasis})</span>
              ${live ? '<span class="tag">live</span>' : (winner && open ? `<span class="tag">🏆 ${escapeHtml(winner.label || winner.code)}</span>` : '')}`;
          })()}</h3>
          <div class="meta">${escapeHtml(c.start_date)} → ${escapeHtml(c.end_date)}${priceDateNote(c)}${hasMultiMember ? ' · <span class="tag">mixed team/solo</span>' : ''}</div>
          ${outcome.club.leftOut ? `<div class="text-muted text-small">${outcome.club.leftOut} team${outcome.club.leftOut === 1 ? '' : 's'} without a budget ${outcome.club.leftOut === 1 ? 'is' : 'are'} left out of the club %.</div>` : ''}
          <div>${verdict}</div>
          <div class="ranks">
            ${(s.teams || []).map((t, i) => {
              const spentLine = t.buyIn > 0
                ? `${fmtNok(t.amountSpent)} / ${fmtNok(t.buyIn)}`
                : `${fmtNok(t.amountSpent)} spent`;
              const spentClass = t.overSpent ? 'overspent' : 'text-muted';
              return `
                <div class="r">
                  ${open ? ['🥇','🥈','🥉','4️⃣','5️⃣'][i] || '' : ''} ${escapeHtml(t.label)}
                  ${(t.members || []).length > 1 ? `<span class="text-muted text-small"> · ${t.members.join(' + ')}</span>` : ''}
                  <div class="${pctClass(t.pct)}"><strong>${fmtPct(t.pct)}</strong> <span class="text-muted text-small">${pctBasis(t)}</span> <span class="text-muted">${fmtNok(t.netPnl)}</span></div>
                  <div class="text-small ${spentClass}">
                    ${spentLine}${t.overSpent ? ` ⚠ +${fmtNok(t.overSpentBy)} over` : ''} · ${tradesLabel(t.trades)}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
          <div class="actions">
            <a class="btn small" href="./presentation.html?competition=${encodeURIComponent(c.id)}">Run presentation</a>
            <button class="btn small danger" data-delete="${escapeHtml(c.id)}">Delete</button>
          </div>
        </div>
      `;
    }

    function render() {
      el.innerHTML = `
        <style>${VIEW_CSS}</style>
        <div class="hero">
          <h2>Competitions &amp; rivalries ${window.UI.infoIcon('competition-scoring')}</h2>
          <button type="button" class="btn small" id="jump-new" aria-expanded="${formOpen}" aria-controls="new-form">+ New competition</button>
        </div>

        <details class="rules-info">
          <summary><span class="info-icon">i</span> How scoring works</summary>
          <div class="rules-body">
            <h4>Setting up</h4>
            <ul>
              <li>Pick a <strong>name</strong>, a <strong>start</strong> and an <strong>end date</strong> — that window is what gets scored.</li>
              <li>Every team needs a <strong>budget</strong> (50 000 kr is filled in when you pick a member).</li>
              <li>Up to 5 teams. A team is one person (solo) or several investors sharing one budget; each investor is on one team only.</li>
            </ul>
            <h4>What counts</h4>
            <ul>
              <li>A position enters the competition only when a <strong>buy (KJØPT) lands inside the window</strong>. A stock held from before doesn't count — even if it's sold during the window.</li>
              <li>Only plain buys and sells open and close positions; corporate actions (BYTTE, SPLITT, emisjon / rights issues) don't.</li>
              <li>Buys are attributed per investor by the Dim-values weights — only your share of a split stock counts for you.</li>
            </ul>
            <h4>Selling</h4>
            <ul>
              <li>A sell reduces only your in-window shares; the part that exceeds them (selling older shares) is ignored. Proceeds are pro-rated.</li>
            </ul>
            <h4>Dividends</h4>
            <ul>
              <li>A dividend (UTBYTTE) or withholding tax (KUPONGSKATT) counts only when the stock was <strong>bought during the window</strong>, you <strong>still hold</strong> those shares when it's paid, and it's <strong>paid before the window ends</strong>.</li>
              <li>Dividends on stock held from before the window, or paid after the end date, don't count.</li>
            </ul>
            <h4>Scoring</h4>
            <ul>
              <li><strong>Net P/L = realized + dividends + unrealized at the end.</strong></li>
              <li>End-of-window value uses the close on (or the last close before) the end date — period-correct, not today's price.</li>
            </ul>
            <h4>Budget — recyclable pool</h4>
            <ul>
              <li>Tracks actual cash, so <strong>fees are included</strong>: a buy consumes <em>price × qty + purchase fee</em>; a sell returns <em>price × qty − sale fee</em>.</li>
              <li><strong>Capital used = buys (incl. fees) − sell proceeds (net of fees)</strong>. Selling frees up budget to redeploy.</li>
              <li>Going over budget is flagged on net invested, not gross buys. Fees are only counted once.</li>
            </ul>
            <h4>Ranking</h4>
            <ul>
              <li><strong>Return % = net P/L ÷ budget</strong> (the competition amount), highest first. A 50 000 kr budget that ends +5 000 kr is +10 %, however much of it was invested. Teams aggregate by label, with the shared budget counted once.</li>
              <li>Going over budget doesn't raise the base: the % is still on the budget, and the overspend is flagged.</li>
              <li>The club figure (everyone combined) is net P/L ÷ the <strong>sum of the budgets</strong>. Older competitions can have a team with no budget: it is ranked on net invested and left out of the club figure, and the card says so. With no budget at all, the club figure is on net invested.</li>
              <li>A full tie, or a competition where nobody has bought anything, has no winner: no trophy, no medals.</li>
            </ul>
          </div>
        </details>

        ${scored.length === 0
          ? window.UI.emptyState('No competitions running.', 'Start one below — make this interesting.')
          : scored.map(renderCompetition).join('')}

        <div id="write-gate"></div>
        <form class="competition-card" id="new-form" aria-label="New competition"${formOpen ? '' : ' hidden'}>
          <p class="text-muted text-small">
            Only <strong>new buys made during the date range</strong> count toward the competition.
            A stock bought before the window doesn't enter, even if it's sold inside the window.
            Up to 5 teams — each team can be one person (solo) or multiple investors sharing a budget.
            Each investor belongs to one team only.
          </p>
          <label for="comp-name">Name</label>
          <input id="comp-name" name="name" required placeholder="Spring 2026: Pivot or perish" />
          <div style="display:flex; gap:14px; margin-top:10px; flex-wrap:wrap">
            <div style="flex:1 1 130px; min-width:0">
              <label for="comp-start">Start</label>
              <input id="comp-start" type="date" name="start_date" required />
            </div>
            <div style="flex:1 1 130px; min-width:0">
              <label for="comp-end">End</label>
              <input id="comp-end" type="date" name="end_date" required />
            </div>
          </div>

          <div class="section-title" style="margin-top: 18px; margin-bottom: 6px">Teams (up to 5)</div>
          <div id="teams-setup">
            ${[1, 2, 3, 4, 5].map((i) => `
              <div class="team-row" data-team="${i}">
                <input class="team-label" name="label-${i}" placeholder="Team ${i} label (e.g. HH, JC+ØS)" aria-label="Team ${i} label" />
                <input class="team-amount" name="amount-${i}" type="number" min="0" step="100" placeholder="Budget NOK" aria-label="Team ${i} budget NOK" />
                <div class="member-chips">
                  ${MEMBERS.map((m) => `
                    <label class="m-chip"><input type="checkbox" data-team="${i}" data-member="${m}"> ${m}</label>
                  `).join('')}
                </div>
              </div>
            `).join('')}
          </div>
          <p class="text-muted text-small" id="team-error" style="color: var(--negative)" role="status" aria-live="polite"></p>

          <div style="margin-top:14px">
            <button type="submit" class="btn">Start it 🔥</button>
          </div>
        </form>
      `;

      // Creating or deleting a competition writes to the sheet. Ask for the
      // scope up front — the grant is a redirect, so it cannot happen mid-form.
      const canWrite = window.UI.writeGate(el.querySelector('#write-gate'),
        'Creating or deleting a competition');
      if (!canWrite) {
        el.querySelectorAll('#new-form button[type="submit"], [data-delete]')
          .forEach((b) => { b.disabled = true; b.title = 'Enable editing first'; });
      }

      el.querySelector('#jump-new').addEventListener('click', (e) => {
        e.preventDefault();
        const form = el.querySelector('#new-form');
        formOpen = !formOpen;
        form.hidden = !formOpen;
        el.querySelector('#jump-new').setAttribute('aria-expanded', String(formOpen));
        if (formOpen) {
          const calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          form.scrollIntoView({ behavior: calm ? 'auto' : 'smooth' });
          el.querySelector('#comp-name').focus({ preventScroll: true });
        } else {
          el.querySelector('#team-error').textContent = '';
        }
      });

      // Members are exclusive across teams.
      el.querySelectorAll('#teams-setup input[type="checkbox"]').forEach((cb) => {
        cb.addEventListener('change', () => {
          const chip = cb.closest('.m-chip');
          if (!cb.checked) { chip.classList.remove('checked'); return; }
          chip.classList.add('checked');
          // A team needs a budget: start it at the usual 50 000, editable.
          const amount = el.querySelector(`#teams-setup input[name="amount-${cb.dataset.team}"]`);
          if (amount && !amount.value) amount.value = '50000';
          const member = cb.dataset.member;
          el.querySelectorAll(`#teams-setup input[data-member="${member}"]`).forEach((other) => {
            if (other === cb) return;
            if (other.checked) {
              other.checked = false;
              other.closest('.m-chip').classList.remove('checked');
            }
          });
        });
      });

      // One inline line for problems and for success; no alert() for either.
      function showTeamError(msg, ok) {
        const err = el.querySelector('#team-error');
        err.textContent = msg;
        err.style.color = ok ? 'var(--positive)' : 'var(--negative)';
        err.setAttribute('role', ok ? 'status' : 'alert');
      }

      el.querySelector('#new-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        el.querySelector('#team-error').textContent = '';
        const fd = new FormData(e.target);
        const teams = [];
        for (let i = 1; i <= 5; i++) {
          const label = String(fd.get(`label-${i}`) || '').trim();
          const amount = Number(fd.get(`amount-${i}`)) || 0;
          const members = Array.from(el.querySelectorAll(`#teams-setup input[data-team="${i}"]:checked`))
            .map((cb) => cb.dataset.member);
          if (!members.length && !label && !amount) continue; // empty row
          if (!members.length) {
            showTeamError(`Team ${i}: pick at least one member, or clear the row.`);
            return;
          }
          if (!(amount > 0)) {
            showTeamError(`Team ${i}: set a budget in NOK.`);
            return;
          }
          teams.push({ label: label || members.join('+'), amount, members });
        }
        if (!teams.length) {
          showTeamError('Add at least one team.');
          return;
        }
        const start = fd.get('start_date');
        const end = fd.get('end_date');
        if (end < start) {
          showTeamError('The end date is before the start date.');
          return;
        }
        // Two teams may not resolve to the same label (a blank one is its members).
        const seen = new Set();
        for (const t of teams) {
          const key = t.label.toLowerCase();
          if (seen.has(key)) {
            showTeamError(`Two teams have the same label (${t.label}). Give each team its own.`);
            return;
          }
          seen.add(key);
        }
        // Known limit: the competition row and each participant row are separate
        // sheet appends, so a failure part-way leaves a competition with fewer
        // participants. Apps Script has no transaction to wrap them in.
        try {
          const id = await window.CompetitionsData.createCompetition({
            name: fd.get('name'),
            start_date: fd.get('start_date'),
            end_date: fd.get('end_date'),
            teams,
          });
          // The create has succeeded: a failed refresh must not read as a failed create.
          let refreshErr = null;
          try { await reload(); } catch (err) { refreshErr = err; }
          // Focus the confirmation: the re-render destroyed the submit button.
          showTeamError(`Created ${id} with ${teams.length} team${teams.length === 1 ? '' : 's'}.`
            + (refreshErr ? ` The list could not refresh (${refreshErr.message}); reload the tab to see it.` : ''), true);
          const done = el.querySelector('#team-error');
          done.tabIndex = -1; done.focus();
        } catch (err) {
          showTeamError('Failed: ' + err.message);
        }
      });

      el.querySelectorAll('[data-delete]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.delete;
          if (!confirm(`Delete competition ${id}? This permanently removes it and its participants/picks from the sheet.`)) return;
          try {
            await window.CompetitionsData.deleteCompetition(id);
            await reload();
          } catch (err) {
            alert('Failed: ' + err.message);
          }
        });
      });
    }

    // Re-fetch and re-render in place (the SPA never reloads the page). The
    // fresh rows go back into the store, so the next visit starts from them.
    async function reload() {
      const raw = await window.CompetitionsData.fetchRaw();
      store.competitionsRaw = raw.competitions;
      store.participantsRaw = raw.participants;
      scored = scoreAll(newestFirst(window.CompetitionsData.fromRows(raw.competitions, raw.participants)));
      render();
    }
  };
})();
