// ─── Collection Runner ─────────────────────────────────────────────────────────
// Runs every request in a collection (or a single folder) sequentially,
// reusing the same buildRequestArgs/proxy/buildPmApi/runScript pipeline as
// sendRequest(), but headless (no tab/DOM updates). Progress and per-request
// results are tracked in state.runner and shown in the runner modal.
//
// A "setup" step lets the user optionally attach a CSV/JSON data file —
// when present, the whole request list runs once per row, with each row's
// columns available as {{variables}} (interp() and pm.iterationData.get()
// both consult state.runner.currentRow, see js/state.js / js/send.js).

function collectRunnerRequests(col) {
  return [...col.requests, ...col.folders.flatMap(f => f.requests)];
}

function runCollection(colId) {
  const col = state.cols.find(c => c.id === colId);
  if (!col) return;
  openRunnerSetup(col.name, collectRunnerRequests(col));
}

function runFolder(colId, folderId) {
  const col    = state.cols.find(c => c.id === colId);
  const folder = col?.folders.find(f => f.id === folderId);
  if (!folder) return;
  openRunnerSetup(folder.name, folder.requests);
}

function stopRunner() {
  if (state.runner) state.runner.stopRequested = true;
}

// ─── Setup step ─────────────────────────────────────────────────────────────────

function openRunnerSetup(label, requests) {
  state.runner = {
    label, requests,
    setup:         true,
    running:       false,
    stopRequested: false,
    dataRows:      null,
    dataFileName:  '',
    currentRow:    null,
    total:         requests.length,
    completed:     0,
    results:       [],
  };
  openRunnerModal();
  renderRunnerModal();
}

function onRunnerDataFile(input) {
  const file = input.files?.[0];
  if (!file || !state.runner) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      state.runner.dataRows     = parseRunnerDataFile(String(reader.result), file.name);
      state.runner.dataFileName = file.name;
    } catch (e) {
      notify(`Failed to parse data file: ${e.message}`, 'error');
      state.runner.dataRows     = null;
      state.runner.dataFileName = '';
      input.value = '';
    }
    renderRunnerModal();
  };
  reader.readAsText(file);
}

function parseRunnerDataFile(text, filename) {
  if (filename.toLowerCase().endsWith('.json')) {
    const data = JSON.parse(text);
    if (!Array.isArray(data)) throw new Error('JSON data file must be an array of objects');
    return data;
  }
  return parseCsv(text);
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const cells = parseCsvLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    return row;
  });
}

function parseCsvLine(line) {
  const cells = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      cells.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  return cells;
}

// ─── Run ──────────────────────────────────────────────────────────────────────

async function startRunnerRun() {
  const r = state.runner;
  if (!r) return;
  const rows = r.dataRows && r.dataRows.length ? r.dataRows : [null];

  r.setup     = false;
  r.running   = true;
  r.stopRequested = false;
  r.total     = r.requests.length * rows.length;
  r.completed = 0;
  r.results   = [];
  renderRunnerModal();

  outer:
  for (let i = 0; i < rows.length; i++) {
    r.currentRow = rows[i];
    for (const req of r.requests) {
      if (r.stopRequested) break outer;
      const result = await runSingleRequest(req);
      if (rows.length > 1) result.iteration = i + 1;
      r.results.push(result);
      r.completed++;
      renderRunnerModal();
    }
  }
  r.currentRow = null;

  r.running = false;
  renderRunnerModal();
  if (state.showHist) renderHistPanel();
  scheduleDiskSave();
}

