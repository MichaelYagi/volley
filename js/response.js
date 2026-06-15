// ─── Response Panel ───────────────────────────────────────────────────────────

function switchRespTab(tabName) {
  const tab = activeTab();
  if (!tab) return;
  tab.respTab = tabName;
  document.querySelectorAll('[data-rtab]').forEach(t =>
    t.classList.toggle('active', t.dataset.rtab === tabName)
  );
  renderRespPanel();
}

function renderRespPanel() {
  const wrap    = document.getElementById('resp-body-wrap');
  const badge   = document.getElementById('status-badge');
  const timeEl  = document.getElementById('resp-time');
  const sizeEl  = document.getElementById('resp-size');
  const copyBtn = document.getElementById('copy-resp-btn');
  const exBtn   = document.getElementById('save-example-btn');
  const tab     = activeTab();
  const resp    = tab?.resp;

  updateTestsBadge(resp);
  teardownJsonTree(wrap);
  wrap.classList.remove('mcp-body');

  // Nothing sent yet
  if (!resp) {
    wrap.innerHTML = `<span class="muted">Press Send to execute the request</span>`;
    exBtn.style.display = 'none';
    return;
  }

  // SSE stream — its own rendering path (handles its own status/error display)
  if (resp.sse) {
    renderSseRespPanel(tab, resp, wrap, badge, timeEl, sizeEl, copyBtn, exBtn);
    return;
  }

  // WebSocket connection — its own rendering path (transcript + composer)
  if (resp.ws) {
    renderWsRespPanel(tab, resp, wrap, badge, timeEl, sizeEl, copyBtn, exBtn);
    return;
  }

  // MCP session — its own rendering path (JSON-RPC transcript + composer)
  if (resp.mcp) {
    renderMcpRespPanel(tab, resp, wrap, badge, timeEl, sizeEl, copyBtn, exBtn);
    return;
  }

  // Network / abort error
  if (resp.error) {
    badge.style.display   = 'none';
    timeEl.style.display  = 'none';
    sizeEl.style.display  = 'none';
    copyBtn.style.display = 'none';
    exBtn.style.display   = 'none';
    wrap.innerHTML = `
      <div style="color:var(--danger);background:var(--danger-bg);border:1px solid var(--danger-border);border-radius:4px;padding:10px 14px">
        ${esc(resp.error)}
        ${resp.elapsed ? `<span style="margin-left:8px;color:var(--text-muted)">(${resp.elapsed}ms)</span>` : ''}
      </div>`;
    return;
  }

  // Status badge
  const color = statusColor(resp.status);
  badge.style.display    = '';
  badge.style.background = color + '22';
  badge.style.color      = color;
  badge.className        = 'status-badge';
  badge.textContent      = `${resp.status} ${resp.statusText}`;

  // Timing & size
  timeEl.style.display = '';
  timeEl.textContent   = resp.elapsed + 'ms';

  if (resp.size != null) {
    sizeEl.style.display = '';
    sizeEl.textContent   = formatBytes(resp.size);
  } else {
    sizeEl.style.display = 'none';
  }

  // Body tab
  if (tab.respTab === 'body') {
    copyBtn.style.display = '';
    exBtn.style.display   = tab.reqId ? '' : 'none';

    if (resp.bodyType === 'image') {
      wrap.innerHTML = `<img src="${resp.body}" style="max-width:100%;border-radius:4px">`;
      return;
    }

    if (resp.bodyType === 'binary') {
      copyBtn.style.display = 'none';
      const ct = resp.headers['content-type'] || 'application/octet-stream';
      wrap.innerHTML = `<span class="muted">Binary response (${esc(ct)}) — preview not supported</span>`;
      return;
    }

    if (resp.bodyType === 'json') {
      try {
        renderJsonTree(wrap, resp.bodyJson);
        return;
      } catch { /* fall through to plain text */ }
    }

    wrap.innerHTML = `<pre>${esc(resp.body)}</pre>`;

  // Headers tab
  } else if (tab.respTab === 'headers') {
    copyBtn.style.display = 'none';
    exBtn.style.display   = 'none';
    wrap.innerHTML = Object.entries(resp.headers)
      .map(([k, v]) =>
        `<div style="margin-bottom:3px">
          <span style="color:var(--json-key)">${esc(k)}</span>
          <span style="color:var(--text-muted)">: </span>
          <span>${esc(v)}</span>
        </div>`
      ).join('');

  // Tests tab
  } else if (tab.respTab === 'tests') {
    copyBtn.style.display = 'none';
    exBtn.style.display   = 'none';
    const results = resp.testResults || [];
    if (!results.length) {
      wrap.innerHTML = `<span class="muted">No tests defined. Add a test script in the Scripts tab.</span>`;
    } else {
      wrap.innerHTML = results.map(r => `
        <div class="test-result ${r.passed ? 'pass' : 'fail'}">
          <span class="test-icon">${r.passed ? '✓' : '✗'}</span>
          <span class="test-name">${esc(r.name)}</span>
          ${r.error ? `<div class="test-error">${esc(r.error)}</div>` : ''}
        </div>`
      ).join('');
    }
  }
}

