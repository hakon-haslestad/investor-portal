const test = require('node:test');
const assert = require('node:assert');
const { context } = require('./harness');

// The phone and host halves of games/room.js against a fake network, a fake
// clock and a fake tab. These are the ways a phone used to fall out of a game.

function rig({ hidden = false } = {}) {
  const clock = {
    t: 1000000, timers: [], n: 0,
    setTimeout(fn, ms) { const id = ++clock.n; clock.timers.push({ id, at: clock.t + ms, fn }); return id; },
    clearTimeout(id) { clock.timers = clock.timers.filter((x) => x.id !== id); },
    // Run everything due within `ms`, letting promises settle between timers.
    async advance(ms) {
      const end = clock.t + ms;
      for (;;) {
        await flush();
        const due = clock.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        clock.timers = clock.timers.filter((x) => x !== due);
        clock.t = due.at;
        due.fn();
      }
      clock.t = end;
      await flush();
    },
  };
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  const docHandlers = {}, winHandlers = {};
  const net = { calls: [], down: false, get: () => ({ ok: true, roundId: 1, answers: {}, joined: [], rev: 1 }), post: () => ({ ok: true }) };
  const fetch = async (url, opts) => {
    const post = opts && opts.method === 'POST';
    const body = post ? JSON.parse(opts.body) : null;
    net.calls.push({ post, body, url });
    if (net.down) throw new Error('Failed to fetch');
    const data = post ? net.post(body) : net.get(url);
    if (data === 'down') throw new Error('Failed to fetch');
    return { ok: true, json: async () => data };
  };
  const doc = { hidden, addEventListener: (n, f) => { docHandlers[n] = f; }, removeEventListener: (n) => { delete docHandlers[n]; } };
  class FakeDate extends Date { static now() { return clock.t; } }
  const win = context(['games/session.js', 'games/room.js'], {
    PORTAL_CONFIG: { ROOMS_URL: 'https://rooms.test/exec' },
    fetch, document: doc, Date: FakeDate,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    addEventListener: (n, f) => { winHandlers[n] = f; },
    removeEventListener: (n) => { delete winHandlers[n]; },
    Auth: { accessToken: async () => { throw new Error('token expired'); } },
  });
  const posts = (action) => net.calls.filter((c) => c.post && c.body.action === action);
  const gets = () => net.calls.filter((c) => !c.post);
  return { clock, net, doc, docHandlers, winHandlers, win, posts, gets, GR: win.GameRoom, flush };
}
const session = (win) => win.localStorage.setItem('portal.games.room', JSON.stringify({ code: 'ABCD', member: 'HH', pass: 'P' }));
const lastState = (room) => { let s; const off = room.onChange((x) => { s = x; }); off(); return s; };

// ── Cause 1: a dropped phone says so, and says why it cannot come back ─────
test('a phone that cannot reach the server shows Reconnecting, then recovers on its own', async () => {
  const r = rig();
  session(r.win);
  const room = await r.GR.resume();
  await r.clock.advance(10);
  assert.equal(lastState(room).reconnecting, false);
  r.net.down = true;
  await r.clock.advance(3000);
  assert.equal(lastState(room).reconnecting, true);
  r.net.down = false;
  await r.clock.advance(20000);
  assert.equal(lastState(room).reconnecting, false);
  room.close();
});

test('a room the server no longer knows is "gone": polling stops and the pass is dropped', async () => {
  const r = rig();
  session(r.win);
  const room = await r.GR.resume();
  r.net.get = () => ({ ok: false, error: 'no such room' });
  await r.clock.advance(3000);
  assert.equal(lastState(room).gone, true);
  assert.equal(r.GR.savedSession(), null);
  const n = r.gets().length;
  await r.clock.advance(60000);
  assert.equal(r.gets().length, n, 'no more polling');
});

test('other server errors keep the phone reconnecting, never blank', async () => {
  const r = rig();
  session(r.win);
  const room = await r.GR.resume();
  r.net.get = () => ({ ok: false, error: 'busy' });
  await r.clock.advance(3000);
  assert.equal(lastState(room).reconnecting, true);
  assert.equal(lastState(room).gone, false);
  assert.ok(r.GR.savedSession(), 'pass kept');
  room.close();
});

