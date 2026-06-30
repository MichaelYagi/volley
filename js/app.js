// ─── Data loading / saving (data/ via server.js) ───────────────────────────────

async function loadData() {
  const res  = await fetch('/api/data');
  const data = await res.json();

  state.cols = (data.cols || []).map(c => ({
    id:       uid(),
    name:     c.name,
    description: c.description || '',
    requests: (c.requests || []).map(normalizeReq),
    folders:  (c.folders  || []).map(f => ({
      id:       uid(),
      name:     f.name,
      requests: (f.requests || []).map(normalizeReq),
    })),
  }));

  state.envs      = data.envs?.length ? data.envs : [{ id: 'default', name: 'No Environment', vars: [] }];
  state.activeEnv = data.activeEnv || 'default';
  state.globals   = data.globals || [];
  state.hist      = data.hist || [];

  state.expandedCols = new Set(state.cols.map(c => c.id));

  // Restore open tabs from the last session. Saved tabs reference requests by
  // {col, folder, name} (see findReqLocation/findReqByLocation) since `id`s
  // are ephemeral and regenerated on every load.
  let activeIdx = -1;
  state.tabs = (data.openTabs || []).map((ot, i) => {
    const r = findReqByLocation(ot);
    if (!r) return null;
    if (i === data.activeIndex) activeIdx = i;
    return {
      id: uid(), reqId: r.id, req: clone(r), resp: null,
      reqTab: ot.reqTab || 'headers', respTab: 'body', loading: false, abortCtrl: null,
    };
  });
  const activeTabAtIdx = activeIdx >= 0 ? state.tabs[activeIdx] : null;
  state.tabs = state.tabs.filter(Boolean);
  state.activeTabId = activeTabAtIdx ? activeTabAtIdx.id : (state.tabs[0]?.id || null);
}

// ─── Serialize open tabs for persistence ───────────────────────────────────────
function serializeOpenTabs() {
  return state.tabs.filter(t => t.reqId).map(t => {
    const loc = findReqLocation(t.reqId);
    return loc ? { ...loc, reqTab: t.reqTab } : null;
  }).filter(Boolean);
}

// Index of the active tab within serializeOpenTabs()'s output (or -1)
function activeOpenTabIndex() {
  const tab = activeTab();
  if (!tab || !tab.reqId) return -1;
  return state.tabs.filter(t => t.reqId).indexOf(tab);
}

async function saveAll(silent = false) {
  setSaveStatus('saving');
  try {
    const res = await fetch('/api/save', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ cols: state.cols, envs: state.envs, activeEnv: state.activeEnv, globals: state.globals, hist: state.hist, openTabs: serializeOpenTabs(), activeIndex: activeOpenTabIndex() }),
    });
    const data = await res.json();
    if (data.ok) {
      setSaveStatus('saved');
      if (!silent) {
        snapshotAllRequests();
        notify('Saved', 'success');
      }
      updateChangesBadge();
    } else {
      setSaveStatus('error');
      notify('Save failed: ' + data.error, 'error');
    }
  } catch (e) {
    setSaveStatus('error');
    notify('Save failed: ' + e.message, 'error');
  }
}

function setSaveStatus(status) {
  const el = document.getElementById('save-status');
  if (!el) return;
  if (status === 'saving') {
    el.textContent = 'Saving…';
    el.style.color = 'var(--text-muted)';
  } else if (status === 'saved') {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    el.textContent = `Saved ${time}`;
    el.style.color = 'var(--text-muted)';
  } else {
    el.textContent = 'Save failed';
    el.style.color = 'var(--danger)';
  }
}

// ─── App Init ─────────────────────────────────────────────────────────────────

async function init() {
  try {
    await loadData();
    snapshotAllRequests();
  } catch (e) {
    notify('Could not load data/: ' + e.message, 'error');
  }

  document.querySelectorAll('#method-select option').forEach(opt => {
    opt.style.color = MC[opt.value] || 'var(--text)';
  });

  applyFeatureFlags();
  refreshCookieJar().then(() => { if (activeTab()?.reqTab === 'headers') renderReqPanel(); });
  refreshMockServerStatus();
  initGitSync();
  renderEnvSelect();
  renderSidebar();
  setupResizer();
  setupPanelResizer();
  if (activeTab()) showReqEditor();
  else showEmptyState();
  document.addEventListener('click', hideCtxMenu);

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveAll();
    }
  });

  window.addEventListener('beforeunload', () => {
    clearTimeout(_diskSaveTimer);
    syncAllTabsIntoCols();
    const payload = JSON.stringify({ cols: state.cols, envs: state.envs, activeEnv: state.activeEnv, globals: state.globals, hist: state.hist, openTabs: serializeOpenTabs(), activeIndex: activeOpenTabIndex() });
    navigator.sendBeacon('/api/save', new Blob([payload], { type: 'application/json' }));
  });
}

