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
    Utilities: { formatDate: () => '', getUuid: () => require('crypto').randomUUID() },
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
  assert.deepEqual(Object.keys(parsed).sort(), ['a', 'choices', 'g', 'host', 'hp', 'j', 'prompt', 'q', 'r', 'v']);
  assert.deepEqual(parsed.r, ['HH', 'JC']);
  assert.deepEqual(parsed.a, { HH: 2 });
  // Nothing that names a holding or a number of kroner.
  assert.ok(!/kr|Equinor|NOK|price|value/i.test(raw), raw);
});

// ── One room across games, and ending it ──────────────────────────────────
test('the host can switch games without anyone rejoining', () => {
  const g = gs({ tokenInfo: goodToken('hh@x.no') });
  const { code } = post(g, { action: 'create', token: 't', gameId: 'odd-one-out', roster: ['HH', 'JC'] });
  post(g, { action: 'join', token: 't', code });
  post(g, { action: 'round', token: 't', code, roundId: 1, prompt: 'a', choices: 4 });
  post(g, { action: 'answer', token: 't', code, roundId: 1, value: 2 });

  const r = post(g, { action: 'game', token: 't', code, gameId: 'back-trading' });
  assert.equal(r.ok, true);
  const st = get(g, { code });
  assert.equal(st.gameId, 'back-trading', 'the new game is announced');
  assert.deepEqual(st.joined, ['HH'], 'and nobody was kicked out');
  assert.deepEqual(st.answers, {}, 'a call from the last game does not carry over');
  assert.equal(st.roundId, 0);
});

test('closing the room tells the phones, rather than vanishing', () => {
  const g = gs({ tokenInfo: goodToken('hh@x.no') });
  const { code } = post(g, { action: 'create', token: 't', gameId: 'odd-one-out', roster: ['HH'] });
  assert.equal(get(g, { code }).closed, false);

  assert.equal(post(g, { action: 'close', token: 't', code }).ok, true);
  const st = get(g, { code });
  assert.equal(st.ok, true, 'the room still answers');
  assert.equal(st.closed, true, 'and says it is over');
});

test('a closed room takes no more answers', () => {
  const g = gs({ tokenInfo: goodToken('hh@x.no') });
  const { code } = post(g, { action: 'create', token: 't', gameId: 'x', roster: ['HH'] });
  post(g, { action: 'round', token: 't', code, roundId: 1, prompt: 'a', choices: 4 });
  post(g, { action: 'close', token: 't', code });
  assert.equal(post(g, { action: 'answer', token: 't', code, roundId: 1, value: 0 }).error, 'room closed');
  assert.equal(post(g, { action: 'round', token: 't', code, roundId: 2, prompt: 'b' }).error, 'room closed');
  // Joining still works, so a latecomer is told the game ended rather than
  // that their code is wrong.
  assert.equal(post(g, { action: 'join', token: 't', code }).ok, true);
  // And closing twice is not an error.
  assert.equal(post(g, { action: 'close', token: 't', code }).ok, true);
});

test('only the host can switch games or close the room', () => {
  const g = gs({ tokenInfo: goodToken('hh@x.no') });
  const { code } = post(g, { action: 'create', token: 't', gameId: 'x', roster: ['HH', 'JC'] });
  const g2 = gs({ tokenInfo: goodToken('jc@x.no') });
  g2._cache.set(`room:${code}`, g._cache.get(`room:${code}`));
  assert.equal(post(g2, { action: 'close', token: 't', code }).error, 'not the host');
  assert.equal(post(g2, { action: 'game', token: 't', code, gameId: 'y' }).error, 'not the host');
});

// ── Room passes: staying in the game after the Google token dies ──────────
test('joining hands back a pass', () => {
  const g = gs({ tokenInfo: goodToken('hh@x.no') });
  const { code } = post(g, { action: 'create', token: 't', gameId: 'x', roster: ['HH', 'JC'] });
  const j = post(g, { action: 'join', token: 't', code });
  assert.equal(j.ok, true);
  assert.match(j.pass, /^[0-9a-f]{32}$/, 'long enough not to be guessed');
  assert.equal(j.member, 'HH');
});

