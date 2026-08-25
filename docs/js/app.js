// SPA boot: config check → auth gate → hydrate → mount nav → start router.

(function () {
  const gate = () => document.getElementById('auth-gate');
  const shell = () => document.getElementById('shell');

  function showGate(html) {
    shell().hidden = true;
    gate().hidden = false;
    gate().querySelector('#gate-status').innerHTML = html || '';
  }

  function buildNav(me) {
    const links = window.Router.ROUTES
      .filter((r) => !r.adminOnly || me.role === 'admin')
      .map((r) => `<a href="#/${r.match}" data-route="${r.match}">${r.label}</a>`)
      .join('');
    document.getElementById('top-nav').innerHTML = links;
    const who = document.getElementById('nav-who');
    who.innerHTML = `${window.UI.esc(me.displayName || me.investorCode || '')} · <a href="#" id="nav-signout">Bounce</a>`;
    document.getElementById('nav-signout').addEventListener('click', async (e) => {
      e.preventDefault();
      await window.Auth.signOut();
      location.reload();
    });
  }

  async function enter() {
    const store = await window.Store.hydrate();
    const me = window.Store.whoami(store);
    if (!me) {
      showGate(`
        <div class="flash error" style="text-align:left">
          <strong>Not authorized.</strong> Your Google account
          (${window.UI.esc(window.Auth.getEmail() || 'unknown')}) is not in the Members tab of the portal sheet.
          Ask an admin to add you, then <a href="#" id="gate-signout">sign out</a> and try again.
        </div>`);
      document.getElementById('gate-signout').addEventListener('click', async (e) => {
        e.preventDefault(); await window.Auth.signOut(); location.reload();
      });
      return;
    }
    gate().hidden = true;
    shell().hidden = false;
    buildNav(me);
    window.Router.start({ store, me });
  }

  async function boot() {
    if (!window.PORTAL_CONFIG || window.PORTAL_CONFIG.OAUTH_CLIENT_ID.startsWith('__REPLACE')) {
      showGate('<div class="flash error"><strong>Setup needed:</strong> edit <code>js/config.js</code> with your OAuth Client ID.</div>');
      document.getElementById('gate-signin').disabled = true;
      return;
    }
    document.getElementById('gate-signin').addEventListener('click', async () => {
      try {
        showGate('Authorizing…');
        await window.Auth.signIn();
        showGate('Loading portfolio…');
        await enter();
      } catch (e) {
        showGate(`<div class="flash error">Sign-in failed: <code>${window.UI.esc(e.message)}</code></div>`);
      }
    });
    try {
      await window.Auth.ensureToken();
      if (!window.Auth.getEmail()) await window.Auth.signIn();
      showGate('Loading portfolio…');
      await enter();
    } catch (_e) {
      // Not signed in — the gate with its button is already visible.
      showGate('');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    window.UI.enableInfoPopovers();
    boot();
  });
})();
