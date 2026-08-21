const express = require('express');
const registry = require('../lib/stationRegistry');
const liquidsoapConfigGen = require('../lib/liquidsoapConfigGen');

const router = express.Router({ mergeParams: true });

// GET /api/stations/:stationId/settings
router.get('/', (req, res) => {
  // req.station уже загружен middleware stationAuth — отдаём публичную часть
  const { passwordHash, ...publicStation } = req.station;
  const global = registry.getGlobalSettings();
  res.json({ ...publicStation, port: global.port });
});

// POST /api/stations/:stationId/settings — mount / битрейт / режим
router.post('/', async (req, res) => {
  try {
    const { mount, bitrate, mode, name } = req.body;

    if (name !== undefined) {
      await registry.renameStation(req.params.stationId, name);
    }

    const updated = await registry.updateStationSettings(req.params.stationId, {
      mount,
      bitrate: bitrate !== undefined ? Number(bitrate) : undefined,
      mode,
    });

    liquidsoapConfigGen.regenerate();
    res.json({ ok: true, station: updated, note: 'Требуется перезапуск движка для применения' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
