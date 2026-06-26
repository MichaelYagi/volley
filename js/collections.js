// ─── Request Selection ────────────────────────────────────────────────────────

function findReq(id) {
  for (const col of state.cols) {
    for (const r of col.requests)                        if (r.id === id) return r;
    for (const f of col.folders) for (const r of f.requests) if (r.id === id) return r;
  }
  return null;
}

// Request `id`s are ephemeral and regenerated on every load (see CLAUDE.md), so
// they can't be used to refer to a request across a page reload. These two
// helpers translate to/from a stable {col, folder, name} location, used to
// persist open tabs in data/_salvo/tabs.json.
function findReqLocation(id) {
  for (const col of state.cols) {
    for (const r of col.requests) if (r.id === id) return { col: col.name, folder: null, name: r.name };
    for (const f of col.folders) for (const r of f.requests) if (r.id === id) return { col: col.name, folder: f.name, name: r.name };
  }
  return null;
}

function findReqByLocation(loc) {
  if (!loc) return null;
  const col = state.cols.find(c => c.name === loc.col);
  if (!col) return null;
  if (loc.folder) {
    const f = col.folders.find(f => f.name === loc.folder);
    return f?.requests.find(r => r.name === loc.name) || null;
  }
  return col.requests.find(r => r.name === loc.name) || null;
}

function selectReq(id) {
  openTab(id);
}

// ─── Collection CRUD ──────────────────────────────────────────────────────────

function addCollection() {
  const col = { id: uid(), name: 'New Collection', description: '', folders: [], requests: [] };
  state.cols.unshift(col);
  state.expandedCols.add(col.id);
  renderSidebar();
  scheduleDiskSave();
}

async function renameCol(id) {
  const col = state.cols.find(c => c.id === id);
  if (!col) return;
  const name = await promptDialog('Rename collection:', col.name);
  if (name !== null) { col.name = name; renderSidebar(); scheduleDiskSave(); }
}

async function deleteCol(id) {
  const col = state.cols.find(c => c.id === id);
  if (!await confirmDialog(`Delete collection "${col?.name}"?`, { okLabel: 'Delete', danger: true })) return;
  state.cols = state.cols.filter(c => c.id !== id);
  renderSidebar();
  scheduleDiskSave();
  syncMockRoutes();
}

