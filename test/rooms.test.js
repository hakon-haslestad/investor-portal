const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Load the Apps Script with stubs for the Google runtime. The rooms API is
// the one piece of this project that only runs on Google's servers, so
// without this it could only be tested by deploying — which is exactly how
// auth gating quietly ships broken.
function gs({ tokenInfo, members } = {}) {
  const cache = new Map();
  const ctx = {
    console,
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cache.has(k) ? cache.get(k) : null),
        put: (k, v) => cache.set(k, v),
      }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (t) => ({ _t: t, setMimeType() { return this; }, getContent: () => t }),
    },
    UrlFetchApp: {
      fetch: () => ({
        getResponseCode: () => (tokenInfo ? 200 : 401),
        getContentText: () => JSON.stringify(tokenInfo || {}),
      }),
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: (n) => (n !== 'Members' ? null : {
          getDataRange: () => ({ getValues: () => members || [['email', 'investorCode'], ['hh@x.no', 'HH'], ['jc@x.no', 'JC']] }),
        }),
      }),
    },
    Utilities: { formatDate: () => '' },
    SpreadsheetApp_: null,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8'), ctx);
  ctx._cache = cache;
  return ctx;
}

const CLIENT = '872440185175-io8gmos8q04sq7jdt99ubeb16hbopv47.apps.googleusercontent.com';
const goodToken = (email) => ({ aud: CLIENT, email, email_verified: 'true' });
const post = (g, body) => JSON.parse(g.doPost({ postData: { contents: JSON.stringify(body) } }).getContent());
const get = (g, params) => JSON.parse(g.doGet({ parameter: params }).getContent());

test('room codes avoid characters that get misread aloud', () => {
  const g = gs({ tokenInfo: goodToken('hh@x.no') });
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const code = g.newRoomCode_();
    assert.equal(code.length, 4);
    assert.ok(/^[A-Z2-9]{4}$/.test(code), code);
    for (const ch of code) assert.ok(!'O0I1'.includes(ch), `${code} contains a lookalike`);
    seen.add(code);
  }
  assert.ok(seen.size > 100, 'codes are actually random');
});

test('a host creates a room and gets a code back', () => {
  const g = gs({ tokenInfo: goodToken('hh@x.no') });
  const r = post(g, { action: 'create', token: 't', gameId: 'odd-one-out', roster: ['HH', 'JC'] });
  assert.equal(r.ok, true);
  assert.match(r.code, /^[A-Z2-9]{4}$/);
  assert.equal(r.member, 'HH');
});

// ── The security gate: the reason an "anyone" deployment is acceptable ─────
test('a request with no usable token is refused', () => {
  const g = gs({ tokenInfo: null });
  const r = post(g, { action: 'create', token: 'whatever', roster: ['HH'] });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not signed in');
});

test('a token minted for another Google app is refused', () => {
  // Without the audience check this would pass — any Google app's token
  // would become a write credential here.
  const g = gs({ tokenInfo: { aud: 'some-other-app.apps.googleusercontent.com', email: 'hh@x.no', email_verified: 'true' } });
  const r = post(g, { action: 'create', token: 't', roster: ['HH'] });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not signed in');
});

test('an unverified Google email is refused', () => {
  const g = gs({ tokenInfo: { aud: CLIENT, email: 'hh@x.no', email_verified: 'false' } });
  assert.equal(post(g, { action: 'create', token: 't', roster: ['HH'] }).error, 'not signed in');
});

test('a real Google account that is not a club member is refused', () => {
  const g = gs({ tokenInfo: goodToken('stranger@example.com') });
  const r = post(g, { action: 'create', token: 't', roster: ['HH'] });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not a member');
});

