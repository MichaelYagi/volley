// ─── Send Request ─────────────────────────────────────────────────────────────

async function sendRequest() {
  const tab = activeTab();
  if (!tab || tab.loading) return;

  tab.abortCtrl = new AbortController();
  tab.loading   = true;
  tab.resp      = null;
  tab.respTab   = 'body';

  if (activeTab() === tab) {
    // Switch response tabs to body and show spinner
    document.querySelectorAll('[data-rtab]').forEach(t =>
      t.classList.toggle('active', t.dataset.rtab === 'body')
    );
    document.getElementById('send-btn').textContent = 'Cancel';
    document.getElementById('send-btn').onclick     = cancelReq;
    document.getElementById('resp-body-wrap').innerHTML =
      `<div style="display:flex;align-items:center;gap:8px;color:var(--text-muted)">
         <div class="spinner"><span></span><span></span><span></span></div> Sending…
       </div>`;
    document.getElementById('status-badge').style.display   = 'none';
    document.getElementById('resp-time').style.display      = 'none';
    document.getElementById('resp-size').style.display      = 'none';
    document.getElementById('copy-resp-btn').style.display  = 'none';
    document.getElementById('resp-tests-badge').style.display = 'none';
  }

  const start = Date.now();

  try {
    if (tab.req.preRequestScript?.trim()) {
      try {
        runScript(tab.req.preRequestScript, buildPmApi(tab.req, null).pm);
        scheduleDiskSave();
      } catch (e) {
        throw new Error(`Pre-request script error: ${e.message}`);
      }
    }

    const { url: builtUrl, headers, bodyKind, bodyPayload, digestAuth } = await buildRequestArgs(tab.req);

    const proxyRes = await fetch('/api/proxy', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        url: builtUrl, method: tab.req.method, headers, bodyKind, body: bodyPayload, digestAuth,
        skipCookieJar: isAutoHeaderDisabled(tab.req, 'Cookie'),
      }),
      signal:  tab.abortCtrl.signal,
    });

    const data = await proxyRes.json();
    if (!data.ok) throw new Error(data.error);

    const elapsed = Date.now() - start;
    tab.resp      = await parseResponse(data, elapsed);

    // Log to history
    state.hist.push({
      method:  tab.req.method,
      url:     builtUrl,
      status:  data.status,
      elapsed,
    });

    if (tab.req.testScript?.trim()) {
      const { pm, testResults } = buildPmApi(tab.req, tab.resp);
      try {
        runScript(tab.req.testScript, pm);
      } catch (e) {
        testResults.push({ name: 'Test script error', passed: false, error: e.message });
      }
      tab.resp.testResults = testResults;
    }

    if (state.showHist) renderHistPanel();
    scheduleDiskSave();
    await refreshCookieJar();

  } catch (err) {
    const elapsed = Date.now() - start;
    tab.resp = err.name === 'AbortError'
      ? { error: 'Request cancelled', elapsed }
      : { error: err.message, elapsed };

  } finally {
    tab.loading = false;
    if (activeTab() === tab) {
      document.getElementById('send-btn').textContent = 'Send';
      document.getElementById('send-btn').onclick     = sendRequest;
      renderRespPanel();
      if (tab.reqTab === 'headers') renderReqPanel();
    }
  }
}

function cancelReq() {
  activeTab()?.abortCtrl?.abort();
}

// ─── Build fetch arguments from the active request ────────────────────────────

