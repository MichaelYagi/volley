// ─── Generic Confirm / Prompt Dialog ───────────────────────────────────────────

let _dialogResolve = null;

function showDialog({ title = '', message = '', input = false, value = '', okLabel = 'OK', danger = false }) {
  return new Promise(resolve => {
    _dialogResolve = resolve;

    const titleEl = document.getElementById('dialog-title');
    titleEl.textContent = title;
    titleEl.style.display = title ? '' : 'none';

    const msgEl = document.getElementById('dialog-message');
    msgEl.textContent = message;
    msgEl.style.display = message ? '' : 'none';

    const inputEl = document.getElementById('dialog-input');
    inputEl.style.display = input ? '' : 'none';
    inputEl.value = value;

    const okBtn = document.getElementById('dialog-ok-btn');
    okBtn.textContent = okLabel;
    okBtn.className = danger ? '' : 'btn-primary';
    okBtn.style.color = danger ? 'var(--danger)' : '';

    document.getElementById('dialog-modal').style.display = 'flex';

    setTimeout(() => {
      if (input) { inputEl.focus(); inputEl.select(); }
      else       { okBtn.focus(); }
    }, 0);
  });
}

function closeDialog(result) {
  document.getElementById('dialog-modal').style.display = 'none';
  if (_dialogResolve) { _dialogResolve(result); _dialogResolve = null; }
}

function dialogCancel() {
  const isPrompt = document.getElementById('dialog-input').style.display !== 'none';
  closeDialog(isPrompt ? null : false);
}

function dialogConfirm() {
  const inputEl   = document.getElementById('dialog-input');
  const isPrompt  = inputEl.style.display !== 'none';
  closeDialog(isPrompt ? inputEl.value : true);
}

// Resolves true/false — replacement for window.confirm().
function confirmDialog(message, opts = {}) {
  return showDialog({ message, input: false, okLabel: opts.okLabel || 'Confirm', danger: !!opts.danger });
}

// Resolves to the entered string, or null if cancelled — replacement for window.prompt().
function promptDialog(message, value = '', opts = {}) {
  return showDialog({ message, input: true, value, okLabel: opts.okLabel || 'OK' });
}

// ─── Collection Info Modal ─────────────────────────────────────────────────────

let _colInfoId = null;

function openColInfoModal(colId) {
  const col = state.cols.find(c => c.id === colId);
  if (!col) return;
  _colInfoId = colId;
  document.getElementById('col-info-title').textContent = `${col.name} — Description`;
  document.getElementById('col-info-desc').value = col.description || '';
  document.getElementById('col-info-modal').style.display = 'flex';
}

function closeColInfoModal() {
  document.getElementById('col-info-modal').style.display = 'none';
  _colInfoId = null;
}

function saveColInfoModal() {
  const col = state.cols.find(c => c.id === _colInfoId);
  if (col) {
    col.description = document.getElementById('col-info-desc').value;
    scheduleDiskSave();
  }
  closeColInfoModal();
}

// ─── Environment Modal ────────────────────────────────────────────────────────

function openEnvModal() {
  state.envSelId = state.activeEnv;
  renderEnvModal();
  document.getElementById('env-modal').style.display = 'flex';
}

function closeEnvModal() {
  document.getElementById('env-modal').style.display = 'none';
  renderEnvSelect();
}

function renderEnvSelect() {
  const sel = document.getElementById('env-select');
  sel.innerHTML = state.envs.map(e =>
    `<option value="${e.id}" ${e.id === state.activeEnv ? 'selected' : ''}>${esc(e.name)}</option>`
  ).join('');
}

function renderEnvModal() {
  renderEnvList();
  renderEnvDetail();
}

function renderEnvList() {
  const listEl = document.getElementById('env-list-panel');
  listEl.innerHTML =
    `<div class="env-item ${state.envSelId === '__globals__' ? 'active' : ''}" onclick="envSelect('__globals__')">
       Globals
     </div>` +
    state.envs.map(e => `
      <div class="env-item ${e.id === state.envSelId ? 'active' : ''}" onclick="envSelect('${e.id}')">
        ${esc(e.name)}
        ${e.id === state.activeEnv ? '<span class="env-dot">●</span>' : ''}
      </div>`
    ).join('') +
    `<button onclick="addEnv()" style="color:var(--accent);font-size:11px;margin-top:8px;width:100%;padding:5px 0">
       + New Environment
     </button>`;
}

