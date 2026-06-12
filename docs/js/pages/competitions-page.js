(async function () {
  const { store, me } = await window.Nav.bootstrap('comp', { includeCompetitions: true });
  const { fmtNok, fmtPct, pctClass, escapeHtml } = window.Fmt;
  const MEMBERS = ['HH', 'HS', 'ØS', 'JC', 'HF'];

  const root = document.getElementById('root');
  let list;
  try {
    list = await window.CompetitionsData.listCompetitions();
  } catch (err) {
    root.innerHTML = `<div class="flash error">Couldn't load competitions: ${escapeHtml(err.message)}</div>`;
    return;
  }

  // Score each comp client-side
  const scored = list.map((entry) => {
    const s = window.CompetitionEngine.scoreCompetition(store, entry.competition, entry.participants);
    return { ...s, participants: entry.participants };
  });

  render();

  function render() {
    root.innerHTML = `
      <div class="hero">
        <h2>Competitions & rivalries</h2>
        <a href="#new" class="btn small" onclick="document.getElementById('new-form').scrollIntoView({behavior:'smooth'}); return false;">+ New competition</a>
      </div>

      <details class="rules-info">
        <summary><span class="info-icon">i</span> How scoring works</summary>
        <div class="rules-body">
          <h4>Setting up</h4>
          <ul>
            <li>Pick a <strong>name</strong>, a <strong>start</strong> and an <strong>end date</strong> — that window is what gets scored.</li>
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
            <li>End-of-window value uses the closest price snapshot on or before the end date — period-correct, not today's price.</li>
          </ul>
          <h4>Budget — recyclable pool</h4>
          <ul>
            <li>Tracks actual cash, so <strong>fees are included</strong>: a buy consumes <em>price × qty + purchase fee</em>; a sell returns <em>price × qty − sale fee</em>.</li>
            <li><strong>Capital used = buys (incl. fees) − sell proceeds (net of fees)</strong>. Selling frees up budget to redeploy.</li>
            <li>Going over budget is flagged on net invested, not gross buys. Fees are only counted once.</li>
          </ul>
          <h4>Ranking</h4>
          <ul>
            <li><strong>Return % = net P/L ÷ net invested</strong>, highest first. Teams aggregate by label, with the shared budget counted once.</li>
          </ul>
        </div>
      </details>

      ${scored.length === 0 ? `
        <div class="flash">No competitions running. Start one — make this interesting.</div>
      ` : scored.map(renderCompetition).join('')}

      <div class="section-title" id="new">Create a competition</div>
      <form class="competition-card" id="new-form">
        <p class="text-muted text-small">
          Only <strong>new buys made during the date range</strong> count toward the competition.
          A stock bought before the window doesn't enter, even if it's sold inside the window.
          Up to 5 teams — each team can be one person (solo) or multiple investors sharing a budget.
          Each investor belongs to one team only.
        </p>
        <label>Name</label>
        <input name="name" required placeholder="Spring 2026: Pivot or perish" />
        <div style="display:flex; gap:14px; margin-top:10px">
          <div style="flex:1">
            <label>Start</label>
            <input type="date" name="start_date" required />
          </div>
          <div style="flex:1">
            <label>End</label>
            <input type="date" name="end_date" required />
          </div>
        </div>

        <div class="section-title" style="margin-top: 18px; margin-bottom: 6px">Teams (up to 5)</div>
        <div id="teams-setup">
          ${[1,2,3,4,5].map((i) => `
            <div class="team-row" data-team="${i}">
              <input class="team-label" name="label-${i}" placeholder="Team ${i} label (e.g. HH, JC+ØS)" />
              <input class="team-amount" name="amount-${i}" type="number" min="0" step="100" placeholder="Budget NOK" />
              <div class="member-chips">
                ${MEMBERS.map((m) => `
                  <label class="m-chip"><input type="checkbox" data-team="${i}" data-member="${m}"> ${m}</label>
                `).join('')}
              </div>
            </div>
          `).join('')}
        </div>
        <p class="text-muted text-small" id="team-error" style="color: var(--negative); display:none"></p>

        <div style="margin-top:14px">
          <button type="submit" class="btn">Start it 🔥</button>
        </div>
      </form>
    `;

    // Members are exclusive across teams.
    document.querySelectorAll('#teams-setup input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const chip = cb.closest('.m-chip');
        if (!cb.checked) { chip.classList.remove('checked'); return; }
        chip.classList.add('checked');
        const member = cb.dataset.member;
        document.querySelectorAll(`#teams-setup input[data-member="${member}"]`).forEach((other) => {
          if (other === cb) return;
          if (other.checked) {
            other.checked = false;
            other.closest('.m-chip').classList.remove('checked');
          }
        });
      });
    });

    document.getElementById('new-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const fd = new FormData(form);
      const teams = [];
      for (let i = 1; i <= 5; i++) {
        const label = String(fd.get(`label-${i}`) || '').trim();
        const amount = Number(fd.get(`amount-${i}`)) || 0;
        const members = Array.from(document.querySelectorAll(`#teams-setup input[data-team="${i}"]:checked`))
          .map((cb) => cb.dataset.member);
        if (!members.length && !label && !amount) continue; // empty row
        if (!members.length) {
          showTeamError(`Team ${i}: pick at least one member, or clear the row.`);
          return;
        }
        teams.push({ label: label || members.join('+'), amount, members });
      }
      if (!teams.length) {
        showTeamError('Add at least one team.');
        return;
      }
      try {
        await window.Auth.requestWriteAccess();
        const id = await window.CompetitionsData.createCompetition({
          name: fd.get('name'),
          start_date: fd.get('start_date'),
          end_date: fd.get('end_date'),
          teams,
        });
        alert(`Created ${id} with ${teams.length} team${teams.length === 1 ? '' : 's'}.`);
        location.reload();
      } catch (err) {
        showTeamError('Failed: ' + err.message);
      }
    });

    function showTeamError(msg) {
      const el = document.getElementById('team-error');
      el.textContent = msg; el.style.display = 'block';
    }

    document.querySelectorAll('[data-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.delete;
        if (!confirm(`Delete competition ${id}? This permanently removes it and its participants/picks from the sheet.`)) return;
        try {
          await window.Auth.requestWriteAccess();
          await window.CompetitionsData.deleteCompetition(id);
          location.reload();
        } catch (err) {
          alert('Failed: ' + err.message);
        }
      });
    });
  }

  function renderCompetition(s) {
    const c = s.competition;
    const hasMultiMember = (s.teams || []).some((t) => (t.members || []).length > 1);
    const verdict = (!s.teams || !s.teams.length)
      ? 'No participants yet.'
      : `Leader: ${s.teams[0].label} → ${fmtPct(s.teams[0].pct)}`;
    return `
      <div class="competition-card">
        <h3>${escapeHtml(c.name)}</h3>
        <div class="meta">${c.start_date} → ${c.end_date}${hasMultiMember ? ' · <span class="tag">mixed team/solo</span>' : ''}</div>
        <div>${verdict}</div>
        <div class="ranks">
          ${(s.teams || []).map((t, i) => {
            const spentLine = t.buyIn > 0
              ? `${fmtNok(t.amountSpent)} / ${fmtNok(t.buyIn)}`
              : `${fmtNok(t.amountSpent)} spent`;
            const spentClass = t.overSpent ? 'overspent' : 'text-muted';
            return `
              <div class="r">
                ${['🥇','🥈','🥉','4️⃣','5️⃣'][i] || ''} ${escapeHtml(t.label)}
                ${(t.members || []).length > 1 ? `<span class="text-muted text-small"> · ${t.members.join(' + ')}</span>` : ''}
                <div class="${pctClass(t.pct)}"><strong>${fmtPct(t.pct)}</strong> <span class="text-muted">${fmtNok(t.netPnl)}</span></div>
                <div class="text-small ${spentClass}">
                  ${spentLine}${t.overSpent ? ` ⚠ +${fmtNok(t.overSpentBy)} over` : ''}
                </div>
              </div>
            `;
          }).join('')}
        </div>
        <div class="actions">
          <a class="btn small" href="./presentation.html?competition=${encodeURIComponent(c.id)}">Run presentation</a>
          <button class="btn small danger" data-delete="${c.id}">Delete</button>
        </div>
      </div>
    `;
  }
})();