async function buildRequestArgs(req) {
  // URL + path variables + query params
  let raw = interp(req.url);
  raw = substitutePathVars(raw, req.pathVars);
  if (!raw.match(/^https?:\/\//i)) raw = 'https://' + raw;
  const urlObj = new URL(raw);

  req.params
    .filter(p => p.enabled && p.key)
    .forEach(p => urlObj.searchParams.set(interp(p.key), interp(p.value)));

  // Headers
  const headers = {};
  req.headers
    .filter(h => h.enabled && h.key)
    .forEach(h => { headers[interp(h.key)] = interp(h.value); });

  // Auth
  const auth = req.auth;
  let digestAuth = null;

  if (auth.type === 'bearer' && auth.token && !isAutoHeaderDisabled(req, 'Authorization')) {
    headers['Authorization'] = `Bearer ${interp(auth.token)}`;
  }
  if (auth.type === 'basic' && !isAutoHeaderDisabled(req, 'Authorization')) {
    headers['Authorization'] = `Basic ${btoa(`${auth.username}:${auth.password}`)}`;
  }
  if (auth.type === 'apikey' && auth.apiKey && !isAutoHeaderDisabled(req, interp(auth.apiKey))) {
    headers[auth.apiKey] = auth.apiValue;
  }
  if ((auth.type === 'oauth2_cc' || auth.type === 'oauth2_pwd') && !isAutoHeaderDisabled(req, 'Authorization')) {
    const token = await ensureOAuthToken(auth);
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }
  if (auth.type === 'digest' && (auth.username || auth.password)) {
    digestAuth = { username: interp(auth.username), password: interp(auth.password) };
  }
  if (auth.type === 'jwt' && auth.jwtSecret && !isAutoHeaderDisabled(req, 'Authorization')) {
    const jwt = await buildJwt(interp(auth.jwtSecret), auth.jwtPayload);
    headers['Authorization'] = `Bearer ${jwt}`;
  }

  // Body
  let bodyKind    = 'none';
  let bodyPayload = null;
  const bt = req.body.type;

  if (bt === 'raw' && req.body.raw) {
    bodyKind    = 'raw';
    bodyPayload = interp(req.body.raw);
  } else if (bt === 'formdata') {
    bodyKind    = 'formdata';
    bodyPayload = req.body.formData
      .filter(f => f.enabled && f.key)
      .map(f => f.type === 'file'
        ? { key: interp(f.key), type: 'file', fileName: f.fileName, fileData: f.fileData, fileMimeType: f.fileMimeType }
        : { key: interp(f.key), value: interp(f.value) });
  } else if (bt === 'binary') {
    bodyKind    = 'binary';
    bodyPayload = { fileName: req.body.fileName, fileData: req.body.fileData, fileMimeType: req.body.binaryMimeType };
  } else if (bt === 'urlencoded') {
    bodyKind    = 'urlencoded';
    bodyPayload = req.body.formData
      .filter(f => f.enabled && f.key)
      .map(f => ({ key: interp(f.key), value: interp(f.value) }));
  } else if (bt === 'graphql') {
    bodyKind = 'graphql';
    let variables = {};
    try { variables = JSON.parse(interp(req.body.graphql.variables || '') || '{}'); } catch {}
    bodyPayload = { query: interp(req.body.graphql.query || ''), variables };
    if (!isAutoHeaderDisabled(req, 'Content-Type') && !Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
  }

  return { url: urlObj.toString(), headers, bodyKind, bodyPayload, digestAuth };
}

// ─── OAuth 2.0 token acquisition (Client Credentials / Password Grant) ────────

async function ensureOAuthToken(auth) {
  if (auth.cachedToken && auth.cachedExpiry > Date.now() + 5000) return auth.cachedToken;
  return fetchOAuthToken(auth);
}

async function fetchOAuthToken(auth) {
  if (!auth.accessTokenUrl) throw new Error('Access Token URL is required');

  const params = { grant_type: auth.type === 'oauth2_pwd' ? 'password' : 'client_credentials' };
  if (auth.clientId)     params.client_id     = interp(auth.clientId);
  if (auth.clientSecret) params.client_secret = interp(auth.clientSecret);
  if (auth.scope)        params.scope         = interp(auth.scope);
  if (auth.type === 'oauth2_pwd') {
    params.username = interp(auth.username);
    params.password = interp(auth.password);
  }

  const body = Object.entries(params).map(([key, value]) => ({ key, value }));
  const res  = await fetch('/api/proxy', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url:      interp(auth.accessTokenUrl),
      method:   'POST',
      headers:  { 'Content-Type': 'application/x-www-form-urlencoded' },
      bodyKind: 'urlencoded',
      body,
    }),
  });

  const data = await res.json();
  if (!data.ok || data.status < 200 || data.status >= 300) {
    throw new Error('Token request failed: ' + (data.error || `HTTP ${data.status}`));
  }

  const json = JSON.parse(new TextDecoder('utf-8').decode(base64ToBytes(data.bodyBase64)));
  if (!json.access_token) throw new Error('Token response missing access_token');

  auth.cachedToken  = json.access_token;
  auth.cachedExpiry = Date.now() + (json.expires_in ? json.expires_in * 1000 : 3600_000);
  scheduleAutoSave();
  return auth.cachedToken;
}