// Renders an SSE response: a live-updating list of received events on the
// Body tab, the upstream's response headers on the Headers tab, and a
// connection status indicator in place of the usual timing display.
function renderSseRespPanel(tab, resp, wrap, badge, timeEl, sizeEl, copyBtn, exBtn) {
  copyBtn.style.display = 'none';
  exBtn.style.display   = 'none';
  sizeEl.style.display  = 'none';

  if (resp.status) {
    const color = statusColor(resp.status);
    badge.style.display    = '';
    badge.style.background = color + '22';
    badge.style.color      = color;
    badge.className        = 'status-badge';
    badge.textContent      = `${resp.status} ${resp.statusText}`;
  } else {
    badge.style.display = 'none';
  }

  timeEl.style.display = '';
  timeEl.textContent   = resp.status == null
    ? 'Connecting…'
    : (resp.connected ? 'Connected' : `Closed (${resp.elapsed}ms)`);

  if (tab.respTab === 'headers') {
    const entries = Object.entries(resp.headers || {});
    wrap.innerHTML = entries.length
      ? entries.map(([k, v]) =>
          `<div style="margin-bottom:3px">
            <span style="color:var(--json-key)">${esc(k)}</span>
            <span style="color:var(--text-muted)">: </span>
            <span>${esc(v)}</span>
          </div>`
        ).join('')
      : `<span class="muted">No headers</span>`;
    return;
  }

  if (tab.respTab === 'tests') {
    wrap.innerHTML = `<span class="muted">Tests are not supported for SSE streams.</span>`;
    return;
  }

  // Body tab — live event log
  let html = '';
  if (resp.error) {
    html += `<div style="color:var(--danger);background:var(--danger-bg);border:1px solid var(--danger-border);border-radius:4px;padding:8px 12px;margin-bottom:8px">${esc(resp.error)}</div>`;
  }
  if (!resp.events.length) {
    html += `<span class="muted">${resp.connected ? 'Waiting for events…' : 'No events received.'}</span>`;
  } else {
    html += resp.events.map(evt => `
      <div class="sse-event">
        <div class="sse-event-meta">
          <span class="sse-event-name">${esc(evt.event)}</span>
          ${evt.id != null ? `<span class="sse-event-id">id: ${esc(evt.id)}</span>` : ''}
          <span class="sse-event-time">${new Date(evt.receivedAt).toLocaleTimeString()}</span>
        </div>
        <pre class="sse-event-data">${esc(evt.data)}</pre>
      </div>`
    ).join('');
  }
  wrap.innerHTML = html;
}

// Renders a WebSocket connection: a live transcript of sent/received messages
// on the Body tab, plus a message composer while the connection is open. The
// Headers/Tests tabs aren't applicable to a relayed WS connection.
const WS_STATUS_LABEL = { connecting: 'Connecting…', open: 'Connected', closed: 'Closed', error: 'Error' };