function exportCol(id) {
  const col = state.cols.find(c => c.id === id);
  if (!col) return;
  const blob = new Blob([JSON.stringify(col, null, 2)], { type: 'application/json' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = col.name + '.json';
  a.click();
}

// ─── Postman v2.1.0 serialisation ─────────────────────────────────────────────

function colToPostman(col) {
  function toPostmanItem(r) {
    const header = r.headers.map(h => ({ key: h.key, value: h.value, disabled: !h.enabled }));

    const urlObj = { raw: r.url };
    if (r.params.length) {
      urlObj.query = r.params.map(p => ({ key: p.key, value: p.value, disabled: !p.enabled }));
    }

    const request = { method: r.method, header, url: urlObj };

    if (r.body.type === 'raw' && r.body.raw) {
      request.body = {
        mode: 'raw',
        raw:  r.body.raw,
        options: { raw: { language: r.body.contentType || 'json' } },
      };
    } else if (r.body.type === 'formdata') {
      request.body = {
        mode:     'formdata',
        formdata: r.body.formData.map(f => ({ key: f.key, value: f.value, disabled: !f.enabled, type: 'text' })),
      };
    } else if (r.body.type === 'urlencoded') {
      request.body = {
        mode:       'urlencoded',
        urlencoded: r.body.formData.map(f => ({ key: f.key, value: f.value, disabled: !f.enabled })),
      };
    }

    if (r.auth.type === 'bearer') {
      request.auth = { type: 'bearer', bearer: [{ key: 'token', value: r.auth.token, type: 'string' }] };
    } else if (r.auth.type === 'basic') {
      request.auth = { type: 'basic', basic: [
        { key: 'username', value: r.auth.username, type: 'string' },
        { key: 'password', value: r.auth.password, type: 'string' },
      ]};
    } else if (r.auth.type === 'apikey') {
      request.auth = { type: 'apikey', apikey: [
        { key: 'key',   value: r.auth.apiKey,   type: 'string' },
        { key: 'value', value: r.auth.apiValue,  type: 'string' },
        { key: 'in',    value: 'header',          type: 'string' },
      ]};
    }

    return { name: r.name, request };
  }

  return {
    info: {
      name:   col.name,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: [
      ...col.folders.map(f => ({ name: f.name, item: f.requests.map(toPostmanItem) })),
      ...col.requests.map(toPostmanItem),
    ],
  };
}

function exportColAsPostman(id) {
  const col = state.cols.find(c => c.id === id);
  if (!col) return;
  const blob = new Blob([JSON.stringify(colToPostman(col), null, 2)], { type: 'application/json' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = col.name + '.postman_collection.json';
  a.click();
}

// ─── Folder CRUD ──────────────────────────────────────────────────────────────

function addFolder(colId) {
  const col = state.cols.find(c => c.id === colId);
  if (!col) return;
  col.folders.push({ id: uid(), name: 'New Folder', requests: [] });
  state.expandedCols.add(colId);
  renderSidebar();
  scheduleDiskSave();
}

// ─── Request CRUD ─────────────────────────────────────────────────────────────

function newRequestTemplate() {
  return {
    id:      uid(),
    name:    'New Request',
    method:  'GET',
    url:     '',
    protocol: 'http',
    headers: [],
    params:  [],
    pathVars: [],
    body:    defaultBody(),
    auth:    defaultAuth(),
    preRequestScript: '',
    testScript:       '',
    description: '',
    comments: [],
    mock: defaultMock(),
    examples: [],
    disabledAutoHeaders: [],
  };
}

function addReq(colId, folderId = null) {
  const r   = newRequestTemplate();
  const col = state.cols.find(c => c.id === colId);
  if (!col) return;

  if (folderId) {
    const folder = col.folders.find(f => f.id === folderId);
    if (folder) folder.requests.push(r);
  } else {
    col.requests.push(r);
  }

  selectReq(r.id);
  renderSidebar();
  scheduleDiskSave();
}

async function renameReq(id) {
  const r = findReq(id);
  if (!r) return;
  const name = await promptDialog('Rename request:', r.name);
  if (name === null) return;
  r.name = name;

  const tab = state.tabs.find(t => t.reqId === id);
  if (tab) {
    tab.req.name = name;
    if (activeTab() === tab) document.getElementById('req-name-input').value = name;
    renderTabStrip();
  }

  renderSidebar();
  scheduleDiskSave();
}

function dupReq(id) {
  const src = findReq(id);
  if (!src) return;

  const copy = { ...clone(src), id: uid(), name: src.name + ' (copy)' };
  const col  = state.cols.find(c => c.requests.some(r => r.id === id));
  if (!col) return;

  col.requests.push(copy);
  selectReq(copy.id);
  renderSidebar();
  scheduleDiskSave();
}

// ─── Move / Delete (single and batch) ────────────────────────────────────────

function moveReqs(ids, targetType, targetId) {
  const idSet = new Set(ids);
  const moved = [];

  state.cols = state.cols.map(c => ({
    ...c,
    requests: c.requests.filter(r => { if (idSet.has(r.id)) { moved.push(clone(r)); return false; } return true; }),
    folders:  c.folders.map(f => ({
      ...f,
      requests: f.requests.filter(r => { if (idSet.has(r.id)) { moved.push(clone(r)); return false; } return true; }),
    })),
  }));

  if (!moved.length) return;

  if (targetType === 'col') {
    const col = state.cols.find(c => c.id === targetId);
    if (col) { moved.forEach(r => col.requests.push(r)); state.expandedCols.add(targetId); }
  } else if (targetType === 'folder') {
    for (const col of state.cols) {
      const folder = col.folders.find(f => f.id === targetId);
      if (folder) {
        moved.forEach(r => folder.requests.push(r));
        state.expandedCols.add(col.id);
        state.expandedFolders.add(targetId);
        break;
      }
    }
  }

  state.selectedReqIds = new Set();
  renderSidebar();
  scheduleDiskSave();
}

async function deleteReqs(ids) {
  const label = ids.length === 1 ? `"${findReq(ids[0])?.name}"` : `these ${ids.length} requests`;
  if (!await confirmDialog(`Delete ${label}?`, { okLabel: 'Delete', danger: true })) return;

  const idSet = new Set(ids);
  state.cols = state.cols.map(c => ({
    ...c,
    requests: c.requests.filter(r => !idSet.has(r.id)),
    folders:  c.folders.map(f => ({ ...f, requests: f.requests.filter(r => !idSet.has(r.id)) })),
  }));

  state.tabs = state.tabs.filter(t => !idSet.has(t.reqId));
  if (state.activeTabId && !state.tabs.some(t => t.id === state.activeTabId)) {
    state.activeTabId = state.tabs[0]?.id || null;
  }

  state.selectedReqIds = new Set();
  renderSidebar();
  if (activeTab()) showReqEditor();
  else showEmptyState();
  scheduleDiskSave();
  syncMockRoutes();
}

// ─── Drag & drop reordering ───────────────────────────────────────────────────
// Persisted ordering lives in the array order of state.cols[].requests and
// state.cols[].folders[].requests/folders themselves — server.js writes each
// request's array index as its `order` field (and a per-collection _meta.json
// for folder order/existence) on save, and sorts by that on load. So reordering
// here is just splicing these arrays; scheduleDiskSave() persists the new order.

// Finds the {list, index} of the array (a collection's or folder's `requests`)
// that currently contains the request `id`.
function findReqContainer(id) {
  for (const col of state.cols) {
    let idx = col.requests.findIndex(r => r.id === id);
    if (idx !== -1) return { list: col.requests, index: idx };
    for (const f of col.folders) {
      idx = f.requests.findIndex(r => r.id === id);
      if (idx !== -1) return { list: f.requests, index: idx };
    }
  }
  return null;
}

// Moves request `id` out of its current list and into `targetList` at
// `targetIndex` (an index within `targetList` as it exists *before* removal).
function moveReqToPosition(id, targetList, targetIndex) {
  const src = findReqContainer(id);
  if (!src) return;
  const [req] = src.list.splice(src.index, 1);
  let idx = targetIndex;
  if (src.list === targetList && src.index < targetIndex) idx--;
  targetList.splice(idx, 0, req);
}

// Reorders folder `folderId` within its collection to `targetIndex` (an index
// within col.folders as it exists *before* removal). Folders only reorder
// within their own collection — moving a folder to a different collection
// isn't supported.
function moveFolderToPosition(colId, folderId, targetIndex) {
  const col = state.cols.find(c => c.id === colId);
  if (!col) return;
  const srcIdx = col.folders.findIndex(f => f.id === folderId);
  if (srcIdx === -1) return;
  const [folder] = col.folders.splice(srcIdx, 1);
  let idx = targetIndex;
  if (srcIdx < targetIndex) idx--;
  col.folders.splice(idx, 0, folder);
}

// Reorders collection `colId` within state.cols to `targetIndex` (an index
// within state.cols as it exists *before* removal).
function moveColToPosition(colId, targetIndex) {
  const srcIdx = state.cols.findIndex(c => c.id === colId);
  if (srcIdx === -1) return;
  const [col] = state.cols.splice(srcIdx, 1);
  let idx = targetIndex;
  if (srcIdx < targetIndex) idx--;
  state.cols.splice(idx, 0, col);
}

// ─── Backup export / import (all collections, as plain JSON) ──────────────────

// Exports every collection (requests + folders) and environment as a single
// JSON file that can be re-imported via importAny() — by this Salvo instance
// or shared with a team and merged into theirs.
function exportAll() {
  const payload = { cols: clone(state.cols), envs: clone(state.envs) };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = 'salvo-export.json';
  a.click();
}

// Merge a list of [key, value] vars into an environment matched by name,
// creating it if it doesn't exist. New keys are added; changed values are
// replaced; identical keys are left untouched.
function mergeEnvVars(envName, pairs) {
  let env = state.envs.find(e => e.name === envName);
  if (!env) {
    env = { id: uid(), name: envName, vars: [] };
    state.envs.push(env);
  }
  let changed = 0;
  pairs.forEach(([k, v]) => {
    if (!k) return;
    const existing = env.vars.find(row => row.key === k);
    if (!existing) {
      env.vars.push({ id: uid(), key: k, value: v ?? '', enabled: true });
      changed++;
    } else if (existing.value !== (v ?? '')) {
      existing.value = v ?? '';
      changed++;
    }
  });
  return { envName: env.name, changed };
}

// ─── Import preview modal ─────────────────────────────────────────────────────

let _importPending = null;

function _buildImportItems(importedCols) {
  const items = [];
  importedCols.forEach(ic => {
    const col = state.cols.find(c => c.name === ic.name);
    const checkReqs = (reqs, folderName) => {
      const existingList = folderName
        ? ((col && col.folders.find(f => f.name === folderName)) || { requests: [] }).requests
        : (col || { requests: [] }).requests;
      reqs.forEach(r => {
        const match = existingList.find(x => x.name === r.name);
        if (!match) {
          items.push({ id: uid(), colName: ic.name, folderName, name: r.name, type: 'new', req: r });
        } else if (reqFingerprint(r) !== reqFingerprint(match)) {
          items.push({ id: uid(), colName: ic.name, folderName, name: r.name, type: 'changed', req: r, existing: match });
        }
        // identical → silent skip
      });
    };
    checkReqs(ic.requests, null);
    ic.folders.forEach(ifo => checkReqs(ifo.requests, ifo.name));
  });
  return items;
}

function openImportModal(rawData) {
  const importedCols = (rawData.cols || []).map(c => ({
    name:        c.name,
    description: c.description || '',
    requests:    (c.requests || []).map(normalizeReq),
    folders:     (c.folders  || []).map(f => ({
      name:     f.name,
      requests: (f.requests || []).map(normalizeReq),
    })),
  }));

  _importPending = { rawData, importedCols, items: _buildImportItems(importedCols) };

  const list = document.getElementById('import-list');
  const items = _importPending.items;

  if (!items.length) {
    list.innerHTML = `<div class="import-empty">Nothing to import — all requests are already up to date.</div>`;
  } else {
    const groups = {};
    items.forEach(item => { (groups[item.colName] = groups[item.colName] || []).push(item); });
    let html = '';
    for (const [colName, colItems] of Object.entries(groups)) {
      html += `<div class="import-col-group"><div class="import-col-name">${esc(colName)}</div>`;
      colItems.forEach(item => {
        const path = item.folderName ? `<span class="import-item-path">${esc(item.folderName)} / </span>` : '';
        const tagClass = item.type === 'new' ? 'import-tag-new' : 'import-tag-changed';
        const tagLabel = item.type === 'new' ? 'New' : 'Changed';
        const color = MC[item.req.method] || 'var(--text)';
        if (item.type === 'changed') {
          const diffHtml = buildDiffHTML(buildChangeDiff(item.req, item.existing));
          html += `<div class="import-item-wrap">
            <div class="import-item">
              <input type="checkbox" data-import-id="${esc(item.id)}" checked>
              <span class="req-method" style="color:${color};font-size:10px;font-weight:700;min-width:44px;flex-shrink:0">${esc(item.req.method)}</span>
              <span class="import-item-name">${path}${esc(item.name)}</span>
              <span class="import-item-tag ${tagClass}">${tagLabel}</span>
              <button class="import-diff-toggle" id="import-diff-btn-${esc(item.id)}" onclick="toggleImportDiff('${esc(item.id)}')">▶</button>
            </div>
            <div class="changes-diff import-diff" id="import-diff-${esc(item.id)}" style="display:none">${diffHtml}</div>
          </div>`;
        } else {
          html += `<div class="import-item">
            <input type="checkbox" data-import-id="${esc(item.id)}" checked>
            <span class="req-method" style="color:${color};font-size:10px;font-weight:700;min-width:44px;flex-shrink:0">${esc(item.req.method)}</span>
            <span class="import-item-name">${path}${esc(item.name)}</span>
            <span class="import-item-tag ${tagClass}">${tagLabel}</span>
          </div>`;
        }
      });
      html += `</div>`;
    }
    list.innerHTML = html;
  }

  document.getElementById('import-overwrite-all').checked = false;
  document.getElementById('import-modal').style.display = 'flex';
}

function closeImportModal() {
  document.getElementById('import-modal').style.display = 'none';
  _importPending = null;
}

function importToggleAll(checked) {
  document.querySelectorAll('#import-list input[type=checkbox]').forEach(cb => { cb.checked = checked; });
}

function toggleImportDiff(itemId) {
  const diff = document.getElementById(`import-diff-${itemId}`);
  const btn  = document.getElementById(`import-diff-btn-${itemId}`);
  if (!diff) return;
  const open = diff.style.display === 'none';
  diff.style.display = open ? 'block' : 'none';
  if (btn) btn.textContent = open ? '▼' : '▶';
}

function _applyImportItems(items, rawData) {
  let added = 0, updated = 0;

  items.forEach(item => {
    let col = state.cols.find(c => c.name === item.colName);
    if (!col) {
      col = { id: uid(), name: item.colName, description: '', requests: [], folders: [] };
      state.cols.push(col);
    }
    state.expandedCols.add(col.id);

    if (item.folderName) {
      let folder = col.folders.find(f => f.name === item.folderName);
      if (!folder) { folder = { id: uid(), name: item.folderName, requests: [] }; col.folders.push(folder); }
      const idx = folder.requests.findIndex(x => x.name === item.name);
      if (idx >= 0) { folder.requests[idx] = { ...item.req, id: folder.requests[idx].id }; updated++; }
      else          { folder.requests.push(item.req); added++; }
    } else {
      const idx = col.requests.findIndex(x => x.name === item.name);
      if (idx >= 0) { col.requests[idx] = { ...item.req, id: col.requests[idx].id }; updated++; }
      else          { col.requests.push(item.req); added++; }
    }
  });

  let envsChanged = 0;
  ((rawData && rawData.envs) || []).forEach(ie => {
    if (!ie || !ie.name) return;
    const pairs = Array.isArray(ie.vars) ? ie.vars.map(v => [v.key, v.value]) : Object.entries(ie.vars || {});
    const { changed } = mergeEnvVars(ie.name, pairs);
    envsChanged += changed;
  });

  renderSidebar();
  renderEnvSelect();
  scheduleDiskSave();
  return { added, updated, envsChanged };
}

function confirmImport() {
  if (!_importPending) return;

  const checkedIds = new Set(
    [...document.querySelectorAll('#import-list input[type=checkbox]:checked')]
      .map(cb => cb.dataset.importId)
  );
  const items = _importPending.items.filter(item => checkedIds.has(item.id));
  const { added, updated, envsChanged } = _applyImportItems(items, _importPending.rawData);

  // Refresh any open tabs whose requests were replaced, keeping the same tab focused
  state.tabs.forEach(tab => {
    if (!tab.reqId) return;
    const current = findReq(tab.reqId);
    if (current) tab.req = clone(current);
  });

  closeImportModal();

  renderTabStrip();
  if (activeTab()) { syncReqEditor(); renderReqPanel(); }

  const parts = [];
  if (added)        parts.push(`${added} added`);
  if (updated)      parts.push(`${updated} updated`);
  if (envsChanged)  parts.push(`${envsChanged} env var${envsChanged === 1 ? '' : 's'} synced`);
  notify(parts.length ? `Imported: ${parts.join(', ')}` : 'Nothing changed', 'success');
}

// ─── Import dropdown ─────────────────────────────────────────────────────────

function toggleImportDropdown() {
  const menu = document.getElementById('import-dropdown-menu');
  const open = menu.style.display !== 'none';
  if (open) { closeImportDropdown(); return; }
  menu.style.display = 'flex';
  setTimeout(() => document.addEventListener('click', _importDropdownOutside, { once: true }), 0);
}

function closeImportDropdown() {
  document.getElementById('import-dropdown-menu').style.display = 'none';
}

function _importDropdownOutside(e) {
  if (!document.getElementById('import-dropdown').contains(e.target)) closeImportDropdown();
}

// ─── URL import modal ─────────────────────────────────────────────────────────

function openUrlImportModal() {
  const input = document.getElementById('url-import-input');
  const err   = document.getElementById('url-import-error');
  input.value = '';
  err.style.display = 'none';
  document.getElementById('url-import-btn').disabled = false;
  document.getElementById('url-import-modal').style.display = 'flex';
  input.focus();
}

function closeUrlImportModal() {
  document.getElementById('url-import-modal').style.display = 'none';
}

async function fetchImportFromUrl() {
  const input = document.getElementById('url-import-input');
  const err   = document.getElementById('url-import-error');
  const btn   = document.getElementById('url-import-btn');
  const url   = input.value.trim();

  if (!url) { showUrlImportError('Please enter a URL.'); return; }

  btn.disabled  = true;
  btn.textContent = 'Fetching…';
  err.style.display = 'none';

  try {
    const res = await fetch('/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'GET', url, headers: {}, skipCookieJar: true }),
    });
    const envelope = await res.json();
    if (!envelope.ok) throw new Error(envelope.error || `Request failed`);
    if (envelope.status < 200 || envelope.status >= 300)
      throw new Error(`Server returned ${envelope.status}`);

    let text, data;
    try { text = atob(envelope.bodyBase64); } catch { throw new Error('Could not decode response.'); }
    try { data = JSON.parse(text); } catch { throw new Error('Response is not valid JSON.'); }

    closeUrlImportModal();
    await importAnyData(data);
  } catch (e) {
    showUrlImportError(e.message || 'Failed to fetch URL.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Fetch & Preview';
  }
}

function showUrlImportError(msg) {
  const err = document.getElementById('url-import-error');
  err.textContent = msg;
  err.style.display = 'block';
}

// ─── Import cURL modal ────────────────────────────────────────────────────────

let _curlImportPending = null;

function openCurlImportModal() {
  const sel = document.getElementById('curl-import-col-select');
  sel.innerHTML = state.cols.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('')
    + `<option value="__new__">New collection…</option>`;
  sel.value = state.cols.length ? state.cols[0].name : '__new__';
  const newInput = document.getElementById('curl-import-col-new');
  newInput.value        = '';
  newInput.style.display = sel.value === '__new__' ? '' : 'none';
  document.getElementById('curl-import-text').value = '';
  _curlImportResetPreview();
  document.getElementById('curl-import-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('curl-import-text')?.focus(), 0);
}

function _curlImportColChange() {
  const sel = document.getElementById('curl-import-col-select');
  const newInput = document.getElementById('curl-import-col-new');
  const isNew = sel.value === '__new__';
  newInput.style.display = isNew ? '' : 'none';
  if (isNew) setTimeout(() => newInput.focus(), 0);
  _curlImportResetPreview();
}

function _curlImportGetColName() {
  const sel = document.getElementById('curl-import-col-select');
  if (sel.value === '__new__') {
    return document.getElementById('curl-import-col-new').value.trim() || 'Imported';
  }
  return sel.value;
}

function closeCurlImportModal() {
  document.getElementById('curl-import-modal').style.display = 'none';
  _curlImportPending = null;
}

function _curlImportResetPreview() {
  document.getElementById('curl-import-preview').style.display     = 'none';
  document.getElementById('curl-import-preview-btn').style.display = '';
  document.getElementById('curl-import-confirm-btn').style.display = 'none';
  _curlImportPending = null;
}

function previewCurlImport() {
  const text    = document.getElementById('curl-import-text').value.trim();
  const colName = _curlImportGetColName();

  if (!text) { notify('Paste some curl commands first', 'error'); return; }

  const blocks  = parseCurlBatch(text);
  const results = blocks.map(block => {
    const hasShellVars = /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(block.curlText);
    const parsed       = parseCurlCommand(block.curlText);
    const name         = block.name || (parsed.url ? curlBatchNameFromUrl(parsed.url) : null) || 'Request';
    return { name, parsed, hasShellVars, block };
  });

  _curlImportPending = { results, colName };

  let html       = '';
  let validCount = 0;

  results.forEach(r => {
    if (r.parsed.ok) {
      validCount++;
      const color = MC[r.parsed.method] || 'var(--text)';
      html += `<div class="import-item">
        <span class="req-method" style="color:${color};font-size:10px;font-weight:700;min-width:44px;flex-shrink:0">${esc(r.parsed.method)}</span>
        <span class="import-item-name">${esc(r.name)}</span>
        <span class="import-item-tag import-tag-new">New</span>
      </div>`;
      if (r.hasShellVars) {
        html += `<div style="padding:2px 12px 6px 56px;font-size:11px;color:var(--warning)">⚠ Shell variables will appear as literals — replace with Salvo {{variables}} after import</div>`;
      }
      (r.parsed.warnings || []).forEach(w => {
        html += `<div style="padding:2px 12px 6px 56px;font-size:11px;color:var(--warning)">⚠ ${esc(w)}</div>`;
      });
    } else {
      const firstLine = r.block.curlText.split('\n')[0].slice(0, 80);
      html += `<div class="import-item" style="opacity:0.55">
        <span style="font-size:10px;font-weight:700;min-width:44px;flex-shrink:0;color:var(--danger)">—</span>
        <span class="import-item-name" style="color:var(--text-muted);font-family:monospace;font-size:11px">${esc(firstLine)}</span>
        <span class="import-item-tag" style="background:var(--danger-bg);color:var(--danger)">Skipped</span>
      </div>`;
      if (r.hasShellVars) {
        html += `<div style="padding:2px 12px 6px 56px;font-size:11px;color:var(--danger)">Shell variables detected — replace $VAR with literal values or Salvo {{variables}}</div>`;
      } else {
        (r.parsed.errors || []).forEach(e => {
          html += `<div style="padding:2px 12px 6px 56px;font-size:11px;color:var(--danger)">✕ ${esc(e)}</div>`;
        });
      }
    }
  });

  if (!html) html = '<div class="import-empty">No curl commands found.</div>';

  document.getElementById('curl-import-preview-list').innerHTML = html;
  document.getElementById('curl-import-preview').style.display  = '';

  const btn = document.getElementById('curl-import-confirm-btn');
  if (validCount > 0) {
    btn.textContent   = `Import ${validCount}`;
    btn.style.display = '';
    document.getElementById('curl-import-preview-btn').style.display = 'none';
  } else {
    btn.style.display = 'none';
  }
}

function confirmCurlImport() {
  if (!_curlImportPending) return;
  const { results, colName } = _curlImportPending;

  const valid = results.filter(r => r.parsed.ok);
  if (!valid.length) return;

  let col = state.cols.find(c => c.name === colName);
  if (!col) {
    col = { id: uid(), name: colName, description: '', folders: [], requests: [] };
    state.cols.unshift(col);
  }
  state.expandedCols.add(col.id);

  let added = 0;
  valid.forEach(r => {
    const name = _curlUniqueName(r.name, col.requests.map(x => x.name));
    const req  = normalizeReq({
      name,
      method:  r.parsed.method,
      url:     r.parsed.url,
      params:  _curlExtractParams(r.parsed.url),
      headers: r.parsed.headers.map(h => {
        const c = h.indexOf(':');
        return { id: uid(), key: h.slice(0, c).trim(), value: h.slice(c + 1).trim(), enabled: true, note: '' };
      }),
      body: _curlImportBody(r.parsed),
    });
    col.requests.push(req);
    added++;
  });

  renderSidebar();
  scheduleDiskSave();
  closeCurlImportModal();
  notify(`Imported ${added} request${added !== 1 ? 's' : ''} into "${colName}"`, 'success');
}

function _curlUniqueName(name, existing) {
  if (!existing.includes(name)) return name;
  let i = 2;
  while (existing.includes(`${name} (${i})`)) i++;
  return `${name} (${i})`;
}

function _curlExtractParams(url) {
  try {
    const qi = url.indexOf('?');
    if (qi < 0) return [];
    return url.slice(qi + 1).split('&').filter(Boolean).map(pair => {
      const ei = pair.indexOf('=');
      return ei < 0
        ? { id: uid(), key: pair, value: '', enabled: true, note: '' }
        : { id: uid(), key: pair.slice(0, ei), value: pair.slice(ei + 1), enabled: true, note: '' };
    });
  } catch { return []; }
}

function _curlImportBody(parsed) {
  const b = defaultBody();
  if (parsed.bodyType === 'raw') {
    b.type        = 'raw';
    b.raw         = parsed.bodyContent;
    b.contentType = parsed.bodyContentType || 'text';
  } else if (parsed.bodyType === 'formdata') {
    b.type     = 'formdata';
    b.formData = parsed.bodyContent.map(f => ({ id: uid(), key: f.key, value: f.value, enabled: true }));
  } else if (parsed.bodyType === 'urlencoded') {
    b.type     = 'urlencoded';
    b.formData = parsed.bodyContent.map(f => ({ id: uid(), key: f.key, value: f.value, enabled: true }));
  }
  return b;
}

// Dispatches based on JSON shape — shared by file and URL import paths.
async function importAnyData(data) {
  if (Array.isArray(data.cols)) {
    openImportModal(data);
  } else if (data.item) {
    const col = parsePostman(data);
    state.cols.push(col);
    state.expandedCols.add(col.id);

    let envMsg = '';
    if (Array.isArray(data.variable) && data.variable.length) {
      const { changed } = mergeEnvVars(col.name, data.variable.map(v => [v.key, v.value]));
      if (changed) envMsg = `, ${changed} env var${changed === 1 ? '' : 's'}`;
    }

    renderSidebar();
    renderEnvSelect();
    scheduleDiskSave();
    notify('Imported: ' + col.name + envMsg, 'success');
  } else if (data._postman_variable_scope === 'environment' && Array.isArray(data.values)) {
    const pairs = data.values.filter(v => v.enabled !== false).map(v => [v.key, v.value]);
    const { envName, changed } = mergeEnvVars(data.name || 'Imported Environment', pairs);
    renderEnvSelect();
    scheduleDiskSave();
    notify(`Imported environment "${envName}" (${changed} var${changed === 1 ? '' : 's'})`, 'success');
  } else {
    throw new Error('Not a Salvo export, Postman collection, or Postman environment');
  }
}

async function importAny(event) {
  const file = event.target.files[0];
  if (!file) return;

  try {
    const data = JSON.parse(await file.text());
    await importAnyData(data);
  } catch (err) {
    notify('Import failed: ' + err.message, 'error');
  }

  event.target.value = '';
}

function parsePostman(data) {
  if (!data?.item) throw new Error('Not a Postman v2.x collection');

  const folders  = [];
  const requests = [];

  function parseItem(item, targetReqs, targetFolders) {
    if (item.item) {
      // Folder
      const folder = { id: uid(), name: item.name || 'Folder', requests: [] };
      item.item.forEach(child => {
        if (child.item) parseItem(child, folder.requests, targetFolders);
        else folder.requests.push(parseReqItem(child));
      });
      targetFolders.push(folder);
    } else {
      targetReqs.push(parseReqItem(item));
    }
  }

  function parseReqItem(item) {
    const r       = item.request || {};
    const headers = (r.header || []).map(h => ({
      id: uid(), key: h.key || '', value: h.value || '', enabled: !h.disabled,
    }));

    const params = [];
    let url = '';

    if (typeof r.url === 'string') {
      url = r.url;
    } else if (r.url) {
      url = r.url.raw || '';
      (r.url.query || []).forEach(q =>
        params.push({ id: uid(), key: q.key || '', value: q.value || '', enabled: !q.disabled })
      );
    }

    let body = { type: 'none', raw: '', formData: [] };
    if (r.body) {
      if (r.body.mode === 'raw') {
        body = { type: 'raw', raw: r.body.raw || '', formData: [], contentType: r.body.options?.raw?.language || 'json' };
      } else if (r.body.mode === 'formdata') {
        body = { type: 'formdata', raw: '', formData: (r.body.formdata || []).map(f => ({ id: uid(), key: f.key, value: f.value, enabled: !f.disabled })) };
      } else if (r.body.mode === 'urlencoded') {
        body = { type: 'urlencoded', raw: '', formData: (r.body.urlencoded || []).map(f => ({ id: uid(), key: f.key, value: f.value, enabled: !f.disabled })) };
      }
    }

    const auth = defaultAuth();
    if (r.auth?.type === 'bearer') {
      auth.type  = 'bearer';
      auth.token = r.auth.bearer?.find(b => b.key === 'token')?.value || '';
    } else if (r.auth?.type === 'basic') {
      auth.type     = 'basic';
      auth.username = r.auth.basic?.find(b => b.key === 'username')?.value || '';
      auth.password = r.auth.basic?.find(b => b.key === 'password')?.value || '';
    }

    return {
      id: uid(),
      name:    item.name || 'Untitled',
      method:  (r.method || 'GET').toUpperCase(),
      url, headers, params, body, auth,
      description: typeof item.request?.description === 'string' ? item.request.description : (item.description || ''),
    };
  }

  data.item.forEach(item => parseItem(item, requests, folders));

  return {
    id:   uid(),
    name: data.info?.name || 'Imported Collection',
    description: data.info?.description || '',
    folders,
    requests,
  };
}
