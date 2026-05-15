(async function () {
  const me = await fetchMe();
  if (!me) return;
  const params = new URLSearchParams(location.search);
  const id = params.get('competition');
  if (!id) {
    document.getElementById('root').innerHTML = '<p>No competition selected. <a href="/competitions.html">Pick one</a>.</p>';
    return;
  }
  const data = await api('/api/competitions/' + encodeURIComponent(id) + '/presentation');
  if (!data) return;
  const slides = data.slides || [];
  let cur = 0;

  const root = document.getElementById('root');

  function render() {
    const s = slides[cur];
    root.innerHTML = `
      <div class="slide-header">
        <div><a href="/competitions.html" class="text-muted text-small">← back</a></div>
        <div class="progress">${cur + 1} / ${slides.length}</div>
        <div>
          <button class="nav-btn" onclick="window.__prev()">←</button>
          <button class="nav-btn" onclick="window.__next()">→</button>
        </div>
      </div>
      <div class="slide ${slideClass(s.type)}">
        ${renderSlide(s, data.competition)}
      </div>
    `;
  }

  function slideClass(type) { return 'slide-' + type; }

  function renderSlide(s, comp) {
    switch (s.type) {
      case 'title': return renderTitle(s);
      case 'setup': return renderSetup(s);
      case 'early': return renderEarly(s);
      case 'pivot': return renderPivot(s);
      case 'positions': return renderPositions(s);
      case 'standings': return renderStandings(s, comp);
      case 'verdict': return renderVerdict(s);
      default: return `<pre>${JSON.stringify(s, null, 2)}</pre>`;
    }
  }

  function renderTitle(s) {
    return `
      <h1>${s.title}</h1>
      <p class="lead">${s.subtitle}</p>
      <div class="chips">${(s.chips || []).map((c) => `<div class="chip">${c}</div>`).join('')}</div>
      <div class="participants">${s.participantsLine}</div>
    `;
  }

  function renderSetup(s) {
    return `
      <h2>${s.title}</h2>
      <p class="lead">${s.teaser}</p>
      <div class="setup-grid">
        ${s.rows.map((r) => `
          <div class="setup-row">
            <div class="name">${r.code} <span class="text-muted text-small">${r.name}</span></div>
            ${r.team ? `<div class="team">Team: ${r.team}</div>` : ''}
            <div class="picks">${(r.picks || []).join(' · ') || '<span class="text-muted">full portfolio</span>'}</div>
            <div class="buyin">Buy-in: ${fmtNok(r.buyIn)}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderEarly(s) {
    return `
      <h2>${s.title}</h2>
      <p class="lead">${s.teaser}</p>
      <div class="text-muted text-small" style="margin-bottom:10px">As of ${s.asOf}</div>
      <div class="standings"><div class="col">
        ${s.ranks.map((r, i) => `
          <div class="rank-row">
            <div class="badge">${['🥇','🥈','🥉','4️⃣','5️⃣'][i] || ''}</div>
            <div class="who"><div class="name">${r.code}${r.teamLabel ? ` <span class="text-muted">(${r.teamLabel})</span>` : ''}</div><div class="meta">${fmtNok(r.netPnl)}</div></div>
            <div class="pct ${pctClass(r.pct)}">${fmtPct(r.pct)}</div>
          </div>
        `).join('')}
      </div></div>
    `;
  }

  function renderPivot(s) {
    if (!s.trades || s.trades.length === 0) {
      return `
        <h2>${s.title}</h2>
        <p class="lead">${s.teaser}</p>
        <p class="text-muted">No "pivot" trades inside the second half of this window. Everyone held the line.</p>
      `;
    }
    return `
      <h2>${s.title}</h2>
      <p class="lead">${s.teaser}</p>
      <div class="pivot-trades">
        <table>
          <thead><tr><th>Date</th><th>Who</th><th>Type</th><th>Security</th><th class="text-right">Qty</th><th class="text-right">Amount</th></tr></thead>
          <tbody>
            ${s.trades.map((t) => `
              <tr>
                <td class="text-small">${t.date}</td>
                <td><strong>${t.code}</strong></td>
                <td class="text-small"><span class="tag">${t.type}</span></td>
                <td>${t.security}</td>
                <td class="text-right">${fmtQty(t.qty)}</td>
                <td class="text-right ${pctClass(t.amount)}">${fmtNok(t.amount)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderPositions(s) {
    return `
      <h2>${s.title}</h2>
      <p class="lead">${s.teaser}</p>
      <div class="position-list">
        ${s.rows.map((r) => `
          <div class="investor-card">
            <h3>${r.code} <span class="text-muted text-small">${r.name}${r.teamLabel ? ` · ${r.teamLabel}` : ''}</span></h3>
            ${r.breakdown.length === 0 ? '<p class="text-muted">No positions in this window.</p>' : `
            <table>
              <thead><tr><th>Security</th><th class="text-right">Cost</th><th class="text-right">MV now</th><th class="text-right">Unrealized</th><th class="text-right">Divs</th></tr></thead>
              <tbody>
                ${r.breakdown.map((b) => `
                  <tr>
                    <td>${b.security}</td>
                    <td class="text-right">${fmtNok(b.costSum)}</td>
                    <td class="text-right">${fmtNok(b.marketValue)}</td>
                    <td class="text-right ${pctClass(b.unrealized)}">${fmtNok(b.unrealized)}</td>
                    <td class="text-right">${fmtNok(b.divs)}</td>
                  </tr>
                `).join('')}
                <tr class="summary-row">
                  <td>Total</td>
                  <td class="text-right">${fmtNok(r.total.costSum)}</td>
                  <td class="text-right">${fmtNok(r.total.mv)}</td>
                  <td class="text-right ${pctClass(r.total.unrealized)}">${fmtNok(r.total.unrealized)}</td>
                  <td class="text-right">${fmtNok(r.total.divs)}</td>
                </tr>
              </tbody>
            </table>
            `}
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderStandings(s, comp) {
    return `
      <h2>${s.title}</h2>
      <p class="lead">All in. Receipts below.</p>
      <div class="standings">
        <div class="col">
          <h3>Individual</h3>
          ${s.individual.map((r) => `
            <div class="rank-row">
              <div class="badge">${r.podium}</div>
              <div class="who"><div class="name">${r.code} <span class="text-muted text-small">${r.name}${r.teamLabel ? ` · ${r.teamLabel}` : ''}</span></div>
              <div class="meta">${fmtNok(r.netPnl)} P/L · MV ${fmtNok(r.mv)}</div></div>
              <div class="pct ${pctClass(r.pct)}">${fmtPct(r.pct)}</div>
            </div>
          `).join('')}
        </div>
        ${s.teams ? `
        <div class="col">
          <h3>Teams</h3>
          ${s.teams.map((t) => `
            <div class="rank-row">
              <div class="badge">${t.podium}</div>
              <div class="who"><div class="name">${t.label}</div><div class="meta">${(t.members||[]).join(' + ')} · buy-in ${fmtNok(t.buyIn)}</div></div>
              <div class="pct ${pctClass(t.pct)}">${fmtPct(t.pct)}</div>
            </div>
          `).join('')}
        </div>
        ` : ''}
      </div>
    `;
  }

  function renderVerdict(s) {
    return `
      <h2>${s.title}</h2>
      <div class="verdict-card">
        <div class="big">${s.teaser}</div>
        <div class="runners">${(s.runnerUps || []).join(' · ')}</div>
      </div>
    `;
  }

  window.__next = () => { cur = Math.min(slides.length - 1, cur + 1); render(); };
  window.__prev = () => { cur = Math.max(0, cur - 1); render(); };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); window.__next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); window.__prev(); }
    else if (e.key === 'Home') { cur = 0; render(); }
    else if (e.key === 'End') { cur = slides.length - 1; render(); }
  });
  render();
})();
