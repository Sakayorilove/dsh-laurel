/**
 * 工作树（git worktree）的**纯逻辑层**：路径规划、命名、保留裁决、状态归约。
 *
 * 这一层不做任何 IO，也不认识 git 命令 —— 它只回答「该怎么命名」「该不该删」。
 * 真正的 `git worktree add/remove` 在 `src/worktree.ts`（宿主半边）。
 *
 * 为什么把裁决逻辑单独抽出来：保留/清理策略是**会出错就毁数据**的地方
 * （误删未提交改动 = 用户的工作没了）。所以它必须是可穷举测试的纯函数。
 *
 * 隔离语义（对齐 docs/compatibility-report.md §3.1）：
 * 每个任务一棵独立的 git worktree，通过覆盖 `CreateAgentOptions.meta.cwd`
 * 让子 agent 在那个目录里跑 —— session 的 cwd 既是工具路径解析根，
 * 也是沙箱 workspace-write 边界。
 */
/* ------------------------------------------------------------------ *
 * 命名
 * ------------------------------------------------------------------ */
/** 任务 id 已经过 `ID_PATTERN` 校验（`^[a-z][a-z0-9_-]{0,63}$`），可以直接进分支名。 */
export function worktreeBranch(runId, taskId) {
    return `loom/${sanitizeRefSegment(runId)}/${sanitizeRefSegment(taskId)}`;
}
/** 目录名：用 `__` 连接，避免 `/` 造出子目录。 */
export function worktreeDirName(runId, taskId) {
    return `${sanitizeRefSegment(runId)}__${sanitizeRefSegment(taskId)}`;
}
/**
 * 把任意字符串变成合法的 git ref 段。
 *
 * git ref 的禁用字符比想象的毒：空格、`~^:?*[\`、`..`、`@{`、结尾 `.lock`、
 * 以 `.` 开头或结尾、ASCII 控制字符。任务 id 已经受约束，
 * 但 runId 是 UUID 风格的自造值，这里统一兜一遍，**宁可改写也不让 git 报错**。
 */
