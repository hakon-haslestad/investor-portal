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
    document.getElementById('gate-signin').addEventListener('click', () => {
      // Redirect flow: full-page navigation to Google and back — no popup,
      // nothing for the browser to block.
      showGate('Redirecting to Google…');
      window.Auth.signIn();
    });
    // Returning from the OAuth redirect? Consume #access_token before the
    // router ever sees the hash.
    window.Auth.consumeRedirectToken();
    // Auto-login from the stored session; email via the userinfo endpoint.
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
