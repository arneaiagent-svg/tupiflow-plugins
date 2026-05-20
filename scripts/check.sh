#!/usr/bin/env bash
# scripts/check.sh — local gate, mirrors tupiflow-registry/scripts/check.sh.
#
# Run before pushing to main. This is the only CI gate for the monorepo —
# there are no GitHub Actions on this repo (per PLUGIN_TIERS.md §4.1 /
# tupiflow-registry M1.3 policy).
set -euo pipefail

cd "$(dirname "$0")/.."

run() {
  local name="$1"
  shift
  echo
  echo "==> ${name}"
  "$@"
}

run "type-check"      pnpm type-check
run "build"           pnpm build
run "changeset"       bash -c "pnpm changeset status || true"

echo
echo "All checks passed."