// ─── Sidebar Drag-to-Resize ───────────────────────────────────────────────────

function setupResizer() {
  const resizer = document.getElementById('resizer');
  const sidebar = document.getElementById('sidebar');
  let dragging  = false;
  let startX, startW;

  resizer.addEventListener('mousedown', e => {
    dragging = true;
    startX   = e.clientX;
    startW   = sidebar.offsetWidth;
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const w = Math.max(180, Math.min(420, startW + e.clientX - startX));
    sidebar.style.width = w + 'px';
  });

  document.addEventListener('mouseup', () => {
    dragging = false;
    document.body.style.userSelect = '';
  });
}

// ─── Request/Response Drag-to-Resize ──────────────────────────────────────────

function setupPanelResizer() {
  const resizer  = document.getElementById('panel-resizer');
  const reqPanel = document.getElementById('req-panel');
  const editor   = document.getElementById('req-editor');
  let dragging = false;
  let startY, startH;

  resizer.addEventListener('mousedown', e => {
    dragging = true;
    startY   = e.clientY;
    startH   = reqPanel.offsetHeight;
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const max = editor.offsetHeight - resizer.offsetHeight - 80;
    const h   = Math.max(80, Math.min(max, startH + e.clientY - startY));
    reqPanel.style.flex = `0 0 ${h}px`;
  });

  document.addEventListener('mouseup', () => {
    dragging = false;
    document.body.style.userSelect = '';
  });
}

// ─── History Panel ────────────────────────────────────────────────────────────

function toggleHistPanel() {
  state.showHist = !state.showHist;
  document.getElementById('hist-toggle').textContent = state.showHist ? '◀ Back to Request' : '⏱ History';

  if (state.showHist) {
    if (state.showChanges) {
      state.showChanges = false;
      document.getElementById('changes-panel').style.display = 'none';
      updateChangesToggleLabel();
    }
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('req-editor').style.display  = 'none';
    document.getElementById('hist-panel').style.display  = 'flex';
    renderHistPanel();
  } else {
    document.getElementById('hist-panel').style.display = 'none';
    if (activeTab()) showReqEditor();
    else showEmptyState();
  }
}

function renderHistPanel() {
  const list = document.getElementById('hist-list');

  if (!state.hist.length) {
    list.innerHTML = `<p class="muted" style="padding:12px;font-size:12px">No requests yet.</p>`;
    return;
  }

  list.innerHTML = [...state.hist].reverse().map((h, i) => {
    const color = statusColor(h.status);

    const badge = h.status
      ? `<span class="status-badge" style="background:${color}22;color:${color}">${h.status}</span>`
      : '';

    // reversed index → original index for replay
    const origIdx = state.hist.length - 1 - i;

    return `
      <div class="hist-item" onclick="replayHistory(${origIdx})">
        <div class="hist-top">
          <span style="color:${MC[h.method] || 'var(--text)'};font-weight:700">${h.method}</span>
          ${badge}
          <span style="margin-left:auto;color:var(--text-muted)">${h.elapsed}ms</span>
        </div>
        <div class="hist-url">${esc(h.url)}</div>
      </div>`;
  }).join('');
}

function replayHistory(i) {
  const h = state.hist[i];
  if (!h) return;

  // Populate a minimal scratch request from the history entry (not tied to any saved request)
  const req = {
    id:      uid(),
    name:    h.url,
    method:  h.method,
    url:     h.url,
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
  };

  const tab = {
    id: uid(), reqId: null, req, resp: null,
    reqTab: 'headers', respTab: 'body', loading: false, abortCtrl: null,
  };
  state.tabs.push(tab);
  state.activeTabId = tab.id;
  state.showHist = false;

  document.getElementById('hist-panel').style.display  = 'none';
  document.getElementById('hist-toggle').textContent   = '⏱ History';
  renderSidebar();
  showReqEditor();
}

async function clearHistory() {
  if (!await confirmDialog('Clear all request history?', { okLabel: 'Clear', danger: true })) return;
  state.hist = [];
  renderHistPanel();
  scheduleDiskSave();
}

// ─── Change Tracking ──────────────────────────────────────────────────────────

