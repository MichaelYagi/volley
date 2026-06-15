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
  state.cols.push(col);
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
// creating it if it doesn't exist. Existing keys are left untouched.
function mergeEnvVars(envName, pairs) {
  let env = state.envs.find(e => e.name === envName);
  if (!env) {
    env = { id: uid(), name: envName, vars: [] };
    state.envs.push(env);
  }
  let added = 0;
  pairs.forEach(([k, v]) => {
    if (!k || env.vars.some(row => row.key === k)) return;
    env.vars.push({ id: uid(), key: k, value: v ?? '', enabled: true });
    added++;
  });
  return { envName: env.name, added };
}

// Merge a { cols, envs } payload into the current state. Existing collections/
// folders are matched by name; requests with a name that already exists in the
// matching collection/folder are skipped. Environments are matched by name and
// merged var-by-var, leaving existing vars untouched.
function mergeImportedData(data) {
  const importedCols = (data.cols || []).map(c => ({
    name:     c.name,
    description: c.description || '',
    requests: (c.requests || []).map(normalizeReq),
    folders:  (c.folders  || []).map(f => ({
      name:     f.name,
      requests: (f.requests || []).map(normalizeReq),
    })),
  }));

  let added = 0, skipped = 0;

  importedCols.forEach(ic => {
    let col = state.cols.find(c => c.name === ic.name);
    if (!col) {
      col = { id: uid(), name: ic.name, description: ic.description || '', requests: [], folders: [] };
      state.cols.push(col);
    }
    state.expandedCols.add(col.id);

    ic.requests.forEach(r => {
      if (col.requests.some(x => x.name === r.name)) { skipped++; return; }
      col.requests.push(r);
      added++;
    });

    ic.folders.forEach(ifo => {
      let folder = col.folders.find(f => f.name === ifo.name);
      if (!folder) {
        folder = { id: uid(), name: ifo.name, requests: [] };
        col.folders.push(folder);
      }
      ifo.requests.forEach(r => {
        if (folder.requests.some(x => x.name === r.name)) { skipped++; return; }
        folder.requests.push(r);
        added++;
      });
    });
  });

  let envsAdded = 0, varsAdded = 0;
  (data.envs || []).forEach(ie => {
    if (!ie || !ie.name) return;
    const existed = state.envs.some(e => e.name === ie.name);
    const pairs = Array.isArray(ie.vars) ? ie.vars.map(v => [v.key, v.value]) : Object.entries(ie.vars || {});
    const { added: va } = mergeEnvVars(ie.name, pairs);
    if (!existed) envsAdded++;
    varsAdded += va;
  });

  renderSidebar();
  renderEnvSelect();
  scheduleDiskSave();

  const skippedMsg = skipped ? `, skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}` : '';
  const envMsg = (envsAdded || varsAdded)
    ? `, ${envsAdded} new env${envsAdded === 1 ? '' : 's'} (${varsAdded} var${varsAdded === 1 ? '' : 's'})`
    : '';
  notify(`Imported ${added} request${added === 1 ? '' : 's'}${skippedMsg}${envMsg}`, 'success');
}

// Dispatches based on JSON shape: a Salvo export ({ cols }) is merged into the
// current collections; a Postman v2.x collection ({ info, item }) is added as
// a new collection.
async function importAny(event) {
  const file = event.target.files[0];
  if (!file) return;

  try {
    const data = JSON.parse(await file.text());

    if (Array.isArray(data.cols)) {
      mergeImportedData(data);
    } else if (data.item) {
      const col = parsePostman(data);
      state.cols.push(col);
      state.expandedCols.add(col.id);

      let envMsg = '';
      if (Array.isArray(data.variable) && data.variable.length) {
        const { added } = mergeEnvVars(col.name, data.variable.map(v => [v.key, v.value]));
        if (added) envMsg = `, ${added} env var${added === 1 ? '' : 's'}`;
      }

      renderSidebar();
      renderEnvSelect();
      scheduleDiskSave();
      notify('Imported: ' + col.name + envMsg, 'success');
    } else if (data._postman_variable_scope === 'environment' && Array.isArray(data.values)) {
      const pairs = data.values.filter(v => v.enabled !== false).map(v => [v.key, v.value]);
      const { envName, added } = mergeEnvVars(data.name || 'Imported Environment', pairs);
      renderEnvSelect();
      scheduleDiskSave();
      notify(`Imported environment "${envName}" (${added} var${added === 1 ? '' : 's'})`, 'success');
    } else {
      throw new Error('Not a Salvo export, Postman collection, or Postman environment');
    }
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
