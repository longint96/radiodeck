const fs = require('fs');
const path = require('path');

/**
 * Санитизирует ОДИН сегмент имени (файла или папки) — как раньше для
 * плоских имён файлов, просто вырезаны "/" и "\", раз это уже сегмент.
 */
function sanitizeSegment(name) {
  return String(name).replace(/[^\w\-. а-яА-ЯёЁ]/gu, '_');
}

/**
 * Санитизирует ОТНОСИТЕЛЬНЫЙ путь (может содержать подпапки через "/"):
 * очищает каждый сегмент отдельно, отбрасывает "." и ".." (не ошибка —
 * просто выкидываются из пути, как явно вредоносные/бессмысленные), затем
 * ОБЯЗАТЕЛЬНО проверяет, что итоговый абсолютный путь не вышел за пределы
 * mediaDir — это и есть настоящая защита от path traversal, очистка имён
 * сама по себе достаточной защитой не является.
 */
function sanitizeRelativePath(mediaDir, rawRelPath) {
  const parts = String(rawRelPath)
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p !== '' && p !== '.' && p !== '..')
    .map(sanitizeSegment)
    .filter((p) => p !== ''); // сегмент мог стать пустым после очистки спецсимволов

  if (parts.length === 0) {
    throw new Error('Пустой или некорректный путь к файлу');
  }

  const relPath = parts.join('/');
  const mediaDirResolved = path.resolve(mediaDir);
  const absPath = path.resolve(mediaDirResolved, relPath);

  if (absPath !== mediaDirResolved && !absPath.startsWith(mediaDirResolved + path.sep)) {
    throw new Error('Некорректный путь — попытка выйти за пределы медиатеки');
  }

  return { relPath, absPath };
}

/**
 * То же самое, но для ЦЕЛЕВОЙ ПАПКИ при загрузке (может быть пустой строкой —
 * загрузка в корень медиатеки станции). В отличие от sanitizeRelativePath
 * не требует существования файла на конце — просто путь до директории.
 */
function sanitizeFolderPath(mediaDir, rawFolder) {
  if (!rawFolder) return { relPath: '', absPath: path.resolve(mediaDir) };

  const parts = String(rawFolder)
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p !== '' && p !== '.' && p !== '..')
    .map(sanitizeSegment)
    .filter((p) => p !== '');

  const relPath = parts.join('/');
  const mediaDirResolved = path.resolve(mediaDir);
  const absPath = relPath ? path.resolve(mediaDirResolved, relPath) : mediaDirResolved;

  if (absPath !== mediaDirResolved && !absPath.startsWith(mediaDirResolved + path.sep)) {
    throw new Error('Некорректный путь папки — попытка выйти за пределы медиатеки');
  }

  return { relPath, absPath };
}

/**
 * Рекурсивно обходит директорию, возвращает список файлов в виде
 * относительных путей (через "/", независимо от ОС). Скрытые и служебные
 * файлы/папки (начинающиеся с ".", включая .tag-tmp-*) пропускаются.
 */
async function listFilesRecursive(baseDir, currentRelDir = '') {
  const fullDir = currentRelDir ? path.join(baseDir, currentRelDir) : baseDir;

  let entries;
  try {
    entries = await fs.promises.readdir(fullDir, { withFileTypes: true });
  } catch {
    return [];
  }

  let results = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const relPath = currentRelDir ? `${currentRelDir}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      const nested = await listFilesRecursive(baseDir, relPath);
      results = results.concat(nested);
    } else if (entry.isFile()) {
      results.push(relPath);
    }
  }
  return results;
}

module.exports = { sanitizeSegment, sanitizeRelativePath, sanitizeFolderPath, listFilesRecursive };
