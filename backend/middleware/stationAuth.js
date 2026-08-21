const { getStationInternal } = require('../lib/stationRegistry');

/**
 * Доступ к станции (её медиатеке, настройкам, истории и т.д.) теперь
 * управляется ЕДИНСТВЕННО паролем портала — отдельных паролей на
 * каждую станцию больше нет (упростили модель: один пароль на всё).
 * Требует, чтобы роут был примонтирован с параметром :stationId
 * (id или slug) — используется mergeParams.
 */
function stationAuth(req, res, next) {
  const stationId = req.params.stationId;
  const station = getStationInternal(stationId);
  if (!station) {
    return res.status(404).json({ error: 'Станция не найдена' });
  }

  const portalPassword = req.headers['x-portal-password'];
  if (!portalPassword || portalPassword !== process.env.PORTAL_PASSWORD) {
    return res.status(401).json({ error: 'Неверный пароль портала' });
  }

  req.station = station;
  next();
}

module.exports = stationAuth;
