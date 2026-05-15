const express = require('express');
const { verifyLogin } = require('../auth');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'missing_credentials' });
  const user = await verifyLogin(email.trim().toLowerCase(), password);
  if (!user) return res.status(401).json({ error: 'bad_credentials' });
  req.session.user = user;
  res.json({ user });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'not_logged_in' });
  res.json({ user: req.session.user });
});

module.exports = router;
