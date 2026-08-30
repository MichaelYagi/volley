// Shared chrome for every docs page: renders the sidebar nav from one list
// (so adding/renaming a guide means editing this file, not 17 of them),
// highlights the current page, and a theme toggle (own localStorage key —
// this site is a different origin than the app, so it can't read
// volley-theme). No build step, same as the app itself.

const GUIDES = [
  { href: 'guides/getting-started.html',           label: 'Getting Started' },
  { href: 'guides/data-storage.html',               label: 'Data Storage' },
  { href: 'guides/environment-variables.html',      label: 'Environment Variables' },
  { href: 'guides/request-editing.html',            label: 'Request Editing' },
  { href: 'guides/auth-types.html',                 label: 'Auth Types' },
  { href: 'guides/realtime-protocols.html',         label: 'Realtime & Streaming' },
  { href: 'guides/scripts-and-testing.html',        label: 'Scripts & Tests' },
  { href: 'guides/collection-runner.html',          label: 'Collection Runner & CLI' },
  { href: 'guides/monitors.html',                   label: 'Monitors' },
  { href: 'guides/mock-server.html',                label: 'Mock Server' },
  { href: 'guides/cookie-jar.html',                 label: 'Cookie Jar' },
  { href: 'guides/webhooks.html',                   label: 'Webhooks' },
  { href: 'guides/api-documentation.html',          label: 'API Documentation' },
  { href: 'guides/tabs-and-changes.html',           label: 'Tabs & Changes Panel' },
  { href: 'guides/export-import.html',              label: 'Export / Import' },
  { href: 'guides/git-sync.html',                   label: 'Git Sync' },
  { href: 'guides/log-viewer-and-settings.html',    label: 'Log Viewer & Settings' },
  { href: 'guides/testing.html',                    label: 'Testing & Development' },
];

function docsRoot() {
  return location.pathname.includes('/guides/') ? '../' : '';
}

function renderDocsTopbar() {
  const root = docsRoot();
  const el = document.getElementById('docs-topbar');
  if (!el) return;
  el.innerHTML = `
    <button id="docs-nav-toggle" aria-label="Toggle navigation">☰</button>
    <a href="${root}index.html" style="display:flex;align-items:center;gap:8px;text-decoration:none">
      <img src="${root}favicon.svg" alt="">
      <span class="brand">Volley Docs</span>
    </a>
    <span class="sep"></span>
    <a class="tb-link" href="https://github.com/MichaelYagi/volley" target="_blank" rel="noopener">GitHub</a>
    <a class="tb-link" href="https://www.npmjs.com/package/@michaelyagi/volley" target="_blank" rel="noopener">npm</a>
    <button id="docs-theme-toggle" aria-label="Toggle theme"></button>
  `;
  document.getElementById('docs-nav-toggle').onclick = () => {
    document.getElementById('docs-nav').classList.toggle('open');
  };
  document.getElementById('docs-theme-toggle').onclick = toggleDocsTheme;
}

function renderDocsNav() {
  const nav = document.getElementById('docs-nav');
  if (!nav) return;
  const root = docsRoot();
  const here = location.pathname.split('/').pop();
  nav.innerHTML = `
    <div class="nav-section">Guides</div>
    ${GUIDES.map(g => {
      const file = g.href.split('/').pop();
      const active = file === here ? ' active' : '';
      return `<a class="${active.trim()}" href="${root}${g.href}">${g.label}</a>`;
    }).join('')}
  `;
}

function currentDocsTheme() {
  return localStorage.getItem('volley-docs-theme') || 'dark';
}

function applyDocsTheme(theme) {
  document.documentElement.setAttribute('data-doc-theme', theme);
  const btn = document.getElementById('docs-theme-toggle');
  if (btn) btn.textContent = theme === 'dark' ? '☾' : '☀';
}

function toggleDocsTheme() {
  const next = currentDocsTheme() === 'dark' ? 'light' : 'dark';
  localStorage.setItem('volley-docs-theme', next);
  applyDocsTheme(next);
}

applyDocsTheme(currentDocsTheme());
document.addEventListener('DOMContentLoaded', () => {
  renderDocsTopbar();
  renderDocsNav();
  applyDocsTheme(currentDocsTheme());
});
