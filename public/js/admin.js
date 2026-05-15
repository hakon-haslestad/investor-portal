(async function () {
  const me = await fetchMe();
  if (!me) return;
  document.getElementById('nav-mount').innerHTML = buildNav('admin', me.displayName);

  await renderSheetCard();
  let state = await api('/api/admin/securities');
  if (!state) return;

  // security → pending payload { memberString, factor }
  const dirty = new Map();

  // Current sort. Click a column header to cycle asc → desc → reset to default.
  let sortBy = { column: 'security', direction: 'asc' };

  const filter = document.getElementById('filter');
  const onlyUnmapped = document.getElementById('only-unmapped');
  const saveAllBtn = document.getElementById('save-all');
  const discardAllBtn = document.getElementById('discard-all');
  filter.addEventListener('input', render);
  onlyUnmapped.addEventListener('change', render);
  saveAllBtn.addEventListener('click', saveAll);
  discardAllBtn.addEventListener('click', () => { dirty.clear(); render(); });

  render();

  function visibleRows() {
    const f = filter.value.trim().toLowerCase();
    const filtered = state.securities.filter((s) => {
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
    const [av, bv] = [sortValue(a), sortValue(b)];
    if (av < bv) return -dir;
    if (av > bv) return dir;
    // Stable fallback: alphabetical by security name
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
    const totalUnmapped = state.securities.filter((s) => !s.mapped).length;
    document.getElementById('meta-line').textContent =
      `${state.securities.length} securities · ${totalUnmapped} unmapped`;

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
          ${rows.map((s, i) => renderRow(s, i)).join('')}
        </tbody>
      </table>
    `;
    root.querySelectorAll('th.sortable').forEach((th) => {
      th.addEventListener('click', () => {
        const col = th.dataset.sort;
        if (sortBy.column === col) {
          sortBy.direction = sortBy.direction === 'asc' ? 'desc' : 'asc';
        } else {
          sortBy = { column: col, direction: 'asc' };
        }
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

  function markDirty(tr, sec) {
    const memberString = selectedMembersFromRow(tr).join('/');
    const factor = tr.querySelector('[name=factor]').value.trim() || null;
    dirty.set(sec, { memberString, factor });
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
    let ok = 0, failed = [];
    saveAllBtn.disabled = true;
    saveAllBtn.textContent = `Saving 0/${total}…`;
    for (const [security, payload] of dirty.entries()) {
      if (!payload.memberString) {
        failed.push(`${security}: no investors selected`);
        continue;
      }
      try {
        const r = await fetch('/api/admin/securities/' + encodeURIComponent(security), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const body = await r.json();
        if (!r.ok) failed.push(`${security}: ${body.message || body.error}`);
        else ok += 1;
      } catch (err) {
        failed.push(`${security}: ${err.message}`);
      }
      saveAllBtn.textContent = `Saving ${ok}/${total}…`;
    }
    dirty.clear();
    state = await api('/api/admin/securities');
    render();
    if (failed.length) {
      flashStatus('error', `Saved ${ok}/${total}. Failed: ${failed.join(' · ')}`);
    } else {
      flashStatus('success', `✅ Saved ${ok} mapping${ok === 1 ? '' : 's'} to the sheet.`);
    }
  }

  function renderRow(s, i) {
    const selected = new Set(parseMembers(s.memberString));
    const memberOptions = state.memberOptions;
    return `
      <tr data-sec="${escapeAttr(s.security)}" class="${s.mapped ? '' : 'unmapped'}">
        <td>${s.mapped ? '<span class="badge-mapped">mapped</span>' : '<span class="badge-unmapped">unmapped</span>'}</td>
        <td><strong>${escapeHtml(s.security)}</strong></td>
        <td>
          <div class="investor-chips">
            ${memberOptions.map((m) => `
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
    // Trim trailing zeros: 0.5 → "0.5", 0.3333… → "0.3333"
    return Number(n).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  async function renderSheetCard() {
    const mount = document.getElementById('sheet-card');
    const cfg = await api('/api/admin/sheet-config');
    if (!cfg) return;

    mount.innerHTML = `
      <div class="sheet-card">
        <h3>Google Sheets connection</h3>
        ${!cfg.keyFileConfigured ? `
          <div class="flash error">
            <strong>Setup needed.</strong> Set <code>GOOGLE_SERVICE_ACCOUNT_KEY</code> in your <code>.env</code> file and restart the server.
            See the README for the full Google Cloud setup.
          </div>
        ` : ''}
        <div class="setup-line">
          ${cfg.serviceAccountEmail
            ? `Service account: <span class="sa-email" id="sa-email">${escapeHtml(cfg.serviceAccountEmail)}</span>
               <button class="btn small ghost" id="copy-email">Copy</button> &middot;
               Share the sheet with this address as <strong>Editor</strong> before syncing.`
            : '<em>Service account email unavailable — key file not loaded.</em>'}
          <details>
            <summary>Full setup steps</summary>
            <ol>
              <li>Google Cloud Console → New project ("Geysir Invest Portal")</li>
              <li>APIs &amp; Services → Library → enable <strong>Google Sheets API</strong></li>
              <li>IAM &amp; Admin → Service Accounts → Create <code>geysir-portal-sync</code> (no roles)</li>
              <li>Open the account → Keys → Add key → JSON → save as <code>data/google-service-account.json</code></li>
              <li>Share the Google Sheet with the email above as <strong>Editor</strong> (the app writes the Ownership tab back)</li>
              <li>Add <code>GOOGLE_SERVICE_ACCOUNT_KEY=./data/google-service-account.json</code> to <code>.env</code>, restart server</li>
              <li>Paste the sheet URL below → Save → Test → Sync now</li>
            </ol>
          </details>
        </div>

        <div class="row">
          ${cfg.sheetUrl ? `<a href="${escapeAttr(cfg.sheetUrl)}" target="_blank" rel="noopener" class="btn ghost">Open sheet ↗</a>` : ''}
          <button class="btn ghost" id="test-conn">Test connection</button>
          <button class="btn" id="sync-now">Sync now</button>
        </div>
        <div class="setup-line">
          ${cfg.lastSyncAt ? `Last synced: ${formatLocalTime(cfg.lastSyncAt)}` : '<em>Never synced yet.</em>'}
        </div>
        <div id="sheet-status" style="margin-top:10px"></div>
      </div>
    `;

    if (cfg.serviceAccountEmail) {
      document.getElementById('copy-email').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(cfg.serviceAccountEmail);
          flashStatus('success', 'Email copied — paste it into the sheet\'s Share dialog.');
        } catch (_e) {
          flashStatus('error', 'Couldn\'t copy. Select the email and copy manually.');
        }
      });
    }
    document.getElementById('test-conn').addEventListener('click', testConnection);
    document.getElementById('sync-now').addEventListener('click', syncNow);
  }

  async function testConnection() {
    flashStatus('info', 'Pinging Google…');
    const r = await fetch('/api/admin/test-connection', { method: 'POST' });
    const body = await r.json();
    if (!r.ok) return flashStatus('error', body.message || body.error);
    flashStatus('success', `✅ Connected. Found ${body.rowCount} rows. Header: ${(body.headerRow || []).slice(0, 4).join(' · ')}…`);
  }

  async function syncNow() {
    flashStatus('info', 'Syncing from Google…');
    const r = await fetch('/api/admin/sync', { method: 'POST' });
    const body = await r.json();
    if (!r.ok) return flashStatus('error', body.message || body.error);
    const unmappedBlock = (body.unmappedSecurities || []).length
      ? `<div class="flash error" style="margin-top:8px">
          ⚠ ${body.unmappedSecurities.length} securities unmapped: <strong>${body.unmappedSecurities.join(', ')}</strong>.
          Fill them in below before they show up in anyone's portfolio.
        </div>`
      : '';
    document.getElementById('sheet-status').innerHTML = `
      <div class="flash success">
        ✅ Synced ${body.rowsImported} transactions, ${body.holdingsImported} holdings, ${body.kpisImported} KPIs.
      </div>${unmappedBlock}
    `;
    // Refresh both the config (for new lastSyncAt) and securities list
    state = await api('/api/admin/securities');
    render();
  }

  function flashStatus(kind, msg) {
    const el = document.getElementById('sheet-status');
    if (!el) return;
    el.innerHTML = `<div class="flash ${kind === 'success' ? 'success' : kind === 'error' ? 'error' : ''}">${escapeHtml(msg)}</div>`;
  }

  function formatLocalTime(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleString('nb-NO', { dateStyle: 'short', timeStyle: 'short' });
    } catch (_e) {
      return iso;
    }
  }
})();
