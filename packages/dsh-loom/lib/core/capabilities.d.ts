/**
 * 运行时能力模型（03 P0 表、02 §3.2）。
 *
 * ── 评审 09 的 E 改了什么 ───────────────────────────────────────────────
 * 原实现在 `fact()` 里写 `lastVerifiedAt: new Date().toISOString()` ——
 * 每次构造能力表都盖一个「刚刚验证过」的时间戳，**而没有任何验证发生**。
 * 同时 `worktreeIsolation` / `perCallCwd` 标 `available: true`，
 * 但它们自己的 `limits` 又写着「provider 未接线」。这是自相矛盾：
 * 「接口支持」被当成了「当前可运行」。
 *
 * 现在改成**四个正交字段**，任一为真都不蕴含其余为真：
 *
 *   declaredByHost  —— 宿主公开契约里有没有这个入口（静态可查，读 .d.ts）
 *   implementedByLoom —— Loom 代码写完了没有（有代码 + 有测试）
 *   availableInEnv  —— 当前环境真的探测到了吗（需要探测动作 + 回执）
 *   verifiedInRun   —— 这次运行里真的跑到过吗（需要 run 证据 + 时间戳）
 *
 * `lastVerifiedAt` **只**在 `verifiedInRun === true` 时有值，
 * 且来自**那次验证发生的时间**，不是「现在」。
 *
 * ── 本项目的依赖立场 ───────────────────────────────────────────────────
 * Loom **不使用任何第三方插件的代码**。所以 backend 只有两种：
 *   `host` —— 宿主 DSH 自己提供的能力（我们只调用它的公开契约）
 *   `loom` —— 本项目自建的能力（代码全在本仓库里）
 * 没有第三种。任何「装个别人写的插件就有这个能力」的路径都不在设计里。
 */
/** 能力从哪来。只有两种，见文件头。 */
export type CapabilityBackend = 'host' | 'loom';
/** 证据来源的类别 —— 决定它能支撑到哪一档。 */
export type EvidenceKind = 
/** 读宿主 .d.ts / README 得到的公开契约。只能支撑 declaredByHost。 */
'spec'
/** 本仓库的源码 + 测试。只能支撑 implementedByLoom。 */
 | 'source'
/** 一次探测动作的回执（命令 + 输出）。支撑 availableInEnv。 */
 | 'probe'
/** 一次真实运行的回执（run id + 时间）。支撑 verifiedInRun。 */
 | 'run';
export interface CapabilityEvidence {
    readonly kind: EvidenceKind;
    /** 人可核对的位置：文件:行号，或命令 + 关键输出。 */
    readonly where: string;
    /** 证据产生的时间（ISO）。spec/source 类可以为 null（它们没有「发生时间」）。 */
    readonly at: string | null;
}
/**
 * 一项能力的事实。
 *
 * ⚠ 四个字段的顺序就是它们的强度顺序。写 `availableInEnv: true` 前，
 * `declaredByHost` 与 `implementedByLoom` 必须已经为 true —— 由
 * `assertCapabilityCoherence()` 在构造时断言。
 */
