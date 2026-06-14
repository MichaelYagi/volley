// ─── MCP (Model Context Protocol) ────────────────────────────────────────────
// Salvo includes a small built-in MCP client for two transports, selected by
// URL scheme:
//
// - mcp+http:// / mcp+https://  -- Streamable HTTP transport. Strip the
//   `mcp+` prefix to get the real endpoint and POST JSON-RPC messages via
//   /api/proxy-stream (so both plain-JSON and SSE responses are handled).
//   The `Mcp-Session-Id` response header (if any) is captured and replayed on
//   subsequent requests, and the negotiated `protocolVersion` is sent back as
//   `MCP-Protocol-Version`.
// - mcp+stdio://<command line>  -- everything after the scheme is a shell
//   command line; Salvo spawns it as a local child process via
//   /api/mcp-stdio (see server.js) and speaks newline-delimited JSON-RPC over
//   its stdin/stdout.
//
// Either way, Connect performs the `initialize` handshake (and sends
// `notifications/initialized`), then the composer lets you send arbitrary
// JSON-RPC requests/notifications and view the transcript. sendRequest()
// (js/send.js) detects the scheme via isMcpUrl() and delegates here instead
// of doing a fetch.

const MCP_PROTOCOL_VERSION = '2025-06-18';

const MCP_METHODS = [
  'tools/list', 'tools/call',
  'resources/list', 'resources/read', 'resources/templates/list',
  'prompts/list', 'prompts/get',
  'completion/complete', 'logging/setLevel', 'ping',
];

// True if `url` (after {{var}} interpolation) uses the mcp+http(s):// or
// mcp+stdio:// scheme.
function isMcpUrl(url) {
  return /^mcp\+(https?|stdio):\/\//i.test(interp(url || ''));
}

function mcpTransport(url) {
  return /^mcp\+stdio:\/\//i.test(interp(url || '')) ? 'stdio' : 'http';
}

// Splits a shell-style command line into argv, honoring "..." and '...' quoting.
function splitCommandLine(s) {
  const out = [];
  let cur = '', quote = null;
  for (const c of s) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (/\s/.test(c)) {
      if (cur) { out.push(cur); cur = ''; }
    } else {
      cur += c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function nextMcpId(tab) {
  return tab.resp.nextId++;
}

// Opens an MCP session for `tab`. Connection state and the JSON-RPC
// transcript live on tab.resp; the live relay WebSocket (stdio transport
// only) is kept on tab.mcpSocket (runtime only, never persisted).
async function connectMcp(tab) {
  if (tab.mcpConnecting) return;
  if (tab.resp?.mcp && (tab.resp.status === 'open' || tab.resp.status === 'connecting')) return;

  const transport = mcpTransport(tab.req.url);
  tab.resp = {
    mcp: true, transport, status: 'connecting', messages: [],
    sessionId: null, protocolVersion: null, serverInfo: null,
    initializeId: null, nextId: 1,
  };
  tab.respTab = 'body';
  if (activeTab() === tab) {
    document.querySelectorAll('[data-rtab]').forEach(t =>
      t.classList.toggle('active', t.dataset.rtab === 'body')
    );
    renderRespPanel();
  }

  tab.mcpConnecting = true;
  try {
    if (transport === 'stdio') connectMcpStdio(tab);
    else await sendMcpInitialize(tab);
  } finally {
    tab.mcpConnecting = false;
  }
  if (activeTab() === tab) updateSendBtn();
}

// Spawns the command after `mcp+stdio://` as a local child process via the
// /api/mcp-stdio relay (see server.js) and wires up the JSON-RPC handshake.
function connectMcpStdio(tab) {
  const raw     = interp(tab.req.url);
  const cmdline = raw.replace(/^mcp\+stdio:\/\//i, '').trim();
  const [command, ...args] = splitCommandLine(cmdline);

  if (!command) {
    tab.resp.status = 'error';
    tab.resp.error  = 'No command specified after mcp+stdio://';
    tab.resp.messages.push({ dir: 'system', text: tab.resp.error, time: Date.now() });
    if (activeTab() === tab) renderRespPanel();
    return;
  }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const sock  = new WebSocket(`${proto}//${location.host}/api/mcp-stdio`);
  tab.mcpSocket = sock;

  sock.onopen = () => sock.send(JSON.stringify({ command, args }));

  sock.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === 'open') {
      tab.resp.status = 'open';
      tab.resp.messages.push({ dir: 'system', text: 'Connected', time: Date.now() });
      if (activeTab() === tab) { renderRespPanel(); updateSendBtn(); }
      sendMcpInitialize(tab);
      return;
    }
    if (msg.type === 'message') {
      handleMcpMessage(tab, msg.data);
      return;
    }
    if (msg.type === 'stderr') {
      tab.resp.messages.push({ dir: 'system', text: `stderr: ${msg.data}`, time: Date.now() });
      if (activeTab() === tab) renderRespPanel();
      return;
    }
    if (msg.type === 'close') {
      if (tab.resp.status !== 'error') tab.resp.status = 'closed';
      const detail = msg.signal ? `signal ${msg.signal}` : `code ${msg.code ?? ''}`;
      tab.resp.messages.push({ dir: 'system', text: `Process exited (${detail})`, time: Date.now() });
      sock.close();
      tab.mcpSocket = null;
      if (activeTab() === tab) { renderRespPanel(); updateSendBtn(); }
      return;
    }
    if (msg.type === 'error') {
      tab.resp.status = 'error';
      tab.resp.error  = msg.message;
      tab.resp.messages.push({ dir: 'system', text: `Error: ${msg.message}`, time: Date.now() });
      if (activeTab() === tab) { renderRespPanel(); updateSendBtn(); }
    }
  };

  sock.onclose = () => {
    if (tab.resp?.mcp && tab.resp.status !== 'closed' && tab.resp.status !== 'error') {
      tab.resp.status = 'closed';
      tab.resp.messages.push({ dir: 'system', text: 'Connection closed', time: Date.now() });
    }
    tab.mcpSocket = null;
    if (activeTab() === tab) { renderRespPanel(); updateSendBtn(); }
  };
}

function disconnectMcp(tab) {
  if (!tab?.resp?.mcp) return;
  if (tab.mcpSocket) { tab.mcpSocket.close(); tab.mcpSocket = null; }
  if (tab.resp.status !== 'closed' && tab.resp.status !== 'error') {
    tab.resp.status = 'closed';
    tab.resp.messages.push({ dir: 'system', text: 'Connection closed', time: Date.now() });
  }
  if (activeTab() === tab) { renderRespPanel(); updateSendBtn(); }
}

// Sends `initialize`, recording its id so handleMcpMessage() can recognize
// the response and follow up with notifications/initialized.
async function sendMcpInitialize(tab) {
  const id = nextMcpId(tab);
  tab.resp.initializeId = id;
  await mcpSend(tab, {
    jsonrpc: '2.0', id, method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities:    {},
      clientInfo:      { name: 'Salvo', version: '1.0' },
    },
  });
}

