// Icecast отдаёт публичный (без авторизации) JSON-статус со списком реально
// подключённых источников. Используем это как источник правды для
// "станция онлайн/офлайн" — в отличие от статуса systemd-сервиса, здесь
// видно именно то, вещает ли КОНКРЕТНАЯ станция прямо сейчас, а не просто
// "процесс liquidsoap жив".

const AUDIO_EXT_RE = /\.(mp3|ogg|flac|wav|aac|m4a)$/i;

/**
 * Если у трека пустые теги, liquidsoap (см. radio.liq, fallback_title)
 * подставляет вместо title полный путь к файлу — иначе трек вообще выпал
 * бы из "сейчас играет"/истории. Здесь сокращаем этот путь до последних
 * двух сегментов ("папка/имя_файла.mp3"), чтобы не показывать в интерфейсе
 * длинный абсолютный путь вида "/mediateka/radio/rock/album1/track.mp3".
 * Настоящие теги (не похожие на путь к файлу) не трогаем вообще.
 */
function prettifyTitle(rawTitle) {
  if (!rawTitle) return rawTitle;
  if (rawTitle.includes('/') && AUDIO_EXT_RE.test(rawTitle)) {
    const parts = rawTitle.split('/').filter(Boolean);
    return parts.slice(-2).join('/');
  }
  return rawTitle;
}

async function fetchIcecastStatus(port) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`http://localhost:${port}/status-json.xsl`, {
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Icecast status-json вернул ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Возвращает Map<mount без ведущего слэша, {online, title, listeners}>
 * по всем реально подключённым источникам Icecast.
 */
async function getMountStatuses(port) {
  const map = new Map();

  let data;
  try {
    data = await fetchIcecastStatus(port);
  } catch (err) {
    // Icecast недоступен — возвращаем пустую карту, вызывающий код
    // трактует отсутствие записи как "офлайн"
    return { map, error: err.message };
  }

  const raw = data?.icestats?.source;
  // Icecast отдаёт ОБЪЕКТ, если источник один, и МАССИВ, если их несколько —
  // частая ловушка при разборе status-json.xsl
  const sources = !raw ? [] : Array.isArray(raw) ? raw : [raw];

  for (const src of sources) {
    let mount = (src.mount || '').replace(/^\/+/, '');

    // Icecast 2.4.4 (и не только) не всегда отдаёт поле "mount" напрямую —
    // тогда достаём его из listenurl (всегда присутствует и содержит
    // полный URL вида http://host:port/<mount>)
    if (!mount && src.listenurl) {
      try {
        mount = new URL(src.listenurl).pathname.replace(/^\/+/, '');
      } catch {
        /* битый URL — пропускаем источник */
      }
    }

    if (!mount) continue;
    map.set(mount, {
      online: true,
      title: prettifyTitle(src.title || src.yp_currently_playing || null),
      listeners: typeof src.listeners === 'number' ? src.listeners : null,
    });
  }

  return { map, error: null };
}

/**
 * Сопоставляет список станций из реестра с их живым статусом в Icecast.
 */
async function getNowPlaying(stations, port) {
  const { map, error } = await getMountStatuses(port);

  return {
    error,
    stations: stations.map((s) => {
      const status = map.get(s.mount);
      return {
        id: s.id,
        slug: s.slug,
        online: !!status,
        title: status?.title || null,
        listeners: status?.listeners ?? null,
      };
    }),
  };
}

module.exports = { getNowPlaying };
