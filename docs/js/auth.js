// Google Identity Services Token Client wrapper.
// Issues access tokens (~1h TTL, no refresh tokens — that's normal for browser flows).
// Re-auth on reload is silent if the user has an active Google session and previously consented.

(function () {
  const STORAGE_KEY = 'portal.token';
  // (token clients are created per-request — see requestToken)
  let cachedToken = null;
  let cachedEmail = null;

  function loadCachedToken() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed.access_token || !parsed.expires_at) return null;
      if (Date.now() >= parsed.expires_at - 60_000) return null;
      // Drop tokens that don't cover the currently configured scopes
      // (so changing config.js OAUTH_SCOPE invalidates stale tokens).
      const needed = (window.PORTAL_CONFIG.OAUTH_SCOPE || '').split(/\s+/).filter(Boolean);
      const have = (parsed.scope || '').split(/\s+/).filter(Boolean);
      const missing = needed.filter((s) => !have.includes(s));
      if (missing.length) {
        sessionStorage.removeItem(STORAGE_KEY);
        sessionStorage.removeItem('portal.email');
        return null;
      }
      return parsed;
    } catch (_e) { return null; }
  }

  function storeToken(tok) {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(tok));
    cachedToken = tok;
  }

  function clearToken() {
    sessionStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem('portal.email');
    cachedToken = null;
    cachedEmail = null;
  }

  function waitForGis() {
    return new Promise((resolve) => {
      if (window.google && window.google.accounts && window.google.accounts.oauth2) return resolve();
      const t = setInterval(() => {
        if (window.google && window.google.accounts && window.google.accounts.oauth2) {
          clearInterval(t); resolve();
        }
      }, 50);
    });
  }

  // One FRESH GIS token client per request. Reusing a client after a
  // blocked/abandoned popup poisons it: the next requestAccessToken routes
  // its response to the stale internal request and the promise hangs
  // forever — exactly the "sign in and land back at the gate" loop.
  // error_callback catches popup-blocked/closed so callers get a rejection
  // instead of a hang.
  function requestToken({ silent, scope }) {
    const requestScope = scope || window.PORTAL_CONFIG.OAUTH_SCOPE;
    return new Promise((resolve, reject) => {
      waitForGis().then(() => {
        let settled = false;
        const client = window.google.accounts.oauth2.initTokenClient({
          client_id: window.PORTAL_CONFIG.OAUTH_CLIENT_ID,
          scope: requestScope,
          callback: (resp) => {
            if (settled) return;
            settled = true;
            if (resp.error) return reject(new Error(resp.error_description || resp.error));
            const tok = {
              access_token: resp.access_token,
              expires_at: Date.now() + (Number(resp.expires_in || 3600) * 1000),
              scope: resp.scope,
            };
            storeToken(tok);
            resolve(tok);
          },
          error_callback: (err) => {
            if (settled) return;
            settled = true;
            reject(new Error((err && (err.message || err.type)) || 'popup failed'));
          },
        });
        client.requestAccessToken({ prompt: silent ? '' : 'consent' });
      }).catch(reject);
    });
  }

  function tokenHasScope(tok, scopeString) {
    if (!tok) return false;
    const have = (tok.scope || '').split(/\s+/).filter(Boolean);
    const want = (scopeString || '').split(/\s+/).filter(Boolean);
    return want.every((s) => have.includes(s));
  }

  async function fetchUserInfo(accessToken) {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + accessToken },
    });
    if (!r.ok) throw new Error('userinfo failed: ' + r.status);
    const j = await r.json();
    sessionStorage.setItem('portal.email', j.email || '');
    cachedEmail = j.email || null;
    return j;
  }

  // ── Redirect-based sign-in ─────────────────────────────────────────────
  // The GIS popup flow proved unreliable (COOP/popup-relay breakage leaves
  // the promise hanging with no callback). The classic implicit redirect
  // flow has no popup at all: navigate to Google, come back with the token
  // in the URL fragment. Requires this page's URL to be listed under
  // "Authorized redirect URIs" on the OAuth client.
  function redirectUri() {
    return location.origin + location.pathname;
  }

  function signInRedirect() {
    const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem('portal.oauth_state', state);
    const params = new URLSearchParams({
      client_id: window.PORTAL_CONFIG.OAUTH_CLIENT_ID,
      redirect_uri: redirectUri(),
      response_type: 'token',
      scope: window.PORTAL_CONFIG.OAUTH_SCOPE,
      include_granted_scopes: 'true',
      state,
      prompt: 'select_account',
    });
    location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + params);
  }

  // Parse a returning OAuth fragment (#access_token=…). Returns true when a
  // token was consumed; cleans the fragment either way so the hash router
  // never sees it. Call BEFORE the router starts.
  function consumeRedirectToken() {
    const h = location.hash || '';
    if (!h.includes('access_token=')) return false;
    const p = new URLSearchParams(h.replace(/^#/, ''));
    const expected = sessionStorage.getItem('portal.oauth_state');
    sessionStorage.removeItem('portal.oauth_state');
    const ok = p.get('access_token') && (!expected || p.get('state') === expected);
    if (ok) {
      storeToken({
        access_token: p.get('access_token'),
        expires_at: Date.now() + (Number(p.get('expires_in') || 3600) * 1000),
        scope: p.get('scope') || window.PORTAL_CONFIG.OAUTH_SCOPE,
      });
    }
    history.replaceState(null, '', location.pathname + location.search);
    return !!ok;
  }

  // Public API
  window.Auth = {
    // Redirect flow — full-page navigation, no popup. The page reloads on
    // return and consumeRedirectToken() picks the token up at boot.
    signIn() {
      signInRedirect();
      // Never resolves — the browser is navigating away.
      return new Promise(() => {});
    },

    consumeRedirectToken,

    async ensureToken() {
      const t = loadCachedToken();
      if (t) {
        cachedToken = t;
        return t;
      }
      // No stored session → don't touch GIS here. A token request always
      // opens a popup, and without a user gesture the browser blocks it —
      // the caller should show the sign-in button instead.
      throw new Error('not signed in');
    },

    async signOut() {
      const tok = loadCachedToken();
      clearToken();
      if (tok && window.google && window.google.accounts && window.google.accounts.oauth2) {
        window.google.accounts.oauth2.revoke(tok.access_token, () => {});
      }
    },

    getEmail() {
      if (cachedEmail) return cachedEmail;
      return sessionStorage.getItem('portal.email');
    },

    // Resolve the signed-in email from an existing token WITHOUT opening a
    // popup — for the silent auto-login path, where a fresh browser session
    // has a valid token but no cached email. An interactive signIn() here
    // would be popup-blocked (no user gesture) and dead-end the login.
    async ensureEmail() {
      if (this.getEmail()) return this.getEmail();
      const t = cachedToken || loadCachedToken();
      if (!t) throw new Error('no token');
      const info = await fetchUserInfo(t.access_token);
      return info.email || null;
    },

    async accessToken() {
      // Check the in-memory token's expiry too — the SPA lives longer than
      // one token TTL, and a stale cachedToken would 401 forever.
      let t = cachedToken;
      if (t && Date.now() >= t.expires_at - 60_000) t = null;
      if (!t) t = loadCachedToken();
      if (t) { cachedToken = t; return t.access_token; }
      // No valid token and no user gesture available here — bubble up so
      // the UI can offer the sign-in button (which redirects).
      throw new Error('unauthenticated');
    },

    // Drop the current token (memory + storage) so the next accessToken()
    // call runs a silent GIS refresh. Called by the Sheets client on 401.
    invalidateToken() {
      cachedToken = null;
      sessionStorage.removeItem(STORAGE_KEY);
    },

    // Trigger a separate consent prompt that adds the read+write Sheets
    // scope to the existing token. Members never need this; admin pages
    // and write-actions call it before issuing a mutation. If the user
    // already has the broader scope (e.g. cached from a previous session),
    // this resolves silently.
    async requestWriteAccess() {
      const writeScope = window.PORTAL_CONFIG.OAUTH_SCOPE_WRITE;
      if (!writeScope) throw new Error('OAUTH_SCOPE_WRITE not configured');
      const existing = cachedToken || loadCachedToken();
      if (tokenHasScope(existing, writeScope)) {
        cachedToken = existing; return existing;
      }
      // Popup with a hard timeout — if the popup relay is broken in this
      // browser, fail with guidance instead of hanging forever.
      const timeout = new Promise((_, rej) => setTimeout(() =>
        rej(new Error('write-access popup timed out — allow popups for this site and retry')), 25_000));
      return Promise.race([requestToken({ silent: false, scope: writeScope }), timeout]);
    },

    hasWriteScope() {
      const writeScope = window.PORTAL_CONFIG.OAUTH_SCOPE_WRITE;
      return tokenHasScope(cachedToken || loadCachedToken(), writeScope);
    },
  };
})();
