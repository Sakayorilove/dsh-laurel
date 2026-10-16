/** Workspace identities are derived from host-owned cwd. Every project graph,
 * draft, layout and source map is partitioned; unowned legacy logs are not auto-assigned. */
import { createHash } from 'node:crypto';
const WORKSPACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/**
 * 校验工作区标识。
 *
 * 为什么必须严格：它会变成**目录名**。放任 `../` 会写出数据目录之外，
 * 放任空串会让所有项目落回同一个「全局」。
 */
export function isValidWorkspaceId(raw) {
    return typeof raw === 'string' && WORKSPACE_ID_RE.test(raw);
}
/**
 * 把任意来源的字符串规范成合法工作区 id。
 *
 * 返回 `null` 表示**无法安全归属** —— 调用方必须拒绝，不许猜一个默认值。
 * 这是刻意的：猜错的代价是把 A 项目的约束注入 B 项目。
 */
export function normalizeWorkspaceId(raw) {
    if (typeof raw !== 'string')
        return null;
    const trimmed = raw.trim();
    if (trimmed === '')
        return null;
    // 用正则直接判，不调用 isValidWorkspaceId —— 它是类型谓词 `raw is string`，
    // 而 trimmed 已经是 string，false 分支会被收窄成 never，后面的 replace 全部编不过。
    if (WORKSPACE_ID_RE.test(trimmed))
        return trimmed;
    // 路径或中文使用完整摘要，替换与截断都会导致不同项目碰撞。
    // 注意用 '-' 替换而不是删掉 —— 删掉会让 `a/b` 与 `ab` 撞成同一个 id。
    if (!/[\p{L}\p{N}]/u.test(trimmed))
        return null;
    return `ws-${createHash('sha256').update(trimmed).digest('hex')}`;
}
/** 旧版遗留的全局文件名（相对于 loom 根）。 */
export const LEGACY_GLOBAL_FILES = ['drafts.json', 'presentation.json', 'sourcemap.json'];
/** 一个工作区的状态目录名。 */
export function workspaceDirName(workspaceId) {
    return workspaceId;
}
/**
 * 规划旧全局文件 → 工作区的迁移。
 *
 * 纪律（评审步骤 1 第 3 条：「旧全局文件迁移需预览并保留备份，不能猜归属」）：
 *   - 只处理**调用方显式列出**的文件，不自动发现
 *   - 目标已存在 → 记为 blocker，**不静默覆盖**
 *   - `keepBackup` 由调用方决定；默认建议 true
 */
export function planMigration(req) {
    if (!isValidWorkspaceId(req.workspaceId)) {
        return { plans: [], blockers: [`工作区 id 不合法：「${String(req.workspaceId)}」`] };
    }
    if (req.root.trim() === '') {
        return { plans: [], blockers: ['loom 根目录为空'] };
    }
    const plans = [];
    const blockers = [];
    const inTarget = new Set(req.existingInTarget);
    for (const file of req.existing) {
        const to = `${req.root}/workspaces/${workspaceDirName(req.workspaceId)}/${file}`;
        const targetExists = inTarget.has(file);
        plans.push({ file, from: `${req.root}/${file}`, to, targetExists });
        if (targetExists) {
            blockers.push(`目标已存在同名文件：${to}。不会覆盖 —— 请先人工确认哪一份是当前有效的。`);
        }
    }
    return { plans, blockers };
}
export function checkOwnership(resourceWorkspaceId, requestWorkspaceId) {
    if (!isValidWorkspaceId(requestWorkspaceId)) {
        return {
            ok: false,
            reason: `请求没有提供合法的工作区 id（得到「${String(requestWorkspaceId)}」）。` +
                '无法归属就不读写 —— 不回落全局，避免跨项目覆盖。',
        };
    }
    if (!isValidWorkspaceId(resourceWorkspaceId)) {
        return {
            ok: false,
            reason: `资源没有记录工作区归属（得到「${String(resourceWorkspaceId)}」）。` +
                '这可能是旧版全局文件，需要先迁移到明确的工作区。',
        };
    }
    if (resourceWorkspaceId !== requestWorkspaceId) {
        return {
            ok: false,
            reason: `归属不匹配：资源属于「${resourceWorkspaceId}」，请求来自「${requestWorkspaceId}」。`,
        };
    }
    return { ok: true };
}
/**
 * 乐观并发闸门。
 *
 * 评审步骤 1 第 4 条：「草案写入携带 `expectedRevision`，旧窗口更新返回可定位冲突，
 * 不静默覆盖。」
 *
 * 语义：
 *   - `expectedRevision === null` → 调用方声明「我认为现在没有草案」。
 *     若实际已有草案 → 冲突（旧窗口凭「空」覆盖新稿，正是要拦的）。
 *   - `expectedRevision === n` → 必须与当前一致，否则冲突。
 *   - 当前无草案（null）而 expected 是数字 → 冲突（草案被别人删了或从没写过）。
 *
 * 不用「大于」判断：revision 必须**恰好相等**。允许「基于更旧的版本覆盖」
 * 会让两个窗口各改一半、后提交者赢，静默丢改动。
 */
export function checkRevisionGuard(current, guard) {
    const expected = guard.expectedRevision;
    if (current === expected)
        return { ok: true };
    const detail = expected === null
        ? `调用方以为还没有草案，但磁盘上已有 revision ${String(current)}。`
        : current === null
            ? `调用方基于 revision ${expected}，但磁盘上没有草案（可能已被删除或从未写入）。`
            : `调用方基于 revision ${expected}，磁盘上是 revision ${current}。`;
    return {
        ok: false,
        conflict: {
            currentRevision: current,
            expectedRevision: expected,
            detail: `${detail} 拒绝覆盖 —— 请先读取当前草案再重新提交。`,
        },
    };
}
