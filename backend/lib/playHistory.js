const fs = require('fs');
const path = require('path');

const registry = require('./stationRegistry');
const icecastStatus = require('./icecastStatus');

const MAX_ENTRIES = 50;
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 суток — записи старше отсекаются

function pruneOld(entries) {
  const cutoff = Date.now() - MAX_AGE_MS;
  return entries.filter((e) => new Date(e.playedAt).getTime() >= cutoff);
}

function historyDir() {
  if (!process.env.STATIONS_REGISTRY) return null;
  return path.join(path.dirname(process.env.STATIONS_REGISTRY), 'history');
}

function historyFilePath(slug) {
  return path.join(historyDir(), `${slug}.json`);
}

function readHistoryRaw(slug) {
  try {
    return JSON.parse(fs.readFileSync(historyFilePath(slug), 'utf8'));
  } catch {
    return []; // файла ещё нет или он битый — начинаем с пустой истории
  }
}

function writeHistoryRaw(slug, entries) {
  const dir = historyDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = historyFilePath(slug);
  const tempPath = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(entries, null, 2), 'utf8');
  fs.renameSync(tempPath, target);
}

// В памяти держим последний известный title на станцию — чтобы не читать
// файл с диска на каждый тик поллинга просто ради сравнения "изменилось ли".
// Сбрасывается при перезапуске панели — в худшем случае один трек, который
// уже был последним в истории, залогируется повторно один раз после рестарта.
const lastKnownTitle = new Map(); // slug -> title

function appendIfChanged(slug, title) {
  if (lastKnownTitle.get(slug) === title) return;
  lastKnownTitle.set(slug, title);

  const entries = pruneOld(readHistoryRaw(slug));
  entries.push({ title, playedAt: new Date().toISOString() });
  writeHistoryRaw(slug, entries.slice(-MAX_ENTRIES));
}

async function pollOnce() {
  if (!historyDir()) return;

  const global = registry.getGlobalSettings();
  const stations = registry.listStations();
  const { stations: nowPlaying } = await icecastStatus.getNowPlaying(stations, global.port);

  for (const s of nowPlaying) {
    if (s.online && s.title) {
      appendIfChanged(s.slug, s.title);
    }
  }
}

/**
 * Последние записи истории для станции, новые сверху. Отсекает записи
 * старше MAX_AGE_MS даже если новых треков давно не было (иначе устаревшая
 * запись могла бы висеть в истории сколько угодно, пока станция офлайн).
 */
function getHistory(slug) {
  return pruneOld(readHistoryRaw(slug)).slice().reverse();
}

/**
 * Полностью очищает историю станции — по кнопке в админке.
 * Сбрасывает и in-memory кэш last-known-title, чтобы следующий реально
 * играющий трек сразу залогировался, а не был принят за "то же самое".
 */
function clearHistory(slug) {
  writeHistoryRaw(slug, []);
  lastKnownTitle.delete(slug);
}

/**
 * Запускает фоновый опрос. Работает независимо от того, открыт ли
 * портал в браузере — история пишется, пока жив процесс панели.
 */
function startPolling(intervalMs = 15000) {
  pollOnce().catch(() => {});
  setInterval(() => pollOnce().catch(() => {}), intervalMs);
}

module.exports = { startPolling, getHistory, clearHistory, pollOnce };
