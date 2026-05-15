// Shared chrome: nav bar + page-level auth gate.

(function () {
  function buildNav(active, displayName) {
    return `
      <nav class="nav">
        <h1>Geysir Invest AS</h1>
        <div class="links">
          <a href="./index.html" class="${active === 'home' ? 'active' : ''}">Dashboard</a>
          <a href="./competitions.html" class="${active === 'comp' ? 'active' : ''}">Competitions</a>
          <a href="./data.html" class="${active === 'data' ? 'active' : ''}">Data</a>
          <a href="./admin.html" class="${active === 'admin' ? 'active' : ''}">Admin</a>
        </div>
        <div class="who">
          ${displayName || ''} · <a href="#" id="nav-signout">Bounce</a>
        </div>
      </nav>
    `;
  }

  // Guards a page: ensure access token, hydrate sheet, look up Member.
  // If not authed → redirect to login. If authed but not in Members → "not authorized".
  async function bootstrap(active, opts = {}) {
    if (!window.GEYSIR_CONFIG || window.GEYSIR_CONFIG.OAUTH_CLIENT_ID.startsWith('__REPLACE')) {
      document.body.innerHTML =
        '<div class="container"><div class="flash error">Setup needed: edit <code>js/config.js</code> with your OAuth Client ID.</div></div>';
      throw new Error('config not set');
    }
    try {
      await window.Auth.ensureToken();
    } catch (_e) {
      location.href = './login.html';
      throw _e;
    }
    if (!window.Auth.getEmail()) {
      try {
        await window.Auth.signIn();
      } catch (_e) {
        location.href = './login.html';
        throw _e;
      }
    }
    const store = await window.Store.hydrate(opts);
    const me = window.Store.whoami(store);
    if (!me) {
      document.body.innerHTML = `
        <div class="container">
          <div class="flash error" style="max-width:520px;margin:80px auto">
            <strong>Not authorized.</strong> Your Google account
            (${window.Auth.getEmail() || 'unknown'}) is not in the Members tab of the Geysir sheet.
            Ask an admin to add you, then <a href="#" onclick="window.Auth.signOut().then(()=>location.reload())">sign out</a> and try again.
          </div>
        </div>`;
      throw new Error('not_a_member');
    }
    const mount = document.getElementById('nav-mount');
    if (mount) {
      mount.innerHTML = buildNav(active, me.displayName);
      document.getElementById('nav-signout').addEventListener('click', async (e) => {
        e.preventDefault();
        await window.Auth.signOut();
        location.href = './login.html';
      });
    }
    return { store, me };
  }

  window.Nav = { buildNav, bootstrap };
})();
