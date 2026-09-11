// Google OAuth 2.0 implicit *redirect* flow — the portal's one and only
// sign-in mechanism. Navigate to Google, come back with the token in the URL
// fragment. No popups, no Google Identity Services library.
//
// Issues access tokens (~1h TTL, no refresh tokens — that's normal for browser
// flows). Re-auth on reload is silent while the stored token is still valid;
// after that the user clicks Sign in once more.
//
// The same redirect is reused to upgrade to the read+write Sheets scope
// (see requestWriteAccess), so there is exactly one code path to reason about.

(function () {
  const STORAGE_KEY = 'portal.token';
  const EMAIL_KEY = 'portal.email';
  const STATE_KEY = 'portal.oauth_state';
  const RETURN_KEY = 'portal.oauth_return';
  let cachedToken = null;
  let cachedEmail = null;

  // Google returns granted scopes in normalized form — the shorthand
  // "email"/"profile" we request comes back as the full
  // https://www.googleapis.com/auth/userinfo.* URL. Compare normalized,
  // or every fresh token gets discarded as "missing email".
  function normScope(s) {
    if (s === 'email') return 'https://www.googleapis.com/auth/userinfo.email';
    if (s === 'profile') return 'https://www.googleapis.com/auth/userinfo.profile';
    return s;
  }
  function scopeSet(str) {
    return new Set((str || '').split(/\s+/).filter(Boolean).map(normScope));
  }
  function coversScopes(haveStr, neededStr) {
    const have = scopeSet(haveStr);
    // 'openid' is implied whenever any userinfo/identity scope was granted.
    const SHEETS = 'https://www.googleapis.com/auth/spreadsheets';
    for (const s of scopeSet(neededStr)) {
      if (s === 'openid' && (have.has('openid') || have.has(normScope('email')))) continue;
      // The read+write Sheets scope subsumes the read-only one. Google never
      // echoes both, so without this an upgraded token looks like it lost
      // read access and gets thrown away on the next page load.
      if (s === SHEETS + '.readonly' && have.has(SHEETS)) continue;
      if (!have.has(s)) return false;
    }
    return true;
  }

  function loadCachedToken() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed.access_token || !parsed.expires_at) return null;
      if (Date.now() >= parsed.expires_at - 60_000) return null;
      // Drop tokens that don't cover the currently configured scopes
      // (so changing config.js OAUTH_SCOPE invalidates stale tokens).
      if (!coversScopes(parsed.scope, window.PORTAL_CONFIG.OAUTH_SCOPE)) {
        sessionStorage.removeItem(STORAGE_KEY);
        sessionStorage.removeItem(EMAIL_KEY);
        return null;
      }
      return parsed;
    } catch (_e) { return null; }
  }

  function storeToken(tok) {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(tok));
    cachedToken = tok;
  }

  // Everything this origin cached on behalf of the signed-in user. The sheet
  // title cache is keyed per spreadsheet (sheet.js spreadsheetTitle), so it is
  // swept by prefix rather than by name.
  function clearToken() {
    sessionStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(EMAIL_KEY);
    sessionStorage.removeItem(STATE_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    for (const k of Object.keys(sessionStorage)) {
      if (k.startsWith('portal.sheetTitle.')) sessionStorage.removeItem(k);
    }
    cachedToken = null;
    cachedEmail = null;
  }

  function tokenHasScope(tok, scopeString) {
    if (!tok) return false;
    return coversScopes(tok.scope, scopeString);
  }

  async function fetchUserInfo(accessToken) {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + accessToken },
    });
    if (!r.ok) throw new Error('userinfo failed: ' + r.status);
    const j = await r.json();
    sessionStorage.setItem(EMAIL_KEY, j.email || '');
    cachedEmail = j.email || null;
    return j;
  }

  // ── Redirect-based sign-in ─────────────────────────────────────────────
  // A popup flow proved unreliable (COOP/popup-relay breakage leaves the
  // promise hanging with no callback). The classic implicit redirect flow has
  // no popup at all. Requires this page's URL to be listed under
  // "Authorized redirect URIs" on the OAuth client.
  function redirectUri() {
    // Always the canonical directory URL — strip index.html so every entry
    // point sends the same registered redirect URI.
    return location.origin + location.pathname.replace(/index\.html$/, '');
  }

  // scope defaults to the read scope. returnHash, when given, is the hash the
  // user should land back on — the whole point of an in-app scope upgrade is
  // that it returns you to the view you left.
  function signInRedirect(scope, returnHash) {
    const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem(STATE_KEY, state);
    if (returnHash) sessionStorage.setItem(RETURN_KEY, returnHash);
    else sessionStorage.removeItem(RETURN_KEY);
    const params = new URLSearchParams({
      client_id: window.PORTAL_CONFIG.OAUTH_CLIENT_ID,
      redirect_uri: redirectUri(),
      response_type: 'token',
      scope: scope || window.PORTAL_CONFIG.OAUTH_SCOPE,
      // Carries previously granted scopes forward, so upgrading to write
      // never silently drops the read scope.
      include_granted_scopes: 'true',
      state,
      // Only prompt for an account on a fresh sign-in. A scope upgrade for an
      // already-signed-in user should not make them pick their account again.
      prompt: returnHash ? 'consent' : 'select_account',
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
    const expected = sessionStorage.getItem(STATE_KEY);
    sessionStorage.removeItem(STATE_KEY);
    const ok = p.get('access_token') && (!expected || p.get('state') === expected);
    if (ok) {
      storeToken({
        access_token: p.get('access_token'),
        expires_at: Date.now() + (Number(p.get('expires_in') || 3600) * 1000),
        scope: p.get('scope') || window.PORTAL_CONFIG.OAUTH_SCOPE,
      });
    }
    // Restore the view the user was on before a scope upgrade bounced them
    // through Google. Falls back to a clean URL for a plain sign-in.
    const back = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    history.replaceState(null, '', location.pathname + location.search + (ok && back ? back : ''));
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

    // Returns the stored, still-valid token or throws. Never initiates a
    // sign-in: the caller decides whether to show the gate.
    async ensureToken() {
      const t = loadCachedToken();
      if (t) {
        cachedToken = t;
        return t;
      }
      throw new Error('not signed in');
    },

    async signOut() {
      const tok = loadCachedToken();
      clearToken();
      if (!tok) return;
      // Best-effort revocation. keepalive so it still goes out if the caller
      // reloads immediately afterwards; failure here is not worth blocking on.
      try {
        await fetch('https://oauth2.googleapis.com/revoke?token=' +
          encodeURIComponent(tok.access_token), { method: 'POST', keepalive: true });
      } catch (_e) { /* already signed out locally — that's what matters */ }
    },

    getEmail() {
      if (cachedEmail) return cachedEmail;
      return sessionStorage.getItem(EMAIL_KEY);
    },

    // Resolve the signed-in email from an existing token — for the silent
    // auto-login path, where a fresh browser session has a valid token but no
    // cached email.
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
      // No valid token — bubble up so the UI can offer the sign-in button.
      throw new Error('unauthenticated');
    },

    // Drop the current token (memory + storage) so the next accessToken()
    // call reports 'unauthenticated' and the UI can re-gate. Called by the
    // Sheets client on 401.
    invalidateToken() {
      cachedToken = null;
      sessionStorage.removeItem(STORAGE_KEY);
    },

    // Upgrade to the read+write Sheets scope via the same redirect. This
    // navigates away, so callers must gate BEFORE collecting input — see
    // UI.writeGate in components.js — rather than calling this mid-save.
    requestWriteAccess() {
      const writeScope = window.PORTAL_CONFIG.OAUTH_SCOPE_WRITE;
      if (!writeScope) throw new Error('OAUTH_SCOPE_WRITE not configured');
      if (this.hasWriteScope()) return Promise.resolve(cachedToken || loadCachedToken());
      signInRedirect(writeScope, location.hash || '');
      // Never resolves — the browser is navigating away.
      return new Promise(() => {});
    },

    hasWriteScope() {
      const writeScope = window.PORTAL_CONFIG.OAUTH_SCOPE_WRITE;
      return tokenHasScope(cachedToken || loadCachedToken(), writeScope);
    },
  };
})();
