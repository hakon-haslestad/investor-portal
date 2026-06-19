// Pure-SVG chart helpers. No libraries, no canvas, no event handlers beyond
// the browser-native <title> tooltip. Returns SVG elements ready to inject.
//
// All charts share:
//   - viewBox-based responsiveness (width/height are intrinsic, scaled by CSS)
//   - Inner padding for axis labels
//   - Y axis auto-scaled with a small headroom; X axis date-driven with yearly
//     gridlines.

(function () {
  const NS = 'http://www.w3.org/2000/svg';
  // Y-axis labels sit on the RIGHT (matches the price-chart design), so the
  // right pad is the wide one and the left pad is just a small gutter.
  const PAD = { top: 16, right: 60, bottom: 30, left: 16 };

  function svgEl(name, attrs) {
    const el = document.createElementNS(NS, name);
    if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  function dateToTs(d) { return Date.parse(d); }
  function tsToDate(t) { return new Date(t); }

  let mlGradSeq = 0; // unique gradient ids for single-series area fills

  function niceMax(v) {
    if (v <= 0) return 1;
    const exp = Math.pow(10, Math.floor(Math.log10(v)));
    const f = v / exp;
    let nice;
    if (f <= 1) nice = 1; else if (f <= 2) nice = 2; else if (f <= 5) nice = 5; else nice = 10;
    return nice * exp;
  }
  function niceMin(v) {
    if (v >= 0) return 0;
    return -niceMax(-v);
  }

  function fmtNok(n) {
    if (!Number.isFinite(n)) return '—';
    const abs = Math.abs(n);
    if (abs >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return (n / 1e3).toFixed(0) + 'k';
    return Math.round(n).toString();
  }

  function axes(g, xMin, xMax, yMin, yMax, width, height) {
    const w = width - PAD.left - PAD.right;
    const h = height - PAD.top - PAD.bottom;

    // Y gridlines + labels — 6 ticks, dashed for non-zero, solid for the zero line.
    const yTicks = 6;
    for (let i = 0; i <= yTicks; i++) {
      const v = yMin + (yMax - yMin) * (i / yTicks);
      const y = PAD.top + h - (h * (v - yMin)) / (yMax - yMin);
      const isZero = Math.abs(v) < 1e-9 && yMin < 0;
      const line = svgEl('line', {
        x1: PAD.left, x2: PAD.left + w, y1: y, y2: y,
        stroke: isZero ? '#525866' : '#2a2a2a',
        'stroke-width': 1,
        'shape-rendering': 'crispEdges',
      });
      g.appendChild(line);
      // Labels on the right of the plot.
      const label = svgEl('text', {
        x: PAD.left + w + 8, y: y + 4, 'text-anchor': 'start',
        fill: '#8a8a8a', 'font-size': 11, 'font-weight': 500,
      });
      label.textContent = fmtNok(v);
      g.appendChild(label);
    }

    // X gridlines: monthly when the span is shorter than ~2 years, otherwise yearly.
    const yearMs = 365.25 * 24 * 60 * 60 * 1000;
    const span = xMax - xMin;
    const ticks = [];
    if (span <= 2 * yearMs) {
      const start = tsToDate(xMin);
      let cursor = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1);
      // Density: skip months to keep <= ~12 ticks
      const months = Math.round(span / (yearMs / 12)) + 1;
      const step = months > 12 ? Math.ceil(months / 8) : 1;
      let i = 0;
      while (cursor <= xMax) {
        if (cursor >= xMin && (i % step === 0)) {
          const d = new Date(cursor);
          const lbl = d.toLocaleDateString('en', { month: 'short', year: '2-digit' });
          ticks.push({ t: cursor, lbl });
        }
        i++;
        const next = new Date(cursor);
        next.setUTCMonth(next.getUTCMonth() + 1);
        cursor = next.getTime();
      }
    } else {
      const startYear = tsToDate(xMin).getUTCFullYear();
      const endYear = tsToDate(xMax).getUTCFullYear();
      for (let y = startYear; y <= endYear; y++) {
        const t = Date.parse(`${y}-01-01`);
        if (t < xMin || t > xMax) continue;
        ticks.push({ t, lbl: String(y) });
      }
    }
    for (const { t, lbl } of ticks) {
      const xPos = PAD.left + (w * (t - xMin)) / (xMax - xMin);
      const line = svgEl('line', {
        x1: xPos, x2: xPos, y1: PAD.top, y2: PAD.top + h,
        stroke: '#2a2a2a', 'stroke-width': 1, 'shape-rendering': 'crispEdges',
      });
      g.appendChild(line);
      const label = svgEl('text', {
        x: xPos, y: PAD.top + h + 18, 'text-anchor': 'middle',
        fill: '#8a8a8a', 'font-size': 11, 'font-weight': 500,
      });
      label.textContent = lbl;
      g.appendChild(label);
    }
  }

  function pathD(points) {
    if (!points.length) return '';
    return points.map((p, i) => (i === 0 ? `M${p.x} ${p.y}` : `L${p.x} ${p.y}`)).join(' ');
  }

  function areaD(points, baselineY) {
    if (!points.length) return '';
    const top = points.map((p, i) => (i === 0 ? `M${p.x} ${p.y}` : `L${p.x} ${p.y}`)).join(' ');
    const last = points[points.length - 1];
    const first = points[0];
    return `${top} L${last.x} ${baselineY} L${first.x} ${baselineY} Z`;
  }

  // series: [{ name, color, points: [{date, y}] }]
  // Renders one stacked area per series; points must share x dates.
  function stackedArea({ series, width = 900, height = 240, title }) {
    const svg = svgEl('svg', {
      viewBox: `0 0 ${width} ${height}`, xmlns: NS,
      role: 'img', 'aria-label': title || 'stacked area chart',
    });
    if (!series.length || !series[0].points.length) {
      const t = svgEl('text', { x: width / 2, y: height / 2, fill: '#8a92a6', 'text-anchor': 'middle' });
      t.textContent = 'No data';
      svg.appendChild(t);
      return svg;
    }
    const dates = series[0].points.map((p) => dateToTs(p.date));
    const xMin = dates[0];
    const xMax = dates[dates.length - 1];
    // Compute stacked totals per index
    const n = series[0].points.length;
    const stacks = new Array(n).fill(0);
    let yMax = 0;
    for (const s of series) {
      for (let i = 0; i < n; i++) {
        stacks[i] += s.points[i].y;
        if (stacks[i] > yMax) yMax = stacks[i];
      }
    }
    yMax = niceMax(yMax);
    const yMin = 0;

    const w = width - PAD.left - PAD.right;
    const h = height - PAD.top - PAD.bottom;
    const xScale = (t) => PAD.left + (w * (t - xMin)) / (xMax - xMin || 1);
    const yScale = (v) => PAD.top + h - (h * (v - yMin)) / (yMax - yMin || 1);

    const g = svgEl('g');
    svg.appendChild(g);
    axes(g, xMin, xMax, yMin, yMax, width, height);

    // Stack accumulator per index
    const acc = new Array(n).fill(0);
    for (const s of series) {
      const top = [];
      const bottom = [];
      for (let i = 0; i < n; i++) {
        const x = xScale(dates[i]);
        const yBase = acc[i];
        const yTop = yBase + s.points[i].y;
        bottom.push({ x, y: yScale(yBase) });
        top.push({ x, y: yScale(yTop) });
        acc[i] = yTop;
      }
      const d = pathD(top.concat(bottom.slice().reverse())) + ' Z';
      const path = svgEl('path', {
        d, fill: s.color, opacity: 0.85, stroke: s.color, 'stroke-width': 0.5,
      });
      const t = svgEl('title');
      const lastY = s.points[n - 1].y;
      t.textContent = `${s.name}: ${fmtNok(lastY)} kr`;
      path.appendChild(t);
      g.appendChild(path);
    }

    if (title) {
      const tEl = svgEl('text', {
        x: PAD.left, y: 12, fill: '#e7e9ee', 'font-size': 12, 'font-weight': 600,
      });
      tEl.textContent = title;
      svg.appendChild(tEl);
    }
    return svg;
  }

  function fmtNokFull(n) {
    if (!Number.isFinite(n)) return '—';
    return Math.round(n).toLocaleString('nb-NO') + ' kr';
  }

  // series: [{ name, color, points: [{date, y}] }]
  // When interactive=true, hovering the chart shows a crosshair, per-series
  // dots, and a floating tooltip listing every investor's value at that date.
  function multiLine({ series, width = 900, height = 240, title, interactive = false }) {
    const svg = svgEl('svg', {
      viewBox: `0 0 ${width} ${height}`, xmlns: NS,
      role: 'img', 'aria-label': title || 'line chart',
    });
    if (!series.length || !series[0].points.length) {
      const t = svgEl('text', { x: width / 2, y: height / 2, fill: '#8a92a6', 'text-anchor': 'middle' });
      t.textContent = 'No data';
      svg.appendChild(t);
      return svg;
    }
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const s of series) {
      for (const p of s.points) {
        const t = dateToTs(p.date);
        if (t < xMin) xMin = t;
        if (t > xMax) xMax = t;
        if (p.y < yMin) yMin = p.y;
        if (p.y > yMax) yMax = p.y;
      }
    }
    yMax = niceMax(yMax);
    yMin = niceMin(yMin);
    if (yMin === yMax) yMax = yMin + 1;

    const w = width - PAD.left - PAD.right;
    const h = height - PAD.top - PAD.bottom;
    const xScale = (t) => PAD.left + (w * (t - xMin)) / (xMax - xMin || 1);
    const yScale = (v) => PAD.top + h - (h * (v - yMin)) / (yMax - yMin || 1);

    const g = svgEl('g');
    svg.appendChild(g);
    axes(g, xMin, xMax, yMin, yMax, width, height);

    // All series share the same x dates (built from the same replay).
    const dates = series[0].points.map((p) => p.date);
    const xCoords = dates.map((d) => xScale(dateToTs(d)));
    const seriesPts = series.map((s) =>
      s.points.map((p) => ({ x: xScale(dateToTs(p.date)), y: yScale(p.y), raw: p }))
    );

    // Every timeline gets the price-chart area fill (series-color gradient
    // under the line) so the whole portal shares one look. A single series
    // uses the full design opacity; multi-series use a lighter fill so the
    // overlapping areas don't muddy the comparison. Fills are drawn first so
    // all lines stay crisp on top.
    const fillTopOpacity = series.length === 1 ? '0.18' : '0.16';
    for (let i = 0; i < series.length; i++) {
      const gradId = `mlGrad${mlGradSeq++}`;
      const defs = svgEl('defs');
      const grad = svgEl('linearGradient', { id: gradId, x1: '0', y1: '0', x2: '0', y2: '1' });
      grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': series[i].color, 'stop-opacity': fillTopOpacity }));
      grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': series[i].color, 'stop-opacity': '0' }));
      defs.appendChild(grad);
      g.appendChild(defs);
      g.appendChild(svgEl('path', { d: areaD(seriesPts[i], PAD.top + h), fill: `url(#${gradId})` }));
    }

    for (let i = 0; i < series.length; i++) {
      const s = series[i];
      const pts = seriesPts[i];
      const path = svgEl('path', {
        d: pathD(pts), fill: 'none', stroke: s.color, 'stroke-width': 2.5,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      });
      g.appendChild(path);
      const last = pts[pts.length - 1];
      g.appendChild(svgEl('circle', { cx: last.x, cy: last.y, r: 4, fill: s.color, stroke: '#0e0f13', 'stroke-width': 1.5 }));
    }

    if (title) {
      const tEl = svgEl('text', {
        x: PAD.left, y: 12, fill: '#e7e9ee', 'font-size': 12, 'font-weight': 600,
      });
      tEl.textContent = title;
      svg.appendChild(tEl);
    }

    if (!interactive) return svg;

    // ─── Hover layer ─────────────────────────────────────────────────────
    const hover = svgEl('g', { 'pointer-events': 'none', visibility: 'hidden' });
    svg.appendChild(hover);

    const crosshair = svgEl('line', {
      x1: 0, x2: 0, y1: PAD.top, y2: PAD.top + h,
      stroke: '#8a92a6', 'stroke-width': 1, 'stroke-dasharray': '3,3',
    });
    hover.appendChild(crosshair);

    const dots = series.map((s) => {
      const c = svgEl('circle', {
        cx: 0, cy: 0, r: 5, fill: s.color, stroke: '#0e0f13', 'stroke-width': 2,
      });
      hover.appendChild(c);
      return c;
    });

    // Tooltip box: date header + one row per investor
    const TIP_PAD = 8;
    const TIP_ROW_H = 14;
    const TIP_W = 250;
    const TIP_H = TIP_PAD * 2 + TIP_ROW_H * (series.length + 1) + 4;

    const tipBg = svgEl('rect', {
      x: 0, y: 0, width: TIP_W, height: TIP_H,
      rx: 6, ry: 6, fill: '#181a22', stroke: '#262a36', 'stroke-width': 1,
      opacity: 0.97,
    });
    hover.appendChild(tipBg);

    const tipDate = svgEl('text', { x: 0, y: 0, fill: '#e7e9ee', 'font-size': 11, 'font-weight': 700 });
    hover.appendChild(tipDate);

    const rows = series.map((s) => {
      const sw = svgEl('rect', { x: 0, y: 0, width: 8, height: 8, fill: s.color, rx: 1, ry: 1 });
      hover.appendChild(sw);
      const nm = svgEl('text', { x: 0, y: 0, fill: '#e7e9ee', 'font-size': 10 });
      hover.appendChild(nm);
      const vl = svgEl('text', { x: 0, y: 0, fill: '#e7e9ee', 'font-size': 10, 'font-weight': 600, 'text-anchor': 'end' });
      hover.appendChild(vl);
      return { sw, nm, vl };
    });

    // Transparent overlay that captures pointer events across the plot area.
    const overlay = svgEl('rect', {
      x: PAD.left, y: PAD.top, width: w, height: h,
      fill: 'transparent', 'pointer-events': 'all',
    });
    svg.appendChild(overlay);

    function clientToSvg(evt) {
      const pt = svg.createSVGPoint();
      pt.x = evt.clientX; pt.y = evt.clientY;
      const ctm = svg.getScreenCTM();
      if (!ctm) return { x: 0, y: 0 };
      const out = pt.matrixTransform(ctm.inverse());
      return { x: out.x, y: out.y };
    }
    function nearestIndex(xUser) {
      let best = 0, bestDist = Math.abs(xCoords[0] - xUser);
      for (let i = 1; i < xCoords.length; i++) {
        const d = Math.abs(xCoords[i] - xUser);
        if (d < bestDist) { bestDist = d; best = i; }
      }
      return best;
    }
    function show(idx) {
      hover.setAttribute('visibility', 'visible');
      const x = xCoords[idx];
      crosshair.setAttribute('x1', x);
      crosshair.setAttribute('x2', x);
      for (let i = 0; i < series.length; i++) {
        const pt = seriesPts[i][idx];
        dots[i].setAttribute('cx', pt.x);
        dots[i].setAttribute('cy', pt.y);
      }
      // Position tooltip right of crosshair unless that pushes it off-canvas.
      let tipX = x + 12;
      if (tipX + TIP_W > width - PAD.right) tipX = x - 12 - TIP_W;
      if (tipX < PAD.left) tipX = PAD.left;
      const tipY = PAD.top + 8;
      tipBg.setAttribute('x', tipX);
      tipBg.setAttribute('y', tipY);
      tipDate.setAttribute('x', tipX + TIP_PAD);
      tipDate.setAttribute('y', tipY + TIP_PAD + 10);
      tipDate.textContent = dates[idx];
      for (let i = 0; i < series.length; i++) {
        const rowY = tipY + TIP_PAD + 10 + TIP_ROW_H * (i + 1) + 2;
        const r = rows[i];
        r.sw.setAttribute('x', tipX + TIP_PAD);
        r.sw.setAttribute('y', rowY - 8);
        r.nm.setAttribute('x', tipX + TIP_PAD + 14);
        r.nm.setAttribute('y', rowY);
        r.nm.textContent = series[i].name;
        r.vl.setAttribute('x', tipX + TIP_W - TIP_PAD);
        r.vl.setAttribute('y', rowY);
        // Value + % change since the start of the visible series. When the
        // series is rebased to 0 at the start (cumulative P/L), the value is
        // itself the change, so the % is meaningless — show value only.
        const yv = series[i].points[idx].y;
        const base = series[i].points[0].y;
        let txt = fmtNokFull(yv);
        if (Math.abs(base) >= 1) {
          const pc = ((yv - base) / Math.abs(base)) * 100;
          txt += `  ${pc >= 0 ? '+' : ''}${pc.toFixed(1)}%`;
        }
        r.vl.textContent = txt;
      }
    }
    function hide() { hover.setAttribute('visibility', 'hidden'); }

    overlay.addEventListener('mousemove', (evt) => {
      const { x } = clientToSvg(evt);
      show(nearestIndex(x));
    });
    overlay.addEventListener('mouseleave', hide);
    overlay.addEventListener('touchstart', (evt) => {
      if (!evt.touches[0]) return;
      const { x } = clientToSvg(evt.touches[0]);
      show(nearestIndex(x));
    }, { passive: true });
    overlay.addEventListener('touchmove', (evt) => {
      if (!evt.touches[0]) return;
      const { x } = clientToSvg(evt.touches[0]);
      show(nearestIndex(x));
    }, { passive: true });
    overlay.addEventListener('touchend', hide);
    overlay.style.cursor = 'crosshair';

    return svg;
  }

  // series: [{ code?, name, color, valueText? }]
  // When onSelect + code are provided, each key becomes clickable. Keys whose
  // code is in selectedCodes get the "selected" class; the rest get "dimmed"
  // (when there's any selection at all). Supports multi-select.
  function legend({ series, selectedCodes, onSelect }) {
    const active = Array.isArray(selectedCodes) ? selectedCodes
      : (selectedCodes ? [selectedCodes] : []);
    const wrap = document.createElement('div');
    wrap.className = 'chart-legend';
    for (const s of series) {
      const key = document.createElement('div');
      key.className = 'key';
      if (s.code) key.dataset.code = s.code;
      if (active.length && s.code) {
        key.classList.add(active.includes(s.code) ? 'selected' : 'dimmed');
      }
      if (onSelect && s.code) {
        key.classList.add('clickable');
        key.addEventListener('click', () => onSelect(s.code));
      }
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = s.color;
      const lbl = document.createElement('span');
      lbl.className = 'name';
      lbl.textContent = s.name;
      key.appendChild(sw);
      key.appendChild(lbl);
      if (s.valueText) {
        const v = document.createElement('span');
        v.className = 'v';
        v.textContent = s.valueText;
        key.appendChild(v);
      }
      wrap.appendChild(key);
    }
    return wrap;
  }

  // Single-security price chart: teal area + angular line, right-side y-axis
  // labels, and buy (blue) / sell (red) dot markers placed at their trade date.
  // points:  [{ date, price }]  (sorted ascending by date)
  // markers: [{ date, type: 'buy' | 'sell' }]
  let priceGradSeq = 0;
  function priceChart(opts) {
    const {
      points = [], markers = [],
      width = 1180, height = 440,
      line = '#1FE0CE', fillTop = 'rgba(31,224,206,0.16)', fillBottom = 'rgba(31,224,206,0)',
      buy = '#2D5BFF', sell = '#FF3B3B',
    } = opts || {};
    const PADP = { top: 30, right: 70, bottom: 48, left: 12 };
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    // When the series spans more than one calendar year, tack a 2-digit year
    // onto each date label (e.g. "3 Mar '24") so the axis isn't ambiguous.
    const yearOf = (iso) => Number(String(iso).slice(0, 4));
    const crossesYears = points.length >= 2 && yearOf(points[0].date) !== yearOf(points[points.length - 1].date);
    const fmtDate = (iso) => {
      const d = new Date(iso);
      const base = `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
      return crossesYears ? `${base} '${String(d.getUTCFullYear()).slice(2)}` : base;
    };
    const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, xmlns: NS, role: 'img', 'aria-label': 'Price chart' });

    if (points.length < 2) {
      const t = svgEl('text', { x: width / 2, y: height / 2, fill: '#8a8a8a', 'text-anchor': 'middle' });
      t.textContent = 'Not enough price history in this window';
      svg.appendChild(t);
      return svg;
    }

    const plotW = width - PADP.left - PADP.right;
    const plotH = height - PADP.top - PADP.bottom;
    const xMin = dateToTs(points[0].date);
    const xMax = dateToTs(points[points.length - 1].date);
    const prices = points.map((p) => p.price).filter((v) => Number.isFinite(v));
    let lo = Math.min(...prices), hi = Math.max(...prices);
    const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.05 || 1;
    lo -= pad; hi += pad;

    const xAt = (ts) => PADP.left + (xMax > xMin ? (ts - xMin) / (xMax - xMin) : 0) * plotW;
    const yAt = (v) => PADP.top + (1 - (v - lo) / (hi - lo)) * plotH;

    const linePath = points
      .map((p, i) => `${i ? 'L' : 'M'}${xAt(dateToTs(p.date)).toFixed(2)},${yAt(p.price).toFixed(2)}`)
      .join(' ');
    const areaPath = `${linePath} L${xAt(xMax).toFixed(2)},${(PADP.top + plotH).toFixed(2)} `
      + `L${PADP.left.toFixed(2)},${(PADP.top + plotH).toFixed(2)} Z`;

    const gradId = `priceGrad${priceGradSeq++}`;
    const defs = svgEl('defs');
    const grad = svgEl('linearGradient', { id: gradId, x1: '0', y1: '0', x2: '0', y2: '1' });
    grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': fillTop }));
    grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': fillBottom }));
    defs.appendChild(grad);
    svg.appendChild(defs);

    // Horizontal gridlines at each y tick (faint), drawn under the area.
    for (let i = 0; i < 4; i++) {
      const v = lo + ((hi - lo) * i) / 3;
      svg.appendChild(svgEl('line', {
        x1: PADP.left, x2: width - PADP.right, y1: yAt(v).toFixed(1), y2: yAt(v).toFixed(1),
        stroke: '#2a2a2a', 'stroke-width': '1', 'shape-rendering': 'crispEdges',
      }));
    }

    svg.appendChild(svgEl('path', { d: areaPath, fill: `url(#${gradId})` }));
    svg.appendChild(svgEl('path', {
      d: linePath, fill: 'none', stroke: line, 'stroke-width': '2.5',
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));

    // Y-axis labels on the right (stock value, 4 ticks).
    for (let i = 0; i < 4; i++) {
      const v = lo + ((hi - lo) * i) / 3;
      const t = svgEl('text', {
        x: width - PADP.right + 14, y: (yAt(v) + 8).toFixed(1),
        fill: '#8a8a8a', 'font-size': '22', 'font-weight': '500',
      });
      t.textContent = Math.round(v).toString();
      svg.appendChild(t);
    }

    // X-axis labels (time): up to 5 evenly spaced dates along the bottom.
    const nLabels = Math.min(5, points.length);
    const baseY = PADP.top + plotH;
    for (let k = 0; k < nLabels; k++) {
      const ts = xMin + ((xMax - xMin) * k) / (nLabels - 1);
      const cx = xAt(ts);
      svg.appendChild(svgEl('line', {
        x1: cx.toFixed(1), x2: cx.toFixed(1), y1: baseY + 6, y2: baseY + 12,
        stroke: '#3a3a3a', 'stroke-width': '2',
      }));
      const anchor = k === 0 ? 'start' : (k === nLabels - 1 ? 'end' : 'middle');
      const t = svgEl('text', {
        x: cx.toFixed(1), y: baseY + 34, fill: '#8a8a8a', 'font-size': '22',
        'font-weight': '500', 'text-anchor': anchor,
      });
      t.textContent = fmtDate(new Date(ts).toISOString().slice(0, 10));
      svg.appendChild(t);
    }

    // Nearest price point for a given marker date (for the dot's y position).
    const priceAt = (ts) => {
      let best = points[0], bestD = Infinity;
      for (const p of points) {
        const d = Math.abs(dateToTs(p.date) - ts);
        if (d < bestD) { bestD = d; best = p; }
      }
      return best.price;
    };
    for (const m of markers) {
      const ts = dateToTs(m.date);
      const cx = xAt(ts), cy = yAt(priceAt(ts));
      const color = m.type === 'sell' ? sell : buy;
      svg.appendChild(svgEl('circle', { cx: cx.toFixed(1), cy: cy.toFixed(1), r: '11', fill: color, opacity: '0.25' }));
      svg.appendChild(svgEl('circle', { cx: cx.toFixed(1), cy: cy.toFixed(1), r: '7', fill: color, stroke: '#fff', 'stroke-width': '1.5' }));
    }

    // ─── Hover: crosshair + dot + tooltip (value & % change since start) ────
    const xs = points.map((p) => xAt(dateToTs(p.date)));
    const base = points[0].price;
    const hover = svgEl('g', { 'pointer-events': 'none', visibility: 'hidden' });
    svg.appendChild(hover);
    const cross = svgEl('line', { y1: PADP.top, y2: PADP.top + plotH, stroke: '#8a8a8a', 'stroke-width': '1', 'stroke-dasharray': '4,4' });
    hover.appendChild(cross);
    const dot = svgEl('circle', { r: '6', fill: line, stroke: '#fff', 'stroke-width': '1.5' });
    hover.appendChild(dot);
    const TIPW = 240, TIPH = 96;
    const bg = svgEl('rect', { width: TIPW, height: TIPH, rx: '8', ry: '8', fill: '#181a22', stroke: '#262a36', 'stroke-width': '1', opacity: '0.97' });
    hover.appendChild(bg);
    const tDate = svgEl('text', { fill: '#8a8a8a', 'font-size': '20' }); hover.appendChild(tDate);
    const tPrice = svgEl('text', { fill: '#e7e9ee', 'font-size': '26', 'font-weight': '700' }); hover.appendChild(tPrice);
    const tPct = svgEl('text', { 'font-size': '22', 'font-weight': '600' }); hover.appendChild(tPct);
    const overlay = svgEl('rect', { x: PADP.left, y: PADP.top, width: plotW, height: plotH, fill: 'transparent', 'pointer-events': 'all' });
    svg.appendChild(overlay);

    const toSvgX = (evt) => {
      const pt = svg.createSVGPoint();
      pt.x = evt.clientX; pt.y = evt.clientY;
      const m = svg.getScreenCTM();
      if (!m) return 0;
      return pt.matrixTransform(m.inverse()).x;
    };
    const nearest = (xu) => {
      let b = 0, bd = Math.abs(xs[0] - xu);
      for (let i = 1; i < xs.length; i++) { const d = Math.abs(xs[i] - xu); if (d < bd) { bd = d; b = i; } }
      return b;
    };
    const show = (i) => {
      hover.setAttribute('visibility', 'visible');
      const p = points[i]; const x = xs[i]; const y = yAt(p.price);
      cross.setAttribute('x1', x); cross.setAttribute('x2', x);
      dot.setAttribute('cx', x); dot.setAttribute('cy', y);
      let tx = x + 14;
      if (tx + TIPW > width - PADP.right) tx = x - 14 - TIPW;
      if (tx < PADP.left) tx = PADP.left;
      const ty = PADP.top + 6;
      bg.setAttribute('x', tx); bg.setAttribute('y', ty);
      tDate.setAttribute('x', tx + 14); tDate.setAttribute('y', ty + 26); tDate.textContent = fmtDate(p.date);
      tPrice.setAttribute('x', tx + 14); tPrice.setAttribute('y', ty + 56);
      tPrice.textContent = Math.round(p.price).toLocaleString('en-US').replace(/,/g, ' ');
      const pct = base ? ((p.price - base) / Math.abs(base)) * 100 : 0;
      tPct.setAttribute('x', tx + 14); tPct.setAttribute('y', ty + 82);
      tPct.setAttribute('fill', pct > 0.05 ? '#3ee07f' : pct < -0.05 ? '#ff7a7a' : '#8a8a8a');
      tPct.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% since start`;
    };
    const hide = () => hover.setAttribute('visibility', 'hidden');
    overlay.addEventListener('mousemove', (e) => show(nearest(toSvgX(e))));
    overlay.addEventListener('mouseleave', hide);
    overlay.addEventListener('touchstart', (e) => { if (e.touches[0]) show(nearest(toSvgX(e.touches[0]))); }, { passive: true });
    overlay.addEventListener('touchmove', (e) => { if (e.touches[0]) show(nearest(toSvgX(e.touches[0]))); }, { passive: true });
    overlay.addEventListener('touchend', hide);
    overlay.style.cursor = 'crosshair';

    return svg;
  }

  // Trade timeline: every buy/sell as a dot over [from, to]. x = date,
  // y = signed NOK (buys up / sells down) around a zero line, radius ∝ √amount.
  // trades: [{ date, amount (abs NOK), type: 'buy'|'sell', label }]
  function tradeScatter(opts) {
    const {
      trades = [], from, to, width = 1100, height = 420,
      buy = '#2D5BFF', sell = '#FF3B3B',
    } = opts || {};
    const PADT = { top: 24, right: 70, bottom: 46, left: 12 };
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const fmtDate = (iso) => { const d = new Date(iso); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
    const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, xmlns: NS, role: 'img', 'aria-label': 'Trades' });

    if (!trades.length) {
      const t = svgEl('text', { x: width / 2, y: height / 2, fill: '#8a8a8a', 'text-anchor': 'middle', 'font-size': '20' });
      t.textContent = 'No buys or sells in this period';
      svg.appendChild(t);
      return svg;
    }

    const plotW = width - PADT.left - PADT.right;
    const plotH = height - PADT.top - PADT.bottom;
    const xMin = dateToTs(from || trades[0].date);
    const xMax = dateToTs(to || trades[trades.length - 1].date);
    const maxAbs = Math.max(...trades.map((t) => Math.abs(t.amount) || 0), 1);
    const yMax = niceMax(maxAbs);
    const xAt = (ts) => PADT.left + (xMax > xMin ? (ts - xMin) / (xMax - xMin) : 0.5) * plotW;
    const yAt = (v) => PADT.top + (1 - (v + yMax) / (2 * yMax)) * plotH; // [-yMax, +yMax]

    // Gridlines + right-side NOK labels at -yMax, -½, 0, +½, +yMax.
    for (const v of [yMax, yMax / 2, 0, -yMax / 2, -yMax]) {
      svg.appendChild(svgEl('line', {
        x1: PADT.left, x2: PADT.left + plotW, y1: yAt(v).toFixed(1), y2: yAt(v).toFixed(1),
        stroke: v === 0 ? '#525866' : '#2a2a2a', 'stroke-width': '1', 'shape-rendering': 'crispEdges',
      }));
      const lbl = svgEl('text', {
        x: width - PADT.right + 12, y: (yAt(v) + 5).toFixed(1), fill: '#8a8a8a',
        'font-size': '17', 'font-weight': '500',
      });
      lbl.textContent = fmtNok(v);
      svg.appendChild(lbl);
    }

    // X date ticks (up to 6).
    const nx = 6;
    for (let k = 0; k < nx; k++) {
      const ts = xMin + ((xMax - xMin) * k) / (nx - 1);
      const cx = xAt(ts);
      svg.appendChild(svgEl('line', { x1: cx.toFixed(1), x2: cx.toFixed(1), y1: PADT.top + plotH + 6, y2: PADT.top + plotH + 12, stroke: '#3a3a3a', 'stroke-width': '2' }));
      const anchor = k === 0 ? 'start' : (k === nx - 1 ? 'end' : 'middle');
      const t = svgEl('text', { x: cx.toFixed(1), y: PADT.top + plotH + 32, fill: '#8a8a8a', 'font-size': '17', 'font-weight': '500', 'text-anchor': anchor });
      t.textContent = fmtDate(new Date(ts).toISOString().slice(0, 10));
      svg.appendChild(t);
    }

    // Dots — larger amounts drawn first so small ones stay clickable on top.
    const sorted = trades.slice().sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
    for (const tr of sorted) {
      const amt = Math.abs(tr.amount) || 0;
      const cx = xAt(dateToTs(tr.date));
      const cy = yAt(tr.type === 'buy' ? amt : -amt);
      const r = Math.max(6, Math.min(22, Math.sqrt(amt / maxAbs) * 22));
      const color = tr.type === 'sell' ? sell : buy;
      const c = svgEl('circle', { cx: cx.toFixed(1), cy: cy.toFixed(1), r: r.toFixed(1), fill: color, 'fill-opacity': '0.8', stroke: '#fff', 'stroke-width': '1.2' });
      const title = svgEl('title');
      title.textContent = `${tr.label || ''} · ${tr.date} · ${tr.type === 'sell' ? 'Sold' : 'Bought'} ${fmtNok(amt)}`;
      c.appendChild(title);
      svg.appendChild(c);
    }
    return svg;
  }

  window.Charts = { stackedArea, multiLine, legend, priceChart, tradeScatter };
})();
