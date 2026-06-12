(async function () {
  // Presentation page has no nav (full-screen deck), but we still need auth + store.
  // Skip nav.bootstrap and do a slim setup.
  if (window.PORTAL_CONFIG.OAUTH_CLIENT_ID.startsWith('__REPLACE')) {
    document.getElementById('root').innerHTML = 'Setup needed: edit js/config.js';
    return;
  }
  try { await window.Auth.ensureToken(); } catch (_e) { location.href = './login.html'; return; }
  if (!window.Auth.getEmail()) {
    try { await window.Auth.signIn(); } catch (_e) { location.href = './login.html'; return; }
  }
  const store = await window.Store.hydrate({ includeCompetitions: true });

  const { fmtNok, fmtPct, fmtQty, pctClass, escapeHtml, PODIUM } = window.Fmt;
  const params = new URLSearchParams(location.search);
  const id = params.get('competition');
  const root = document.getElementById('root');
  if (!id) {
    root.innerHTML = '<p>No competition selected. <a href="./competitions.html">Pick one</a>.</p>';
    return;
  }

  const entry = await window.CompetitionsData.getCompetition(id);
  if (!entry) {
    root.innerHTML = `<p>Competition <code>${escapeHtml(id)}</code> not found. <a href="./competitions.html">Back</a>.</p>`;
    return;
  }
  const scored = window.CompetitionEngine.scoreCompetition(store, entry.competition, entry.participants);
  scored.participants = entry.participants;
  const data = window.PresentationBuilder.buildPresentation(store, scored);
  const slides = data.slides || [];
  let cur = 0;

  function render() {
    const s = slides[cur];
    root.innerHTML = `
      <div class="slide-header">
        <div><a href="./competitions.html" class="text-muted text-small">← back</a></div>
        <div class="progress">${cur + 1} / ${slides.length}</div>
        <div>
          <button class="nav-btn" onclick="window.__prev()">←</button>
          <button class="nav-btn" onclick="window.__next()">→</button>
        </div>
      </div>
      <div class="slide slide-${s.type}">${renderSlide(s, data.competition)}</div>
    `;
    mount(s); // some slides (charts) need real DOM nodes after innerHTML is set
  }

  function renderSlide(s) {
    switch (s.type) {
      case 'title': return renderTitle(s);
      case 'summary': return renderSummary(s);
      case 'setup': return renderSetup(s);
      case 'early': return renderEarly(s);
      case 'curve': return renderCurve(s);
      case 'picks': return renderPicks(s);
      case 'pivot': return renderPivot(s);
      case 'positions': return renderPositions(s);
      case 'standings': return renderStandings(s);
      case 'verdict': return renderVerdict(s);
      default: return `<pre>${JSON.stringify(s, null, 2)}</pre>`;
    }
  }

  // Post-innerHTML hook: inject SVG charts into their mount points.
  function mount(s) {
    if (s.type === 'curve') {
      const el = document.getElementById('chart-mount');
      if (!el) return;
      const flat = !s.series || !s.series.length
        || s.series.every((ser) => (ser.points || []).every((p) => Math.abs(p.y || 0) < 0.01));
      if (s.noActivity || flat) return; // empty-state banner already rendered
      el.appendChild(window.Charts.multiLine({
        series: s.series, width: 960, height: 360,
        title: 'Cumulative return % by participant', interactive: true,
      }));
    } else if (s.type === 'picks') {
      if (s.noActivity) return;
      (s.charts || []).forEach((ch, i) => {
        if (!ch.points || ch.points.length < 2) return; // placeholder text already shown
        const el = document.getElementById(`pick-mount-${i}`);
        if (el) el.appendChild(window.Charts.priceChart({ points: ch.points, markers: ch.markers }));
      });
    }
  }

  function renderTitle(s) {
    return `
      <h1>${escapeHtml(s.title)}</h1>
      <p class="lead">${escapeHtml(s.subtitle)}</p>
      <div class="chips">${(s.chips || []).map((c) => `<div class="chip">${escapeHtml(c)}</div>`).join('')}</div>
      <div class="participants">${escapeHtml(s.participantsLine)}</div>
    `;
  }
  function renderSummary(s) {
    const banner = s.noActivity
      ? `<p class="empty-note">${escapeHtml(s.emptyNote)}</p>` : '';
    return `
      <h2>${escapeHtml(s.title)}</h2>
      ${banner}
      <div class="kpi-grid">
        ${s.cards.map((card) => `
          <div class="kpi-card">
            <div class="label">${escapeHtml(card.label)}</div>
            <div class="value ${card.cls || ''}">${escapeHtml(String(card.value))}</div>
            ${card.sub ? `<div class="sub">${escapeHtml(card.sub)}</div>` : ''}
          </div>
        `).join('')}
      </div>
    `;
  }
  function renderCurve(s) {
    const flat = !s.series || !s.series.length
      || s.series.every((ser) => (ser.points || []).every((p) => Math.abs(p.y || 0) < 0.01));
    if (s.noActivity || flat) {
      return `
        <h2>${escapeHtml(s.title)}</h2>
        <p class="empty-note">${escapeHtml(s.emptyNote)}</p>
      `;
    }
    const legend = s.series.map((ser) => `
      <span class="legend-key"><span class="swatch" style="background:${ser.color}"></span>${escapeHtml(ser.name)}</span>
    `).join('');
    return `
      <h2>${escapeHtml(s.title)}</h2>
      <div class="curve-legend">${legend}</div>
      <div id="chart-mount" class="chart-wrap"></div>
    `;
  }
  function renderPicks(s) {
    if (s.noActivity || !s.charts || !s.charts.length) {
      return `
        <h2>${escapeHtml(s.title)}</h2>
        <p class="empty-note">${escapeHtml(s.emptyNote)}</p>
      `;
    }
    return `
      <h2>${escapeHtml(s.title)}</h2>
      <p class="lead">Buy / sell marked on each pick's price through the window.</p>
      <div class="picks-grid">
        ${s.charts.map((ch, i) => `
          <div class="chart-card pick-card">
            <div class="pick-head">
              <span class="pick-sec">${escapeHtml(ch.security)}</span>
              <span class="text-muted text-small">${ch.code}${ch.name && ch.name !== ch.code ? ` · ${escapeHtml(ch.name)}` : ''}</span>
              <span class="pick-gain ${pctClass(ch.gain)}">${fmtNok(ch.gain)}</span>
            </div>
            <div id="pick-mount-${i}" class="pick-chart">
              ${ch.points.length < 2 ? '<p class="text-muted text-small" style="padding:10px 6px">Not enough price history in this window.</p>' : ''}
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }
  function renderSetup(s) {
    return `
      <h2>${escapeHtml(s.title)}</h2>
      <p class="lead">${escapeHtml(s.teaser)}</p>
      <div class="setup-grid">
        ${s.rows.map((r) => {
          const spentLine = r.buyIn > 0
            ? `Spent ${fmtNok(r.amountSpent)} / Budget ${fmtNok(r.buyIn)}`
            : `Spent ${fmtNok(r.amountSpent)}`;
          const cls = r.overSpent ? 'overspent' : 'text-muted';
          return `
            <div class="setup-row">
              <div class="name">${escapeHtml(r.label)}</div>
              ${(r.members || []).length > 1 ? `<div class="team">Team: ${r.members.join(' + ')}</div>` : ''}
              <div class="buyin ${cls}">${spentLine}${r.overSpent ? ` ⚠ +${fmtNok(r.overSpentBy)} over` : ''}</div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }
  function renderEarly(s) {
    return `
      <h2>${escapeHtml(s.title)}</h2>
      <p class="lead">${escapeHtml(s.teaser)}</p>
      <div class="text-muted text-small" style="margin-bottom:10px">As of ${s.asOf}</div>
      <div class="standings"><div class="col">
        ${s.ranks.map((r, i) => `
          <div class="rank-row">
            <div class="badge">${PODIUM[i] || ''}</div>
            <div class="who"><div class="name">${r.code}${r.teamLabel ? ` <span class="text-muted">(${escapeHtml(r.teamLabel)})</span>` : ''}</div><div class="meta">${fmtNok(r.netPnl)}</div></div>
            <div class="pct ${pctClass(r.pct)}">${fmtPct(r.pct)}</div>
          </div>
        `).join('')}
      </div></div>
    `;
  }
  function renderPivot(s) {
    if (!s.trades || s.trades.length === 0) {
      return `
        <h2>${escapeHtml(s.title)}</h2>
        <p class="lead">${escapeHtml(s.teaser)}</p>
        <p class="text-muted">No "pivot" trades inside the second half of this window. Everyone held the line.</p>
      `;
    }
    return `
      <h2>${escapeHtml(s.title)}</h2>
      <p class="lead">${escapeHtml(s.teaser)}</p>
      <div class="pivot-trades">
        <table>
          <thead><tr><th>Date</th><th>Who</th><th>Type</th><th>Security</th><th class="text-right">Qty</th><th class="text-right">Amount</th></tr></thead>
          <tbody>
            ${s.trades.map((t) => `
              <tr>
                <td class="text-small">${t.date}</td>
                <td><strong>${t.code}</strong></td>
                <td class="text-small"><span class="tag">${t.type}</span></td>
                <td>${escapeHtml(t.security)}</td>
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
    if (s.noActivity) {
      return `
        <h2>${escapeHtml(s.title)}</h2>
        <p class="empty-note">${escapeHtml(s.emptyNote)}</p>
      `;
    }
    const fmtNum = (v) => (v == null || v === '' ? '—' : escapeHtml(String(v)));
    return `
      <h2>${escapeHtml(s.title)}</h2>
      <p class="lead">${escapeHtml(s.teaser)}</p>
      <div class="position-list">
        ${s.rows.map((r) => `
          <div class="investor-card">
            <h3>${r.code} <span class="text-muted text-small">${escapeHtml(r.name)}${r.teamLabel ? ` · ${escapeHtml(r.teamLabel)}` : ''}</span></h3>
            ${r.breakdown.length === 0 ? '<p class="text-muted">No positions in this window.</p>' : `
            <table>
              <thead><tr><th>Security</th><th class="text-right">Cost</th><th class="text-right">MV @ end</th><th class="text-right">Unrealized</th><th class="text-right">Divs</th><th class="text-right">P/E</th><th class="text-right">EPS</th></tr></thead>
              <tbody>
                ${r.breakdown.map((b) => `
                  <tr>
                    <td>${escapeHtml(b.security)}</td>
                    <td class="text-right">${fmtNok(b.costSum)}</td>
                    <td class="text-right">${fmtNok(b.marketValue)}</td>
                    <td class="text-right ${pctClass(b.unrealized)}">${fmtNok(b.unrealized)}</td>
                    <td class="text-right">${fmtNok(b.divs)}</td>
                    <td class="text-right text-muted">${fmtNum(b.pe)}</td>
                    <td class="text-right text-muted">${fmtNum(b.eps)}</td>
                  </tr>
                `).join('')}
                <tr class="summary-row">
                  <td>Total</td>
                  <td class="text-right">${fmtNok(r.total.costSum)}</td>
                  <td class="text-right">${fmtNok(r.total.mv)}</td>
                  <td class="text-right ${pctClass(r.total.unrealized)}">${fmtNok(r.total.unrealized)}</td>
                  <td class="text-right">${fmtNok(r.total.divs)}</td>
                  <td class="text-right"></td>
                  <td class="text-right"></td>
                </tr>
              </tbody>
            </table>
            `}
          </div>
        `).join('')}
      </div>
    `;
  }
  function renderStandings(s) {
    return `
      <h2>${escapeHtml(s.title)}</h2>
      <p class="lead">All in. Receipts below.</p>
      <div class="standings">
        <div class="col">
          <h3>Individual</h3>
          ${s.individual.map((r) => `
            <div class="rank-row">
              <div class="badge">${r.podium}</div>
              <div class="who"><div class="name">${r.code} <span class="text-muted text-small">${escapeHtml(r.name)}${r.teamLabel ? ` · ${escapeHtml(r.teamLabel)}` : ''}</span></div>
              <div class="meta">${fmtNok(r.netPnl)} P/L · MV @ end ${fmtNok(r.mv)}</div></div>
              <div class="pct ${pctClass(r.pct)}">${fmtPct(r.pct)}</div>
            </div>
          `).join('')}
        </div>
        ${s.teams ? `
        <div class="col">
          <h3>Teams</h3>
          ${s.teams.map((t) => {
            const spentLine = t.buyIn > 0
              ? `spent ${fmtNok(t.amountSpent)} / ${fmtNok(t.buyIn)}`
              : `spent ${fmtNok(t.amountSpent)}`;
            const spentCls = t.overSpent ? 'overspent' : 'text-muted';
            return `
              <div class="rank-row">
                <div class="badge">${t.podium}</div>
                <div class="who">
                  <div class="name">${escapeHtml(t.label)}</div>
                  <div class="meta">${(t.members||[]).join(' + ')} · <span class="${spentCls}">${spentLine}${t.overSpent ? ` ⚠ +${fmtNok(t.overSpentBy)}` : ''}</span></div>
                </div>
                <div class="pct ${pctClass(t.pct)}">${fmtPct(t.pct)}</div>
              </div>
            `;
          }).join('')}
        </div>
        ` : ''}
      </div>
    `;
  }
  function renderVerdict(s) {
    return `
      <h2>${escapeHtml(s.title)}</h2>
      <div class="verdict-card">
        <div class="big">${escapeHtml(s.teaser)}</div>
        <div class="runners">${(s.runnerUps || []).map(escapeHtml).join(' · ')}</div>
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
