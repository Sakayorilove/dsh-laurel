/**
 * dsh-loom · 宿主半边：工作树管理（IO 层）。
 *
 * 职责边界：
 * - 本文件**只做 git 命令与磁盘操作**，所有裁决逻辑在 `core/worktree-plan.ts`。
 * - 不 import 任何 DSH 包 —— 只有 `node:*`。这样它能被独立测试，也不给宿主
 *   增加加载期耦合。（`scripts/check-bundle.mjs` 会断言这一点。）
 *
 * 为什么自己写而不是用现成库：
 * 我们只需要 4 条 git 命令（rev-parse / worktree add / status / worktree remove），
 * 用库要多背一个依赖、一层抽象、一份许可声明。用 `node:child_process` 直接调
 * git 是更短也更可控的路径 —— 出错时的 stderr 原样可见，不用猜库吞了什么。
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { executeWsl, toExecutionPath, toHostPath, wslToWindowsPath } from './bridge.js';
import { decideRetention, isLive, pickFreeSuffix, planIsolation, worktreeBranch, worktreePath, } from './core/worktree-plan.js';
import { ensureDir } from './config.js';
/** git 的超时。worktree add 在大仓库上会慢，给足 2 分钟。 */
const GIT_TIMEOUT_MS = 120_000;
export function git(cwd, args, timeoutMs = GIT_TIMEOUT_MS) {
    if (process.platform === 'win32') {
        const normalized = args.map((arg) => /^(?:[A-Za-z]:[\\/]|\\\\)/.test(arg) ? toExecutionPath(arg) : arg);
        return executeWsl(['git', ...normalized], cwd, { timeoutMs, maxOutputBytes: 4 * 1024 * 1024 })
            .then((result) => ({ code: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr }))
            .catch((error) => ({ code: 1, stdout: '', stderr: error.message }));
    }
    return new Promise((resolve) => {
        execFile('git', [...args], {
            cwd,
            timeout: timeoutMs,
            maxBuffer: 8 * 1024 * 1024,
            windowsHide: true,
            // 关掉交互式凭据提示：否则 git 在网络操作上会挂住等输入。
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
        }, (error, stdout, stderr) => {
            const code = error && typeof error.code === 'number'
                ? (error.code)
                : error
                    ? 1
                    : 0;
            resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        });
    });
}
export class WorktreeError extends Error {
    detail;
    constructor(message, detail = []) {
        super(message);
        this.name = 'WorktreeError';
        this.detail = detail;
    }
}
/**
 * 只读探测一个目录是不是 git 仓库，并拿到 baseSha。
 *
 * 注意 `--show-toplevel` 在 worktree 里返回的是**那棵树自己的**顶层，
 * `--git-common-dir` 才指向共享的 `.git`。我们同时读两个，才能判断
 * 「这个仓库能不能开工作树」（bare 仓库不行）。
 */