// ── Cause 2: waking up polls now, not at the next throttled timer ──────────
for (const [where, name] of [['doc', 'visibilitychange'], ['win', 'online'], ['win', 'pageshow'], ['win', 'focus']]) {
  test(`${name} polls at once after the tab was hidden`, async () => {
    const r = rig();
    session(r.win);
    const room = await r.GR.resume();
    await r.clock.advance(10);
    r.doc.hidden = true;
    await r.clock.advance(60000);
    const n = r.gets().length;
    r.doc.hidden = false;
    (where === 'doc' ? r.docHandlers : r.winHandlers)[name]();
    await r.flush();
    assert.equal(r.gets().length, n + 1, 'one poll straight away, no clock advance');
    room.close();
  });
}

test('a burst of wake events starts one poll, not three', async () => {
  const r = rig();
  session(r.win);
  const room = await r.GR.resume();
  await r.clock.advance(10);
  const n = r.gets().length;
  r.docHandlers.visibilitychange(); r.winHandlers.focus(); r.winHandlers.pageshow();
  await r.flush();
  assert.equal(r.gets().length, n + 1);
  room.close();
});

test('stopping the poller removes its wake-up listeners', async () => {
  const r = rig();
  session(r.win);
  const room = await r.GR.resume();
  room.close();
  assert.deepEqual([Object.keys(r.docHandlers), Object.keys(r.winHandlers)], [[], []]);
});

// ── Cause 3: resume on a bad network keeps the seat ────────────────────────
test('resume with the network down attaches, keeps the pass and shows Reconnecting', async () => {
  const r = rig();
  session(r.win);
  r.net.down = true;
  const room = await r.GR.resume();
  assert.ok(room, 'not thrown away');
  assert.equal(room.member, 'HH');
  assert.equal(lastState(room).reconnecting, true);
  assert.ok(r.GR.savedSession());
  r.net.down = false;
  await r.clock.advance(20000);
  assert.equal(lastState(room).reconnecting, false);
  room.close();
});

test('resume into a closed or vanished room says why, and drops the pass', async () => {
  for (const [reply, key] of [[{ ok: true, closed: true, roundId: 2, answers: {} }, 'closed'], [{ ok: false, error: 'no such room' }, 'gone']]) {
    const r = rig();
    session(r.win);
    r.net.get = () => reply;
    const room = await r.GR.resume();
    assert.equal(lastState(room)[key], true, key);
    assert.equal(r.GR.savedSession(), null);
  }
});

test('a saved pass the server no longer honours means the room is gone', async () => {
  const r = rig();
  const room = await phone(r);
  r.net.post = () => ({ ok: false, error: 'bad pass' });
  await r.clock.advance(6000);   // the next ping
  assert.equal(lastState(room).gone, true);
  assert.equal(r.GR.savedSession(), null);
});

// ── Cause 4: the host runs the room on the host pass ───────────────────────
async function hosting(r) {
  r.net.post = (b) => (b.action === 'create' ? { ok: true, code: 'ABCD', hostPass: 'HP' } : { ok: true });
  return r.GR.openHost({ gameId: 'x', roster: [{ code: 'HH' }] });
}

test('round, game and close go out on the host pass with no Google token', async () => {
  const r = rig();
  r.net.post = () => ({ ok: true });
  // create is the one call that needs the token
  r.win.Auth.accessToken = async () => 'tok';
  const h = await hosting(r);
  r.win.Auth.accessToken = async () => { throw new Error('token expired'); };
  await h.setRound('q', 4);
  await h.setGame('y');
  await h.close();
  for (const a of ['round', 'game', 'close']) {
    const b = r.posts(a)[0].body;
    assert.equal(b.hostPass, 'HP', a);
    assert.equal(b.token, undefined, a);
  }
});

test('stopping the host does not hang on a dead network', async () => {
  const r = rig();
  r.win.Auth.accessToken = async () => 'tok';
  const h = await hosting(r);
  r.net.post = () => 'down';
  const done = h.close();
  await r.clock.advance(1000);
  await done;
  assert.equal(r.posts('close').length, 2);
});

test('a round that hits busy or a dead network is retried, not dropped', async () => {
  const r = rig();
  r.win.Auth.accessToken = async () => 'tok';
  const h = await hosting(r);
  let n = 0;
  r.net.post = () => { n += 1; return n === 1 ? { ok: false, error: 'busy' } : { ok: true }; };
  const done = h.setRound('q', 4);
  await r.clock.advance(5000);
  await done;
  assert.equal(r.posts('round').length, 2);
  h.close();
});

