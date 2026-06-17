// ─── Mock Server (topbar modal) ─────────────────────────────────────────────────
// Builds a route list from every request with mock.enabled across all
// collections, and starts/stops the local mock HTTP server (server.js's
// /api/mock/* endpoints) to serve them. See js/request.js's mockHTML() for the
// per-request "Mock" tab where mock.enabled/status/headers/body/delay are set.

function buildMockRoutes() {
  const routes = [];
  state.cols.forEach(c => {
    [...c.requests, ...c.folders.flatMap(f => f.requests)].forEach(r => {
      if (!r.mock?.enabled) return;
      routes.push({
        method:  r.method,
        path:    extractMockPath(r.url),
        status:  r.mock.status || 200,
        headers: (r.mock.headers || [])
          .filter(h => h.enabled && h.key)
          .map(h => ({ key: interp(h.key), value: interp(h.value) })),
        body:  interp(r.mock.body || ''),
        delay: r.mock.delay || 0,
        name:  r.name,
      });
    });
  });
  return routes;
}

async function openMockModal() {
  document.getElementById('mock-modal').style.display = 'flex';
  await refreshMockStatus();
}

function closeMockModal() {
  document.getElementById('mock-modal').style.display = 'none';
}

async function refreshMockStatus() {
  try {
    const res  = await fetch('/api/mock/status');
    const data = await res.json();
    _mockStatus = data;
    renderMockModal(data);
  } catch (e) {
    _mockStatus = { running: false, port: null, routes: 0 };
    renderMockModal(_mockStatus);
  }
  updateMockServerBadge();
}

function renderMockModal(status) {
  const routes = buildMockRoutes();

  document.getElementById('mock-start-btn').style.display = status.running ? 'none' : '';
  document.getElementById('mock-stop-btn').style.display  = status.running ? '' : 'none';
  document.getElementById('mock-port-input').disabled     = !!status.running;

  if (status.running) {
    document.getElementById('mock-port-input').value   = status.port;
    document.getElementById('mock-status').textContent = `Running on http://localhost:${status.port} — serving ${status.routes} route(s)`;
  } else {
    document.getElementById('mock-status').textContent = `Stopped. ${routes.length} request(s) have mocking enabled.`;
  }

  document.getElementById('mock-routes').innerHTML = routes.length
    ? `<div class="mock-route-list">` + routes.map(r => `
        <div class="mock-route-item">
          <span class="runner-method" style="color:${MC[r.method] || 'var(--text)'}">${esc(r.method)}</span>
          <span class="mock-route-path">${esc(r.path)}</span>
          <span class="mock-route-status">${esc(String(r.status))}</span>
          <span class="mock-route-name">${esc(r.name)}</span>
        </div>`).join('') + `</div>`
    : `<p class="muted">No requests have mocking enabled yet — open a request's "Mock" tab to configure one.</p>`;
}

async function startMock() {
  const port   = parseInt(document.getElementById('mock-port-input').value, 10) || 5875;
  const routes = buildMockRoutes();
  if (!routes.length) { notify('No requests have mocking enabled', 'error'); return; }

  try {
    const res  = await fetch('/api/mock/start', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ port, routes }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    notify(`Mock server started on port ${port}`, 'success');
  } catch (e) {
    notify(`Failed to start mock server: ${e.message}`, 'error');
  }
  await refreshMockStatus();
}

async function stopMock() {
  try {
    await fetch('/api/mock/stop', { method: 'POST' });
    notify('Mock server stopped', 'info');
  } catch (e) {
    notify(`Failed to stop mock server: ${e.message}`, 'error');
  }
  await refreshMockStatus();
}

// ─── Shared mock server status ──────────────────────────────────────────────────
// Lets curlPanelHTML() (js/curl.js) show a "test against the mock server" command
// when this request's mock is enabled and the mock server happens to be running,
// and lights up a badge on the topbar's "Mock Server" button. Refreshed on init
// and each time the cURL tab is opened (switchReqTab).
let _mockStatus = null;

function updateMockServerBadge() {
  const badge = document.getElementById('mock-server-badge');
  if (badge) badge.style.display = _mockStatus?.running ? '' : 'none';
}

async function refreshMockServerStatus() {
  try {
    const res = await fetch('/api/mock/status');
    _mockStatus = await res.json();
  } catch {
    _mockStatus = null;
  }
  updateMockServerBadge();
  if (activeTab()?.reqTab === 'curl') renderReqPanel();
}

async function syncMockRoutes() {
  if (!_mockStatus?.running) return;
  try {
    const res = await fetch('/api/mock/update', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ routes: buildMockRoutes() }),
    });
    const data = await res.json();
    if (data.ok) _mockStatus.routes = data.routes;
  } catch { /* silent — server may have been stopped externally */ }
}
