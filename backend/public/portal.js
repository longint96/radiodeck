const state = {
  password: sessionStorage.getItem('portalPassword') || null,
  globalPort: null,
  nowPlaying: {}, // slug -> {online, title, listeners}
  libraryStats: {}, // slug -> {count, totalDurationSeconds}
  stations: [], // текущий список станций — нужен диаграмме слушателей
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
    document.getElementById('mediaPathInput').value = g.mediaBaseDir || '';
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

// ---------- Путь к медиатеке ----------

document.getElementById('saveMediaPathBtn').addEventListener('click', async () => {
  const msg = document.getElementById('saveMediaPathMsg');
  const reportEl = document.getElementById('mediaMoveReport');
  const newPath = document.getElementById('mediaPathInput').value.trim();

  if (!newPath || !newPath.startsWith('/')) {
    msg.textContent = 'Путь должен быть абсолютным (начинаться с /)';
    return;
  }

  if (!confirm(
    `Сменить путь к медиатеке на:\n${newPath}\n\n` +
    `Папки ВСЕХ станций будут перенесены на новое место (не скопированы —\n` +
    `перенесены, исходные папки удалятся). Движок вещания будет автоматически\n` +
    `перезапущен сразу после переноса. Продолжить?`
  )) {
    return;
  }

  const typed = prompt('Подтвердите — наберите слово ПЕРЕНЕСТИ:');
  if (typed !== 'ПЕРЕНЕСТИ') {
    msg.textContent = typed === null ? '' : 'Отменено — слово введено неверно.';
    return;
  }

  msg.textContent = 'Переношу файлы и перезапускаю движок — это может занять время...';
  reportEl.classList.add('hidden');
  try {
    const result = await api('/api/portal/media-base-dir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: newPath }),
    });

    if (!result.changed) {
      msg.textContent = 'Путь не изменился — переносить нечего.';
      return;
    }

    msg.textContent = 'Готово. Движок перезапущен.';
    reportEl.classList.remove('hidden');
    reportEl.innerHTML = `
      ${result.moved.length ? `<div>Перенесены станции: ${result.moved.join(', ')}</div>` : ''}
      ${result.errors.length ? `<div class="media-move-errors">${result.errors.map(escapeHtml).join('<br>')}</div>` : ''}
    `;
    loadSystemStats();
  } catch (err) {
    msg.textContent = `Ошибка: ${err.message}`;
  }
});

