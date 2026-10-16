#!/bin/bash
# 打印本机 Chromium 可执行文件的绝对路径。
# 不写死版本号 —— 换 playwright 版本时这个脚本不该需要改。
set -euo pipefail

if [ -n "${LOOM_CHROME:-}" ] && [ -x "$LOOM_CHROME" ]; then
  echo "$LOOM_CHROME"
  exit 0
fi

for root in "$HOME/.cache/ms-playwright" /root/.cache/ms-playwright; do
  [ -d "$root" ] || continue
  # 目录名形如 chromium-1234，按版本倒序找第一个可用的
  for d in $(ls -1 "$root" | grep '^chromium-[0-9]' | sort -Vr); do
    for rel in chrome-linux64/chrome chrome-linux/chrome; do
      p="$root/$d/$rel"
      if [ -x "$p" ]; then
        echo "$p"
        exit 0
      fi
    done
  done
done

echo "找不到 Chromium。请设置 LOOM_CHROME 指向 chrome 二进制。" >&2
exit 1
