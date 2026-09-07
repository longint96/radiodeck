const { scanLibrary } = require('./mediaScan');

/**
 * Лёгкая сводка по медиатеке станции — счётчик и суммарная длительность,
 * для карточек на портале. Использует ТОТ ЖЕ персистентный кэш и тот же
 * сканер (mediaScan.scanLibrary), что и полный список медиатеки станции —
 * если админ уже открывал страницу станции (или наоборот, сначала
 * посмотрел портал), повторного разбора файлов не будет ни там, ни там.
 */
async function getLibrarySummary(mediaDir) {
  const files = await scanLibrary(mediaDir);
  return {
    count: files.length,
    totalDurationSeconds: files.reduce((sum, f) => sum + (f.durationSeconds || 0), 0),
  };
}

module.exports = { getLibrarySummary };