function renderWsRespPanel(tab, resp, wrap, badge, timeEl, sizeEl, copyBtn, exBtn) {
  copyBtn.style.display = 'none';
  exBtn.style.display   = 'none';
  sizeEl.style.display  = 'none';
  badge.style.display   = 'none';

  timeEl.style.display = '';
  timeEl.textContent   = WS_STATUS_LABEL[resp.status] || '';

  if (tab.respTab === 'headers') {
    wrap.innerHTML = `<span class="muted">Headers are not available for WebSocket connections.</span>`;
    return;
  }

  if (tab.respTab === 'tests') {
    wrap.innerHTML = `<span class="muted">Tests are not supported for WebSocket connections.</span>`;
    return;
  }

  // Body tab — message transcript + composer
  let html = '<div class="ws-transcript">';
  if (resp.error) {
    html += `<div style="color:var(--danger);background:var(--danger-bg);border:1px solid var(--danger-border);border-radius:4px;padding:8px 12px;margin-bottom:8px">${esc(resp.error)}</div>`;
  }
  if (!resp.messages.length) {
    html += `<span class="muted">${resp.status === 'connecting' ? 'Connecting…' : 'No messages yet.'}</span>`;
  } else {
    html += resp.messages.map(m => {
      if (m.dir === 'system') {
        return `<div class="ws-msg ws-msg-system">
          <span class="ws-msg-time">${new Date(m.time).toLocaleTimeString()}</span>
          <span class="ws-msg-text">${esc(m.text)}</span>
        </div>`;
      }
      const dirLabel = m.dir === 'sent' ? '↑ sent' : '↓ received';
      const body     = m.binary ? `(binary, base64) ${m.data}` : m.data;
      return `<div class="ws-msg ws-msg-${m.dir}">
        <div class="ws-msg-meta">
          <span class="ws-msg-dir">${dirLabel}</span>
          <span class="ws-msg-time">${new Date(m.time).toLocaleTimeString()}</span>
        </div>
        <pre class="ws-msg-data">${esc(body)}</pre>
      </div>`;
    }).join('');
  }
  html += '</div>';

  const open = resp.status === 'open';
  html += `
    <div class="ws-composer">
      <input id="ws-msg-input" type="text" placeholder="Message to send" ${open ? '' : 'disabled'}
             onkeydown="if(event.key==='Enter'){sendWsComposerMessage();event.preventDefault();}">
      <button class="btn-primary" onclick="sendWsComposerMessage()" ${open ? '' : 'disabled'}>Send</button>
    </div>`;

  wrap.innerHTML = html;

  const transcript = wrap.querySelector('.ws-transcript');
  if (transcript) transcript.scrollTop = transcript.scrollHeight;
}

// Renders an MCP session: a transcript of JSON-RPC messages (sent and
// received) on the Body tab, plus a method/params composer while the
// session is open. The Headers/Tests tabs aren't applicable to an MCP
// session.
const MCP_STATUS_LABEL = { connecting: 'Connecting…', open: 'Connected', closed: 'Closed', error: 'Error' };

