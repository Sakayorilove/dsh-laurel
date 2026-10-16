/**
 * dsh-loom · 宿主半边：配置与路径。
 *
 * 纪律（沿用 Laurel 套件已验证的做法）：
 * - **家目录只认 `DSH_HOME` 环境变量**，不从 `DSH_PROFILE_DIR` 往上推
 *   —— Electron fork 出来的子进程里没有 `DSH_HOME`，往上推会推到错误位置。
 * - 所有 IO 都在调用方 try/catch，配置坏了不许影响宿主启动。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isValidWorkspaceId } from './core/scope.js';
export const PACKAGE_NAME = 'dsh-loom';
/**
 * 版本号。**必须与 `package.json` 的 `version` 一致** ——
 * 评审 09 的 H 发现过两处不一致（源码写 0.1.0、package.json 写 0.2.0），
 * 那种不一致会让「包是什么状态」无法核对。`scripts/check-bundle.mjs` 会断言相等。
 */
export const VERSION = '0.8.6';
/** 解析 dsh 家目录。 */
export function resolveDshHome() {
    const fromEnv = process.env['DSH_HOME'];
    if (typeof fromEnv === 'string' && fromEnv.trim().length > 0)
        return resolve(fromEnv.trim());
    return join(homedir(), '.dsh');
}
export function loomPaths(home = resolveDshHome()) {
    const root = join(home, 'loom');
    return {
        home,
        root,
        revisions: join(root, 'revisions.jsonl'),
        architectures: join(root, 'architectures.jsonl'),
        events: join(root, 'events.log'),
        runs: join(root, 'runs.jsonl'),
        worktrees: join(root, 'worktrees.jsonl'),
        legacyDrafts: join(root, 'drafts.json'),
        legacyPresentation: join(root, 'presentation.json'),
        legacySourcemap: join(root, 'sourcemap.json'),
        workspacesRoot: join(root, 'workspaces'),
    };
}
/**
 * 取某个工作区的分区路径。
 *
 * ⚠ 工作区 id 不合法时**抛错**，不回落全局 —— 那正是评审 F 描述的泄漏路径。
 * 调用方应先用 `normalizeWorkspaceId()` 把外部输入规范化。
 */
export function loomWorkspacePaths(paths, workspaceId) {
    if (!isValidWorkspaceId(workspaceId)) {
        throw new Error(`工作区 id 不合法：「${String(workspaceId)}」。` +
            '无法归属就不读写 —— 不回落全局，避免跨项目覆盖。');
    }
    const dir = join(paths.workspacesRoot, workspaceId);
    return {
        workspaceId,
        dir,
        drafts: join(dir, 'drafts.json'),
        presentation: join(dir, 'presentation.json'),
        sourcemap: join(dir, 'sourcemap.json'),
        revisions: join(dir, 'revisions.jsonl'),
        architectures: join(dir, 'architectures.jsonl'),
    };
}
export function ensureDir(dir) {
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
}
export const DEFAULT_CONFIG = {
    enabled: true,
    defaultMode: 'auto',
    autoCollectReplies: true,
    allowModelDraftWrite: false,
    defaultMaxConcurrency: 2,
    maxRepairRounds: 1,
    injectDraftSummary: true,
    edgeArrows: true,
    edgeMotion: 'auto',
    planningModeDefault: false,
    planningModeColor: '#6ea8fe',
    welcomeEnabled: true,
    welcomeFont: 'inherit',
    welcomeFontSize: 16,
    welcomeColor: '#e6e8ea',
    welcomeGlow: 1,
    welcomeStroke: 0,
    welcomeStrokeColor: '#0b0d10',
    maxInjectChars: 1200,
    eventLog: true,
    logLevel: 'info',
};
export function normalizeConfig(input, base = DEFAULT_CONFIG) {
    const src = (input && typeof input === 'object' ? input : {});
    const pick = (key) => (src[key] === undefined ? base[key] : src[key]);
    const level = pick('logLevel');
    return {
        enabled: src['enabled'] === undefined ? base.enabled : src['enabled'] === true,
        defaultMode: src['defaultMode'] === 'auto' || src['defaultMode'] === 'manual' ? src['defaultMode'] : base.defaultMode,
        autoCollectReplies: src['autoCollectReplies'] === undefined ? base.autoCollectReplies : src['autoCollectReplies'] === true,
        allowModelDraftWrite: src['allowModelDraftWrite'] === undefined ? base.allowModelDraftWrite : src['allowModelDraftWrite'] === true,
        maxRepairRounds: clampInt(pick('maxRepairRounds'), 0, 3, base.maxRepairRounds),
        defaultMaxConcurrency: clampInt(pick('defaultMaxConcurrency'), 1, 3, base.defaultMaxConcurrency),
        injectDraftSummary: src['injectDraftSummary'] === undefined ? base.injectDraftSummary : src['injectDraftSummary'] === true,
        edgeArrows: src['edgeArrows'] === undefined ? base.edgeArrows : src['edgeArrows'] === true,
        edgeMotion: src['edgeMotion'] === 'auto' || src['edgeMotion'] === 'on' || src['edgeMotion'] === 'off' ? src['edgeMotion'] : base.edgeMotion,
        planningModeDefault: src['planningModeDefault'] === undefined ? base.planningModeDefault : src['planningModeDefault'] === true,
        planningModeColor: typeof src['planningModeColor'] === 'string' && /^#[0-9a-f]{6}$/i.test(src['planningModeColor']) ? src['planningModeColor'] : base.planningModeColor,
        welcomeEnabled: src['welcomeEnabled'] === undefined ? base.welcomeEnabled : src['welcomeEnabled'] === true,
        welcomeFont: typeof src['welcomeFont'] === 'string' && src['welcomeFont'].trim() ? String(src['welcomeFont']).slice(0, 80) : base.welcomeFont,
        welcomeFontSize: clampInt(pick('welcomeFontSize'), 12, 28, base.welcomeFontSize),
        welcomeColor: typeof src['welcomeColor'] === 'string' && /^#[0-9a-f]{6}$/i.test(src['welcomeColor']) ? src['welcomeColor'] : base.welcomeColor,
        welcomeGlow: clampInt(pick('welcomeGlow'), 0, 3, base.welcomeGlow),
        welcomeStroke: clampInt(pick('welcomeStroke'), 0, 2, base.welcomeStroke),
        welcomeStrokeColor: typeof src['welcomeStrokeColor'] === 'string' && /^#[0-9a-f]{6}$/i.test(src['welcomeStrokeColor']) ? src['welcomeStrokeColor'] : base.welcomeStrokeColor,
        maxInjectChars: clampInt(pick('maxInjectChars'), 200, 8000, base.maxInjectChars),
        eventLog: src['eventLog'] === undefined ? base.eventLog : src['eventLog'] === true,
        logLevel: level === 'debug' || level === 'info' || level === 'warn' || level === 'error' ? level : base.logLevel,
    };
}
export function clampInt(value, min, max, fallback) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n))
        return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}
