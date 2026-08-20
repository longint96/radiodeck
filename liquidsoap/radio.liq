#!/usr/bin/liquidsoap

# =============================================================
#  Radio Deck — мультистанционный движок вещания
#
#  Этот файл СТАТИЧЕСКИЙ и не меняется порталом. Он определяет
#  логику "как собрать одну станцию" и применяет её к списку
#  станций из stations.liq (генерируется порталом).
#
#  Добавление/удаление станции или смена битрейта/режима
#  требует перезапуска ВСЕГО процесса — все станции работают
#  в одном liquidsoap-процессе, это осознанный компромисс
#  в пользу простоты (см. README, раздел "Архитектура").
#
#  Добавление/удаление ФАЙЛОВ в медиатеку станции перезапуска
#  НЕ требует — плейлист следит за папкой (reload_mode="watch").
# =============================================================

settings.log.level := 3
settings.log.stdout := true

log_dir = getenv("/home/claude/radio-project/logs", "RADIO_LOG_DIR")
settings.log.file.path := path.concat(log_dir, "radio.log")

# Локальный telnet-сервер для диагностики (skip трека и т.п.)
settings.server.telnet := true
settings.server.telnet.bind_addr := "127.0.0.1"
settings.server.telnet.port := 1234

# Подключаем сгенерированные порталом файлы:
#   global.liq    — общий порт и пароль источника Icecast
#   stations.liq  — список станций (id, slug, media_dir, mode, bitrate, mount)
%include "global.liq"
%include "stations.liq"

# --- Сборка одной станции --------------------------------------
#
# station — запись вида:
#   {id="a1b2c3", slug="rock-fm", media_dir="/.../media/rock-fm",
#    mode="normal", bitrate=128, mount="rock-fm.mp3"}

def make_station(station) =
  playlist_mode = if station.mode == "random" then "randomize" else "normal" end

  radio =
    playlist(
      id="playlist_#{station.id}",
      mode=playlist_mode,
      reload=30,
      reload_mode="watch",
      station.media_dir
    )

  # Защита от пустого плейлиста / тишины
  radio = mksafe(radio)

  # Плавные переходы между треками
  radio = crossfade(radio, duration=3.)

  # --- Обработка звука: выравнивание громкости + защита от клиппинга ---
  # normalize — постепенно подтягивает средний уровень треков к единой
  # целевой громкости (тихие треки громче, громкие — тише).
  # compress — сглаживает пики поверх этого, чтобы резкие громкие места
  # не проскакивали в клиппинг. Оба оператора применяются ДО объединения
  # с тишиной-заглушкой ниже — иначе AGC пытался бы "усилить" тишину,
  # гоняясь за целевым уровнем там, где усиливать нечего.
  radio = normalize(radio)
  radio = compress(radio)

  # Резервный источник на случай полностью пустой медиатеки станции
  security = mksafe(blank(id="silence_#{station.id}"))
  radio = fallback(id="fallback_#{station.id}", track_sensitive=false, [radio, security])

  # Каждая станция вещает на общий Icecast-порт, но на свою mount-точку
  output.icecast(
    %mp3(bitrate=station.bitrate),
    id="out_#{station.id}",
    host="localhost",
    port=radio_port,
    password=radio_source_password,
    mount=station.mount,
    radio
  )
end

# --- Применяем ко всем станциям из реестра ----------------------

list.iter(make_station, stations)

# Если станций пока нет (совсем новая установка, либо все станции
# удалены) — ни один make_station не создаст output.icecast, и у скрипта
# не будет вообще ни одного output. Liquidsoap в этом случае отказывается
# стартовать ("No output defined, nothing to do") и завершается с ошибкой —
# а systemd с Restart=on-failure уходит в бесконечный цикл перезапуска.
# Безобидный dummy-output держит процесс живым и просто ждёт первую
# реальную станцию, ничего никуда не отправляя.
if list.length(stations) == 0 then
  output.dummy(blank())
end