export function sanitizeRefSegment(raw) {
    let out = '';
    for (const ch of raw) {
        const code = ch.codePointAt(0) ?? 0;
        if (code < 0x20 || code === 0x7f)
            continue;
        if (' ~^:?*[\\{}'.includes(ch)) {
            out += '-';
            continue;
        }
        out += ch;
    }
    // `@{` 是 git 的 reflog 语法，即使字符本身合法也要拆开。
    out = out.replace(/@\{/g, '@-');
    // 折叠连续的 `..` 与 `/`，去掉开头/结尾的 `.` 和 `/`
    out = out.replace(/\.\.+/g, '.').replace(/\/+/g, '-');
    out = out.replace(/^[./@-]+/, '').replace(/[./@-]+$/, '');
    if (out.endsWith('.lock'))
        out = out.slice(0, -'.lock'.length);
    if (out.length === 0)
        out = 'unnamed';
    if (out.length > 96)
        out = out.slice(0, 96);
    return out;
}
export function worktreePath(root, runId, taskId) {
    const sep = root.includes('\\') ? '\\' : '/';
    const trimmed = root.replace(/[/\\]+$/, '');
    return `${trimmed}${sep}${worktreeDirName(runId, taskId)}`;
}
export const EMPTY_STATUS = { changed: 0, untracked: 0, commits: 0, stashed: 0 };
/**
 * 决定这棵树该不该删。
 *
 * **默认保留。** 只有「三项全零」才删 —— 脏数据比磁盘空间贵得多。
 * `status === null` 表示**没拿到状态**（git 失败、目录没了、超时），
 * 那也必须保留：不知道就等于不安全。
 *
 * @param status 树状态；`null` = 未知。
 */
export function decideRetention(status) {
    if (status === null) {
        return {
            action: 'keep',
            nextState: 'unknown',
            reason: '拿不到工作树状态（git status 失败或目录不可读），按不删处理',
        };
    }
    const reasons = [];
    if (status.changed > 0)
        reasons.push(`${status.changed} 个未提交改动`);
    if (status.untracked > 0)
        reasons.push(`${status.untracked} 个未跟踪文件`);
    if (status.commits > 0)
        reasons.push(`${status.commits} 个新提交`);
    if (status.stashed > 0)
        reasons.push(`${status.stashed} 个 stash`);
    if (reasons.length > 0) {
        return { action: 'keep', nextState: 'dirty', reason: `保留：${reasons.join('、')}` };
    }
    return { action: 'remove', nextState: 'clean', reason: '移除：工作树干净，无改动无新提交' };
}
/**
 * 扫描一棵树的「有没有值得保留的东西」时，判据只看**这个任务自己的贡献**。
 * 所以 commits 是相对 `baseSha` 数的，不是 `git rev-list --count HEAD`。
 * 这个函数把两个数安全带地相减并夹到非负。
 */
export function commitsSince(aheadCount) {
    if (aheadCount === null || !Number.isFinite(aheadCount))
        return 0;
    return Math.max(0, Math.trunc(aheadCount));
}
/* ------------------------------------------------------------------ *
 * 状态归约
 * ------------------------------------------------------------------ */
/** 允许的状态迁移。任何不在表里的迁移都是 bug，不是「容忍一下」。 */
const TRANSITIONS = {
    created: ['active', 'clean', 'dirty', 'unknown', 'removed'],
    active: ['clean', 'dirty', 'unknown', 'removed'],
    clean: ['removed'],
    dirty: ['removed'],
    unknown: ['removed'],
    removed: [],
};
export function canTransition(from, to) {
    return TRANSITIONS[from].includes(to);
}
export function assertTransition(from, to, taskId) {
    if (!canTransition(from, to)) {
        throw new Error(`工作树状态非法迁移：任务「${taskId}」不能从 ${from} 变成 ${to}`);
    }
}
/** 终态之外都算「活着」。 */
export function isLive(state) {
    return state !== 'removed';
}
const SHA_RE = /^[0-9a-f]{40}$/;
const TASK_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
/**
 * 派发前的隔离前置检查。
 *
 * 「同一基线」是 Loom 的硬要求（03 的验收项）——并行任务如果不在同一 baseSha 上，
 * 合并时会产生无法归因的冲突。所以这里**只在全部一致时才放行**，不一致就报错，
 * 不静默取第一个。
 */
export function planIsolation(requests) {
    const issues = [];
    if (requests.length === 0) {
        issues.push({ code: 'EMPTY', taskId: '', detail: '没有任务需要隔离' });
        return issues;
    }
    const seen = new Set();
    for (const req of requests) {
        if (!TASK_ID_RE.test(req.taskId)) {
            issues.push({ code: 'BAD_TASK_ID', taskId: req.taskId, detail: `任务 id 不合法：${req.taskId}` });
        }
        if (seen.has(req.taskId)) {
            issues.push({ code: 'DUPLICATE_TASK', taskId: req.taskId, detail: `任务 id 重复：${req.taskId}` });
        }
        seen.add(req.taskId);
        if (!SHA_RE.test(req.baseSha)) {
            issues.push({
                code: 'BAD_BASE_SHA',
                taskId: req.taskId,
                detail: `baseSha 必须是 40 位小写 hex，实际是「${req.baseSha}」`,
            });
        }
    }
    const repo = requests[0].repoPath;
    const base = requests[0].baseSha;
    for (const req of requests.slice(1)) {
        if (req.repoPath !== repo) {
            issues.push({
                code: 'DIFFERENT_REPO',
                taskId: req.taskId,
                detail: `要求同一仓库，但任务「${req.taskId}」的仓库是 ${req.repoPath}，其余是 ${repo}`,
            });
        }
        if (req.baseSha !== base) {
            issues.push({
                code: 'DIFFERENT_BASE',
                taskId: req.taskId,
                detail: `要求同一 baseSha，但任务「${req.taskId}」是 ${req.baseSha}，其余是 ${base}`,
            });
        }
    }
    return issues;
}
/* ------------------------------------------------------------------ *
 * 分支/树名冲突
 * ------------------------------------------------------------------ */
/**
 * `git worktree add` 对**已存在的路径**会直接失败。重跑同一个 run 时
 * 目录可能还在（上一轮保留的脏树）。所以派发前必须换一个不冲突的名字，
 * 或者先确认那棵树是本次 run 的。
 *
 * 返回一个没被占用的后缀（`''` 表示原名可用）。
 */
export function pickFreeSuffix(taken, base, maxTries = 100) {
    const set = new Set(taken);
    if (!set.has(base))
        return '';
    for (let i = 2; i <= maxTries; i += 1) {
        const candidate = `${base}-${i}`;
        if (!set.has(candidate))
            return `-${i}`;
    }
    return null;
}
/* ------------------------------------------------------------------ *
 * 派发标签：把「这一趟派发属于哪个 run 的哪个任务」编码进 child label
 * ------------------------------------------------------------------ */
/**
 * ── 为什么用 label 传递工作树归属 ──────────────────────────────────────
 *
 * `SubagentStartRequest`（`@deepseek-ai/dsh-subagent`）**没有** cwd 字段，
 * 也不该有：cwd 是会话创建元数据，不是委托参数。可用的传递通道只有 label：
 *
 *   `label?: string` — "Optional short display label persisted with a
 *   session-backed child."
 *
 * 于是 Loom 在派发前把归属编码进 label，provider 在 `start()` 里解回来。
 * 这不是 hack：label 本来就是「这次派发的标识」，而 Loom 需要的正是
 * 「这次派发对应哪棵树」。编码保留了人可读性。
 *
 * ── 为什么必须能明确失败 ────────────────────────────────────────────────
 * label 解析不出来时**绝不能**回落到父会话 cwd —— 那正是「子代理偷偷
 * 在父目录里写代码」这个最危险的失败模式。所以 `parseDispatchLabel()`
 * 返回 null，provider 拿到 null 就抛（见 src/provider.ts）。
 */
/** 派发标签前缀。改它等于改协议，两边必须同步。 */
export const DISPATCH_LABEL_PREFIX = 'loom';
/** 构造派发标签。`runId` / `taskId` 必须已过 `sanitizeRefSegment`（建树时已做）。 */
export function dispatchLabel(runId, taskId) {
    return DISPATCH_LABEL_PREFIX + ':' + runId + ':' + taskId;
}
/**
 * 解析派发标签。**不是** Loom 派发的 label 一律返回 null。
 *
 * 认三件事：前缀、恰好 3 段、两个段都非空。多一个冒号就返回 null ——
 * 宁可不认，也不猜哪一段是 id。
 */
export function parseDispatchLabel(label) {
    if (typeof label !== 'string')
        return null;
    const parts = label.split(':');
    if (parts.length !== 3)
        return null;
    const prefix = parts[0];
    const runId = parts[1];
    const taskId = parts[2];
    if (prefix !== DISPATCH_LABEL_PREFIX)
        return null;
    if (runId === undefined || taskId === undefined)
        return null;
    if (runId === '' || taskId === '')
        return null;
    return { runId, taskId };
}
/**
 * 在「已登记的活树」里找出这次派发该用的那棵。
 *
 * 输入是 `WorktreeRecord` 列表（调用方从 store 里取最近一次状态），
 * 输出是裁决。**五种拒绝各有独立原因码**，因为它们的处置方式不同：
 * `NO_LABEL`/`BAD_LABEL` 是调用方写错，`NO_RECORD` 是顺序错（先派发后建树），
 * `NOT_LIVE` 是树已结算，`NO_REPO`/`BAD_PATH` 是记录损坏。
 */
export function resolveDispatch(label, records) {
    if (label === undefined) {
        return { ok: false, code: 'NO_LABEL', detail: '派发没有带 label，无法确定用哪棵工作树' };
    }
    const parsed = parseDispatchLabel(label);
    if (parsed === null) {
        return {
            ok: false,
            code: 'BAD_LABEL',
            detail: 'label「' + label + '」不是 Loom 派发标签（期望 ' + DISPATCH_LABEL_PREFIX + ':<runId>:<taskId>）',
        };
    }
    const hit = records.find((r) => r.runId === parsed.runId && r.taskId === parsed.taskId);
    if (hit === undefined) {
        return { ok: false, code: 'NO_RECORD', detail: '找不到 ' + parsed.runId + ' / ' + parsed.taskId + ' 的工作树记录' };
    }
    if (!isLive(hit.state)) {
        return { ok: false, code: 'NOT_LIVE', detail: '工作树 ' + parsed.taskId + ' 的状态是 ' + hit.state + '，不能派发进去' };
    }
    if (hit.repoPath === '') {
        return { ok: false, code: 'NO_REPO', detail: '工作树记录缺 repoPath，无法确认归属（settle 需要它）' };
    }
    if (hit.path === '') {
        return { ok: false, code: 'BAD_PATH', detail: '工作树记录缺 path' };
    }
    return { ok: true, runId: parsed.runId, taskId: parsed.taskId, path: hit.path };
}
/**
 * 从一批记录里取「最近一次状态」。store 是追加式的，
 * 同一 `runId/taskId` 可能有多条（created → active → clean）。
 */
export function latestRecords(records) {
    const map = new Map();
    for (const rec of records)
        map.set(rec.runId + '\u0000' + rec.taskId, rec);
    return [...map.values()];
}
