const bcrypt = require('bcryptjs');

function hashPassword(password) {
  return bcrypt.hashSync(String(password), 10);
}

function verifyPassword(password, hash) {
  if (!hash) return false;
  return bcrypt.compareSync(String(password || ''), hash);
}

module.exports = { hashPassword, verifyPassword };
