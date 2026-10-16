#!/usr/bin/env bash
# Loom 重构：多包工作区 → 单包，去掉所有第三方依赖与抄来的代码。
set -eu
ROOT="$HOME/projects/dsh-loom"
cd "$ROOT"

echo "=== 1. 建新布局 ==="
mkdir -p src/core lib/client tests scripts docs

echo "=== 2. 搬 core 源码 ==="
for f in "$ROOT"/packages/core/src/*.ts; do
  [ -e "$f" ] || continue
  cp "$f" src/core/
done

echo "=== 3. 搬宿主半边源码 ==="
for f in "$ROOT"/packages/plugin-host/src/*.ts; do
  [ -e "$f" ] || continue
  cp "$f" src/
done

echo "=== 4. 把 @dsh-loom/core 换成相对路径 ==="
sed -i "s#'@dsh-loom/core'#'./core/index.js'#g" src/index.ts src/store.ts src/tools.ts src/http.ts

echo "=== 5. 删掉旧的包结构、产物、抄来的代码、第三方打包链 ==="
rm -rf packages
rm -f  lib/index.js lib/client.js lib/client-kit.js
rm -rf lib/client
rm -f  scripts/build.mjs scripts/build-client.mjs scripts/copy-kit.sh scripts/verify-and-pack.sh
rm -f  tests/fixtures.ts
rm -f  vitest.config.ts pnpm-workspace.yaml pnpm-lock.yaml
rm -rf node_modules
rm -f  dsh-loom-0.1.0.tgz

echo "=== 6. 结果 ==="
find . -maxdepth 2 -not -path './node_modules*' -not -path './.git*' | sort | head -60
