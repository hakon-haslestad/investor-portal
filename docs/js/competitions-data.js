// Read/write the Competitions / Competition_Participants / Competition_Picks tabs.
// Each tab is keyed by its first column(s).

(function () {
  const T = window.PORTAL_CONFIG.TABS;

  // ─── Read all three tabs in parallel ──────────────────────────────────────

  async function listCompetitions() {
    const sheets = await window.Sheet.batchGet([T.competitions, T.participants, T.picks]);
    const compRows = sheets[T.competitions] || [];
    const partRows = sheets[T.participants] || [];
    const pickRows = sheets[T.picks] || [];

    const competitions = parseCompetitions(compRows);
    const participantsByComp = groupParticipants(partRows);
    const picksByComp = groupPicks(pickRows);

    return competitions.map((c) => ({
      competition: c,
      participants: participantsByComp.get(c.id) || [],
      picks: picksByComp.get(c.id) || [],
    }));
  }

  async function getCompetition(id) {
    const all = await listCompetitions();
    return all.find((c) => c.competition.id === id) || null;
  }

  // ─── Writes ───────────────────────────────────────────────────────────────

  // Create a competition.
  //
  // teams: [{ label: 'JC+ØS', amount: 50000, members: ['JC', 'ØS'] }, ...]
  //   Each member becomes a Competition_Participants row with team_label=label
  //   and buy_in_nok=amount.
  // Legacy `participants` shape (flat list of investor rows) is still accepted.
  async function createCompetition({ name, description, start_date, end_date, teams = [], participants = [], narrative }) {
    const id = newId();
    const now = new Date().toISOString();
    const compRow = [
      id, name, description || '',
      '', '', '', // type / mode / metric — kept for sheet compat, no longer used
      start_date || '', end_date || '',
      narrative ? JSON.stringify(narrative) : '',
      window.Auth.getEmail() || '',
      now,
    ];
    await window.Sheet.appendRow(T.competitions, compRow);

    // Expand teams[] → participant rows
    const rows = [];
    for (const t of teams) {
      if (!t || !t.members || !t.members.length) continue;
      for (const code of t.members) {
        rows.push({
          investor_code: code,
          team_label: t.label || code,
          buy_in_nok: Number(t.amount) || 0,
        });
      }
    }
    for (const p of participants) rows.push(p); // legacy

    for (const p of rows) {
      await window.Sheet.appendRow(T.participants, [
        id, p.investor_code, p.team_label || '', p.buy_in_nok || 0,
      ]);
    }
    return id;
  }

  async function deleteCompetition(id) {
    // We can't easily delete rows mid-sheet via values.update without batchUpdate
    // (which requires sheetId not range). Easier UX: blank out the Id cell so it
    // stops appearing. The user can manually delete the row in the sheet if they
    // want a clean removal.
    const compRows = await window.Sheet.getValues(T.competitions);
    let targetRow = -1;
    for (let i = 1; i < compRows.length; i++) {
      if ((compRows[i][0] || '').toString().trim() === id) { targetRow = i + 1; break; }
    }
    if (targetRow < 0) throw new Error('Competition not found in sheet');
    // Overwrite Id column with empty so listCompetitions skips this row.
    await window.Sheet.updateRow(T.competitions, targetRow, ['']);
    return true;
  }

  // ─── Parsers (internal) ──────────────────────────────────────────────────

  function parseCompetitions(rows) {
    if (!rows.length) return [];
    const header = rows[0].map((h) => String(h || '').trim());
    const idx = {
      id: header.indexOf('Id'),
      name: header.indexOf('Name'),
      desc: header.indexOf('Description'),
      type: header.indexOf('Type'),
      mode: header.indexOf('Mode'),
      metric: header.indexOf('Metric'),
      start: header.indexOf('StartDate'),
      end: header.indexOf('EndDate'),
      narrative: header.indexOf('NarrativeJson'),
      createdBy: header.indexOf('CreatedBy'),
      createdAt: header.indexOf('CreatedAt'),
    };
    const out = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const id = (r[idx.id] || '').toString().trim();
      if (!id) continue;
      out.push({
        id,
        name: r[idx.name] || '',
        description: r[idx.desc] || '',
        type: r[idx.type] || 'individual',
        mode: r[idx.mode] || 'full_portfolio',
        metric: r[idx.metric] || 'return_pct',
        start_date: window.Parsers.excelDateToISO(r[idx.start]) || (r[idx.start] || ''),
        end_date: window.Parsers.excelDateToISO(r[idx.end]) || (r[idx.end] || ''),
        narrative_json: r[idx.narrative] || '',
        created_by: r[idx.createdBy] || '',
        created_at: r[idx.createdAt] || '',
      });
    }
    return out;
  }

  function groupParticipants(rows) {
    const map = new Map();
    if (!rows.length) return map;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const compId = (r[0] || '').toString().trim();
      if (!compId) continue;
      if (!map.has(compId)) map.set(compId, []);
      map.get(compId).push({
        investor_code: (r[1] || '').toString().trim(),
        team_label: (r[2] || '').toString().trim() || null,
        buy_in_nok: window.Parsers.numOrNull(r[3]) || 0,
      });
    }
    return map;
  }

  function groupPicks(rows) {
    const map = new Map();
    if (!rows.length) return map;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const compId = (r[0] || '').toString().trim();
      if (!compId) continue;
      if (!map.has(compId)) map.set(compId, []);
      map.get(compId).push({
        investor_code: (r[1] || '').toString().trim(),
        security: (r[2] || '').toString().trim(),
        isin: (r[3] || '').toString().trim() || null,
        label: (r[4] || '').toString().trim() || null,
      });
    }
    return map;
  }

  function newId() {
    // c_ + 6 base36 chars from random + time bits — collision-free for 5 users.
    const r = Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0');
    const t = (Date.now() % (36 ** 2)).toString(36).padStart(2, '0');
    return `c_${r}${t}`;
  }

  window.CompetitionsData = { listCompetitions, getCompetition, createCompetition, deleteCompetition };
})();
