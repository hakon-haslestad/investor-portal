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
        console.error('sign-in failed', e);
        showGate(`<div class="flash error">Sign-in failed: <code>${window.UI.esc(e.message)}</code><br>
          <span class="text-small">If a popup was blocked, allow popups for this site and try again.</span></div>`);
      }
    });
    // Silent auto-login: token via GIS silent flow, email via the userinfo
    // endpoint (NEVER an interactive popup here — without a user gesture the
    // browser blocks it and the login dead-ends at the gate).
    try {
      await window.Auth.ensureToken();
      await window.Auth.ensureEmail();
    } catch (e) {
      // Genuinely not signed in — wait for the button click.
      showGate('');
      return;
    }
    try {
      showGate('Loading portfolio…');
      await enter();
    } catch (e) {
      // Signed in but loading failed — surface the real error instead of
      // silently bouncing back to the sign-in button.
      console.error('load failed', e);
      showGate(`<div class="flash error" style="text-align:left"><strong>Signed in, but loading the sheet failed.</strong><br>
        <code>${window.UI.esc((e && e.message) || String(e))}</code><br>
        <span class="text-small">Try the button above to re-authorize, or check the browser console.</span></div>`);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    window.UI.enableInfoPopovers();
    boot();
  });
})();
