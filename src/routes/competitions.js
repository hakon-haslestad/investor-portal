const express = require('express');
const {
  listCompetitions,
  getCompetition,
  createCompetition,
  deleteCompetition,
} = require('../competitions/engine');
const { buildPresentation } = require('../competitions/presentation');

const router = express.Router();

router.get('/', (_req, res) => {
  const all = listCompetitions();
  // Return a compact shape for the list view
  res.json({
    competitions: all.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      type: c.type,
      mode: c.mode,
      start_date: c.start_date,
      end_date: c.end_date,
      ranks: c._scored.ranks.map((r) => ({
        code: r.code,
        teamLabel: r.teamLabel,
        pct: r.pct,
        netPnl: r.netPnl,
      })),
      teams: c._scored.teams,
    })),
  });
});

router.post('/', (req, res) => {
  try {
    const id = createCompetition(req.body || {});
    res.json({ id, ok: true });
  } catch (err) {
    res.status(400).json({ error: 'bad_request', message: err.message });
  }
});

router.get('/:id', (req, res) => {
  const c = getCompetition(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'not_found' });
  res.json(c);
});

router.delete('/:id', (req, res) => {
  const info = deleteCompetition(Number(req.params.id));
  res.json({ deleted: info.changes });
});

router.get('/:id/presentation', (req, res) => {
  const c = getCompetition(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'not_found' });
  res.json(buildPresentation(c));
});

module.exports = router;
