#!/usr/bin/env bash
#
# Radio Deck — автоматическая установка на чистый Ubuntu 24.04.
#
# Использование:
#   sudo bash install.sh
#
# Переопределяемые переменные окружения (необязательно):
#   INSTALL_DIR      — куда ставить проект (по умолчанию /home/claude/radio-project)
#   RADIO_USER        — системный пользователь для сервисов (по умолчанию radio)
#   DOWNLOAD_URL       — прямая ссылка на архив проекта
#   PANEL_PORT       — порт веб-панели (по умолчанию 3000)
#   ICECAST_PORT      — порт вещания Icecast (по умолчанию 8000)
#   FORCE             — "1", чтобы переустановить поверх существующей папки
#
# Пример: sudo INSTALL_DIR=/opt/radio-deck PANEL_PORT=4000 bash install.sh

set -euo pipefail

# ============================================================
# Настройки
# ============================================================

INSTALL_DIR="${INSTALL_DIR:-/home/claude/radio-project}"
RADIO_USER="${RADIO_USER:-radio}"
DOWNLOAD_URL="${DOWNLOAD_URL:-https://nextcloud.longint.ru/s/4wqdme6XYgsFpwJ/download}"
PANEL_PORT="${PANEL_PORT:-3000}"
ICECAST_PORT="${ICECAST_PORT:-8000}"
FORCE="${FORCE:-0}"

# Пути установки systemd/sudoers — обычно не меняются
SYSTEMD_DIR="/etc/systemd/system"
SUDOERS_FILE="/etc/sudoers.d/radio-panel"
ICECAST_ETC_CONFIG="/etc/icecast2/icecast.xml"
CREDENTIALS_FILE="/root/radio-deck-credentials.txt"

# ============================================================
# Вспомогательные функции
# ============================================================

log()  { echo -e "\033[1;33m==>\033[0m $*"; }
ok()   { echo -e "\033[1;32m✓\033[0m $*"; }
err()  { echo -e "\033[1;31mОШИБКА:\033[0m $*" >&2; }
fail() { err "$*"; exit 1; }

random_secret() {
  # 24 случайных alphanumeric-символа, без внешних зависимостей вроде openssl.
  # "|| true" обязателен: head обрывает бесконечный поток /dev/urandom, tr получает
  # SIGPIPE (код 141), и при включённом "set -o pipefail" это иначе валит весь скрипт.
  tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24 || true
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Команда '$1' не найдена после установки пакетов — прервано."
}

# ============================================================
# 0. Проверки перед стартом
# ============================================================

if [[ $EUID -ne 0 ]]; then
  fail "Запустите от root: sudo bash install.sh"
fi

if [[ -f "$INSTALL_DIR/data/stations.json" && "$FORCE" != "1" ]]; then
  fail "В $INSTALL_DIR уже есть data/stations.json — похоже, там рабочая установка.
       Если это осознанная переустановка (данные будут перезаписаны новыми из архива,
       ваши текущие станции сохранятся, т.к. registry не трогается) — повторите с FORCE=1:
         sudo FORCE=1 bash install.sh
       Для обычного обновления кода используйте процедуру из README (rsync), а не этот скрипт."
fi

log "Установка Radio Deck в $INSTALL_DIR (пользователь сервисов: $RADIO_USER)"

# ============================================================
# 1. Системные пакеты
# ============================================================

log "Устанавливаю системные пакеты (liquidsoap, icecast2, nodejs, ffmpeg, ...)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq liquidsoap icecast2 nodejs npm ffmpeg wget unzip rsync file

require_cmd liquidsoap
require_cmd node
require_cmd npm
require_cmd ffmpeg
require_cmd ffprobe
ok "Системные пакеты на месте"

# ============================================================
# 2. Пользователь radio
# ============================================================

if id "$RADIO_USER" &>/dev/null; then
  ok "Пользователь $RADIO_USER уже существует"
else
  log "Создаю системного пользователя $RADIO_USER"
  useradd -r -m -d "/home/$RADIO_USER" -s /usr/sbin/nologin "$RADIO_USER"
  ok "Пользователь $RADIO_USER создан"
fi

# ============================================================
# 3. Скачивание и распаковка архива
# ============================================================

log "Скачиваю проект: $DOWNLOAD_URL"
TMP_ZIP="$(mktemp /tmp/radio-project-XXXXXX.zip)"
if ! wget -q -O "$TMP_ZIP" "$DOWNLOAD_URL"; then
  rm -f "$TMP_ZIP"
  fail "Не удалось скачать архив. Проверьте DOWNLOAD_URL и доступ в интернет с этого сервера."
fi

# Nextcloud отдаёт HTML-страницу с формой пароля вместо архива, если ссылка
# защищена паролем — проверяем, что реально скачали ZIP, а не эту страницу
if ! file "$TMP_ZIP" | grep -qi 'zip archive'; then
  rm -f "$TMP_ZIP"
  fail "Скачанный файл — не ZIP-архив (возможно, ссылка защищена паролем или устарела).
       Проверьте ссылку в браузере: $DOWNLOAD_URL"
