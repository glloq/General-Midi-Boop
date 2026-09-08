#!/usr/bin/env bash
#
# scripts/verify-docker.sh — build the image, start it, and prove it works.
#
# Why this exists: `docker build` was broken for a long time and nobody knew,
# because nothing ever built the image (audit 2026-09-07, F-118 / F-157).
# Three independent faults were stacked on top of each other, and each one
# hid the next — so a build that merely *succeeds* proves very little. This
# script goes all the way to a live HTTP response.
#
# Usage:
#   scripts/verify-docker.sh                 # build + run + probe + clean up
#   IMAGE_TAG=gmboop:ci scripts/verify-docker.sh
#   HOST_PORT=18080 scripts/verify-docker.sh
#   BUILD_ARGS="--build-arg WITH_RUNTIME_ASSETS=0" scripts/verify-docker.sh
#
# Exit code 0 = the image builds, the container reaches "Up", /api/health
# answers 200 with a JSON body, and the SPA shell is served.
#
# NOTE ON ARCHITECTURE: this verifies the image for the platform of the Docker
# daemon that runs it. The production target is a Raspberry Pi (linux/arm64).
# To verify that one you need QEMU binfmt + buildx; see the Dockerfile header.

set -euo pipefail

IMAGE_TAG="${IMAGE_TAG:-gmboop:verify}"
CONTAINER_NAME="${CONTAINER_NAME:-gmboop-verify}"
HOST_PORT="${HOST_PORT:-18080}"
BUILD_ARGS="${BUILD_ARGS:-}"
TIMEOUT_S="${TIMEOUT_S:-60}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  if [ "${KEEP_IMAGE:-0}" != "1" ]; then
    docker rmi "$IMAGE_TAG" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

fail() { printf '\n[verify-docker] FAIL: %s\n' "$1" >&2; exit 1; }
step() { printf '\n[verify-docker] == %s\n' "$1"; }

step "1/4 build"
# shellcheck disable=SC2086
docker build $BUILD_ARGS -t "$IMAGE_TAG" . || fail "docker build returned non-zero"

step "2/4 image size"
docker images "$IMAGE_TAG" --format '  {{.Repository}}:{{.Tag}}  {{.Size}}'

step "3/4 start container"
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER_NAME" -p "${HOST_PORT}:8080" "$IMAGE_TAG" >/dev/null \
  || fail "docker run returned non-zero"

# A crash-at-boot container (the F-118 symptom: no better-sqlite3 binding, or
# the F-157 symptom: shared/ missing) exits within a second or two. Poll for a
# live HTTP response rather than sleeping a fixed amount.
deadline=$(( $(date +%s) + TIMEOUT_S ))
until curl -fsS --noproxy '*' "http://127.0.0.1:${HOST_PORT}/api/health" >/dev/null 2>&1; do
  if ! docker ps --filter "name=^/${CONTAINER_NAME}$" --format '{{.Names}}' | grep -q .; then
    echo "--- container logs ---" >&2
    docker logs "$CONTAINER_NAME" 2>&1 | tail -40 >&2
    fail "container is not running (it died at boot)"
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "--- container logs ---" >&2
    docker logs "$CONTAINER_NAME" 2>&1 | tail -40 >&2
    fail "/api/health did not answer within ${TIMEOUT_S}s"
  fi
  sleep 1
done

step "4/4 probe"
health="$(curl -fsS --noproxy '*' "http://127.0.0.1:${HOST_PORT}/api/health")"
echo "  GET /api/health -> $health"

# The health payload must be honest about what a container cannot do. Audit
# L12 fixed usb/ble/serial reporting `ready` when they were nothing of the
# sort; a container that claims `usb: ready` is that regression coming back.
node -e '
  const h = JSON.parse(process.argv[1]);
  const bad = [];
  if (h.status !== "ok") bad.push("status=" + h.status);
  for (const key of ["usb", "ble", "serial"]) {
    const st = h.capabilities?.[key]?.status;
    if (st === "ready") bad.push(key + " claims ready inside a container");
  }
  if (h.capabilities?.database?.status !== "ready") {
    bad.push("database=" + h.capabilities?.database?.status + " (better-sqlite3 binding?)");
  }
  if (bad.length) { console.error("  dishonest/broken health: " + bad.join("; ")); process.exit(1); }
  console.error("  health payload is honest (database ready; usb/ble/serial not claiming ready)");
' "$health" || fail "health payload check failed"

code="$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "http://127.0.0.1:${HOST_PORT}/")"
[ "$code" = "200" ] || fail "GET / returned HTTP $code"
echo "  GET / -> HTTP 200"

printf '\n[verify-docker] OK — image builds, container runs, /api/health is honest.\n'