export async function probeRepo(path) {
    const detail = [];
    if (!existsSync(path))
        return { ok: false, detail: [`路径不存在：${path}`] };
    const inside = await git(path, ['rev-parse', '--is-inside-work-tree']);
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
        detail.push(`不是 git 工作树：${path}`);
        if (inside.stderr.trim())
            detail.push(inside.stderr.trim());
        return { ok: false, detail };
    }
    const isBare = await git(path, ['rev-parse', '--is-bare-repository']);
    if (isBare.stdout.trim() === 'true') {
        detail.push('是 bare 仓库，不能开工作树');
        return { ok: false, detail };
    }
    const top = await git(path, ['rev-parse', '--show-toplevel']);
    if (top.code !== 0) {
        detail.push(`拿不到仓库顶层：${top.stderr.trim()}`);
        return { ok: false, detail };
    }
    const topLevel = normalizeGitPath(top.stdout.trim());
    const head = await git(path, ['rev-parse', 'HEAD']);
    if (head.code !== 0) {
        // 空仓库（还没有任何提交）无法作为 baseSha 开工作树。
        detail.push('仓库还没有任何提交（HEAD 不存在），无法确定 baseSha');
        return { ok: false, topLevel, detail };
    }
    const headSha = head.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(headSha)) {
        detail.push(`HEAD 不是完整 sha：${headSha}`);
        return { ok: false, topLevel, detail };
    }
    // 判断当前目录是不是链接工作树（`--git-dir` 与 `--git-common-dir` 不同）。
    const gitDir = (await git(path, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
    const commonDir = (await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim();
    const isLinkedWorktree = gitDir !== '' && commonDir !== '' && normalizeGitPath(gitDir) !== normalizeGitPath(commonDir);
    return { ok: true, topLevel, headSha, isLinkedWorktree, detail };
}
/** Windows 上 git 可能回 `C:/x/y`，统一成平台分隔符便于比较。 */
function normalizeGitPath(p) {
    if (p === '')
        return p;
    p = toHostPath(p);
    const unified = p.replace(/\\/g, '/').replace(/\/+$/, '');
    try {
        return realpathSync.native ? realpathSync.native(unified) : realpathSync(unified);
    }
    catch {
        return unified;
    }
}
export function createWorktreeStore(paths) {
    const file = paths.worktrees;
    const append = (record) => {
        ensureDir(paths.root);
        appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    };
    const listAll = () => {
        if (!existsSync(file))
            return [];
        const out = [];
        for (const line of readFileSync(file, 'utf8').split('\n')) {
            const trimmed = line.trim();
            if (trimmed === '')
                continue;
            try {
                const parsed = JSON.parse(trimmed);
                if (parsed && typeof parsed.taskId === 'string' && typeof parsed.path === 'string')
                    out.push(parsed);
            }
            catch {
                // 事件日志式的容错：坏行跳过，不影响已解析的部分。
            }
        }
        return out;
    };
    const latest = () => {
        const map = new Map();
        for (const rec of listAll())
            map.set(`${rec.runId}\u0000${rec.taskId}`, rec);
        return map;
    };
    return { file, append, listAll, latest };
}
export function createWorktreeManager(options) {
    const { paths } = options;
    // 工作树落点：由 `DSH_LOOM_WSL_WORKTREE_BASE` 指定 WSL 侧基础目录（例如
    // `/home/<你的 WSL 用户>/projects/.dsh-loom`）；没配就退回插件自己的数据目录。
    const suffix = `worktrees-${createHash('sha256').update(paths.home).digest('hex').slice(0, 16)}`;
    const wslBase = process.env.DSH_LOOM_WSL_WORKTREE_BASE;
    const root = options.root ?? (process.platform === 'win32' && wslBase
        ? wslToWindowsPath(`${wslBase}/${suffix}`)
        : join(paths.root, suffix));
    const store = createWorktreeStore(paths);
    const log = options.log ?? { debug() { }, info() { }, warn() { }, error() { } };
    function now() {
        return new Date().toISOString();
    }
    function record(partial) {
        store.append(partial);
    }
    function preview(runId, taskIds) {
        const taken = new Set(store.listAll().filter((r) => isLive(r.state)).map((r) => r.path));
        return taskIds.map((taskId) => {
            let path = worktreePath(root, runId, taskId);
            if (taken.has(path)) {
                const suffix = pickFreeSuffix([...taken], path);
                path = suffix === null ? path : `${path}${suffix}`;
            }
            taken.add(path);
            return { taskId, path, branch: worktreeBranch(runId, taskId) };
        });
    }
    async function create(runId, repoPath, taskIds) {
        const problems = [];
        const probe = await probeRepo(repoPath);
        if (!probe.ok || probe.topLevel === undefined || probe.headSha === undefined) {
            return { ok: false, records: [], problems: probe.detail.length > 0 ? probe.detail : ['仓库探测失败'] };
        }
        const requests = taskIds.map((taskId) => ({
            taskId,
            repoPath: probe.topLevel,
            baseSha: probe.headSha,
        }));
        const issues = planIsolation(requests);
        if (issues.length > 0) {
            return { ok: false, baseSha: probe.headSha, repoPath: probe.topLevel, records: [], problems: issues.map((i) => i.detail) };
        }
        ensureDir(root);
        const planned = preview(runId, taskIds);
        const created = [];
        for (const plan of planned) {
            // baseSha 与分支都从同一个 HEAD 派生 —— `-b <branch> <path> <baseSha>`
            // 让「新分支」「工作树目录」「基线」三者在一条命令里同时确定。
            const res = await git(probe.topLevel, ['worktree', 'add', '-b', plan.branch, plan.path, probe.headSha]);
            if (res.code !== 0) {
                problems.push(`任务「${plan.taskId}」建树失败：${res.stderr.trim() || `git 退出码 ${res.code}`}`);
                log.warn(`worktree add 失败 task=${plan.taskId} path=${plan.path}`);
                break;
            }
            const rec = {
                taskId: plan.taskId,
                runId,
                path: plan.path,
                repoPath: probe.topLevel,
                baseSha: probe.headSha,
                branch: plan.branch,
                state: 'created',
                createdAt: now(),
                updatedAt: now(),
            };
            record(rec);
            created.push(rec);
            log.debug(`worktree created task=${plan.taskId} path=${plan.path}`);
        }
        if (problems.length > 0) {
            // 半边建成 = 不可用。回滚已建的那些，避免留下无主目录。
            // 注意 `--force` **不能**加：那些树里可能有 agent 已经写进去的东西，
            // 静默删掉就是数据丢失。移除失败就保留并如实记账。
            for (const rec of created.reverse()) {
                const rm = await git(probe.topLevel, ['worktree', 'remove', rec.path]);
                const removed = rm.code === 0;
                record({
                    ...rec,
                    state: removed ? 'removed' : 'dirty',
                    updatedAt: now(),
                    reason: `回滚：同批建树失败（${removed ? '已移除' : `移除失败，保留待人工处理：${rm.stderr.trim()}`}）`,
                });
            }
            return { ok: false, baseSha: probe.headSha, repoPath: probe.topLevel, records: [], problems };
        }
        return { ok: true, baseSha: probe.headSha, repoPath: probe.topLevel, records: created, problems: [] };
    }
    /** 读一棵树的「有没有值得保留的东西」。返回 null = 没拿到状态。 */
    async function readStatus(path, baseSha) {
        if (!existsSync(path))
            return null;
        const st = await git(path, ['status', '--porcelain=v1', '--untracked-files=all'], 30_000);
        if (st.code !== 0)
            return null;
        let changed = 0;
        let untracked = 0;
        for (const line of st.stdout.split('\n')) {
            if (line.length < 3)
                continue;
            const xy = line.slice(0, 2);
            if (xy === '??')
                untracked += 1;
            else
                changed += 1;
        }
        // 只数本任务自己产生的提交：baseSha..HEAD。
        const ahead = await git(path, ['rev-list', '--count', `${baseSha}..HEAD`], 30_000);
        if (ahead.code !== 0)
            return null;
        const commits = Number.parseInt(ahead.stdout.trim(), 10);
        if (!Number.isFinite(commits))
            return null;
        return { changed, untracked, commits, stashed: 0 };
    }
    async function settle(runId, taskId) {
        const key = `${runId}\u0000${taskId}`;
        const rec = store.latest().get(key);
        if (rec === undefined) {
            return { action: 'keep', nextState: 'unknown', reason: `找不到任务「${taskId}」的工作树记录` };
        }
        if (!isLive(rec.state)) {
            return { action: 'keep', nextState: 'removed', reason: `任务「${taskId}」的工作树已经移除过` };
        }
        const status = await readStatus(rec.path, rec.baseSha);
        const verdict = decideRetention(status);
        // 主仓库不在了（被挪走/删掉）就没法执行 worktree remove，只能保留并记账。
        if (!existsSync(rec.repoPath)) {
            record({
                ...rec,
                state: 'unknown',
                updatedAt: now(),
                reason: `保留：源仓库 ${rec.repoPath} 已不存在，无法安全移除`,
            });
            return { action: 'keep', nextState: 'unknown', reason: `源仓库不存在：${rec.repoPath}` };
        }
        if (verdict.action === 'remove') {
            // `git worktree remove` **必须**在主仓库里跑。
            // 在工作树里跑会报 "not a git repository"（工作树的 .git 是文件不是目录），
            // 在工作树的父目录跑也不是仓库 —— 这是最初实现踩过的坑。
            const rm = await git(rec.repoPath, ['worktree', 'remove', rec.path]);
            if (rm.code !== 0) {
                record({
                    ...rec,
                    state: 'unknown',
                    updatedAt: now(),
                    reason: `保留：判定为干净但移除失败（${rm.stderr.trim() || `退出码 ${rm.code}`}）`,
                });
                return { action: 'keep', nextState: 'unknown', reason: `判定为干净但移除失败：${rm.stderr.trim()}` };
            }
            record({ ...rec, state: 'removed', updatedAt: now(), reason: verdict.reason });
            log.info(`worktree removed task=${taskId}（干净）`);
            return verdict;
        }
        record({ ...rec, state: verdict.nextState, updatedAt: now(), reason: verdict.reason });
        log.info(`worktree kept task=${taskId}：${verdict.reason}`);
        return verdict;
    }
    async function settleRun(runId) {
        const live = listLive(runId);
        const out = [];
        for (const rec of live)
            out.push(await settle(runId, rec.taskId));
        return out;
    }
    function listLive(runId) {
        const map = store.latest();
        const out = [];
        for (const rec of map.values()) {
            if (!isLive(rec.state))
                continue;
            if (runId !== undefined && rec.runId !== runId)
                continue;
            out.push(rec);
        }
        return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }
    /**
     * 只看某一棵树的记录。**不管它是否还活着** —— 已移除的也要能找到，
     * 否则「已经没了」和「从来没建过」就分不清（评审 09 A 的破坏性确认需要区分）。
     */
    function find(runId, taskId) {
        return store.latest().get(`${runId}\u0000${taskId}`) ?? null;
    }
    /**
     * 这棵树「应该」在哪。
     *
     * 优先用已记录的真实路径；没有记录时退回**路径规划**（不落盘），
     * 这样「签发 token 让用户确认路径」这一步在记录还没落盘时也拿得到目标。
     */
    function pathFor(runId, taskId) {
        const rec = find(runId, taskId);
        if (rec !== null)
            return rec.path;
        const planned = preview(runId, [taskId]);
        return planned[0]?.path ?? worktreePath(root, runId, taskId);
    }
    /**
     * 这棵树里有什么会被丢掉。用于向用户展示「删的代价」，不能只说「有改动」。
     *
     * 只读 git status / stash list，不写。任何一步失败都如实说明，
     * 不假装「干净」—— 假装干净会误导用户确认删除。
     */
    async function describeChanges(runId, taskId) {
        const rec = find(runId, taskId);
        const target = rec?.path ?? pathFor(runId, taskId);
        const notes = [];
        if (rec === null) {
            notes.push(`没有工作树记录（目标路径 ${target}）。可能尚未创建，或记录已过期。`);
            return notes;
        }
        if (!existsSync(target)) {
            notes.push(`目标路径已不存在：${target}`);
            return notes;
        }
        const status = await git(target, ['status', '--porcelain']);
        if (status.code === 0 && status.stdout.trim() !== '') {
            const lines = status.stdout.trim().split('\n');
            notes.push(`未提交改动 ${lines.length} 项：`, ...lines.slice(0, 20));
            if (lines.length > 20)
                notes.push(`… 另有 ${lines.length - 20} 项`);
        }
        const stash = await git(target, ['stash', 'list']);
        if (stash.code === 0 && stash.stdout.trim() !== '') {
            notes.push('stash 里还有内容：', ...stash.stdout.trim().split('\n'));
        }
        const unpushed = await git(target, ['log', '--branches', '--not', '--remotes', '--oneline']);
        if (unpushed.code === 0 && unpushed.stdout.trim() !== '') {
            notes.push('有未推送的提交：', ...unpushed.stdout.trim().split('\n').slice(0, 20));
        }
        if (notes.length === 0)
            notes.push('未发现未提交改动或未推送提交（仍然会被永久删除工作树目录）。');
        return notes;
    }
    async function forceRemove(runId, taskId) {
        const rec = store.latest().get(`${runId}\u0000${taskId}`);
        if (rec === undefined)
            return { ok: false, detail: `找不到任务「${taskId}」的工作树记录` };
        if (!isLive(rec.state))
            return { ok: true, detail: '已经是移除状态' };
        if (!existsSync(rec.repoPath)) {
            return { ok: false, detail: `源仓库 ${rec.repoPath} 已不存在，无法执行 worktree remove` };
        }
        const rm = await git(rec.repoPath, ['worktree', 'remove', '--force', rec.path]);
        if (rm.code !== 0) {
            return { ok: false, detail: rm.stderr.trim() || `git 退出码 ${rm.code}` };
        }
        record({ ...rec, state: 'removed', updatedAt: now(), reason: '用户强制移除' });
        return { ok: true, detail: '已强制移除' };
    }
    return { create, settle, settleRun, listLive, find, pathFor, describeChanges, forceRemove, preview };
}
/** 收尾：`git worktree prune` 清掉已经不存在的工作树的元数据。 */
export async function pruneWorktrees(repoPath) {
    return git(repoPath, ['worktree', 'prune']);
}
/** 删除一个分支（树移除之后调用）。失败不抛 —— 分支可能已经被合并删除。 */
export async function deleteBranch(repoPath, branch) {
    return git(repoPath, ['branch', '-D', branch]);
}
/* ------------------------------------------------------------------ *
 * 逐任务 cwd 会话元数据
 * ------------------------------------------------------------------ */
/**
 * 把官方 `childSessionMeta()` 的产物改写成指向本任务工作树。
 *
 * 为什么必须覆盖：官方那个函数**原样继承父 cwd**（见
 * `dsh-subagent/lib/types/child-agent.js:111`），不清空的话所有子代理会
 * 共用一个目录，隔离等于没做。
 *
 * 只改 `cwd`，其余字段（parentSession / isSeeded / origin / delegationDepth /
 * agentPreset）全部保留 —— 那条血缘链是宿主用来重建历史的，动它会把
 * 子会话历史搞坏。
 */
export function withTaskCwd(meta, worktreePath) {
    return { ...meta, cwd: worktreePath };
}
/** 断言工作树路径是绝对的 —— 宿主的 session 校验只认绝对路径。 */
export function assertAbsoluteForSession(p) {
    const isWin = /^[A-Za-z]:[/\\]/.test(p) || p.startsWith('\\\\');
    const isPosix = p.startsWith('/');
    if (!isWin && !isPosix) {
        throw new WorktreeError(`工作树路径必须是绝对路径，实际是「${p}」（宿主 session 校验会拒绝）`);
    }
}
