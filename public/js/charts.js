// Shared Chart.js theme + helpers. Loaded after chart.umd.min.js, before any
// page-specific script that calls into it.

const CHART_THEME = {
  text: '#e7e9ee',
  muted: '#8a92a6',
  grid: 'rgba(255,255,255,0.06)',
  positive: '#3ee07f',
  negative: '#ff7a7a',
  accent2: '#ffc94f',
  link: '#6ad1ff',
};

// One stable colour per investor — used across all charts so HH is always the
// same colour on the equity story as on the bar chart.
const INVESTOR_COLOURS = {
  HH: '#3ee07f',
  HS: '#6ad1ff',
  ØS: '#ffc94f',
  JC: '#c792ff',
  HF: '#ff8d6b',
};

function applyChartDefaults() {
  if (typeof Chart === 'undefined') return;
  Chart.defaults.color = CHART_THEME.muted;
  Chart.defaults.borderColor = CHART_THEME.grid;
  Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.plugins.legend.labels.color = CHART_THEME.text;
  Chart.defaults.plugins.tooltip.backgroundColor = '#1f222d';
  Chart.defaults.plugins.tooltip.borderColor = '#262a36';
  Chart.defaults.plugins.tooltip.borderWidth = 1;
  Chart.defaults.plugins.tooltip.titleColor = CHART_THEME.text;
  Chart.defaults.plugins.tooltip.bodyColor = CHART_THEME.text;
}

function fmtNokShort(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)} M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(0)} k`;
  return `${sign}${abs.toFixed(0)}`;
}

function nokTooltip(ctx) {
  const v = ctx.parsed.y;
  const label = ctx.dataset.label ? `${ctx.dataset.label}: ` : '';
  return `${label}${fmtNok(v)}`;
}

// Destroy a prior Chart instance on a canvas so re-rendering after a range
// change doesn't leak instances.
const _chartRegistry = new Map();
function killChart(canvasId) {
  const prior = _chartRegistry.get(canvasId);
  if (prior) {
    prior.destroy();
    _chartRegistry.delete(canvasId);
  }
}
function registerChart(canvasId, chart) {
  _chartRegistry.set(canvasId, chart);
  return chart;
}

function renderEquityStory(canvasId, timeline) {
  killChart(canvasId);
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  const { months, group } = timeline;
  const chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: months,
      datasets: [
        {
          label: 'Money in (net deposits)',
          data: group.cumulative.netDeposits,
          borderColor: CHART_THEME.muted,
          backgroundColor: 'rgba(138, 146, 166, 0.10)',
          borderWidth: 2,
          tension: 0.25,
          fill: true,
          pointRadius: 0,
          pointHoverRadius: 4,
        },
        {
          label: 'Realized + dividends',
          data: group.cumulative.netPnl,
          borderColor: CHART_THEME.positive,
          backgroundColor: 'rgba(62, 224, 127, 0.12)',
          borderWidth: 2.5,
          tension: 0.25,
          fill: true,
          pointRadius: 0,
          pointHoverRadius: 4,
        },
        {
          label: 'Dividends only',
          data: group.cumulative.dividends,
          borderColor: CHART_THEME.accent2,
          borderDash: [4, 4],
          borderWidth: 1.5,
          tension: 0.25,
          fill: false,
          pointRadius: 0,
          pointHoverRadius: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { ticks: { maxTicksLimit: 10 }, grid: { display: false } },
        y: {
          ticks: { callback: (v) => fmtNokShort(v) },
          grid: { color: CHART_THEME.grid },
        },
      },
      plugins: {
        legend: { position: 'top', align: 'end' },
        tooltip: { callbacks: { label: nokTooltip } },
      },
    },
  });
  registerChart(canvasId, chart);
}

function renderMonthlyPnl(canvasId, timeline) {
  killChart(canvasId);
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  const { months, group } = timeline;
  const realized = group.monthly.realized;
  const divs = group.monthly.dividends;
  const chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: months,
      datasets: [
        {
          label: 'Realized',
          data: realized,
          backgroundColor: realized.map((v) =>
            v >= 0 ? 'rgba(62, 224, 127, 0.7)' : 'rgba(255, 122, 122, 0.7)'
          ),
          borderRadius: 3,
          stack: 'pnl',
        },
        {
          label: 'Dividends',
          data: divs,
          backgroundColor: 'rgba(255, 201, 79, 0.7)',
          borderRadius: 3,
          stack: 'pnl',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          stacked: true,
          ticks: { maxTicksLimit: 12 },
          grid: { display: false },
        },
        y: {
          stacked: true,
          ticks: { callback: (v) => fmtNokShort(v) },
          grid: { color: CHART_THEME.grid },
        },
      },
      plugins: {
        legend: { position: 'top', align: 'end' },
        tooltip: { callbacks: { label: nokTooltip } },
      },
    },
  });
  registerChart(canvasId, chart);
}

function renderPerInvestorCumulative(canvasId, timeline) {
  killChart(canvasId);
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  const { months, perInvestor, names } = timeline;
  const datasets = Object.keys(perInvestor).map((code) => ({
    label: `${code} ${names && names[code] ? names[code] : ''}`.trim(),
    data: perInvestor[code].cumulative.netPnl,
    borderColor: INVESTOR_COLOURS[code] || CHART_THEME.link,
    backgroundColor: 'transparent',
    borderWidth: 2,
    tension: 0.25,
    pointRadius: 0,
    pointHoverRadius: 4,
  }));
  const chart = new Chart(ctx, {
    type: 'line',
    data: { labels: months, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { ticks: { maxTicksLimit: 10 }, grid: { display: false } },
        y: {
          ticks: { callback: (v) => fmtNokShort(v) },
          grid: { color: CHART_THEME.grid },
        },
      },
      plugins: {
        legend: { position: 'top', align: 'end' },
        tooltip: { callbacks: { label: nokTooltip } },
      },
    },
  });
  registerChart(canvasId, chart);
}
