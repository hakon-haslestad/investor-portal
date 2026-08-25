// SPA boot: config check → auth gate → hydrate → mount nav → start router.

(function () {
  const gate = () => document.getElementById('auth-gate');
  const shell = () => document.getElementById('shell');

  function showGate(html) {
    shell().hidden = true;
    gate().hidden = false;
    gate().querySelector('#gate-status').innerHTML = html || '';
  }

  // Visible boot trace — every startup step logs to the gate so a failing
  // sign-in names its failing step on screen instead of dying silently.
  const steps = [];
  function trace(msg) {
    steps.push(msg);
    console.log('[boot]', msg);
    const el = gate().querySelector('#gate-status');
    if (el) {
      el.innerHTML = `<div class="text-small text-muted" style="text-align:left">${steps.map(window.UI.esc).join('<br>')}</div>`;
    }
  }
  function traceFail(msg, e) {
    console.error('[boot]', msg, e);
    steps.push(`✗ ${msg}: ${(e && e.message) || e}`);
    showGate(`<div class="flash error" style="text-align:left">${steps.map(window.UI.esc).join('<br>')}</div>`);
  }

  function buildNav(me) {
    const links = window.Router.ROUTES
      .filter((r) => !r.adminOnly || me.role === 'admin')
      .map((r) => `<a href="#/${r.match}" data-route="${r.match}">${r.label}${r.badge ? `<sup class="nav-badge">${r.badge}</sup>` : ''}</a>`)
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
    trace('loading sheet data…');
    const store = await window.Store.hydrate();
    trace(`sheet loaded: ${store.transactions.length} transactions, ${store.members.length} members, ${store.prices.dates.length} price rows`);
    const me = window.Store.whoami(store);
    trace(me ? `member matched: ${me.investorCode} (${me.role})` : `no member match for ${window.Auth.getEmail() || '(no email)'}`);
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
    trace('entering app');
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
    const consumed = window.Auth.consumeRedirectToken();
    trace(consumed ? 'OAuth redirect token consumed ✓' : 'no OAuth fragment in URL');
    // Auto-login from the stored session; email via the userinfo endpoint.
    try {
      await window.Auth.ensureToken();
      trace('stored token valid ✓');
    } catch (e) {
      trace(`no stored session (${(e && e.message) || e}) — click Sign in`);
      return;
    }
    try {
      await window.Auth.ensureEmail();
      trace(`email resolved: ${window.Auth.getEmail()}`);
    } catch (e) {
      traceFail('resolving email (userinfo) failed', e);
      return;
    }
    try {
      await enter();
    } catch (e) {
      traceFail('loading the app failed', e);
    }
  }

  // Any uncaught failure during boot lands in the on-screen trace too.
  window.addEventListener('error', (e) => {
    if (!gate().hidden) traceFail('uncaught error', e.error || e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    if (!gate().hidden) traceFail('unhandled rejection', e.reason);
  });

  document.addEventListener('DOMContentLoaded', () => {
    window.UI.enableInfoPopovers();
    boot();
  });
})();