function snapshotAllRequests() {
  state.snapshots = new Map();
  for (const col of state.cols) {
    for (const req of col.requests) state.snapshots.set(req.id, clone(req));
    for (const folder of col.folders)
      for (const req of folder.requests) state.snapshots.set(req.id, clone(req));
  }
}

// Fingerprint of the user-editable fields of a request — excludes ephemeral
// fields (id, cached OAuth tokens, comments, description, mock, examples).

function getChangedRequests() {
  const changed = [];
  for (const col of state.cols) {
    for (const req of col.requests) {
      const orig = state.snapshots.get(req.id);
      if (orig && reqFingerprint(req) !== reqFingerprint(orig))
        changed.push({ req, original: orig, col, folder: null });
    }
    for (const folder of col.folders) {
      for (const req of folder.requests) {
        const orig = state.snapshots.get(req.id);
        if (orig && reqFingerprint(req) !== reqFingerprint(orig))
          changed.push({ req, original: orig, col, folder });
      }
    }
  }
  return changed;
}

function updateChangesBadge() {
  const count = getChangedRequests().length;
  const badge = document.getElementById('changes-badge');
  if (badge) {
    badge.textContent = count || '';
    badge.style.display = count ? 'inline-flex' : 'none';
  }
  if (state.showChanges) renderChangesPanel();
}

function updateChangesToggleLabel() {
  const btn = document.getElementById('changes-toggle');
  if (!btn) return;
  const count = getChangedRequests().length;
  const badgeHtml = count ? `<span id="changes-badge" class="changes-badge">${count}</span>` : `<span id="changes-badge" class="changes-badge" style="display:none"></span>`;
  btn.innerHTML = `✎ Changes ${badgeHtml}`;
}

function toggleChangesPanel() {
  state.showChanges = !state.showChanges;

  if (state.showChanges) {
    if (state.showHist) {
      state.showHist = false;
      document.getElementById('hist-panel').style.display = 'none';
      document.getElementById('hist-toggle').textContent = '⏱ History';
    }
    document.getElementById('changes-toggle').textContent = '◀ Back to Request';
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('req-editor').style.display  = 'none';
    document.getElementById('changes-panel').style.display = 'flex';
    renderChangesPanel();
  } else {
    document.getElementById('changes-panel').style.display = 'none';
    updateChangesToggleLabel();
    if (activeTab()) showReqEditor();
    else showEmptyState();
  }
}

// Compares two kv arrays (params/headers/formData) and returns a list of
// added/removed/changed entries keyed by `key`.
function diffKvArray(origArr, currArr) {
  const orig = (origArr || []).filter(r => r.key);
  const curr = (currArr || []).filter(r => r.key);
  const changes = [];

  // Group by key to handle duplicates
  const group = arr => arr.reduce((m, r) => {
    (m[r.key] = m[r.key] || []).push(r); return m;
  }, {});
  const oMap = group(orig), cMap = group(curr);
  const allKeys = new Set([...Object.keys(oMap), ...Object.keys(cMap)]);

  for (const key of allKeys) {
    const oRows = oMap[key] || [], cRows = cMap[key] || [];
    const max = Math.max(oRows.length, cRows.length);
    for (let i = 0; i < max; i++) {
      const o = oRows[i], c = cRows[i];
      if (!o) changes.push({ type: 'added',   key, val: c.value, enabled: c.enabled });
      else if (!c) changes.push({ type: 'removed', key, val: o.value, enabled: o.enabled });
      else if (o.value !== c.value) changes.push({ type: 'changed', key, oldVal: o.value, newVal: c.value });
      else if (o.enabled !== c.enabled) changes.push({ type: 'toggled', key, val: o.value, enabled: c.enabled });
    }
  }
  return changes;
}

