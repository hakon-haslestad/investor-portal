// Shared number/HTML formatters. Ported from public/js/api.js.

(function () {
  function fmtNok(n) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    const v = Math.round(Number(n));
    return v.toLocaleString('nb-NO') + ' kr';
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

  window.Fmt = { fmtNok, fmtPct, fmtQty, pctClass, escapeHtml, PODIUM };
})();