// Records `msg` in the transcript and sends it over the active transport.
async function mcpSend(tab, msg) {
  tab.resp.messages.push({ dir: 'sent', data: msg, time: Date.now() });
  if (activeTab() === tab) renderRespPanel();

  if (tab.resp.transport === 'stdio') {
    if (tab.mcpSocket?.readyState === WebSocket.OPEN) tab.mcpSocket.send(JSON.stringify(msg));
  } else {
    await sendMcpHttp(tab, msg);
  }
}

// Posts a single JSON-RPC message to the mcp+http(s):// endpoint via
// /api/proxy-stream, handling both a plain JSON response and an SSE response
// containing one or more JSON-RPC messages.
async function sendMcpHttp(tab, msg) {
  try {
    const { url: target, headers } = await buildRequestArgs(tab.req);
    const endpoint = target.replace(/^mcp\+/i, '');

    const reqHeaders = {
      ...headers,
      'Content-Type': 'application/json',
      'Accept':       'application/json, text/event-stream',
    };
    if (tab.resp.sessionId)       reqHeaders['Mcp-Session-Id']      = tab.resp.sessionId;
    if (tab.resp.protocolVersion) reqHeaders['MCP-Protocol-Version'] = tab.resp.protocolVersion;

    const proxyRes = await fetch('/api/proxy-stream', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ url: endpoint, method: 'POST', headers: reqHeaders, bodyKind: 'raw', body: JSON.stringify(msg) }),
    });

    if (proxyRes.headers.get('x-salvo-stream') === 'error') {
      const data = await proxyRes.json();
      throw new Error(data.error);
    }

    const status = Number(proxyRes.headers.get('x-salvo-upstream-status')) || 0;
    let respHeaders = {};
    try { respHeaders = JSON.parse(atob(proxyRes.headers.get('x-salvo-upstream-headers') || '')) || {}; } catch {}

    if (respHeaders['mcp-session-id']) tab.resp.sessionId = respHeaders['mcp-session-id'];

    const text = await proxyRes.text();

    if (status >= 400) throw new Error(`HTTP ${status}${text ? `: ${text.slice(0, 300)}` : ''}`);

    const contentType = respHeaders['content-type'] || '';
    if (contentType.includes('text/event-stream')) {
      const { events } = extractSseEvents(text);
      for (const evt of events) {
        if (!evt.data) continue;
        try { handleMcpMessage(tab, JSON.parse(evt.data)); } catch {}
      }
    } else if (text.trim()) {
      try { handleMcpMessage(tab, JSON.parse(text)); }
      catch { tab.resp.messages.push({ dir: 'system', text: `Non-JSON response: ${text.slice(0, 300)}`, time: Date.now() }); }
    }
    // Otherwise: empty body (e.g. 202 Accepted for a notification) — nothing to show.
  } catch (err) {
    tab.resp.status = 'error';
    tab.resp.error  = err.message;
    tab.resp.messages.push({ dir: 'system', text: `Error: ${err.message}`, time: Date.now() });
  }

  if (activeTab() === tab) { renderRespPanel(); updateSendBtn(); }
}

// Records an incoming JSON-RPC message, captures server info from the
// initialize response, and kicks off notifications/initialized once
// initialize completes.
function handleMcpMessage(tab, data) {
  tab.resp.messages.push({ dir: 'received', data, time: Date.now() });

  if (data?.id === tab.resp.initializeId && data.result) {
    if (data.result.protocolVersion) tab.resp.protocolVersion = data.result.protocolVersion;
    if (data.result.serverInfo)      tab.resp.serverInfo      = data.result.serverInfo;
    mcpSend(tab, { jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  if (activeTab() === tab) renderRespPanel();
}

// Called by the composer's Send button (js/response.js).
function sendMcpComposerMessage() {
  const tab          = activeTab();
  const methodInput  = document.getElementById('mcp-method-input');
  const paramsInput  = document.getElementById('mcp-params-input');
  if (!tab || !methodInput || !methodInput.value.trim()) return;

  let params;
  try { params = paramsInput.value.trim() ? JSON.parse(paramsInput.value) : undefined; }
  catch { notify('Params must be valid JSON', 'error'); return; }

  const msg = { jsonrpc: '2.0', id: nextMcpId(tab), method: methodInput.value.trim() };
  if (params !== undefined) msg.params = params;

  mcpSend(tab, msg);
}