fi
ok "Архив скачан и подтверждён как настоящий ZIP"

log "Распаковываю"
TMP_DIR="$(mktemp -d)"
unzip -q "$TMP_ZIP" -d "$TMP_DIR"
rm -f "$TMP_ZIP"

# Архив может содержать файлы прямо в корне или во вложенной папке radio-project/
SRC_DIR="$TMP_DIR"
if [[ -d "$TMP_DIR/radio-project" && -f "$TMP_DIR/radio-project/README.md" ]]; then
  SRC_DIR="$TMP_DIR/radio-project"
fi
[[ -f "$SRC_DIR/backend/server.js" ]] || fail "В архиве не найден backend/server.js — структура проекта не распознана."

mkdir -p "$INSTALL_DIR"
cp -r "$SRC_DIR"/. "$INSTALL_DIR"/
rm -rf "$TMP_DIR"
ok "Проект распакован в $INSTALL_DIR"

# ============================================================
# 4. Директории данных
# ============================================================

mkdir -p "$INSTALL_DIR"/{media,logs,data}
chown -R "$RADIO_USER:$RADIO_USER" "$INSTALL_DIR"
ok "Права на $INSTALL_DIR переданы пользователю $RADIO_USER"

# ============================================================
# 5. Генерация паролей и подготовка icecast.xml + data/stations.json
#    (пишем их СОГЛАСОВАННО, чтобы не ловить classic "changeme у одного,
#    другое значение у другого" сразу после первого старта)
# ============================================================

log "Генерирую пароли"
SOURCE_PASSWORD="$(random_secret)"
ADMIN_PASSWORD="$(random_secret)"
PORTAL_PASSWORD="$(random_secret)"

ICECAST_XML="$INSTALL_DIR/icecast/icecast.xml"
sed -i \
  -e "s|<source-password>[^<]*</source-password>|<source-password>${SOURCE_PASSWORD}</source-password>|" \
  -e "s|<relay-password>[^<]*</relay-password>|<relay-password>${SOURCE_PASSWORD}</relay-password>|" \
  -e "s|<admin-password>[^<]*</admin-password>|<admin-password>${ADMIN_PASSWORD}</admin-password>|" \
  -e "s|<port>[0-9]*</port>|<port>${ICECAST_PORT}</port>|" \
  "$ICECAST_XML"

# Реестр станций — создаём заранее с тем же паролем источника, что и в icecast.xml,
# иначе backend при первом старте создаст его сам со значением "changeme" по
# умолчанию, и liquidsoap не сможет подключиться к Icecast.
cat > "$INSTALL_DIR/data/stations.json" <<JSON
{
  "global": {
    "port": ${ICECAST_PORT},
    "sourcePassword": "${SOURCE_PASSWORD}"
  },
  "stations": []
}
JSON
chown "$RADIO_USER:$RADIO_USER" "$INSTALL_DIR/data/stations.json"
chmod 600 "$INSTALL_DIR/data/stations.json"
ok "icecast.xml и data/stations.json согласованы по паролю источника"

# ============================================================
# 6. Симлинк /etc/icecast2/icecast.xml -> проект
#    (НЕ копия — иначе правки из портала не долетают до реального Icecast,
#    см. README, раздел "Диагностика")
# ============================================================

log "Настраиваю /etc/icecast2/icecast.xml как симлинк на проект"
rm -f "$ICECAST_ETC_CONFIG"
ln -s "$ICECAST_XML" "$ICECAST_ETC_CONFIG"
ok "Симлинк создан: $ICECAST_ETC_CONFIG -> $ICECAST_XML"

# ============================================================
# 7. backend/.env
# ============================================================

log "Генерирую backend/.env"
cat > "$INSTALL_DIR/backend/.env" <<ENV
PANEL_PORT=${PANEL_PORT}
PORTAL_PASSWORD=${PORTAL_PASSWORD}

MEDIA_BASE_DIR=${INSTALL_DIR}/media
STATIONS_REGISTRY=${INSTALL_DIR}/data/stations.json
LIQUIDSOAP_GLOBAL_CONFIG=${INSTALL_DIR}/liquidsoap/global.liq
LIQUIDSOAP_STATIONS_CONFIG=${INSTALL_DIR}/liquidsoap/stations.liq
ICECAST_CONFIG=${INSTALL_DIR}/icecast/icecast.xml

SERVICE_MODE=systemd
LIQUIDSOAP_SERVICE=liquidsoap-radio
ICECAST_SERVICE=icecast2

LIQUIDSOAP_BIN=/usr/bin/liquidsoap
LIQUIDSOAP_SCRIPT=${INSTALL_DIR}/liquidsoap/radio.liq

MAX_UPLOAD_MB=1024
ENV
chown "$RADIO_USER:$RADIO_USER" "$INSTALL_DIR/backend/.env"
chmod 600 "$INSTALL_DIR/backend/.env"
ok ".env создан"

# ============================================================
# 8. systemd-юниты и sudoers — подставляем реальные INSTALL_DIR/RADIO_USER
# ============================================================