test('a pass answers without any Google token at all', () => {
  // This is the whole point: the OAuth token lasts about an hour with no
  // refresh, so a phone must not need one to keep playing.
  const g = gs({ tokenInfo: goodToken('hh@x.no') });
  const { code } = post(g, { action: 'create', token: 't', gameId: 'x', roster: ['HH'] });
  const { pass } = post(g, { action: 'join', token: 't', code });
  post(g, { action: 'round', token: 't', code, roundId: 1, prompt: 'q', choices: 4 });

  const dead = gs({ tokenInfo: null });          // token expired, nothing valid
  dead._cache.set(`room:${code}`, g._cache.get(`room:${code}`));
  const r = post(dead, { action: 'answer', code, roundId: 1, value: 2, pass });
  assert.equal(r.ok, true, 'still able to answer');
  assert.deepEqual(get(dead, { code }).answers, { HH: 2 });
});

test('a made-up pass is refused', () => {
  const g = gs({ tokenInfo: goodToken('hh@x.no') });
  const { code } = post(g, { action: 'create', token: 't', gameId: 'x', roster: ['HH'] });
  post(g, { action: 'join', token: 't', code });
  post(g, { action: 'round', token: 't', code, roundId: 1, prompt: 'q', choices: 4 });
  const r = post(g, { action: 'answer', code, roundId: 1, value: 0, pass: 'NOTAREALPASSNOTAREAL' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'bad pass');
});

test('a pass cannot host — it only answers', () => {
  const g = gs({ tokenInfo: goodToken('hh@x.no') });
  const { code } = post(g, { action: 'create', token: 't', gameId: 'x', roster: ['HH'] });
  const { pass } = post(g, { action: 'join', token: 't', code });
  const dead = gs({ tokenInfo: null });
  dead._cache.set(`room:${code}`, g._cache.get(`room:${code}`));
  // Creating, switching game and closing all still demand a real token.
  for (const action of ['round', 'game', 'close', 'create']) {
    const r = post(dead, { action, code, pass, roundId: 9, gameId: 'y', roster: ['HH'] });
    assert.equal(r.ok, false, `${action} must not accept a pass`);
    assert.equal(r.error, 'not signed in');
  }
});

test('rejoining returns the same pass, so a second device cannot lock out the first', () => {
  const g = gs({ tokenInfo: goodToken('hh@x.no') });
  const { code } = post(g, { action: 'create', token: 't', gameId: 'x', roster: ['HH'] });
  const a = post(g, { action: 'join', token: 't', code }).pass;
  const b = post(g, { action: 'join', token: 't', code }).pass;
  assert.equal(a, b);
});

test('passes are never exposed by the open GET', () => {
  const g = gs({ tokenInfo: goodToken('hh@x.no') });
  const { code } = post(g, { action: 'create', token: 't', gameId: 'x', roster: ['HH'] });
  const { pass } = post(g, { action: 'join', token: 't', code });
  // GET needs no token, so anything it returns is public. A leaked pass would
  // let a stranger answer as that member.
  const body = JSON.stringify(get(g, { code }));
  assert.ok(!body.includes(pass), 'the pass is not in the public response');
  assert.ok(!/"p"/.test(body), 'nor the pass map');
});

test('a pass from one room does not work in another', () => {
  const g = gs({ tokenInfo: goodToken('hh@x.no') });
  const a = post(g, { action: 'create', token: 't', gameId: 'x', roster: ['HH'] }).code;
  const b = post(g, { action: 'create', token: 't', gameId: 'x', roster: ['HH'] }).code;
  const { pass } = post(g, { action: 'join', token: 't', code: a });
  post(g, { action: 'round', token: 't', code: b, roundId: 1, prompt: 'q', choices: 2 });
  const r = post(g, { action: 'answer', code: b, roundId: 1, value: 0, pass });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'bad pass');
});

