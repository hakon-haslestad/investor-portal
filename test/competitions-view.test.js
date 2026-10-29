const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const { baseWindow, context, load } = require('./harness');

// Mounts the real Competitions view on a small fake DOM, with a stub engine
// and data layer, so a render that throws (a const used before it is set, as
// in production once) fails here, and the form rules can be driven.
const COMP = { id: 'C1', name: 'Spring', start_date: '2024-01-01', end_date: '2024-03-31' };
const team = (label, pct, extra = {}) => ({ label, members: [label], pct, netPnl: pct * 100, pctBase: 'buyIn', buyIn: 50000, amountSpent: 1000, ...extra });
const rows = (...ts) => ts.map((t) => ({ code: t.label, teamLabel: t.label, netPnl: t.netPnl, amountSpent: 1000, grossBought: 1 }));
const scoredOf = (...teams) => ({ competition: COMP, teams, ranks: rows(...teams) });

function fakeDom() {
  const kids = {};
  const el = (extra = {}) => ({ style: {}, dataset: {}, listeners: {}, addEventListener(t, fn) { this.listeners[t] = fn; }, scrollIntoView(o) { this.scrolled = o; }, ...extra });
  const members = ['HH', 'HS', 'ØS', 'JC', 'HF'];
  const boxes = [];
  for (let i = 1; i <= 5; i++) {
    kids[`#teams-setup input[name="amount-${i}"]`] = el({ value: '' });
    for (const m of members) {
      const chip = { classList: { add() {}, remove() {} } };
      boxes.push(el({ dataset: { team: String(i), member: m }, checked: false, closest: () => chip }));
    }
  }
  for (const k of ['#write-gate', '#jump-new', '#new-form']) kids[k] = el({ setAttribute(a, v) { this[a] = v; } });
  kids['#comp-name'] = el({ focus(o) { this.focused = true; this.focusOpts = o; } });
  kids['#team-error'] = el({ textContent: '', setAttribute(k, v) { this[k] = v; }, focus() { this.focused = true; } });
  const root = {
    innerHTML: '',
    querySelector: (sel) => kids[sel] || null,
    querySelectorAll(sel) {
      let m;
      if (sel === '#teams-setup input[type="checkbox"]') return boxes;
      if ((m = sel.match(/input\[data-team="(\d)"\]:checked/))) return boxes.filter((b) => b.dataset.team === m[1] && b.checked);
      if ((m = sel.match(/input\[data-member="(.+)"\]/))) return boxes.filter((b) => b.dataset.member === m[1]);
      return [];
    },
  };
  const tick = (team, member) => {
    const b = boxes.find((x) => x.dataset.team === String(team) && x.dataset.member === member);
    b.checked = true; b.listeners.change();
  };
  return { root, kids, tick };
}

async function mount(list, created = [], store = {}, reduceMotion = false) {
  const w = baseWindow({
    Views: {},
    UI: {
      flash: (k, h) => `<div class="flash ${k}">${h}</div>`, infoIcon: () => '', emptyState: (t) => `<div class="empty-state">${t}</div>`,
      writeGate: () => true,
    },
    CompetitionsData: {
      listCompetitions: async () => list.map((s) => ({ competition: s.competition, participants: [] })),
      fetchRaw: async () => ({ competitions: [], participants: [] }),
      fromRows: () => list.map((s) => ({ competition: s.competition, participants: [] })),
      createCompetition: async (c) => { created.push(c); return 'C9'; },
      deleteCompetition: async () => {},
    },
    CompetitionEngine: { scoreCompetition: (store, c) => list.find((s) => s.competition.id === c.id) },
    FormData: class { constructor(f) { this.f = f; } get(k) { return this.f.values[k]; } },
    alert: () => { throw new Error('alert() must not be used'); },
    confirm: () => false,
    matchMedia: () => ({ matches: reduceMotion }),
  });
  vm.createContext(w);
  load(w, 'format.js', 'views/competitions.js');
  const dom = fakeDom();
  await w.Views.competitions(dom.root, { store });
  return { w, ...dom, created };
}