document.getElementById('fixPermissionsBtn').addEventListener('click', async () => {
  const msg = document.getElementById('fixPermissionsMsg');
  msg.textContent = 'Восстанавливаю права...';
  try {
    const result = await api('/api/portal/fix-media-permissions', { method: 'POST' });
    msg.textContent = result.output || 'Готово.';
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
    renderListenersChart();
  } catch (err) {
    console.error(err);
  }
}

/**
 * Столбчатая диаграмма текущего числа слушателей по станциям — X: названия
 * станций, Y: текущее кол-во слушателей. Рисуется на чистом HTML/CSS
 * (height в процентах), без графической библиотеки — та же дисциплина,
 * что и у VU-метров в SYSTEM MONITOR.
 */
function renderListenersChart() {
  const chart = document.getElementById('listenersChart');
  if (!chart) return;

  if (state.stations.length === 0) {
    chart.innerHTML = '<p class="hint">Станций пока нет.</p>';
    return;
  }

  const currentValues = state.stations.map((s) => state.nowPlaying[s.slug]?.listeners ?? 0);
  const peakValues = state.stations.map((s) => state.nowPlaying[s.slug]?.listenerPeak ?? 0);
  // Нормализуем оба столбца по ОБЩЕМУ максимуму (текущие и пиковые вместе) —
  // иначе столбцы current/peak по разным станциям были бы несравнимы между собой
  const maxValue = Math.max(1, ...currentValues, ...peakValues);

  chart.innerHTML = `
    <div class="listeners-chart-legend">
      <span><span class="legend-swatch legend-swatch-current"></span> сейчас</span>
      <span><span class="legend-swatch legend-swatch-peak"></span> пик с последнего рестарта</span>
    </div>
    <div class="listeners-chart-bars">
      ${state.stations.map((s, i) => {
        const current = currentValues[i];
        const peak = peakValues[i];
        const currentPct = Math.round((current / maxValue) * 100);
        const peakPct = Math.round((peak / maxValue) * 100);
        return `
          <div class="listeners-bar-col" title="${escapeHtml(s.name)}: сейчас ${current}, пик ${peak}">
            <div class="listeners-bar-group">
              <div class="listeners-bar-item">
                <div class="listeners-bar-value">${current}</div>
                <div class="listeners-bar-track">
                  <div class="listeners-bar-fill listeners-bar-fill-current" style="height: ${currentPct}%"></div>
                </div>
              </div>
              <div class="listeners-bar-item">
                <div class="listeners-bar-value listeners-bar-value-peak">${peak}</div>
                <div class="listeners-bar-track">
                  <div class="listeners-bar-fill listeners-bar-fill-peak" style="height: ${peakPct}%"></div>
                </div>
              </div>
            </div>
            <div class="listeners-bar-label">${escapeHtml(s.name)}</div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function applyNowPlayingToCards() {
  document.querySelectorAll('.station-card').forEach((card) => {
    const slug = card.dataset.slug;
    const info = state.nowPlaying[slug];
    if (!info) return;

    const dot = card.querySelector('.station-live-dot');
    const nowPlayingEl = card.querySelector('.station-now-playing');
    const listenersEl = card.querySelector('.station-listeners');
    if (dot) {
      dot.classList.toggle('live-on', info.online);
      dot.classList.toggle('live-off', !info.online);
    }
    if (nowPlayingEl) {
      nowPlayingEl.textContent = info.online
        ? (info.title ? info.title : 'в эфире')
        : 'офлайн';
    }
    if (listenersEl) {
      listenersEl.textContent = info.online && info.listeners != null
        ? `👤 ${info.listeners} сейчас · макс. ${info.listenerPeak ?? '—'}`
        : '';
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
    state.stations = data.stations;
    document.getElementById('stationCount').textContent = `${data.stations.length} станций на портале`;

    if (data.stations.length === 0) {
      grid.innerHTML = '<p class="hint">Станций пока нет — создайте первую.</p>';
      renderListenersChart();
      return;
    }

    grid.innerHTML = data.stations.map((s) => {
      const streamUrl = `http://${window.location.hostname}:${state.globalPort || '8000'}/${s.mount}`;
      return `
      <div class="station-card" data-slug="${escapeHtml(s.slug)}">
        <div class="station-card-header">
          <span class="station-card-name">${escapeHtml(s.name)}</span>
          <span class="station-card-mode">${s.mode === 'random' ? 'случайный' : 'по порядку'}</span>
        </div>
        <div class="station-live-row">
          <span class="station-live-dot"></span>
          <span class="station-now-playing">—</span>
        </div>
        <span class="station-listeners"></span>
        <a class="station-card-url" href="${escapeHtml(streamUrl)}" target="_blank" rel="noopener" title="Открыть поток">${escapeHtml(streamUrl.replace('http://', ''))}</a>
        <div class="station-card-meta">
          <span>${s.bitrate} кбит/с</span>
          <span class="station-library-stats">—</span>
        </div>
        <div class="station-card-actions">
          <a class="btn-secondary" href="/station/${encodeURIComponent(s.slug)}">Открыть админку</a>
          <button class="track-action station-delete" data-id="${escapeHtml(s.id)}" data-name="${escapeHtml(s.name)}" title="Удалить станцию">✕</button>
        </div>
      </div>
    `;
    }).join('');

    grid.querySelectorAll('.station-delete').forEach((btn) => {
      btn.addEventListener('click', () => deleteStation(btn.dataset.id, btn.dataset.name));
    });
    applyNowPlayingToCards();
    applyLibraryStatsToCards();
    renderListenersChart();
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

// ---------- Скачать плейлист (.m3u) со всеми станциями ----------

document.getElementById('downloadPlaylistBtn').addEventListener('click', async () => {
  const btn = document.getElementById('downloadPlaylistBtn');
  const originalText = btn.textContent;
  btn.textContent = 'Формирую...';
  btn.disabled = true;

  try {
    const data = await api('/api/portal/stations');
    if (data.stations.length === 0) {
      alert('Станций пока нет — плейлист будет пустым, сначала создайте хотя бы одну.');
    }

    const port = state.globalPort || '8000';
    const lines = ['#EXTM3U'];
    data.stations.forEach((s) => {
      const url = `http://${window.location.hostname}:${port}/${s.mount}`;
      lines.push(`#EXTINF:-1,${s.name}`);
      lines.push('#EXTVLCOPT:network-caching=1000');
      lines.push(url);
    });

    const blob = new Blob([lines.join('\n') + '\n'], { type: 'audio/x-mpegurl' });
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = 'radio-deck.m3u';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  } catch (err) {
    alert(`Ошибка формирования плейлиста: ${err.message}`);
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
});

document.getElementById('createStationBtn').addEventListener('click', () => {
  document.getElementById('newStationName').value = '';
  document.getElementById('newStationMount').value = '';
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

  if (!name) { msg.textContent = 'Укажите название станции'; return; }

  msg.textContent = 'Создание...';
  try {
    await api('/api/portal/stations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mount: mount || undefined, bitrate: newBitrate, mode: newMode }),
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