// ── Staying in: presence and the host pass ─────────────────────────────────
// A room with HH hosting and JC joined; returns the pieces the tests need.
function liveRoom() {
  const g = gs({ tokenInfo: goodToken('hh@x.no') });
  const made = post(g, { action: 'create', token: 't', gameId: 'x', roster: ['HH', 'JC'] });
  const pass = post(g, { action: 'join', token: 't', code: made.code }).pass;
  return { g, code: made.code, hostPass: made.hostPass, pass };
}
const dead = (g, code) => {
  const d = gs({ tokenInfo: null });          // Google token expired, nothing valid
  d._cache.set(`room:${code}`, g._cache.get(`room:${code}`));
  return d;
};

test('a ping with a pass records "seen" without a token and without moving rev', () => {
  const { g, code, pass } = liveRoom();
  let t = 1000000;
  g.nowMs_ = () => t;
  const rev = get(g, { code }).rev;
  const d = dead(g, code);
  d.nowMs_ = () => t;
  assert.equal(post(d, { action: 'ping', code, pass }).ok, true);
  t += 7000;
  d.nowMs_ = () => t;
  assert.equal(get(d, { code }).seen.HH, 7);
  assert.equal(get(d, { code }).rev, rev, 'a ping is not a change the screen must redraw for');
});

test('joining counts as being seen', () => {
  const { g, code } = liveRoom();
  assert.equal(get(g, { code }).seen.HH, 0);
});

test('a ping needs a pass: no pass, a made-up pass, another room\'s pass are all refused', () => {
  const { g, code, pass } = liveRoom();
  assert.equal(post(g, { action: 'ping', code, token: 't' }).error, 'bad pass');
  assert.equal(post(g, { action: 'ping', code, pass: 'NOTAREALPASSNOTAREAL' }).error, 'bad pass');
  const other = post(g, { action: 'create', token: 't', gameId: 'x', roster: ['HH'] }).code;
  assert.equal(post(g, { action: 'ping', code: other, pass }).error, 'bad pass');
});

test('create hands the host a host pass that runs the room with no Google token', () => {
  const { g, code, hostPass } = liveRoom();
  assert.match(hostPass, /^[0-9a-f]{32}$/);
  const d = dead(g, code);
  assert.equal(post(d, { action: 'round', code, hostPass, roundId: 3, prompt: 'q', choices: 2 }).ok, true);
  assert.equal(get(d, { code }).roundId, 3);
  assert.equal(post(d, { action: 'game', code, hostPass, gameId: 'y' }).ok, true);
  assert.equal(post(d, { action: 'close', code, hostPass }).ok, true);
  assert.equal(get(d, { code }).closed, true);
});

test('the host pass is refused when wrong, from another room, or used for anything but round/game/close', () => {
  const { g, code, hostPass, pass } = liveRoom();
  const d = dead(g, code);
  assert.equal(post(d, { action: 'round', code, hostPass: 'NOTAREALPASSNOTAREAL', roundId: 1 }).ok, false);
  const other = post(g, { action: 'create', token: 't', gameId: 'x', roster: ['HH'] });
  assert.equal(post(d, { action: 'round', code, hostPass: other.hostPass, roundId: 1 }).ok, false);
  // It is not a member pass and not a way to create or join.
  for (const action of ['answer', 'join', 'create', 'ping']) {
    assert.equal(post(d, { action, code, hostPass, roundId: 0, roster: ['HH'] }).ok, false, action);
  }
  // And a member pass still cannot host, even one that belongs to the host's own seat.
  for (const action of ['round', 'game', 'close']) {
    assert.equal(post(d, { action, code, pass, roundId: 1 }).error, 'not signed in', action);
  }
});

test('the host pass never appears in the open GET or in a join', () => {
  const { g, code, hostPass } = liveRoom();
  assert.ok(!JSON.stringify(get(g, { code })).includes(hostPass));
  assert.ok(!JSON.stringify(post(g, { action: 'join', token: 't', code })).includes(hostPass));
});

