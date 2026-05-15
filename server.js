require('dotenv').config();
const path = require('path');
const express = require('express');
const { sessionMiddleware, requireAuth } = require('./src/auth');

const PORT = Number(process.env.PORT || 3000);
const app = express();

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware());

// Public assets — login page is reachable without auth
app.use('/login.html', express.static(path.join(__dirname, 'public', 'login.html')));
app.use('/css', express.static(path.join(__dirname, 'public', 'css')));
app.use('/js', express.static(path.join(__dirname, 'public', 'js')));

// Auth routes (login/logout/me) are public
app.use('/api', require('./src/routes/auth'));

// Health check
app.get('/health', (_req, res) => res.json({ ok: true }));

// Gate everything else behind auth
app.use((req, res, next) => {
  if (req.path === '/login.html') return next();
  return requireAuth(req, res, next);
});

// Protected API
app.use('/api', require('./src/routes/dashboard'));
app.use('/api/competitions', require('./src/routes/competitions'));
app.use('/api/admin', require('./src/routes/admin'));
app.use('/api/data', require('./src/routes/data'));

// Protected static pages
app.use(express.static(path.join(__dirname, 'public')));

// Root → dashboard if logged in, login page otherwise
app.get('/', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/index.html');
  return res.redirect('/login.html');
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error', message: err.message });
});

app.listen(PORT, () => {
  console.log(`Geysir Portal up on http://localhost:${PORT}`);
});