function renderEnvDetail() {
  const detailEl = document.getElementById('env-detail-panel');

  if (state.envSelId === '__globals__') {
    detailEl.innerHTML = `<p class="muted" style="margin:0 0 12px;font-size:12px">
        Global variables are available in every environment, and are used as a
        fallback when a <code>{{variable}}</code> isn't found in the active environment.
      </p>` + kvEditorHTML(state.globals, 'globalVars');
    return;
  }

  const env = state.envs.find(e => e.id === state.envSelId);
  if (!env) { detailEl.innerHTML = ''; return; }

  let html = `<input value="${esc(env.name)}" oninput="envRename(this.value)"
                     style="width:100%;margin-bottom:12px;font-size:13px">`;

  html += kvEditorHTML(env.vars, 'envVars');

  html += `
    <div style="display:flex;gap:8px;margin-top:16px">
      <button onclick="envUse()">Use This Environment</button>
      ${env.id !== 'default' ? `<button onclick="envDelete()" style="color:var(--danger)">Delete</button>` : ''}
    </div>`;

  detailEl.innerHTML = html;
}

// ─── Environment actions ──────────────────────────────────────────────────────

// Switch the active environment directly from the topbar dropdown.
function envQuickSwitch(id) { state.activeEnv = id; scheduleDiskSave(); }

function envSelect(id)      { state.envSelId = id; renderEnvModal(); }
function envRename(name)    { const e = getSelEnv(); if (e) { e.name = name; scheduleDiskSave(); } }

function addEnv() {
  const e = { id: uid(), name: 'New Environment', vars: [] };
  state.envs.push(e);
  state.envSelId = e.id;
  renderEnvModal();
  scheduleDiskSave();
}

function envUse() {
  state.activeEnv = state.envSelId;
  renderEnvSelect();
  closeEnvModal();
  scheduleDiskSave();
}

async function envDelete() {
  if (!await confirmDialog(`Delete environment "${getSelEnv()?.name}"?`, { okLabel: 'Delete', danger: true })) return;
  state.envs     = state.envs.filter(e => e.id !== state.envSelId);
  state.envSelId = 'default';
  renderEnvModal();
  scheduleDiskSave();
}

function getSelEnv() {
  return state.envs.find(e => e.id === state.envSelId) ?? null;
}

// ─── About Modal ──────────────────────────────────────────────────────────────

function openAboutModal() {
  document.getElementById('about-modal').style.display = 'flex';
  const el = document.getElementById('about-version');
  if (el && !el.textContent) {
    fetch('/api/version').then(r => r.json()).then(d => { el.textContent = d.version; }).catch(() => {});
  }
}

function closeAboutModal() {
  document.getElementById('about-modal').style.display = 'none';
}

// ─── Cookie Jar Modal ─────────────────────────────────────────────────────────

let _cookieJar = [];

async function openCookiesModal() {
  document.getElementById('cookies-modal').style.display = 'flex';
  await renderCookiesModal();
}

function closeCookiesModal() {
  document.getElementById('cookies-modal').style.display = 'none';
}

// Refreshes the in-memory _cookieJar cache from /api/cookies — used both by
// the Cookie Jar modal and the computed "Cookie" header preview on the Headers tab.
async function refreshCookieJar() {
  try {
    const res  = await fetch('/api/cookies');
    const data = await res.json();
    _cookieJar = data.cookies || [];
  } catch { /* keep stale cache on failure */ }
  return _cookieJar;
}

async function renderCookiesModal() {
  const list = document.getElementById('cookies-list');
  list.innerHTML = `<p class="muted">Loading…</p>`;

  await refreshCookieJar();

  if (!_cookieJar.length) {
    list.innerHTML = `<p class="muted">No cookies stored yet.</p>`;
    return;
  }

  list.innerHTML = _cookieJar.map((c, i) => `
    <div class="cookie-item">
      <div class="cookie-main">
        <span class="cookie-name">${esc(c.name)}</span>
        <span class="cookie-domain">${esc(c.domain)}${esc(c.path)}</span>
        <button class="cookie-del" onclick="deleteCookie(${i})" title="Delete cookie">✕</button>
      </div>
      <div class="cookie-value">${esc(c.value)}</div>
      <div class="cookie-expires">${c.expires ? 'Expires ' + new Date(c.expires).toLocaleString() : 'Session cookie'}</div>
    </div>`
  ).join('');
}

async function deleteCookie(i) {
  const c = _cookieJar[i];
  if (!c) return;
  if (!await confirmDialog(`Delete cookie "${c.name}"?`, { okLabel: 'Delete', danger: true })) return;
  await fetch('/api/cookies', {
    method:  'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ domain: c.domain, path: c.path, name: c.name }),
  });
  renderCookiesModal();
}

async function clearAllCookies() {
  if (!await confirmDialog('Delete all stored cookies?', { okLabel: 'Delete', danger: true })) return;
  await fetch('/api/cookies', {
    method:  'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({}),
  });
  renderCookiesModal();
}
