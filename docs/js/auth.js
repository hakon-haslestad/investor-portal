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

  async function ensureTokenClient() {
    if (tokenClient) return tokenClient;
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
      scope: window.PORTAL_CONFIG.OAUTH_SCOPE,
      callback: () => {}, // assigned per-request
    });
    return tokenClient;
  }

  function requestToken({ silent }) {
    return new Promise((resolve, reject) => {
      ensureTokenClient().then((client) => {
        client.callback = (resp) => {
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

    async accessToken() {
      const t = cachedToken || loadCachedToken();
      if (t) { cachedToken = t; return t.access_token; }
      const fresh = await requestToken({ silent: true });
      return fresh.access_token;
    },
  };
})();