function renderMcpRespPanel(tab, resp, wrap, badge, timeEl, sizeEl, copyBtn, exBtn) {
  // Preserve scroll position across re-renders — new messages never force
  // the transcript to jump to the bottom. First render starts at the top.
  const prevScrollTop = resp._scroll ? resp._scroll.top : 0;
  // First render: nothing is "unseen" yet — don't show the new-message banner
  // for messages that were already there when the session was opened.
  if (resp._seenCount === undefined) resp._seenCount = resp.messages.length;

  copyBtn.style.display = 'none';
  exBtn.style.display   = 'none';
  sizeEl.style.display  = 'none';
  badge.style.display   = 'none';

  timeEl.style.display = '';
  const statusLabel = MCP_STATUS_LABEL[resp.status] || '';
  timeEl.textContent = resp.serverInfo
    ? `${statusLabel} — ${resp.serverInfo.name}${resp.serverInfo.version ? ' ' + resp.serverInfo.version : ''}`
    : statusLabel;

  if (tab.respTab === 'headers') {
    wrap.innerHTML = `<span class="muted">Headers are not available for MCP sessions.</span>`;
    return;
  }

  if (tab.respTab === 'tests') {
    wrap.innerHTML = `<span class="muted">Tests are not supported for MCP sessions.</span>`;
    return;
  }

  // Body tab — method/params composer (fixed, non-scrolling) + scrollable
  // JSON-RPC transcript below it.
  wrap.classList.add('mcp-body');
  const open = resp.status === 'open';
  let html = `
    <div class="mcp-composer">
      <div class="mcp-composer-row">
        <input id="mcp-method-input" list="mcp-methods" placeholder="method (e.g. tools/list)" value="${esc(resp._lastComposer?.method ?? 'tools/list')}" ${open ? '' : 'disabled'}>
        <button class="btn-primary" onclick="sendMcpComposerMessage()" ${open ? '' : 'disabled'}>Send</button>
      </div>
      <datalist id="mcp-methods">
        ${MCP_METHODS.map(m => `<option value="${esc(m)}">`).join('')}
      </datalist>
      <textarea id="mcp-params-input" placeholder="params (JSON)" rows="6" ${open ? '' : 'disabled'}>${esc(resp._lastComposer?.params ?? '{}')}</textarea>
    </div>`;

  html += '<div class="mcp-transcript-wrap"><div class="ws-transcript">';
  if (resp.error) {
    html += `<div style="color:var(--danger);background:var(--danger-bg);border:1px solid var(--danger-border);border-radius:4px;padding:8px 12px;margin-bottom:8px">${esc(resp.error)}</div>`;
  }
  if (!resp.messages.length) {
    html += `<span class="muted">${resp.status === 'connecting' ? 'Connecting…' : 'No messages yet.'}</span>`;
  } else {
    html += resp.messages.map(m => {
      if (m.dir === 'system') {
        return `<div class="ws-msg ws-msg-system">
          <span class="ws-msg-time">${new Date(m.time).toLocaleTimeString()}</span>
          <span class="ws-msg-text">${esc(m.text)}</span>
        </div>`;
      }
      const dirLabel = m.dir === 'sent' ? '↑ sent' : '↓ received';
      return `<div class="ws-msg ws-msg-${m.dir}">
        <div class="ws-msg-meta">
          <span class="ws-msg-dir">${dirLabel}</span>
          <span class="ws-msg-time">${new Date(m.time).toLocaleTimeString()}</span>
        </div>
        <pre class="ws-msg-data">${esc(JSON.stringify(m.data, null, 2))}</pre>
      </div>`;
    }).join('');
  }
  html += '</div></div>';

  wrap.innerHTML = html;

  const transcriptWrap = wrap.querySelector('.mcp-transcript-wrap');
  if (transcriptWrap) {
    // Setting scrollTop on the freshly-created element fires an async
    // 'scroll' event — ignore that one so it isn't mistaken for a user
    // scroll (which would immediately dismiss the new-message banner below).
    let ignoreNextScroll = prevScrollTop !== 0;
    transcriptWrap.scrollTop = prevScrollTop;
    resp._scroll = { top: transcriptWrap.scrollTop };

    const atBottom = () =>
      transcriptWrap.scrollHeight - transcriptWrap.scrollTop - transcriptWrap.clientHeight < 10;
    if (atBottom()) resp._seenCount = resp.messages.length;

    const dismissBanner = () => {
      resp._seenCount = resp.messages.length;
      wrap.querySelector('.mcp-new-msg-banner')?.remove();
    };

    transcriptWrap.addEventListener('scroll', () => {
      if (ignoreNextScroll) { ignoreNextScroll = false; return; }
      resp._scroll = { top: transcriptWrap.scrollTop };
      if (atBottom()) dismissBanner();
    });

    if (resp.messages.length > resp._seenCount) {
      const banner = document.createElement('div');
      banner.className = 'mcp-new-msg-banner';
      banner.textContent = 'New response ↓';
      banner.onclick = () => {
        transcriptWrap.scrollTo({ top: transcriptWrap.scrollHeight, behavior: 'smooth' });
        resp._scroll = { top: transcriptWrap.scrollHeight };
        dismissBanner();
      };
      wrap.appendChild(banner);
    }
  }
}

// Show a pass/fail summary badge on the "Tests" response tab.
function updateTestsBadge(resp) {
  const badge = document.getElementById('resp-tests-badge');
  if (!badge) return;
  const results = resp?.testResults;
  if (!results || !results.length) { badge.style.display = 'none'; return; }
  const failed = results.filter(r => !r.passed).length;
  badge.style.display    = '';
  badge.textContent      = failed ? `${failed}✗` : `${results.length}✓`;
  badge.style.background = failed ? 'var(--danger-bg)' : 'transparent';
  badge.style.color      = failed ? 'var(--danger)' : 'var(--success, #3fb950)';
}

function copyResponse() {
  const resp = activeTab()?.resp;
  if (resp?.body) {
    copyText(resp.body).then(() => notify('Copied', 'success'));
  }
}

