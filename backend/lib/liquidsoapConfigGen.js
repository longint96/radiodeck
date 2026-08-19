const fs = require('fs');
const path = require('path');

const { listStations, getGlobalSettings, mediaDirFor } = require('./stationRegistry');

const GLOBAL_CONFIG_PATH = process.env.LIQUIDSOAP_GLOBAL_CONFIG;
const STATIONS_CONFIG_PATH = process.env.LIQUIDSOAP_STATIONS_CONFIG;
const ICECAST_CONFIG_PATH = process.env.ICECAST_CONFIG;

function escapeLiquidsoapString(str) {
  // Экранируем кавычки и обратные слэши для вставки в строковый литерал liquidsoap
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function renderGlobalLiq(global) {
  return `### Этот файл автоматически перезаписывается порталом.
### Не редактируйте вручную — изменения будут потеряны при следующем
### сохранении глобальных настроек или создании/удалении станции.

# Единый порт Icecast для всех станций (различаются mount-точкой)
radio_port = ${global.port}

# Пароль источника — используется liquidsoap для подключения к Icecast.
# Должен совпадать с <source-password> в icecast/icecast.xml
radio_source_password = "${escapeLiquidsoapString(global.sourcePassword)}"
`;
}

function renderStationsLiq(stations) {
  const entries = stations.map((s) => {
    const mediaDir = escapeLiquidsoapString(mediaDirFor(s.slug));
    return `  {id="${s.id}", slug="${escapeLiquidsoapString(s.slug)}", ` +
      `media_dir="${mediaDir}", mode="${s.mode}", bitrate=${s.bitrate}, ` +
      `mount="${escapeLiquidsoapString(s.mount)}"}`;
  });

  return `### Этот файл автоматически перезаписывается порталом при создании,
### удалении или изменении настроек станции. Не редактируйте вручную.

stations = [
${entries.join(',\n')}
]
`;
}

function syncIcecastConfig(global, stationsCount) {
  let xml = fs.readFileSync(ICECAST_CONFIG_PATH, 'utf8');
  xml = xml.replace(/<port>\d+<\/port>/, `<port>${global.port}</port>`);
  xml = xml.replace(/<source-password>[^<]*<\/source-password>/, `<source-password>${global.sourcePassword}</source-password>`);
  // Держим лимит источников с запасом над фактическим числом станций
  const sourcesLimit = Math.max(10, stationsCount + 10);
  xml = xml.replace(/<sources>\d+<\/sources>/, `<sources>${sourcesLimit}</sources>`);
  fs.writeFileSync(ICECAST_CONFIG_PATH, xml, 'utf8');
}

/**
 * Полная регенерация всех конфигов движка из текущего состояния реестра.
 * Вызывается после любого изменения станций или глобальных настроек.
 * НЕ перезапускает сервисы — изменения применяются отдельным вызовом restart.
 */
function regenerate() {
  const global = getGlobalSettings();
  const stations = listStations();

  fs.writeFileSync(GLOBAL_CONFIG_PATH, renderGlobalLiq(global), 'utf8');
  fs.writeFileSync(STATIONS_CONFIG_PATH, renderStationsLiq(stations), 'utf8');
  syncIcecastConfig(global, stations.length);
}

module.exports = { regenerate };
