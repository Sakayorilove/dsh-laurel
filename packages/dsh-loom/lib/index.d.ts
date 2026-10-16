/**
 * dsh-loom · 宿主半边入口
 *
 * ── 这个插件做什么 ─────────────────────────────────────────────────────
 * 把软件项目拆成一张可编辑的节点图，再把图确定性地编译成可执行的批次脚本。
 * 两种模式共享同一份方案：
 *   自动  选资料 → 提示词 → AI 架构回答 → 校验成图 → 用户改图 → 回传优化
 *   手动  空白/模板/自动初排 → 手改 → 导出提示词或任务包
 *
 * 三层数据**分开**存：架构（允许环）/ 开工任务（必须 DAG）/ 运行事实。
 *
 * ── 四条纪律（每条都有出处）─────────────────────────────────────────────
 *   1. **顶层 `inject` 留空**。cordis 的 Context 是受控代理，没写进 `inject`
 *      的服务用 `ctx.X` 访问会直接抛；`ctx.get(name)` + try/catch 更安全，
 *      非 Web 组合（CLI / headless）也能激活。
 *   2. **Web 路由走子插件 + `effect`**，让 cordis 管等待、服务重建与清理。
 *   3. **家目录只认 `DSH_HOME`**，不从 profile 目录往上推。
 *   4. **非关键 IO 吞异常；关键写入必须可见。** 事件日志可以失败，
 *      revision / 授权 / 集成事实不行 —— 不照搬「所有 IO 都吞」。
 */
import { PACKAGE_NAME, VERSION } from './config.js';
import { type LoomCapabilities } from './core/index.js';
export { PACKAGE_NAME, VERSION };
/** 顶层 inject 故意留空。见纪律 1。 */
export declare const inject: string[];
export declare function apply(ctx: any, config?: Record<string, unknown>): {
    status: () => {
        ok: boolean;
        data: {
            error: string;
        };
    };
    dispose?: undefined;
} | {
    /** 给宿主/测试看的只读快照。 */
    status: () => {
        ok: boolean;
        data: {
            package: string;
            version: string;
            home: string;
            config: {
                enabled: boolean;
                defaultMode: "auto" | "manual";
                autoCollectReplies: boolean;
                allowModelDraftWrite: boolean;
                maxRepairRounds: number;
                defaultMaxConcurrency: number;
                injectDraftSummary: boolean;
                edgeArrows: boolean;
                planningModeDefault: boolean;
                edgeMotion: "auto" | "on" | "off";
                planningModeColor: string;
                welcomeEnabled: boolean;
                welcomeFont: string;
                welcomeFontSize: number;
                welcomeColor: string;
                welcomeGlow: number;
                welcomeStroke: number;
                welcomeStrokeColor: string;
                maxInjectChars: number;
                eventLog: boolean;
                logLevel: "debug" | "info" | "warn" | "error";
            };
            capabilities: LoomCapabilities;
            stats: {
                revisions: number;
                architectures: number;
                runs: number;
                events: number;
            };
            paths: import("./config.js").LoomPaths;
        };
    };
    dispose: () => void;
};