export interface CapabilityFact {
    readonly backend: CapabilityBackend;
    /** 1. 宿主公开契约里存在这个入口。读 .d.ts 可得，不需要运行。 */
    readonly declaredByHost: boolean;
    /** 2. Loom 侧代码写完并有测试覆盖。 */
    readonly implementedByLoom: boolean;
    /** 3. 当前环境探测到可用。需要真实探测回执。`'unknown'` 表示没探过。 */
    readonly availableInEnv: boolean | 'unknown';
    /** 4. 本次运行实际跑通过。需要真实 run 证据。 */
    readonly verifiedInRun: boolean;
    /** 只在 verifiedInRun 为 true 时有值，且是那次验证的时间。 */
    readonly lastVerifiedAt: string | null;
    readonly evidence: readonly CapabilityEvidence[];
    /** 未做到的部分。**必须展示给 UI**，不再被 true 过滤掉。 */
    readonly limits: readonly string[];
}
export interface LoomCapabilities {
    /** 探测时间（UTC ISO）。真实探测动作发生的时间。 */
    readonly probedAt: string;
    readonly hostVersion: string;
    /** 宿主实际生效的 workflow engine 与 provider。 */
    readonly engine: {
        readonly workflowEnginePackage: string;
        readonly subagentProvider: string;
    };
    readonly parallel: CapabilityFact;
    readonly realParentAgent: CapabilityFact;
    readonly cancel: CapabilityFact;
    readonly backgroundJobs: CapabilityFact;
    readonly multiSessionApi: CapabilityFact;
    readonly worktreeIsolation: CapabilityFact;
    readonly journal: CapabilityFact;
    readonly wslExecution: CapabilityFact;
    readonly perCallCwd: CapabilityFact;
}
export declare const CAPABILITY_KEYS: readonly ["parallel", "realParentAgent", "cancel", "backgroundJobs", "multiSessionApi", "worktreeIsolation", "journal", "wslExecution", "perCallCwd"];
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];
/** 构造一项能力事实。**不再自动盖时间戳** —— 时间必须由调用方显式给出。 */
export declare function capabilityFact(input: {
    readonly backend: CapabilityBackend;
    readonly declaredByHost: boolean;
    readonly implementedByLoom: boolean;
    readonly availableInEnv: boolean | 'unknown';
    readonly verifiedInRun?: boolean;
    readonly lastVerifiedAt?: string | null;
    readonly evidence?: readonly CapabilityEvidence[];
    readonly limits?: readonly string[];
}): CapabilityFact;
/**
 * 一致性断言 —— 这是本文件的核心价值。
 *
 * 三条规则，违反任一条说明能力表在说谎：
 *   R1. `availableInEnv === true` ⟹ `declaredByHost === true`
 *       （宿主都不认识这个入口，环境不可能「可用」）
 *   R2. `availableInEnv === true` ⟹ `implementedByLoom === true`
 *       （Loom 没写代码，不可能「可用」）
 *   R3. `verifiedInRun === true` ⟹ `lastVerifiedAt !== null`
 *       （说验证过却拿不出时间，就是没有证据）
 *
 * 反向不成立：`declaredByHost` 为真不代表能跑 —— 那正是原实现搞错的地方。
 */
export declare function assertCapabilityCoherence(fact: CapabilityFact): void;
/** 收集一项事实里所有「没做到」的说明，供 UI 展示。 */
export declare function capabilityGaps(fact: CapabilityFact): string[];
/**
 * 给测试与调用方看的「能不能用」判定。
 *
 * ⚠ 注意这里**不用** available（那是「探测到了」），而要求 verifiedInRun 或
 * 至少 availableInEnv===true 且 implementedByLoom。派发闸门（requireCapability）
 * 用这个，不用 available。
 */
export declare function isUsable(fact: CapabilityFact): boolean;
/**
 * P0 实测得到的默认能力表（2026-10-02，见 docs/compatibility-report.md）。
 *
 * 默认值只记录实现与公开接口事实，环境状态保持 unknown。
 * WSL 原生进程注册 provider 并加载公开 helper 后，入口才报告当前环境可用。
 * Windows 桌面跨进程子代理未接线；任何静态资料和注册结果都不能代替真实运行回执。
 */
export declare function knownCapabilities(): LoomCapabilities;
/** 编译期/派发前的闸门：不支持就抛，不静默降级。 */
export declare class UnsupportedCapabilityError extends Error {
    readonly key: string;
    constructor(key: string, detail: string);
}
/**
 * 派发闸门。用 `isUsable()` 而不是 `available` ——
 * 后者只表示「探测到了」，不表示「Loom 真的能跑」。
 */
export declare function requireCapability(caps: LoomCapabilities, key: CapabilityKey, detail: string): CapabilityFact;
/** 降级清单的一行。 */
export interface DegradationRow {
    readonly key: string;
    readonly backend: CapabilityBackend;
    /** 人可读状态，逐档显示卡在哪一步。 */
    readonly state: string;
    readonly gaps: readonly string[];
    readonly fallback: string;
}
/**
 * 面向 UI 的降级说明：哪些功能当前不可用，替代路径是什么。
 *
 * ── 与旧版的差别（评审 E 的第 3 点）──────────────────────────────────────
 * 旧版 `if (state !== '可用') rows.push(...)` —— 只收集 available!==true 的项，
 * 于是 `worktreeIsolation` / `perCallCwd` 的 limits（正是「未接线」这个最该
 * 展示给用户的信息）**永远不会出现**。
 *
 * 现在改成：**只要 `capabilityGaps()` 非空就纳入**。一项「探测可用但没在
 * 真实运行里验证过」的能力也会带缺口出现 —— 那才是诚实的 UI。
 */
export declare function describeDegradations(caps: LoomCapabilities): DegradationRow[];
/** 一项能力卡在哪一档 —— 逐档回答，不用「可用/不可用」这个粗糙二分。 */
export declare function stageLabel(f: CapabilityFact): string;
