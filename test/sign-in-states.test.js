const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const { baseWindow, load } = require('./harness');

// Sign-in and failure states in plain words: the shared error box, the views
// that use it (mounted with a failing Sheets call), the router's catch, the
// session banner event and the return hash of "Sign in again".

function win(extra = {}) {
  const events = [];
  const w = baseWindow({
    Views: {},
    Event: class { constructor(t) { this.type = t; } },
    dispatchEvent(e) { events.push(e.type); },
    ...extra,
  });
  vm.createContext(w);
  load(w, 'format.js', 'components.js');
  return { w, events };
}
const expired = () => Object.assign(new Error('unauthenticated'), { code: 'unauthenticated' });
const RAW = 'Sheets API 500: {"error":{"message":"Backend Error"}}';

test('an expired session says so, offers Sign in again and never shows the raw word', () => {
  const { w, events } = win();
  const html = w.UI.loadError(expired(), 'competitions');
  assert.match(html, /Your session expired/);
  assert.match(html, /data-act="sign-in-again"/);
  assert.doesNotMatch(html, /unauthenticated/);
  assert.deepStrictEqual(events, ['portal:session-expired']);
});

test('a plain Error("unauthenticated") counts as expired too', () => {
  const { w } = win();
  assert.strictEqual(w.UI.isSessionExpired(new Error('unauthenticated')), true);
  assert.strictEqual(w.UI.isSessionExpired(new Error(RAW)), false);
});

test('another failure: plain sentence, Try again, Sign in again, raw text only in details', () => {
  const { w } = win();
  const html = w.UI.loadError(new Error(RAW), 'the sheet');
  assert.match(html, /We could not load the sheet/);
  assert.match(html, /data-act="retry"/);
  assert.match(html, /data-act="sign-in-again"/);
  const [visible, details] = html.split('<details');
  assert.doesNotMatch(visible, /Sheets API 500/);
  assert.match(details, /Sheets API 500/);
});

test('error text is escaped', () => {
  const { w } = win();
  assert.doesNotMatch(w.UI.loadError(new Error('<img onerror=x>'), 'x'), /<img/);
});

test('Competitions mounts with a failing Sheets call and shows the plain box', async () => {
  const { w } = win({
    CompetitionsData: { listCompetitions: async () => { throw expired(); } },
    CompetitionEngine: {},
  });
  load(w, 'views/competitions.js');
  const el = { innerHTML: '' };
  await w.Views.competitions(el, { store: {} });
  assert.match(el.innerHTML, /Your session expired/);
  assert.doesNotMatch(el.innerHTML, /unauthenticated/);
});

function accountingEl() {
  const mounts = {};
  const node = (id) => (mounts[id] = mounts[id] || { innerHTML: '', style: {}, addEventListener() {}, querySelector: () => node('x') });
  return { mounts, el: { innerHTML: '', querySelector: (sel) => node(sel) } };
}

async function mountAccounting(err) {
  const { w } = win({
    PORTAL_CONFIG: { ACCOUNTING_SHEET_ID: 'S', ACCOUNTING_TABS: { dnbRaw: 'D', nordnetRaw: 'N' } },
    // The tab lists the sheet's tabs first (since the year-end checklist), so that is the call that fails.
    Sheet: { batchGet: async () => { throw err; }, listTabs: async () => { throw err; } },
    Accounting: {},
    Auth: { getEmail: () => 'a@example.test' },
  });
  load(w, 'views/accounting.js');
  const { mounts, el } = accountingEl();
  await w.Views.accounting(el, { me: {} });
  return mounts['#acc-root'].innerHTML;
}

test('Accounting: expired session shows Sign in again, not "Sheet API error"', async () => {
  const html = await mountAccounting(expired());
  assert.match(html, /Your session expired/);
  assert.doesNotMatch(html, /unauthenticated|Sheet API error/);
});

test('Accounting: a server error is plain, with Try again and details', async () => {
  const html = await mountAccounting(new Error(RAW));
  assert.match(html, /We could not read it just now/);
  assert.match(html, /data-act="retry"/);
  assert.match(html, /<details[\s\S]*Sheets API 500/);
  assert.doesNotMatch(html.split('<details')[0], /Sheets API 500/);
});

test('Router: a view that throws shows the plain box with the tab name', async () => {
  const el = { innerHTML: '', classList: { remove() {} }, focus() {} };
  const { w } = win({
    document: { ...baseWindow().document, getElementById: (id) => (id === 'view' ? el : null), querySelectorAll: () => [] },
    location: { hash: '#/competitions', replace() {} },
    scrollTo() {},
    Views: { competitions: async () => { throw new Error(RAW); } },
  });
  load(w, 'router.js');
  w.UI.bindRowExpanders = () => {};
  w.Router.start({ store: {}, me: { role: 'admin' } });
  await new Promise((r) => setTimeout(r, 20));
  assert.match(el.innerHTML, /We could not load competitions/);
  assert.match(el.innerHTML, /data-act="retry"/);
});

test('Sign in again returns to the view you are on, and ignores the OAuth fragment', () => {
  for (const [hash, expect] of [['#/accounting/2025', '#/accounting/2025'], ['#access_token=abc&state=1', '']]) {
    const nav = [];
    const w = baseWindow({
      PORTAL_CONFIG: { OAUTH_CLIENT_ID: 'id', OAUTH_SCOPE: 's' },
      location: { hash, origin: 'http://x', pathname: '/', assign: (u) => nav.push(u) },
    });
    vm.createContext(w);
    load(w, 'auth.js');
    w.Auth.signInAgain();
    assert.strictEqual(nav.length, 1);
    assert.strictEqual(w.sessionStorage.getItem('portal.oauth_return') || '', expect);
    assert.match(nav[0], /prompt=select_account/);
  }
});
