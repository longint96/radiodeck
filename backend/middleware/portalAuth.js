function portalAuth(req, res, next) {
  const provided = req.headers['x-portal-password'];
  const expected = process.env.PORTAL_PASSWORD;

  if (!expected) {
    return res.status(500).json({ error: 'PORTAL_PASSWORD не задан на сервере' });
  }
  if (provided !== expected) {
    return res.status(401).json({ error: 'Неверный пароль портала' });
  }
  next();
}

module.exports = portalAuth;