// Saves the current response as a named "Example" on the request, viewable
// later from the request's Examples tab — see js/request.js's examplesHTML().
async function saveResponseAsExample() {
  const tab = activeTab();
  if (!tab?.resp || !tab.reqId) return;

  const name = await promptDialog('Save response as example named:', `${tab.resp.status} ${tab.resp.statusText}`.trim());
  if (!name) return;

  const resp = tab.resp;
  let body = resp.body;
  if (resp.bodyType === 'image') {
    // resp.body is a blob: URL, only valid for this document's lifetime —
    // convert to a data: URL so the example survives a page reload.
    const blob = await fetch(resp.body).then(r => r.blob());
    body = await new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  }

  tab.req.examples.push({
    id: uid(), name,
    status: resp.status, statusText: resp.statusText,
    headers: resp.headers, body, bodyJson: resp.bodyJson, bodyType: resp.bodyType,
    createdAt: Date.now(),
  });

  scheduleAutoSave();
  updateTabBadges();
  if (tab.reqTab === 'examples') renderReqPanel();
  notify(`Saved example "${name}"`, 'success');
}

// ─── JSON Tree (DOM-built — no innerHTML, safe for any content) ───────────────

// Save a value extracted from the response into the active environment.
async function saveJsonValueAsVar(value) {
  const env = state.envs.find(e => e.id === state.activeEnv);
  if (!env) { notify('No active environment', 'error'); return; }

  const name = await promptDialog('Save as environment variable named:');
  if (!name) return;

  const strValue = typeof value === 'string' ? value : JSON.stringify(value);
  const existing = env.vars.find(v => v.key === name);
  if (existing) existing.value = strValue;
  else env.vars.push({ id: uid(), key: name, value: strValue, enabled: true });

  scheduleDiskSave();
  notify(`Saved {{${name}}}`, 'success');
}

function buildSaveVarBtn(value) {
  const btn = document.createElement('button');
  btn.className   = 'jt-savevar';
  btn.textContent = '→{{}}';
  btn.title       = 'Save as environment variable';
  btn.addEventListener('click', e => {
    e.stopPropagation();
    saveJsonValueAsVar(value);
  });
  return btn;
}

// Rows are absolutely positioned at `index * JT_ROW_HEIGHT` — keep this in
// sync with the .jt-row height/line-height in css/response.css.
const JT_ROW_HEIGHT = 21; // px
const JT_OVERSCAN   = 10; // extra rows rendered above/below the viewport

// Builds a tree of { open, isArr, children } mirroring `data`'s shape, used
// to track each object/array's expanded/collapsed state across re-renders.
// Top two levels start expanded, matching the old recursive tree's default.
function buildJtState(data, depth) {
  if (data === null || typeof data !== 'object') return null;
  const isArr = Array.isArray(data);
  const keys  = isArr ? data.map((_, i) => i) : Object.keys(data);
  return {
    open:  depth < 2,
    isArr,
    children: keys.map(k => buildJtState(data[k], depth + 1)),
  };
}

function jtPreview(data, isArr) {
  if (isArr) return `▸ [… ${data.length}]`;
  const keys = Object.keys(data);
  return `▸ {${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '…' : ''}}`;
}

// Walks `data`/`state` and appends one line descriptor per visible row to
// `lines` — collapsed objects/arrays contribute a single 'collapsed' line,
// expanded ones contribute an 'open' line, one line per child, and a 'close'
// line. This flat list is what gets virtualized for rendering.
function flattenJsonTree(data, state, depth, keyLabel, comma, lines) {
  if (data === null || typeof data !== 'object') {
    lines.push({ depth, keyLabel, comma, type: 'leaf', data });
    return;
  }

  const { isArr, children } = state;
  const keys = isArr ? data.map((_, i) => i) : Object.keys(data);

  if (!keys.length) {
    lines.push({ depth, keyLabel, comma, type: 'empty', isArr });
    return;
  }

  if (!state.open) {
    lines.push({ depth, keyLabel, comma, type: 'collapsed', isArr, data, state });
    return;
  }

  lines.push({ depth, keyLabel, comma: false, type: 'open', isArr, state });
  keys.forEach((k, i) => {
    flattenJsonTree(data[k], children[i], depth + 1, isArr ? null : k, i < keys.length - 1, lines);
  });
  lines.push({ depth, keyLabel: null, comma, type: 'close', isArr });
}

