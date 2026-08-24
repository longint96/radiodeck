const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { slugify, uniqueSlug } = require('./slug');

const REGISTRY_PATH = process.env.STATIONS_REGISTRY;
const MEDIA_BASE_DIR = process.env.MEDIA_BASE_DIR;

const ALLOWED_MODES = ['normal', 'random'];
const ALLOWED_BITRATES = [64, 96, 128, 192, 256, 320];

function assertPaths() {
  if (!REGISTRY_PATH) throw new Error('STATIONS_REGISTRY не задан в .env');
}

function defaultRegistry() {
  return {
    global: {
      port: 8000,
      sourcePassword: 'changeme',
      mediaBaseDir: MEDIA_BASE_DIR || null,
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
  // Экранируем passwordHash защитно: у станций, созданных ДО отказа от
  // станционных паролей, это поле может остаться в data/stations.json —
  // наружу его отдавать незачем, даже если оно больше не используется
  // для аутентификации.
  const { passwordHash, ...rest } = station;
  return rest;
}

function getMediaBaseDir() {
  const registry = readRegistryRaw();
  const dir = registry.global.mediaBaseDir || MEDIA_BASE_DIR;
  if (!dir) {
    throw new Error('Путь к медиатеке не задан ни в настройках портала, ни в MEDIA_BASE_DIR (.env)');
  }
  return dir;
}

function mediaDirFor(slug) {
  return path.join(getMediaBaseDir(), slug);
}

function moveDirRecursive(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    // Старый и новый путь на разных файловых системах — rename так не умеет,
    // копируем содержимое и удаляем источник только после успешного копирования
    fs.cpSync(src, dest, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

/**
 * Меняет базовый путь медиатеки и переносит папки уже существующих станций
 * со старого пути на новый (rename, либо copy+delete между файловыми
 * системами). Папки, которых не было на старом месте, просто создаются
 * пустыми на новом. Если на новом месте уже есть папка с именем станции —
 * трек не переносится, ошибка сообщается по этой станции, остальные
 * переносятся как обычно (не блокируем всю операцию из-за одной коллизии).
 */
async function updateMediaBaseDir(newBaseDir) {
  if (!newBaseDir || typeof newBaseDir !== 'string' || !path.isAbsolute(newBaseDir)) {
    throw new Error('Путь к медиатеке должен быть абсолютным (начинаться с /)');
  }
  const cleanNew = path.resolve(newBaseDir);

  return withWriteLock(() => {
    const registry = readRegistryRaw();
    const oldBaseDir = registry.global.mediaBaseDir || MEDIA_BASE_DIR;
    const cleanOld = oldBaseDir ? path.resolve(oldBaseDir) : null;

    if (cleanOld === cleanNew) {
      return { changed: false, moved: [], errors: [], mediaBaseDir: cleanNew };
    }

    fs.mkdirSync(cleanNew, { recursive: true });

    const moved = [];
    const errors = [];
    for (const station of registry.stations) {
      const oldDir = cleanOld ? path.join(cleanOld, station.slug) : null;
      const newDir = path.join(cleanNew, station.slug);

      if (fs.existsSync(newDir)) {
        errors.push(`${station.slug}: на новом пути уже есть папка с этим именем — пропущено, перенесите вручную`);
        continue;
      }
      if (!oldDir || !fs.existsSync(oldDir)) {
        fs.mkdirSync(newDir, { recursive: true }); // на старом месте ничего не было — создаём пустую
        continue;
      }
      try {
        moveDirRecursive(oldDir, newDir);
        moved.push(station.slug);
      } catch (err) {
        errors.push(`${station.slug}: ${err.message}`);
      }
    }

    registry.global.mediaBaseDir = cleanNew;
    writeRegistryRaw(registry);

    return { changed: true, moved, errors, mediaBaseDir: cleanNew };
  });
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

async function createStation({ name, bitrate = 128, mode = 'normal', mount }) {
  if (!name || !name.trim()) throw new Error('Название станции обязательно');
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
      createdAt: new Date().toISOString(),
    };

    // Папку медиатеки создаём ДО записи в реестр: если mkdir упадёт
    // (например, нет прав на смонтированный отдельно диск) — реестр
    // останется нетронутым, а не в рассогласованном состоянии
    // "станция есть в data/stations.json, а конфиг liquidsoap про неё не знает"
    fs.mkdirSync(mediaDirFor(slug), { recursive: true });

    registry.stations.push(station);
    writeRegistryRaw(registry);

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

/**
 * Экспорт для резервного копирования: названия/настройки станций и пути —
 * НЕ сами файлы медиатеки (их бэкапить нужно отдельно, штатными средствами
 * для файлов, например rsync/tar на уровне ОС). Явный whitelist полей
 * (а не просто "всё кроме passwordHash") — безопаснее на случай, если в
 * будущем в объект станции добавится ещё какое-то служебное поле, которое
 * не должно попасть в бэкап по умолчанию.
 */
function exportBackup() {
  const registry = readRegistryRaw();
  return {
    exportedAt: new Date().toISOString(),
    global: {
      port: registry.global.port,
      sourcePassword: registry.global.sourcePassword,
      mediaBaseDir: registry.global.mediaBaseDir,
    },
    stations: registry.stations.map((s) => ({
      id: s.id,
      slug: s.slug,
      name: s.name,
      mount: s.mount,
      bitrate: s.bitrate,
      mode: s.mode,
      createdAt: s.createdAt,
    })),
  };
}

// Тот же формат slug, что производит slugify() — единственная защита от
// path traversal через это поле: slug идёт прямо в mediaDirFor(slug) =
// path.join(mediaBaseDir, slug), и раз бэкап теперь приходит извне
// (загруженный файл, а не то, что мы сами сгенерировали), доверять ему
// вслепую нельзя. Значение вроде "../../etc" будет отклонено целиком —
// не "почищено", а именно отклонено, с понятной ошибкой.
const SAFE_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Полная замена текущего реестра данными из бэкапа (см. exportBackup выше).
 * НЕ слияние — если в бэкапе нет какой-то станции, которая сейчас есть
 * в реестре, эта станция из реестра пропадёт (её файлы на диске при этом
 * не трогаются, только запись в реестре и, соответственно, конфиг
 * liquidsoap). Осознанное решение в пользу предсказуемости — слияние
 * с логикой "что делать при конфликте slug/mount" было бы куда менее
 * предсказуемым поведением.
 *
 * Валидирует ВСЁ перед тем, как что-либо записать — при любой ошибке
 * реестр остаётся полностью нетронутым (ничего не пишем частично).
 */
async function importBackup(backup) {
  if (!backup || typeof backup !== 'object') {
    throw new Error('Файл бэкапа повреждён или имеет неверный формат');
  }
  if (!backup.global || typeof backup.global !== 'object') {
    throw new Error('В бэкапе отсутствует раздел global');
  }
  if (!Array.isArray(backup.stations)) {
    throw new Error('В бэкапе отсутствует список станций');
  }

  const { port, sourcePassword, mediaBaseDir } = backup.global;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Некорректный порт в разделе global бэкапа');
  }
  if (!sourcePassword || typeof sourcePassword !== 'string') {
    throw new Error('Отсутствует пароль источника в разделе global бэкапа');
  }
  if (!mediaBaseDir || typeof mediaBaseDir !== 'string' || !path.isAbsolute(mediaBaseDir)) {
    throw new Error('Некорректный путь к медиатеке в разделе global бэкапа (должен быть абсолютным)');
  }

  const seenSlugs = new Set();
  const seenMounts = new Set();
  const importedStations = backup.stations.map((s, i) => {
    const label = `станция #${i + 1}${s?.name ? ` (${s.name})` : ''}`;

    if (!s || typeof s !== 'object') throw new Error(`${label}: некорректная запись`);
    if (!s.slug || typeof s.slug !== 'string' || !SAFE_SLUG_RE.test(s.slug)) {
      throw new Error(`${label}: некорректный slug "${s.slug}"`);
    }
    if (!s.name || typeof s.name !== 'string' || !s.name.trim()) {
      throw new Error(`${label}: отсутствует название`);
    }
    if (!s.mount || typeof s.mount !== 'string' || !s.mount.trim()) {
      throw new Error(`${label}: отсутствует mount-точка`);
    }
    try {
      validateStationFields({ bitrate: s.bitrate, mode: s.mode });
    } catch (err) {
      throw new Error(`${label}: ${err.message}`);
    }
    if (s.bitrate === undefined || s.mode === undefined) {
      throw new Error(`${label}: отсутствует битрейт или режим`);
    }

    const cleanMount = s.mount.trim().replace(/^\/+/, '');

    if (seenSlugs.has(s.slug)) throw new Error(`Дублирующийся slug "${s.slug}" внутри бэкапа`);
    if (seenMounts.has(cleanMount)) throw new Error(`Дублирующаяся mount-точка "${cleanMount}" внутри бэкапа`);
    seenSlugs.add(s.slug);
    seenMounts.add(cleanMount);

    return {
      id: (typeof s.id === 'string' && s.id) || crypto.randomBytes(6).toString('hex'),
      slug: s.slug,
      name: s.name.trim(),
      mount: cleanMount,
      bitrate: s.bitrate,
      mode: s.mode,
      createdAt: (typeof s.createdAt === 'string' && s.createdAt) || new Date().toISOString(),
    };
  });

  return withWriteLock(() => {
    const newRegistry = {
      global: { port, sourcePassword, mediaBaseDir },
      stations: importedStations,
    };
    writeRegistryRaw(newRegistry);

    // Папки медиатеки могли не существовать (например, восстанавливаем
    // на свежий инстанс) — создаём пустыми, если их ещё нет. Обычно
    // предполагается, что сами файлы будут восстановлены/загружены
    // отдельно, этот бэкап их не переносит.
    const createdMediaDirs = [];
    for (const station of importedStations) {
      const dir = path.join(mediaBaseDir, station.slug);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        createdMediaDirs.push(station.slug);
      }
    }

    return {
      restoredStations: importedStations.map((s) => s.slug),
      createdMediaDirs,
    };
  });
}

module.exports = {
  listStations,
  getStationInternal,
  getStationPublic,
  getGlobalSettings,
  createStation,
  updateStationSettings,
  renameStation,
  deleteStation,
  updateGlobalSettings,
  updateMediaBaseDir,
  mediaDirFor,
  getMediaBaseDir,
  exportBackup,
  importBackup,
};