async function submit(m, values) {
  m.kids['#new-form'].values = { name: 'N', start_date: '2024-01-01', end_date: '2024-02-01', ...values };
  await m.kids['#new-form'].listeners.submit({ preventDefault() {}, target: m.kids['#new-form'] });
}

test('mounts with a competition present and shows the club % with its basis', async () => {
  const m = await mount([scoredOf(team('HH', 4), team('HS', 2))]);
  assert.match(m.root.innerHTML, /Spring/);
  assert.match(m.root.innerHTML, /of total budget/);
  assert.match(m.root.innerHTML, /🏆 HH/);
  assert.match(m.root.innerHTML, /🥇/);
});

test('a full tie shows no trophy, no medals and no "leader"', async () => {
  const html = (await mount([scoredOf(team('HH', 3), team('HS', 3))])).root.innerHTML;
  assert.doesNotMatch(html, /🏆|🥇|🥈/);
  assert.doesNotMatch(html, /Leader:/);
});

test('a competition with no purchases shows no trophy and no medals', async () => {
  const idle = scoredOf(team('HH', 0), team('HS', 0));
  idle.ranks.forEach((r) => { r.grossBought = 0; });
  const html = (await mount([idle])).root.innerHTML;
  assert.doesNotMatch(html, /🏆|🥇|🥈/);
});

test('a legacy team without a budget is left out of the club %, and the view says so', async () => {
  const html = (await mount([scoredOf(team('HH', 4), team('HS', 9, { buyIn: 0, pctBase: 'invested' }))])).root.innerHTML;
  assert.match(html, /1 team without a budget is left out/);
  assert.match(html, /of total budget/);
});

test('with no budget anywhere, the club % says net invested', async () => {
  const html = (await mount([scoredOf(team('HH', 4, { buyIn: 0, pctBase: 'invested' }))])).root.innerHTML;
  assert.match(html, /of net invested/);
});

test('with no competitions the view still mounts, form included', async () => {
  const m = await mount([]);
  assert.match(m.root.innerHTML, /No competitions running/);
  assert.match(m.root.innerHTML, /id="team-error"/);
});

test('ticking a member prefills the team budget with 50 000, and keeps one that is set', async () => {
  const m = await mount([]);
  m.tick(1, 'HH');
  assert.equal(m.kids['#teams-setup input[name="amount-1"]'].value, '50000');
  m.kids['#teams-setup input[name="amount-2"]'].value = '20000';
  m.tick(2, 'HS');
  assert.equal(m.kids['#teams-setup input[name="amount-2"]'].value, '20000');
});

test('the form refuses an end before the start, with an inline message and no alert', async () => {
  const m = await mount([]); m.tick(1, 'HH');
  await submit(m, { 'label-1': '', 'amount-1': '50000', start_date: '2024-03-01', end_date: '2024-02-01' });
  assert.match(m.kids['#team-error'].textContent, /end.*before.*start/i);
  assert.equal(m.created.length, 0);
});

test('the form refuses duplicate team labels, case-insensitive, on the resolved label', async () => {
  const m = await mount([]); m.tick(1, 'HH'); m.tick(2, 'HS');
  await submit(m, { 'label-1': ' Rocket ', 'amount-1': '50000', 'label-2': 'rocket', 'amount-2': '50000' });
  assert.match(m.kids['#team-error'].textContent, /same label/i);
  await submit(m, { 'label-1': '', 'amount-1': '50000', 'label-2': 'hh', 'amount-2': '50000' });
  assert.match(m.kids['#team-error'].textContent, /same label/i, 'a blank label resolves to the members');
  assert.equal(m.created.length, 0);
});

test('the form refuses a team without a budget', async () => {
  const m = await mount([]); m.tick(1, 'HH');
  await submit(m, { 'label-1': '', 'amount-1': '' });
  assert.match(m.kids['#team-error'].textContent, /Team 1.*budget/i);
  assert.equal(m.created.length, 0);
});

test('a refresh that fails after a successful create says it was created, never "Failed"', async () => {
  const m = await mount([]); m.tick(1, 'HH');
  m.w.CompetitionsData.fetchRaw = async () => { throw new Error('offline'); };
  await submit(m, { 'label-1': 'A', 'amount-1': '50000' });
  assert.equal(m.created.length, 1);
  const msg = m.kids['#team-error'].textContent;
  assert.match(msg, /Created C9/);
  assert.match(msg, /offline/);
  assert.doesNotMatch(msg, /^Failed/);
});