test('a repeated round keeps the answers; a late old round does not roll the room back', () => {
  const { g, code, hostPass, pass } = liveRoom();
  post(g, { action: 'round', code, hostPass, roundId: 1, prompt: 'one', choices: 2 });
  post(g, { action: 'round', code, hostPass, roundId: 2, prompt: 'two', choices: 2 });
  post(g, { action: 'answer', code, pass, roundId: 2, value: 1 });
  // The host's reply was lost and it retries round 2: nothing changes.
  assert.equal(post(g, { action: 'round', code, hostPass, roundId: 2, prompt: 'two', choices: 2 }).ok, true);
  assert.deepEqual(get(g, { code }).answers, { HH: 1 });
  // A slow retry of round 1 lands after round 2 started.
  assert.equal(post(g, { action: 'round', code, hostPass, roundId: 1, prompt: 'one', choices: 2 }).ok, true);
  const s = get(g, { code });
  assert.equal(s.roundId, 2);
  assert.equal(s.prompt, 'two');
});

test('the host pass on a closed room: close is idempotent, round and game are refused', () => {
  const { g, code, hostPass } = liveRoom();
  assert.equal(post(g, { action: 'close', code, hostPass }).ok, true);
  assert.equal(post(g, { action: 'close', code, hostPass }).ok, true);
  assert.equal(post(g, { action: 'round', code, hostPass, roundId: 5 }).error, 'room closed');
  assert.equal(post(g, { action: 'game', code, hostPass, gameId: 'y' }).error, 'room closed');
});

test('a ping on a closed room says closed, so the phone can stop', () => {
  const { g, code, hostPass, pass } = liveRoom();
  post(g, { action: 'close', code, hostPass });
  const r = post(g, { action: 'ping', code, pass });
  assert.equal(r.ok, true);
  assert.equal(r.closed, true);
});

// ── The evening's scoreboard ───────────────────────────────────────────────
test('the host posts the scoreboard and the open GET returns it', () => {
  const { g, code, hostPass } = liveRoom();
  assert.equal(get(g, { code }).scores, null);
  const scores = { games: [{ id: 'g', name: 'Guess', pts: { HH: 2, JC: 1 } }] };
  const before = get(g, { code }).rev;
  assert.equal(post(g, { action: 'scores', code, hostPass, scores }).ok, true);
  const r = get(g, { code });
  assert.deepEqual(JSON.parse(JSON.stringify(r.scores)), scores);
  assert.equal(r.rev, before);
  assert.ok(!JSON.stringify(r).includes(hostPass));
});

test('a phone pass cannot post scores, and an oversized scoreboard is refused', () => {
  const { g, code, hostPass, pass } = liveRoom();
  assert.notEqual(post(g, { action: 'scores', code, pass, scores: { games: [] } }).ok, true);
  const big = { games: [{ id: 'g', name: 'x'.repeat(7000), pts: {} }] };
  assert.equal(post(g, { action: 'scores', code, hostPass, scores: big }).error, 'scores too big');
  assert.equal(get(g, { code }).scores, null);
});

test('scores: only a well-formed scoreboard is stored; strings and junk values are dropped', () => {
  const { g, code, hostPass } = liveRoom();
  const hostile = { games: [{ id: 'g', name: '<b>x</b>', pts: { HH: '<img src=x onerror=1>', JC: 2, HS: 1.5, ØS: -1 } }, 'junk', { id: 'h' }] };
  assert.equal(post(g, { action: 'scores', code, hostPass, scores: hostile }).ok, true);
  const s = JSON.parse(JSON.stringify(get(g, { code }).scores));
  assert.deepEqual(s, { games: [{ id: 'g', name: '<b>x</b>', pts: { JC: 2, 'ØS': -1 } }] });
  assert.equal(post(g, { action: 'scores', code, hostPass, scores: 'nope' }).error, 'bad scores');
});

test('scores do not move rev (the host screen is not woken), and are refused after close', () => {
  const { g, code, hostPass } = liveRoom();
  const before = get(g, { code }).rev;
  post(g, { action: 'scores', code, hostPass, scores: { games: [{ id: 'g', name: 'G', pts: { HH: 1 } }] } });
  assert.equal(get(g, { code }).rev, before);
  post(g, { action: 'close', code, hostPass });
  assert.equal(post(g, { action: 'scores', code, hostPass, scores: { games: [] } }).error, 'room closed');
  assert.equal(get(g, { code }).scores.games[0].pts.HH, 1, 'the final board stands');
});
