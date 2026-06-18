// ─── Server Log Viewer ────────────────────────────────────────────────────────

let _logsSse        = null;
let _logsAutoScroll = true;

function openLogsModal() {
  _logsAutoScroll = true;
  document.getElementById('logs-modal').style.display = 'flex';
  _connectLogsSse();
}

function closeLogsModal() {
  document.getElementById('logs-modal').style.display = 'none';
  if (_logsSse) { _logsSse.close(); _logsSse = null; }
}

function _connectLogsSse() {
  if (_logsSse) { _logsSse.close(); _logsSse = null; }
  const output = document.getElementById('logs-output');
  output.innerHTML = '';

  _logsSse = new EventSource('/api/logs/stream');

  _logsSse.onmessage = e => {
    const line = JSON.parse(e.data);
    const div  = document.createElement('div');
    div.className = 'logs-line'
      + (line.includes('[ERROR]') ? ' logs-error'
       : line.includes('[WARN]')  ? ' logs-warn'  : '');
    div.textContent = line;
    output.appendChild(div);
    if (_logsAutoScroll) output.scrollTop = output.scrollHeight;
  };

  output.addEventListener('scroll', _onLogsScroll, { passive: true });
}

function _onLogsScroll() {
  const output  = document.getElementById('logs-output');
  if (!output) return;
  const atBottom = output.scrollTop + output.clientHeight >= output.scrollHeight - 24;
  _logsAutoScroll = atBottom;
}
