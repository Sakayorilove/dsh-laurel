/**
 * 架构 → 任务的多对多来源映射（07 §3、§6）。
 *
 * 纪律：
 * - 一个架构模块可对应多个实现/验收任务；一个共享准备任务可对应多个模块。
 * - 架构改变接口或模块责任时，关联任务标 stale；**不擅改在途运行**。
 * - 架构同名节点不凭名字自动绑定现有任务。
 */
/**
 * 判断哪些任务因为架构更新而 stale。
 *
 * @param sourceMap 现有映射
 * @param currentArchitectureRevision 新架构的 revision
 * @param liveArchitectureNodeIds 新架构里仍然存在的模块 id
 */
export function computeStale(sourceMap, currentArchitectureRevision, liveArchitectureNodeIds) {
    const live = new Set(liveArchitectureNodeIds);
    const stale = [];
    const fresh = [];
    const dangling = new Set();
    for (const entry of sourceMap.entries) {
        const missing = entry.architectureNodeIds.filter((id) => !live.has(id));
        for (const m of missing)
            dangling.add(m);
        if (missing.length > 0) {
            stale.push({
                workflowNodeId: entry.workflowNodeId,
                reason: `引用的架构模块已不存在：${missing.join('、')}`,
            });
            continue;
        }
        if (entry.basedOnArchitectureRevision !== currentArchitectureRevision) {
            stale.push({
                workflowNodeId: entry.workflowNodeId,
                reason: `基于架构 revision ${entry.basedOnArchitectureRevision}，当前是 ${currentArchitectureRevision}`,
            });
            continue;
        }
        fresh.push(entry.workflowNodeId);
    }
    const covered = new Set();
    for (const e of sourceMap.entries)
        for (const id of e.architectureNodeIds)
            covered.add(id);
    const uncovered = liveArchitectureNodeIds.filter((id) => !covered.has(id));
    return {
        architectureId: sourceMap.architectureId,
        architectureRevision: currentArchitectureRevision,
        stale,
        fresh,
        uncoveredArchitectureNodes: uncovered,
        danglingArchitectureNodes: [...dangling],
    };
}
export function validateSourceMap(map, workflowNodeIds) {
    const problems = [];
    if (typeof map !== 'object' || map === null || Array.isArray(map))
        return ['SourceMap 必须是对象'];
    const m = map;
    if (m.schemaVersion !== 1)
        problems.push('schemaVersion 必须是 1');
    if (!Array.isArray(m.entries))
        return [...problems, 'entries 必须是数组'];
    if (typeof m.architectureId !== 'string' || !m.architectureId)
        problems.push('architectureId 必须是非空字符串');
    if (typeof m.workflowId !== 'string' || !m.workflowId)
        problems.push('workflowId 必须是非空字符串');
    const seen = new Set();
    const known = new Set(workflowNodeIds);
    m.entries.forEach((e, i) => {
        if (!e || typeof e !== 'object') {
            problems.push(`entries[${i}] 不是对象`);
            return;
        }
        if (typeof e.workflowNodeId !== 'string' || !known.has(e.workflowNodeId)) {
            problems.push(`entries[${i}].workflowNodeId 指向不存在的任务：${String(e.workflowNodeId)}`);
        }
        if (seen.has(e.workflowNodeId))
            problems.push(`entries[${i}] 重复任务映射`);
        seen.add(e.workflowNodeId);
        if (!Array.isArray(e.decisionIds) || e.decisionIds.some((id) => typeof id !== 'string'))
            problems.push(`entries[${i}].decisionIds 必须是字符串数组`);
        if (!Array.isArray(e.architectureNodeIds) || e.architectureNodeIds.length === 0 || e.architectureNodeIds.some((id) => typeof id !== 'string')) {
            problems.push(`entries[${i}].architectureNodeIds 必须是非空数组`);
        }
    });
    return problems;
}
