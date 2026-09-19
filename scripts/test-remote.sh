#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
for attempt in $(seq 1 30); do
  if docker-compose exec -T db pg_isready -U careeros -d careeros >/dev/null 2>&1; then break; fi
  sleep 1
done
# The dedicated test database never shares tables or assets with production.
docker-compose exec -T db psql -U careeros -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='careeros_test'" | grep -q 1 || docker-compose exec -T db createdb -U careeros careeros_test
set -a
source .env
set +a
export DATABASE_URL="postgresql://careeros:${POSTGRES_PASSWORD}@db:5432/careeros_test"
mkdir -p test-data
chown 1000:1000 test-data
options=(-v "$PWD/test-data:/tmp/careeros-test" -v "$PWD/server:/app/server:ro" -v "$PWD/tests:/app/tests:ro" -v "$PWD/migrations:/app/migrations:ro" -e NODE_ENV=test -e DATABASE_URL -e PUBLIC_URL=http://127.0.0.1:3110/careeros -e PORT=3110 -e DATA_DIR=/tmp/careeros-test -e BOOTSTRAP_TOKEN=test-bootstrap-token-1234567890)
docker-compose run --rm "${options[@]}" web npm run migrate
if [[ "${1:-integration}" == "browser" ]]; then
  mkdir -p test-results
  chmod 777 test-results
  docker-compose run --rm "${options[@]}" -v "$PWD/dist:/app/dist:ro" -v "$PWD/test-results:/tmp/careeros-e2e" web node --import tsx tests/browser.ts
else
  docker-compose run --rm "${options[@]}" web npm run test:integration
fi
