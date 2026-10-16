/**
 * 规划器输出 → 已采纳的不可变 revision。
 *
 * 纪律（02 §6.3、04 规划器提示词）：
 * - 模型只**提议**任务与依赖；能不能执行由确定性程序判断。
 * - 「识别/规划」只生成草案；「开始运行」是另一次授权。本模块只做前者。
 * - Schema 修复最多两次；仍失败就明确失败，不把自由文本包装成「成功计划」。
 * - 置信度是提示性数值，**不作为权限或执行条件**。
 */
import { contentDigest } from './digest.js';
import { LOOM_COMPILER_VERSION } from './model.js';
import { validateWorkflow } from './validate.js';
/** Schema 定向修复的次数上限（02 §6.3：最多两次）。 */
export const MAX_SCHEMA_REPAIRS = 2;
/**
 * 把候选提案收成一份不可变 revision。
 * 校验不通过就**不**产出 revision —— 没有「部分接受」这回事。
 */
export function adoptPlannerOutput(proposal, options = {}) {
    const result = validateWorkflow(proposal, options);
    const blocked = [];
    const maybe = proposal;
    const openQuestions = Array.isArray(maybe?.openQuestions) ? maybe.openQuestions : [];
    if (openQuestions.length > 0) {
        blocked.push({
            nodeId: '*',
            reason: `提案里有 ${openQuestions.length} 个未决问题，相关任务保持阻塞：${openQuestions.join('；')}`,
        });
    }
    if (!result.ok) {
        return { accepted: false, workflow: null, errors: result.errors, warnings: result.warnings, blocked };
    }
    const p = proposal;
    const adoptedAt = options.adoptedAt ?? new Date().toISOString();
    const inputDigest = options.inputDigest ?? contentDigest({ workflowId: p.workflowId, revision: p.revision, nodes: p.nodes, edges: p.edges });
    const workflow = {
        ...p,
        inputDigest,
        compilerVersion: LOOM_COMPILER_VERSION,
        adoptedAt,
    };
    return { accepted: true, workflow, errors: [], warnings: result.warnings, blocked };
}
export function canRepair(budget) {
    return budget.repairsUsed < MAX_SCHEMA_REPAIRS;
}
/** 给模型看的修复指令：只带错误路径与原因，不带任何执行权限。 */
export function renderRepairInstruction(errors) {
    return [
        '你上次返回的候选图没有通过结构校验。请**只**修复下面列出的问题，不要扩大范围，不要开始实施。',
        '',
        ...errors.slice(0, 50).map((e, i) => `${i + 1}. [${e.code}] ${e.path}：${e.message}`),
        '',
        '仍然只返回候选图 JSON。',
    ].join('\n');
}
