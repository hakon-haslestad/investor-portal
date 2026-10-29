const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const { baseWindow, load } = require('./harness');

// Mounts app.js's boot on a fake DOM: the gate says what is happening in plain
// words, keeps the developer trace behind ?debug=1, and offers the right way out.

async function boot({ search = '', auth = {}, hydrate, hash = '' } = {}) {
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, hidden: false, innerHTML: '', style: {}, listeners: {}, addEventListener(t, f) { this.listeners[t] = f; }, querySelector(sel) { return el(sel); } });
  let domReady;
  const docListeners = {};
  const w = baseWindow({
    location: { hash, search, reload() {} },
    PORTAL_CONFIG: { OAUTH_CLIENT_ID: 'id' },
    Event: class {},
    Router: { ROUTES: [], start() {}, reload() { w.reloaded = true; } },
    UI: {
      esc: (s) => String(s).replace(/</g, '&lt;'), enableInfoPopovers() {}, skeleton: () => '<div class="skeleton-wrap" aria-busy="true"></div>',
      isSessionExpired: (e) => /unauthenticated/.test(String(e && e.message)),
      loadError: (e, what) => `<div class="flash error">${what ? `We could not load ${what}.` : 'Your session expired.'}<button data-act="retry"></button></div>`,
    },
    Auth: {
      consumeRedirectToken: () => false,
      ensureToken: async () => ({}), ensureEmail: async () => 'a@example.test', getEmail: () => 'a@example.test',
      signIn(h) { w.signedInWith = h; }, signInAgain() { w.again = true; },
      ...auth,
    },
    Store: { hydrate, whoami: () => ({ investorCode: 'HH', role: 'admin' }) },
    GameRoom: { configured: () => false },
  });
  w.document.addEventListener = (t, f) => { docListeners[t] = f; if (t === 'DOMContentLoaded') domReady = f; };
  w.document.getElementById = el;
  vm.createContext(w);
  load(w, 'app.js');
  const seen = [];
  const gs = el('auth-gate');
  Object.defineProperty(gs.querySelector('#gate-status'), 'innerHTML', { get() { return this._h || ''; }, set(v) { this._h = v; seen.push(v); } });
  domReady();
  await new Promise((r) => setTimeout(r, 20));
  return { w, el, seen, docListeners, status: () => el('#gate-status')._h || '' };
}

const store = { transactions: [], members: [], prices: { dates: [] } };

test('loading shows one plain line, no developer trace', async () => {
  let release;
  const gateOpen = new Promise((r) => { release = r; });
  const b = await boot({ hydrate: async () => { await gateOpen; return store; } });
  assert.match(b.status(), /Loading members, transactions and prices/);
  assert.doesNotMatch(b.seen.join(''), /OAuth|stored token|email resolved/);
  assert.match(b.status(), /skeleton-wrap/, 'placeholder blocks under the line');
  assert.strictEqual(b.el('#gate-signin').hidden, true);
  release();
});

test('a failed load says what failed, with Try again; no raw error, no Sign in with Google', async () => {
  const b = await boot({ hydrate: async () => { throw new Error('Sheets API 500: {"error":1}'); } });
  assert.match(b.status(), /We could not load the sheet/);
  assert.doesNotMatch(b.status(), /Sheets API 500|OAuth/);
  assert.strictEqual(b.el('#gate-signin').hidden, true);
});

test('?debug=1 keeps the boot trace on screen', async () => {
  const b = await boot({ search: '?debug=1', hydrate: async () => { throw new Error('Sheets API 500'); } });
  assert.match(b.status(), /stored token valid/);
  assert.match(b.status(), /Sheets API 500/);
});

test('an expired token at boot says the session expired and keeps the Sign in button', async () => {
  const b = await boot({
    hydrate: async () => store,
    auth: { ensureToken: async () => { throw new Error('not signed in'); }, hasExpiredSession: () => true },
  });
  assert.match(b.status(), /Your session expired/);
  assert.strictEqual(b.el('#gate-signin').hidden, false);
});

test('never signed in: plain gate, no expired message', async () => {
  const b = await boot({
    hydrate: async () => store,
    auth: { ensureToken: async () => { throw new Error('not signed in'); }, hasExpiredSession: () => false },
  });
  assert.doesNotMatch(b.status(), /expired/);
  assert.strictEqual(b.el('#gate-signin').hidden, false);
});

test('Sign in at the gate returns to the page that was asked for', async () => {
  const b = await boot({ hash: '#/accounting', hydrate: async () => store, auth: { ensureToken: async () => { throw new Error('not signed in'); } } });
  b.el('gate-signin').listeners.click();
  assert.strictEqual(b.w.signedInWith, '#/accounting');
});

test('data-act buttons: sign-in-again calls Auth, retry re-runs the view', async () => {
  const b = await boot({ hydrate: async () => store });
  const hit = (act) => b.docListeners.click({ target: { closest: () => ({ dataset: { act } }) }, preventDefault() {} });
  hit('sign-in-again'); assert.strictEqual(b.w.again, true);
  b.el('auth-gate').hidden = true; hit('retry'); assert.strictEqual(b.w.reloaded, true);
});
