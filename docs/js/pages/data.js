(async function () {
  const { store, me } = await window.Nav.bootstrap('data');
  const { canonicalName, snapshotDate } = window.Portfolio;

  // Build join keys from the latest Beholdningsverdi snapshot + Dim-values.
  const latestSnap = snapshotDate(store);
  const holdingsBySec = new Map();
  let latestSnapTotalMv = 0;
  if (latestSnap) {
    for (const h of store.holdings) {
      if (h.snapshotDate !== latestSnap) continue;
      const key = canonicalName(h.security);
      if (!holdingsBySec.has(key)) holdingsBySec.set(key, h);
      latestSnapTotalMv += Number(h.marketValueNok) || 0;
    }
  }
  const metaBySec = new Map();
  for (const m of store.meta) metaBySec.set(m.security, m);

  // Joined row per transaction.
  const rows = store.transactions.map((t) => {
    const can = canonicalName(t.security);
    const h = holdingsBySec.get(can);
    const m = metaBySec.get(t.security) || metaBySec.get(can);
    return {
      // From Rådata fra nordnet
      trade_date: t.tradeDate,
      settle_date: t.settleDate,
      type: t.type,
      security: t.security,
      isin: t.isin,
      qty: t.qty,
      price: t.price,
      amount_nok: t.amount,
      currency: t.currency,
      fee: t.fee,
      running_balance: t.saldo,
      transaction_text: t.text,
      // From Dim-values
      member: m ? m.memberString : '',
      factor: m ? m.factor : null,
      // From Beholdningsverdi (latest snapshot for this security)
      current_price: h ? h.currentPrice : null,
      current_qty: h ? h.qty : null,
      market_value_nok: h ? h.marketValueNok : null,
      return_pct: h ? h.returnPct : null,
    };
  });

  const FLAT_COLS = [
    { key: 'trade_date',       label: 'Trade date',  type: 'date' },
    { key: 'type',             label: 'Type',        type: 'pill' },
    { key: 'security',         label: 'Stock',       type: 'string' },
    { key: 'member',           label: 'Investors',   type: 'string' },
    { key: 'factor',           label: 'Factor',      type: 'num' },
    { key: 'qty',              label: 'Tx Qty',      type: 'num' },
    { key: 'price',            label: 'Tx Price',    type: 'num' },
    { key: 'amount_nok',       label: 'Amount NOK',  type: 'money' },
    { key: 'fee',              label: 'Fee',         type: 'money' },
    { key: 'currency',         label: 'Curr',        type: 'string' },
    { key: 'current_price',    label: 'Price now',   type: 'num' },
    { key: 'current_qty',      label: 'Qty now',     type: 'num' },
    { key: 'market_value_nok', label: 'MV now',      type: 'money' },
  ];
  // Columns that get summed in the header row.
  //  • Flow-style (qty, amount, fee) → straight sum across all visible rows.
  //  • market_value_nok → deduped by security (each stock's MV counts once).
  const SUM_COLS = new Set(['qty', 'amount_nok', 'fee', 'market_value_nok']);
  const DEDUPE_BY_SECURITY = new Set(['market_value_nok']);

  const modeSel = document.getElementById('mode');
  const groupSel = document.getElementById('pivot-group');
  const group2Sel = document.getElementById('pivot-group2');
  const measureWrap = document.getElementById('pivot-measure-wrap');
  const groupWrap = document.getElementById('pivot-group-wrap');
  const group2Wrap = document.getElementById('pivot-group2-wrap');
  const filterEl = document.getElementById('filter');
  const countEl = document.getElementById('count');
  const fromInput = document.getElementById('date-from');
  const toInput = document.getElementById('date-to');

  // Available pivot measures. `dedupeBy` means values are deduped on that key
  // within each bucket before summing — needed for MV which is the same per
  // security across all transaction rows.
  const MEASURES = [
    { id: 'count',      label: 'Count',         type: 'int',   sumField: 'count' },
    { id: 'sum-amount', label: 'Σ Amount NOK',  type: 'money', sumField: 'sumAmount' },
    { id: 'sum-qty',    label: 'Σ Qty',         type: 'num',   sumField: 'sumQty' },
    { id: 'sum-fee',    label: 'Σ Fee',         type: 'money', sumField: 'sumFee' },
    { id: 'sum-mv',     label: 'Σ MV now',      type: 'money', sumField: 'sumMv',  dedupeBy: 'security' },
  ];
  const storedMeasures = JSON.parse(localStorage.getItem('portal.data.measures') || '["count","sum-amount"]');
  const activeMeasures = new Set(storedMeasures);

  // Build the measure chip UI
  measureWrap.innerHTML = MEASURES.map((m) => `
    <label class="m-chip ${activeMeasures.has(m.id) ? 'checked' : ''}">
      <input type="checkbox" value="${m.id}" ${activeMeasures.has(m.id) ? 'checked' : ''}> ${Fmt.escapeHtml(m.label)}
    </label>
  `).join('');
  measureWrap.querySelectorAll('input').forEach((cb) => {
    cb.addEventListener('change', () => {
      cb.closest('.m-chip').classList.toggle('checked', cb.checked);
      if (cb.checked) activeMeasures.add(cb.value); else activeMeasures.delete(cb.value);
      localStorage.setItem('portal.data.measures', JSON.stringify(Array.from(activeMeasures)));
      render();
    });
  });

  let sortBy = { column: 'trade_date', direction: 'desc' };

  // Actual data range — bounds the date inputs and seeds them when the user
  // clicks Custom with nothing set yet.
  let minTradeDate = null, maxTradeDate = null;
  for (const r of rows) {
    if (!r.trade_date) continue;
    if (!minTradeDate || r.trade_date < minTradeDate) minTradeDate = r.trade_date;
    if (!maxTradeDate || r.trade_date > maxTradeDate) maxTradeDate = r.trade_date;
  }
  if (minTradeDate) { fromInput.min = minTradeDate; toInput.min = minTradeDate; }
  if (maxTradeDate) { fromInput.max = maxTradeDate; toInput.max = maxTradeDate; }

  // Date-range picker state. Persisted in localStorage (separate key from dashboard).
  const storedRange = JSON.parse(localStorage.getItem('portal.data.range') || '{"preset":"all"}');
  let range = { preset: storedRange.preset || 'all', from: storedRange.from || null, to: storedRange.to || null };
  if (range.preset === 'custom' && range.from && range.to) {
    fromInput.value = range.from;
    toInput.value = range.to;
    showCustomInputs(true);
  }
  setActivePreset(range.preset);

  function dateBounds(preset) {
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const addMonths = (d, n) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };
    const addYears  = (d, n) => { const x = new Date(d); x.setUTCFullYear(x.getUTCFullYear() + n); return x.toISOString().slice(0, 10); };
    switch (preset) {
      case '1m':  return { from: addMonths(today, -1), to: todayStr };
      case '6m':  return { from: addMonths(today, -6), to: todayStr };
      case 'ytd': return { from: `${today.getUTCFullYear()}-01-01`, to: todayStr };
      case '1y':  return { from: addYears(today, -1),  to: todayStr };
      case 'all': return { from: null, to: null };
      default:    return { from: null, to: null };
    }
  }

  function inRange(tradeDate) {
    if (!range.from && !range.to) return true;
    if (!tradeDate) return false;
    if (range.from && tradeDate < range.from) return false;
    if (range.to && tradeDate > range.to) return false;
    return true;
  }

  function setActivePreset(preset) {
    document.querySelectorAll('#range-picker .preset').forEach((b) => {
      b.classList.toggle('active', b.dataset.preset === preset);
    });
  }
  function showCustomInputs(show) {
    document.getElementById('custom-sep').style.display  = show ? 'inline' : 'none';
    document.getElementById('custom-sep2').style.display = show ? 'inline' : 'none';
    fromInput.style.display = show ? 'inline-block' : 'none';
    toInput.style.display   = show ? 'inline-block' : 'none';
  }

  function persistRange() {
    localStorage.setItem('portal.data.range', JSON.stringify(range));
  }

  document.querySelectorAll('#range-picker .preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = btn.dataset.preset;
      if (p === 'custom') {
        // Pre-fill the inputs with the data's full span if nothing's set yet,
        // so the user has a sensible starting point.
        if (!fromInput.value) fromInput.value = range.from || minTradeDate || '';
        if (!toInput.value)   toInput.value   = range.to   || maxTradeDate || '';
        range = {
          preset: 'custom',
          from: fromInput.value || null,
          to: toInput.value || null,
        };
        showCustomInputs(true);
        setActivePreset('custom');
        if (range.from && range.to) { persistRange(); render(); }
        return;
      }
      const b = dateBounds(p);
      range = { preset: p, from: b.from, to: b.to };
      showCustomInputs(false);
      setActivePreset(p);
      persistRange();
      render();
    });
  });
  const onCustomChange = () => {
    if (!fromInput.value || !toInput.value) return;
    range = { preset: 'custom', from: fromInput.value, to: toInput.value };
    persistRange();
    render();
  };
  fromInput.addEventListener('change', onCustomChange);
  toInput.addEventListener('change', onCustomChange);

  document.getElementById('meta-line').textContent =
    `${rows.length} transactions · joined with Beholdningsverdi (${latestSnap || 'no snapshot'}) + Dim-values · signed in as ${me.displayName} (${me.investorCode})`;

  // Pivot can also group by member.
  for (const sel of [groupSel, group2Sel]) {
    if (sel && !sel.querySelector('option[value="member"]')) {
      const opt = document.createElement('option');
      opt.value = 'member'; opt.textContent = 'Investors';
      sel.appendChild(opt);
    }
  }

  [modeSel, groupSel, group2Sel].forEach((el) => el.addEventListener('change', () => {
    if (modeSel.value === 'pivot') {
      // Default sort: first selected measure, desc.
      const first = [...activeMeasures][0] || 'count';
      sortBy = { column: 'measure:' + first, direction: 'desc' };
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
    group2Wrap.hidden = !pivot;
    measureWrap.hidden = !pivot;
    if (pivot) renderPivot(); else renderFlat();
  }

  function renderFlat() {
    const filtered = applyFilter(rows);
    const sorted = filtered.slice().sort(compareFlat);
    countEl.textContent = `${sorted.length} / ${rows.length} rows`;

    const totals = {};
    for (const col of SUM_COLS) totals[col] = 0;
    for (const r of sorted) {
      for (const col of SUM_COLS) {
        if (col === 'market_value_nok') continue; // overridden below
        const v = Number(r[col]);
        if (Number.isFinite(v)) totals[col] += v;
      }
    }
    // MV total is the latest-snapshot portfolio MV, always — ignores all filters.
    totals.market_value_nok = latestSnapTotalMv;

    document.getElementById('root').innerHTML = `
      <div class="data-table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              ${FLAT_COLS.map((c) => `
                <th class="sortable ${sortBy.column === c.key ? 'sorted' : ''} ${c.type === 'num' || c.type === 'money' ? 'num' : ''}"
                    data-sort="${c.key}">
                  ${Fmt.escapeHtml(c.label)}${sortArrow(c.key)}
                </th>
              `).join('')}
            </tr>
          </thead>
          <tbody>
            <tr class="summary-top">
              <td class="label" colspan="5">Σ Total (${sorted.length})</td>
              ${FLAT_COLS.slice(5).map((c) => `
                <td class="${c.type === 'num' || c.type === 'money' ? 'num' : ''}">
                  ${SUM_COLS.has(c.key) ? formatCell(totals[c.key], c.type) : ''}
                </td>
              `).join('')}
            </tr>
            ${sorted.map((r) => `
              <tr>
                ${FLAT_COLS.map((c) => `<td class="${c.type === 'num' || c.type === 'money' ? 'num' : ''}">${formatCell(r[c.key], c.type)}</td>`).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
    wireSort();
  }

  function compareFlat(a, b) {
    const dir = sortBy.direction === 'asc' ? 1 : -1;
    const col = FLAT_COLS.find((c) => c.key === sortBy.column);
    const av = a[sortBy.column]; const bv = b[sortBy.column];
    const numeric = col && (col.type === 'num' || col.type === 'money');
    let cmp;
    if (numeric) {
      const an = av == null ? -Infinity : Number(av);
      const bn = bv == null ? -Infinity : Number(bv);
      cmp = an < bn ? -1 : an > bn ? 1 : 0;
    } else {
      cmp = (av || '').toString().toLowerCase().localeCompare((bv || '').toString().toLowerCase(), 'nb');
    }
    return cmp * dir;
  }

  function renderPivot() {
    const filtered = applyFilter(rows);
    const g1 = groupSel.value;
    const g2 = group2Sel.value;          // empty string when "(none)"
    const measures = MEASURES.filter((m) => activeMeasures.has(m.id));

    // Bucket key = "g1value|||g2value" (g2 may be '')
    const buckets = new Map();
    function ensure(k1, k2) {
      const key = `${k1}|||${k2}`;
      if (!buckets.has(key)) {
        buckets.set(key, {
          g1: k1, g2: k2, count: 0,
          sumAmount: 0, sumQty: 0, sumFee: 0, sumMv: 0,
          _seenSec: new Set(),
        });
      }
      return buckets.get(key);
    }
    for (const r of filtered) {
      const k1 = groupKey(r, g1);
      const k2 = g2 ? groupKey(r, g2) : '';
      const b = ensure(k1, k2);
      b.count += 1;
      b.sumAmount += Number(r.amount_nok) || 0;
      b.sumQty    += Number(r.qty) || 0;
      b.sumFee    += Number(r.fee) || 0;
      const sec = (r.security || '').toString();
      if (sec && !b._seenSec.has(sec) && r.market_value_nok != null) {
        b._seenSec.add(sec);
        b.sumMv += Number(r.market_value_nok) || 0;
      }
    }

    let pivotRows = Array.from(buckets.values());

    // Sort: 'g1' / 'g2' (lexicographic) or 'measure:<id>' (numeric).
    pivotRows.sort((a, b) => {
      const dir = sortBy.direction === 'asc' ? 1 : -1;
      if (sortBy.column === 'g1') return a.g1.toString().localeCompare(b.g1.toString(), 'nb') * dir;
      if (sortBy.column === 'g2') return a.g2.toString().localeCompare(b.g2.toString(), 'nb') * dir;
      if (sortBy.column.startsWith('measure:')) {
        const id = sortBy.column.slice('measure:'.length);
        const m = MEASURES.find((x) => x.id === id);
        if (m) {
          const av = a[m.sumField] || 0;
          const bv = b[m.sumField] || 0;
          return (av - bv) * dir;
        }
      }
      // Default fallback: by primary group
      return a.g1.toString().localeCompare(b.g1.toString(), 'nb') * dir;
    });

    countEl.textContent = `${pivotRows.length} groups · ${filtered.length} rows`;

    // Grand totals across the filtered set, except MV which is always the
    // full latest-snapshot portfolio MV regardless of filters.
    const totals = { count: 0, sumAmount: 0, sumQty: 0, sumFee: 0, sumMv: latestSnapTotalMv };
    for (const r of filtered) {
      totals.count += 1;
      totals.sumAmount += Number(r.amount_nok) || 0;
      totals.sumQty    += Number(r.qty) || 0;
      totals.sumFee    += Number(r.fee) || 0;
    }

    const showG2 = !!g2;
    const headerCols = [
      { id: 'g1',    label: groupLabel(g1),  num: false },
      ...(showG2 ? [{ id: 'g2', label: groupLabel(g2), num: false }] : []),
      ...measures.map((m) => ({ id: 'measure:' + m.id, label: m.label, num: true, measure: m })),
    ];

    if (!measures.length) {
      document.getElementById('root').innerHTML = '<p class="text-muted">Pick at least one measure to see the pivot.</p>';
      return;
    }

    document.getElementById('root').innerHTML = `
      <div class="data-table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              ${headerCols.map((c) => `
                <th class="sortable ${c.num ? 'num' : ''} ${sortBy.column === c.id ? 'sorted' : ''}" data-sort="${c.id}">
                  ${Fmt.escapeHtml(c.label)}${sortArrow(c.id)}
                </th>
              `).join('')}
            </tr>
          </thead>
          <tbody>
            <tr class="summary-top">
              <td class="label" ${showG2 ? 'colspan="2"' : ''}>Σ Total</td>
              ${measures.map((m) => `<td class="num">${formatCell(totals[m.sumField], m.type)}</td>`).join('')}
            </tr>
            ${pivotRows.map((b) => `
              <tr>
                <td>${Fmt.escapeHtml(b.g1)}</td>
                ${showG2 ? `<td>${Fmt.escapeHtml(b.g2)}</td>` : ''}
                ${measures.map((m) => `<td class="num">${formatCell(b[m.sumField], m.type)}</td>`).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
    wireSort();
  }

  function groupKey(r, groupBy) {
    switch (groupBy) {
      case 'security': return r.security || '(blank)';
      case 'type': return r.type || '(blank)';
      case 'currency': return r.currency || '(blank)';
      case 'member': return r.member || '(unmapped)';
      case 'year': return (r.trade_date || '').slice(0, 4) || '(no date)';
      case 'month': return (r.trade_date || '').slice(0, 7) || '(no date)';
      default: return '(blank)';
    }
  }

  function groupLabel(groupBy) {
    return { security: 'Stock', type: 'Type', currency: 'Currency', member: 'Investors', year: 'Year', month: 'Year-month' }[groupBy] || groupBy;
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

  function applyFilter(arr) {
    const f = filterEl.value.trim().toLowerCase();
    return arr.filter((r) => {
      if (!inRange(r.trade_date)) return false;
      if (!f) return true;
      return (
        (r.security || '').toLowerCase().includes(f)
        || (r.type || '').toLowerCase().includes(f)
        || (r.currency || '').toLowerCase().includes(f)
        || (r.member || '').toLowerCase().includes(f)
        || (r.transaction_text || '').toLowerCase().includes(f)
        || (r.trade_date || '').includes(f)
      );
    });
  }

  function wireSort() {
    document.querySelectorAll('th.sortable').forEach((th) => {
      th.addEventListener('click', () => {
        const col = th.dataset.sort;
        if (sortBy.column === col) sortBy.direction = sortBy.direction === 'asc' ? 'desc' : 'asc';
        else {
          const numericDefaults = ['qty', 'price', 'amount_nok', 'fee', 'running_balance', 'count', 'measure', 'trade_date', 'current_price', 'current_qty', 'market_value_nok', 'factor'];
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
      case 'money': return (Math.round(Number(v))).toLocaleString('nb-NO');
      case 'num':
        return Number.isInteger(Number(v))
          ? Number(v).toLocaleString('nb-NO')
          : Number(v).toLocaleString('nb-NO', { maximumFractionDigits: 4 });
      case 'int': return Math.round(Number(v)).toLocaleString('nb-NO');
      case 'date': return Fmt.escapeHtml(v);
      case 'pill': return `<span class="type-pill type-${Fmt.escapeHtml(v)}">${Fmt.escapeHtml(v)}</span>`;
      default: return Fmt.escapeHtml(v);
    }
  }
})();
