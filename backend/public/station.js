// Слаг станции берём из пути /station/<slug>
const STATION_SLUG = decodeURIComponent(window.location.pathname.split('/').filter(Boolean)[1] || '');
const API_BASE = `/api/stations/${encodeURIComponent(STATION_SLUG)}`;

const state = {
  // Общий ключ с portal.js: если админ уже вошёл на портал в этой вкладке/
  // браузере, повторно вводить пароль на странице станции не придётся —
  // отдельных паролей на станции больше нет, везде один пароль портала.
  password: sessionStorage.getItem('portalPassword') || null,
  bitrate: null,
  mode: null,
  globalPort: null,
};

// ---------- Авторизация ----------

const lockScreen = document.getElementById('lockScreen');
const app = document.getElementById('app');

async function tryUnlock(password) {
  const res = await fetch(`${API_BASE}/settings`, {
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

if (!STATION_SLUG) {
  document.getElementById('lockError').textContent = 'Некорректный адрес станции';
} else if (state.password) {
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

// ---------- Инициализация приложения ----------

function initApp() {
  loadSettings();
  loadLibrary();
  loadStatus();
  loadHistory();
  setInterval(loadStatus, 15000);
  setInterval(loadHistory, 20000);
}

// ---------- Настройки трансляции ----------

const bitrateSegmented = document.getElementById('bitrateSegmented');
const modeSegmented = document.getElementById('modeSegmented');

bitrateSegmented.addEventListener('click', (e) => {
  if (e.target.tagName !== 'BUTTON') return;
  setActiveSegment(bitrateSegmented, e.target.dataset.value);
  state.bitrate = Number(e.target.dataset.value);
});
modeSegmented.addEventListener('click', (e) => {
  if (e.target.tagName !== 'BUTTON') return;
  setActiveSegment(modeSegmented, e.target.dataset.value);
  state.mode = e.target.dataset.value;
});

function setActiveSegment(container, value) {
  [...container.children].forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === value);
  });
}

function updateListenUrl() {
  const mount = document.getElementById('mountInput').value.trim();
  const el = document.getElementById('listenUrl');
  if (!state.globalPort || !mount) {
    el.textContent = '—';
    el.removeAttribute('href');
    return;
  }
  const url = `http://${window.location.hostname}:${state.globalPort}/${mount}`;
  el.textContent = url.replace('http://', '');
  el.href = url;
}
document.getElementById('mountInput').addEventListener('input', updateListenUrl);

async function loadSettings() {
  try {
    const s = await api(`${API_BASE}/settings`);
    document.getElementById('nameInput').value = s.name;
    document.getElementById('mountInput').value = s.mount;
    document.getElementById('stationNameHeader').textContent = s.name;
    document.getElementById('lockStationName').textContent = s.name;
    document.title = `Radio Deck — ${s.name}`;
    state.bitrate = s.bitrate;
    state.mode = s.mode;
    state.globalPort = s.port;
    setActiveSegment(bitrateSegmented, String(s.bitrate));
    setActiveSegment(modeSegmented, s.mode);
    updateListenUrl();
  } catch (err) {
    console.error(err);
  }
}

document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
  const msg = document.getElementById('saveSettingsMsg');
  msg.textContent = 'Сохранение...';
  try {
    const name = document.getElementById('nameInput').value.trim();
    const mount = document.getElementById('mountInput').value.trim();
    await api(`${API_BASE}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mount, bitrate: state.bitrate, mode: state.mode }),
    });
    msg.textContent = 'Сохранено. Перезапустите движок для применения.';
    document.getElementById('stationNameHeader').textContent = name;
    document.title = `Radio Deck — ${name}`;
  } catch (err) {
    msg.textContent = `Ошибка: ${err.message}`;
  }
});

// ---------- Транспорт / статус ----------

document.getElementById('restartBtn').addEventListener('click', async () => {
  if (!confirm('Перезапустить движок? Это затронет ВСЕ станции портала, а не только эту.')) return;
  const msg = document.getElementById('restartMsg');
  msg.textContent = 'Перезапуск...';
  try {
    await api(`${API_BASE}/control/restart`, { method: 'POST' });
    msg.textContent = 'Готово.';
    setTimeout(loadStatus, 2000);
  } catch (err) {
    msg.textContent = `Ошибка: ${err.message}`;
  }
});

document.getElementById('refreshStatusBtn').addEventListener('click', loadStatus);

async function loadStatus() {
  try {
    const s = await api(`${API_BASE}/control/status`);
    renderStatus('statusLiquidsoap', s.liquidsoap);
    renderStatus('statusIcecast', s.icecast);

    const listenersEl = document.getElementById('statusListeners');
    listenersEl.classList.remove('status-on', 'status-off', 'status-unknown');
    if (s.online && s.listeners != null) {
      listenersEl.textContent = String(s.listeners);
      listenersEl.classList.add('status-on');
    } else {
      listenersEl.textContent = '—';
      listenersEl.classList.add('status-unknown');
    }

    const banner = document.getElementById('nowPlayingBanner');
    if (s.online && s.nowPlayingTitle) {
      banner.textContent = `▶ Сейчас играет: ${s.nowPlayingTitle}`;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }

    const onAirDot = document.getElementById('onAirDot');
    onAirDot.classList.toggle('live', !!s.liquidsoap);
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

// ---------- История воспроизведения ----------

async function loadHistory() {
  const list = document.getElementById('historyList');
  try {
    const data = await api(`${API_BASE}/history`);
    if (data.history.length === 0) {
      list.innerHTML = '<li class="hint">История пока пуста — начните вещание.</li>';
      return;
    }
    list.innerHTML = data.history.map((h) => `
      <li class="history-item">
        <span class="history-time">${new Date(h.playedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>
        <span class="history-title">${escapeHtml(h.title)}</span>
      </li>
    `).join('');
  } catch (err) {
    list.innerHTML = `<li class="hint">Ошибка: ${escapeHtml(err.message)}</li>`;
  }
}

document.getElementById('clearHistoryBtn').addEventListener('click', async () => {
  if (!confirm('Очистить историю воспроизведения этой станции?')) return;
  const msg = document.getElementById('clearHistoryMsg');
  msg.textContent = 'Очистка...';
  try {
    await api(`${API_BASE}/history`, { method: 'DELETE' });
    msg.textContent = '';
    loadHistory();
  } catch (err) {
    msg.textContent = `Ошибка: ${err.message}`;
  }
});

// ---------- Медиатека ----------

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');

['dragenter', 'dragover'].forEach((evt) =>
  dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.add('dragover'); })
);
['dragleave', 'drop'].forEach((evt) =>
  dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); })
);
dropZone.addEventListener('drop', (e) => {
  const files = e.dataTransfer.files;
  if (files.length) uploadFiles(files);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) uploadFiles(fileInput.files);
});

function uploadFiles(fileList) {
  const formData = new FormData();
  [...fileList].forEach((f) => formData.append('files', f));

  const progressWrap = document.getElementById('uploadProgress');
  const vuFill = document.getElementById('vuFill');
  const label = document.getElementById('uploadProgressLabel');
  progressWrap.classList.remove('hidden');
  vuFill.style.width = '0%';
  label.textContent = '0%';

  const folder = document.getElementById('uploadFolderInput').value.trim();
  const uploadUrl = folder
    ? `${API_BASE}/library/upload?folder=${encodeURIComponent(folder)}`
    : `${API_BASE}/library/upload`;

  const xhr = new XMLHttpRequest();
  xhr.open('POST', uploadUrl);
  xhr.setRequestHeader('X-Portal-Password', state.password);

  xhr.upload.addEventListener('progress', (e) => {
    if (!e.lengthComputable) return;
    const pct = Math.round((e.loaded / e.total) * 100);
    vuFill.style.width = `${pct}%`;
    label.textContent = `${pct}%`;
  });

  xhr.onload = () => {
    progressWrap.classList.add('hidden');
    fileInput.value = '';
    if (xhr.status >= 200 && xhr.status < 300) {
      loadLibrary();
    } else {
      const data = JSON.parse(xhr.responseText || '{}');
      alert(`Ошибка загрузки: ${data.error || xhr.statusText}`);
    }
  };
  xhr.onerror = () => {
    progressWrap.classList.add('hidden');
    alert('Ошибка сети при загрузке файлов');
  };
  xhr.send(formData);
}

const PAGE_SIZE = 20;
const libraryState = {
  allFiles: [],      // полный список с сервера, без фильтрации
  searchQuery: '',
  currentPage: 1,
};

async function loadLibrary() {
  const tbody = document.getElementById('trackTableBody');
  try {
    const data = await api(`${API_BASE}/library`);
    document.getElementById('trackCount').textContent = `${data.count} треков в медиатеке`;
    document.getElementById('libraryStats').textContent = data.count > 0
      ? `${data.count} треков · ${formatDuration(data.totalDurationSeconds)}`
      : '';

    libraryState.allFiles = data.files;
    libraryState.currentPage = 1; // список обновился с сервера — начинаем с первой страницы
    renderLibraryTable();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-row">Ошибка: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function getFilteredFiles() {
  const q = libraryState.searchQuery.trim().toLowerCase();
  if (!q) return libraryState.allFiles;
  return libraryState.allFiles.filter((f) =>
    f.name.toLowerCase().includes(q) ||
    (f.title && f.title.toLowerCase().includes(q)) ||
    (f.artist && f.artist.toLowerCase().includes(q))
  );
}

function renderLibraryTable() {
  const tbody = document.getElementById('trackTableBody');
  const filtered = getFilteredFiles();

  if (libraryState.allFiles.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-row">Медиатека пуста — загрузите первые треки</td></tr>';
    renderPagination(0, 0);
    return;
  }
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-row">Ничего не найдено по запросу</td></tr>';
    renderPagination(0, 0);
    return;
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  if (libraryState.currentPage > totalPages) libraryState.currentPage = totalPages;

  const start = (libraryState.currentPage - 1) * PAGE_SIZE;
  const pageFiles = filtered.slice(start, start + PAGE_SIZE);

  tbody.innerHTML = pageFiles.map((f) => `
    <tr>
      <td>
        ${f.title
          ? `<span class="track-title">${escapeHtml(f.title)}</span>${f.artist ? `<span class="track-artist">${escapeHtml(f.artist)}</span>` : ''}`
          : '<span class="track-title-empty">без тегов</span>'}
      </td>
      <td class="track-filename">${escapeHtml(f.name)}</td>
      <td class="track-numeric">${f.durationSeconds != null ? formatDuration(f.durationSeconds) : '—'}</td>
      <td class="track-numeric">${f.bitrateKbps != null ? `${f.bitrateKbps} кбит/с` : '—'}</td>
      <td>${formatSize(f.sizeBytes)}</td>
      <td>${new Date(f.modifiedAt).toLocaleString('ru-RU')}</td>
      <td>
        <div class="row-actions">
          <button class="track-action track-edit-tags" data-name="${escapeHtml(f.name)}"
            title="${f.tagsEditable ? 'Редактировать теги' : 'Редактирование тегов доступно для MP3, OGG и FLAC'}"
            ${f.tagsEditable ? '' : 'disabled'}>✎</button>
          <button class="track-action track-delete" data-name="${escapeHtml(f.name)}" title="Удалить">✕</button>
        </div>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.track-delete').forEach((btn) => {
    btn.addEventListener('click', () => deleteTrack(btn.dataset.name));
  });
  tbody.querySelectorAll('.track-edit-tags').forEach((btn) => {
    btn.addEventListener('click', () => openTagEditor(btn.dataset.name));
  });

  renderPagination(filtered.length, totalPages);
}

function renderPagination(filteredCount, totalPages) {
  const el = document.getElementById('libraryPagination');
  if (filteredCount === 0) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = `
    <button id="pagePrevBtn" ${libraryState.currentPage <= 1 ? 'disabled' : ''}>← Назад</button>
    <span>Страница ${libraryState.currentPage} из ${totalPages} (${filteredCount} треков)</span>
    <button id="pageNextBtn" ${libraryState.currentPage >= totalPages ? 'disabled' : ''}>Вперёд →</button>
  `;
  document.getElementById('pagePrevBtn')?.addEventListener('click', () => {
    libraryState.currentPage -= 1;
    renderLibraryTable();
  });
  document.getElementById('pageNextBtn')?.addEventListener('click', () => {
    libraryState.currentPage += 1;
    renderLibraryTable();
  });
}

document.getElementById('librarySearch').addEventListener('input', (e) => {
  libraryState.searchQuery = e.target.value;
  libraryState.currentPage = 1; // новый поиск — всегда с первой страницы
  renderLibraryTable();
});

function formatDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

async function deleteTrack(name) {
  if (!confirm(`Удалить «${name}» из медиатеки?`)) return;
  try {
    await api(`${API_BASE}/library/file?path=${encodeURIComponent(name)}`, { method: 'DELETE' });
    loadLibrary();
  } catch (err) {
    alert(`Ошибка удаления: ${err.message}`);
  }
}

// ---------- Удаление всей медиатеки ----------

document.getElementById('deleteAllBtn').addEventListener('click', async () => {
  const msg = document.getElementById('deleteAllMsg');
  const trackCountText = document.getElementById('trackCount').textContent;

  if (!confirm(
    `Удалить ВСЕ треки этой станции без возможности восстановления?\n\n` +
    `Сейчас в медиатеке: ${trackCountText}.`
  )) {
    return;
  }

  const typed = prompt('Это необратимо. Наберите слово УДАЛИТЬ, чтобы подтвердить:');
  if (typed !== 'УДАЛИТЬ') {
    msg.textContent = typed === null ? '' : 'Отменено — слово введено неверно.';
    return;
  }

  msg.textContent = 'Удаление...';
  try {
    const result = await api(`${API_BASE}/library`, { method: 'DELETE' });
    msg.textContent = `Удалено файлов: ${result.deletedCount}.`;
    loadLibrary();
  } catch (err) {
    msg.textContent = `Ошибка: ${err.message}`;
  }
});

// ---------- Редактор ID3/Vorbis-тегов ----------

const tagModal = document.getElementById('tagModal');
let currentTagFile = null;

async function openTagEditor(name) {
  currentTagFile = name;
  document.getElementById('tagModalFilename').textContent = name;
  document.getElementById('tagModalMsg').textContent = 'Загрузка тегов...';
  tagModal.classList.remove('hidden');

  try {
    const tags = await api(`${API_BASE}/library/file/tags?path=${encodeURIComponent(name)}`);
    document.getElementById('tagTitle').value = tags.title;
    document.getElementById('tagArtist').value = tags.artist;
    document.getElementById('tagAlbum').value = tags.album;
    document.getElementById('tagYear').value = tags.year;
    document.getElementById('tagGenre').value = tags.genre;
    document.getElementById('tagTrackNumber').value = tags.trackNumber;
    document.getElementById('tagComment').value = tags.comment;
    document.getElementById('tagModalMsg').textContent = '';
  } catch (err) {
    document.getElementById('tagModalMsg').textContent = `Ошибка: ${err.message}`;
  }
}

function closeTagEditor() {
  tagModal.classList.add('hidden');
  currentTagFile = null;
}

document.getElementById('tagCancelBtn').addEventListener('click', closeTagEditor);

document.getElementById('tagSaveBtn').addEventListener('click', async () => {
  if (!currentTagFile) return;
  const msg = document.getElementById('tagModalMsg');
  msg.textContent = 'Сохранение...';

  const payload = {
    title: document.getElementById('tagTitle').value,
    artist: document.getElementById('tagArtist').value,
    album: document.getElementById('tagAlbum').value,
    year: document.getElementById('tagYear').value,
    genre: document.getElementById('tagGenre').value,
    trackNumber: document.getElementById('tagTrackNumber').value,
    comment: document.getElementById('tagComment').value,
  };

  try {
    await api(`${API_BASE}/library/file/tags?path=${encodeURIComponent(currentTagFile)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    closeTagEditor();
    loadLibrary();
  } catch (err) {
    msg.textContent = `Ошибка: ${err.message}`;
  }
});

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
