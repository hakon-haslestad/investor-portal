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
  const PAD = { top: 16, right: 16, bottom: 28, left: 64 };

  function svgEl(name, attrs) {
    const el = document.createElementNS(NS, name);
    if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  function dateToTs(d) { return Date.parse(d); }
  function tsToDate(t) { return new Date(t); }

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
        stroke: isZero ? '#525866' : '#262a36',
        'stroke-width': isZero ? 1 : 1,
        'shape-rendering': 'crispEdges',
      });
      if (!isZero) line.setAttribute('stroke-dasharray', '2,4');
      g.appendChild(line);
      const label = svgEl('text', {
        x: PAD.left - 8, y: y + 4, 'text-anchor': 'end',
        fill: '#8a92a6', 'font-size': 10,
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
        stroke: '#262a36', 'stroke-width': 1, 'shape-rendering': 'crispEdges',
      });
      g.appendChild(line);
      const label = svgEl('text', {
        x: xPos, y: PAD.top + h + 16, 'text-anchor': 'middle',
        fill: '#8a92a6', 'font-size': 10,
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
    const TIP_W = 200;
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
        r.vl.textContent = fmtNokFull(series[i].points[idx].y);
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
  // When onSelect + code are provided, each key becomes clickable; the entry
  // whose code matches selectedCode renders with the "selected" class, others
  // with "dimmed" — useful for cross-filtering a dashboard.
  function legend({ series, selectedCode, onSelect }) {
    const wrap = document.createElement('div');
    wrap.className = 'chart-legend';
    for (const s of series) {
      const key = document.createElement('div');
      key.className = 'key';
      if (s.code) key.dataset.code = s.code;
      if (selectedCode && s.code) {
        key.classList.add(s.code === selectedCode ? 'selected' : 'dimmed');
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

  window.Charts = { stackedArea, multiLine, legend };
})();
