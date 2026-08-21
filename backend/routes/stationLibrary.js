const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const { readTags, writeTags, isTagEditable } = require('../lib/tags');
const { scanLibrary } = require('../lib/mediaScan');
const { mediaDirFor } = require('../lib/stationRegistry');
const { sanitizeSegment, sanitizeRelativePath, sanitizeFolderPath, listFilesRecursive } = require('../lib/safePath');

// mergeParams — доступ к :stationId из родительского роутера, который его примонтировал
const router = express.Router({ mergeParams: true });

const ALLOWED_EXT = new Set(['.mp3', '.ogg', '.flac', '.wav', '.aac', '.m4a']);

/**
 * req.station устанавливается middleware stationAuth выше по цепочке —
 * здесь мы уже точно знаем, к какой станции обращаемся.
 */
function getMediaDir(req) {
  return mediaDirFor(req.station.slug);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      // Целевая подпапка передаётся через query-параметр (?folder=...), а не
      // поле формы — так она гарантированно доступна ДО того, как multer
      // начнёт разбирать сам multipart-поток с файлами (в отличие от полей
      // формы, порядок которых в теле запроса не гарантирован)
      const { absPath } = sanitizeFolderPath(getMediaDir(req), req.query.folder || '');
      fs.mkdirSync(absPath, { recursive: true });
      cb(null, absPath);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => cb(null, sanitizeSegment(file.originalname)),
});

const upload = multer({
  storage,
  limits: { fileSize: (parseInt(process.env.MAX_UPLOAD_MB || '1024', 10)) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      return cb(new Error(`Недопустимый формат файла: ${ext}`));
    }
    cb(null, true);
  },
});

// GET /api/stations/:stationId/library — рекурсивный список файлов медиатеки
// (включая подпапки). "name" в ответе — относительный путь от корня медиатеки
// станции, например "album1/track.mp3", а не просто имя файла.
//
// Метаданные (теги, длительность, битрейт) читаются через scanLibrary —
// единый проход через music-metadata (без дочерних процессов ffprobe на
// каждый файл) с постоянным кэшем на диске по mtime/размеру. Раньше здесь
// был неограниченный Promise.all, который на 900 файлах запускал до 900
// одновременных ffprobe-подпроцессов и занимал 7-10 минут.
router.get('/', async (req, res) => {
  const mediaDir = getMediaDir(req);
  fs.mkdirSync(mediaDir, { recursive: true });

  try {
    const scanned = await scanLibrary(mediaDir);

    const files = scanned.map((f) => ({
      ...f,
      tagsEditable: isTagEditable(path.join(mediaDir, f.name)),
    }));

    files.sort((a, b) => a.name.localeCompare(b.name, 'ru'));

    const totalDurationSeconds = files.reduce(
      (sum, f) => sum + (f.durationSeconds || 0),
      0
    );

    res.json({ files, count: files.length, totalDurationSeconds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stations/:stationId/library/upload?folder=album1%2Fsub — загрузка
// файлов, опционально в указанную подпапку (создаётся автоматически)
router.post('/upload', upload.array('files', 50), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'Файлы не переданы (поле "files")' });
  }
  const mediaDir = getMediaDir(req);
  res.json({
    uploaded: req.files.map((f) => ({
      name: path.relative(mediaDir, f.path).split(path.sep).join('/'),
      sizeBytes: f.size,
    })),
  });
});

// DELETE /api/stations/:stationId/library — удалить ВСЮ медиатеку станции
// (включая все подпапки) и создать заново уже пустой корень
router.delete('/', async (req, res) => {
  const mediaDir = getMediaDir(req);
  try {
    const relPaths = await listFilesRecursive(mediaDir);
    await fs.promises.rm(mediaDir, { recursive: true, force: true });
    await fs.promises.mkdir(mediaDir, { recursive: true });
    res.json({ ok: true, deletedCount: relPaths.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/stations/:stationId/library/file?path=album1%2Ftrack.mp3
// Путь передаётся через query-параметр, а не URL-сегмент — некоторые
// конфигурации nginx/реверс-прокси нормализуют "%2F" обратно в "/" прямо
// в пути ДО того, как запрос дойдёт до Node, что незаметно сломало бы
// адресацию файлов в подпапках. Query-строку прокси такой нормализации
// обычно не подвергают.
router.delete('/file', (req, res) => {
  let relPath, absPath;
  try {
    ({ relPath, absPath } = sanitizeRelativePath(getMediaDir(req), req.query.path || ''));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  fs.unlink(absPath, (err) => {
    if (err) return res.status(404).json({ error: 'Файл не найден' });
    res.json({ deleted: relPath });
  });
});

// GET /api/stations/:stationId/library/file/tags?path=album1%2Ftrack.mp3
router.get('/file/tags', async (req, res) => {
  let absPath;
  try {
    ({ absPath } = sanitizeRelativePath(getMediaDir(req), req.query.path || ''));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (!fs.existsSync(absPath)) {
    return res.status(404).json({ error: 'Файл не найден' });
  }
  if (!isTagEditable(absPath)) {
    return res.status(400).json({ error: 'Редактирование тегов поддерживается только для MP3, OGG и FLAC' });
  }

  try {
    res.json(await readTags(absPath));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/stations/:stationId/library/file/tags?path=album1%2Ftrack.mp3
router.put('/file/tags', async (req, res) => {
  let absPath;
  try {
    ({ absPath } = sanitizeRelativePath(getMediaDir(req), req.query.path || ''));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (!fs.existsSync(absPath)) {
    return res.status(404).json({ error: 'Файл не найден' });
  }
  if (!isTagEditable(absPath)) {
    return res.status(400).json({ error: 'Редактирование тегов поддерживается только для MP3, OGG и FLAC' });
  }

  const { title, artist, album, year, genre, trackNumber, comment } = req.body;
  try {
    await writeTags(absPath, { title, artist, album, year, genre, trackNumber, comment });
    res.json({ ok: true, tags: await readTags(absPath) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
