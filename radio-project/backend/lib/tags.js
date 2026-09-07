const NodeID3 = require('node-id3');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const ID3_EXT = new Set(['.mp3']);
const VORBIS_EXT = new Set(['.ogg', '.flac']);

function getBackend(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ID3_EXT.has(ext)) return 'id3';
  if (VORBIS_EXT.has(ext)) return 'vorbis';
  return null;
}

function isTagEditable(filePath) {
  return getBackend(filePath) !== null;
}

function execFileAsync(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.toString().trim() || err.message));
      resolve(stdout.toString());
    });
  });
}

function normalizeTags(raw) {
  return {
    title: raw.title || '',
    artist: raw.artist || '',
    album: raw.album || '',
    year: raw.year || '',
    genre: raw.genre || '',
    trackNumber: raw.trackNumber || '',
    comment: raw.comment || '',
  };
}

// ============================================================
// Бэкенд 1: ID3v2 (mp3) — через node-id3, синхронно
// ============================================================

function readTagsId3(filePath) {
  const raw = NodeID3.read(filePath) || {};
  return normalizeTags({
    title: raw.title,
    artist: raw.artist,
    album: raw.album,
    year: raw.year,
    genre: raw.genre,
    trackNumber: raw.trackNumber,
    comment: raw.comment && raw.comment.text,
  });
}

function writeTagsId3(filePath, tags) {
  const payload = {};
  if (tags.title !== undefined) payload.title = String(tags.title);
  if (tags.artist !== undefined) payload.artist = String(tags.artist);
  if (tags.album !== undefined) payload.album = String(tags.album);
  if (tags.year !== undefined) payload.year = String(tags.year);
  if (tags.genre !== undefined) payload.genre = String(tags.genre);
  if (tags.trackNumber !== undefined) payload.trackNumber = String(tags.trackNumber);
  if (tags.comment !== undefined) {
    payload.comment = { language: 'eng', text: String(tags.comment) };
  }

  const success = NodeID3.update(payload, filePath);
  if (!success) {
    throw new Error('Не удалось записать ID3-теги в файл');
  }
}

// ============================================================
// Бэкенд 2: Vorbis Comments (ogg, flac) — через ffprobe/ffmpeg
//
// Пишем через "-c copy" (стрим-копирование, без переэнкодинга) во
// временный файл рядом с оригиналом и атомарно переименовываем поверх —
// это не портит аудио и не оставляет файл в промежуточном состоянии
// при сбое посреди записи.
// ============================================================

async function readTagsVorbis(filePath) {
  let stdout;
  try {
    stdout = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-print_format', 'json',
      '-show_entries', 'format_tags:stream_tags',
      filePath,
    ]);
  } catch (err) {
    throw new Error(`ffprobe недоступен или не смог прочитать файл: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = {};
  }

  // FLAC/MP3 отдают теги на уровне контейнера (format.tags), а OGG —
  // на уровне потока (streams[0].tags). Сливаем оба источника, чтобы
  // одна и та же логика работала для всех Vorbis-контейнеров.
  const formatTags = (parsed.format && parsed.format.tags) || {};
  const streamTags = (parsed.streams && parsed.streams[0] && parsed.streams[0].tags) || {};
  const rawTags = { ...streamTags, ...formatTags };

  const tags = {};
  Object.keys(rawTags).forEach((k) => { tags[k.toLowerCase()] = rawTags[k]; });

  return normalizeTags({
    title: tags.title,
    artist: tags.artist,
    album: tags.album,
    year: tags.date || tags.year,
    genre: tags.genre,
    trackNumber: tags.track || tags.tracknumber,
    comment: tags.comment,
  });
}

async function writeTagsVorbis(filePath, tags) {
  // Незаданные поля сохраняем как есть — читаем текущее состояние и мёржим
  const current = await readTagsVorbis(filePath).catch(() => normalizeTags({}));

  const merged = {
    title: tags.title !== undefined ? String(tags.title) : current.title,
    artist: tags.artist !== undefined ? String(tags.artist) : current.artist,
    album: tags.album !== undefined ? String(tags.album) : current.album,
    date: tags.year !== undefined ? String(tags.year) : current.year,
    genre: tags.genre !== undefined ? String(tags.genre) : current.genre,
    tracknumber: tags.trackNumber !== undefined ? String(tags.trackNumber) : current.trackNumber,
    comment: tags.comment !== undefined ? String(tags.comment) : current.comment,
  };

  const ext = path.extname(filePath);
  const tempPath = path.join(
    path.dirname(filePath),
    `.tag-tmp-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
  );

  const metadataArgs = [];
  Object.entries(merged).forEach(([key, value]) => {
    // FLAC хранит Vorbis Comments на уровне контейнера (format),
    // OGG — на уровне потока (stream). Пишем в оба места одной командой,
    // чтобы не разветвлять логику по конкретному расширению.
    metadataArgs.push('-metadata', `${key}=${value}`);
    metadataArgs.push('-metadata:s:0', `${key}=${value}`);
  });

  const args = [
    '-y',
    '-i', filePath,
    '-map', '0',
    '-c', 'copy',
    ...metadataArgs,
    tempPath,
  ];

  try {
    await execFileAsync('ffmpeg', args);
  } catch (err) {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    throw new Error(`Не удалось записать теги через ffmpeg: ${err.message}`);
  }

  fs.renameSync(tempPath, filePath);
}

// ============================================================
// Общий интерфейс — routes/library.js работает только с этими функциями
// ============================================================

async function readTags(filePath) {
  const backend = getBackend(filePath);
  if (backend === 'id3') return readTagsId3(filePath);
  if (backend === 'vorbis') return readTagsVorbis(filePath);
  throw new Error('Формат файла не поддерживает редактирование тегов');
}

async function writeTags(filePath, tags) {
  const backend = getBackend(filePath);
  if (backend === 'id3') return writeTagsId3(filePath, tags);
  if (backend === 'vorbis') return writeTagsVorbis(filePath, tags);
  throw new Error('Формат файла не поддерживает редактирование тегов');
}

module.exports = { readTags, writeTags, isTagEditable };
