// Hash router for the SPA shell. Routes look like #/portfolio/holdings.
//
// A view is registered as window.Views[name] = async function (el, ctx) {…}
// where ctx = { store, me, params, path, navigate }. The router owns the
// top-level nav highlighting; sub-tabs are the view's own business.

(function () {
  // Top-level route table — drives both dispatch and the nav bar.
  // `match` is the first path segment; `view` keys into window.Views.
  const GROUPS = [
    { id: 'overview',    label: 'Overview' },
    { id: 'investments', label: 'Investments' },
    { id: 'club',        label: 'Club' },
    { id: 'books',       label: 'Books' },
    { id: 'admin',       label: 'Admin' },
  ];
  const ROUTES = [
    { match: 'board',        label: 'Board',        view: 'board',        group: 'overview' },
    { match: 'dashboard',    label: 'Dashboard',    view: 'dashboard',    group: 'overview' },
    { match: 'portfolio',    label: 'Portfolio',    view: 'portfolio',    group: 'investments' },
    { match: 'investors',    label: 'Investors',    view: 'investors',    group: 'club' },
    { match: 'competitions', label: 'Competitions', view: 'competitions', group: 'club' },
    { match: 'games',        label: 'Games',        view: 'games',        group: 'club', lazy: 'games' },
    // Reachable by link/QR from a hosted game; no nav tab of its own. The Club
    // row carries a "Join a game" entry (JOIN_ENTRY) that points here.
    { match: 'play',         label: 'Play',         view: 'play', group: 'club', hidden: true },
    { match: 'accounting',   label: 'Accounting',   view: 'accounting', group: 'books', badge: 'beta', lazy: 'books' },
    { match: 'admin',        label: 'Admin',        view: 'admin', group: 'admin', adminOnly: true },
  ];
  // Never highlighted: #/play highlights the Club group only.
  const JOIN_ENTRY = { match: 'join', label: 'Join a game', href: '#/play', group: 'club' };
  const DEFAULT = '#/dashboard';

  let ctxBase = null; // {store, me} — set once by app boot
  let current = { cleanup: null };
  let booted = false;
  let seq = 0; // the latest dispatch; an older one stops after its awaits

  function parseHash() {
    const raw = (location.hash || '').replace(/^#\/?/, '');
    const [pathPart, queryPart] = raw.split('?');
    const segs = pathPart.split('/').filter(Boolean);
    const query = {};
    if (queryPart) {
      for (const [k, v] of new URLSearchParams(queryPart)) query[k] = v;
    }
    return { segs, query };
  }

  function navigate(path) {
    location.hash = path.startsWith('#') ? path : '#/' + path.replace(/^\//, '');
  }

  function groupOf(match) {
    const r = ROUTES.find((x) => x.match === match);
    return r ? r.group : null;
  }

  // Groups visible to a role, each with its entries and a link to its first entry.
  function groupsFor(role) {
    const ok = (r) => !r.adminOnly || role === 'admin';
    return GROUPS.map((g) => {
      const entries = ROUTES.filter((r) => r.group === g.id && !r.hidden && ok(r))
        .map((r) => ({ match: r.match, label: r.label, href: '#/' + r.match, badge: r.badge }));
      if (g.id === JOIN_ENTRY.group) entries.push({ match: JOIN_ENTRY.match, label: JOIN_ENTRY.label, href: JOIN_ENTRY.href });
      return { id: g.id, label: g.label, href: entries.length ? entries[0].href : '#/', entries };
    }).filter((g) => g.entries.length);
  }

  function highlightNav(active) {
    const group = groupOf(active);
    const blocks = Array.from(document.querySelectorAll('#sub-nav [data-group-entries]'));
    // A group with a second row is "true" (the entry carries "page"); a single-entry group is the page itself.
    const hasSub = blocks.some((b) => b.dataset.groupEntries === group);
    const mark = (a, on, val) => {
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', val || 'page');
      else a.removeAttribute('aria-current');
    };
    document.querySelectorAll('#top-nav a[data-group]').forEach((a) => mark(a, a.dataset.group === group, hasSub ? 'true' : 'page'));
    let shown = false;
    blocks.forEach((b) => {
      b.hidden = b.dataset.groupEntries !== group;
      if (!b.hidden) shown = true;
    });
    document.querySelectorAll('#sub-nav a[data-route]').forEach((a) => mark(a, a.dataset.route === active));
    const sub = document.getElementById('sub-nav');
    if (sub) sub.hidden = !shown;
  }

  async function dispatch() {
    const { segs, query } = parseHash();
    if (!segs.length) { location.replace(DEFAULT); return; }
    // #/game was the old single-game route; keep shared links working.
    if (segs[0] === 'game') { location.replace('#/games' + (segs[1] ? '/' + segs[1] : '')); return; }
    const route = ROUTES.find((r) => r.match === segs[0]);
    if (!route) { location.replace(DEFAULT); return; }
    if (route.adminOnly && ctxBase.me.role !== 'admin') { location.replace(DEFAULT); return; }

    const mine = ++seq;
    const el = document.getElementById('view');
    el.classList.remove('wide'); // views opt in per render
    if (typeof current.cleanup === 'function') { try { current.cleanup(); } catch (_e) {} }
    current.cleanup = null;
    highlightNav(route.match);
    document.title = route.label + ' - Investor Portal';
    const status = document.getElementById('route-status');
    if (status) status.textContent = '';
    el.innerHTML = window.UI.skeleton('view');
    // Not on the first load: focus on #view there would start Tab after the skip link.
    if (booted) el.focus({ preventScroll: true });
    booted = true;
    window.scrollTo(0, 0);
    try {
      // Files only this route needs (see lazy.js); a failure lands in the catch below.
      if (route.lazy) {
        await window.Lazy.load(route.lazy);
        if (mine !== seq) return;
      }
      const cleanup = await window.Views[route.view](el, {
        ...ctxBase,
        params: segs.slice(1),
        query,
        path: segs.join('/'),
        navigate,
      });
      if (typeof cleanup === 'function') current.cleanup = cleanup;
      if (status) status.textContent = route.label + ' loaded';
    } catch (e) {
      console.error(e);
      if (status) status.textContent = route.label + ' failed to load';
      el.innerHTML = window.UI.loadError(e, route.label.toLowerCase());
    }
  }

  function start(base) {
    ctxBase = base;
    // Delegated once on #view — it survives every innerHTML re-render, so
    // views never have to wire up their own table expanders.
    window.UI.bindRowExpanders(document.getElementById('view'));
    // The skip link is a button-like anchor: a real #view href would change the hash route.
    const skip = document.getElementById('skip-link');
    if (skip) skip.addEventListener('click', (e) => { e.preventDefault(); document.getElementById('view').focus(); });
    window.addEventListener('hashchange', dispatch);
    dispatch();
  }

  window.Router = { ROUTES, GROUPS, groupOf, groupsFor, start, navigate, parseHash, reload: dispatch };
})();
