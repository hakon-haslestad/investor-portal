const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { context, ROOT } = require('./harness');

// The lazy loader on a fake DOM: scripts are "loaded" when the test fires
// their onload/onerror, so order, caching and retry can be driven.
function mountLazy(src = './js/lazy.js?v=20990101') {
  const added = [];
  const head = { appendChild: (s) => { added.push(s); } };
  const document = { currentScript: { src: 'http://localhost/js/' + src.slice(5) }, head, createElement: () => ({}) };
  const w = context(['lazy.js'], { document });
  return { w, added };
}
const ok = (s) => s.onload();
const fail = (s) => s.onerror();

test('load adds the group scripts in manifest order, unordered-safe (async=false), with the version of its own tag', () => {
  const { w, added } = mountLazy();
  const done = w.Lazy.load('games');
  const files = Array.from(w.Lazy.files('games'));
  assert.ok(files.length > 10);
  assert.deepStrictEqual(added.map((s) => s.src), files.map((f) => `http://localhost/js/${f}?v=20990101`));
  assert.ok(added.every((s) => s.async === false), 'async=false keeps execution order');
  added.forEach(ok);
  return done;
});

test('a second load shares the first and adds nothing; a loaded group never reloads', async () => {
  const { w, added } = mountLazy();
  const a = w.Lazy.load('games'), b = w.Lazy.load('games');
  assert.strictEqual(a, b);
  added.forEach(ok); await a;
  const n = added.length;
  await w.Lazy.load('games');
  assert.strictEqual(added.length, n);
});

test('a failed script rejects; the retry re-adds from the first failed file on, in order', async () => {
  const { w, added } = mountLazy();
  const first = w.Lazy.load('games');
  const n = added.length;
  added.forEach((s, i) => (i === 3 ? fail(s) : ok(s)));
  await assert.rejects(first, /Could not load/);
  const retry = w.Lazy.load('games');
  const again = added.slice(n);
  assert.strictEqual(again.length, n - 3, 'files 0-2 are done, 3 onwards come again');
  assert.match(again[0].src, new RegExp(w.Lazy.files('games')[3].replace('.', '\\.')));
  again.forEach(ok);
  await retry;
});

test('an unknown group rejects instead of loading nothing', async () => {
  const { w } = mountLazy();
  await assert.rejects(w.Lazy.load('nope'), /Unknown/);
});

test('every lazy file exists, is not loaded by index.html too, and registry.js comes last', () => {
  const { w } = mountLazy();
  const html = fs.readFileSync(path.join(ROOT, '..', 'index.html'), 'utf8');
  const files = Array.from(w.Lazy.files('games'));
  for (const f of [...files, ...w.Lazy.files('books')]) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), f + ' exists');
    assert.ok(!html.includes('js/' + f + '?'), f + ' is also an eager tag');
  }
  assert.strictEqual(files.filter((f) => f.startsWith('games/')).pop(), 'games/registry.js');
});

test('index.html: every script is deferred, one ?v= for all, no inline scripts, lazy.js before the router (wiring invariant)', () => {
  const html = fs.readFileSync(path.join(ROOT, '..', 'index.html'), 'utf8');
  const tags = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(tags.length > 20);
  for (const t of tags) assert.match(t, /\ssrc="[^"]+"[^>]*\sdefer/, t);
  const versions = new Set([...html.matchAll(/\?v=([^"]+)"/g)].map((m) => m[1]));
  assert.strictEqual(versions.size, 1, 'one shared ?v= value: ' + [...versions]);
  assert.ok(html.indexOf('js/lazy.js') > 0 && html.indexOf('js/lazy.js') < html.indexOf('js/router.js'));
});

test('load order: index.html scripts, then the lazy group, define every route view without a load-time error', () => {
  const html = fs.readFileSync(path.join(ROOT, '..', 'index.html'), 'utf8');
  const eager = [...html.matchAll(/src="\.\/js\/([^"?]+)/g)].map((m) => m[1]).filter((f) => f !== 'app.js');
  const w = context(['lazy.js'], { document: { currentScript: { src: 'x/js/lazy.js' }, addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {} }) } });
  const { load } = require('./harness');
  load(w, ...eager.filter((f) => f !== 'lazy.js'), ...w.Lazy.files('games'), ...w.Lazy.files('books'));
  for (const r of w.Router.ROUTES) assert.strictEqual(typeof w.Views[r.view], 'function', r.view);
  assert.ok(w.Games.registry.length >= 5);
});

test('the Accounting route loads the books group; the Board loads it only to calculate', () => {
  const r = fs.readFileSync(path.join(ROOT, 'router.js'), 'utf8');
  assert.match(r, /match: 'accounting'[^}]*lazy: 'books'/);
  const b = fs.readFileSync(path.join(ROOT, 'views', 'board.js'), 'utf8');
  assert.match(b, /if \(!sheetId\) \{\s*if \(window\.Lazy\) await window\.Lazy\.load\('books'\)/);
});
