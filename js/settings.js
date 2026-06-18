// ─── Settings & feature flags ─────────────────────────────────────────────────

function _getSettings() {
  try { return JSON.parse(localStorage.getItem('salvo-settings') || '{}'); } catch { return {}; }
}

function _saveSettings(s) {
  localStorage.setItem('salvo-settings', JSON.stringify(s));
}

function isFeatureEnabled(name) {
  return !!(_getSettings().features?.[name]);
}

function setFeature(name, enabled) {
  const s = _getSettings();
  s.features = { ...(s.features || {}), [name]: enabled };
  _saveSettings(s);
  applyFeatureFlags();
}

function applyFeatureFlags() {
  const gitBtn  = document.getElementById('git-topbar-btn');
  const logsBtn = document.getElementById('logs-topbar-btn');
  if (gitBtn)  gitBtn.style.display  = isFeatureEnabled('git')  ? '' : 'none';
  if (logsBtn) logsBtn.style.display = isFeatureEnabled('logs') ? '' : 'none';
}

// ─── Settings modal ───────────────────────────────────────────────────────────

async function openSettingsModal() {
  document.getElementById('settings-modal').style.display = 'flex';
  await renderSettingsModal();
}

function closeSettingsModal() {
  document.getElementById('settings-modal').style.display = 'none';
}

async function renderSettingsModal() {
  let bufferSize = 500;
  try {
    const cfg = await fetch('/api/logs/config').then(r => r.json());
    bufferSize = cfg.bufferSize ?? 500;
  } catch {}

  document.getElementById('settings-modal-body').innerHTML = `
    <div class="settings-section">
      <div class="settings-label">General</div>
      <div class="settings-row" onclick="document.getElementById('feat-logs').click()">
        <input type="checkbox" id="feat-logs" class="settings-checkbox"
               ${isFeatureEnabled('logs') ? 'checked' : ''}
               onchange="setFeature('logs', this.checked); syncLogsSubRow(this.checked)" onclick="event.stopPropagation()">
        <div class="settings-row-content">
          <strong>Show logs</strong>
          <div class="settings-desc">Display a Logs button in the toolbar to stream live server output.</div>
        </div>
      </div>
      <div class="settings-sub-row ${isFeatureEnabled('logs') ? '' : 'settings-sub-disabled'}" id="logs-buffer-row">
        <input type="number" id="logs-buffer-input" class="settings-number" min="10" max="10000"
               value="${bufferSize}" ${isFeatureEnabled('logs') ? '' : 'disabled'}
               onchange="saveLogBufferSize(+this.value)">
        <div class="settings-row-content">
          <strong>Buffer size</strong>
          <div class="settings-desc">Lines kept in memory and replayed when the log viewer opens.</div>
        </div>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-label">Experimental</div>
      <div class="settings-row" onclick="document.getElementById('feat-git').click()">
        <input type="checkbox" id="feat-git" class="settings-checkbox"
               ${isFeatureEnabled('git') ? 'checked' : ''}
               onchange="setFeature('git', this.checked)" onclick="event.stopPropagation()">
        <div class="settings-row-content">
          <strong>Git sync</strong>
          <div class="settings-desc">Push and pull collections against a remote git repository.</div>
        </div>
      </div>
    </div>`;
}

function syncLogsSubRow(enabled) {
  const row   = document.getElementById('logs-buffer-row');
  const input = document.getElementById('logs-buffer-input');
  if (!row) return;
  row.classList.toggle('settings-sub-disabled', !enabled);
  if (input) input.disabled = !enabled;
}

async function saveLogBufferSize(size) {
  if (!size || size < 10) return;
  try {
    await fetch('/api/logs/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bufferSize: size }),
    });
  } catch (e) { notify('Failed to save log buffer size: ' + e.message, 'error'); }
}