// Headless equivalent of sendRequest() — runs pre-request/test scripts and the
// proxied request for a single saved request, without touching any open tab.
async function runSingleRequest(reqOrig) {
  const req   = clone(reqOrig);
  const start = Date.now();
  const result = {
    name: req.name, method: req.method, url: req.url,
    status: null, statusText: '', elapsed: 0, error: null, tests: null,
  };

  try {
    if (req.preRequestScript?.trim()) {
      try {
        runScript(req.preRequestScript, buildPmApi(req, null).pm);
      } catch (e) {
        throw new Error(`Pre-request script error: ${e.message}`);
      }
    }

    const { url: builtUrl, headers, bodyKind, bodyPayload, digestAuth } = await buildRequestArgs(req);
    result.url = builtUrl;

    const proxyRes = await fetch('/api/proxy', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ url: builtUrl, method: req.method, headers, bodyKind, body: bodyPayload, digestAuth }),
    });

    const data = await proxyRes.json();
    if (!data.ok) throw new Error(data.error);

    const elapsed = Date.now() - start;
    const resp = await parseResponse(data, elapsed);
    result.status     = resp.status;
    result.statusText = resp.statusText;
    result.elapsed    = elapsed;

    state.hist.push({ method: req.method, url: builtUrl, status: data.status, elapsed });

    if (req.testScript?.trim()) {
      const { pm, testResults } = buildPmApi(req, resp);
      try {
        runScript(req.testScript, pm);
      } catch (e) {
        testResults.push({ name: 'Test script error', passed: false, error: e.message });
      }
      result.tests = testResults;
    }
  } catch (err) {
    result.elapsed = Date.now() - start;
    result.error = err.message;
  }

  return result;
}

// Headless equivalent of startRunnerRun() — runs every request once per data
// row (or once if `dataRows` is empty/null) via runSingleRequest(), without
// touching state.runner or the modal. Used by cli.js. Returns the flat array
// of per-request results (with `.iteration` set when dataRows has >1 row).
async function runRequestsHeadless(requests, dataRows) {
  const rows = dataRows && dataRows.length ? dataRows : [null];
  const results = [];

  for (let i = 0; i < rows.length; i++) {
    state.runner = { currentRow: rows[i] };
    for (const req of requests) {
      const result = await runSingleRequest(req);
      if (rows.length > 1) result.iteration = i + 1;
      results.push(result);
    }
  }

  state.runner = null;
  return results;
}

// ─── Runner Modal ───────────────────────────────────────────────────────────────

function openRunnerModal() {
  document.getElementById('runner-modal').style.display = 'flex';
}

function closeRunnerModal() {
  document.getElementById('runner-modal').style.display = 'none';
  document.getElementById('runner-data-file').value = '';
  state.runner = null;
}

function renderRunnerModal() {
  const r = state.runner;
  if (!r) return;

  document.getElementById('runner-title').textContent = `Run: ${r.label}`;
  document.getElementById('runner-setup').style.display     = r.setup ? '' : 'none';
  document.getElementById('runner-start-btn').style.display = r.setup ? '' : 'none';
  document.getElementById('runner-stop-btn').style.display  = (!r.setup && r.running) ? '' : 'none';

  document.getElementById('runner-data-info').textContent = r.dataRows
    ? `${r.dataFileName}: ${r.dataRows.length} row(s) — collection will run once per row`
    : '';

  if (r.setup) {
    document.getElementById('runner-summary').textContent = '';
    document.getElementById('runner-results').innerHTML = '';
    return;
  }

  document.getElementById('runner-summary').textContent =
    `${r.completed} / ${r.total} requests` + (r.running ? ' — running…' : ' — done');

  document.getElementById('runner-results').innerHTML = r.results.map(res => {
    const statusClass = res.error ? 'danger'
      : (res.status >= 200 && res.status < 400) ? 'success' : 'warning';
    const statusLabel = res.error ? 'Error' : `${res.status} ${esc(res.statusText || '')}`.trim();

    let testsHtml = '';
    if (res.tests) {
      const passed = res.tests.filter(t => t.passed).length;
      testsHtml = `<span class="runner-tests ${passed === res.tests.length ? 'success' : 'danger'}">${passed}/${res.tests.length} tests</span>`;
    }

    const namePrefix = res.iteration ? `[#${res.iteration}] ` : '';

    return `
      <div class="runner-item" title="${esc(res.error || res.url || '')}">
        <span class="runner-method" style="color:${MC[res.method] || 'var(--text)'}">${esc(res.method)}</span>
        <span class="runner-name">${esc(namePrefix + res.name)}</span>
        <span class="runner-status ${statusClass}">${statusLabel}</span>
        <span class="runner-time">${res.elapsed}ms</span>
        ${testsHtml}
      </div>`;
  }).join('');
}
