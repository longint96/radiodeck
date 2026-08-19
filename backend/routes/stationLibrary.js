const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const { readTags, writeTags, isTagEditable } = require('../lib/tags');
const { getMediaInfo } = require('../lib/mediaInfo');
const { mediaDirFor } = require('../lib/stationRegistry');

// mergeParams — доступ к :stationId из родительского роутера, который его примонтировал
const router = express.Router({ mergeParams: true });

const ALLOWED_EXT = new Set(['.mp3', '.ogg', '.flac', '.wav', '.aac', '.m4a']);

function sanitizeFilename(name) {
  const base = path.basename(name);
  return base.replace(/[^\w\-. а-яА-ЯёЁ]/gu, '_');
}

/**
 * req.station устанавливается middleware stationAuth выше по цепочке —
 * здесь мы уже точно знаем, к какой станции обращаемся.
 */
function getMediaDir(req) {
  return mediaDirFor(req.station.slug);
}

function resolveMediaPath(req, rawName) {
  const mediaDir = getMediaDir(req);
  const safeName = sanitizeFilename(rawName);
  const filePath = path.join(mediaDir, safeName);
  if (!filePath.startsWith(path.resolve(mediaDir))) {
    throw new Error('Некорректный путь');
  }
  return { safeName, filePath, mediaDir };
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = getMediaDir(req);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, sanitizeFilename(file.originalname)),
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

// GET /api/stations/:stationId/library — список файлов медиатеки станции
router.get('/', async (req, res) => {
  const mediaDir = getMediaDir(req);
  fs.mkdirSync(mediaDir, { recursive: true });

  let entries;
  try {
    entries = await fs.promises.readdir(mediaDir, { withFileTypes: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  try {
    const files = await Promise.all(
      entries
        .filter((e) => e.isFile() && !e.name.startsWith('.tag-tmp-'))
        .map(async (e) => {
          const filePath = path.join(mediaDir, e.name);
          const stat = await fs.promises.stat(filePath);

          const entry = {
            name: e.name,
            sizeBytes: stat.size,
            modifiedAt: stat.mtime,
            tagsEditable: isTagEditable(filePath),
            title: '',
            artist: '',
            durationSeconds: null,
            bitrateKbps: null,
          };

          if (entry.tagsEditable) {
            try {
              const tags = await readTags(filePath);
              entry.title = tags.title;
              entry.artist = tags.artist;
            } catch {
              /* нет валидных тегов — оставляем пустыми */
            }
          }

          try {
            const info = await getMediaInfo(filePath);
            entry.durationSeconds = info.durationSeconds;
            entry.bitrateKbps = info.bitrateKbps;
          } catch {
            /* битый/нераспознанный файл — оставляем null, список не падает */
          }

          return entry;
        })
    );

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

// POST /api/stations/:stationId/library/upload
router.post('/upload', upload.array('files', 50), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'Файлы не переданы (поле "files")' });
  }
  res.json({
    uploaded: req.files.map((f) => ({ name: f.filename, sizeBytes: f.size })),
  });
});

// DELETE /api/stations/:stationId/library — удалить ВСЕ файлы медиатеки станции
router.delete('/', async (req, res) => {
  const mediaDir = getMediaDir(req);

  let entries;
  try {
    entries = await fs.promises.readdir(mediaDir, { withFileTypes: true });
  } catch {
    return res.json({ ok: true, deletedCount: 0 }); // папки нет — удалять нечего, не ошибка
  }

  const files = entries.filter((e) => e.isFile() && !e.name.startsWith('.tag-tmp-'));

  try {
    await Promise.all(files.map((e) => fs.promises.unlink(path.join(mediaDir, e.name))));
    res.json({ ok: true, deletedCount: files.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/stations/:stationId/library/:filename
router.delete('/:filename', (req, res) => {
  let safeName, filePath;
  try {
    ({ safeName, filePath } = resolveMediaPath(req, req.params.filename));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  fs.unlink(filePath, (err) => {
    if (err) return res.status(404).json({ error: 'Файл не найден' });
    res.json({ deleted: safeName });
  });
});

// GET /api/stations/:stationId/library/:filename/tags
router.get('/:filename/tags', async (req, res) => {
  let filePath;
  try {
    ({ filePath } = resolveMediaPath(req, req.params.filename));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Файл не найден' });
  }
  if (!isTagEditable(filePath)) {
    return res.status(400).json({ error: 'Редактирование тегов поддерживается только для MP3, OGG и FLAC' });
  }

  try {
    res.json(await readTags(filePath));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/stations/:stationId/library/:filename/tags
router.put('/:filename/tags', async (req, res) => {
  let filePath;
  try {
    ({ filePath } = resolveMediaPath(req, req.params.filename));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Файл не найден' });
  }
  if (!isTagEditable(filePath)) {
    return res.status(400).json({ error: 'Редактирование тегов поддерживается только для MP3, OGG и FLAC' });
  }

  const { title, artist, album, year, genre, trackNumber, comment } = req.body;
  try {
    await writeTags(filePath, { title, artist, album, year, genre, trackNumber, comment });
    res.json({ ok: true, tags: await readTags(filePath) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
