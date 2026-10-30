#!/usr/bin/env bash
# Prepare a linked worktree: link what git ignores, then build if there is source.
set -euo pipefail
main="$(git worktree list --porcelain | sed -n '1s/^worktree //p')"
here="$(git rev-parse --show-toplevel)"
if [ "$(cd "$main" && pwd -P)" = "$(cd "$here" && pwd -P)" ]; then
  echo "Run this from a linked worktree, not the main checkout." >&2
  exit 1
fi
ln -sfn "$main/node_modules" "$here/node_modules"
for f in bench/routes-specific.mjs bench/routes-specific.urls.mjs; do
  if [ -e "$main/$f" ]; then ln -sfn "$main/$f" "$here/$f"; fi
done
if [ -d "$here/src" ]; then
  (cd "$here" && node node_modules/typescript/bin/tsc -p tsconfig.json)
fi
echo "Worktree ready: $here"