function buildChangeDiff(req, orig) {
  const rows = [];
  const simple = (field, oldVal, newVal) => rows.push({ field, oldVal: String(oldVal), newVal: String(newVal) });
  const note   = (field, msg)            => rows.push({ field, note: msg });
  const kv     = (field, origArr, currArr) => {
    const items = diffKvArray(origArr, currArr);
    if (items.length) rows.push({ field, kv: items });
  };

  if (req.name   !== orig.name)   simple('name',   orig.name,   req.name);
  if (req.method !== orig.method) simple('method', orig.method, req.method);
  if (req.url    !== orig.url)    simple('url',    orig.url || '(empty)', req.url || '(empty)');

  kv('params',   orig.params,   req.params);
  kv('path vars', orig.pathVars, req.pathVars);
  kv('headers',  orig.headers,  req.headers);

  if ((orig.body?.type || 'none') !== (req.body?.type || 'none'))
    simple('body', orig.body?.type || 'none', req.body?.type || 'none');
  else if (req.body?.type === 'formdata')
    kv('body', orig.body?.formData, req.body?.formData);
  else if (req.body?.type === 'raw' && orig.body?.raw !== req.body?.raw)
    note('body', 'raw content edited');
  else if (JSON.stringify(orig.body) !== JSON.stringify(req.body))
    note('body', 'modified');

  if ((orig.auth?.type || 'none') !== (req.auth?.type || 'none'))
    simple('auth', orig.auth?.type || 'none', req.auth?.type || 'none');
  else {
    const strip = a => { const c = { ...a }; delete c.cachedToken; delete c.cachedExpiry; delete c.cachedRefreshToken; return c; };
    if (JSON.stringify(strip(orig.auth)) !== JSON.stringify(strip(req.auth)))
      note('auth', 'credentials modified');
  }

  if (JSON.stringify(orig.disabledAutoHeaders || []) !== JSON.stringify(req.disabledAutoHeaders || []))
    note('auto-headers', 'disabled set changed');

  const ps = s => !!(s?.trim());
  if (ps(orig.preRequestScript) !== ps(req.preRequestScript))
    simple('pre-request script', ps(orig.preRequestScript) ? 'yes' : 'no', ps(req.preRequestScript) ? 'yes' : 'no');
  else if (orig.preRequestScript !== req.preRequestScript)
    note('pre-request script', 'edited');
  if (ps(orig.testScript) !== ps(req.testScript))
    simple('test script', ps(orig.testScript) ? 'yes' : 'no', ps(req.testScript) ? 'yes' : 'no');
  else if (orig.testScript !== req.testScript)
    note('test script', 'edited');

  if ((orig.mock?.enabled || false) !== (req.mock?.enabled || false))
    simple('mock', orig.mock?.enabled ? 'enabled' : 'disabled', req.mock?.enabled ? 'enabled' : 'disabled');
  else if (JSON.stringify(orig.mock) !== JSON.stringify(req.mock))
    note('mock', 'settings modified');

  if ((orig.description || '') !== (req.description || ''))
    note('description', 'edited');

  if (JSON.stringify(orig.examples || []) !== JSON.stringify(req.examples || []))
    note('examples', `${(orig.examples || []).length} → ${(req.examples || []).length}`);

  return rows;
}

function buildDiffHTML(diff) {
  return diff.map(({ field, oldVal, newVal, note, kv }) => {
    if (kv) {
      const kvHtml = kv.map(c => {
        if (c.type === 'added')
          return `<div class="changes-diff-kv-row"><span class="changes-diff-new">+ ${esc(c.key)}: ${esc(c.val)}</span></div>`;
        if (c.type === 'removed')
          return `<div class="changes-diff-kv-row"><span class="changes-diff-old">− ${esc(c.key)}: ${esc(c.val)}</span></div>`;
        if (c.type === 'changed')
          return `<div class="changes-diff-kv-row"><span class="changes-diff-kv-key">${esc(c.key)}:</span> <span class="changes-diff-old">${esc(c.oldVal)}</span> <span class="changes-diff-arrow">→</span> <span class="changes-diff-new">${esc(c.newVal)}</span></div>`;
        if (c.type === 'toggled')
          return `<div class="changes-diff-kv-row"><span class="changes-diff-kv-key">${esc(c.key)}:</span> <span class="changes-diff-note">${c.enabled ? 'enabled' : 'disabled'}</span></div>`;
        return '';
      }).join('');
      return `<div class="changes-diff-row changes-diff-row-kv">
        <span class="changes-diff-field">${esc(field)}</span>
        <div class="changes-diff-kv">${kvHtml}</div>
      </div>`;
    }
    return `<div class="changes-diff-row">
      <span class="changes-diff-field">${esc(field)}</span>
      ${note
        ? `<span class="changes-diff-note">${esc(note)}</span>`
        : `<span class="changes-diff-old">${esc(oldVal)}</span> <span class="changes-diff-arrow">→</span> <span class="changes-diff-new">${esc(newVal)}</span>`}
    </div>`;
  }).join('');
}

