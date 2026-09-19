#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
mkdir -p backups
exec 9>backups/.lock
flock -n 9 || exit 0
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="backups/$stamp"
mkdir "$target.tmp"
trap 'rm -rf "$target.tmp"' EXIT
docker-compose exec -T db pg_dump -U careeros -d careeros -Fc | docker-compose exec -T web node server/backup-stream.mjs encrypt > "$target.tmp/database.enc"
docker-compose exec -T web tar -czf - -C /app/data . | docker-compose exec -T web node server/backup-stream.mjs encrypt > "$target.tmp/assets.enc"
(cd "$target.tmp" && sha256sum ./*.enc > SHA256SUMS)
mv "$target.tmp" "$target"
find backups -mindepth 1 -maxdepth 1 -type d -name '20*' -mtime +6 -exec rm -rf -- {} +
printf 'CareerOS encrypted local backup completed: %s\n' "$stamp"
