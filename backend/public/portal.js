const state = {
  password: sessionStorage.getItem('portalPassword') || null,
  globalPort: null,
  nowPlaying: {}, // slug -> {online, title, listeners}
  libraryStats: {}, // slug -> {count, totalDurationSeconds}
};

// ---------- Авторизация ----------

const lockScreen = document.getElementById('lockScreen');
const app = document.getElementById('app');

async function tryUnlock(password) {
  const res = await fetch('/api/portal/stations', {
    headers: { 'X-Portal-Password': password },
  });
  if (res.ok) {
    state.password = password;
    sessionStorage.setItem('portalPassword', password);
    lockScreen.classList.add('hidden');
    app.classList.remove('hidden');
    initApp();
    return true;
  }
  return false;
}

document.getElementById('unlockBtn').addEventListener('click', async () => {
  const pwd = document.getElementById('passwordInput').value;
  const ok = await tryUnlock(pwd);
  if (!ok) {
    document.getElementById('lockError').textContent = 'Неверный пароль';
  }
});
document.getElementById('passwordInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('unlockBtn').click();
});

if (state.password) {
  tryUnlock(state.password);
}

// ---------- Общий помощник для запросов ----------

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      ...(options.headers || {}),
      'X-Portal-Password': state.password,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка запроса ${path}`);
  return data;
}

function initApp() {
  loadGlobal();
  loadStations();
  loadStatus();
  loadSystemStats();
  loadNowPlaying();
  loadLibraryStats();
  setInterval(loadStatus, 15000);
  setInterval(loadSystemStats, 10000);
  setInterval(loadNowPlaying, 10000);
  // Библиотека меняется редко (загрузка/удаление файлов) — обновляем раз в минуту,
  // не гоняем ffprobe по всем станциям с той же частотой, что "сейчас играет"
  setInterval(loadLibraryStats, 60000);
}

// ---------- Глобальные настройки движка ----------

async function loadGlobal() {
  try {
    const g = await api('/api/portal/global');
    document.getElementById('globalPortInput').value = g.port;
    state.globalPort = g.port;
  } catch (err) {
    console.error(err);
  }
}

document.getElementById('saveGlobalBtn').addEventListener('click', async () => {
  const msg = document.getElementById('saveGlobalMsg');
  msg.textContent = 'Сохранение...';
  try {
    const port = Number(document.getElementById('globalPortInput').value);
    const sourcePassword = document.getElementById('globalSourcePasswordInput').value;
    const body = { port };
    if (sourcePassword) body.sourcePassword = sourcePassword;

    await api('/api/portal/global', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    document.getElementById('globalSourcePasswordInput').value = '';
    state.globalPort = port;
    msg.textContent = 'Сохранено. Перезапустите движок для применения.';
    loadStations();
  } catch (err) {
    msg.textContent = `Ошибка: ${err.message}`;
  }
});

// ---------- Системный монитор ----------

async function loadSystemStats() {
  try {
    const s = await api('/api/portal/system-stats');
    renderMeter('cpu', s.cpu.percent, `${s.cpu.percent}%`);
    renderMeter('ram', s.memory.percent, `${s.memory.usedMb} / ${s.memory.totalMb} МБ`);

    if (s.disk.error) {
      document.getElementById('diskLabel').textContent = 'н/д';
      document.getElementById('diskPathLabel').textContent = s.disk.path;
    } else {
      renderMeter('disk', s.disk.percent, `${s.disk.usedGb} / ${s.disk.totalGb} ГБ`);
      document.getElementById('diskPathLabel').textContent = s.disk.path;
    }

    document.getElementById('uptimeLabel').textContent = `Аптайм сервера: ${formatUptime(s.uptimeSeconds)}`;
  } catch (err) {
    console.error(err);
  }
}

function renderMeter(prefix, percent, label) {
  const labelEl = document.getElementById(prefix === 'cpu' ? 'cpuPercentLabel' : `${prefix}Label`);
  if (labelEl) labelEl.textContent = label;

  const fill = document.getElementById(`${prefix}MeterFill`);
  if (!fill) return;
  fill.style.width = `${Math.min(100, percent)}%`;
  fill.classList.remove('meter-warn', 'meter-crit');
  if (percent >= 90) fill.classList.add('meter-crit');
  else if (percent >= 70) fill.classList.add('meter-warn');
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} дн. ${hours} ч.`;
  if (hours > 0) return `${hours} ч. ${mins} мин.`;
  return `${mins} мин.`;
}

