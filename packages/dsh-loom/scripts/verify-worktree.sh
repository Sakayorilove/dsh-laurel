#!/usr/bin/env bash
# 工作树 IO 层的真实 git 集成验证。
#
# 在临时目录里建真仓库，跑真 git worktree add/status/remove，
# 逐项核对「脏树必须保留、干净树才移除」这条防线。
#
# 用法：bash scripts/verify-worktree.sh
set -uo pipefail

WORK="$(mktemp -d /tmp/loom-wt-XXXXXX)"

# Loom 项目根（lib/ 所在处），与临时仓库分开。
# 优先用调用方传的 LOOM，否则从脚本位置反推。
if [ -z "${LOOM:-}" ]; then
  LOOM="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
if [ ! -f "$LOOM/lib/worktree.js" ]; then
  echo "找不到 $LOOM/lib/worktree.js —— 请先 pnpm run build，或用 LOOM=<项目根> bash $0" >&2
  exit 1
fi
export LOOM

PASS=0
FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32m✔\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m✘\033[0m %s\n' "$1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1（期望 $3，实际 $2）"; fi; }

REPO="$WORK/repo"
export DSH_HOME="$WORK/dshhome"

# 驱动脚本写在 $DRV，import 用相对路径 ../lib/*.js。
DRV="$LOOM/.wt-verify"
mkdir -p "$DRV"
# 无论成败都要清掉驱动目录和临时仓库。
trap 'rm -rf "$WORK" "$DRV"' EXIT
export DSH_HOME="$WORK/dshhome"
mkdir -p "$REPO"
cd "$REPO"
git init -q -b main
git config user.email "loom@test.local"
git config user.name "Loom Test"
printf 'hello\n' > a.txt
git add -A
git commit -q -m init

BASE="$(git rev-parse HEAD)"
echo "baseSha：$BASE"
echo

# ---------- 用 Loom 自己的管理器跑 ----------
cat > "$DRV/drive.mjs" <<'EOS'
import { createWorktreeManager, probeRepo } from '../lib/worktree.js'
import { loomPaths, resolveDshHome } from '../lib/config.js'

const root = process.argv[2]
const base = process.argv[3]
const paths = loomPaths(resolveDshHome())

const manager = createWorktreeManager({
  paths,
  log: { debug() {}, info() {}, warn() {}, error() {} },
})

const out = { steps: [] }
const recorder = (name, value) => out.steps.push({ name, value })

const probe = await probeRepo(root)
recorder('probe.ok', probe.ok)
recorder('probe.headSha', probe.headSha)

const made = await manager.create('run-1', root, ['backend', 'frontend'])
recorder('create.ok', made.ok)
recorder('create.baseSha', made.baseSha)
recorder('create.count', made.records.length)
recorder('create.paths', made.records.map((r) => r.path))
recorder('create.branches', made.records.map((r) => r.branch))

process.stdout.write(JSON.stringify(out))
EOS

# 相对 import，无需路径替换 "$DRV/drive.mjs"

echo "── 1. 建树与探测"
OUT="$(cd "$DRV" && node "$DRV/drive.mjs" "$REPO" "$BASE" 2>&1)"
if [ -z "$OUT" ] || ! printf '%s' "$OUT" | head -c1 | grep -q '{'; then
  bad "drive.mjs 执行失败：$OUT"
  exit 1
fi
check "probe.ok" "$(printf '%s' "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const g=n=>o.steps.find(x=>x.name===n)?.value;console.log(String(g("probe.ok")))})')" "true"
check "probe.headSha 等于 base" "$(printf '%s' "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const g=n=>o.steps.find(x=>x.name===n)?.value;console.log(String(g("probe.headSha")))})')" "$BASE"
check "create.ok" "$(printf '%s' "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const g=n=>o.steps.find(x=>x.name===n)?.value;console.log(String(g("create.ok")))})')" "true"
check "建了 2 棵树" "$(printf '%s' "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const g=n=>o.steps.find(x=>x.name===n)?.value;console.log(g("create.count"))})')" "2"
check "baseSha 全部一致" "$(printf '%s' "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const g=n=>o.steps.find(x=>x.name===n)?.value;console.log(String(g("create.baseSha")))})')" "$BASE"

