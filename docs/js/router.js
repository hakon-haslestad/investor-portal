// Hash router for the SPA shell. Routes look like #/portfolio/holdings.
//
// A view is registered as window.Views[name] = async function (el, ctx) {…}
// where ctx = { store, me, params, path, navigate }. The router owns the
// top-level nav highlighting; sub-tabs are the view's own business.

(function () {
  // Top-level route table — drives both dispatch and the nav bar.
  // `match` is the first path segment; `view` keys into window.Views.
  const ROUTES = [
    { match: 'dashboard',    label: 'Dashboard',    view: 'dashboard' },
    { match: 'portfolio',    label: 'Portfolio',    view: 'portfolio' },
    { match: 'investors',    label: 'Investors',    view: 'investors' },
    { match: 'competitions', label: 'Competitions', view: 'competitions' },
    { match: 'game',         label: 'The Game',     view: 'game' },
    { match: 'accounting',   label: 'Accounting',   view: 'accounting', badge: 'beta' },
    { match: 'admin',        label: 'Admin',        view: 'admin', adminOnly: true },
  ];
  const DEFAULT = '#/dashboard';

  let ctxBase = null; // {store, me} — set once by app boot
  let current = { cleanup: null };

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

  function highlightNav(active) {
    document.querySelectorAll('#top-nav a[data-route]').forEach((a) => {
      const on = a.dataset.route === active;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  async function dispatch() {
    const { segs, query } = parseHash();
    if (!segs.length) { location.replace(DEFAULT); return; }
    const route = ROUTES.find((r) => r.match === segs[0]);
    if (!route) { location.replace(DEFAULT); return; }
    if (route.adminOnly && ctxBase.me.role !== 'admin') { location.replace(DEFAULT); return; }

    const view = window.Views[route.view];
    const el = document.getElementById('view');
    el.classList.remove('wide'); // views opt in per render
    if (typeof current.cleanup === 'function') { try { current.cleanup(); } catch (_e) {} }
    current.cleanup = null;
    highlightNav(route.match);
    el.innerHTML = '<div class="view-loading" role="status" aria-live="polite">Loading…</div>';
    el.focus({ preventScroll: true });
    window.scrollTo(0, 0);
    try {
      const cleanup = await view(el, {
        ...ctxBase,
        params: segs.slice(1),
        query,
        path: segs.join('/'),
        navigate,
      });
      if (typeof cleanup === 'function') current.cleanup = cleanup;
    } catch (e) {
      console.error(e);
      el.innerHTML = `<div class="flash error"><strong>This tab failed to load.</strong><br><code>${(e && e.message) || e}</code></div>`;
    }
  }

  function start(base) {
    ctxBase = base;
    window.addEventListener('hashchange', dispatch);
    dispatch();
  }

  window.Router = { ROUTES, start, navigate, parseHash };
})();
