(async function () {
  const me = await fetchMe();
  if (!me) return;
  document.getElementById('nav-mount').innerHTML = buildNav('data', me.displayName);

  const data = await api('/api/data/transactions');
  if (!data) return;
  const rows = data.rows;

  const FLAT_COLS = [
    { key: 'trade_date', label: 'Trade date', type: 'date' },
    { key: 'type', label: 'Type', type: 'pill' },
    { key: 'security', label: 'Security', type: 'string' },
    { key: 'qty', label: 'Qty', type: 'num' },
    { key: 'price', label: 'Price', type: 'num' },
    { key: 'amount_nok', label: 'Amount NOK', type: 'money' },
    { key: 'fee', label: 'Fee', type: 'money' },
    { key: 'currency', label: 'Curr', type: 'string' },
    { key: 'running_balance', label: 'Balance', type: 'money' },
  ];
  // Columns that get summed in the footer (flat mode)
  const SUM_COLS = new Set(['qty', 'amount_nok', 'fee']);

  const modeSel = document.getElementById('mode');
  const groupSel = document.getElementById('pivot-group');
  const measureSel = document.getElementById('pivot-measure');
  const groupWrap = document.getElementById('pivot-group-wrap');
  const measureWrap = document.getElementById('pivot-measure-wrap');
  const filterEl = document.getElementById('filter');
  const countEl = document.getElementById('count');

  let sortBy = { column: 'trade_date', direction: 'desc' };

  document.getElementById('meta-line').textContent = `${rows.length} transactions loaded`;

  [modeSel, groupSel, measureSel].forEach((el) => el.addEventListener('change', () => {
    // Reset sort when switching modes / pivot dimensions so the default
    // (date desc for flat, measure desc for pivot) makes sense.
    if (modeSel.value === 'pivot') {
      sortBy = { column: 'measure', direction: 'desc' };
    } else {
      sortBy = { column: 'trade_date', direction: 'desc' };
    }
    render();
  }));
  filterEl.addEventListener('input', render);

  render();

  function render() {
    const pivot = modeSel.value === 'pivot';
    groupWrap.hidden = !pivot;
    measureWrap.hidden = !pivot;
    if (pivot) renderPivot();
    else renderFlat();
  }

  // ─── Flat mode ─────────────────────────────────────────────────────────────

  function renderFlat() {
    const filtered = applyFilter(rows);
    const sorted = filtered.slice().sort((a, b) => compareFlat(a, b));
    countEl.textContent = `${sorted.length} / ${rows.length} rows`;

    const totals = {};
    for (const col of SUM_COLS) totals[col] = 0;
    for (const r of sorted) {
      for (const col of SUM_COLS) totals[col] += Number(r[col]) || 0;
    }

    document.getElementById('root').innerHTML = `
      <table class="data-table">
        <thead><tr>
          ${FLAT_COLS.map((c) => `
            <th class="sortable ${sortBy.column === c.key ? 'sorted' : ''} ${c.type === 'num' || c.type === 'money' ? 'num' : ''}"
                data-sort="${c.key}">
              ${escapeHtml(c.label)}${sortArrow(c.key)}
            </th>
          `).join('')}
        </tr></thead>
        <tbody>
          ${sorted.map((r) => `
            <tr>
              ${FLAT_COLS.map((c) => `<td class="${c.type === 'num' || c.type === 'money' ? 'num' : ''}">${formatCell(r[c.key], c.type)}</td>`).join('')}
            </tr>
          `).join('')}
        </tbody>
        <tfoot>
          <tr>
            <td class="label" colspan="3">Σ Total (${sorted.length})</td>
            ${FLAT_COLS.slice(3).map((c) => `
              <td class="${c.type === 'num' || c.type === 'money' ? 'num' : ''}">
                ${SUM_COLS.has(c.key) ? formatCell(totals[c.key], c.type) : ''}
              </td>
            `).join('')}
          </tr>
        </tfoot>
      </table>
    `;
    wireSort();
  }

  function compareFlat(a, b) {
    const dir = sortBy.direction === 'asc' ? 1 : -1;
    const col = FLAT_COLS.find((c) => c.key === sortBy.column);
    const av = a[sortBy.column];
    const bv = b[sortBy.column];
    const numeric = col && (col.type === 'num' || col.type === 'money');
    let cmp;
    if (numeric) {
      const an = av == null ? -Infinity : Number(av);
      const bn = bv == null ? -Infinity : Number(bv);
      cmp = an < bn ? -1 : an > bn ? 1 : 0;
    } else {
      const as = (av || '').toString().toLowerCase();
      const bs = (bv || '').toString().toLowerCase();
      cmp = as.localeCompare(bs, 'nb');
    }
    return cmp * dir;
  }

  // ─── Pivot mode ────────────────────────────────────────────────────────────

  function renderPivot() {
    const filtered = applyFilter(rows);
    const groupBy = groupSel.value;
    const measure = measureSel.value;
    const measureLabel = measureSel.options[measureSel.selectedIndex].text;

    const buckets = new Map();
    for (const r of filtered) {
      const k = groupKey(r, groupBy);
      if (!buckets.has(k)) buckets.set(k, { key: k, count: 0, sumAmount: 0, sumQty: 0, sumFee: 0 });
      const b = buckets.get(k);
      b.count += 1;
      b.sumAmount += Number(r.amount_nok) || 0;
      b.sumQty += Number(r.qty) || 0;
      b.sumFee += Number(r.fee) || 0;
    }

    let pivotRows = Array.from(buckets.values()).map((b) => ({
      key: b.key,
      count: b.count,
      measure: measureValue(b, measure),
    }));

    pivotRows.sort((a, b) => {
      const dir = sortBy.direction === 'asc' ? 1 : -1;
      if (sortBy.column === 'key') {
        return a.key.toString().localeCompare(b.key.toString(), 'nb') * dir;
      }
      if (sortBy.column === 'count') {
        return (a.count - b.count) * dir;
      }
      return (a.measure - b.measure) * dir;
    });

    countEl.textContent = `${pivotRows.length} groups · ${filtered.length} rows`;

    const total = pivotRows.reduce((s, r) => s + r.measure, 0);
    const totalCount = pivotRows.reduce((s, r) => s + r.count, 0);
    const measureType = measure === 'count' ? 'int' : 'money';

    document.getElementById('root').innerHTML = `
      <table class="data-table">
        <thead><tr>
          <th class="sortable ${sortBy.column === 'key' ? 'sorted' : ''}" data-sort="key">
            ${escapeHtml(groupLabel(groupBy))}${sortArrow('key')}
          </th>
          <th class="sortable num ${sortBy.column === 'count' ? 'sorted' : ''}" data-sort="count">
            Count${sortArrow('count')}
          </th>
          <th class="sortable num ${sortBy.column === 'measure' ? 'sorted' : ''}" data-sort="measure">
            ${escapeHtml(measureLabel)}${sortArrow('measure')}
          </th>
        </tr></thead>
        <tbody>
          ${pivotRows.map((r) => `
            <tr>
              <td>${escapeHtml(r.key)}</td>
              <td class="num">${r.count.toLocaleString('nb-NO')}</td>
              <td class="num">${formatCell(r.measure, measureType)}</td>
            </tr>
          `).join('')}
        </tbody>
        <tfoot>
          <tr>
            <td class="label">Σ Total</td>
            <td class="num">${totalCount.toLocaleString('nb-NO')}</td>
            <td class="num">${formatCell(total, measureType)}</td>
          </tr>
        </tfoot>
      </table>
    `;
    wireSort();
  }

  function groupKey(r, groupBy) {
    switch (groupBy) {
      case 'security': return r.security || '(blank)';
      case 'type': return r.type || '(blank)';
      case 'currency': return r.currency || '(blank)';
      case 'year': return (r.trade_date || '').slice(0, 4) || '(no date)';
      case 'month': return (r.trade_date || '').slice(0, 7) || '(no date)';
      default: return '(blank)';
    }
  }

  function groupLabel(groupBy) {
    return { security: 'Security', type: 'Type', currency: 'Currency', year: 'Year', month: 'Year-month' }[groupBy] || groupBy;
  }

  function measureValue(b, measure) {
    switch (measure) {
      case 'sum-amount': return b.sumAmount;
      case 'sum-qty': return b.sumQty;
      case 'sum-fee': return b.sumFee;
      case 'count': return b.count;
      default: return 0;
    }
  }

  // ─── Shared helpers ────────────────────────────────────────────────────────

  function applyFilter(arr) {
    const f = filterEl.value.trim().toLowerCase();
    if (!f) return arr;
    return arr.filter((r) =>
      (r.security || '').toLowerCase().includes(f)
      || (r.type || '').toLowerCase().includes(f)
      || (r.currency || '').toLowerCase().includes(f)
      || (r.transaction_text || '').toLowerCase().includes(f)
      || (r.trade_date || '').includes(f)
    );
  }

  function wireSort() {
    document.querySelectorAll('th.sortable').forEach((th) => {
      th.addEventListener('click', () => {
        const col = th.dataset.sort;
        if (sortBy.column === col) {
          sortBy.direction = sortBy.direction === 'asc' ? 'desc' : 'asc';
        } else {
          // Numeric / date columns default to desc; strings asc
          const numericDefaults = ['qty', 'price', 'amount_nok', 'fee', 'running_balance', 'count', 'measure', 'trade_date'];
          sortBy = { column: col, direction: numericDefaults.includes(col) ? 'desc' : 'asc' };
        }
        render();
      });
    });
  }

  function sortArrow(column) {
    if (sortBy.column !== column) return '<span class="sort-arrow">↕</span>';
    return `<span class="sort-arrow">${sortBy.direction === 'asc' ? '▲' : '▼'}</span>`;
  }

  function formatCell(v, type) {
    if (v == null || v === '') return '<span class="text-muted">—</span>';
    switch (type) {
      case 'money':
        return (Math.round(Number(v))).toLocaleString('nb-NO');
      case 'num':
        return Number.isInteger(Number(v))
          ? Number(v).toLocaleString('nb-NO')
          : Number(v).toLocaleString('nb-NO', { maximumFractionDigits: 4 });
      case 'int':
        return Math.round(Number(v)).toLocaleString('nb-NO');
      case 'date':
        return escapeHtml(v);
      case 'pill':
        return `<span class="type-pill type-${escapeHtml(v)}">${escapeHtml(v)}</span>`;
      default:
        return escapeHtml(v);
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
