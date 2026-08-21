#!/usr/bin/env bash
#
# Восстанавливает владельца (radio:radio) всех файлов в текущей медиатеке.
# Нужен для случаев, когда файлы попали в папку станции в обход панели
# (например, залиты через WinSCP/SFTP от другого системного пользователя) —
# тогда backend (работает от radio) не может ни прочитать, ни переписать
# их ID3/Vorbis-теги из-за прав доступа.
#
# СПЕЦИАЛЬНО без аргументов: путь к медиатеке скрипт узнаёт сам, читая
# тот же data/stations.json, что использует backend — так sudoers-правило
# можно безопасно прописать на точное совпадение команды (без wildcard
# по пути, который иначе мог бы стать вектором для передачи произвольного
# пути через sudo).

set -euo pipefail

REGISTRY="${STATIONS_REGISTRY:-/home/claude/radio-project/data/stations.json}"

if [[ ! -f "$REGISTRY" ]]; then
  echo "Реестр станций не найден: $REGISTRY" >&2
  exit 1
fi

MEDIA_DIR="$(python3 -c "
import json
with open('$REGISTRY') as f:
    data = json.load(f)
print(data.get('global', {}).get('mediaBaseDir', ''))
")"

if [[ -z "$MEDIA_DIR" ]]; then
  echo "mediaBaseDir не задан в реестре — нечего исправлять" >&2
  exit 1
fi

if [[ ! -d "$MEDIA_DIR" ]]; then
  echo "Директория медиатеки не существует: $MEDIA_DIR" >&2
  exit 1
fi

chown -R radio:radio "$MEDIA_DIR"
echo "OK: владелец файлов в $MEDIA_DIR восстановлен (radio:radio)"
