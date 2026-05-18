const express = require('express');
const { buildDashboard, investorDetail } = require('../portfolio/calculator');
const { buildTimeline } = require('../portfolio/timeline');
const copy = require('../copy');

const router = express.Router();

router.get('/dashboard', (req, res) => {
  const { preset, from, to } = req.query;
  const opts = {};
  if (from && to) {
    opts.from = String(from);
    opts.to = String(to);
    opts.preset = 'custom';
  } else if (preset) {
    opts.preset = String(preset);
  }
  const dashboard = buildDashboard(opts);
  res.json({ ...dashboard, names: copy.NAMES });
});

router.get('/dashboard/timeline', (req, res) => {
  const { from, to } = req.query;
  const timeline = buildTimeline({
    from: from ? String(from) : undefined,
    to: to ? String(to) : undefined,
  });
  res.json({ ...timeline, names: copy.NAMES });
});

router.get('/investor/:code', (req, res) => {
  const code = req.params.code;
  const detail = investorDetail(code);
  if (!detail) return res.status(404).json({ error: 'unknown_investor' });
  res.json({ ...detail, displayName: copy.NAMES[code] || code });
});

module.exports = router;
