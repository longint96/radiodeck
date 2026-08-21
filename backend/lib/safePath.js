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
 * Санитизирует ОТНОСИТЕЛЬНЫЙ путь к УЖЕ СУЩЕСТВУЮЩЕМУ файлу (может
 * содержать подпапки через "/"): отбрасывает "." и ".." (явно вредоносные/
 * бессмысленные сегменты), затем ОБЯЗАТЕЛЬНО проверяет, что итоговый
 * абсолютный путь не вышел за пределы mediaDir — это и есть настоящая
 * защита от path traversal.
 *
 * ВАЖНО: здесь НЕ применяется sanitizeSegment (замена "необычных" символов
 * на "_") — в отличие от создания НОВОГО имени файла, здесь мы ищем уже
 * существующий файл на диске, и его реальное имя менять нельзя. Файлы,
 * загруженные в обход панели (например через WinSCP), могут легально
 * содержать скобки, апострофы и другие символы вне узкого вайтлиста
 * sanitizeSegment — если бы мы их всё равно "очищали" при поиске, путь
 * переставал бы совпадать с реальным файлом на диске, и любая операция
 * (удаление, чтение/запись тегов) падала бы с "файл не найден", хотя
 * файл физически на месте. Путь traversal-защите резать символы не нужно —
 * достаточно проверки path.resolve() + startsWith ниже.
 */
function sanitizeRelativePath(mediaDir, rawRelPath) {
  const parts = String(rawRelPath)
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p !== '' && p !== '.' && p !== '..');

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
 * загрузка в корень медиатеки станции). Так же БЕЗ sanitizeSegment — по той
 * же причине: если загружаемый файл кладётся в уже существующую папку
 * (например, созданную через WinSCP с "необычными" символами в имени),
 * очистка символов создала бы ДРУГУЮ папку вместо той, что реально нужна.
 */
function sanitizeFolderPath(mediaDir, rawFolder) {
  if (!rawFolder) return { relPath: '', absPath: path.resolve(mediaDir) };

  const parts = String(rawFolder)
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p !== '' && p !== '.' && p !== '..');

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
