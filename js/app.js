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
      if (!silent) notify('Saved', 'success');
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
  } catch (e) {
    notify('Could not load data/: ' + e.message, 'error');
  }

  document.querySelectorAll('#method-select option').forEach(opt => {
    opt.style.color = MC[opt.value] || 'var(--text)';
  });

  refreshCookieJar().then(() => { if (activeTab()?.reqTab === 'headers') renderReqPanel(); });
  refreshMockServerStatus();
  renderEnvSelect();
  renderSidebar();
  setupResizer();
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

// ─── History Panel ────────────────────────────────────────────────────────────

function toggleHistPanel() {
  state.showHist = !state.showHist;
  document.getElementById('hist-toggle').textContent = state.showHist ? '◀ Back to Request' : '⏱ History';

  if (state.showHist) {
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

function clearHistory() {
  state.hist = [];
  renderHistPanel();
  scheduleDiskSave();
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
init().catch(err => notify(err.message, 'error'));