test('a member who is not in this room cannot answer into it', () => {
  const g = gs({ tokenInfo: goodToken('hh@x.no') });
  const { code } = post(g, { action: 'create', token: 't', gameId: 'x', roster: ['HH'] });
  // JC is a member, but this room's roster is HH only.
  const g2 = gs({ tokenInfo: goodToken('jc@x.no') });
  g2._cache.set(`room:${code}`, g._cache.get(`room:${code}`));
  const r = post(g2, { action: 'answer', token: 't', code, roundId: 0, value: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not in this room');
});

// ── Rounds and answers ────────────────────────────────────────────────────
test('joining, answering and polling round-trip', () => {
  const g = gs({ tokenInfo: goodToken('hh@x.no') });
  const { code } = post(g, { action: 'create', token: 't', gameId: 'odd-one-out', roster: ['HH', 'JC'] });
  assert.deepEqual(get(g, { code }).joined, []);

  assert.equal(post(g, { action: 'join', token: 't', code }).ok, true);
  assert.deepEqual(get(g, { code }).joined, ['HH']);

  post(g, { action: 'round', token: 't', code, roundId: 1, prompt: 'Which one?', choices: 4 });
  assert.equal(post(g, { action: 'answer', token: 't', code, roundId: 1, value: 2 }).ok, true);

  const state = get(g, { code });
  assert.deepEqual(state.answers, { HH: 2 });
  assert.equal(state.roundId, 1);
  assert.equal(state.prompt, 'Which one?');
  assert.equal(state.choices, 4);
});

test('an answer for a round that has moved on is dropped, not applied', () => {
  const g = gs({ tokenInfo: goodToken('hh@x.no') });
  const { code } = post(g, { action: 'create', token: 't', gameId: 'x', roster: ['HH'] });
  post(g, { action: 'round', token: 't', code, roundId: 1, prompt: 'a', choices: 4 });
  post(g, { action: 'round', token: 't', code, roundId: 2, prompt: 'b', choices: 4 });
  // A slow phone still on question 1 must not answer question 2.
  const r = post(g, { action: 'answer', token: 't', code, roundId: 1, value: 3 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'stale round');
  assert.deepEqual(get(g, { code }).answers, {});
});

test('a new round clears the previous answers', () => {
  const g = gs({ tokenInfo: goodToken('hh@x.no') });
  const { code } = post(g, { action: 'create', token: 't', gameId: 'x', roster: ['HH'] });
  post(g, { action: 'round', token: 't', code, roundId: 1, prompt: 'a', choices: 4 });
  post(g, { action: 'answer', token: 't', code, roundId: 1, value: 0 });
  assert.deepEqual(get(g, { code }).answers, { HH: 0 });
  post(g, { action: 'round', token: 't', code, roundId: 2, prompt: 'b', choices: 4 });
  assert.deepEqual(get(g, { code }).answers, {});
});

test('button labels survive the round trip', () => {
  const g = gs({ tokenInfo: goodToken('hh@x.no') });
  const { code } = post(g, { action: 'create', token: 't', gameId: 'back-trading', roster: ['HH'] });
  post(g, { action: 'round', token: 't', code, roundId: 1, prompt: 'Held?', choices: ['Hold 💎', 'Sell ✂️'] });
  assert.deepEqual(get(g, { code }).choices, ['Hold 💎', 'Sell ✂️']);
});

test('the rev counter moves on every change, so the screen can skip no-op polls', () => {
  const g = gs({ tokenInfo: goodToken('hh@x.no') });
  const { code } = post(g, { action: 'create', token: 't', gameId: 'x', roster: ['HH'] });
  const a = get(g, { code }).rev;
  post(g, { action: 'join', token: 't', code });
  const b = get(g, { code }).rev;
  assert.ok(b > a);
  assert.equal(get(g, { code }).rev, b, 'a read does not bump it');
});

test('polling an unknown or expired room says so rather than throwing', () => {
  const g = gs({ tokenInfo: goodToken('hh@x.no') });
  assert.equal(get(g, { code: 'ZZZZ' }).ok, false);
  assert.equal(get(g, {}).ok, false);
  assert.equal(post(g, { action: 'answer', token: 't', code: 'ZZZZ', roundId: 1, value: 0 }).error, 'no such room');
});

test('malformed input is refused rather than crashing the endpoint', () => {
  const g = gs({ tokenInfo: goodToken('hh@x.no') });
  assert.equal(JSON.parse(g.doPost({ postData: { contents: 'not json' } }).getContent()).error, 'bad json');
  assert.equal(JSON.parse(g.doPost({}).getContent()).error, 'not signed in');
  const { code } = post(g, { action: 'create', token: 't', gameId: 'x', roster: ['HH'] });
  assert.equal(post(g, { action: 'nonsense', token: 't', code }).error, 'unknown action');
});

test('the room holds no club data — only codes and small integers', () => {
  const g = gs({ tokenInfo: goodToken('hh@x.no') });
  const { code } = post(g, { action: 'create', token: 't', gameId: 'odd-one-out', roster: ['HH', 'JC'] });
  post(g, { action: 'round', token: 't', code, roundId: 1, prompt: "Which one doesn't belong?", choices: 4 });
  post(g, { action: 'answer', token: 't', code, roundId: 1, value: 2 });
  // This is the whole reason an unauthenticated GET is acceptable.
  const raw = g._cache.get(`room:${code}`);
  assert.match(raw, /^\{.*\}$/);
  const parsed = JSON.parse(raw);
  assert.deepEqual(Object.keys(parsed).sort(), ['a', 'choices', 'g', 'host', 'j', 'prompt', 'q', 'r', 'v']);
  assert.deepEqual(parsed.r, ['HH', 'JC']);
  assert.deepEqual(parsed.a, { HH: 2 });
  // Nothing that names a holding or a number of kroner.
  assert.ok(!/kr|Equinor|NOK|price|value/i.test(raw), raw);
});