// ── Cause 5: answers survive busy, network and a stale round ───────────────
async function phone(r) {
  session(r.win);
  const room = await r.GR.resume();
  await r.clock.advance(10);
  return room;
}

test('an answer is retried on busy and on a network error', async () => {
  const r = rig();
  const room = await phone(r);
  const replies = [{ ok: false, error: 'busy' }, 'down', { ok: true }];
  r.net.post = (b) => (b.action === 'answer' ? replies.shift() : { ok: true });
  const p = room.answer(2);
  await r.clock.advance(10000);
  const res = await p;
  assert.equal(res.ok, true);
  assert.equal(r.posts('answer').length, 3);
  room.close();
});

test('a stale round is not re-sent: the phone refreshes to the new question instead', async () => {
  const r = rig();
  const room = await phone(r);
  r.net.post = () => ({ ok: false, error: 'stale round', roundId: 2 });
  const n = r.gets().length;
  const res = await room.answer(1);
  await r.flush();
  assert.equal(res.error, 'stale round');
  assert.equal(r.posts('answer').length, 1, 'not retried');
  assert.equal(r.gets().length, n + 1, 'refreshed straight away');
  room.close();
});

test('an answer carries the pass, never a token', async () => {
  const r = rig();
  const room = await phone(r);
  await room.answer(0);
  assert.equal(r.posts('answer')[0].body.pass, 'P');
  assert.equal(r.posts('answer')[0].body.token, undefined);
  room.close();
});

// ── Cause 6: presence ──────────────────────────────────────────────────────
test('a phone pings with its pass about every five seconds, not on every poll', async () => {
  const r = rig();
  const room = await phone(r);
  await r.clock.advance(30000);
  const n = r.posts('ping').length;
  assert.ok(n >= 5 && n <= 7, `pings ${n}`);
  assert.equal(r.posts('ping')[0].body.pass, 'P');
  room.close();
});

test('the host sees a phone go away and come back even though rev never moves', async () => {
  const r = rig();
  r.win.Auth.accessToken = async () => 'tok';
  const h = await hosting(r);
  r.net.get = () => ({ ok: true, rev: 5, roundId: 0, joined: ['HH', 'JC'], answers: {}, seen: { HH: 2, JC: 40 } });
  await r.clock.advance(3000);
  assert.deepEqual(Array.from(h.state.away), ['JC']);
  r.net.get = () => ({ ok: true, rev: 5, roundId: 0, joined: ['HH', 'JC'], answers: {}, seen: { HH: 2, JC: 3 } });
  await r.clock.advance(3000);
  assert.deepEqual(Array.from(h.state.away), []);
  h.close();
});

// ── The phone page: what a player reads when it drops ──────────────────────
function board(state, answer) {
  const win = context(['views/play.js'], { Views: {}, UI: { esc: (x) => String(x) } });
  const el = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
  const room = { member: 'HH', code: 'ABCD', forget() {}, close() {}, answer, onChange(cb) { cb(state); return () => {}; } };
  win.Views.playResumed(el, room);
  return el;
}

test('the phone page says Reconnecting, keeps its buttons, and names why a seat ended', () => {
  const live = { roundId: 1, choices: 3, prompt: 'Pick', answered: false };
  assert.ok(!board(live).innerHTML.includes('Reconnecting'));
  assert.ok(!board(live).innerHTML.includes('flash error'), 'no error on a healthy board');
  const re = board({ ...live, reconnecting: true }).innerHTML;
  assert.ok(re.includes('Reconnecting…') && re.includes('play-btn'));
  assert.ok(board({ closed: true }).innerHTML.includes('The host closed the room'));
  assert.ok(board({ gone: true }).innerHTML.includes('This room is gone'));
});

test('a failed answer reads as plain words, not as the server\'s error code', async () => {
  const el = (err) => {
    const buttons = [{ addEventListener(_e, f) { this.f = f; }, getAttribute: () => '0', classList: { add() {} } }];
    const win = context(['views/play.js'], { Views: {}, UI: { esc: (x) => String(x) } });
    const e = { innerHTML: '', querySelector: () => null, querySelectorAll: (q) => (q === '.play-btn' ? buttons : []) };
    const room = { member: 'HH', code: 'ABCD', forget() {}, close() {}, answer: async () => ({ ok: false, error: err }), onChange(cb) { cb({ roundId: 1, choices: 2 }); return () => {}; } };
    win.Views.playResumed(e, room);
    return { e, click: () => buttons[0].f() };
  };
  for (const [err, shown] of [['busy', 'try again'], ['network', 'try again']]) {
    const x = el(err);
    await x.click();
    assert.ok(x.e.innerHTML.includes(shown), err);
    assert.ok(!x.e.innerHTML.includes(`>${err}<`), err);
  }
  const stale = el('stale round');
  await stale.click();
  assert.ok(!stale.e.innerHTML.includes('flash error'), 'a stale round just refreshes');
});

