/**
 * Выбор акцентного цвета интерфейса — независимо от авторизации.
 *
 * Хранится в localStorage (НЕ sessionStorage) — принципиальный момент:
 * sessionStorage чистится при обычном выходе и при автовыходе по
 * неактивности (см. portal.js/station.js), а localStorage переживает и
 * то, и другое, и виден уже на экране блокировки, до ввода пароля.
 * Именно это нужно для заявленной цели — визуально различать несколько
 * поднятых серверов по разным вкладкам браузера ещё до входа в каждый.
 *
 * localStorage к тому же изначально скопирован по origin (домен/IP:порт) —
 * то есть каждый сервер и так хранит свой выбор отдельно, без какого-либо
 * дополнительного кода для этого.
 *
 * Меняется только акцентная пара (--amber/--amber-dim) — семантические
 * цвета статусов (--green-live "в эфире", --red-alert "тревога/удаление")
 * не трогаются: это разные по смыслу цвета, а не часть бренд-темы.
 */

const THEME_COLORS = [
  { name: 'Amber',      accent: '#ffb000', dim: '#7a5500' },
  { name: 'Orange',     accent: '#ff9142', dim: '#7a4419' },
  { name: 'Vermilion',  accent: '#ff6b52', dim: '#7a2f1f' },
  { name: 'Rose',       accent: '#ff5c93', dim: '#7a1f42' },
  { name: 'Magenta',    accent: '#e35cff', dim: '#5c1f7a' },
  { name: 'Violet',     accent: '#a374ff', dim: '#3f2b7a' },
  { name: 'Indigo',     accent: '#7c93ff', dim: '#2b357a' },
  { name: 'Sky Blue',   accent: '#4dabf7', dim: '#1a4a7a' },
  { name: 'Cyan',       accent: '#22d3ee', dim: '#0d5f6b' },
  { name: 'Teal',       accent: '#2dd4bf', dim: '#0d5f52' },
  { name: 'Lime',       accent: '#a3e635', dim: '#4a5f13' },
  { name: 'Gold',       accent: '#ffd93d', dim: '#7a6413' },
];

const THEME_STORAGE_KEY = 'radioDeckThemeColor';

function getSavedThemeIndex() {
  const raw = localStorage.getItem(THEME_STORAGE_KEY);
  const idx = raw !== null ? parseInt(raw, 10) : 0;
  return Number.isInteger(idx) && idx >= 0 && idx < THEME_COLORS.length ? idx : 0;
}

function applyTheme(index) {
  const theme = THEME_COLORS[index] || THEME_COLORS[0];
  document.documentElement.style.setProperty('--amber', theme.accent);
  document.documentElement.style.setProperty('--amber-dim', theme.dim);
}

function setTheme(index) {
  localStorage.setItem(THEME_STORAGE_KEY, String(index));
  applyTheme(index);
  document.querySelectorAll('.theme-picker').forEach((picker) => {
    picker.querySelectorAll('.theme-swatch').forEach((el, i) => {
      el.classList.toggle('active', i === index);
    });
  });
}

/**
 * Рисует ряд кружков-образцов внутрь указанного контейнера (по id) и
 * навешивает обработчики клика. Можно вызывать для нескольких контейнеров
 * сразу (экран блокировки + настройки внутри приложения) — все они будут
 * оставаться синхronизированы между собой через setTheme() выше.
 */
function renderThemePicker(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const currentIndex = getSavedThemeIndex();
  container.className = 'theme-picker';
  container.innerHTML = THEME_COLORS.map((theme, i) => `
    <span
      class="theme-swatch${i === currentIndex ? ' active' : ''}"
      style="background: linear-gradient(135deg, ${theme.accent}, ${theme.dim})"
      title="${theme.name}"
      data-index="${i}"
    ></span>
  `).join('');

  container.querySelectorAll('.theme-swatch').forEach((el) => {
    el.addEventListener('click', () => setTheme(parseInt(el.dataset.index, 10)));
  });
}

// Применяем СРАЗУ при загрузке скрипта — до отрисовки контента страницы,
// чтобы не было эффекта "мигания" дефолтным amber перед сменой на
// сохранённый цвет
applyTheme(getSavedThemeIndex());
