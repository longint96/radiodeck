const express = require('express');
const registry = require('../lib/stationRegistry');
const liquidsoapConfigGen = require('../lib/liquidsoapConfigGen');
const serviceControl = require('../lib/serviceControl');
const systemStats = require('../lib/systemStats');
const icecastStatus = require('../lib/icecastStatus');
const mediaInfo = require('../lib/mediaInfo');
const mediaPermissions = require('../lib/mediaPermissions');

const router = express.Router();

// GET /api/portal/stations — список всех станций
router.get('/stations', (req, res) => {
  try {
    res.json({ stations: registry.listStations() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/portal/stations — создать станцию
router.post('/stations', async (req, res) => {
  try {
    const { name, bitrate, mode, mount } = req.body;
    const station = await registry.createStation({
      name,
      bitrate: bitrate !== undefined ? Number(bitrate) : undefined,
      mode,
      mount,
    });
    liquidsoapConfigGen.regenerate();
    res.json({
      ok: true,
      station,
      note: 'Станция создана. Чтобы она начала вещать, перезапустите движок.',
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/portal/stations/:id — удалить станцию
router.delete('/stations/:id', async (req, res) => {
  try {
    const deleteMedia = req.query.deleteMedia === '1' || req.body?.deleteMedia === true;
    const removed = await registry.deleteStation(req.params.id, { deleteMedia });
    liquidsoapConfigGen.regenerate();
    res.json({ ok: true, deleted: removed });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/portal/global — глобальные настройки (порт, пароль источника)
router.get('/global', (req, res) => {
  try {
    res.json(registry.getGlobalSettings());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/portal/global — обновить глобальные настройки
router.post('/global', async (req, res) => {
  try {
    const { port, sourcePassword } = req.body;
    const updated = await registry.updateGlobalSettings({
      port: port !== undefined ? Number(port) : undefined,
      sourcePassword,
    });
    liquidsoapConfigGen.regenerate();
    res.json({ ok: true, global: updated, note: 'Требуется перезапуск для применения' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/portal/status — статус движка (icecast + liquidsoap)
router.get('/status', async (req, res) => {
  try {
    res.json(await serviceControl.status());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/portal/restart — перезапустить движок (затрагивает ВСЕ станции)
router.post('/restart', async (req, res) => {
  try {
    await serviceControl.restart();
    res.json({ ok: true, message: 'Движок перезапущен, все станции применили изменения' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/portal/system-stats — CPU/память/диск сервера
router.get('/system-stats', async (req, res) => {
  try {
    let diskPath = '/';
    try {
      diskPath = registry.getMediaBaseDir();
    } catch {
      /* путь к медиатеке ещё не задан нигде — считаем диск для корня */
    }
    res.json(await systemStats.getSystemStats(diskPath));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/portal/now-playing — текущий трек и online/офлайн статус каждой станции
router.get('/now-playing', async (req, res) => {
  try {
    const global = registry.getGlobalSettings();
    const stations = registry.listStations();
    const result = await icecastStatus.getNowPlaying(stations, global.port);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/portal/library-stats — кол-во треков и суммарная длительность
// по каждой станции (для карточек на главной). Тегов не читает — только
// длительность, поэтому легче полного списка медиатеки станции.
router.get('/library-stats', async (req, res) => {
  try {
    const stations = registry.listStations();
    const stats = await Promise.all(
      stations.map(async (s) => {
        const summary = await mediaInfo.getLibrarySummary(registry.mediaDirFor(s.slug));
        return { slug: s.slug, ...summary };
      })
    );
    res.json({ stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/portal/media-base-dir — сменить путь к медиатеке.
// Автоматически переносит папки существующих станций на новое место и
// СРАЗУ перезапускает движок (не откладывая, как остальные настройки) —
// до перезапуска liquidsoap продолжает следить за старым, уже опустевшим
// путём, и станции покажутся пустыми.
router.post('/media-base-dir', async (req, res) => {
  try {
    const { path: newPath } = req.body;
    const result = await registry.updateMediaBaseDir(newPath);

    if (result.changed) {
      liquidsoapConfigGen.regenerate();
      await serviceControl.restart();
    }

    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/portal/fix-media-permissions — восстановить владельца (radio:radio)
// всех файлов медиатеки. Нужно после загрузки файлов в обход панели
// (например, через WinSCP/SFTP от другого системного пользователя) —
// backend работает от radio и не может читать/писать теги в чужих файлах.
router.post('/fix-media-permissions', async (req, res) => {
  try {
    const output = await mediaPermissions.fixMediaPermissions();
    res.json({ ok: true, output });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