// Builds the DOM for a single flattened line.
function buildJtRow(line, onToggle) {
  const row = document.createElement('div');
  row.className = 'jt-row';
  row.style.paddingLeft = (line.depth * 16) + 'px';

  if (line.keyLabel !== null && line.keyLabel !== undefined) {
    const keyEl = document.createElement('span');
    keyEl.className   = 'jt-key';
    keyEl.textContent = `"${line.keyLabel}"`;
    row.appendChild(keyEl);

    const colon       = document.createElement('span');
    colon.style.color = 'var(--text-muted)';
    colon.textContent = ': ';
    row.appendChild(colon);
  }

  if (line.type === 'leaf') {
    row.classList.add('jt-leaf');
    const data    = line.data;
    const valueEl = document.createElement('span');
    if (data === null)                  { valueEl.className = 'jt-null'; valueEl.textContent = 'null';      }
    else if (typeof data === 'boolean') { valueEl.className = 'jt-bool'; valueEl.textContent = String(data); }
    else if (typeof data === 'number')  { valueEl.className = 'jt-num';  valueEl.textContent = data;         }
    else                                 { valueEl.className = 'jt-str'; valueEl.textContent = `"${data}"`;  }
    row.appendChild(valueEl);
    row.appendChild(buildSaveVarBtn(data));

  } else if (line.type === 'empty') {
    const span = document.createElement('span');
    span.style.color  = 'var(--text-muted)';
    span.textContent  = line.isArr ? '[]' : '{}';
    row.appendChild(span);

  } else if (line.type === 'collapsed') {
    const toggle = document.createElement('span');
    toggle.className   = 'jt-toggle';
    toggle.textContent = jtPreview(line.data, line.isArr);
    toggle.addEventListener('click', () => { line.state.open = true; onToggle(); });
    row.appendChild(toggle);

  } else if (line.type === 'open') {
    const toggle = document.createElement('span');
    toggle.className   = 'jt-toggle';
    toggle.textContent = '▾';
    toggle.addEventListener('click', () => { line.state.open = false; onToggle(); });
    row.appendChild(toggle);

    const bracket       = document.createElement('span');
    bracket.style.color = 'var(--text-muted)';
    bracket.textContent = line.isArr ? '[' : '{';
    row.appendChild(bracket);

  } else if (line.type === 'close') {
    const bracket       = document.createElement('span');
    bracket.style.color = 'var(--text-muted)';
    bracket.textContent = line.isArr ? ']' : '}';
    row.appendChild(bracket);
  }

  if (line.comma) {
    const comma       = document.createElement('span');
    comma.style.color = 'var(--text-muted)';
    comma.textContent = ',';
    row.appendChild(comma);
  }

  return row;
}

// Removes any scroll/resize listeners left over from a previously rendered
// JSON tree — called at the top of renderRespPanel() before repurposing
// `wrap` for a different tab/body type.
function teardownJsonTree(wrap) {
  if (wrap._jtScrollHandler)  { wrap.removeEventListener('scroll', wrap._jtScrollHandler); wrap._jtScrollHandler = null; }
  if (wrap._jtResizeObserver) { wrap._jtResizeObserver.disconnect(); wrap._jtResizeObserver = null; }
}

// Renders `data` as a collapsible JSON tree inside `wrap` (#resp-body-wrap),
// virtualizing rows so only those visible in the scrollable viewport (plus a
// small overscan buffer) are ever present in the DOM — large responses stay
// fast to render and scroll.
function renderJsonTree(wrap, data) {
  const rootState = buildJtState(data, 0);

  wrap.innerHTML = '';
  const spacer = document.createElement('div');
  spacer.style.position = 'relative';
  wrap.appendChild(spacer);

  let lines = [];

  function render() {
    spacer.style.height = (lines.length * JT_ROW_HEIGHT) + 'px';

    const start = Math.max(0, Math.floor(wrap.scrollTop / JT_ROW_HEIGHT) - JT_OVERSCAN);
    const end   = Math.min(lines.length, Math.ceil((wrap.scrollTop + wrap.clientHeight) / JT_ROW_HEIGHT) + JT_OVERSCAN);

    spacer.innerHTML = '';
    for (let i = start; i < end; i++) {
      const row    = buildJtRow(lines[i], reflow);
      row.style.top = (i * JT_ROW_HEIGHT) + 'px';
      spacer.appendChild(row);
    }
  }

  function reflow() {
    lines = [];
    flattenJsonTree(data, rootState, 0, null, false, lines);
    render();
  }

  wrap._jtScrollHandler = render;
  wrap.addEventListener('scroll', wrap._jtScrollHandler);

  wrap._jtResizeObserver = new ResizeObserver(render);
  wrap._jtResizeObserver.observe(wrap);

  reflow();
}