test('a valid form creates the competition and confirms inline, never with alert()', async () => {
  const m = await mount([]); m.tick(1, 'HH'); m.tick(2, 'HS');
  await submit(m, { 'label-1': 'A', 'amount-1': '50000', 'label-2': '', 'amount-2': '30000' });
  assert.equal(m.created.length, 1);
  assert.deepEqual(m.created[0].teams.map((t) => [t.label, t.amount]), [['A', 50000], ['HS', 30000]]);
  assert.match(m.kids['#team-error'].textContent, /Created C9 with 2 teams/);
});

// An element stub that accepts anything the view does to it: every query
// returns another stub, every method is a no-op.
function fakeEl() {
  const el = {
    innerHTML: '', style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, scrollIntoView() {},
    appendChild() {}, closest: () => null,
    querySelector: () => fakeEl(),
    querySelectorAll: () => [],
  };
  return el;
}

const TEAM = { label: 'HH+HS', members: ['HH', 'HS'], pct: 4.3, pctBase: 'buyIn', netPnl: 2150, buyIn: 50000, amountSpent: 48000, overSpent: false, overSpentBy: 0, trades: 7 };

test('the Competitions tab renders a competition without throwing', async () => {
  const w = context(['format.js'], {
    UI: { flash: (k, m) => `FLASH:${m}`, emptyState: (t) => `EMPTY:${t}`, infoIcon: () => '', writeGate: () => true },
    CompetitionsData: { listCompetitions: async () => [{ competition: { id: 'c1', name: 'Cup', start_date: '2025-03-01', end_date: '2025-08-31' }, participants: [] }] },
    CompetitionEngine: { scoreCompetition: (store, c) => ({ competition: c, ranks: [], teams: [TEAM] }) },
    Views: {},
  });
  load(w, 'views/competitions.js');
  const el = fakeEl();
  await w.Views.competitions(el, { store: {}, me: { role: 'admin' } });
  assert.doesNotMatch(el.innerHTML, /FLASH/);
  assert.match(el.innerHTML, /HH\+HS/);
  assert.match(el.innerHTML, /of budget/);
  assert.match(el.innerHTML, /7 trades/, 'trade count is shown as secondary info');
});

test('a live competition says which day its prices are from; a finished one does not', async () => {
  const store = { prices: { latestDate: '2026-10-28' } };
  const liveComp = { ...scoredOf(team('HH', 4)), competition: { ...COMP, end_date: '2999-12-31' } };
  assert.match((await mount([liveComp], [], store)).root.innerHTML, /prices per 2026-10-28/);
  assert.doesNotMatch((await mount([scoredOf(team('HH', 4))], [], store)).root.innerHTML, /prices per/);
});

test('the newest competition is on top', async () => {
  const comp = (id, name, start, end) => ({ competition: { id, name, start_date: start, end_date: end }, participants: [] });
  const w = context(['format.js'], {
    UI: { flash: (k, m) => `FLASH:${m}`, emptyState: (t) => `EMPTY:${t}`, infoIcon: () => '', writeGate: () => true, loadError: () => 'ERR' },
    CompetitionsData: { listCompetitions: async () => [
      comp('a', 'Spring 2025', '2025-03-01', '2025-08-31'),
      comp('c', 'Autumn 2026', '2026-09-01', '2026-12-15'),
      comp('b', 'Autumn 2025', '2025-09-01', '2025-12-15'),
    ] },
    CompetitionEngine: { scoreCompetition: (store, c) => ({ competition: c, ranks: [], teams: [TEAM] }) },
    Views: {},
  });
  load(w, 'views/competitions.js');
  const el = fakeEl();
  await w.Views.competitions(el, { store: {}, me: { role: 'admin' } });
  const at = (s) => el.innerHTML.indexOf(s);
  assert.ok(at('Autumn 2026') > -1 && at('Autumn 2026') < at('Autumn 2025') && at('Autumn 2025') < at('Spring 2025'));
});

