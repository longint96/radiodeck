const express = require('express');
const playHistory = require('../lib/playHistory');

const router = express.Router({ mergeParams: true });

// GET /api/stations/:stationId/history — последние 15 треков станции
router.get('/', (req, res) => {
  try {
    res.json({ history: playHistory.getHistory(req.station.slug) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/stations/:stationId/history — очистить историю станции
router.delete('/', (req, res) => {
  try {
    playHistory.clearHistory(req.station.slug);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
