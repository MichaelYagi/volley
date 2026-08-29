// ─── Monitors (topbar modal) ─────────────────────────────────────────────────
// A monitor is a saved { collection, folder?, env? } run definition plus an
// interval; server.js re-runs it on that schedule in-process (see
// runMonitor() in server.js) via the same headless runner cli.js uses, and
// keeps a capped run history. This modal is just a CRUD + history viewer
// over server.js's /api/monitors* endpoints — no scheduling happens here.

let _monitors      = [];
let _monitorSelId  = null; // selected monitor id, or 'new' for the blank form, or null

async function openMonitorsModal() {
  document.getElementById('monitors-modal').style.display = 'flex';
  await refreshMonitors();
}

function closeMonitorsModal() {
  document.getElementById('monitors-modal').style.display = 'none';
}

async function refreshMonitors() {
  try {
    const res  = await fetch('/api/monitors');
    const data = await res.json();
    _monitors = data.monitors || [];
  } catch { _monitors = []; }
  renderMonitorsList();
  renderMonitorsDetail();
  updateMonitorsBadge();
}

function renderMonitorsList() {
  const list = document.getElementById('monitors-list');
  if (!_monitors.length) {
    list.innerHTML = `<p class="muted">No monitors yet.</p>`;
    return;
  }
  list.innerHTML = _monitors.map(m => {
    const last = m.runs?.[0];
    const dot  = !m.enabled ? 'disabled unknown' : !last ? 'unknown' : (last.ok ? 'ok' : 'fail');
    return `
      <div class="monitor-item${m.id === _monitorSelId ? ' active' : ''}" onclick="selectMonitor('${m.id}')" title="${last ? (last.ok ? 'Last run OK' : 'Last run failed') : 'Never run'}">
        <span class="monitor-item-dot ${dot}"></span>
        <span class="monitor-item-name">${esc(m.name)}</span>
      </div>`;
  }).join('');
}

function selectMonitor(id) {
  _monitorSelId = id;
  renderMonitorsList();
  renderMonitorsDetail();
}

function newMonitorForm() {
  _monitorSelId = 'new';
  renderMonitorsList();
  renderMonitorsDetail();
}

