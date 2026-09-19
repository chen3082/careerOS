#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
mkdir -p test-results/recovery test-restore
chown -R 1000:1000 test-restore
docker-compose exec -T db pg_dump -U careeros -d careeros_test -Fc | docker-compose exec -T web node server/backup-stream.mjs encrypt > test-results/recovery/database.enc
tar -czf - -C test-data . | docker-compose exec -T web node server/backup-stream.mjs encrypt > test-results/recovery/assets.enc
docker-compose exec -T db psql -U careeros -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='careeros_restore_test'" | grep -q 1 && { echo 'Isolated restore database already exists; refusing overwrite.'; exit 1; }
docker-compose exec -T db createdb -U careeros careeros_restore_test
docker-compose exec -T web node server/backup-stream.mjs decrypt < test-results/recovery/database.enc > test-results/recovery/verified.dump
docker-compose exec -T db pg_restore -U careeros -d careeros_restore_test --exit-on-error < test-results/recovery/verified.dump
docker-compose exec -T web node server/backup-stream.mjs decrypt < test-results/recovery/assets.enc > test-results/recovery/verified.tar.gz
tar -xzf test-results/recovery/verified.tar.gz -C test-restore
chown -R 1000:1000 test-restore
set -a
source .env
set +a
export DATABASE_URL="postgresql://careeros:${POSTGRES_PASSWORD}@db:5432/careeros_restore_test"
options=(-v "$PWD/server:/app/server:ro" -v "$PWD/tests:/app/tests:ro" -v "$PWD/test-restore:/restore" -e NODE_ENV=test -e DATABASE_URL -e DATA_DIR=/restore)
docker-compose run --rm "${options[@]}" web node --import tsx tests/recovery.ts
docker-compose run --rm "${options[@]}" web node --import tsx server/replay-deletions.ts /restore/latest-test-deletions.log
remaining=$(docker-compose exec -T db psql -U careeros -d careeros_restore_test -tAc 'SELECT count(*) FROM users')
[[ "$remaining" == "0" ]]
echo 'Encrypted PostgreSQL + asset restore and post-snapshot deletion replay passed.'
rm -f test-results/recovery/verified.dump test-results/recovery/verified.tar.gz
docker-compose exec -T db dropdb -U careeros careeros_restore_test
