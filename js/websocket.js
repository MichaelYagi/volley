// ─── WebSocket ─────────────────────────────────────────────────────────────────
// ws:// and wss:// requests are relayed through /api/ws-proxy (see server.js)
// since the browser's WebSocket API can't send custom headers (auth, cookies)
// to an arbitrary cross-origin host. sendRequest() (js/send.js) detects the
// scheme via isWsUrl() and delegates here instead of doing a fetch.

// True if `url` (after {{var}} interpolation) uses the ws:// or wss:// scheme.
function isWsUrl(url) {
  return /^wss?:\/\//i.test(interp(url || ''));
}

// Opens a relayed WebSocket connection for `tab`. Connection state and the
// message transcript live on tab.resp; the live browser WebSocket itself is
// kept on tab.wsSocket (runtime only, never persisted).
async function connectWs(tab) {
  if (tab.wsSocket) return;

  const { url: target, headers } = await buildRequestArgs(tab.req);

  tab.resp    = { ws: true, status: 'connecting', messages: [], url: target };
  tab.respTab = 'body';
  if (activeTab() === tab) {
    document.querySelectorAll('[data-rtab]').forEach(t =>
      t.classList.toggle('active', t.dataset.rtab === 'body')
    );
    renderRespPanel();
  }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const sock  = new WebSocket(`${proto}//${location.host}/api/ws-proxy`);
  tab.wsSocket = sock;

  sock.onopen = () => sock.send(JSON.stringify({ url: target, headers }));

  sock.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === 'open') {
      tab.resp.status = 'open';
      tab.resp.messages.push({ dir: 'system', text: 'Connected', time: Date.now() });
    } else if (msg.type === 'message') {
      tab.resp.messages.push({ dir: 'received', binary: !!msg.binary, data: msg.data, time: Date.now() });
    } else if (msg.type === 'close') {
      tab.resp.status = 'closed';
      tab.resp.messages.push({ dir: 'system', text: 'Connection closed', time: Date.now() });
      sock.close();
      tab.wsSocket = null;
    } else if (msg.type === 'error') {
      tab.resp.status = 'error';
      tab.resp.error  = msg.message;
      tab.resp.messages.push({ dir: 'system', text: `Error: ${msg.message}`, time: Date.now() });
    }

    if (activeTab() === tab) { renderRespPanel(); updateSendBtn(); }
  };

  sock.onclose = () => {
    if (tab.resp?.ws && tab.resp.status !== 'closed' && tab.resp.status !== 'error') {
      tab.resp.status = 'closed';
      tab.resp.messages.push({ dir: 'system', text: 'Connection closed', time: Date.now() });
    }
    tab.wsSocket = null;
    if (activeTab() === tab) { renderRespPanel(); updateSendBtn(); }
  };

  if (activeTab() === tab) updateSendBtn();
}

function disconnectWs(tab) {
  if (!tab?.wsSocket) return;
  tab.wsSocket.close();
  tab.wsSocket = null;
  if (tab.resp?.ws && tab.resp.status !== 'closed') {
    tab.resp.status = 'closed';
    tab.resp.messages.push({ dir: 'system', text: 'Connection closed', time: Date.now() });
  }
  if (activeTab() === tab) { renderRespPanel(); updateSendBtn(); }
}

// Sends a text message over an open relayed WebSocket connection. After the
// connect handshake, the relay forwards frames from the browser to the
// upstream target as-is, so this is just a raw send().
function sendWsMessage(tab, text) {
  if (!tab?.wsSocket || tab.wsSocket.readyState !== WebSocket.OPEN) return;
  tab.wsSocket.send(text);
  tab.resp.messages.push({ dir: 'sent', data: text, time: Date.now() });
  if (activeTab() === tab) renderRespPanel();
}

// Called by the composer's Send button / Enter key (js/response.js).
function sendWsComposerMessage() {
  const tab   = activeTab();
  const input = document.getElementById('ws-msg-input');
  if (!tab || !input || !input.value) return;
  sendWsMessage(tab, input.value);
  document.getElementById('ws-msg-input')?.focus();
}

// Keeps #send-btn's label/handler in sync with the active tab's connection
// state. Called on tab switch/open and whenever the URL or WS state changes.
function updateSendBtn() {
  const tab = activeTab();
  const btn = document.getElementById('send-btn');
  if (!tab || !btn) return;

  if (isWsUrl(tab.req.url)) {
    if (tab.wsSocket) {
      btn.textContent = 'Disconnect';
      btn.onclick     = () => disconnectWs(tab);
    } else {
      btn.textContent = 'Connect';
      btn.onclick     = sendRequest;
    }
  } else if (isMcpUrl(tab.req)) {
    if (tab.resp?.mcp && (tab.resp.status === 'open' || tab.resp.status === 'connecting')) {
      btn.textContent = 'Disconnect';
      btn.onclick     = () => disconnectMcp(tab);
    } else {
      btn.textContent = 'Connect';
      btn.onclick     = sendRequest;
    }
  } else if (tab.loading) {
    btn.textContent = 'Cancel';
    btn.onclick     = cancelReq;
  } else {
    btn.textContent = 'Send';
    btn.onclick     = sendRequest;
  }
}
