// ─── Git Sync ──────────────────────────────────────────────────────────────────
// Push/pull against a remote collections repository via /api/git/* endpoints.

let _gitConfig  = null;
let _gitStatus  = null;
let _gitConflicts = [];
let _autoSyncTimer = null;

// ─── Modal open/close ─────────────────────────────────────────────────────────

async function openGitModal() {
  document.getElementById('git-modal').style.display = 'flex';
  await refreshGitModal();
}

function closeGitModal() {
  document.getElementById('git-modal').style.display = 'none';
}

async function refreshGitModal() {
  try {
    const [cfgRes, statusRes] = await Promise.all([
      fetch('/api/git/config').then(r => r.json()),
      fetch('/api/git/status').then(r => r.json()),
    ]);
    _gitConfig = cfgRes.config || {};
    _gitStatus = statusRes;
    renderGitModal();
  } catch (e) {
    notify('Failed to load git status: ' + e.message, 'error');
  }
}

function renderGitModal() {
  const cfg    = _gitConfig || {};
  const status = _gitStatus || {};
  const initialized  = status.initialized;
  const localChanges = status.localChanges || 0;
  const lastSync     = cfg.lastSync ? new Date(cfg.lastSync).toLocaleString() : 'Never';

  document.getElementById('git-modal-body').innerHTML = `
    <div class="git-section">
      <h4>Repository</h4>
      <div class="git-field">
        <label>Remote URL</label>
        <input id="git-url" value="${esc(cfg.remoteUrl || '')}" placeholder="https://github.com/user/my-collections">
      </div>
      <div class="git-field">
        <label>Personal Access Token <span style="color:var(--text-faint);font-weight:400">(required for private repos and push)</span></label>
        <input id="git-pat" type="password" placeholder="${cfg.patSet ? '(saved — leave blank to keep)' : 'ghp_… or leave blank for public read-only'}">
      </div>
      <div class="git-field">
        <label>Branch</label>
        <input id="git-branch" value="${esc(cfg.branch || 'main')}" placeholder="main" style="width:100px">
      </div>
      <div class="git-row" style="margin-top:12px">
        <button onclick="saveGitConfig()">Save</button>
        <button onclick="initGitRepo()" id="git-init-btn"
                ${!cfg.remoteUrl ? 'disabled title="Save a remote URL first"' : ''}>
          ${initialized ? 'Re-clone' : 'Connect'}
        </button>
      </div>
    </div>

    <div class="git-section">
      <h4>Auto-sync</h4>
      <label class="git-toggle-row">
        <input type="checkbox" id="git-autosync" ${cfg.autoSync ? 'checked' : ''}
               onchange="toggleGitAutoSync(this.checked)">
        Sync every
        <input id="git-interval" type="number" min="1" max="60"
               value="${cfg.intervalMinutes || 5}" style="width:48px;margin:0 4px"
               onchange="saveGitInterval(+this.value)">
        minutes
      </label>
    </div>

    <div class="git-section">
      <h4>Sync</h4>
      ${!initialized
        ? `<p class="git-muted">Connect a repository above to enable sync.</p>`
        : `<div class="git-status-row">
             <span class="git-muted">Last sync: ${esc(lastSync)}</span>
             <span class="git-muted git-change-count${localChanges > 0 ? ' git-dirty' : ''}">
               ${localChanges > 0 ? `${localChanges} local change${localChanges !== 1 ? 's' : ''}` : 'Up to date'}
             </span>
           </div>
           <div class="git-row" style="margin-top:10px">
             <button id="git-push-btn" onclick="gitPush()">Push</button>
             <button id="git-pull-btn" onclick="gitPull()">Pull</button>
           </div>`
      }
    </div>`;
}

// ─── Config ───────────────────────────────────────────────────────────────────

async function saveGitConfig() {
  const remoteUrl = document.getElementById('git-url').value.trim();
  const pat       = document.getElementById('git-pat').value;
  const branch    = document.getElementById('git-branch').value.trim() || 'main';
  const cfg       = { ...(_gitConfig || {}), remoteUrl, branch };
  if (pat) cfg.pat = pat;
  try {
    const res = await fetch('/api/git/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg),
    });
    if (!(await res.json()).ok) throw new Error('Save failed');
    notify('Git config saved', 'success');
    await refreshGitModal();
  } catch (e) { notify(e.message, 'error'); }
}

