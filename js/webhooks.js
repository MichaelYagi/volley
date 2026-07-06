// ─── Webhook Capture (topbar modal) ─────────────────────────────────────────────
// Starts/stops a local HTTP listener (server.js's /api/webhooks/* endpoints)
// that accepts any request on any method/path, always replies 200, and logs
// what it received — for testing one local service calling another as a
// webhook. Polls the log while the modal is open so newly-received requests
// show up without a manual refresh.

let _webhookStatus     = null;
let _webhookLog        = [];
let _webhookSelectedId = null;
let _webhookPoll       = null;

async function openWebhooksModal() {
  document.getElementById('webhooks-modal').style.display = 'flex';
  await refreshWebhooksModal();
  if (_webhookPoll) clearInterval(_webhookPoll);
  _webhookPoll = setInterval(refreshWebhookLogAndRender, 1500);
}

function closeWebhooksModal() {
  document.getElementById('webhooks-modal').style.display = 'none';
  if (_webhookPoll) { clearInterval(_webhookPoll); _webhookPoll = null; }
}

async function refreshWebhooksModal() {
  try {
    const res = await fetch('/api/webhooks/status');
    _webhookStatus = await res.json();
  } catch {
    _webhookStatus = { running: false, port: null, count: 0 };
  }
  await refreshWebhookLog();
  renderWebhooksModal();
  updateWebhooksBadge();
}

async function refreshWebhookLog() {
  try {
    const res  = await fetch('/api/webhooks/log');
    const data = await res.json();
    _webhookLog = data.requests || [];
  } catch { _webhookLog = []; }
}

async function refreshWebhookLogAndRender() {
  await refreshWebhookLog();
  renderWebhookList();
  renderWebhookDetail();
}

function renderWebhooksModal() {
  const s = _webhookStatus || { running: false, port: null, count: 0 };

  document.getElementById('webhooks-start-btn').style.display = s.running ? 'none' : '';
  document.getElementById('webhooks-stop-btn').style.display  = s.running ? '' : 'none';
  document.getElementById('webhooks-port-input').disabled     = !!s.running;

  document.getElementById('webhooks-status').textContent = s.running
    ? `Listening on http://localhost:${s.port} — point another local request at that URL and it'll show up below.`
    : `Stopped. ${s.count} request(s) captured so far.`;
  if (s.running) document.getElementById('webhooks-port-input').value = s.port;

  renderWebhookList();
  renderWebhookDetail();
}

function renderWebhookList() {
  const list = document.getElementById('webhooks-list');
  if (!_webhookLog.length) {
    list.innerHTML = `<p class="muted">No requests captured yet.</p>`;
    return;
  }
  list.innerHTML = _webhookLog.map(r => `
    <div class="webhook-item${r.id === _webhookSelectedId ? ' active' : ''}" onclick="selectWebhookEntry('${r.id}')" title="Click to ${r.id === _webhookSelectedId ? 'collapse' : 'expand'}">
      <span class="webhook-item-arrow${r.id === _webhookSelectedId ? ' open' : ''}">&#9654;</span>
      <span class="runner-method" style="color:${MC[r.method] || 'var(--text)'}">${esc(r.method)}</span>
      <span class="webhook-item-path">${esc(r.path)}</span>
      <span class="webhook-item-time">${new Date(r.time).toLocaleTimeString()}</span>
    </div>`).join('');
}

function selectWebhookEntry(id) {
  _webhookSelectedId = _webhookSelectedId === id ? null : id;
  renderWebhookList();
  renderWebhookDetail();
}

function renderWebhookDetail() {
  const el = document.getElementById('webhooks-detail');
  const r  = _webhookLog.find(x => x.id === _webhookSelectedId);
  if (!r) { el.innerHTML = `<p class="muted">Select a captured request to inspect it.</p>`; return; }

  const headerRows = Object.entries(r.headers || {}).map(([k, v]) => `
    <div class="webhook-header-row">
      <span class="webhook-header-key">${esc(k)}</span>
      <span class="webhook-header-value">${esc(String(v))}</span>
    </div>`).join('');

  el.innerHTML = `
    <div class="webhook-detail-title">
      <span class="runner-method" style="color:${MC[r.method] || 'var(--text)'}">${esc(r.method)}</span>
      ${esc(r.path)}${esc(r.query || '')}
    </div>
    <div class="muted" style="font-size:12px;margin-bottom:12px">${new Date(r.time).toLocaleString()}</div>
    <label>Headers</label>
    <div class="webhook-headers">${headerRows || '<p class="muted">None</p>'}</div>
    <label style="margin-top:12px">Body</label>
    <pre class="webhook-body">${r.body ? esc(r.body) : '<span class="muted">Empty</span>'}</pre>
  `;
}

async function startWebhooks() {
  const port = parseInt(document.getElementById('webhooks-port-input').value, 10) || 5876;
  try {
    const res  = await fetch('/api/webhooks/start', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ port }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    notify(`Webhook capture listening on port ${data.port}`, 'success');
  } catch (e) {
    notify(`Failed to start webhook capture: ${e.message}`, 'error');
  }
  await refreshWebhooksModal();
}

async function stopWebhooks() {
  try {
    await fetch('/api/webhooks/stop', { method: 'POST' });
    notify('Webhook capture stopped', 'info');
  } catch (e) {
    notify(`Failed to stop webhook capture: ${e.message}`, 'error');
  }
  await refreshWebhooksModal();
}

async function clearWebhookLog() {
  if (!await confirmDialog('Clear all captured requests?', { okLabel: 'Clear', danger: true })) return;
  await fetch('/api/webhooks/clear', { method: 'POST' });
  _webhookSelectedId = null;
  await refreshWebhooksModal();
}

// ─── Shared webhook capture status ──────────────────────────────────────────────
// Lights up a badge on the topbar's "Webhooks" button. Refreshed on init.
function updateWebhooksBadge() {
  const badge = document.getElementById('webhooks-badge');
  if (badge) badge.style.display = _webhookStatus?.running ? '' : 'none';
}

async function refreshWebhooksStatusBadge() {
  try {
    const res = await fetch('/api/webhooks/status');
    _webhookStatus = await res.json();
  } catch {
    _webhookStatus = null;
  }
  updateWebhooksBadge();
}
