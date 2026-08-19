const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { hashPassword, verifyPassword } = require('./auth');
const { slugify, uniqueSlug } = require('./slug');

const REGISTRY_PATH = process.env.STATIONS_REGISTRY;
const MEDIA_BASE_DIR = process.env.MEDIA_BASE_DIR;

const ALLOWED_MODES = ['normal', 'random'];
const ALLOWED_BITRATES = [64, 96, 128, 192, 256, 320];

function assertPaths() {
  if (!REGISTRY_PATH) throw new Error('STATIONS_REGISTRY не задан в .env');
  if (!MEDIA_BASE_DIR) throw new Error('MEDIA_BASE_DIR не задан в .env');
}

function defaultRegistry() {
  return {
    global: {
      port: 8000,
      sourcePassword: 'changeme',
    },
    stations: [],
  };
}

// --- Сериализация записи: конкурентные POST/DELETE не должны затирать
//     друг друга при чтении-модификации-записи одного JSON-файла ---
let writeQueue = Promise.resolve();
function withWriteLock(fn) {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.catch(() => {});
  return run;
}

function readRegistryRaw() {
  assertPaths();
  if (!fs.existsSync(REGISTRY_PATH)) {
    const initial = defaultRegistry();
    fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(initial, null, 2), 'utf8');
    return initial;
  }
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
}

function writeRegistryRaw(registry) {
  const tempPath = `${REGISTRY_PATH}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(registry, null, 2), 'utf8');
  fs.renameSync(tempPath, REGISTRY_PATH);
}

function toPublicStation(station) {
  const { passwordHash, ...rest } = station;
  return rest;
}

function mediaDirFor(slug) {
  return path.join(MEDIA_BASE_DIR, slug);
}

// ============================================================
// Публичное API
// ============================================================

function listStations() {
  const registry = readRegistryRaw();
  return registry.stations.map(toPublicStation);
}

function getStationInternal(id) {
  const registry = readRegistryRaw();
  return registry.stations.find((s) => s.id === id || s.slug === id) || null;
}

function getStationPublic(id) {
  const station = getStationInternal(id);
  return station ? toPublicStation(station) : null;
}

function getGlobalSettings() {
  return readRegistryRaw().global;
}

function validateStationFields({ bitrate, mode }) {
  if (bitrate !== undefined && !ALLOWED_BITRATES.includes(bitrate)) {
    throw new Error(`Недопустимый битрейт. Разрешены: ${ALLOWED_BITRATES.join(', ')}`);
  }
  if (mode !== undefined && !ALLOWED_MODES.includes(mode)) {
    throw new Error(`Недопустимый режим. Разрешены: ${ALLOWED_MODES.join(', ')}`);
  }
}

async function createStation({ name, bitrate = 128, mode = 'normal', mount, password }) {
  if (!name || !name.trim()) throw new Error('Название станции обязательно');
  if (!password || password.length < 4) throw new Error('Пароль станции должен быть не короче 4 символов');
  validateStationFields({ bitrate, mode });

  return withWriteLock(() => {
    const registry = readRegistryRaw();
    const existingSlugs = registry.stations.map((s) => s.slug);
    const slug = uniqueSlug(slugify(name), existingSlugs);

    const existingMounts = registry.stations.map((s) => s.mount);
    let finalMount = (mount && mount.trim()) || `${slug}.mp3`;
    finalMount = finalMount.replace(/^\/+/, ''); // без ведущего слэша — добавляется на фронте при показе URL
    if (existingMounts.includes(finalMount)) {
      throw new Error(`Mount-точка "${finalMount}" уже занята другой станцией`);
    }

    const station = {
      id: crypto.randomBytes(6).toString('hex'),
      slug,
      name: name.trim(),
      mount: finalMount,
      bitrate,
      mode,
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString(),
    };

    registry.stations.push(station);
    writeRegistryRaw(registry);

    fs.mkdirSync(mediaDirFor(slug), { recursive: true });

    return toPublicStation(station);
  });
}

async function updateStationSettings(id, { mount, bitrate, mode }) {
  validateStationFields({ bitrate, mode });

  return withWriteLock(() => {
    const registry = readRegistryRaw();
    const station = registry.stations.find((s) => s.id === id || s.slug === id);
    if (!station) throw new Error('Станция не найдена');

    if (mount !== undefined) {
      const cleanMount = mount.trim().replace(/^\/+/, '');
      if (!cleanMount) throw new Error('Mount-точка не может быть пустой');
      const collision = registry.stations.find((s) => s.id !== station.id && s.mount === cleanMount);
      if (collision) throw new Error(`Mount-точка "${cleanMount}" уже занята станцией "${collision.name}"`);
      station.mount = cleanMount;
    }
    if (bitrate !== undefined) station.bitrate = bitrate;
    if (mode !== undefined) station.mode = mode;

    writeRegistryRaw(registry);
    return toPublicStation(station);
  });
}

async function renameStation(id, name) {
  if (!name || !name.trim()) throw new Error('Название станции обязательно');

  return withWriteLock(() => {
    const registry = readRegistryRaw();
    const station = registry.stations.find((s) => s.id === id || s.slug === id);
    if (!station) throw new Error('Станция не найдена');
    station.name = name.trim();
    writeRegistryRaw(registry);
    return toPublicStation(station);
  });
}

async function changeStationPassword(id, oldPassword, newPassword) {
  if (!newPassword || newPassword.length < 4) {
    throw new Error('Новый пароль должен быть не короче 4 символов');
  }

  return withWriteLock(() => {
    const registry = readRegistryRaw();
    const station = registry.stations.find((s) => s.id === id || s.slug === id);
    if (!station) throw new Error('Станция не найдена');
    if (!verifyPassword(oldPassword, station.passwordHash)) {
      throw new Error('Текущий пароль указан неверно');
    }
    station.passwordHash = hashPassword(newPassword);
    writeRegistryRaw(registry);
    return { ok: true };
  });
}

async function deleteStation(id, { deleteMedia = false } = {}) {
  return withWriteLock(() => {
    const registry = readRegistryRaw();
    const idx = registry.stations.findIndex((s) => s.id === id || s.slug === id);
    if (idx === -1) throw new Error('Станция не найдена');

    const [removed] = registry.stations.splice(idx, 1);
    writeRegistryRaw(registry);

    if (deleteMedia) {
      const dir = mediaDirFor(removed.slug);
      fs.rmSync(dir, { recursive: true, force: true });
    }

    return toPublicStation(removed);
  });
}

async function updateGlobalSettings({ port, sourcePassword }) {
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error('Некорректный порт (1-65535)');
  }

  return withWriteLock(() => {
    const registry = readRegistryRaw();
    if (port !== undefined) registry.global.port = port;
    if (sourcePassword !== undefined && sourcePassword.length > 0) {
      registry.global.sourcePassword = sourcePassword;
    }
    writeRegistryRaw(registry);
    return registry.global;
  });
}

function verifyStationPassword(id, password) {
  const station = getStationInternal(id);
  if (!station) return false;
  return verifyPassword(password, station.passwordHash);
}

module.exports = {
  listStations,
  getStationInternal,
  getStationPublic,
  getGlobalSettings,
  createStation,
  updateStationSettings,
  renameStation,
  changeStationPassword,
  deleteStation,
  updateGlobalSettings,
  verifyStationPassword,
  mediaDirFor,
};