// ── First render comes from the store; a write refetches and refreshes the store ──
// The real data layer on a fake Sheet counts every read, so "no extra round trip" is a number.
const HEAD_C = ['Id', 'Name', 'StartDate', 'EndDate', 'CreatedBy', 'CreatedAt'];
const HEAD_P = ['CompetitionId', 'Investor', 'Team', 'BuyIn'];
const compRow = (id) => [id, 'Cup ' + id, '2024-01-01', '2024-03-31', 'a@example.test', '2024-01-01T00:00:00Z'];

async function mountReal({ store, sheetRows }) {
  const reads = [];
  let rows = sheetRows;
  const w = baseWindow({
    Views: {},
    PORTAL_CONFIG: { TABS: { competitions: 'Competitions', participants: 'Competition_Participants' } },
    Auth: { getEmail: () => 'a@example.test' },
    Sheet: {
      batchGet: async (tabs) => { reads.push(tabs); return Object.fromEntries(tabs.map((t) => [t, rows[t]])); },
      appendRow: async (tab, row) => { rows = { ...rows, [tab]: [...rows[tab], row] }; },
      deleteRows: async (tab, idx) => { rows = { ...rows, [tab]: rows[tab].filter((_r, i) => !idx.includes(i + 1)) }; },
    },
    UI: { flash: (k, h) => h, infoIcon: () => '', emptyState: (t) => t, writeGate: () => true },
    CompetitionEngine: { scoreCompetition: (s, c, p) => ({ competition: c, teams: [], ranks: [], participants: p }) },
    FormData: class { constructor(f) { this.f = f; } get(k) { return this.f.values[k]; } },
    alert() {}, confirm: () => true,
  });
  vm.createContext(w);
  load(w, 'parsers.js', 'format.js', 'competitions-data.js', 'views/competitions.js');
  const dom = fakeDom();
  // The browser finds the delete button in the painted markup; here it is one stand-in for the first card.
  const deleteBtn = { dataset: { delete: 'c_one' }, listeners: {}, addEventListener(t, fn) { this.listeners[t] = fn; } };
  const find = dom.root.querySelectorAll;
  dom.root.querySelectorAll = (sel) => (sel === '[data-delete]' ? [deleteBtn] : find(sel));
  await w.Views.competitions(dom.root, { store });
  return { w, reads, deleteBtn, ...dom };
}
const T = { competitions: 'Competitions', participants: 'Competition_Participants' };
const sheet = (...ids) => ({ [T.competitions]: [HEAD_C, ...ids.map(compRow)], [T.participants]: [HEAD_P, ...ids.map((id) => [id, 'HH', 'HH', 50000])] });

test('first open renders from the store and reads nothing from the sheet', async () => {
  const s = sheet('c_one');
  const m = await mountReal({ store: { competitionsRaw: s[T.competitions], participantsRaw: s[T.participants] }, sheetRows: sheet('c_other') });
  assert.strictEqual(m.reads.length, 0);
  assert.match(m.root.innerHTML, /Cup c_one/);
});

test('after a create the view refetches once, shows the new state, and writes the rows back to the store', async () => {
  const s = sheet('c_one');
  const store = { competitionsRaw: s[T.competitions], participantsRaw: s[T.participants] };
  const m = await mountReal({ store, sheetRows: s });
  m.tick(1, 'HH');
  const form = m.kids['#new-form'];
  form.values = { name: 'Fresh', start_date: '2024-01-01', end_date: '2024-02-01', 'label-1': '', 'amount-1': '50000' };
  await form.listeners.submit({ preventDefault() {}, target: form });
  assert.strictEqual(m.reads.length, 1, 'one refetch');
  assert.match(m.root.innerHTML, /Fresh/);
  assert.strictEqual(store.competitionsRaw.length, 3, 'header + old + new, in the store for the next visit');
  assert.strictEqual(store.participantsRaw.length, 3);
});