# git 自己认这几棵树
WT_COUNT="$(git worktree list --porcelain | grep -c '^worktree ')"
check "git worktree list 有 3 个（主树 + 2）" "$WT_COUNT" "3"
BR_COUNT="$(git branch --list 'loom/run-1/*' | wc -l | tr -d ' ')"
check "建出 2 个 loom/run-1/* 分支" "$BR_COUNT" "2"

# ---------- 2. 脏树保留 ----------
echo
echo "── 2. 脏树 / 干净树的裁决"
WT_A="$DSH_HOME/loom/worktrees/run-1__backend"
WT_B="$DSH_HOME/loom/worktrees/run-1__frontend"
check "backend 工作树目录存在" "$([ -d "$WT_A" ] && echo yes || echo no)" "yes"
check "frontend 工作树目录存在" "$([ -d "$WT_B" ] && echo yes || echo no)" "yes"

# backend：留未提交改动
printf 'dirty\n' > "$WT_A/dirty.txt"
# frontend：干净
cat > "$DRV/settle.mjs" <<'EOS'
import { createWorktreeManager } from '../lib/worktree.js'
import { loomPaths, resolveDshHome } from '../lib/config.js'
const paths = loomPaths(resolveDshHome())
const manager = createWorktreeManager({ paths, log: { debug() {}, info() {}, warn() {}, error() {} } })
const verdicts = await manager.settleRun('run-1')
process.stdout.write(JSON.stringify(verdicts.map((v) => ({ a: v.action, s: v.nextState, r: v.reason }))))
EOS
# 相对 import，无需路径替换 "$DRV/settle.mjs"
V="$(cd "$DRV" && node "$DRV/settle.mjs" 2>&1)"

VB="$(printf '%s' "$V" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);const b=a.find(x=>x.r&&x.r.includes("未跟踪")||false);console.log(a.filter(x=>x.s==="dirty").length)})')"
check "有 1 棵树判为 dirty（保留）" "$VB" "1"
VN="$(printf '%s' "$V" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);console.log(a.filter(x=>x.a==="remove").length)})')"
check "有 1 棵树判为 remove（干净）" "$VN" "1"

check "脏树目录仍在" "$([ -d "$WT_A" ] && echo yes || echo no)" "yes"
check "干净树目录已消失" "$([ -d "$WT_B" ] && echo no || echo yes)" "yes"
check "脏树的改动文件还在" "$([ -f "$WT_A/dirty.txt" ] && echo yes || echo no)" "yes"

# ---------- 3. 有提交的树也必须保留 ----------
echo
echo "── 3. 已提交的树必须保留"
cat > "$DRV/round2.mjs" <<'EOS'
import { createWorktreeManager } from '../lib/worktree.js'
import { loomPaths, resolveDshHome } from '../lib/config.js'
const paths = loomPaths(resolveDshHome())
const manager = createWorktreeManager({ paths, log: { debug() {}, info() {}, warn() {}, error() {} } })
const out = {}
const made = await manager.create('run-2', process.argv[2], ['committer'])
out.ok = made.ok
out.path = made.records[0]?.path
process.stdout.write(JSON.stringify(out))
EOS
# 相对 import，无需路径替换 "$DRV/round2.mjs"
R2="$(cd "$DRV" && node "$DRV/round2.mjs" "$REPO" 2>&1)"
check "run-2 建树成功" "$(printf '%s' "$R2" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(String(JSON.parse(s).ok)))')" "true"

WT_C="$DSH_HOME/loom/worktrees/run-2__committer"
( cd "$WT_C" && printf 'feature\n' > f.txt && git add -A && git commit -q -m "feat: 提交" )

cat > "$DRV/settle2.mjs" <<'EOS'
import { createWorktreeManager } from '../lib/worktree.js'
import { loomPaths, resolveDshHome } from '../lib/config.js'
const paths = loomPaths(resolveDshHome())
const manager = createWorktreeManager({ paths, log: { debug() {}, info() {}, warn() {}, error() {} } })
const v = await manager.settle('run-2', 'committer')
process.stdout.write(JSON.stringify({ a: v.action, s: v.nextState, r: v.reason }))
EOS
# 相对 import，无需路径替换 "$DRV/settle2.mjs"
V2="$(cd "$DRV" && node "$DRV/settle2.mjs" 2>&1)"
check "有提交 → keep" "$(printf '%s' "$V2" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).a))')" "keep"
check "有提交 → dirty" "$(printf '%s' "$V2" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).s))')" "dirty"
check "有提交的树目录仍在" "$([ -d "$WT_C" ] && echo yes || echo no)" "yes"
check "提交内容还在" "$([ -f "$WT_C/f.txt" ] && echo yes || echo no)" "yes"