function renderChangesPanel() {
  const list = document.getElementById('changes-list');
  const changed = getChangedRequests();

  if (!changed.length) {
    list.innerHTML = `<p class="changes-empty">No unsaved changes.</p>`;
    return;
  }

  const byCol = new Map();
  for (const entry of changed) {
    if (!byCol.has(entry.col.id)) byCol.set(entry.col.id, { col: entry.col, entries: [] });
    byCol.get(entry.col.id).entries.push(entry);
  }

  list.innerHTML = [...byCol.values()].map(({ col, entries }) => `
    <div class="changes-col-group">
      <div class="changes-col-name">${esc(col.name)}</div>
      ${entries.map(({ req, original, folder }) => {
        const color = MC[req.method] || 'var(--text)';
        const path  = folder ? esc(folder.name) : '';
        const diffHtml = buildDiffHTML(buildChangeDiff(req, original));
        return `
          <div class="changes-req-row">
            <div class="changes-req-top">
              <span class="req-method" style="color:${color};font-weight:700;font-size:10px;min-width:46px">${esc(req.method)}</span>
              <span class="changes-req-name">${esc(req.name)}${path ? `<span class="changes-req-path"> · ${path}</span>` : ''}</span>
              <div class="changes-actions">
                <button onclick="openChangedReq('${req.id}')">Open</button>
                <button class="btn-reset" onclick="resetReqChange('${req.id}')">Reset</button>
                <button onclick="toggleChangeDiff('${req.id}')" id="diff-btn-${req.id}">▼</button>
              </div>
            </div>
            <div class="changes-diff" id="diff-${req.id}" style="display:none">${diffHtml}</div>
          </div>`;
      }).join('')}
    </div>`).join('');
}

function toggleChangeDiff(reqId) {
  const diff = document.getElementById(`diff-${reqId}`);
  const btn  = document.getElementById(`diff-btn-${reqId}`);
  if (!diff) return;
  const open = diff.style.display === 'none';
  diff.style.display = open ? 'block' : 'none';
  if (btn) btn.textContent = open ? '▲' : '▼';
}

function openChangedReq(reqId) {
  state.showChanges = false;
  document.getElementById('changes-panel').style.display = 'none';
  updateChangesToggleLabel();
  openTab(reqId);
  if (activeTab()) showReqEditor();
  else showEmptyState();
}

function resetReqChange(reqId) {
  const orig = state.snapshots.get(reqId);
  if (!orig) return;
  const restored = clone(orig);
  state.cols = state.cols.map(c => ({
    ...c,
    requests: c.requests.map(r => r.id === reqId ? restored : r),
    folders:  c.folders.map(f => ({ ...f, requests: f.requests.map(r => r.id === reqId ? restored : r) })),
  }));
  const tab = state.tabs.find(t => t.reqId === reqId);
  if (tab) {
    tab.req = clone(restored);
    if (activeTab()?.id === tab.id) renderReqPanel();
  }
  scheduleDiskSave();
  updateChangesBadge();
  syncMockRoutes();
}

async function resetAllChanges() {
  const changed = getChangedRequests();
  if (!changed.length) return;
  const n = changed.length;
  if (!await confirmDialog(`Reset ${n} changed request${n > 1 ? 's' : ''} to their last saved state?`, { okLabel: 'Reset All', danger: true })) return;
  for (const { req } of changed) {
    const orig = state.snapshots.get(req.id);
    if (!orig) continue;
    const restored = clone(orig);
    state.cols = state.cols.map(c => ({
      ...c,
      requests: c.requests.map(r => r.id === req.id ? restored : r),
      folders:  c.folders.map(f => ({ ...f, requests: f.requests.map(r => r.id === req.id ? restored : r) })),
    }));
    const tab = state.tabs.find(t => t.reqId === req.id);
    if (tab) tab.req = clone(restored);
  }
  if (activeTab()) renderReqPanel();
  scheduleDiskSave();
  updateChangesBadge();
  syncMockRoutes();
}

// ─── Server status indicator ──────────────────────────────────────────────────
(function startServerPoll() {
  const dot     = document.getElementById('server-status');
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('volley-server-status') : null;
  let online    = true;

  function applyStatus(nowOnline) {
    if (nowOnline === online) return;
    online = nowOnline;
    dot.className = 'server-dot ' + (online ? 'server-dot-online' : 'server-dot-offline');
    dot.title     = online ? 'Server online' : 'Server offline';
  }

  if (channel) channel.onmessage = e => applyStatus(e.data);

  async function check() {
    if (document.visibilityState === 'hidden') { setTimeout(check, 5000); return; }
    let nowOnline;
    try {
      const res = await fetch('/api/ping', { signal: AbortSignal.timeout(2000) });
      nowOnline = res.ok;
    } catch { nowOnline = false; }
    applyStatus(nowOnline);
    if (channel) channel.postMessage(nowOnline);
    setTimeout(check, 5000);
  }
  check();
})();

// ─── Boot ─────────────────────────────────────────────────────────────────────
init().catch(err => notify(err.message, 'error'));