function monitorColOptions(selected) {
  return state.cols.map(c => `<option value="${esc(c.name)}" ${c.name === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
}

function monitorFolderOptions(colName, selected) {
  const col = state.cols.find(c => c.name === colName);
  const opts = (col?.folders || []).map(f => `<option value="${esc(f.name)}" ${f.name === selected ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
  return `<option value="">Whole collection</option>${opts}`;
}

function monitorEnvOptions(selected) {
  const opts = state.envs.map(e => `<option value="${esc(e.name)}" ${e.name === selected ? 'selected' : ''}>${esc(e.name)}</option>`).join('');
  return `<option value="">Active environment</option>${opts}`;
}

function renderMonitorsDetail() {
  const el = document.getElementById('monitors-detail');

  if (!_monitorSelId) {
    el.innerHTML = `<p class="muted">Select a monitor to view or edit it, or click "+ New Monitor".</p>`;
    return;
  }

  const isNew = _monitorSelId === 'new';
  const m = isNew ? { name: '', collection: state.cols[0]?.name || '', folder: '', env: '', intervalMinutes: 5, enabled: true } : _monitors.find(x => x.id === _monitorSelId);
  if (!m) { _monitorSelId = null; el.innerHTML = ''; return; }

  el.innerHTML = `
    <div class="monitor-form">
      <label>Name</label>
      <input id="mon-name" value="${esc(m.name)}" placeholder="e.g. Staging health check">
      <div class="row">
        <div>
          <label>Collection</label>
          <select id="mon-collection" onchange="onMonitorColChange()">${monitorColOptions(m.collection)}</select>
        </div>
        <div>
          <label>Folder</label>
          <select id="mon-folder">${monitorFolderOptions(m.collection, m.folder)}</select>
        </div>
      </div>
      <div class="row">
        <div>
          <label>Environment</label>
          <select id="mon-env">${monitorEnvOptions(m.env)}</select>
        </div>
        <div>
          <label>Interval (minutes)</label>
          <input id="mon-interval" type="number" min="1" value="${m.intervalMinutes}">
        </div>
      </div>
      <div class="enabled-row">
        <input id="mon-enabled" type="checkbox" ${m.enabled ? 'checked' : ''}>
        <label for="mon-enabled">Enabled</label>
      </div>
      <div class="modal-footer" style="margin-top:14px;justify-content:flex-start">
        <button class="btn-primary" onclick="saveMonitor(${isNew ? 'null' : `'${m.id}'`})">${isNew ? 'Create' : 'Save'}</button>
        ${!isNew ? `<button onclick="runMonitorNow('${m.id}')">Run Now</button>` : ''}
        ${!isNew ? `<button style="color:var(--danger)" onclick="deleteMonitor('${m.id}')">Delete</button>` : ''}
      </div>
    </div>
    ${!isNew ? monitorRunsHtml(m.runs || []) : ''}
  `;
}

function onMonitorColChange() {
  document.getElementById('mon-folder').innerHTML = monitorFolderOptions(document.getElementById('mon-collection').value, null);
}

function monitorRunsHtml(runs) {
  if (!runs.length) return `<div class="monitor-runs"><p class="muted">No runs yet.</p></div>`;
  return `<div class="monitor-runs">
    <label>Recent runs</label>
    ${runs.map(r => `
      <div class="monitor-run-item">
        <span class="${r.ok ? 'ok' : 'fail'}">${r.ok ? 'OK' : 'FAIL'}</span>
        <span class="monitor-run-time">${new Date(r.at).toLocaleString()}</span>
        <span>${r.error ? esc(r.error) : `${r.passed}/${r.total} requests${r.testTotal ? `, ${r.testPassed}/${r.testTotal} tests` : ''}`}</span>
      </div>`).join('')}
  </div>`;
}

async function saveMonitor(id) {
  const body = {
    name:            document.getElementById('mon-name').value.trim(),
    collection:      document.getElementById('mon-collection').value,
    folder:          document.getElementById('mon-folder').value || null,
    env:             document.getElementById('mon-env').value || null,
    intervalMinutes: Number(document.getElementById('mon-interval').value) || 5,
    enabled:         document.getElementById('mon-enabled').checked,
  };
  if (!body.name || !body.collection) { notify('Name and collection are required', 'error'); return; }

  try {
    const res  = await fetch(id ? '/api/monitors/update' : '/api/monitors', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(id ? { id, ...body } : body),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    notify(id ? 'Monitor updated' : 'Monitor created', 'success');
    _monitorSelId = data.monitor.id;
    await refreshMonitors();
  } catch (e) {
    notify(`Failed to save monitor: ${e.message}`, 'error');
  }
}

async function runMonitorNow(id) {
  try {
    const res  = await fetch('/api/monitors/run', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ id }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    notify(data.run.ok ? 'Monitor run passed' : 'Monitor run failed', data.run.ok ? 'success' : 'error');
    await refreshMonitors();
  } catch (e) {
    notify(`Failed to run monitor: ${e.message}`, 'error');
  }
}

async function deleteMonitor(id) {
  if (!await confirmDialog('Delete this monitor?', { okLabel: 'Delete', danger: true })) return;
  try {
    await fetch('/api/monitors/delete', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ id }),
    });
    _monitorSelId = null;
    await refreshMonitors();
  } catch (e) {
    notify(`Failed to delete monitor: ${e.message}`, 'error');
  }
}

// ─── Shared monitors status ──────────────────────────────────────────────────
// Lights up a badge on the topbar's "Monitors" button when any monitor's
// last run failed. Refreshed on init.
function updateMonitorsBadge() {
  const badge = document.getElementById('monitors-badge');
  if (badge) badge.style.display = _monitors.some(m => m.enabled && m.runs?.[0] && !m.runs[0].ok) ? '' : 'none';
}

async function refreshMonitorsBadge() {
  try {
    const res  = await fetch('/api/monitors');
    const data = await res.json();
    _monitors = data.monitors || [];
  } catch { _monitors = []; }
  updateMonitorsBadge();
}