log "Устанавливаю systemd-юниты"
for unit in liquidsoap-radio.service radio-panel.service; do
  sed \
    -e "s|/home/claude/radio-project|${INSTALL_DIR}|g" \
    -e "s|User=radio|User=${RADIO_USER}|" \
    -e "s|Group=radio|Group=${RADIO_USER}|" \
    "$INSTALL_DIR/systemd/$unit" > "$SYSTEMD_DIR/$unit"
done
ok "Юниты установлены в $SYSTEMD_DIR"

log "Устанавливаю sudoers-правило"
sed -e "s|^radio |${RADIO_USER} |g" "$INSTALL_DIR/systemd/radio-sudoers" > /tmp/radio-sudoers-generated
if visudo -cf /tmp/radio-sudoers-generated; then
  cp /tmp/radio-sudoers-generated "$SUDOERS_FILE"
  chmod 440 "$SUDOERS_FILE"
  ok "sudoers-правило установлено"
else
  rm -f /tmp/radio-sudoers-generated
  fail "Сгенерированный sudoers-файл не прошёл проверку visudo — установка прервана."
fi
rm -f /tmp/radio-sudoers-generated

# ============================================================
# 9. Зависимости backend
# ============================================================

log "Устанавливаю npm-зависимости backend (от имени $RADIO_USER)"
(cd "$INSTALL_DIR/backend" && sudo -u "$RADIO_USER" npm install --no-audit --no-fund --silent)
ok "npm install завершён"

# ============================================================
# 10. Проверка синтаксиса liquidsoap ДО включения сервисов
# ============================================================

log "Проверяю синтаксис radio.liq"
if ! sudo -u "$RADIO_USER" liquidsoap --check "$INSTALL_DIR/liquidsoap/radio.liq"; then
  fail "liquidsoap --check провалился — см. вывод выше. Установка прервана ДО запуска
       сервисов, чтобы не оставлять их в цикле рестартов. Актуально для нестандартных
       версий liquidsoap — см. README, раздел 'Диагностика'."
fi
ok "Синтаксис radio.liq в порядке"

# ============================================================
# 11. Запуск сервисов — по одному, с проверкой на каждом шаге
#     (Icecast умеет тихо падать после старта — уже наступали на эти грабли)
# ============================================================

systemctl daemon-reload

log "Запускаю icecast2"
systemctl enable --now icecast2 >/dev/null
sleep 2
if ! pgrep -x icecast2 >/dev/null; then
  fail "icecast2 не поднялся (процесс не найден после старта). Проверьте:
       journalctl -u icecast2 -n 30 --no-pager
       Частая причина — права на <logdir> в icecast.xml. См. README, раздел 'Диагностика'."
fi
ok "icecast2 запущен и виден в списке процессов"

log "Запускаю liquidsoap-radio"
systemctl enable --now liquidsoap-radio >/dev/null
sleep 2
if ! systemctl is-active --quiet liquidsoap-radio; then
  fail "liquidsoap-radio не поднялся. Проверьте:
       journalctl -u liquidsoap-radio -n 30 --no-pager"
fi
ok "liquidsoap-radio запущен"

log "Запускаю radio-panel"
systemctl enable --now radio-panel >/dev/null
sleep 2
if ! systemctl is-active --quiet radio-panel; then
  fail "radio-panel не поднялся. Проверьте:
       journalctl -u radio-panel -n 30 --no-pager"
fi
ok "radio-panel запущен"

# ============================================================
# 12. Финальная проверка
# ============================================================

log "Проверяю API портала"
HEALTH="$(curl -s "http://localhost:${PANEL_PORT}/api/health" || true)"
if [[ "$HEALTH" != *'"ok":true'* ]]; then
  fail "Портал не отвечает на /api/health. Проверьте: journalctl -u radio-panel -n 30 --no-pager"
fi
ok "Портал отвечает: $HEALTH"

# ============================================================
# 13. Сохраняем креды и печатаем итог
# ============================================================

SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[[ -z "$SERVER_IP" ]] && SERVER_IP="<IP-этого-сервера>"

cat > "$CREDENTIALS_FILE" <<CREDS
Radio Deck — учётные данные установки от $(date -u +"%Y-%m-%d %H:%M UTC")

Портал:              http://${SERVER_IP}:${PANEL_PORT}
Пароль портала:       ${PORTAL_PASSWORD}

Icecast admin UI:     http://${SERVER_IP}:${ICECAST_PORT}/admin/
Icecast admin логин:  admin
Icecast admin пароль: ${ADMIN_PASSWORD}
Пароль источника:     ${SOURCE_PASSWORD}   (уже прописан в icecast.xml и data/stations.json — трогать не нужно)

Файл: $CREDENTIALS_FILE (chmod 600, только root)
CREDS
chmod 600 "$CREDENTIALS_FILE"

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Radio Deck установлен и запущен"
echo "════════════════════════════════════════════════════════════════"
cat "$CREDENTIALS_FILE"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "Дальше: откройте портал в браузере, войдите паролем портала выше,"
echo "и создайте первую станцию через кнопку «+ Создать станцию»."
echo ""
