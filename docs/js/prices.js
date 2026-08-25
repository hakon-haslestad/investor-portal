// Price matrix — parses the `StockPrices` tab (rows = dates, columns =
// tickers + CUR:<PAIR>NOK FX columns, values = close in native currency)
// into forward-fillable per-column series.
//
// Every lookup forward-fills: priceOn(ticker, date) returns the last close
// at or before `date`. Holes (weekends, failed fetches, weekly-only sold
// stocks) are therefore harmless by construction.

(function () {
  const { excelDateToISO, numOrNull } = window.Parsers;

  // rows → { dates: [iso…] ascending, series: Map(column → [{d, v}…]) }
  function build(rows) {
    const empty = { dates: [], series: new Map(), latestDate: null, hasData: false };
    if (!rows || rows.length < 2) return empty;
    const header = rows[0].map((h) => String(h || '').trim());
    const parsed = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row) continue;
      const d = excelDateToISO(row[0]);
      if (!d) continue;
      parsed.push({ d, row });
    }
    parsed.sort((a, b) => a.d.localeCompare(b.d));
    const series = new Map();
    for (let c = 1; c < header.length; c++) {
      const col = header[c];
      if (!col) continue;
      const points = [];
      for (const { d, row } of parsed) {
        const v = numOrNull(row[c]);
        if (v != null) points.push({ d, v });
      }
      if (points.length) series.set(col, points);
    }
    const dates = parsed.map((p) => p.d);
    return {
      dates,
      series,
      latestDate: dates.length ? dates[dates.length - 1] : null,
      hasData: series.size > 0,
    };
  }

  // Last value at or before `date` (binary search). Null when the series is
  // empty or starts after `date`.
  function valueOn(points, date) {
    if (!points || !points.length) return null;
    let lo = 0, hi = points.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid].d <= date) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return best >= 0 ? points[best].v : null;
  }

  function priceOn(matrix, ticker, date) {
    return valueOn(matrix.series.get(ticker), date);
  }

  // Like valueOn, but when the series starts AFTER `date`, returns its first
  // value instead of null — for valuing dates before backfilled history
  // (better the earliest known close than a phantom 0).
  function valueAround(points, date) {
    const v = valueOn(points, date);
    if (v != null) return v;
    return points && points.length ? points[0].v : null;
  }

  // NOK price with the valueAround fallback on both the price and FX legs.
  function nokPriceAround(matrix, security, date) {
    if (!security || !security.ticker) return null;
    const px = valueAround(matrix.series.get(security.ticker), date);
    if (px == null) return null;
    const cur = (security.currency || 'NOK').toUpperCase();
    if (cur === 'NOK') return px;
    const fx = valueAround(matrix.series.get('CUR:' + cur + 'NOK'), date);
    return fx != null && fx > 0 ? px * fx : null;
  }

  function fxOn(matrix, currency, date) {
    const cur = (currency || 'NOK').toUpperCase();
    if (cur === 'NOK') return 1;
    const rate = valueOn(matrix.series.get('CUR:' + cur + 'NOK'), date);
    return rate != null && rate > 0 ? rate : null;
  }

  // NOK close for a security (registry entry) on a date. Null when either
  // the price series or a needed FX series has no data yet.
  function nokPriceOn(matrix, security, date) {
    if (!security || !security.ticker) return null;
    const px = priceOn(matrix, security.ticker, date);
    if (px == null) return null;
    const fx = fxOn(matrix, security.currency, date);
    if (fx == null) return null;
    return px * fx;
  }

  // Dates within [from, to] that have at least one value — the natural
  // sampling grid for daily charts.
  function datesBetween(matrix, from, to) {
    return matrix.dates.filter((d) => d >= from && d <= to);
  }

  window.Prices = { build, priceOn, fxOn, nokPriceOn, nokPriceAround, datesBetween, valueOn };
})();
