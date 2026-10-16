/**
 * dsh-loom · 宿主半边：agent 前置注入。
 *
 * 只在有草案、且配置打开时，往这一步的消息里补一条**只读摘要**。
 *
 * ⚠ 只认 `decision.kind === 'enter'`（正向判断）。
 * 依据是宿主自己的两个官方样例：
 *   - `@deepseek-ai/dsh-tool-jobs`（`agent/pre-step` 监听）
 *   - `@deepseek-ai/dsh-subagent-in-process-driver`（同样写正向判断）
 * 只挡 `'reject'` 是不严的 —— 遇到别的 kind 会去改一个不该改的 decision。
 *
 * ── 评审 09 F 改了什么 ──────────────────────────────────────────────────
 * 原实现无脑读**全局**草案，于是甲项目的锁定约束会注入乙项目。
 * 现在必须先解析出**当前 Agent 的工作区**，只注入该工作区的草案。
 *
 * 工作区从哪来 —— 这是本文件最关键的一处判断：
 *   从 `payload.agent.session.header.cwd` 取，**不是**从请求参数取。
 *   理由：cwd 是宿主自己维护的会话事实，调用方伪造不了；请求参数是调用方
 *   自己写的，用它等于让调用方自证归属。取不到 → 跳过注入（不猜、不回落全局）。
 */
import type { PlanningController } from './planning.js';
import type { LoomStore } from './store.js';
import type { LoomConfig } from './config.js';
export interface InjectionDeps {
    readonly planning?: PlanningController;
    readonly store: LoomStore;
    readonly getConfig: () => LoomConfig;
    readonly isSessionActive?: (agent: any) => boolean;
    readonly log: {
        warn: (...a: unknown[]) => void;
    };
}
/**
 * 从 pre-step payload 里解析当前 Agent 的工作区 id。
 *
 * 取 `agent.session.header.cwd`。返回 null 表示**解析不出** ——
 * 调用方必须跳过注入，绝不能回落到全局草案。
 */
export declare function resolveAgentWorkspace(payload: unknown): string | null;
export declare function installInjection(ctx: any, deps: InjectionDeps): () => void;
