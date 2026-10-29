const test = require('node:test');
const assert = require('node:assert');
const { context } = require('./harness');

// Fake nav elements: just enough DOM for Router.highlightNav (classList, attributes, hidden).
function el(dataset) {
  const cls = new Set(), attrs = {};
  return { dataset, hidden: false, classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), has: (c) => cls.has(c) },
    setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; }, attrs };
}

function mount(hash, role, navEls) {
  const els = { view: { classList: { remove() {} }, focus() {}, innerHTML: '' }, 'route-status': { textContent: '' } };
  const replaced = [];
  const sel = (q) => (navEls[{ '#top-nav a[data-group]': 'groups', '#sub-nav [data-group-entries]': 'blocks', '#sub-nav a[data-route]': 'entries' }[q]] || []);
  const w = context(['router.js'], {
    document: { title: '', getElementById: (id) => els[id] || null, querySelectorAll: sel },
    location: { hash, replace: (h) => replaced.push(h) }, scrollTo() {}, addEventListener() {},
    Views: Object.fromEntries(['board', 'dashboard', 'portfolio', 'investors', 'competitions', 'games', 'play', 'accounting', 'admin'].map((v) => [v, async () => {}])),
    Lazy: { load: async () => {} },
    UI: { bindRowExpanders() {}, skeleton: () => '', loadError: () => '' },
  });
  w.Router.start({ store: {}, me: { role } });
  return { w, replaced };
}
const tick = () => new Promise((r) => setImmediate(r));
const labels = (g) => Array.from(g, (x) => x.label);
const arr = (a) => Array.from(a);

test('groupsFor: five groups in order, Admin only for admins', () => {
  const { w } = mount('#/dashboard', 'member', {});
  assert.deepStrictEqual(labels(w.Router.groupsFor('member')), ['Overview', 'Investments', 'Club', 'Books']);
  assert.deepStrictEqual(labels(w.Router.groupsFor('admin')), ['Overview', 'Investments', 'Club', 'Books', 'Admin']);
});

test('group entries and hrefs: Overview, Club (incl. Join a game -> #/play), group link = first entry', () => {
  const { w } = mount('#/dashboard', 'admin', {});
  const g = Object.fromEntries(w.Router.groupsFor('admin').map((x) => [x.id, x]));
  assert.deepStrictEqual(labels(g.overview.entries), ['Board', 'Dashboard']);
  assert.deepStrictEqual(labels(g.investments.entries), ['Portfolio']);
  assert.deepStrictEqual(labels(g.club.entries), ['Investors', 'Competitions', 'Games', 'Join a game']);
  assert.strictEqual(g.club.entries[3].href, '#/play');
  assert.deepStrictEqual(labels(g.books.entries), ['Accounting']);
  assert.strictEqual(g.books.entries[0].badge, 'beta');
  assert.deepStrictEqual(Object.values(g).map((x) => x.href), ['#/board', '#/portfolio', '#/investors', '#/accounting', '#/admin']);
});

test('groupOf maps every route (play included) to its group; unknown is null', () => {
  const { w } = mount('#/dashboard', 'member', {});
  const want = { board: 'overview', dashboard: 'overview', portfolio: 'investments', investors: 'club', competitions: 'club', games: 'club', play: 'club', accounting: 'books', admin: 'admin' };
  for (const [m, g] of Object.entries(want)) assert.strictEqual(w.Router.groupOf(m), g, m);
  assert.strictEqual(w.Router.groupOf('nope'), null);
});

test('old links keep working: every old path dispatches without redirect, #/game goes to #/games', async () => {
  for (const m of ['dashboard', 'portfolio', 'investors', 'competitions', 'games', 'accounting', 'admin', 'board', 'play']) {
    const { replaced } = mount('#/' + m, 'admin', {}); await tick();
    assert.strictEqual(replaced.length, 0, m);
  }
  const a = mount('#/game', 'member', {}); await tick();
  assert.deepStrictEqual(arr(a.replaced), ['#/games']);
  const b = mount('#/game/xyz', 'member', {}); await tick();
  assert.deepStrictEqual(arr(b.replaced), ['#/games/xyz']);
  const c = mount('#/admin', 'member', {}); await tick();
  assert.deepStrictEqual(arr(c.replaced), ['#/dashboard']);
});

test('highlight: the route group gets aria-current and its entries block shows; play highlights Club with no entry', async () => {
  const mk = () => ({
    groups: ['overview', 'investments', 'club', 'books'].map((id) => el({ group: id })),
    blocks: ['overview', 'investments', 'club', 'books'].map((id) => el({ groupEntries: id })),
    entries: ['board', 'dashboard', 'portfolio', 'investors', 'competitions', 'games', 'join', 'accounting'].map((r) => el({ route: r })),
  });
  const n = mk();
  mount('#/games/abc', 'member', n); await tick();
  assert.deepStrictEqual(n.groups.filter((g) => g.attrs['aria-current']).map((g) => g.dataset.group), ['club']);
  assert.deepStrictEqual(n.blocks.filter((b) => !b.hidden).map((b) => b.dataset.groupEntries), ['club']);
  assert.deepStrictEqual(n.entries.filter((e) => e.attrs['aria-current']).map((e) => e.dataset.route), ['games']);
  const p = mk();
  mount('#/play/ABCD', 'member', p); await tick();
  assert.deepStrictEqual(p.groups.filter((g) => g.attrs['aria-current']).map((g) => g.dataset.group), ['club']);
  assert.strictEqual(p.entries.filter((e) => e.attrs['aria-current']).length, 0);
});

test('aria-current: group link is "true" when it has a second row, "page" for a single-entry group; entry is "page"', async () => {
  const n = {
    groups: ['club', 'books'].map((id) => el({ group: id })),
    blocks: [el({ groupEntries: 'club' })], // Books is single-entry: no second-row block
    entries: ['games'].map((r) => el({ route: r })),
  };
  mount('#/games', 'member', n); await tick();
  assert.strictEqual(n.groups[0].attrs['aria-current'], 'true');
  assert.strictEqual(n.entries[0].attrs['aria-current'], 'page');
  mount('#/accounting', 'member', n); await tick();
  assert.strictEqual(n.groups[0].attrs['aria-current'], undefined);
  assert.strictEqual(n.groups[1].attrs['aria-current'], 'page');
});
