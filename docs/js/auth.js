// Google Identity Services Token Client wrapper.
// Issues access tokens (~1h TTL, no refresh tokens — that's normal for browser flows).
// Re-auth on reload is silent if the user has an active Google session and previously consented.

(function () {
  const STORAGE_KEY = 'portal.token';
  let tokenClient = null;
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

  // Reject handler for the in-flight token request — GIS reports popup
  // failures (blocked, closed by user) via error_callback, not callback.
  // Without this the sign-in promise would hang forever on a blocked popup.
  let pendingReject = null;

  async function ensureTokenClient(scope) {
    if (tokenClient && tokenClient._scope === scope) return tokenClient;
    // Wait for GIS script to load
    await new Promise((resolve) => {
      if (window.google && window.google.accounts && window.google.accounts.oauth2) return resolve();
      const t = setInterval(() => {
        if (window.google && window.google.accounts && window.google.accounts.oauth2) {
          clearInterval(t); resolve();
        }
      }, 50);
    });
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: window.PORTAL_CONFIG.OAUTH_CLIENT_ID,
      scope: scope || window.PORTAL_CONFIG.OAUTH_SCOPE,
      callback: () => {}, // assigned per-request
      error_callback: (err) => {
        if (pendingReject) {
          const r = pendingReject; pendingReject = null;
          r(new Error(err && (err.message || err.type) || 'popup failed'));
        }
      },
    });
    tokenClient._scope = scope || window.PORTAL_CONFIG.OAUTH_SCOPE;
    return tokenClient;
  }

  function requestToken({ silent, scope }) {
    const requestScope = scope || window.PORTAL_CONFIG.OAUTH_SCOPE;
    return new Promise((resolve, reject) => {
      ensureTokenClient(requestScope).then((client) => {
        pendingReject = reject;
        client.callback = (resp) => {
          pendingReject = null;
          if (resp.error) return reject(new Error(resp.error_description || resp.error));
          const tok = {
            access_token: resp.access_token,
            expires_at: Date.now() + (Number(resp.expires_in || 3600) * 1000),
            scope: resp.scope,
          };
          storeToken(tok);
          resolve(tok);
        };
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

  // Public API
  window.Auth = {
    async signIn() {
      const tok = await requestToken({ silent: false });
      const info = await fetchUserInfo(tok.access_token);
      return info;
    },

    async ensureToken() {
      const t = loadCachedToken();
      if (t) {
        cachedToken = t;
        return t;
      }
      return requestToken({ silent: true });
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
      const fresh = await requestToken({ silent: true });
      return fresh.access_token;
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
      // Try silent first (in case the user previously granted write access).
      try {
        const silent = await requestToken({ silent: true, scope: writeScope });
        if (tokenHasScope(silent, writeScope)) return silent;
      } catch (_e) { /* fall through to interactive */ }
      return requestToken({ silent: false, scope: writeScope });
    },

    hasWriteScope() {
      const writeScope = window.PORTAL_CONFIG.OAUTH_SCOPE_WRITE;
      return tokenHasScope(cachedToken || loadCachedToken(), writeScope);
    },
  };
})();
