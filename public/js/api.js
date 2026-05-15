async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (res.status === 401) {
    location.href = '/login.html';
    return null;
  }
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`);
  return res.json();
}

async function logout() {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login.html';
}

function fmtNok(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Math.round(Number(n));
  return v.toLocaleString('nb-NO') + ' kr';
}

function fmtPct(n, sign = true) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  const s = sign && v > 0 ? '+' : '';
  return s + v.toFixed(1) + '%';
}

function fmtQty(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  if (Math.abs(v) < 1) return v.toFixed(2);
  return Math.round(v).toLocaleString('nb-NO');
}

function pctClass(n) {
  if (n == null || !Number.isFinite(Number(n))) return 'text-muted';
  const v = Number(n);
  if (v > 0.5) return 'positive';
  if (v < -0.5) return 'negative';
  return 'text-muted';
}

const PODIUM = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];

function buildNav(active, displayName) {
  return `
    <nav class="nav">
      <h1>Geysir Invest AS</h1>
      <div class="links">
        <a href="/index.html" class="${active === 'home' ? 'active' : ''}">Dashboard</a>
        <a href="/competitions.html" class="${active === 'comp' ? 'active' : ''}">Comps</a>
        <a href="/admin.html" class="${active === 'admin' ? 'active' : ''}">Admin</a>
      </div>
      <div class="who">
        ${displayName || ''} · <a href="#" onclick="logout(); return false;">Bounce</a>
      </div>
    </nav>
  `;
}

async function fetchMe() {
  const r = await fetch('/api/me');
  if (!r.ok) {
    location.href = '/login.html';
    return null;
  }
  const j = await r.json();
  return j.user;
}
