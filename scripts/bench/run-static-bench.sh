#!/usr/bin/env bash
set -euo pipefail

ROUTES="generic"
if [[ "${1:-}" != "" && "${1:-}" != -* ]]; then
  ROUTES="$1"
  shift
fi

echo "[bench] generating static urls for ${ROUTES}"
node scripts/bench/generate-static-urls.mjs --routes "${ROUTES}"

echo "[bench] running benchmark with routes=${ROUTES}"
npm run bench -- --routes "${ROUTES}" "$@"
