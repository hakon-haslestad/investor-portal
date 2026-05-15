const bcrypt = require('bcryptjs');
const session = require('express-session');
const db = require('./db');

const SALT_ROUNDS = 10;

const findUserByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const findUserByCode = db.prepare('SELECT * FROM users WHERE investor_code = ?');
const insertUser = db.prepare(`
  INSERT INTO users (email, password_hash, investor_code, display_name)
  VALUES (?, ?, ?, ?)
`);
const updateUserPassword = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
const updateUserEmail = db.prepare('UPDATE users SET email = ? WHERE id = ?');

async function createUser({ email, password, investorCode, displayName }) {
  const existing = findUserByEmail.get(email) || findUserByCode.get(investorCode);
  if (existing) {
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    updateUserPassword.run(hash, existing.id);
    if (existing.email !== email) updateUserEmail.run(email, existing.id);
    return { id: existing.id, updated: true };
  }
  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  const info = insertUser.run(email, hash, investorCode, displayName);
  return { id: info.lastInsertRowid, updated: false };
}

async function verifyLogin(email, password) {
  const user = findUserByEmail.get(email);
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return null;
  return {
    id: user.id,
    email: user.email,
    investorCode: user.investor_code,
    displayName: user.display_name,
  };
}

function sessionMiddleware() {
  return session({
    name: 'geysir.sid',
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
    },
  });
}

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'not_logged_in' });
  }
  return res.redirect('/login.html');
}

module.exports = {
  createUser,
  verifyLogin,
  sessionMiddleware,
  requireAuth,
};
