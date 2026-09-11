// Shared number/HTML formatters. Ported from public/js/api.js.

(function () {
  function fmtNok(n) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    const v = Math.round(Number(n));
    return v.toLocaleString('nb-NO') + ' kr';
  }
  // Condensed money for narrow screens: 412 300 kr → 412k. Used by the
  // always-visible (p1) columns of wide tables, which have to fit a phone.
  function fmtNokShort(n) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    const v = Number(n);
    const a = Math.abs(v);
    if (a < 10_000) return Math.round(v).toLocaleString('nb-NO');
    if (a < 1_000_000) return Math.round(v / 1000).toLocaleString('nb-NO') + 'k';
    return (v / 1_000_000).toFixed(a < 10_000_000 ? 1 : 0).replace('.', ',') + 'M';
  }
  // True while the viewport is too narrow for full-length money strings.
  function isNarrow() {
    return typeof window.matchMedia === 'function'
      && window.matchMedia('(max-width: 599px)').matches;
  }
  // fmtNok that condenses itself on a phone.
  function fmtNokFit(n) {
    return isNarrow() ? fmtNokShort(n) : fmtNok(n);
  }

  function fmtPct(n, sign = true) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    const v = Number(n);
    const s = sign && v > 0 ? '+' : '';
    return s + v.toFixed(1) + '%';
  }
  function fmtQty(n) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    const v = Number(n);
    if (Math.abs(v) < 1) return v.toFixed(2);
    return Math.round(v).toLocaleString('nb-NO');
  }
  function pctClass(n) {
    if (n == null || !Number.isFinite(Number(n))) return 'text-muted';
    const v = Number(n);
    if (v > 0.5) return 'positive';
    if (v < -0.5) return 'negative';
    return 'text-muted';
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const PODIUM = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];

  window.Fmt = { fmtNok, fmtNokShort, fmtNokFit, isNarrow, fmtPct, fmtQty, pctClass, escapeHtml, PODIUM };
})();
