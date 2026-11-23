#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose config --quiet
docker compose up -d --build
port="${PORT:-3000}"
for attempt in $(seq 1 60); do
  if curl --fail --silent "http://127.0.0.1:$port/api/health" >/dev/null; then break; fi
  if [ "$attempt" = 60 ]; then docker compose logs; exit 1; fi
  sleep 1
done
before="$(curl --fail --silent "http://127.0.0.1:$port/api/library/export")"
docker compose restart
for attempt in $(seq 1 30); do
  if curl --fail --silent "http://127.0.0.1:$port/api/health" >/dev/null; then break; fi
  sleep 1
done
after="$(curl --fail --silent "http://127.0.0.1:$port/api/library/export")"
[ "$before" = "$after" ] || { echo 'Библиотека изменилась после перезапуска'; exit 1; }
curl --fail --silent "http://127.0.0.1:$port/" >/dev/null
curl --fail --silent "http://127.0.0.1:$port/fonts/OpenGOSTTypeB-Regular.ttf" >/dev/null
code="$(curl --silent -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/projects")"
[ "$code" = 404 ] || { echo 'Неожиданный endpoint проектов'; exit 1; }
echo 'Docker smoke: health, интерфейс, локальный шрифт, сохранение библиотеки и отсутствие проектов — OK'
