// ─── Mobile Sidebar Drawer ─────────────────────────────────────────────────────

function toggleSidebar() {
  document.body.classList.toggle('sidebar-open');
}

function closeSidebar() {
  document.body.classList.remove('sidebar-open');
}

// ─── Click Selection ─────────────────────────────────────────────────────────

function reqClick(event, reqId) {
  if (event.ctrlKey || event.metaKey) {
    if (state.selectedReqIds.has(reqId)) state.selectedReqIds.delete(reqId);
    else state.selectedReqIds.add(reqId);
    state.lastSelReqId = reqId;
    renderSidebar();
  } else if (event.shiftKey && state.lastSelReqId) {
    if (state.selectedReqIds.has(reqId)) {
      // Shift-clicking an already-selected item removes it
      state.selectedReqIds.delete(reqId);
    } else {
      const order = sidebarReqOrder();
      const a = order.indexOf(state.lastSelReqId);
      const b = order.indexOf(reqId);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        state.selectedReqIds = new Set(order.slice(lo, hi + 1));
      }
    }
    state.lastSelReqId = reqId;
    renderSidebar();
  } else {
    state.selectedReqIds = new Set();
    state.lastSelReqId   = reqId;
    selectReq(reqId);
  }
}

function sidebarReqOrder() {
  // Only include requests that are actually visible (expanded cols + folders)
  const ids = [];
  for (const col of state.cols) {
    if (!state.expandedCols.has(col.id)) continue;
    for (const f of col.folders) {
      if (!state.expandedFolders.has(f.id)) continue;
      for (const r of f.requests) ids.push(r.id);
    }
    for (const r of col.requests) ids.push(r.id);
  }
  return ids;
}

// Stored when "Move to..." opens so IDs survive the two-step menu chain
let _pendingMoveIds = null;

function showMovePicker(ids, x, y) {
  _pendingMoveIds = [...ids];
  const items = [];
  for (const col of state.cols) {
    const colId = col.id;
    items.push({ label: col.name,
      action: () => { moveReqs(_pendingMoveIds, 'col', colId); _pendingMoveIds = null; } });
    for (const folder of col.folders) {
      const fId = folder.id;
      items.push({ label: '  ↳ ' + folder.name,
        action: () => { moveReqs(_pendingMoveIds, 'folder', fId); _pendingMoveIds = null; } });
    }
  }
  showCtxMenu(x, y, items);
}

function showMovePickerForSelection(event) {
  event.stopPropagation();
  const rect = event.target.getBoundingClientRect();
  showMovePicker([...state.selectedReqIds], rect.left, rect.bottom + 4);
}

function clearSelection() {
  state.selectedReqIds = new Set();
  renderSidebar();
}

// ─── Sidebar Rendering ───────────────────────────────────────────────────────

function renderSidebar() {
  const list     = document.getElementById('col-list');
  const query    = document.getElementById('search-input').value.trim().toLowerCase();
  const clearBtn = document.getElementById('search-clear');

  clearBtn.style.display = query ? '' : 'none';

  list.innerHTML = '';

  if (query) {
    renderSearchResults(list, query);
  } else {
    state.cols.forEach(col => list.insertAdjacentHTML('beforeend', colHTML(col)));
  }

  // Appended last and pinned to the bottom of the scroll area (sticky), so
  // showing it doesn't shift the rows above — including the ones just selected.
  if (state.selectedReqIds.size) list.insertAdjacentHTML('beforeend', selBannerHTML());
}

function selBannerHTML() {
  const n = state.selectedReqIds.size;
  return `
    <div class="sel-banner">
      <span>${n} selected</span>
      <button onclick="showMovePickerForSelection(event)">Move to…</button>
      <button class="sel-clear" onclick="clearSelection()">Clear</button>
      <button class="sel-danger" onclick="deleteReqs([...state.selectedReqIds])">Delete</button>
    </div>`;
}

function renderSearchResults(list, query) {
  const matches = state.cols
    .flatMap(c => [
      ...c.requests.map(r => ({ r, colName: c.name })),
      ...c.folders.flatMap(f => f.requests.map(r => ({ r, colName: `${c.name} / ${f.name}` }))),
    ])
    .filter(({ r }) =>
      r.name.toLowerCase().includes(query) ||
      r.url.toLowerCase().includes(query)
    );

  list.insertAdjacentHTML('beforeend',
    `<div style="padding:4px 12px;font-size:10px;color:var(--text-muted);letter-spacing:1px">RESULTS (${matches.length})</div>`);

  if (!matches.length) {
    list.insertAdjacentHTML('beforeend', '<div style="color:var(--text-faint);padding:8px 12px;font-size:12px">No results</div>');
    return;
  }

  matches.forEach(({ r }) => list.insertAdjacentHTML('beforeend', reqRowHTML(r, 6, false)));
}