function manualFetchOAuthToken() {
  const auth = activeTab().req.auth;
  fetchOAuthToken(auth)
    .then(() => { renderReqPanel(); notify('Token acquired', 'success'); })
    .catch(e => notify(e.message, 'error'));
}

// ─── JWT (HS256) signing ───────────────────────────────────────────────────────

async function buildJwt(secret, payloadStr) {
  let payload;
  try { payload = JSON.parse(payloadStr || '{}'); } catch { payload = {}; }

  const now = Math.floor(Date.now() / 1000);
  if (payload.iat === undefined) payload.iat = now;
  if (payload.exp === undefined) payload.exp = now + 3600;

  const header = { alg: 'HS256', typ: 'JWT' };
  const enc  = obj => base64url(new TextEncoder().encode(JSON.stringify(obj)));
  const data = `${enc(header)}.${enc(payload)}`;

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));

  return `${data}.${base64url(new Uint8Array(sig))}`;
}

function base64url(bytes) {
  let str = '';
  bytes.forEach(b => str += String.fromCharCode(b));
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ─── Parse the proxied response into our response state object ───────────────

function base64ToBytes(b64) {
  const bin   = atob(b64 || '');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Parses and pretty-prints JSON text in a Web Worker so large response
// bodies don't block the UI thread. Resolves to { value, pretty }, or null
// if `text` isn't valid JSON.
function parseJsonOffMainThread(text) {
  return new Promise(resolve => {
    const worker = new Worker('js/json-worker.js');
    worker.onmessage = e => {
      worker.terminate();
      resolve(e.data.ok ? { value: e.data.value, pretty: e.data.pretty } : null);
    };
    worker.postMessage(text);
  });
}

async function parseResponse(data, elapsed) {
  const respHeaders = data.headers || {};
  const ct          = respHeaders['content-type'] || '';
  const bytes       = base64ToBytes(data.bodyBase64);

  if (ct.includes('image')) {
    const blob = new Blob([bytes], { type: ct });
    return {
      status:     data.status,
      statusText: data.statusText,
      headers:    respHeaders,
      body:       URL.createObjectURL(blob),
      bodyType:   'image',
      elapsed,
      size:       bytes.length,
    };
  }

  const isText = !ct || ct.startsWith('text/') || ct.includes('json') || ct.includes('xml') || ct.includes('javascript');
  if (!isText) {
    return {
      status:     data.status,
      statusText: data.statusText,
      headers:    respHeaders,
      body:       null,
      bodyType:   'binary',
      elapsed,
      size:       bytes.length,
    };
  }

  let text     = new TextDecoder('utf-8').decode(bytes);
  let bodyType = 'text';
  let bodyJson;

  if (ct.includes('json')) {
    const parsed = await parseJsonOffMainThread(text);
    if (parsed) { text = parsed.pretty; bodyJson = parsed.value; bodyType = 'json'; }
  }

  return {
    status:     data.status,
    statusText: data.statusText,
    headers:    respHeaders,
    body:       text,
    bodyJson,
    bodyType,
    elapsed,
    size:       bytes.length,
  };
}

// ─── Pre-request / test script sandbox (`pm` API) ─────────────────────────────

// Run user script code with a `pm` global. Uses `new Function` — acceptable
// given Salvo's local-first, single-user trust model (the script author is
// the same person running the server).
function runScript(code, pm) {
  const fn = new Function('pm', code);
  fn(pm);
}

// Build the `pm` object exposed to pre-request/test scripts. `resp` is the
// parsed response (null for pre-request scripts).
function buildPmApi(req, resp) {
  const env = state.envs.find(e => e.id === state.activeEnv);
  const testResults = [];

  const pm = {
    environment: {
      get: key => env?.vars.find(v => v.key === key && v.enabled)?.value,
      set: (key, value) => {
        if (!env) return;
        const existing = env.vars.find(v => v.key === key);
        if (existing) existing.value = String(value);
        else env.vars.push({ id: uid(), key, value: String(value), enabled: true });
      },
      unset: key => {
        if (!env) return;
        env.vars = env.vars.filter(v => v.key !== key);
      },
    },
    globals: {
      get: key => state.globals.find(v => v.key === key && v.enabled)?.value,
      set: (key, value) => {
        const existing = state.globals.find(v => v.key === key);
        if (existing) existing.value = String(value);
        else state.globals.push({ id: uid(), key, value: String(value), enabled: true });
      },
      unset: key => {
        state.globals = state.globals.filter(v => v.key !== key);
      },
    },
    iterationData: {
      get: key => state.runner?.currentRow?.[key],
    },
    test(name, fn) {
      try {
        fn();
        testResults.push({ name, passed: true });
      } catch (e) {
        testResults.push({ name, passed: false, error: e.message });
      }
    },
    expect: makeExpectation,
  };

  if (resp) {
    pm.response = {
      status:       resp.status,
      statusText:   resp.statusText,
      headers:      resp.headers,
      responseTime: resp.elapsed,
      json:  () => resp.bodyJson !== undefined ? resp.bodyJson : JSON.parse(resp.body),
      text:  () => resp.body,
    };
  }

  return { pm, testResults };
}

// Minimal Chai-style assertion builder for `pm.expect(value)`.
function makeExpectation(actual) {
  const stringify = v => { try { return JSON.stringify(v); } catch { return String(v); } };
  const assertCheck = (pass, msg) => { if (!pass) throw new Error(msg); };

  const build = negate => ({
    get not() { return build(!negate); },
    toBe(expected) {
      assertCheck((actual === expected) !== negate,
        `expected ${stringify(actual)}${negate ? ' not' : ''} to be ${stringify(expected)}`);
    },
    toEqual(expected) {
      assertCheck((JSON.stringify(actual) === JSON.stringify(expected)) !== negate,
        `expected ${stringify(actual)}${negate ? ' not' : ''} to equal ${stringify(expected)}`);
    },
    toBeTruthy() {
      assertCheck((!!actual) !== negate, `expected ${stringify(actual)}${negate ? ' not' : ''} to be truthy`);
    },
    toBeFalsy() {
      assertCheck((!actual) !== negate, `expected ${stringify(actual)}${negate ? ' not' : ''} to be falsy`);
    },
    toBeDefined() {
      assertCheck((actual !== undefined) !== negate, `expected value${negate ? ' not' : ''} to be defined`);
    },
    toBeNull() {
      assertCheck((actual === null) !== negate, `expected ${stringify(actual)}${negate ? ' not' : ''} to be null`);
    },
    toContain(expected) {
      assertCheck((actual != null && actual.includes(expected)) !== negate,
        `expected ${stringify(actual)}${negate ? ' not' : ''} to contain ${stringify(expected)}`);
    },
    toHaveProperty(key) {
      assertCheck((actual != null && Object.prototype.hasOwnProperty.call(actual, key)) !== negate,
        `expected ${stringify(actual)}${negate ? ' not' : ''} to have property "${key}"`);
    },
    toBeGreaterThan(n) {
      assertCheck((actual > n) !== negate, `expected ${stringify(actual)}${negate ? ' not' : ''} to be greater than ${n}`);
    },
    toBeLessThan(n) {
      assertCheck((actual < n) !== negate, `expected ${stringify(actual)}${negate ? ' not' : ''} to be less than ${n}`);
    },
  });

  return build(false);
}
