// Loads the scripts a route needs only when it is opened: the game catalogue
// and its game files, and the calculated books (Accounting tab, and the Board
// when it calculates the accounting result itself). The router awaits Lazy.load(group) before it
// calls the view. Script files come from the folder of this script, with the
// ?v= value of this script's own tag, so index.html has one version to bump.
//
// Kept eager on purpose: games/session.js and games/room.js (the boot path
// that resumes a phone in a room reads them) and views/play.js (it needs
// only those two).

(function () {
  const GROUPS = {
    games: [
      'games/rng.js', 'games/pool.js', 'games/shell.js', 'games/round.js',
      'games/spin-the-stock.js', 'games/guess-the-stock.js',
      'games/odd-one-out-rules.js', 'games/odd-one-out.js',
      'games/back-trading-verdict.js', 'games/back-trading.js',
      'games/horse-race-engine.js', 'games/horse-race-audio.js', 'games/horse-race-view.js', 'games/horse-race.js',
      'games/registry.js', 'views/game.js',
    ],
    // accounting.js stays eager: the Investments tab's trade CSV uses it.
    books: ['bank-rules.js', 'books.js', 'calculated-books.js', 'views/accounting.js'],
  };

  const own = document.currentScript && document.currentScript.src || '';
  const base = own.replace(/[^/]*$/, '');
  const version = (own.match(/\?.*$/) || [''])[0];

  const done = new Set();
  const pending = {};

  function inject(file) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.async = false; // dynamic scripts are async by default; false keeps the manifest order
      s.src = base + file + version;
      s.onload = () => { done.add(file); resolve(); };
      s.onerror = () => reject(new Error('Could not load ' + file));
      document.head.appendChild(s);
    });
  }

  function load(group) {
    const files = GROUPS[group];
    if (!files) return Promise.reject(new Error('Unknown script group: ' + group));
    if (pending[group]) return pending[group];
    // After a failure, start again at the first file that never loaded and
    // add everything after it again: a later file may already have run
    // without its dependency, and each file only assigns its own globals.
    const first = files.findIndex((f) => !done.has(f));
    const p = first < 0 ? Promise.resolve() : Promise.all(files.slice(first).map(inject)).then(() => {});
    pending[group] = p;
    p.catch(() => { delete pending[group]; });
    return p;
  }

  window.Lazy = { load, files: (group) => (GROUPS[group] || []).slice() };
})();