// ─── Collection HTML ──────────────────────────────────────────────────────────

function colHTML(col) {
  const open = state.expandedCols.has(col.id);
  const multiSelectActive = state.selectedReqIds.size > 0;
  const dragAttrs = multiSelectActive ? '' :
    `draggable="true" ondragstart="onDragStart(event,'col','${col.id}')" ondragend="onDragEnd(event)"`;

  let html = `
    <div style="position:relative">
      <div class="col-header" ${dragAttrs} onclick="toggleCol('${col.id}')" oncontextmenu="colCtx(event,'${col.id}')"
          ondragover="onColHeaderDragOver(event,'${col.id}')" ondragleave="onDragLeave(event)"
          ondrop="onColHeaderDrop(event,'${col.id}')">
        <span class="col-arrow ${open ? 'open' : ''}">&#9654;</span>
        <span class="col-name">${esc(col.name)}</span>
        <button class="col-menu-btn" onclick="event.stopPropagation();colCtx(event,'${col.id}')" title="Collection options">&#8942;</button>
        <button class="col-add" onclick="event.stopPropagation();addReq('${col.id}')" title="New request">+</button>
      </div>`;

  if (open) {
    html += `<div class="col-body" ondragover="onColHeaderDragOver(event,'${col.id}')" ondragleave="onDragLeave(event)" ondrop="onColHeaderDrop(event,'${col.id}')">`;
    col.folders.forEach(folder => { html += folderHTML(col.id, folder); });
    col.requests.forEach(r => { html += reqRowHTML(r, 6); });
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

function folderHTML(colId, folder) {
  const open = state.expandedFolders.has(folder.id);
  const multiSelectActive = state.selectedReqIds.size > 0;
  const dragAttrs = multiSelectActive ? '' :
    `draggable="true" ondragstart="onDragStart(event,'folder','${folder.id}')" ondragend="onDragEnd(event)"`;

  let html = `
    <div class="folder-header" ${dragAttrs} onclick="toggleFolder('${folder.id}')" oncontextmenu="folderCtx(event,'${colId}','${folder.id}')"
        ondragover="onFolderHeaderDragOver(event,'${colId}','${folder.id}')" ondragleave="onDragLeave(event)"
        ondrop="onFolderHeaderDrop(event,'${colId}','${folder.id}')">
      <span class="col-arrow ${open ? 'open' : ''}">&#9654;</span>
      <span style="font-size:13px">&#128193;</span>
      <span class="folder-name">${esc(folder.name)}</span>
      <button class="col-menu-btn" onclick="event.stopPropagation();folderCtx(event,'${colId}','${folder.id}')" title="Folder options">&#8942;</button>
      <button class="col-add" onclick="event.stopPropagation();addReq('${colId}','${folder.id}')">+</button>
    </div>`;

  if (open) {
    folder.requests.forEach(r => { html += reqRowHTML(r, 22); });
  }

  return html;
}

function reqRowHTML(r, indent, draggable = true) {
  const active   = activeTab()?.reqId === r.id;
  const selected = state.selectedReqIds.has(r.id);
  const ctxOpen  = state.ctxOpenReqId === r.id;
  const color    = MC[r.method] || 'var(--text)';
  const noDrag   = !draggable || state.selectedReqIds.size > 0;

  const handleAttrs = noDrag ? '' :
    `draggable="true" ondragstart="onDragStart(event,'req','${r.id}')" ondragend="onDragEnd(event)"`;

  const dropAttrs = noDrag ? '' :
    `ondragover="onReqRowDragOver(event,'${r.id}')" ondragleave="onDragLeave(event)" ondrop="onReqRowDrop(event,'${r.id}')"`;

  return `
    <div class="req-row ${active ? 'active' : ''} ${selected ? 'selected' : ''} ${noDrag ? 'no-drag' : ''} ${ctxOpen ? 'ctx-open' : ''}" style="padding-left:${indent + 8}px;position:relative"
        ${dropAttrs}
        onclick="reqClick(event,'${r.id}')" oncontextmenu="reqCtx(event,'${r.id}')">
      <span class="req-drag-handle" ${handleAttrs}>&#8942;&#8942;</span>
      <span class="req-check">${selected ? '&#10003;' : ''}</span>
      <span class="req-method" style="color:${color}">${r.method}</span>
      <span class="req-name ${active ? 'active' : ''}">${esc(r.name)}</span>
      <button class="req-menu-btn" onclick="event.stopPropagation();reqCtx(event,'${r.id}')">&#8942;</button>
    </div>`;
}

// ─── Drag & drop ──────────────────────────────────────────────────────────────
// Reordering/moving requests, folders, and collections via drag-and-drop in
// the sidebar. _dragType/_dragId track what's being dragged; moveReqToPosition()/
// moveFolderToPosition()/moveColToPosition() (js/collections.js) do the actual
// array splicing, which server.js persists as each item's `order` (_meta.json
// for folders, colOrder.json for collections) on the next save.
let _dragType = null; // 'req' | 'folder' | 'col'
let _dragId   = null;

function onDragStart(event, type, id) {
  _dragType = type;
  _dragId   = id;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', id);
}

function onDragEnd() {
  _dragType = null;
  _dragId   = null;
  document.querySelectorAll('.drag-over-top,.drag-over-bottom,.drag-target')
    .forEach(el => el.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-target'));
}

function onDragLeave(event) {
  event.currentTarget.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-target');
}

// Dropping a request onto another request row reorders it before/after the
// target (within the same list) or moves it into the target's list.
function onReqRowDragOver(event, reqId) {
  if (_dragType !== 'req' || _dragId === reqId) return;
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer.dropEffect = 'move';
  const el     = event.currentTarget;
  const before = (event.clientY - el.getBoundingClientRect().top) < el.offsetHeight / 2;
  el.classList.toggle('drag-over-top', before);
  el.classList.toggle('drag-over-bottom', !before);
}

function onReqRowDrop(event, reqId) {
  if (_dragType !== 'req' || _dragId === reqId) return;
  event.preventDefault();
  event.stopPropagation();
  const el     = event.currentTarget;
  const before = el.classList.contains('drag-over-top');
  el.classList.remove('drag-over-top', 'drag-over-bottom');

  const target = findReqContainer(reqId);
  if (!target) return;
  moveReqToPosition(_dragId, target.list, before ? target.index : target.index + 1);
  renderSidebar();
  scheduleDiskSave();
}

// Dropping a request onto a folder header moves it into that folder.
// Dropping another folder header onto it reorders folders within the collection.
function onFolderHeaderDragOver(event, colId, folderId) {
  if (!_dragType) return;
  if (_dragType === 'folder' && _dragId === folderId) return;
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer.dropEffect = 'move';
  const el = event.currentTarget;
  if (_dragType === 'folder') {
    const before = (event.clientY - el.getBoundingClientRect().top) < el.offsetHeight / 2;
    el.classList.toggle('drag-over-top', before);
    el.classList.toggle('drag-over-bottom', !before);
  } else {
    el.classList.add('drag-target');
  }
}

function onFolderHeaderDrop(event, colId, folderId) {
  if (!_dragType) return;
  event.preventDefault();
  event.stopPropagation();
  const el = event.currentTarget;
  el.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-target');

  const col = state.cols.find(c => c.id === colId);
  if (!col) return;

  if (_dragType === 'req') {
    const folder = col.folders.find(f => f.id === folderId);
    if (!folder) return;
    moveReqToPosition(_dragId, folder.requests, folder.requests.length);
    state.expandedCols.add(colId);
    state.expandedFolders.add(folderId);
  } else if (_dragType === 'folder') {
    if (_dragId === folderId) return;
    const before    = el.classList.contains('drag-over-top');
    const targetIdx = col.folders.findIndex(f => f.id === folderId);
    moveFolderToPosition(colId, _dragId, before ? targetIdx : targetIdx + 1);
  } else {
    return;
  }

  renderSidebar();
  scheduleDiskSave();
}

// Dropping a request onto a collection's header or empty body area moves it
// to that collection's top level (appended at the end). Dropping another
// collection header onto it reorders collections.
function onColHeaderDragOver(event, colId) {
  if (_dragType === 'col' && _dragId === colId) return;
  if (_dragType !== 'req' && _dragType !== 'col') return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  const el = event.currentTarget;
  if (_dragType === 'col') {
    const before = (event.clientY - el.getBoundingClientRect().top) < el.offsetHeight / 2;
    el.classList.toggle('drag-over-top', before);
    el.classList.toggle('drag-over-bottom', !before);
  } else {
    el.classList.add('drag-target');
  }
}

function onColHeaderDrop(event, colId) {
  if (_dragType === 'col' && _dragId === colId) return;
  if (_dragType !== 'req' && _dragType !== 'col') return;
  event.preventDefault();
  event.stopPropagation();
  const el = event.currentTarget;
  const before = el.classList.contains('drag-over-top');
  el.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-target');

  if (_dragType === 'req') {
    const col = state.cols.find(c => c.id === colId);
    if (!col) return;
    moveReqToPosition(_dragId, col.requests, col.requests.length);
    state.expandedCols.add(colId);
  } else {
    const targetIdx = state.cols.findIndex(c => c.id === colId);
    moveColToPosition(_dragId, before ? targetIdx : targetIdx + 1);
  }

  renderSidebar();
  scheduleDiskSave();
}

// ─── Toggle expand / collapse ─────────────────────────────────────────────────

function toggleCol(id) {
  if (state.expandedCols.has(id)) state.expandedCols.delete(id);
  else state.expandedCols.add(id);
  renderSidebar();
}

function toggleFolder(id) {
  if (state.expandedFolders.has(id)) state.expandedFolders.delete(id);
  else state.expandedFolders.add(id);
  renderSidebar();
}

// ─── Context Menus ────────────────────────────────────────────────────────────

function colCtx(event, colId) {
  event.preventDefault();
  event.stopPropagation();
  showCtxMenu(event.clientX, event.clientY, [
    { label: 'New Request',       action: () => addReq(colId) },
    { label: 'New Folder',        action: () => addFolder(colId) },
    'sep',
    { label: 'Run Collection',    action: () => runCollection(colId) },
    'sep',
    { label: 'Edit Description',  action: () => openColInfoModal(colId) },
    { label: 'Rename',            action: () => renameCol(colId) },
    { label: 'Export JSON',       action: () => exportCol(colId) },
    { label: 'Export as Postman', action: () => exportColAsPostman(colId) },
    'sep',
    { label: 'Delete Collection', action: () => deleteCol(colId), danger: true },
  ]);
}

function folderCtx(event, colId, folderId) {
  event.preventDefault();
  event.stopPropagation();
  showCtxMenu(event.clientX, event.clientY, [
    { label: 'New Request',   action: () => addReq(colId, folderId) },
    'sep',
    { label: 'Run Folder',    action: () => runFolder(colId, folderId) },
    'sep',
    { label: 'Delete Folder', action: () => deleteFolder(colId, folderId), danger: true },
  ]);
}

function copyReqLink(reqId) {
  const r = findReq(reqId);
  if (!r) return;
  copyText(r.url).then(() => notify('Link copied', 'success'));
}

function reqCtx(event, reqId) {
  event.preventDefault();
  event.stopPropagation();

  state.ctxOpenReqId = reqId;

  if (!state.selectedReqIds.has(reqId)) {
    state.selectedReqIds = new Set();
    state.lastSelReqId   = reqId;
    renderSidebar();
  } else {
    document.querySelectorAll('.req-row.ctx-open').forEach(el => el.classList.remove('ctx-open'));
    event.currentTarget.closest('.req-row')?.classList.add('ctx-open');
  }

  const multi = state.selectedReqIds.size > 1;
  const ids   = multi ? [...state.selectedReqIds] : [reqId];

  showCtxMenu(event.clientX, event.clientY, [
    ...(!multi ? [
      { label: 'Rename',    action: () => renameReq(reqId) },
      { label: 'Duplicate', action: () => dupReq(reqId) },
      { label: 'Copy link', action: () => copyReqLink(reqId) },
      'sep',
    ] : []),
    { label: multi ? `Move ${ids.length} requests to…` : 'Move to…',
      action: () => showMovePicker(ids, event.clientX, event.clientY) },
    'sep',
    { label: multi ? `Delete ${ids.length} requests` : 'Delete',
      action: () => deleteReqs(ids), danger: true },
  ]);
}

function showCtxMenu(x, y, items) {
  const menu = document.getElementById('ctx-menu');
  menu.innerHTML = '';

  items.forEach(item => {
    if (item === 'sep') {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      menu.appendChild(sep);
      return;
    }
    const el = document.createElement('div');
    el.className = 'ctx-item' + (item.danger ? ' danger' : '');
    el.textContent = item.label;
    el.addEventListener('click', e => { e.stopPropagation(); hideCtxMenu(); item.action(); });
    menu.appendChild(el);
  });

  // Position — keep within viewport
  menu.style.display = '';
  menu.style.left = '0';
  menu.style.top  = '0';
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = (x + w > window.innerWidth  ? window.innerWidth  - w - 4 : x) + 'px';
  menu.style.top  = (y + h > window.innerHeight ? window.innerHeight - h - 4 : y) + 'px';
}

function hideCtxMenu() {
  document.getElementById('ctx-menu').style.display = 'none';
  state.ctxOpenReqId = null;
  document.querySelectorAll('.req-row.ctx-open').forEach(el => el.classList.remove('ctx-open'));
}
