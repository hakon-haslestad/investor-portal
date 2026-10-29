// SPA boot: config check → auth gate → hydrate → mount nav → start router.

(function () {
  const gate = () => document.getElementById('auth-gate');
  const shell = () => document.getElementById('shell');

  function showGate(html) {
    shell().hidden = true;
    gate().hidden = false;
    gate().querySelector('#gate-status').innerHTML = html || '';
  }

  // The boot steps are for developers: plain words on screen, the full trace
  // only with ?debug=1 (always in the console).
  const DEBUG = /[?&]debug=1\b/.test(location.search);
  const steps = [];
  function trace(msg) {
    steps.push(msg);
    console.log('[boot]', msg);
    if (DEBUG) {
      const el = gate().querySelector('#gate-status');
      if (el) el.innerHTML = `<div class="text-small text-muted" style="text-align:left">${steps.map(window.UI.esc).join('<br>')}</div>`;
    }
  }
  // What the person sees while loading: one plain line.
  function progress(line) {
    gate().querySelector('#gate-signin').hidden = true;
    if (!DEBUG) showGate(`<div class="text-muted">${window.UI.esc(line)}</div>${window.UI.skeleton('block')}`);
  }
  function traceFail(msg, e) {
    console.error('[boot]', msg, e);
    steps.push(`✗ ${msg}: ${(e && e.message) || e}`);
    gate().querySelector('#gate-signin').hidden = true;
    if (window.UI.isSessionExpired(e)) {
      showGate(window.UI.loadError(e));
    } else if (DEBUG) {
      showGate(`<div class="flash error" style="text-align:left">${steps.map(window.UI.esc).join('<br>')}</div>`);
    } else {
      showGate(window.UI.loadError(e, 'the sheet'));
    }
  }

  function buildNav(me) {
    const groups = window.Router.groupsFor(me.role);
    document.getElementById('top-nav').innerHTML = groups
      .map((g) => `<a href="${g.href}" data-group="${g.id}">${g.label}</a>`).join('');
    // Second row: one block per group with several entries; the router shows the active one.
    document.getElementById('sub-nav').innerHTML = groups.filter((g) => g.entries.length > 1)
      .map((g) => `<div class="subnav-group" data-group-entries="${g.id}" hidden>${g.entries
        .map((e) => `<a href="${e.href}" data-route="${e.match}">${e.label}${e.badge ? `<sup class="nav-badge">${e.badge}</sup>` : ''}</a>`).join('')}</div>`).join('');
    // Keep a keyboard-focused second-row link in view when the row scrolls (320 px).
    document.getElementById('sub-nav').addEventListener('focusin', (e) => {
      if (e.target.scrollIntoView) e.target.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    });
    const who = document.getElementById('nav-who');
    who.innerHTML = `${window.UI.esc(me.displayName || me.investorCode || '')} · <button type="button" id="nav-signout" class="link-btn">Bounce</button>`;
    document.getElementById('nav-signout').addEventListener('click', async (e) => {
      e.preventDefault();
      await window.Auth.signOut();
      location.reload();
    });
  }

  async function enter() {
    trace('loading sheet data…');
    progress('Loading members, transactions and prices…');
    const store = await window.Store.hydrate();
    trace(`sheet loaded: ${store.transactions.length} transactions, ${store.members.length} members, ${store.prices.dates.length} price rows`);
    for (const w of store.warnings || []) {
      console.warn('[boot] ' + w);
      const b = document.getElementById('data-banner');
      if (b) { b.textContent = `${w} The portal shows no transactions until it is fixed in the sheet.`; b.hidden = false; }
    }
    progress('Checking your membership…');
    const me = window.Store.whoami(store);
    trace(me ? `member matched: ${me.investorCode} (${me.role})` : `no member match for ${window.Auth.getEmail() || '(no email)'}`);
    if (!me) {
      showGate(`
        <div class="flash error" style="text-align:left">
          <strong>Not authorized.</strong> Your Google account
          (${window.UI.esc(window.Auth.getEmail() || 'unknown')}) is not in the Members tab of the portal sheet.
          Ask an admin to add you, then <button type="button" class="link-btn" id="gate-signout">sign out</button> and try again.
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

  // A phone that already joined a room plays on its room pass alone — no
  // Google token, no sheet download. The OAuth token lives about an hour with
  // no refresh, and the tab can be evicted at any time; without this a player
  // is thrown back to the sign-in screen mid-game and loses the room.
  //
  // The pass proves nothing except "this device joined that room as that
  // member", so this path can only ever reach the play board.
  async function bootPlayerIfResumable() {
    if (!/^#\/play\b/.test(location.hash || '')) return false;
    if (!window.GameRoom || !window.GameRoom.configured()) return false;
    if (!window.GameRoom.savedSession()) return false;
    let room = null;
    try { room = await window.GameRoom.resume(); } catch (_e) { return false; }
    if (!room) return false;
    gate().hidden = true;
    shell().hidden = false;
    document.getElementById('top-nav').innerHTML = '';
    document.getElementById('sub-nav').innerHTML = '';
    document.getElementById('nav-who').innerHTML =
      `${window.UI.esc(room.member)} · <a href="#" id="nav-leave">Leave</a>`;
    document.getElementById('nav-leave').addEventListener('click', (e) => {
      e.preventDefault();
      room.close(); room.forget(); location.hash = '#/play'; location.reload();
    });
    window.Views.playResumed(document.getElementById('view'), room);
    return true;
  }

  // Buttons in error boxes and the session banner (data-act), wired once.
  // "Try again" re-runs the current view, or the whole boot when still at the gate.
  function wireErrorActions() {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest && e.target.closest('[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'sign-in-again') {
        e.preventDefault();
        window.Auth.signInAgain();
      } else if (btn.dataset.act === 'retry') {
        e.preventDefault();
        if (gate().hidden) window.Router.reload();
        else location.reload();
      }
    });
    // The Sheets client says so when a token ends mid-session; a view that is
    // already on screen keeps its numbers and gets this banner.
    window.addEventListener('portal:session-expired', () => {
      const b = document.getElementById('session-banner');
      if (b) b.hidden = false;
    });
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
      window.Auth.signIn(/^#\//.test(location.hash) ? location.hash : '');
    });
    wireErrorActions();
    // Returning from the OAuth redirect? Consume #access_token before the
    // router ever sees the hash.
    const consumed = window.Auth.consumeRedirectToken();
    trace(consumed ? 'OAuth redirect token consumed ✓' : 'no OAuth fragment in URL');
    // Before anything that needs a token or the sheet.
    if (await bootPlayerIfResumable()) return;
    // Auto-login from the stored session; email via the userinfo endpoint.
    try {
      await window.Auth.ensureToken();
      trace('stored token valid ✓');
    } catch (e) {
      trace(`no stored session (${(e && e.message) || e}) — click Sign in`);
      gate().querySelector('#gate-signin').hidden = false;
      if (window.Auth.hasExpiredSession && window.Auth.hasExpiredSession()) {
        showGate('<div class="flash error"><strong>Your session expired.</strong> Sign in again to keep going.</div>');
      }
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