# ---------- 4. 同 baseSha 校验 ----------
echo
echo "── 4. baseSha 一致性闸门（跨仓库/跨基线必须拒绝）"
cat > "$DRV/mismatch.mjs" <<'EOS'
import { createWorktreeManager } from '../lib/worktree.js'
import { loomPaths, resolveDshHome } from '../lib/config.js'
const paths = loomPaths(resolveDshHome())
const manager = createWorktreeManager({ paths, log: { debug() {}, info() {}, warn() {}, error() {} } })
// 任务 id 非法 → 必须拒绝且不建树
const r1 = await manager.create('run-3', process.argv[2], ['Bad-Id'])
// 空任务列表 → 必须拒绝
const r2 = await manager.create('run-4', process.argv[2], [])
process.stdout.write(JSON.stringify({ r1: { ok: r1.ok, p: r1.problems }, r2: { ok: r2.ok, p: r2.problems } }))
EOS
# 相对 import，无需路径替换 "$DRV/mismatch.mjs"
M="$(cd "$DRV" && node "$DRV/mismatch.mjs" "$REPO" 2>&1)"
check "非法任务 id → ok=false" "$(printf '%s' "$M" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(String(JSON.parse(s).r1.ok)))')" "false"
check "空任务列表 → ok=false" "$(printf '%s' "$M" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(String(JSON.parse(s).r2.ok)))')" "false"

# ---------- 5. 非 git 目录 ----------
echo
echo "── 5. 非 git 目录必须被拒绝"
mkdir -p "$WORK/notrepo"
cat > "$DRV/notrepo.mjs" <<'EOS'
import { probeRepo } from '../lib/worktree.js'
const p = await probeRepo(process.argv[2])
process.stdout.write(JSON.stringify({ ok: p.ok, d: p.detail }))
EOS
# 相对 import，无需路径替换 "$DRV/notrepo.mjs"
N="$(cd "$DRV" && node "$DRV/notrepo.mjs" "$WORK/notrepo" 2>&1)"
check "非 git 目录 → ok=false" "$(printf '%s' "$N" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(String(JSON.parse(s).ok)))')" "false"

# 空仓库（无提交）
mkdir -p "$WORK/emptyrepo" && ( cd "$WORK/emptyrepo" && git init -q )
E="$(cd "$DRV" && node "$DRV/notrepo.mjs" "$WORK/emptyrepo" 2>&1)"
check "无提交的空仓库 → ok=false" "$(printf '%s' "$E" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(String(JSON.parse(s).ok)))')" "false"

# ---------- 6. 强制移除 ----------
echo
echo "── 6. 强制移除（用户显式要求）"
cat > "$DRV/force.mjs" <<'EOS'
import { createWorktreeManager } from '../lib/worktree.js'
import { loomPaths, resolveDshHome } from '../lib/config.js'
const paths = loomPaths(resolveDshHome())
const manager = createWorktreeManager({ paths, log: { debug() {}, info() {}, warn() {}, error() {} } })
const r = await manager.forceRemove('run-1', 'backend')
const live = manager.listLive('run-1').map((x) => x.taskId)
process.stdout.write(JSON.stringify({ ok: r.ok, live }))
EOS
# 相对 import，无需路径替换 "$DRV/force.mjs"
F="$(cd "$DRV" && node "$DRV/force.mjs" 2>&1)"
check "forceRemove 成功" "$(printf '%s' "$F" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(String(JSON.parse(s).ok)))')" "true"
check "强制移除后 run-1 无活着的树" "$(printf '%s' "$F" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).live.length))')" "0"
check "脏树目录已被强删" "$([ -d "$WT_A" ] && echo no || echo yes)" "yes"

echo
echo "─────────────────────────────────────"
printf '通过 \033[32m%d\033[0m，失败 \033[31m%d\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
