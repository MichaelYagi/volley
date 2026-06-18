// ─── Color Themes ───────────────────────────────────────────────────────────
// Theme choice is a per-device UI preference (localStorage), not synced via
// /api/save. Applying a theme just sets `data-theme` on <html> — see
// css/themes.css for the actual variable definitions. To add a theme, add a
// `[data-theme="..."]` block there and an entry here.
const THEMES = [
  { id: 'dark',  name: 'Dark',  swatch: ['#0d1117', '#58a6ff', '#c9d1d9'] },
  { id: 'light', name: 'Light', swatch: ['#ffffff', '#0969da', '#1f2328'] },
  { id: 'nord',  name: 'Nord',  swatch: ['#2e3440', '#88c0d0', '#d8dee9'] },
  { id: 'carnival',     name: 'Carnival',     swatch: ['#1a1025', '#ffb627', '#ede4f5'] },
  { id: 'garbagefire', name: 'Garbagefire', swatch: ['#ffff00', '#ff00ff', '#0000ff'] },
];

function getTheme() {
  return localStorage.getItem('salvo-theme') || 'dark';
}

function applyTheme(id) {
  document.documentElement.setAttribute('data-theme', id);
  localStorage.setItem('salvo-theme', id);
  renderThemePicker();
}

function themeSwatchHTML(colors) {
  return `<span class="theme-swatch">${colors.map(c => `<span style="background:${c}"></span>`).join('')}</span>`;
}

function renderThemePicker() {
  const current = getTheme();
  const theme   = THEMES.find(t => t.id === current) || THEMES[0];

  document.getElementById('theme-picker-btn').innerHTML = themeSwatchHTML(theme.swatch);

  document.getElementById('theme-menu').innerHTML = THEMES.map(t => `
    <button class="theme-option ${t.id === current ? 'active' : ''}" onclick="applyTheme('${t.id}');toggleThemeMenu(false)">
      ${themeSwatchHTML(t.swatch)}
      <span>${esc(t.name)}</span>
    </button>`).join('');
}

function toggleThemeMenu(force) {
  const menu = document.getElementById('theme-menu');
  const show = typeof force === 'boolean' ? force : menu.style.display === 'none';
  menu.style.display = show ? 'block' : 'none';
}

document.addEventListener('click', e => {
  if (!e.target.closest('#theme-picker')) toggleThemeMenu(false);
});

renderThemePicker();
