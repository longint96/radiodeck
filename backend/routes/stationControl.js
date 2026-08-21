const express = require('express');
const serviceControl = require('../lib/serviceControl');
const icecastStatus = require('../lib/icecastStatus');
const registry = require('../lib/stationRegistry');
const listenerHistory = require('../lib/listenerHistory');

const router = express.Router({ mergeParams: true });

// GET /api/stations/:stationId/control/status — статус движка + живые
// данные именно этой станции (слушатели, текущий трек) из Icecast
router.get('/status', async (req, res) => {
  try {
    const serviceStatus = await serviceControl.status();

    const global = registry.getGlobalSettings();
    const { stations } = await icecastStatus.getNowPlaying([req.station], global.port);
    const own = stations[0] || { online: false, title: null, listeners: null, listenerPeak: null };

    res.json({
      ...serviceStatus,
      online: own.online,
      nowPlayingTitle: own.title,
      listeners: own.listeners,
      listenerPeak: own.listenerPeak,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stations/:stationId/control/listeners-history — история числа
// слушателей станции (снимки раз в 5 минут, ~7 суток)
router.get('/listeners-history', (req, res) => {
  try {
    res.json({ history: listenerHistory.getHistory(req.station.slug) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stations/:stationId/control/restart
// ВАЖНО: движок общий на все станции портала — перезапуск затрагивает
// ВСЕ станции, а не только текущую. Предупреждение показывается на фронте.
router.post('/restart', async (req, res) => {
  try {
    await serviceControl.restart();
    res.json({
      ok: true,
      message: 'Движок перезапущен. Изменения применены на всех станциях портала.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
