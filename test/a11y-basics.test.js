const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { context } = require('./harness');

const DOCS = path.join(__dirname, '..', 'docs');
const read = (rel) => fs.readFileSync(path.join(DOCS, rel), 'utf8');

// Mounts the real router on a tiny fake DOM and drives a hash change.
function mountRouter(hash) {
  const listeners = {};
  const els = { view: { classList: { remove() {} }, focus() {}, innerHTML: '' }, 'route-status': { textContent: '' }, 'skip-link': { listeners: {}, addEventListener(t, fn) { this.listeners[t] = fn; } } };
  const doc = { title: 'Investor Portal', getElementById: (id) => els[id] || null, querySelectorAll: () => [] };
  const w = context(['router.js'], {
    document: doc, location: { hash, replace() {} }, scrollTo() {}, addEventListener: (t, fn) => { listeners[t] = fn; },
    Views: { portfolio: async () => {}, play: async () => {}, competitions: async () => { throw new Error('boom'); } },
    UI: { bindRowExpanders() {}, skeleton: () => '<div class="skeleton-wrap"></div>', loadError: () => '<div class="flash error">failed</div>' },
  });
  w.Router.start({ store: {}, me: { role: 'member' } });
  return { w, doc, els, listeners };
}
const tick = () => new Promise((r) => setImmediate(r));

test('route change sets the document title and announces the loaded view', async () => {
  const { doc, els } = mountRouter('#/portfolio/holdings');
  await tick();
  assert.strictEqual(doc.title, 'Portfolio - Investor Portal');
  assert.strictEqual(els['route-status'].textContent, 'Portfolio loaded');
});

test('a hidden route (play) still gets a title; a failed view is announced as failed', async () => {
  const a = mountRouter('#/play/ABCD'); await tick();
  assert.strictEqual(a.doc.title, 'Play - Investor Portal');
  const b = mountRouter('#/competitions'); await tick();
  assert.strictEqual(b.els['route-status'].textContent, 'Competitions failed to load');
});

test('first load leaves focus at the page start so the skip link is the first Tab stop; later routes focus #view', async () => {
  const { els, listeners } = mountRouter('#/portfolio');
  let focus = 0;
  els.view.focus = () => { focus++; };
  await tick(); assert.strictEqual(focus, 0);
  listeners.hashchange(); await tick(); assert.strictEqual(focus, 1);
});

test('skip link moves focus to #view without touching the hash route', async () => {
  const { els } = mountRouter('#/portfolio');
  let focused = false, prevented = false;
  els.view.focus = () => { focused = true; };
  els['skip-link'].listeners.click({ preventDefault() { prevented = true; } });
  assert.ok(focused && prevented);
});

test('shell markup (wiring invariant): skip link first in the shell, live region, one h1', () => {
  const html = read('index.html');
  const shell = html.slice(html.indexOf('<div id="shell"'));
  assert.match(shell, /<div id="shell" hidden>\s*<a [^>]*id="skip-link"[^>]*>Skip to main content<\/a>/);
  assert.match(html, /id="route-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /<title>Investor Portal<\/title>/);
  // One h1 visible at a time: the shell brand; the gate h1 is hidden once in. Views must not add one.
  const views = fs.readdirSync(path.join(DOCS, 'js', 'views')).concat(fs.readdirSync(path.join(DOCS, 'js', 'games')).map((f) => '../games/' + f));
  for (const f of views) assert.ok(!/<h1[ >]/.test(read('js/views/' + f)), `${f} adds an h1`);
});

test('sign-out is a button, not a link (wiring invariant)', () => {
  assert.match(read('js/app.js'), /<button type="button" id="nav-signout" class="link-btn">Bounce<\/button>/);
});

test('hidden chip inputs sit inside a positioned chip, so they cannot widen the page (css invariant)', () => {
  const css = read('css/style.css') + read('js/views/competitions.js');
  // every "<chip> input { position: absolute" needs "<chip> { ... position: relative"
  const chips = [...css.matchAll(/(\.[\w-]+(?: \.[\w-]+)?) input \{ position: absolute/g)].map((m) => m[1].split(' ').pop());
  assert.ok(chips.includes('.m-chip') && chips.includes('.investor-chip'));
  for (const c of chips) assert.match(css, new RegExp(`\\${c}\\s*\\{[^}]*position: relative`), `${c} is not positioned`);
});

test('touch targets: coarse-pointer block sets 44px on nav, buttons, chips and expanders (css invariant)', () => {
  const css = read('css/style.css');
  const block = css.slice(css.indexOf('@media (pointer: coarse)'));
  for (const sel of ['.nav .links a', '.btn', '.row-expand', '.investor-chip', '.link-btn']) assert.ok(block.includes(sel), sel);
  assert.match(block, /min-height: 44px/);
});

test('review fixes (wiring invariants): loading skeleton is silent, gate sign-out is a button, chip ring is keyboard-only, subtabs get 44px', () => {
  assert.doesNotMatch(read('js/components.js').match(/function skeleton[\s\S]*?\n  }\n/)[0], /role=|aria-live/);
  assert.match(read('js/app.js'), /<button type="button" class="link-btn" id="gate-signout">/);
  const css = read('css/style.css');
  assert.match(css, /\.investor-chip:has\(input:focus-visible\)/);
  assert.doesNotMatch(css, /\.investor-chip:focus-within/);
  assert.match(css.slice(css.indexOf('@media (pointer: coarse)')), /\.subtabs a/);
});