// ─── Connect (clone) ──────────────────────────────────────────────────────────

async function initGitRepo() {
  const btn = document.getElementById('git-init-btn');
  btn.disabled = true; btn.textContent = 'Connecting…';
  cancelDiskSave(); // prevent any queued save from racing the file copy
  try {
    const res  = await fetch('/api/git/init', { method: 'POST' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    if (data.filesCopied === 0) {
      notify('Connected — no collection files found in remote repo (check server log)', 'error');
    } else {
      await reloadAfterGitSync();
      notify(`Connected — ${data.filesCopied} file${data.filesCopied !== 1 ? 's' : ''} synced from remote`, 'success');
    }
    await refreshGitModal();
    updateGitStatusBadge();
  } catch (e) {
    notify('Connect failed: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Connect'; }
  }
}

// ─── Push ─────────────────────────────────────────────────────────────────────

async function gitPush() {
  const btn = document.getElementById('git-push-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Pushing…'; }
  try {
    // Flush any pending in-memory edits to state.cols first
    syncAllTabsIntoCols();
    await saveAll(true);
    const res  = await fetch('/api/git/push', { method: 'POST' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    notify(data.message || 'Pushed', 'success');
    await refreshGitModal();
    updateGitStatusBadge();
  } catch (e) { notify('Push failed: ' + e.message, 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = 'Push'; } }
}

// ─── Pull ─────────────────────────────────────────────────────────────────────

async function gitPull() {
  const btn = document.getElementById('git-pull-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Pulling…'; }
  try {
    const res  = await fetch('/api/git/pull', { method: 'POST' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    if (data.conflicts?.length) {
      openGitConflictModal(data.conflicts, data.autoApplied);
      if (data.autoApplied > 0) { cancelDiskSave(); await reloadAfterGitSync(); await saveAll(true); }
    } else {
      const msg = data.upToDate
        ? 'Already up to date'
        : `Applied ${data.autoApplied} remote change${data.autoApplied !== 1 ? 's' : ''}`;
      notify(msg, 'success');
      if (data.autoApplied > 0) { cancelDiskSave(); await reloadAfterGitSync(); await saveAll(true); }
    }
    await refreshGitModal();
    updateGitStatusBadge();
  } catch (e) { notify('Pull failed: ' + e.message, 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = 'Pull'; } }
}

// ─── Conflict modal ───────────────────────────────────────────────────────────

function openGitConflictModal(conflicts, autoApplied) {
  _gitConflicts = conflicts;
  document.getElementById('git-conflict-modal').style.display = 'flex';
  renderGitConflicts(autoApplied);
}

function closeGitConflictModal() {
  document.getElementById('git-conflict-modal').style.display = 'none';
  _gitConflicts = [];
}

function renderGitConflicts(autoApplied) {
  let html = '';
  if (autoApplied > 0) {
    html += `<p class="git-muted" style="margin-bottom:12px">
      ${autoApplied} non-conflicting change${autoApplied !== 1 ? 's were' : ' was'} auto-applied.
      Resolve the conflicts below then click Apply.
    </p>`;
  }

  _gitConflicts.forEach((item, i) => {
    const label = item.path.replace(/\.json$/, '').replace(/\//g, ' › ');
    let diffHTML = '';
    if (item.localContent && item.remoteContent) {
      try {
        const diff = buildChangeDiff(JSON.parse(item.localContent), JSON.parse(item.remoteContent));
        diffHTML   = buildDiffHTML(diff);
      } catch {}
    }
    html += `
      <div class="git-conflict-item">
        <div class="git-conflict-header" onclick="toggleGitConflict(${i})">
          <span class="import-diff-toggle" id="git-ct-${i}">▶</span>
          <span class="git-conflict-name">${esc(label)}</span>
          <span class="git-conflict-badge">conflict</span>
        </div>
        <div class="git-conflict-diff" id="git-cd-${i}" style="display:none">
          ${diffHTML || '<p class="git-muted" style="padding:8px 0">Binary or unparseable change.</p>'}
        </div>
        <div class="git-conflict-choice">
          <label><input type="radio" name="gc-${i}" value="local" checked> Keep local</label>
          <label><input type="radio" name="gc-${i}" value="remote"> Take remote</label>
        </div>
      </div>`;
  });

  document.getElementById('git-conflict-list').innerHTML = html;
}

function toggleGitConflict(i) {
  const diff = document.getElementById(`git-cd-${i}`);
  const tog  = document.getElementById(`git-ct-${i}`);
  const open = diff.style.display !== 'none';
  diff.style.display = open ? 'none' : 'block';
  tog.textContent    = open ? '▶' : '▼';
}

async function applyGitResolution() {
  const btn = document.getElementById('git-apply-btn');
  btn.disabled = true; btn.textContent = 'Applying…';
  try {
    const resolutions = _gitConflicts.map((item, i) => ({
      path:          item.path,
      choice:        document.querySelector(`input[name="gc-${i}"]:checked`)?.value || 'local',
      remoteContent: item.remoteContent,
    }));
    const res  = await fetch('/api/git/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolutions }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    closeGitConflictModal();
    notify('Conflicts resolved', 'success');
    cancelDiskSave();
    await reloadAfterGitSync();
    await saveAll(true);
    updateGitStatusBadge();
  } catch (e) {
    notify('Apply failed: ' + e.message, 'error');
    btn.disabled = false; btn.textContent = 'Apply';
  }
}

// ─── Auto-sync ────────────────────────────────────────────────────────────────

async function toggleGitAutoSync(enabled) {
  const cfg = { ...(_gitConfig || {}), autoSync: enabled };
  await fetch('/api/git/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg),
  });
  _gitConfig = cfg;
  clearTimeout(_autoSyncTimer);
  if (enabled) _autoSyncTimer = setTimeout(runGitAutoSync, gitIntervalMs());
}

async function saveGitInterval(minutes) {
  const cfg = { ...(_gitConfig || {}), intervalMinutes: Math.max(1, minutes || 5) };
  await fetch('/api/git/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg),
  });
  _gitConfig = cfg;
}

function gitIntervalMs() {
  return ((_gitConfig?.intervalMinutes || 5) * 60 * 1000);
}

async function runGitAutoSync() {
  // Coordinate across tabs — only one tab syncs per interval
  const key  = 'salvo-last-git-sync';
  const ms   = gitIntervalMs();
  const last = parseInt(localStorage.getItem(key) || '0', 10);
  if (Date.now() - last < ms - 10000) {
    _autoSyncTimer = setTimeout(runGitAutoSync, ms);
    return;
  }
  localStorage.setItem(key, String(Date.now()));

  try {
    syncAllTabsIntoCols();
    await saveAll(true);

    const pushRes = await fetch('/api/git/push', { method: 'POST' });
    const pushData = await pushRes.json();
    if (!pushData.ok) throw new Error(pushData.error);

    const pullRes = await fetch('/api/git/pull', { method: 'POST' });
    const pullData = await pullRes.json();
    if (!pullData.ok) throw new Error(pullData.error);

    if (pullData.conflicts?.length) {
      notify(`Auto-sync: ${pullData.conflicts.length} conflict${pullData.conflicts.length !== 1 ? 's' : ''} — open Git to resolve`, 'error');
    } else if (pullData.autoApplied > 0) {
      await reloadAfterGitSync();
    }
    updateGitStatusBadge();
  } catch (e) {
    notify('Auto-sync failed: ' + e.message, 'error');
  }

  _autoSyncTimer = setTimeout(runGitAutoSync, gitIntervalMs());
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function reloadAfterGitSync() {
  await loadData();
  snapshotAllRequests();
  renderEnvSelect();
  renderSidebar();
  renderTabStrip();
  if (activeTab()) { syncReqEditor(); renderReqPanel(); }
  else showEmptyState();
}

async function updateGitStatusBadge() {
  try {
    const data = await fetch('/api/git/status').then(r => r.json());
    _gitStatus = data;
    const badge = document.getElementById('git-changes-badge');
    if (!badge) return;
    const hasChanges = data.initialized && data.localChanges > 0;
    badge.style.display = hasChanges ? 'inline' : 'none';
    badge.title = hasChanges ? `${data.localChanges} local change${data.localChanges !== 1 ? 's' : ''} — push to sync` : '';
  } catch {}
}

async function initGitSync() {
  try {
    const cfgRes = await fetch('/api/git/config').then(r => r.json());
    _gitConfig = cfgRes.config || {};
    if (_gitConfig.autoSync) {
      _autoSyncTimer = setTimeout(runGitAutoSync, gitIntervalMs());
    }
    updateGitStatusBadge();
  } catch {}
}
