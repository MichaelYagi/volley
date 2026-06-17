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
  const gitBtn = document.getElementById('git-topbar-btn');
  if (gitBtn) gitBtn.style.display = isFeatureEnabled('git') ? '' : 'none';
}

// ─── Settings modal ───────────────────────────────────────────────────────────

function openSettingsModal() {
  renderSettingsModal();
  document.getElementById('settings-modal').style.display = 'flex';
}

function closeSettingsModal() {
  document.getElementById('settings-modal').style.display = 'none';
}

function renderSettingsModal() {
  document.getElementById('settings-modal-body').innerHTML = `
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
