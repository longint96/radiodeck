const express = require('express');
const serviceControl = require('../lib/serviceControl');

const router = express.Router({ mergeParams: true });

// GET /api/stations/:stationId/control/status
router.get('/status', async (req, res) => {
  try {
    res.json(await serviceControl.status());
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
