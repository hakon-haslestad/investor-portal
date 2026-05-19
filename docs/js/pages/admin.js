(async function () {
  const { store, me } = await window.Nav.bootstrap('admin');
  const { escapeHtml } = window.Fmt;
  const MEMBER_OPTIONS = ['HH', 'HS', 'ØS', 'JC', 'HF'];

  // Admin needs read+write Sheets access. Triggers a consent prompt the
  // first time an admin visits this page; silent on subsequent visits
  // once the broader scope is cached.
  try { await window.Auth.requestWriteAccess(); }
  catch (e) {
    document.getElementById('root').innerHTML =
      `<div class="flash error">Admin needs write access to the sheet. ${e.message || e} · <a href="#" onclick="location.reload()">Try again</a></div>`;
    return;
  }

  // Pull a fresh Dim-values index so we have UpdatedAt for the soft-guard.
  let dimIndex = await window.DimValues.readIndex();
  let securities = buildSecuritiesList(store, dimIndex.map);

  // security → pending payload { memberString, factor, expectedUpdatedAt }
  const dirty = new Map();
  let sortBy = { column: 'security', direction: 'asc' };

  renderSheetCard();

  const filter = document.getElementById('filter');
  const onlyUnmapped = document.getElementById('only-unmapped');
  const saveAllBtn = document.getElementById('save-all');
  const discardAllBtn = document.getElementById('discard-all');
  filter.addEventListener('input', render);
  onlyUnmapped.addEventListener('change', render);
  saveAllBtn.addEventListener('click', saveAll);
  discardAllBtn.addEventListener('click', () => { dirty.clear(); render(); });

  render();

  // ─── Build the displayed list ────────────────────────────────────────────

  function buildSecuritiesList(store, dimMap) {
    const txCounts = new Map();
    for (const t of store.transactions) {
      if (!t.security) continue;
      txCounts.set(t.security, (txCounts.get(t.security) || 0) + 1);
    }

    // Current qty from the latest Beholdningsverdi snapshot
    const latestDate = window.Portfolio.snapshotDate(store);
    const currentQty = new Map();
    if (latestDate) {
      for (const h of store.holdings) {
        if (h.snapshotDate !== latestDate) continue;
        currentQty.set(h.security, h.qty);
      }
    }

    const all = new Set();
    for (const k of txCounts.keys()) all.add(k);
    for (const k of currentQty.keys()) all.add(k);
    for (const k of dimMap.keys()) all.add(k);

    return Array.from(all).map((security) => {
      const dim = dimMap.get(security);
      return {
        security,
        type: dim ? (dim.type || 'Stock') : 'Stock',
        categoryTick: dim ? dim.categoryTick : '',
        memberString: dim ? dim.member : '',
        factor: dim ? dim.factor : null,
        isin: dim ? dim.isin : null,
        txCount: txCounts.get(security) || 0,
        currentQty: currentQty.get(security) || 0,
        updatedAt: dim ? dim.updatedAt : '',
        updatedBy: dim ? dim.updatedBy : '',
        mapped: Boolean(dim && dim.member),
      };
    });
  }

  // ─── Sheet card ──────────────────────────────────────────────────────────

  function renderSheetCard() {
    const mount = document.getElementById('sheet-card');
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${window.PORTAL_CONFIG.SHEET_ID}/edit`;
    mount.innerHTML = `
      <div class="sheet-card">
        <h3>Live from Google Sheets</h3>
        <div class="setup-line">
          Signed in as <strong>${escapeHtml(me.displayName)} (${me.investorCode})</strong> · ${escapeHtml(window.Auth.getEmail() || '')}.
          Edits in this tab write straight into the <strong>Dim-values</strong> tab.
        </div>
        <div class="row">
          <a href="${sheetUrl}" target="_blank" rel="noopener" class="btn ghost">Open sheet ↗</a>
          <button class="btn ghost" id="reload-data">Reload from sheet</button>
        </div>
      </div>
    `;
    document.getElementById('reload-data').addEventListener('click', reloadAll);
  }

  async function reloadAll() {
    flash('info', 'Reloading from Google…');
    window.Store.clear();
    const fresh = await window.Store.hydrate({ force: true });
    Object.assign(store, fresh);
    dimIndex = await window.DimValues.readIndex();
    securities = buildSecuritiesList(store, dimIndex.map);
    dirty.clear();
    render();
    flash('success', 'Reloaded.');
  }

  // ─── Main table render ───────────────────────────────────────────────────

  function visibleRows() {
    const f = filter.value.trim().toLowerCase();
    const filtered = securities.filter((s) => {
      if (onlyUnmapped.checked && s.mapped) return false;
      if (!f) return true;
      return (
        s.security.toLowerCase().includes(f)
        || (s.memberString || '').toLowerCase().includes(f)
        || (s.categoryTick || '').toLowerCase().includes(f)
        || (s.type || '').toLowerCase().includes(f)
      );
    });
    return filtered.sort(compareRows);
  }

  function compareRows(a, b) {
    const dir = sortBy.direction === 'asc' ? 1 : -1;
    const av = sortValue(a); const bv = sortValue(b);
    if (av < bv) return -dir;
    if (av > bv) return dir;
    return a.security.localeCompare(b.security, 'nb');
  }

  function sortValue(s) {
    switch (sortBy.column) {
      case 'mapped': return s.mapped ? 1 : 0;
      case 'security': return (s.security || '').toLowerCase();
      case 'memberString': return (s.memberString || '').toLowerCase();
      case 'factor': return s.factor == null ? -Infinity : Number(s.factor);
      case 'currentQty': return s.currentQty == null ? -Infinity : Number(s.currentQty);
      default: return 0;
    }
  }

  function sortArrow(column) {
    if (sortBy.column !== column) return '<span class="sort-arrow">↕</span>';
    return `<span class="sort-arrow">${sortBy.direction === 'asc' ? '▲' : '▼'}</span>`;
  }

  function thClass(column) {
    return 'sortable' + (sortBy.column === column ? ' sorted' : '');
  }

  function render() {
    const rows = visibleRows();
    const totalUnmapped = securities.filter((s) => !s.mapped).length;
    document.getElementById('meta-line').textContent =
      `${securities.length} securities · ${totalUnmapped} unmapped`;
    const root = document.getElementById('root');
    if (!rows.length) {
      root.innerHTML = '<p class="text-muted">Nothing matches. Try a different filter.</p>';
      return;
    }
    root.innerHTML = `
      <table class="admin-table">
        <thead><tr>
          <th class="${thClass('mapped')}" data-sort="mapped">Status${sortArrow('mapped')}</th>
          <th class="${thClass('security')}" data-sort="security">Stock${sortArrow('security')}</th>
          <th class="${thClass('memberString')}" data-sort="memberString">Investors${sortArrow('memberString')}</th>
          <th class="${thClass('factor')}" data-sort="factor">Factor${sortArrow('factor')}</th>
          <th class="${thClass('currentQty')} text-right text-small" data-sort="currentQty">Qty now${sortArrow('currentQty')}</th>
        </tr></thead>
        <tbody>
          ${rows.map(renderRow).join('')}
        </tbody>
      </table>
    `;
    root.querySelectorAll('th.sortable').forEach((th) => {
      th.addEventListener('click', () => {
        const col = th.dataset.sort;
        if (sortBy.column === col) sortBy.direction = sortBy.direction === 'asc' ? 'desc' : 'asc';
        else sortBy = { column: col, direction: 'asc' };
        render();
      });
    });
    root.querySelectorAll('tr[data-sec]').forEach((tr) => {
      const sec = tr.dataset.sec;
      tr.querySelectorAll('.investor-chip input').forEach((cb) => {
        cb.addEventListener('change', () => {
          cb.closest('.investor-chip').classList.toggle('checked', cb.checked);
          autoFillFactor(tr);
          markDirty(tr, sec);
        });
      });
      tr.querySelector('[name=factor]').addEventListener('input', () => markDirty(tr, sec));
    });
    updateSaveAllButton();
  }

  function renderRow(s) {
    const selected = new Set(parseMembers(s.memberString));
    return `
      <tr data-sec="${escapeHtml(s.security)}" class="${s.mapped ? '' : 'unmapped'}">
        <td>${s.mapped ? '<span class="badge-mapped">mapped</span>' : '<span class="badge-unmapped">unmapped</span>'}</td>
        <td><strong>${escapeHtml(s.security)}</strong></td>
        <td>
          <div class="investor-chips">
            ${MEMBER_OPTIONS.map((m) => `
              <label class="investor-chip ${selected.has(m) ? 'checked' : ''}">
                <input type="checkbox" value="${m}" ${selected.has(m) ? 'checked' : ''} /> ${m}
              </label>
            `).join('')}
          </div>
        </td>
        <td><input name="factor" value="${s.factor != null ? s.factor : ''}" placeholder="auto" style="width:70px" /></td>
        <td class="text-right text-small text-muted">${s.currentQty ? Number(s.currentQty).toFixed(0) : '—'}</td>
      </tr>
    `;
  }

  function parseMembers(str) {
    if (!str) return [];
    return String(str).split(/[\/+,]/).map((s) => s.trim()).filter(Boolean);
  }

  function selectedMembersFromRow(tr) {
    return Array.from(tr.querySelectorAll('.investor-chip input:checked')).map((cb) => cb.value);
  }

  function autoFillFactor(tr) {
    const sel = selectedMembersFromRow(tr);
    const factorEl = tr.querySelector('[name=factor]');
    if (!factorEl) return;
    factorEl.value = sel.length ? formatFactor(1 / sel.length) : '';
    factorEl.placeholder = sel.length ? formatFactor(1 / sel.length) : 'auto';
  }

  function formatFactor(n) {
    return Number(n).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  }

  function markDirty(tr, sec) {
    const memberString = selectedMembersFromRow(tr).join('/');
    const factor = tr.querySelector('[name=factor]').value.trim() || null;
    const expectedUpdatedAt = (dimIndex.map.get(sec) || {}).updatedAt || '';
    dirty.set(sec, { memberString, factor, expectedUpdatedAt });
    tr.classList.add('dirty');
    updateSaveAllButton();
  }

  function updateSaveAllButton() {
    const n = dirty.size;
    saveAllBtn.disabled = n === 0;
    discardAllBtn.disabled = n === 0;
    saveAllBtn.textContent = n === 0 ? 'Save changes' : `Save changes (${n})`;
  }

  async function saveAll() {
    if (!dirty.size) return;
    const total = dirty.size;
    let ok = 0, conflicts = [], failed = [];
    saveAllBtn.disabled = true;
    saveAllBtn.textContent = `Saving 0/${total}…`;
    for (const [security, payload] of dirty.entries()) {
      if (!payload.memberString) {
        failed.push(`${security}: no investors selected`);
        continue;
      }
      try {
        const res = await window.DimValues.upsert({
          security,
          member: payload.memberString,
          factor: payload.factor,
          signedInEmail: window.Auth.getEmail(),
          expectedUpdatedAt: payload.expectedUpdatedAt || null,
        });
        if (res.action === 'conflict') conflicts.push({ security, other: res.existing.updatedBy, at: res.existing.updatedAt });
        else ok += 1;
      } catch (err) {
        failed.push(`${security}: ${err.message}`);
      }
      saveAllBtn.textContent = `Saving ${ok}/${total}…`;
    }

    dirty.clear();
    // Refresh the in-memory dim index after writes
    dimIndex = await window.DimValues.readIndex();
    securities = buildSecuritiesList(store, dimIndex.map);
    render();

    if (conflicts.length) {
      const lines = conflicts.map((c) => `${c.security} — last edited by ${c.other || 'someone'} at ${c.at}`).join('<br>');
      flash('error', `⚠ ${conflicts.length} conflict(s) — values not saved. Reload and try again:<br>${lines}`);
    } else if (failed.length) {
      flash('error', `Saved ${ok}/${total}. Failed: ${failed.join(' · ')}`);
    } else {
      flash('success', `✅ Saved ${ok} mapping${ok === 1 ? '' : 's'} to Dim-values.`);
    }
  }

  function flash(kind, msg) {
    const el = document.getElementById('status');
    el.innerHTML = `<div class="flash ${kind === 'success' ? 'success' : kind === 'error' ? 'error' : ''}">${msg}</div>`;
  }
})();
