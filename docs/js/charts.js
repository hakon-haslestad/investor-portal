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

    // Y gridlines + labels
    const yTicks = 5;
    for (let i = 0; i <= yTicks; i++) {
      const v = yMin + (yMax - yMin) * (i / yTicks);
      const y = PAD.top + h - (h * (v - yMin)) / (yMax - yMin);
      const line = svgEl('line', {
        x1: PAD.left, x2: PAD.left + w, y1: y, y2: y,
        stroke: '#262a36', 'stroke-width': 1, 'shape-rendering': 'crispEdges',
      });
      if (v === 0 && yMin < 0) line.setAttribute('stroke', '#8a92a6');
      g.appendChild(line);
      const label = svgEl('text', {
        x: PAD.left - 8, y: y + 4, 'text-anchor': 'end',
        fill: '#8a92a6', 'font-size': 10,
      });
      label.textContent = fmtNok(v);
      g.appendChild(label);
    }

    // X gridlines: one per year
    const startYear = tsToDate(xMin).getUTCFullYear();
    const endYear = tsToDate(xMax).getUTCFullYear();
    for (let y = startYear; y <= endYear; y++) {
      const t = Date.parse(`${y}-01-01`);
      if (t < xMin || t > xMax) continue;
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
      label.textContent = y;
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

  // series: [{ name, color, points: [{date, y}] }]
  function multiLine({ series, width = 900, height = 240, title }) {
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

    for (const s of series) {
      const pts = s.points.map((p) => ({ x: xScale(dateToTs(p.date)), y: yScale(p.y) }));
      const path = svgEl('path', {
        d: pathD(pts), fill: 'none', stroke: s.color, 'stroke-width': 2,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      });
      const t = svgEl('title');
      const lastY = s.points[s.points.length - 1].y;
      t.textContent = `${s.name}: ${fmtNok(lastY)} kr`;
      path.appendChild(t);
      g.appendChild(path);

      // End-of-line dot for affordance
      const last = pts[pts.length - 1];
      const dot = svgEl('circle', {
        cx: last.x, cy: last.y, r: 3.5, fill: s.color,
      });
      g.appendChild(dot);
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

  // series: [{ name, color }]
  function legend({ series }) {
    const wrap = document.createElement('div');
    wrap.className = 'chart-legend';
    for (const s of series) {
      const key = document.createElement('span');
      key.className = 'key';
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = s.color;
      const lbl = document.createElement('span');
      lbl.textContent = s.name;
      key.appendChild(sw);
      key.appendChild(lbl);
      wrap.appendChild(key);
    }
    return wrap;
  }

  window.Charts = { stackedArea, multiLine, legend };
})();
