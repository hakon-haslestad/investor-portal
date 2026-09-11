(async function () {
  // Presentation page has no nav (full-screen deck), but we still need auth + store.
  // Skip nav.bootstrap and do a slim setup.
  if (window.PORTAL_CONFIG.OAUTH_CLIENT_ID.startsWith('__REPLACE')) {
    document.getElementById('root').innerHTML = 'Setup needed: edit js/config.js';
    return;
  }
  // Auth is redirect-based and lives in the SPA shell — this page only
  // reuses an existing session; without one, bounce to the shell to sign in.
  try {
    await window.Auth.ensureToken();
    await window.Auth.ensureEmail();
  } catch (_e) { location.href = './index.html'; return; }
  const store = await window.Store.hydrate({ includeCompetitions: true });

  const { fmtNok, fmtPct, fmtQty, pctClass, escapeHtml, PODIUM } = window.Fmt;

  // Shown when nobody made a single pivot trade in the second half.
  // House rules: if you won't roast your friends, why have a deck at all.
  const NO_PIVOT_ROASTS = [
    'Not a single pivot in the second half. Absolute cowards, all of you.',
    'Zero pivots. Gutless. You didn\'t "hold the line" — you fell asleep on it.',
    'Nobody dared touch a thing. Call it conviction all you want; the deck calls it fear.',
    'No pivots registered. Five grown investors, zero spine between them.',
    'The second half came and went and none of you had the stones to move. Pathetic. Magnificent, but pathetic.',
  ];
  const params = new URLSearchParams(location.search);
  const id = params.get('competition');
  const root = document.getElementById('root');
  // The deck renders the same UI.table primitive as the SPA, so it needs the
  // same delegated expander for the columns a narrow screen hides.
  window.UI.bindRowExpanders(root);
  if (!id) {
    root.innerHTML = '<p>No competition selected. <a href="./index.html#/competitions">Pick one</a>.</p>';
    return;
  }

  const entry = await window.CompetitionsData.getCompetition(id);
  if (!entry) {
    root.innerHTML = `<p>Competition <code>${escapeHtml(id)}</code> not found. <a href="./index.html#/competitions">Back</a>.</p>`;
    return;
  }
  const scored = window.CompetitionEngine.scoreCompetition(store, entry.competition, entry.participants);
  scored.participants = entry.participants;
  const data = window.PresentationBuilder.buildPresentation(store, scored);
  const slides = data.slides || [];
  let cur = 0;

  // Anything a slide starts — an animation loop, an AudioContext — must be
  // torn down before the next render blows its DOM away. The deck had no such
  // hook; without this a race left running would outlive its slide.
  let activeSlide = null;
  function teardown() {
    if (activeSlide && typeof activeSlide.destroy === 'function') {
      try { activeSlide.destroy(); } catch (_e) { /* never block navigation */ }
    }
    activeSlide = null;
  }

  function render() {
    teardown();
    const s = slides[cur];
    root.innerHTML = `
      <div class="slide-header">
        <div><a href="./index.html#/competitions" class="text-muted text-small">← back</a></div>
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
      case 'company': return renderCompany(s);
      case 'verdict': return renderVerdict(s);
      case 'race': return renderRace(s);
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
      if ((s.series || []).some((ser) => (ser.markers || []).length)) {
        const note = document.createElement('div');
        note.className = 'chart-note';
        note.innerHTML = 'daily · <span style="color:#2D5BFF">●</span> buy &nbsp; <span style="color:#FF3B3B">●</span> sell';
        el.appendChild(note);
      }
    } else if (s.type === 'race') {
      mountRace(s);
    } else if (s.type === 'picks') {
      if (s.noActivity) return;
      (s.charts || []).forEach((ch, i) => {
        if (!ch.points || ch.points.length < 2) return; // placeholder text already shown
        const el = document.getElementById(`pick-mount-${i}`);
        if (el) el.appendChild(window.Charts.priceChart({ points: ch.points, markers: ch.markers }));
      });
    }
  }

  // Two and a half minutes: long enough to be an event, short enough to hold
  // a room. The paddock waits for a keypress rather than ambushing the room
  // with a surprise clock.
  const RACE_MS = 150000;

  // The paddock. The track itself is built by HorseRaceView into #race-mount
  // once mount() runs, because it needs real DOM nodes.
  function renderRace(s) {
    if (s.noActivity || !s.lanes || s.lanes.length < 2) {
      return `
        <h2>${escapeHtml(s.title)}</h2>
        <p class="empty-note">${escapeHtml(s.emptyNote || 'Not enough runners to make a race of it.')}</p>`;
    }
    const paddock = s.lanes.map((l) => `
      <div class="race-runner">
        <span class="race-silk" style="background:${escapeHtml(l.colour)}"></span>
        <span class="race-code">${escapeHtml(l.code)}</span>
        <span class="race-name">${escapeHtml(l.name)}</span>
      </div>`).join('');
    return `
      <h2>${escapeHtml(s.title)}</h2>
      <p class="lead">Every investor is a horse. The track is their return since the window opened \u2014 so whoever crosses the line first wins the competition.</p>
      <div class="race-paddock">${paddock}</div>
      <div id="race-mount"></div>
      <p class="chart-note">Space sends them off, and pauses. M mutes. Arrow keys leave at any point.</p>`;
  }

  function mountRace(s) {
    const el = document.getElementById('race-mount');
    if (!el || !s.lanes || s.lanes.length < 2) return;
    const race = window.HorseRaceEngine.buildRace(s.lanes.map((l) => ({
      label: l.code, sublabel: l.name, colour: l.colour,
      positions: l.positions, dates: l.dates,
    })));
    if (!race.ok) {
      el.innerHTML = '<p class="empty-note">Not enough runners with a full series to race.</p>';
      return;
    }
    const audio = window.HorseRaceAudio && window.HorseRaceAudio.supported()
      ? window.HorseRaceAudio.create() : null;
    activeSlide = window.HorseRaceView.create(el, {
      race,
      duration: RACE_MS,
      autoStart: false,   // the paddock waits; space or the button starts it
      audio,
      onFinish: (r) => {
        const say = document.getElementById('hr-say');
        if (say && r.ranking && r.ranking.length) {
          const w = r.ranking[0];
          say.textContent = `${w.sublabel || w.label} wins it.`;
        }
      },
    });
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
      <p class="lead">Cumulative return % — realised (sells + dividends) and unrealised (mark-to-market) combined, competition stocks only.</p>
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
      <div class="text-muted text-small" style="margin-bottom:10px">As of ${s.asOf} (nearest snapshot to day 30) · realised (sells + dividends) and unrealised (mark-to-market) combined, competition stocks only</div>
      <div class="standings"><div class="col">
        ${s.ranks.map((r, i) => `
          <div class="rank-row">
            <div class="badge">${PODIUM[i] || ''}</div>
            <div class="who">
              <div class="name">${r.code}${r.teamLabel ? ` <span class="text-muted">(${escapeHtml(r.teamLabel)})</span>` : ''}</div>
              <div class="meta">Realised ${fmtNok((r.realized || 0) + (r.divs || 0))} · Unrealised ${fmtNok(r.unrealized || 0)} · Net ${fmtNok(r.netPnl)}</div>
            </div>
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
        <p class="text-muted">${escapeHtml(NO_PIVOT_ROASTS[Math.floor(Math.random() * NO_PIVOT_ROASTS.length)])}</p>
      `;
    }
    return `
      <h2>${escapeHtml(s.title)}</h2>
      <p class="lead">${escapeHtml(s.teaser)}</p>
      <div class="pivot-trades">
        ${window.UI.table([
          { label: 'Date', className: 'text-small', p: 1 },
          { label: 'Who', p: 1 },
          { label: 'Type', className: 'text-small', p: 2 },
          { label: 'Security', p: 1 },
          { label: 'Qty', className: 'text-right', p: 3 },
          { label: 'Amount', className: 'text-right', p: 1 },
        ], s.trades.map((t) => [
          t.date,
          `<strong>${t.code}</strong>`,
          `<span class="tag">${t.type}</span>`,
          escapeHtml(t.security),
          fmtQty(t.qty),
          `<span class="${pctClass(t.amount)}">${fmtNok(t.amount)}</span>`,
        ]), { caption: 'Pivot trades' })}
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
            ${window.UI.table([
              { label: 'Security', p: 1 },
              { label: 'Cost', className: 'text-right', p: 2 },
              { label: 'MV @ end', className: 'text-right', p: 1 },
              { label: 'Unrealized', className: 'text-right', p: 1 },
              { label: 'Realized', className: 'text-right', p: 2 },
              { label: 'Divs', className: 'text-right', p: 3 },
              { label: 'P/E', className: 'text-right text-muted', p: 3 },
              { label: 'EPS', className: 'text-right text-muted', p: 3 },
            ], r.breakdown.map((b) => [
              escapeHtml(b.security),
              fmtNok(b.costSum),
              fmtNok(b.marketValue),
              `<span class="${pctClass(b.unrealized)}">${fmtNok(b.unrealized)}</span>`,
              `<span class="${pctClass(b.realized)}">${fmtNok(b.realized)}</span>`,
              fmtNok(b.divs),
              fmtNum(b.pe),
              fmtNum(b.eps),
            ]), {
              caption: `Positions for ${r.code}`,
              foot: ['Total', fmtNok(r.total.costSum), fmtNok(r.total.mv),
                `<span class="${pctClass(r.total.unrealized)}">${fmtNok(r.total.unrealized)}</span>`,
                `<span class="${pctClass(r.total.realized)}">${fmtNok(r.total.realized)}</span>`,
                fmtNok(r.total.divs), '', ''],
            })}
            `}
          </div>
        `).join('')}
      </div>
    `;
  }
  function renderStandings(s) {
    const teams = s.teams || [];
    return `
      <h2>${escapeHtml(s.title)}</h2>
      <p class="lead">Team standings. Winner takes the glory — last place takes the shots.</p>
      <div class="standings-final">
        ${teams.map((t, i) => {
          const isWinner = i === 0;
          const isLoser = teams.length > 1 && i === teams.length - 1;
          const cls = isWinner ? 'winner' : (isLoser ? 'loser' : '');
          const tag = isWinner ? '<span class="standing-tag">🏆 Winner</span>'
            : (isLoser ? '<span class="standing-tag">🥄 Last place — drinks are on them</span>' : '');
          const spentLine = t.buyIn > 0
            ? `spent ${fmtNok(t.amountSpent)} / ${fmtNok(t.buyIn)}`
            : `spent ${fmtNok(t.amountSpent)}`;
          const spentCls = t.overSpent ? 'overspent' : 'text-muted';
          const badge = isWinner ? '🏆' : (t.podium || '');
          return `
            <div class="rank-row ${cls}">
              <div class="badge">${badge}</div>
              <div class="who">
                <div class="name">${escapeHtml(t.label)} ${tag}</div>
                <div class="meta">${(t.members||[]).join(' + ')} · <span class="${spentCls}">${spentLine}${t.overSpent ? ` ⚠ +${fmtNok(t.overSpentBy)}` : ''}</span> · ${fmtNok(t.netPnl)} P/L</div>
              </div>
              <div class="pct ${pctClass(t.pct)}">${fmtPct(t.pct)}</div>
            </div>
          `;
        }).join('')}
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
  function renderCompany(s) {
    if (s.noActivity) {
      return `
        <h2>${escapeHtml(s.title)}</h2>
        <p class="empty-note">${escapeHtml(s.emptyNote)}</p>
      `;
    }
    const cls = s.profited ? 'positive' : 'negative';
    const verdict = s.profited ? 'Yes — Geysir profited 🟢' : 'No — Geysir lost money 🔴';
    return `
      <h2>${escapeHtml(s.title)}</h2>
      <div class="company-verdict ${cls}">${verdict}</div>
      <div class="company-net ${cls}">${fmtNok(s.net)} · ${fmtPct(s.pct)}</div>
      <p class="lead">${escapeHtml(s.why)}</p>
      <div class="kpi-grid">
        <div class="kpi-card"><div class="label">Realised</div><div class="value ${pctClass(s.realized)}">${fmtNok(s.realized)}</div></div>
        <div class="kpi-card"><div class="label">Dividends</div><div class="value">${fmtNok(s.divs)}</div></div>
        <div class="kpi-card"><div class="label">Unrealised</div><div class="value ${pctClass(s.unrealized)}">${fmtNok(s.unrealized)}</div></div>
      </div>
    `;
  }

  window.__next = () => { cur = Math.min(slides.length - 1, cur + 1); render(); };
  window.__prev = () => { cur = Math.max(0, cur - 1); render(); };
  document.addEventListener('keydown', (e) => {
    // The active slide gets first refusal on space and M: on the race slide
    // space sends them off and pauses, rather than skipping past the race.
    // Arrows always navigate, so there is no way to get stuck.
    if (activeSlide && e.key === ' ') {
      e.preventDefault();
      // Once it has started, space toggles pause — including resuming, which
      // a plain isRunning() check would miss because a paused race is neither
      // running nor finished.
      if (activeSlide.isFinished && activeSlide.isFinished()) window.__next();
      else if (activeSlide.isStarted && activeSlide.isStarted()) activeSlide.pause();
      else if (typeof activeSlide.start === 'function') activeSlide.start();
      return;
    }
    if (activeSlide && (e.key === 'm' || e.key === 'M') && activeSlide.toggleMute) {
      e.preventDefault(); activeSlide.toggleMute(); return;
    }
    if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); window.__next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); window.__prev(); }
    else if (e.key === 'Home') { cur = 0; render(); }
    else if (e.key === 'End') { cur = slides.length - 1; render(); }
  });
  render();
})();