/** User settings are validated before persistence; malformed values never silently enable execution. */
export function validateConfigPatch(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new Error('CONFIG_INVALID: 设置必须是对象');
    const patch = input;
    for (const [key, value] of Object.entries(patch)) {
        if (!Object.hasOwn(DEFAULT_CONFIG, key))
            throw new Error(`CONFIG_INVALID: 未知设置 ${key}`);
        if (['enabled', 'autoCollectReplies', 'allowModelDraftWrite', 'injectDraftSummary', 'eventLog', 'edgeArrows', 'planningModeDefault'].includes(key) && typeof value !== 'boolean')
            throw new Error(`CONFIG_INVALID: ${key} 必须为布尔值`);
        if (key === 'edgeMotion' && !['auto', 'on', 'off'].includes(String(value)))
            throw new Error('CONFIG_INVALID: edgeMotion 必须为 auto/on/off');
        if (key === 'planningModeColor' && !/^#[0-9a-f]{6}$/i.test(String(value)))
            throw new Error('CONFIG_INVALID: planningModeColor 必须是 #rrggbb');
        if (key === 'welcomeEnabled' && typeof value !== 'boolean')
            throw new Error('CONFIG_INVALID: welcomeEnabled 必须为布尔值');
        if (key === 'welcomeFont' && (typeof value !== 'string' || value.length > 80))
            throw new Error('CONFIG_INVALID: welcomeFont 必须是 80 字符以内的字符串');
        if (key === 'welcomeFontSize' && (!Number.isInteger(value) || Number(value) < 12 || Number(value) > 28))
            throw new Error('CONFIG_INVALID: welcomeFontSize 必须是 12..28 整数');
        if (key === 'welcomeColor' && !/^#[0-9a-f]{6}$/i.test(String(value)))
            throw new Error('CONFIG_INVALID: welcomeColor 必须是 #rrggbb');
        if (key === 'welcomeGlow' && (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 3))
            throw new Error('CONFIG_INVALID: welcomeGlow 必须是 0..3 整数');
        if (key === 'welcomeStroke' && (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 2))
            throw new Error('CONFIG_INVALID: welcomeStroke 必须是 0..2 整数');
        if (key === 'welcomeStrokeColor' && !/^#[0-9a-f]{6}$/i.test(String(value)))
            throw new Error('CONFIG_INVALID: welcomeStrokeColor 必须是 #rrggbb');
        if (key === 'defaultMode' && value !== 'auto' && value !== 'manual')
            throw new Error('CONFIG_INVALID: defaultMode 必须为 auto 或 manual');
        if (key === 'logLevel' && !['debug', 'info', 'warn', 'error'].includes(String(value)))
            throw new Error('CONFIG_INVALID: logLevel 不合法');
        if (key === 'defaultMaxConcurrency' && (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 3))
            throw new Error('CONFIG_INVALID: 并发必须为 1..3 整数');
        if (key === 'maxRepairRounds' && (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 3))
            throw new Error('CONFIG_INVALID: 修复轮数必须为0..3整数');
        if (key === 'maxInjectChars' && (!Number.isInteger(value) || Number(value) < 200 || Number(value) > 8000))
            throw new Error('CONFIG_INVALID: 摘要长度必须为 200..8000 整数');
    }
}
