#!/bin/bash
# 为「真实浏览器验证」准备本机 Chromium。
#
# ── 为什么要有这个脚本 ──────────────────────────────────────────────────
# WSL 里已经有一份 playwright 缓存的 Chromium 二进制，但系统缺 5 个运行库
# （libnspr4 / libnss3 / libnsutil3 / libsmime3 / libasound2）。
# 本机 apt 走 http 会被代理拦死（`apt-get update` 直接挂住），所以改成
# **直接下 .deb 解到本地前缀**，不需要 root，也不改动系统。
#
# 用法：
#   bash scripts/setup-browser.sh          # 准备
#   source scripts/browser-env.sh          # 之后 shell 里 chrome 可用
#
# 产物在 ~/.local/chromium-libs，删掉即可完全回退。
set -euo pipefail

PREFIX="$HOME/.local/chromium-libs"
STAGE="$HOME/.local/deb-stage"
PROXY="${LOOM_PROXY:-http://127.0.0.1:7897}"
# 先取脚本所在目录再 cd —— 后面会切到 $STAGE，那时相对路径就没意义了。
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$PREFIX" "$STAGE"
cd "$STAGE"

export https_proxy="$PROXY" http_proxy="$PROXY"

fetch() {
  local dir="$1" pat="$2"
  local url="https://archive.ubuntu.com/ubuntu/pool/main/$dir/"
  local deb
  deb=$(curl -s --max-time 30 "$url" \
    | grep -oE 'href="[^"]+\.deb"' | sed 's/href="//; s/"$//' \
    | grep -E "^${pat}_.*_amd64\.deb$" | grep -v amd64v3 | sort -V | tail -1)
  [ -n "$deb" ] || { echo "✗ 找不到 ${pat}（$url）"; return 1; }
  [ -f "$deb" ] || curl -s -O --max-time 120 "$url$deb"
  echo "✓ $deb"
  dpkg-deb -x "$deb" "$PREFIX"
}

echo "== 准备 Chromium 运行库到 $PREFIX =="
fetch n/nspr      'libnspr4'
fetch n/nss       'libnss3'
fetch a/alsa-lib  'libasound2t64'

echo "== 校验 =="
CHROME="$(bash "$HERE/find-chrome.sh")"
LIBDIR="$PREFIX/usr/lib/x86_64-linux-gnu"
missing=$(LD_LIBRARY_PATH="$LIBDIR" ldd "$CHROME" 2>/dev/null | grep 'not found' || true)
if [ -n "$missing" ]; then
  echo "✗ 仍有缺失："
  echo "$missing"
  exit 1
fi
LD_LIBRARY_PATH="$LIBDIR" "$CHROME" --version
echo "✓ 就绪。运行浏览器测试："
echo "  LD_LIBRARY_PATH=$LIBDIR node --test tests/browser-draft-edit.test.mjs"