// ---------- Транспорт / статус ----------

document.getElementById('restartBtn').addEventListener('click', async () => {
  if (!confirm('Перезапустить движок? Все станции портала прервутся на несколько секунд.')) return;
  const msg = document.getElementById('restartMsg');
  msg.textContent = 'Перезапуск...';
  try {
    await api('/api/portal/restart', { method: 'POST' });
    msg.textContent = 'Готово.';
    setTimeout(loadStatus, 2000);
  } catch (err) {
    msg.textContent = `Ошибка: ${err.message}`;
  }
});

document.getElementById('refreshStatusBtn').addEventListener('click', loadStatus);

async function loadStatus() {
  try {
    const s = await api('/api/portal/status');
    renderStatus('statusLiquidsoap', s.liquidsoap);
    renderStatus('statusIcecast', s.icecast);
    document.getElementById('onAirDot').classList.toggle('live', !!s.liquidsoap);
  } catch (err) {
    console.error(err);
  }
}

function renderStatus(elId, value) {
  const el = document.getElementById(elId);
  el.classList.remove('status-on', 'status-off', 'status-unknown');
  if (value === true) {
    el.textContent = 'ON AIR';
    el.classList.add('status-on');
  } else if (value === false) {
    el.textContent = 'OFFLINE';
    el.classList.add('status-off');
  } else {
    el.textContent = 'N/A';
    el.classList.add('status-unknown');
  }
}

async function loadNowPlaying() {
  try {
    const data = await api('/api/portal/now-playing');
    data.stations.forEach((s) => { state.nowPlaying[s.slug] = s; });
    applyNowPlayingToCards();
  } catch (err) {
    console.error(err);
  }
}

function applyNowPlayingToCards() {
  document.querySelectorAll('.station-card').forEach((card) => {
    const slug = card.dataset.slug;
    const info = state.nowPlaying[slug];
    if (!info) return;

    const dot = card.querySelector('.station-live-dot');
    const nowPlayingEl = card.querySelector('.station-now-playing');
    if (dot) {
      dot.classList.toggle('live-on', info.online);
      dot.classList.toggle('live-off', !info.online);
    }
    if (nowPlayingEl) {
      nowPlayingEl.textContent = info.online
        ? (info.title ? info.title : 'в эфире')
        : 'офлайн';
    }
  });
}

// ---------- Статистика медиатеки (кол-во треков + суммарная длительность) ----------

async function loadLibraryStats() {
  try {
    const data = await api('/api/portal/library-stats');
    data.stats.forEach((s) => { state.libraryStats[s.slug] = s; });
    applyLibraryStatsToCards();
  } catch (err) {
    console.error(err);
  }
}

function applyLibraryStatsToCards() {
  document.querySelectorAll('.station-card').forEach((card) => {
    const slug = card.dataset.slug;
    const stats = state.libraryStats[slug];
    const el = card.querySelector('.station-library-stats');
    if (!el) return;

    if (!stats) {
      el.textContent = '—';
    } else if (stats.count === 0) {
      el.textContent = 'медиатека пуста';
    } else {
      el.textContent = `${stats.count} треков · ${formatDuration(stats.totalDurationSeconds)}`;
    }
  });
}

function formatDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// ---------- Список станций ----------

