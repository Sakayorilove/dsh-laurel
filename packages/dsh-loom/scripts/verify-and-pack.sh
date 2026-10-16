#!/usr/bin/env bash
# Fail on failed dependencies; preserve previous rollback packages.
set -euo pipefail
LOOM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$LOOM_ROOT"
mkdir -p .verification
pnpm run typecheck > .verification/typecheck.log 2>&1
pnpm run build > .verification/build.log 2>&1
node scripts/run-tests.mjs --browser
LOOM="$LOOM_ROOT" bash scripts/verify-worktree.sh > .verification/worktree-integration.log 2>&1
pnpm pack --pack-destination . > .verification/pack.log 2>&1
node scripts/write-manifest.mjs
