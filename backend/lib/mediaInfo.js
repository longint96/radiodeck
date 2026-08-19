const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function execFileAsync(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 5 * 1024 * 1024, timeout: 15000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.toString().trim() || err.message));
      resolve(stdout.toString());
    });
  });
}

// Кэш по пути файла: сбрасываем результат, если файл изменился (mtime/размер).
// Живёт в памяти процесса — переживать перезапуски панели ему не нужно,
// после рестарта ffprobe просто отработает заново по каждому файлу один раз.
const cache = new Map(); // filePath -> { mtimeMs, size, durationSeconds, bitrateKbps }

async function getMediaInfo(filePath) {
  const stat = await fs.promises.stat(filePath);

  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return { durationSeconds: cached.durationSeconds, bitrateKbps: cached.bitrateKbps };
  }

  let durationSeconds = null;
  let bitrateKbps = null;

  try {
    const stdout = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration,bit_rate:stream=bit_rate',
      '-of', 'json',
      filePath,
    ]);
    const parsed = JSON.parse(stdout);

    const rawDuration = parsed.format?.duration;
    if (rawDuration && !Number.isNaN(parseFloat(rawDuration))) {
      durationSeconds = Math.round(parseFloat(rawDuration));
    }

    // Средний битрейт файла — предпочитаем format.bit_rate (учитывает контейнер
    // целиком), при его отсутствии берём битрейт первого аудиопотока
    const rawBitrate = parsed.format?.bit_rate ?? parsed.streams?.[0]?.bit_rate;
    if (rawBitrate && !Number.isNaN(parseInt(rawBitrate, 10))) {
      bitrateKbps = Math.round(parseInt(rawBitrate, 10) / 1000);
    }
  } catch {
    // Битый/нераспознанный файл — просто возвращаем null-значения,
    // список медиатеки не должен падать из-за одного плохого файла
  }

  cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, durationSeconds, bitrateKbps });
  return { durationSeconds, bitrateKbps };
}

/**
 * Лёгкая сводка по медиатеке станции — только счётчик и суммарная
 * длительность, без чтения ID3/Vorbis-тегов (те не нужны для карточки
 * портала). Использует тот же кэш по mtime, что и getMediaInfo — если
 * админ уже открывал страницу этой станции, длительности файлов уже
 * в кэше и повторных вызовов ffprobe не будет.
 */
async function getLibrarySummary(mediaDir) {
  let entries;
  try {
    entries = await fs.promises.readdir(mediaDir, { withFileTypes: true });
  } catch {
    return { count: 0, totalDurationSeconds: 0 };
  }

  const files = entries.filter((e) => e.isFile() && !e.name.startsWith('.tag-tmp-'));

  const durations = await Promise.all(
    files.map(async (e) => {
      try {
        const info = await getMediaInfo(path.join(mediaDir, e.name));
        return info.durationSeconds || 0;
      } catch {
        return 0;
      }
    })
  );

  return {
    count: files.length,
    totalDurationSeconds: durations.reduce((sum, d) => sum + d, 0),
  };
}

module.exports = { getMediaInfo, getLibrarySummary };