async function loadStations() {
  const grid = document.getElementById('stationGrid');
  try {
    const data = await api('/api/portal/stations');
    document.getElementById('stationCount').textContent = `${data.stations.length} станций на портале`;

    if (data.stations.length === 0) {
      grid.innerHTML = '<p class="hint">Станций пока нет — создайте первую.</p>';
      return;
    }

    grid.innerHTML = data.stations.map((s) => `
      <div class="station-card" data-slug="${escapeHtml(s.slug)}">
        <div class="station-card-header">
          <span class="station-card-name">${escapeHtml(s.name)}</span>
          <span class="station-card-mode">${s.mode === 'random' ? 'случайный' : 'по порядку'}</span>
        </div>
        <div class="station-live-row">
          <span class="station-live-dot"></span>
          <span class="station-now-playing">—</span>
        </div>
        <div class="station-card-url">${window.location.hostname}:${state.globalPort || '—'}/${escapeHtml(s.mount)}</div>
        <div class="station-card-meta">
          <span>${s.bitrate} кбит/с</span>
          <span class="station-library-stats">—</span>
        </div>
        <div class="station-card-actions">
          <a class="btn-secondary" href="/station/${encodeURIComponent(s.slug)}">Открыть админку</a>
          <button class="track-action station-delete" data-id="${escapeHtml(s.id)}" data-name="${escapeHtml(s.name)}" title="Удалить станцию">✕</button>
        </div>
      </div>
    `).join('');

    grid.querySelectorAll('.station-delete').forEach((btn) => {
      btn.addEventListener('click', () => deleteStation(btn.dataset.id, btn.dataset.name));
    });
    applyNowPlayingToCards();
    applyLibraryStatsToCards();
  } catch (err) {
    grid.innerHTML = `<p class="hint">Ошибка: ${escapeHtml(err.message)}</p>`;
  }
}

async function deleteStation(id, name) {
  if (!confirm(`Удалить станцию «${name}»? Это действие необратимо.`)) return;
  const deleteMedia = confirm('Также удалить все файлы медиатеки этой станции?\n\nОК — удалить файлы, Отмена — оставить файлы на диске.');

  try {
    await api(`/api/portal/stations/${encodeURIComponent(id)}?deleteMedia=${deleteMedia ? '1' : '0'}`, {
      method: 'DELETE',
    });
    loadStations();
  } catch (err) {
    alert(`Ошибка удаления: ${err.message}`);
  }
}

// ---------- Создание станции ----------

const createModal = document.getElementById('createModal');
const newBitrateSegmented = document.getElementById('newBitrateSegmented');
const newModeSegmented = document.getElementById('newModeSegmented');
let newBitrate = 128;
let newMode = 'normal';

newBitrateSegmented.addEventListener('click', (e) => {
  if (e.target.tagName !== 'BUTTON') return;
  setActiveSegment(newBitrateSegmented, e.target.dataset.value);
  newBitrate = Number(e.target.dataset.value);
});
newModeSegmented.addEventListener('click', (e) => {
  if (e.target.tagName !== 'BUTTON') return;
  setActiveSegment(newModeSegmented, e.target.dataset.value);
  newMode = e.target.dataset.value;
});

function setActiveSegment(container, value) {
  [...container.children].forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === value);
  });
}

document.getElementById('createStationBtn').addEventListener('click', () => {
  document.getElementById('newStationName').value = '';
  document.getElementById('newStationMount').value = '';
  document.getElementById('newStationPassword').value = '';
  document.getElementById('createStationMsg').textContent = '';
  createModal.classList.remove('hidden');
});
document.getElementById('createStationCancelBtn').addEventListener('click', () => {
  createModal.classList.add('hidden');
});
createModal.addEventListener('click', (e) => {
  if (e.target === createModal) createModal.classList.add('hidden');
});

document.getElementById('createStationSubmitBtn').addEventListener('click', async () => {
  const msg = document.getElementById('createStationMsg');
  const name = document.getElementById('newStationName').value.trim();
  const mount = document.getElementById('newStationMount').value.trim();
  const password = document.getElementById('newStationPassword').value;

  if (!name) { msg.textContent = 'Укажите название станции'; return; }
  if (!password || password.length < 4) { msg.textContent = 'Пароль — минимум 4 символа'; return; }

  msg.textContent = 'Создание...';
  try {
    await api('/api/portal/stations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mount: mount || undefined, bitrate: newBitrate, mode: newMode, password }),
    });
    createModal.classList.add('hidden');
    loadStations();
  } catch (err) {
    msg.textContent = `Ошибка: ${err.message}`;
  }
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
