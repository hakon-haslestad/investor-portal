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
  async function createCompetition({ name, start_date, end_date, teams = [], participants = [] }) {
    const id = newId();
    const now = new Date().toISOString();
    // Column order must match the Competitions tab header:
    // Id | Name | StartDate | EndDate | CreatedBy | CreatedAt
    const compRow = [
      id, name,
      start_date || '', end_date || '',
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

  // Hard-delete a competition and cascade to its participant and pick rows.
  // The competition is keyed by Id (column A) in Competitions; participants and
  // picks reference it by competition id in their column A.
  async function deleteCompetition(id) {
    const sheets = await window.Sheet.batchGet([T.competitions, T.participants, T.picks]);

    // Sheet row index = array index + 1 (row 0 is the header).
    const rowsMatching = (rows) => {
      const out = [];
      for (let i = 1; i < (rows || []).length; i++) {
        if (((rows[i][0] || '').toString().trim()) === id) out.push(i + 1);
      }
      return out;
    };

    const compRowIdx = rowsMatching(sheets[T.competitions]);
    if (!compRowIdx.length) throw new Error('Competition not found in sheet');

    await window.Sheet.deleteRows(T.competitions, compRowIdx);
    await window.Sheet.deleteRows(T.participants, rowsMatching(sheets[T.participants]));
    await window.Sheet.deleteRows(T.picks, rowsMatching(sheets[T.picks]));
    return true;
  }

  // ─── Parsers (internal) ──────────────────────────────────────────────────

  function parseCompetitions(rows) {
    if (!rows.length) return [];
    const header = rows[0].map((h) => String(h || '').trim());
    const idx = {
      id: header.indexOf('Id'),
      name: header.indexOf('Name'),
      start: header.indexOf('StartDate'),
      end: header.indexOf('EndDate'),
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
        start_date: window.Parsers.excelDateToISO(r[idx.start]) || (r[idx.start] || ''),
        end_date: window.Parsers.excelDateToISO(r[idx.end]) || (r[idx.end] || ''),
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
