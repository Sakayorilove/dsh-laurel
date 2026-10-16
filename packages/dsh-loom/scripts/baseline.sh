#!/usr/bin/env bash
# 生成 Loom 源码/产物基线 hash 清单。输出到 stdout，同时写文件。
set -u
cd ~/projects/dsh-loom || exit 1

OUT=docs/baseline-20261002.txt
mkdir -p docs

{
  echo "# Loom 基线快照 $(date -Iseconds)"
  echo "# 生成者：步骤 0"
  echo ""
  echo "## 环境"
  echo "host: $(hostname)"
  echo "user: $(whoami)"
  echo "cwd: $(pwd)"
  echo "node: $(node -v)"
  echo "pnpm: $(pnpm -v)"
  echo "kernel: $(uname -r)"
  echo ""
  echo "## 版本控制"
  if [ -d .git ]; then
    echo "git: 有"
    echo "branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
    echo "HEAD: $(git rev-parse HEAD 2>/dev/null)"
    echo "dirty:"
    git status --short
  else
    echo "git: 无（本目录不是 git 仓库）"
  fi
  echo ""
  echo "## 安装包"
  for f in *.tgz; do
    [ -e "$f" ] || continue
    echo "$(sha256sum "$f" | cut -d' ' -f1)  $(stat -c%s "$f") bytes  $f"
  done
  echo ""
  echo "## lib 产物"
  find lib -name '*.js' -o -name '*.d.ts' | sort | while read -r f; do
    echo "$(sha256sum "$f" | cut -d' ' -f1)  $(stat -c%s "$f")  $f"
  done
  echo ""
  echo "## src 源码"
  find src -name '*.ts' | sort | while read -r f; do
    echo "$(sha256sum "$f" | cut -d' ' -f1)  $(wc -l < "$f") 行  $f"
  done
  echo ""
  echo "## src 行数合计"
  find src -name '*.ts' -exec cat {} + | wc -l
  echo ""
  echo "## tests"
  find tests -type f | sort | while read -r f; do
    echo "$(sha256sum "$f" | cut -d' ' -f1)  $(wc -l < "$f") 行  $f"
  done
  echo ""
  echo "## scripts"
  find scripts -type f | sort | while read -r f; do
    echo "$(sha256sum "$f" | cut -d' ' -f1)  $f"
  done
} | tee "$OUT"

echo ""
echo "已写入 $OUT"
