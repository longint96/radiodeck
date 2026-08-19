require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const portalAuth = require('./middleware/portalAuth');
const stationAuth = require('./middleware/stationAuth');

const portalRoutes = require('./routes/portal');
const stationLibraryRoutes = require('./routes/stationLibrary');
const stationSettingsRoutes = require('./routes/stationSettings');
const stationControlRoutes = require('./routes/stationControl');
const stationHistoryRoutes = require('./routes/stationHistory');
const playHistory = require('./lib/playHistory');

const app = express();
const PORT = process.env.PANEL_PORT || 3000;
const MEDIA_BASE_DIR = process.env.MEDIA_BASE_DIR;
const DATA_DIR = process.env.STATIONS_REGISTRY && path.dirname(process.env.STATIONS_REGISTRY);

const BUILD_VERSION = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, 'BUILD_VERSION.txt'), 'utf8').trim();
  } catch {
    return 'unknown';
  }
})();

// Убедимся, что базовые директории существуют
[MEDIA_BASE_DIR, DATA_DIR].forEach((dir) => {
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.use(express.json());

// --- Страницы (перед статикой — это единственные два "виртуальных" пути) ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'portal.html'));
});
app.get('/station/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'station.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// --- API портала: список/создание/удаление станций, глобальные настройки ---
app.use('/api/portal', portalAuth, portalRoutes);

// --- API станции: собственный пароль станции (или пароль портала) ---
const stationRouter = express.Router({ mergeParams: true });
stationRouter.use(stationAuth);
stationRouter.use('/library', stationLibraryRoutes);
stationRouter.use('/settings', stationSettingsRoutes);
stationRouter.use('/control', stationControlRoutes);
stationRouter.use('/history', stationHistoryRoutes);
app.use('/api/stations/:stationId', stationRouter);

// Без авторизации — чтобы можно было проверить версию одним curl,
// не вводя пароль портала (полезно при диагностике "накатилось ли обновление")
app.get('/api/health', (req, res) => res.json({ ok: true, buildVersion: BUILD_VERSION }));

app.use((err, req, res, next) => {
  console.error(err);
  if (err.code === 'LIMIT_FILE_SIZE') {
    const maxMb = parseInt(process.env.MAX_UPLOAD_MB || '1024', 10);
    return res.status(413).json({
      error: `Файл слишком большой. Текущий лимит — ${maxMb} МБ (настраивается через MAX_UPLOAD_MB в .env).`,
    });
  }
  res.status(400).json({ error: err.message || 'Внутренняя ошибка' });
});

app.listen(PORT, () => {
  console.log(`Radio Deck портал запущен: http://localhost:${PORT} (build ${BUILD_VERSION})`);
  playHistory.startPolling();
});
