(async function () {
  const me = await fetchMe();
  if (!me) return;
  document.getElementById('nav-mount').innerHTML = buildNav('comp', me.displayName);

  const data = await api('/api/competitions');
  const root = document.getElementById('root');

  root.innerHTML = `
    <div class="hero">
      <h2>Comps & rivalries</h2>
      <a href="#new" class="btn small" onclick="document.getElementById('new-form').scrollIntoView({behavior:'smooth'}); return false;">+ New comp</a>
    </div>

    ${(data.competitions || []).length === 0 ? `
      <div class="flash">No competitions running. Start one — make this interesting.</div>
    ` : data.competitions.map(renderCompetition).join('')}

    <div class="section-title" id="new">Create a competition</div>
    <form class="competition-card" id="new-form">
      <p class="text-muted text-small">Set a name, a date range, and how the scoring works. Team mode = two crews share a bag.</p>
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
      <div style="display:flex; gap:14px; margin-top:10px">
        <div style="flex:1">
          <label>Mode</label>
          <select name="mode">
            <option value="full_portfolio">Full portfolio (whatever they trade)</option>
            <option value="assigned_picks">Assigned picks (specific stocks only)</option>
          </select>
        </div>
        <div style="flex:1">
          <label>Type</label>
          <select name="type">
            <option value="individual">Individual</option>
            <option value="team">Team</option>
          </select>
        </div>
      </div>
      <div style="margin-top:14px">
        <button type="submit" class="btn">Start it 🔥</button>
        <span class="text-muted text-small">(comp engine ships in the next pass — this form will hook up then.)</span>
      </div>
    </form>
  `;

  document.getElementById('new-form').addEventListener('submit', (e) => {
    e.preventDefault();
    alert('Comp engine coming online — saved for the next iteration.');
  });
})();

function renderCompetition(c) {
  const verdict = (() => {
    if (!c.ranks || !c.ranks.length) return 'No ranks yet — nothing has happened.';
    const top = c.ranks[0];
    return `Leader: ${top.label || top.code} → ${(top.pct ?? 0).toFixed(1)}%`;
  })();
  return `
    <div class="competition-card">
      <h3>${c.name}</h3>
      <div class="meta">${c.start_date} → ${c.end_date} · <span class="tag">${c.type}</span> <span class="tag">${c.mode}</span></div>
      <div>${verdict}</div>
      <div class="actions">
        <a class="btn small" href="/presentation.html?competition=${c.id}">Run presentation</a>
        <a class="btn small ghost" href="/competition.html?id=${c.id}">Details</a>
      </div>
    </div>
  `;
}
