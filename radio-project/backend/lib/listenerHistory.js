const fs = require('fs');
const path = require('path');

const registry = require('./stationRegistry');
const icecastStatus = require('./icecastStatus');

const MAX_ENTRIES = 2016; // ~7 суток при снятии раз в 5 минут (7*24*60/5)
const POLL_INTERVAL_MS = 5 * 60 * 1000;

function listenersDir() {
  if (!process.env.STATIONS_REGISTRY) return null;
  return path.join(path.dirname(process.env.STATIONS_REGISTRY), 'listeners');
}

function fileFor(slug) {
  return path.join(listenersDir(), `${slug}.json`);
}

function readHistoryRaw(slug) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(slug), 'utf8'));
  } catch {
    return [];
  }
}

function writeHistoryRaw(slug, entries) {
  const dir = listenersDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = fileFor(slug);
  const tempPath = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(entries), 'utf8');
  fs.renameSync(tempPath, target);
}

/**
 * Снимает срез числа слушателей по всем станциям разом (один запрос к
 * Icecast на все станции сразу, как и в playHistory/portal now-playing) —
 * офлайн-станции пишутся как 0, чтобы ряд не имел дыр для будущих графиков.
 */
async function pollOnce() {
  if (!listenersDir()) return;

  const global = registry.getGlobalSettings();
  const stations = registry.listStations();
  const { stations: nowPlaying } = await icecastStatus.getNowPlaying(stations, global.port);

  const timestamp = new Date().toISOString();
  for (const s of nowPlaying) {
    const entries = readHistoryRaw(s.slug);
    entries.push({ timestamp, listeners: s.online ? (s.listeners ?? 0) : 0 });
    writeHistoryRaw(s.slug, entries.slice(-MAX_ENTRIES));
  }
}

/**
 * Полная история слушателей станции, старые записи первыми (хронологически) —
 * удобно сразу для построения графика слева направо.
 */
function getHistory(slug) {
  return readHistoryRaw(slug);
}

/**
 * Запускает фоновый опрос. Работает независимо от того, открыт ли
 * портал в браузере.
 */
function startPolling(intervalMs = POLL_INTERVAL_MS) {
  pollOnce().catch(() => {});
  setInterval(() => pollOnce().catch(() => {}), intervalMs);
}

module.exports = { startPolling, getHistory, pollOnce };
