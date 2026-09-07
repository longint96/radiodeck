const fs = require('fs');
const path = require('path');
const mm = require('music-metadata');

const { listFilesRecursive } = require('./safePath');

const CACHE_FILENAME = '.library-cache.json';
const SCAN_CONCURRENCY = 8; // сколько файлов парсим одновременно за один проход

/**
 * Ограничивает параллелизм: вместо Promise.all(items.map(fn)) — который для
 * 900 файлов ранее запускал 900 параллельных чтений разом (а с ffprobe —
 * 900 одновременных дочерних процессов, отсюда 7-10 минут на список) —
 * держит не больше `limit` одновременных операций.
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

function cacheFilePath(mediaDir) {
  return path.join(mediaDir, CACHE_FILENAME);
}

function readCache(mediaDir) {
  try {
    return JSON.parse(fs.readFileSync(cacheFilePath(mediaDir), 'utf8'));
  } catch {
    return {}; // кэша ещё нет или он битый — просто пересканируем всё заново
  }
}

function writeCache(mediaDir, cache) {
  try {
    const tempPath = `${cacheFilePath(mediaDir)}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(cache), 'utf8');
    fs.renameSync(tempPath, cacheFilePath(mediaDir));
  } catch {
    /* не смогли записать кэш — не критично, просто пересканируем в следующий раз */
  }
}

/**
 * Разбирает один файл: теги + длительность + битрейт за один проход через
 * music-metadata (парсинг заголовков внутри процесса Node, без дочернего
 * процесса ffprobe). node-id3/ffmpeg по-прежнему используются отдельно —
 * но только для ЗАПИСИ тегов (см. tags.js), не для этого чтения.
 */
async function parseFile(absPath) {
  try {
    const metadata = await mm.parseFile(absPath, { duration: true, skipCovers: true });
    const { common, format } = metadata;
    return {
      title: common.title || '',
      artist: common.artist || common.albumartist || '',
      durationSeconds: format.duration != null ? Math.round(format.duration) : null,
      bitrateKbps: format.bitrate != null ? Math.round(format.bitrate / 1000) : null,
    };
  } catch {
    return { title: '', artist: '', durationSeconds: null, bitrateKbps: null };
  }
}

/**
 * Сканирует всю медиатеку станции (рекурсивно, с подпапками). Использует
 * персистентный кэш на диске (переживает рестарт панели) — файл
 * пересканируется заново только если изменились его mtime/размер, иначе
 * метаданные берутся из кэша мгновенно, без единого обращения к
 * music-metadata.
 *
 * Сам первый проход (когда кэша ещё нет) тоже не должен занимать 7-10
 * минут — используется ограниченный параллелизм (SCAN_CONCURRENCY) вместо
 * неограниченного Promise.all.
 */
async function scanLibrary(mediaDir) {
  const relPaths = await listFilesRecursive(mediaDir);
  const cache = readCache(mediaDir);
  const nextCache = {};

  const results = await mapWithConcurrency(relPaths, SCAN_CONCURRENCY, async (relPath) => {
    const absPath = path.join(mediaDir, relPath);
    const stat = await fs.promises.stat(absPath);

    const cached = cache[relPath];
    let meta;
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      meta = cached.meta;
    } else {
      meta = await parseFile(absPath);
    }

    nextCache[relPath] = { mtimeMs: stat.mtimeMs, size: stat.size, meta };

    return {
      name: relPath,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime,
      title: meta.title,
      artist: meta.artist,
      durationSeconds: meta.durationSeconds,
      bitrateKbps: meta.bitrateKbps,
    };
  });

  // Кэш перезаписываем ТОЛЬКО актуальными записями (nextCache), не старым
  // cache целиком — так удалённые файлы сами по себе выпадают из кэша,
  // не нужно отдельной чистки
  writeCache(mediaDir, nextCache);

  return results;
}

module.exports = { scanLibrary, mapWithConcurrency };