// ── The evening's scoreboard travels with the room ─────────────────────────
test('opening a room starts a fresh evening, and awards go out on the host pass', async () => {
  const r = rig();
  r.win.Auth.accessToken = async () => 'tok';
  r.win.GameSession.award('old', 'Old', { HH: 5 });
  const h = await hosting(r);
  assert.ok(r.win.GameSession.isEmpty(), 'points from before the room are gone');
  r.win.GameSession.award('g', 'Guess', { HH: 1, JC: 2 });
  await r.flush();
  const b = r.posts('scores')[0].body;
  assert.equal(b.hostPass, 'HP');
  assert.equal(b.token, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(b.scores)), { games: [{ id: 'g', name: 'Guess', pts: { HH: 1, JC: 2 } }] });
  await h.close();
});

test('a burst of awards ends with the newest totals, and close sends them before closing', async () => {
  const r = rig();
  r.win.Auth.accessToken = async () => 'tok';
  const h = await hosting(r);
  const order = [];
  r.net.post = (b) => { order.push(b.action); return { ok: true }; };
  for (let i = 0; i < 3; i++) r.win.GameSession.award('g', 'G', { HH: 1 });
  await h.close();
  const last = r.posts('scores').pop().body.scores;
  assert.equal(last.games[0].pts.HH, 3);
  assert.ok(order.lastIndexOf('scores') < order.indexOf('close'));
  r.win.GameSession.award('g', 'G', { HH: 1 });
  await r.flush();
  assert.equal(r.posts('scores').pop().body.scores.games[0].pts.HH, 3, 'a closed room is not written to again');
});

test('a phone reads the totals from the room on every poll, so a reconnect loses nothing', async () => {
  const r = rig();
  const wire = { games: [{ id: 'g', name: 'Guess', pts: { HH: 2 } }] };
  r.net.get = () => ({ ok: true, roundId: 1, answers: {}, joined: [], rev: 1, scores: wire });
  session(r.win);
  const room = await r.win.GameRoom.resume();
  await r.clock.advance(100);
  assert.deepEqual(JSON.parse(JSON.stringify(lastState(room).scores)), wire);
  r.net.get = () => 'down';
  await r.clock.advance(4000);
  assert.ok(lastState(room).scores, 'kept while reconnecting');
  r.net.get = () => ({ ok: true, roundId: 1, answers: {}, joined: [], rev: 2, scores: wire });
  await r.clock.advance(20000);
  assert.deepEqual(JSON.parse(JSON.stringify(lastState(room).scores)), wire);
  room.close();
});

test('a publish that throws does not stall later ones, including the final one at close', async () => {
  const r = rig();
  r.win.Auth.accessToken = async () => 'tok';
  const h = await hosting(r);
  const snap = r.win.GameSession.snapshot;
  let boom = true;
  r.win.GameSession.snapshot = () => { if (boom) { boom = false; throw new Error('boom'); } return snap(); };
  r.win.GameSession.award('g', 'G', { HH: 1 });
  await r.flush();
  assert.equal(r.posts('scores').length, 0, 'the first publish failed');
  r.win.GameSession.award('g', 'G', { HH: 1 });
  await h.close();
  assert.equal(r.posts('scores').pop().body.scores.games[0].pts.HH, 2);
  assert.equal(r.posts('close').length, 1);
});

test('an old web app that answers {ok:false} to scores leaves the games and the close working', async () => {
  const r = rig();
  r.win.Auth.accessToken = async () => 'tok';
  const h = await hosting(r);
  r.net.post = (b) => (b.action === 'scores' ? { ok: false, error: 'unknown action' } : { ok: true });
  r.win.GameSession.award('g', 'G', { HH: 1 });
  await r.flush();
  assert.equal(r.win.GameSession.totals()[0].total, 1, 'the host board still counts');
  await h.close();
  assert.equal(r.posts('close').length, 1);
});
