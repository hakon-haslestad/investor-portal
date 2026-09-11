// Loads the browser IIFE modules into a fake `window` so their pure logic can
// be tested with `node --test` — no bundler, no jsdom, no dependencies.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', 'docs', 'js');

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
    get length() { return m.size; },
    key: (i) => [...m.keys()][i],
  };
}

// Minimal stand-ins for the modules the games lean on, so a test can load one
// file without dragging the whole app in.
function baseWindow(extra = {}) {
  const w = {
    // Browser globals the modules legitimately use.
    URLSearchParams, URL, console,
    localStorage: memoryStorage(),
    sessionStorage: memoryStorage(),
    matchMedia: () => ({ matches: false }),
    addEventListener() {},
    innerWidth: 1280,
    location: { hash: '' },
    document: {
      addEventListener() {},
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
      createElementNS: () => ({ style: {}, attrs: {}, setAttribute() {}, appendChild() {} }),
    },
    ...extra,
  };
  w.window = w;
  return w;
}

function load(win, ...relPaths) {
  for (const rel of relPaths) {
    const file = path.join(ROOT, rel);
    vm.runInContext(fs.readFileSync(file, 'utf8'), win, { filename: file });
  }
  return win;
}

function context(files, extra) {
  const w = baseWindow(extra);
  vm.createContext(w);
  return load(w, ...files);
}

module.exports = { baseWindow, load, context, memoryStorage, ROOT };
