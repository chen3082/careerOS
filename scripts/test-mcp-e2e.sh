#!/usr/bin/env bash
# Dedicated disposable containers; never attach to careeros_default or source .env.
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
[[ $(id -u) = 0 ]] || { echo "Run with sudo for Docker access" >&2; exit 1; }
command -v python3 >/dev/null
case "${CAREEROS_E2E_SCENARIO:-mcp}" in
  mcp) test_script=tests/mcp-e2e.ts ;;
  manual) test_script=tests/manual-applications.ts ;;
  google) test_script=tests/google-login-browser.ts ;;
  providers) test_script=tests/ai-provider-browser.ts ;;
  submissions) test_script=tests/submission-e2e.ts ;;
  accounts) test_script=tests/account-setup-e2e.ts ;;
  catalog) test_script=tests/catalog-e2e.ts ;;
  *) echo "Unknown E2E scenario" >&2; exit 1 ;;
esac
image_ref="${CAREEROS_E2E_IMAGE:-careeros:local}"
[[ "$image_ref" = careeros:* ]] || { echo "A CareerOS image is required" >&2; exit 1; }
[[ -f "$test_script" ]] || exit 1
[[ -f dist/web/index.html ]] || { echo "Build the candidate frontend first: npm run build" >&2; exit 1; }
available=$(awk '/MemAvailable/ {print $2}' /proc/meminfo)
[[ "$available" -ge 1700000 ]] || { echo "Insufficient safe host memory headroom; no test containers started" >&2; exit 1; }
docker image inspect "$image_ref" >/dev/null
docker image inspect postgres:17-bookworm >/dev/null
run="careeros-mcp-e2e-$(date -u +%Y%m%dT%H%M%SZ)-$$"
runner="$run-runner"
database="$run-db"
network="$run-net"
report="$PWD/test-results/$run"
mkdir -p "$PWD/test-results"
chown "${SUDO_UID:-0}:${SUDO_GID:-0}" "$PWD/test-results"
chmod 700 "$PWD/test-results"
# Only public, synthetic test source is readable by the image's non-root UID.
chmod -R a+rX "$PWD/tests" "$PWD/dist"
mkdir -p "$report"
chmod 700 "$report"
chown 1000:1000 "$report"
secret=$(mktemp)
baseline=$(mktemp)
docker ps -q | while read -r cid; do
  docker inspect --format '{{.Id}}|{{.Name}}|{{.State.StartedAt}}|{{.RestartCount}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid"
