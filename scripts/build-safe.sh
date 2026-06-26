#!/usr/bin/env bash
# Safe production build: isolates heavy dirs, enforces 10-min trace timeout, restores on exit.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_BASE="/tmp/dwomoh-build-isolate-$$"
LOG="$PROJECT_DIR/.next/build.log"
TRACE_TIMEOUT=600  # 10 minutes in seconds

mkdir -p "$BACKUP_BASE"

# -- cleanup on any exit --
cleanup() {
  echo "[build-safe] Restoring isolated dirs..."
  [ -d "$BACKUP_BASE/generated-projects" ] && mv "$BACKUP_BASE/generated-projects" "$PROJECT_DIR/generated-projects" 2>/dev/null || true
  [ -d "$BACKUP_BASE/.dwomoh" ]            && mv "$BACKUP_BASE/.dwomoh"            "$PROJECT_DIR/.dwomoh"            2>/dev/null || true
  [ -d "$BACKUP_BASE/browser-screenshots" ] && mv "$BACKUP_BASE/browser-screenshots" "$PROJECT_DIR/public/browser-screenshots" 2>/dev/null || true
  rm -rf "$BACKUP_BASE"
  echo "[build-safe] Dirs restored."
}
trap cleanup EXIT

cd "$PROJECT_DIR"

# -- isolate heavy dirs --
echo "[build-safe] Isolating heavy dirs to $BACKUP_BASE..."
[ -d generated-projects ]         && mv generated-projects         "$BACKUP_BASE/generated-projects"
[ -d .dwomoh ]                    && mv .dwomoh                    "$BACKUP_BASE/.dwomoh"
[ -d public/browser-screenshots ] && mv public/browser-screenshots "$BACKUP_BASE/browser-screenshots"

# -- clear stale build artifacts (keep webpack cache for speed) --
rm -rf .next/server .next/static .next/types \
       .next/BUILD_ID .next/build-manifest.json \
       .next/app-build-manifest.json .next/routes-manifest.json \
       .next/package.json .next/trace .next/export-marker.json \
       .next/images-manifest.json .next/prerender-manifest.json \
       .next/react-loadable-manifest.json .next/required-server-files.json \
       .next/app-path-routes-manifest.json 2>/dev/null || true

echo "[build-safe] Starting build at $(date)..."

# -- run build; kill trace process if it exceeds TRACE_TIMEOUT --
NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS='--max-old-space-size=8192' npx next build 2>&1 &
BUILD_PID=$!

# Watch for "Collecting build traces" then enforce timeout
TRACE_STARTED=0
TRACE_START_TIME=0
while kill -0 $BUILD_PID 2>/dev/null; do
  if [ -f .next/BUILD_ID ] && [ $TRACE_STARTED -eq 0 ]; then
    TRACE_STARTED=1
    TRACE_START_TIME=$(date +%s)
    echo "[build-safe] Trace phase started at $(date)"
  fi
  if [ $TRACE_STARTED -eq 1 ]; then
    ELAPSED=$(( $(date +%s) - TRACE_START_TIME ))
    if [ $ELAPSED -gt $TRACE_TIMEOUT ]; then
      echo "[build-safe] ERROR: Trace exceeded ${TRACE_TIMEOUT}s — killing build (PID $BUILD_PID)"
      kill -9 $BUILD_PID 2>/dev/null
      pkill -9 -f "swc\b" 2>/dev/null || true
      exit 1
    fi
  fi
  sleep 5
done

wait $BUILD_PID
EXIT_CODE=$?

echo "[build-safe] Build exited with code $EXIT_CODE at $(date)"

if [ $EXIT_CODE -eq 0 ]; then
  echo "[build-safe] ✓ Build succeeded"
  echo "[build-safe] Routes compiled:"
  cat .next/app-path-routes-manifest.json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); [print(' ', k) for k in sorted(d.keys())]" || true
else
  echo "[build-safe] ✗ Build failed with exit $EXIT_CODE"
fi

exit $EXIT_CODE