test('after a delete the view refetches once, drops the competition, and refreshes the store', async () => {
  const s = sheet('c_one', 'c_two');
  const store = { competitionsRaw: s[T.competitions], participantsRaw: s[T.participants] };
  const m = await mountReal({ store, sheetRows: s });
  assert.match(m.root.innerHTML, /Cup c_one/);
  m.deleteBtn.listeners.click();
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.strictEqual(m.reads.length, 2, 'the delete reads once to find rows, the view refetches once');
  assert.doesNotMatch(m.root.innerHTML, /Cup c_one/);
  assert.match(m.root.innerHTML, /Cup c_two/);
  assert.strictEqual(store.competitionsRaw.length, 2);
});

// ── The create form sits behind the "+ New competition" button ──
const formTag = (html) => (html.match(/<form[^>]*id="new-form"[^>]*>/) || [''])[0];
const clickNew = (m) => m.kids['#jump-new'].listeners.click({ preventDefault() {} });

test('the create form is closed on load; the write gate stays outside it', async () => {
  const m = await mount([scoredOf(team('HH', 4))]);
  assert.match(formTag(m.root.innerHTML), /\shidden[\s>]/);
  assert.match(m.root.innerHTML, /id="jump-new"[^>]*aria-expanded="false"[^>]*aria-controls="new-form"|aria-controls="new-form"[^>]*id="jump-new"/);
  const gateAt = m.root.innerHTML.indexOf('id="write-gate"');
  assert.ok(gateAt > -1 && gateAt < m.root.innerHTML.indexOf('id="new-form"'));
  assert.doesNotMatch(m.root.innerHTML.slice(m.root.innerHTML.indexOf('id="new-form"')), /id="write-gate"/);
});

test('the button opens the form, sets aria-expanded and focuses Name; a second press closes it', async () => {
  const m = await mount([]);
  clickNew(m);
  assert.strictEqual(m.kids['#new-form'].hidden, false);
  assert.strictEqual(m.kids['#jump-new']['aria-expanded'], 'true');
  assert.ok(m.kids['#comp-name'].focused);
  clickNew(m);
  assert.strictEqual(m.kids['#new-form'].hidden, true);
  assert.strictEqual(m.kids['#jump-new']['aria-expanded'], 'false');
});

test('after a create the form stays open, so "Created" is visible', async () => {
  const m = await mount([]); m.tick(1, 'HH');
  clickNew(m);
  await submit(m, { 'label-1': 'A', 'amount-1': '50000' });
  assert.doesNotMatch(formTag(m.root.innerHTML), /\shidden[\s>]/);
});

test('the live region is in the first render with its role, empty; role=alert only on an error', async () => {
  const m = await mount([]); m.tick(1, 'HH');
  const tag = m.root.innerHTML.match(/<p[^>]*id="team-error"[^>]*>/)[0];
  assert.match(tag, /role="status"/);
  assert.match(tag, /aria-live="polite"/);
  assert.doesNotMatch(tag, /display:\s*none/);
  await submit(m, { 'label-1': 'A', 'amount-1': '' });
  assert.strictEqual(m.kids['#team-error'].role, 'alert');
});

test('after a create the confirmation takes focus (tabindex -1), so keyboard focus is not lost', async () => {
  const m = await mount([]); m.tick(1, 'HH');
  clickNew(m);
  await submit(m, { 'label-1': 'A', 'amount-1': '50000' });
  assert.strictEqual(m.kids['#team-error'].role, 'status');
  assert.strictEqual(m.kids['#team-error'].tabIndex, -1);
  assert.ok(m.kids['#team-error'].focused);
});

test('opening: Name is focused without a second scroll; motion follows prefers-reduced-motion', async () => {
  for (const [reduce, want] of [[true, 'auto'], [false, 'smooth']]) {
    const m = await mount([], [], {}, reduce);
    clickNew(m);
    assert.strictEqual(m.kids['#comp-name'].focusOpts.preventScroll, true);
    assert.strictEqual(m.kids['#new-form'].scrolled.behavior, want);
  }
});

test('closing the form clears an old message; the form has an accessible name and clears the sticky header', async () => {
  const m = await mount([]); m.tick(1, 'HH');
  clickNew(m);
  await submit(m, { 'label-1': 'A', 'amount-1': '' });
  assert.ok(m.kids['#team-error'].textContent);
  clickNew(m);
  assert.strictEqual(m.kids['#team-error'].textContent, '');
  assert.match(formTag(m.root.innerHTML), /aria-label="New competition"/);
});