done > "$baseline"
cp "$baseline" "$report/services-before.txt"
cleanup() {
  result=$?
  runner_result=$result
  services_unchanged=false
  cleanup_verified=false
  trap - EXIT INT TERM
  set +e
  docker rm -f -v "$runner" "$database" >/dev/null 2>&1
  docker network rm "$network" >/dev/null 2>&1
  rm -f "$secret"
  : > "$report/services-after.txt"
  while IFS='|' read -r cid _; do
    docker inspect --format '{{.Id}}|{{.Name}}|{{.State.StartedAt}}|{{.RestartCount}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" >> "$report/services-after.txt" 2>/dev/null || result=1
  done < "$baseline"
  if cmp -s "$baseline" "$report/services-after.txt"; then
    services_unchanged=true
    printf 'Existing service IDs, start times, restart counts and health unchanged.\n' > "$report/isolation.txt"
  else
    printf 'Existing service state changed; inspect before/after.\n' > "$report/isolation.txt"
    result=1
  fi
  remaining=()
  for resource in "$runner" "$database"; do
    if docker container inspect "$resource" >/dev/null 2>&1; then remaining+=("$resource"); fi
  done
  if docker network inspect "$network" >/dev/null 2>&1; then remaining+=("$network"); fi
  if ! docker info --format '{{.ServerVersion}}' >/dev/null 2>&1; then
    printf 'Cleanup could not be verified: Docker daemon unavailable.\n' >> "$report/isolation.txt"
    result=1
  elif [[ ${#remaining[@]} -gt 0 ]]; then
    printf 'Cleanup incomplete; remaining resource: %s\n' "${remaining[@]}" >> "$report/isolation.txt"
    result=1
  else
    cleanup_verified=true
    printf 'Disposable containers/network verified removed; test DB and private assets were tmpfs. No production secrets mounted.\n' >> "$report/isolation.txt"
  fi
  python3 - "$report" "$result" "$runner_result" "$services_unchanged" "$cleanup_verified" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
file = root / 'report.json'
report = json.loads(file.read_text()) if file.exists() else {'passed': False}
report['scenarioPassed'] = report.pop('passed', False)
report['passed'] = int(sys.argv[2]) == 0 and report['scenarioPassed']
report['isolation'] = {'runnerExitCode': int(sys.argv[3]), 'servicesUnchanged': sys.argv[4] == 'true', 'cleanupVerified': sys.argv[5] == 'true'}
file.write_text(json.dumps(report, ensure_ascii=False, indent=2))
with (root / 'REPORT.md').open('a') as out:
    out.write('\n## Overall result after cleanup\n\n' + ('PASS' if report['passed'] else 'FAIL') + '\n\n')
    out.write((root / 'isolation.txt').read_text())
sys.exit(0 if report['passed'] else 1)
PY
  if [[ $? -ne 0 ]]; then result=1; fi
  rm -f "$baseline"
  chown -R "${SUDO_UID:-0}:${SUDO_GID:-0}" "$report"
  printf 'MCP E2E exit=%s report=%s\n' "$result" "$report"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
password=$(openssl rand -hex 24)
encryption=$(openssl rand -hex 32)
bootstrap=$(openssl rand -hex 32)
printf 'POSTGRES_PASSWORD=%s\nPOSTGRES_USER=careeros\nPOSTGRES_DB=careeros_mcp_e2e_test\nNODE_ENV=test\nDATABASE_URL=postgresql://careeros:%s@postgres-e2e:5432/careeros_mcp_e2e_test\nENCRYPTION_KEY=%s\nBOOTSTRAP_TOKEN=%s\nPUBLIC_URL=http://127.0.0.1:3110/careeros\nPORT=3110\nDATA_DIR=/tmp/careeros-mcp-e2e-data\nE2E_OUTPUT=/tmp/careeros-mcp-e2e-report\nSUBMISSIONS_ENABLED=false\nREGISTRATION_OPEN=false\n' "$password" "$password" "$encryption" "$bootstrap" > "$secret"
unset password encryption bootstrap
docker network create --internal --label careeros-purpose=mcp-e2e "$network" >/dev/null
[[ $(docker network inspect --format '{{.Internal}}' "$network") = true ]]
docker run -d --name "$database" --network "$network" --network-alias postgres-e2e \
  --label careeros-purpose=mcp-e2e --memory 256m --memory-swap 256m --cpus 0.25 --pids-limit 80 \
  --env-file "$secret" --tmpfs /var/lib/postgresql/data:rw,size=128m \
  --log-opt max-size=2m --log-opt max-file=1 \
  postgres:17-bookworm -c shared_buffers=32MB -c max_connections=30 >/dev/null
ready=false
for attempt in $(seq 1 40); do
  if docker exec "$database" pg_isready -U careeros -d careeros_mcp_e2e_test >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[[ "$ready" = true ]] || { echo "Test database startup failed" >&2; exit 1; }
docker image inspect --format '{{.Id}}' "$image_ref" > "$report/application-image.txt"
(cd dist/web && find . -type f -exec sha256sum {} + | sort) > "$report/frontend-sha256.txt"
# No published ports, no application volumes, no paid providers, no Internet egress.
timeout --signal=TERM --kill-after=10s 12m docker run --name "$runner" --network "$network" \
  --label careeros-purpose=mcp-e2e --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 1024m --memory-swap 1024m --cpus 0.75 --pids-limit 180 --shm-size 32m \
  --tmpfs /tmp:rw,size=384m,mode=1777 --env-file "$secret" \
  --mount "type=bind,src=$PWD/tests,dst=/app/tests,readonly" \
  --mount "type=bind,src=$PWD/dist,dst=/app/dist,readonly" \
  --mount "type=bind,src=$report,dst=/tmp/careeros-mcp-e2e-report" \
  --log-opt max-size=4m --log-opt max-file=1 \
  "$image_ref" sh -c 'npm run migrate && if [ "$1" = tests/google-login-browser.ts ] || [ "$1" = tests/ai-provider-browser.ts ]; then npm test && npm run test:integration; fi && node --import tsx "$1"' sh "$test_script" \
  > "$report/run.log" 2>&1 &
test_pid=$!
while kill -0 "$test_pid" 2>/dev/null; do
  available=$(awk '/MemAvailable/ {print $2}' /proc/meminfo)
  if [[ "$available" -lt 350000 ]]; then
    echo "Low host memory: stopping only the disposable test runner" >&2
    docker stop -t 5 "$runner" >/dev/null 2>&1 || true
    wait "$test_pid" || true
    exit 1
  fi
  sleep 5
done
set +e
wait "$test_pid"
result=$?
set -e
tail -55 "$report/run.log"
exit "$result"
