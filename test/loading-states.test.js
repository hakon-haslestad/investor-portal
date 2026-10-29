const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { context, ROOT } = require('./harness');

const tick = () => new Promise((r) => setImmediate(r));
const css = fs.readFileSync(path.join(ROOT, '..', 'css', 'style.css'), 'utf8');

// Router on a fake DOM, with a controllable lazy loader.
function mountRouter(hash, { lazy, views } = {}) {
  const els = { view: { classList: { remove() {} }, focus() {}, innerHTML: '' }, 'route-status': { textContent: '' } };
  const seen = [];
  Object.defineProperty(els.view, 'innerHTML', { get() { return this._h || ''; }, set(v) { this._h = v; seen.push(v); } });
  const calls = [];
  const w = context(['router.js'], {
    document: { title: '', getElementById: (id) => els[id] || null, querySelectorAll: () => [] },
    location: { hash, replace() {} }, scrollTo() {}, addEventListener() {},
    Lazy: { load: (g) => { calls.push('lazy:' + g); return lazy(g); } },
    Views: views || { games: async () => { calls.push('view'); }, dashboard: async () => { calls.push('view'); } },
    UI: { bindRowExpanders() {}, skeleton: (k) => `<div class="skeleton-wrap" data-kind="${k}"></div>`, loadError: (e, what) => `<div class="flash error">${what}: ${e.message}</div>` },
  });
  w.Router.start({ store: {}, me: { role: 'member' } });
  return { w, els, seen, calls };
}

test('router shows a skeleton, not bare "Loading…", while a view loads', async () => {
  const m = mountRouter('#/dashboard', { lazy: async () => {} });
  assert.match(m.seen[0], /skeleton-wrap/);
  assert.doesNotMatch(m.seen.join(''), /Loading…/);
  await tick();
});

test('the games route waits for the game files before it calls the view; other routes do not ask for them', async () => {
  let release;
  const m = mountRouter('#/games', { lazy: () => new Promise((r) => { release = r; }) });
  await tick();
  assert.deepStrictEqual(m.calls, ['lazy:games'], 'view not called while the files load');
  release(); await tick();
  assert.deepStrictEqual(m.calls, ['lazy:games', 'view']);
  const d = mountRouter('#/dashboard', { lazy: async () => {} });
  await tick();
  assert.deepStrictEqual(d.calls, ['view']);
});

test('a failed lazy load shows the normal load error and announces it', async () => {
  const m = mountRouter('#/games', { lazy: async () => { throw new Error('Could not load games/pool.js'); } });
  await tick();
  assert.match(m.els.view.innerHTML, /games: Could not load games\/pool\.js/);
  assert.strictEqual(m.els['route-status'].textContent, 'Games failed to load');
  assert.deepStrictEqual(m.calls, ['lazy:games'], 'the view never ran');
});

test('a route left while its files load does not paint the old view over the new one', async () => {
  let release; let hashchange;
  const m = mountRouter('#/games', { lazy: () => new Promise((r) => { release = r; }), views: { games: async (el) => { el.innerHTML = 'GAMES'; }, dashboard: async (el) => { el.innerHTML = 'DASH'; } } });
  await tick();
  m.w.location.hash = '#/dashboard';
  await m.w.Router.reload(); await tick();
  release(); await tick();
  assert.strictEqual(m.els.view.innerHTML, 'DASH');
});

test('UI.skeleton: busy region with one silent status text and no live role; kinds differ', () => {
  const w = context(['components.js'], { Fmt: { escapeHtml: String } });
  const view = w.UI.skeleton('view'), block = w.UI.skeleton('block');
  for (const h of [view, block]) {
    assert.match(h, /aria-busy="true"/);
    assert.match(h, /<span class="sr-only">Loading…<\/span>/);
    assert.doesNotMatch(h, /role=|aria-live/);
    assert.match(h, /class="skeleton /);
  }
  assert.notStrictEqual(view, block);
});

test('skeleton CSS: shimmer is switched off under prefers-reduced-motion (wiring invariant)', () => {
  assert.match(css, /\.skeleton\s*\{[^}]*animation:[^}]*sk-shimmer/);
  const rm = css.slice(css.indexOf('/* skeleton reduced motion */'));
  assert.match(rm, /prefers-reduced-motion: reduce[\s\S]*\.skeleton\s*\{\s*animation: none/);
});
