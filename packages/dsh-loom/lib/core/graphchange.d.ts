/**
 * 用户改动的有类型记录（07 §5）。
 *
 * 纪律：
 * - 只用有类型的 GraphChange，**不开放任意 JSON path、不执行代码**。
 * - 改名保留 ID；删除有明确记录；拆分/合并必须返回来源映射。
 * - 布局（坐标/折叠）不产生 GraphChange —— 它不进语义 payload。
 */
import type { GraphChange } from './graphchange-types.js';
export type { GraphChange, GraphChangeKind, GraphObjectKind } from './graphchange-types.js';
export interface ChangeLogEntry extends GraphChange {
    readonly at: string;
    readonly actor: 'user' | 'model' | 'system';
}
export declare function isSemanticChange(change: GraphChange): boolean;
export declare function semanticChanges(changes: readonly GraphChange[]): GraphChange[];
/**
 * 检查一批改动是否有结构问题（同一对象被删了又改、锁定的对象被改等）。
 * 返回人类可读的冲突列表；空数组表示可以安全应用。
 */
export declare function detectConflicts(changes: readonly GraphChange[], lockedObjectIds: readonly string[]): string[];
