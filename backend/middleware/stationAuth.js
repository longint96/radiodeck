const { getStationInternal, verifyStationPassword } = require('../lib/stationRegistry');

/**
 * Проверяет пароль станции (заголовок X-Station-Password) против её
 * собственного хеша в реестре. Требует, чтобы роут был примонтирован
 * с параметром :stationId (id или slug) — используется mergeParams.
 *
 * Пароль портала (X-Portal-Password) тоже принимается как валидный —
 * администратор портала может зайти в админку любой станции без того,
 * чтобы знать её отдельный пароль.
 */
function stationAuth(req, res, next) {
  const stationId = req.params.stationId;
  const station = getStationInternal(stationId);
  if (!station) {
    return res.status(404).json({ error: 'Станция не найдена' });
  }

  const portalPassword = req.headers['x-portal-password'];
  if (portalPassword && portalPassword === process.env.PORTAL_PASSWORD) {
    req.station = station;
    return next();
  }

  const stationPassword = req.headers['x-station-password'];
  if (!verifyStationPassword(stationId, stationPassword)) {
    return res.status(401).json({ error: 'Неверный пароль станции' });
  }

  req.station = station;
  next();
}

module.exports = stationAuth;
