/**
 * 流程计划（Flow Plan）：流程视图上的**可编辑计划**。
 *
 * 它是计划、不是语义：用户拖动步骤、勾选任务、设置子代理数量、两两分组、
 * 指定审计代理 —— 这些都存在这里；只有点「应用为新依赖」时才把顺序
 * 换算成真实的任务依赖边（并仍要经过校验、写成草案、由用户采纳）。
 */
import { validateTeamPlan } from './team.js';
import { contentDigest } from './digest.js';
import { dependencyLayers } from './validate.js';
import { ID_PATTERN } from './model.js';
/**
 * 流程视图里「每步子代理数量」的上限。
 *
 * 2026-10-06 实测（`scripts/probe-subagent-limit.mjs`，真实官方宿主 + 离线 adapter，
 * 4 个独立任务、声明并发 3）：**峰值同时开着 3 个子代理、全部验收通过**，证据见
 * `.verification/subagent-limit-probe.json`。同时任务图 schema 也把
 * `executionProposal.maxConcurrency` 限在 1..3（validate.ts 的 MAX_CONCURRENCY_RANGE），
 * 配置项 `defaultMaxConcurrency` 同样 1..3。
 *
 * 所以这里取 3 而不是 4：下拉给到 4 只是让用户选一个**永远不会被调度**的数字。
 * 并发 >3 无法通过 Loom 的运行路径到达（schema 先卡住），因此不宣称宿主绝对上限。
 */
export const FLOW_MAX_AGENTS = 3;
export const FLOW_MAX_AUDIT_AGENTS = 3;
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
/** 默认流程计划：按依赖分层，一层一步；每步 2 个子代理；两个审计代理待分组。 */
export function defaultFlowPlan(workflow, now = new Date().toISOString()) {
    const { layers } = dependencyLayers(workflow.nodes, workflow.edges);
    const steps = layers.map((layerTasks, index) => ({
        id: 'step-' + (index + 1),
        taskIds: [...layerTasks],
        agents: Math.min(2, FLOW_MAX_AGENTS),
    }));
    return {
        workflowId: workflow.workflowId,
        revision: workflow.revision,
        steps,
        order: steps.map((s) => s.id),
        groups: [],
        auditAgents: [
            { id: 'audit-1', label: '审计 1', groupId: null },
            { id: 'audit-2', label: '审计 2', groupId: null },
        ],
        updatedAt: now,
    };
}
/** 校验用户提交的流程计划。错误（errors）不可落盘；告警（warnings）可落盘但会提示。 */
export function validateFlowPlan(input, workflow, options = {}) {
    const maxAgents = Math.max(1, options.maxAgents ?? FLOW_MAX_AGENTS);
    const errors = [];
    const warnings = [];
    const raw = asRecord(input);
    if (!raw)
        return { ok: false, plan: null, errors: [{ path: '$', message: '流程计划必须是对象' }], warnings };
    if (raw['workflowId'] !== workflow.workflowId)
        errors.push({ path: 'workflowId', message: '流程计划与当前任务图不一致（workflowId 不同）' });
    const revision = typeof raw['revision'] === 'number' && Number.isInteger(raw['revision']) && raw['revision'] > 0 ? raw['revision'] : null;
    if (revision === null)
        errors.push({ path: 'revision', message: 'revision 必须是正整数' });
    else if (revision !== workflow.revision)
        warnings.push({ path: 'revision', message: `流程计划基于 revision ${revision}，当前是 ${workflow.revision}；应用前请确认` });
    const taskIds = new Set(workflow.nodes.map((n) => n.id));
    const steps = [];
    const seenSteps = new Set();
    const assigned = new Set();
    const rawSteps = Array.isArray(raw['steps']) ? raw['steps'] : null;
    if (!rawSteps)
        errors.push({ path: 'steps', message: 'steps 必须是数组' });
    for (const [i, value] of (rawSteps ?? []).entries()) {
        const step = asRecord(value);
        if (!step) {
            errors.push({ path: `steps[${i}]`, message: '步骤必须是对象' });
            continue;
        }
        const id = typeof step['id'] === 'string' ? step['id'] : '';
        if (!ID_PATTERN.test(id))
            errors.push({ path: `steps[${i}].id`, message: '步骤 id 需要小写字母、数字、短横线或下划线' });
        else if (seenSteps.has(id))
            errors.push({ path: `steps[${i}].id`, message: `步骤 id 重复：${id}` });
        seenSteps.add(id);
        const rawTaskIds = Array.isArray(step['taskIds']) ? step['taskIds'] : null;
        const ids = [];
        if (!rawTaskIds)
            errors.push({ path: `steps[${i}].taskIds`, message: 'taskIds 必须是数组' });
        for (const taskId of rawTaskIds ?? []) {
            if (typeof taskId !== 'string' || !taskIds.has(taskId)) {
                errors.push({ path: `steps[${i}].taskIds`, message: `任务不存在：${String(taskId)}` });
                continue;
            }
            if (assigned.has(taskId)) {
                errors.push({ path: `steps[${i}].taskIds`, message: `任务被重复纳入：${taskId}` });
                continue;
            }
            assigned.add(taskId);
            ids.push(taskId);
        }
        const agents = step['agents'];
        if (typeof agents !== 'number' || !Number.isInteger(agents) || agents < 1 || agents > maxAgents)
            errors.push({ path: `steps[${i}].agents`, message: `子代理数量必须是 1..${maxAgents} 的整数` });
        steps.push({ id, taskIds: ids, agents: typeof agents === 'number' ? agents : 1 });
    }
    const missing = workflow.nodes.map((n) => n.id).filter((id) => !assigned.has(id));
    if (missing.length)
        warnings.push({ path: 'steps', message: `还有 ${missing.length} 个任务未纳入任何步骤：${missing.join('、')}` });
    const rawOrder = Array.isArray(raw['order']) ? raw['order'] : null;
    const order = [];
    if (!rawOrder)
        errors.push({ path: 'order', message: 'order 必须是数组' });
    else {
        for (const [i, id] of rawOrder.entries()) {
            if (typeof id !== 'string' || !seenSteps.has(id)) {
                errors.push({ path: `order[${i}]`, message: `order 引用了不存在的步骤：${String(id)}` });
                continue;
            }
            if (order.includes(id)) {
                errors.push({ path: `order[${i}]`, message: `order 里步骤重复：${id}` });
                continue;
            }
            order.push(id);
        }
        if (order.length !== steps.length)
            errors.push({ path: 'order', message: `order 必须恰好包含全部 ${steps.length} 个步骤` });
    }
    const rawAgents = Array.isArray(raw['auditAgents']) ? raw['auditAgents'] : null;
    const auditAgents = [];
    const auditIds = new Set();
    if (!rawAgents || rawAgents.length < 1 || rawAgents.length > FLOW_MAX_AUDIT_AGENTS)
        errors.push({ path: 'auditAgents', message: `审计代理数量必须是 1..${FLOW_MAX_AUDIT_AGENTS}` });
    for (const [i, value] of (rawAgents ?? []).entries()) {
        const agent = asRecord(value);
        if (!agent) {
            errors.push({ path: `auditAgents[${i}]`, message: '审计代理必须是对象' });
            continue;
        }
        const id = typeof agent['id'] === 'string' ? agent['id'] : '';
        if (!ID_PATTERN.test(id))
            errors.push({ path: `auditAgents[${i}].id`, message: '审计代理 id 需要小写字母、数字、短横线或下划线' });
        else if (auditIds.has(id))
            errors.push({ path: `auditAgents[${i}].id`, message: `审计代理 id 重复：${id}` });
        auditIds.add(id);
        const label = typeof agent['label'] === 'string' && agent['label'].trim() ? agent['label'].trim().slice(0, 24) : '审计代理';
        const groupId = agent['groupId'] === null || agent['groupId'] === undefined ? null : String(agent['groupId']);
        auditAgents.push({ id, label, groupId });
    }
    const rawGroups = Array.isArray(raw['groups']) ? raw['groups'] : null;
    const groups = [];
    const groupIds = new Set();
    const grouped = new Set();
    if (!rawGroups)
        errors.push({ path: 'groups', message: 'groups 必须是数组' });
    for (const [i, value] of (rawGroups ?? []).entries()) {
        const group = asRecord(value);
        if (!group) {
            errors.push({ path: `groups[${i}]`, message: '分组必须是对象' });
            continue;
        }
        const id = typeof group['id'] === 'string' ? group['id'] : '';
        if (!ID_PATTERN.test(id))
            errors.push({ path: `groups[${i}].id`, message: '分组 id 需要小写字母、数字、短横线或下划线' });
        else if (groupIds.has(id))
            errors.push({ path: `groups[${i}].id`, message: `分组 id 重复：${id}` });
        groupIds.add(id);
        const rawStepIds = Array.isArray(group['stepIds']) ? group['stepIds'] : null;
        const stepIds = [];
        if (!rawStepIds || rawStepIds.length < 1 || rawStepIds.length > 3)
            errors.push({ path: `groups[${i}].stepIds`, message: '一个审计组包含 1..3 个步骤' });
        for (const stepId of rawStepIds ?? []) {
            if (typeof stepId !== 'string' || !seenSteps.has(stepId)) {
                errors.push({ path: `groups[${i}].stepIds`, message: `步骤不存在：${String(stepId)}` });
                continue;
            }
            if (grouped.has(stepId)) {
                errors.push({ path: `groups[${i}].stepIds`, message: `步骤被分进多个审计组：${stepId}` });
                continue;
            }
            grouped.add(stepId);
            stepIds.push(stepId);
        }
        const auditAgentId = group['auditAgentId'] === null || group['auditAgentId'] === undefined ? null : String(group['auditAgentId']);
        if (auditAgentId !== null && !auditIds.has(auditAgentId))
            errors.push({ path: `groups[${i}].auditAgentId`, message: `主审不存在：${auditAgentId}` });
        groups.push({ id, stepIds, auditAgentId });
    }
    for (const agent of auditAgents) {
        if (agent.groupId === null)
            continue;
        if (!groupIds.has(agent.groupId)) {
            errors.push({ path: `auditAgents.${agent.id}.groupId`, message: `审计代理绑定了不存在的分组：${agent.groupId}` });
            continue;
        }
        const group = groups.find((g) => g.id === agent.groupId);
        if (group && group.auditAgentId && group.auditAgentId !== agent.id)
            errors.push({ path: `auditAgents.${agent.id}.groupId`, message: `分组的两个主审指针不一致：${group.id}` });
    }
    for (const group of groups)
        if (group.stepIds.length > 1) {
            const positions = group.stepIds.map((id) => order.indexOf(id)).filter((p) => p >= 0).sort((a, b) => a - b);
            const first = positions[0];
            const last = positions[positions.length - 1];
            if (first !== undefined && last !== undefined && last - first !== positions.length - 1)
                warnings.push({ path: `groups.${group.id}`, message: '审计组包含的步骤在顺序里不相邻（仍是合法计划，运行时按组完成度汇总）' });
        }
    let organization;
    if (raw.organization !== undefined)
        try {
            organization = validateTeamPlan(raw.organization, workflow);
        }
        catch (error) {
            errors.push({ path: 'organization', message: String(error.message) });
        }
    const ok = errors.length === 0;
    const plan = ok ? {
        organization,
        workflowId: workflow.workflowId,
        revision: revision ?? workflow.revision,
        steps,
        order,
        groups,
        auditAgents: auditAgents.map((agent) => ({ ...agent, groupId: agent.groupId ?? (groups.find((g) => g.auditAgentId === agent.id)?.id ?? null) })),
        updatedAt: typeof raw['updatedAt'] === 'string' && raw['updatedAt'] ? raw['updatedAt'] : new Date().toISOString(),
    } : null;
    return { ok, plan, errors, warnings };
}
/** 摘要：给审计/回执用的稳定指纹（不含 updatedAt）。 */
export function flowPlanDigest(plan) {
    return contentDigest({ workflowId: plan.workflowId, revision: plan.revision, steps: plan.steps, order: plan.order, groups: plan.groups, auditAgents: plan.auditAgents, organization: plan.organization });
}
const edgeId = (source, target, targetPort) => {
    const direct = `flow-${source}-${target}-${targetPort}`;
    if (direct.length <= 64)
        return direct.toLowerCase();
    return 'flow-' + contentDigest({ source, target, targetPort }).slice(0, 16);
};
/**
 * 把「流程顺序」换算成**任务依赖边**（应用为新依赖）。
 *
 * 规则（都写进错误信息，用户能照着修）：
 * 1. 视觉顺序必须是当前依赖图的合法拓扑序 —— 步骤 i 的任务依赖了更靠后的步骤时直接拒绝，
 *    并指出是哪条边；
 * 2. 相邻两步之间：后一步每个「输入尚未被满足」的任务，尝试从前一步里找一个
 *    产物类型匹配的输出，补一条边；
 * 3. 找不到匹配产物类型时拒绝，指出任务、输入名与类型（提示手工连线或调整分块）。
 */
export function applyFlowOrder(workflow, plan) {
    const errors = [];
    const stepOf = new Map();
    const taskIds = new Set(workflow.nodes.map((n) => n.id));
    for (const step of plan.steps)
        for (const id of step.taskIds) {
            if (!taskIds.has(id))
                errors.push({ path: `steps.${step.id}`, message: `任务不存在：${id}` });
            else
                stepOf.set(id, step.id);
        }
    const stageIndex = new Map();
    plan.order.forEach((id, index) => stageIndex.set(id, index));
    if (errors.length)
        return { ok: false, addedEdges: [], errors };
    const nodeById = new Map(workflow.nodes.map((n) => [n.id, n]));
    const adj = new Map(workflow.nodes.map((n) => [n.id, []]));
    for (const edge of workflow.edges) {
        if (!adj.has(edge.source) || !adj.has(edge.target))
            continue;
        adj.get(edge.source).push(edge.target);
        const a = stageIndex.get(stepOf.get(edge.source) ?? '');
        const b = stageIndex.get(stepOf.get(edge.target) ?? '');
        if (a !== undefined && b !== undefined && a > b)
            errors.push({ path: `edges.${edge.id}`, message: `顺序冲突：${edge.source} → ${edge.target} 是既有依赖，但 ${edge.source} 被排到了 ${edge.target} 之后` });
    }
    if (errors.length)
        return { ok: false, addedEdges: [], errors };
    const hasPath = (from, to) => {
        const seen = new Set([from]);
        const queue = [from];
        while (queue.length) {
            const id = queue.shift();
            if (id === to)
                return true;
            for (const next of adj.get(id) ?? [])
                if (!seen.has(next)) {
                    seen.add(next);
                    queue.push(next);
                }
        }
        return false;
    };
    const servedInputs = new Set();
    for (const edge of workflow.edges)
        servedInputs.add(`${edge.target}:${edge.targetPort}`);
    const addedEdges = [];
    const ordered = plan.order.map((id) => plan.steps.find((s) => s.id === id)).filter((s) => Boolean(s));
    for (let i = 0; i + 1 < ordered.length; i += 1) {
        const current = ordered[i];
        const next = ordered[i + 1];
        if (!current || !next)
            continue;
        for (const targetId of next.taskIds) {
            if (current.taskIds.some((sourceId) => hasPath(sourceId, targetId)))
                continue;
            const target = nodeById.get(targetId);
            if (!target)
                continue;
            const open = (target.inputs ?? []).filter((port) => !servedInputs.has(`${targetId}:${port.name}`));
            if (!open.length)
                continue;
            let linked = false;
            for (const port of open) {
                const producers = current.taskIds
                    .map((id) => nodeById.get(id))
                    .filter((node) => Boolean(node))
                    .filter((node) => (node.outputs ?? []).some((out) => out.artifactType === port.artifactType));
                const producer = producers[0];
                const output = producer && (producer.outputs ?? []).find((out) => out.artifactType === port.artifactType);
                if (!producer || !output)
                    continue;
                const edge = {
                    id: edgeId(producer.id, targetId, port.name),
                    source: producer.id,
                    sourcePort: output.name,
                    target: targetId,
                    targetPort: port.name,
                    artifactType: port.artifactType,
                    require: 'validated',
                };
                addedEdges.push(edge);
                adj.get(producer.id).push(targetId);
                servedInputs.add(`${targetId}:${port.name}`);
                linked = true;
                break;
            }
            if (!linked) {
                const types = open.map((port) => `${port.name}(${port.artifactType})`).join('、');
                errors.push({ path: `steps.${next.id}`, message: `无法把 ${current.id} 的顺序变成依赖：${targetId} 需要 ${types}，而 ${current.id} 里没有产物类型匹配的任务；请手工连线或调整分块` });
            }
        }
    }
    if (errors.length)
        return { ok: false, addedEdges: [], errors };
    return { ok: true, addedEdges, errors: [] };
}
/**
 * 把流程计划编译成运行调度表：
 * - 计划必须整体合法（validateFlowPlan），且**覆盖全部任务**（漏掉的任务不会被调度）；
 * - 每步子代理数量按宿主上限封顶（clamped 标记供回执展示）；
 * - 只有绑定了主审的审计组才进入调度；未绑定主审的组给出告警并被跳过。
 */
export function compileFlowSchedule(workflow, plan, hostCap) {
    const cap = Math.max(1, hostCap);
    const check = validateFlowPlan(plan, workflow);
    const errors = [...check.errors];
    const warnings = [...check.warnings];
    if (!check.ok || !check.plan)
        return { ok: false, schedule: null, errors, warnings };
    const normalized = check.plan;
    const assigned = new Set(normalized.steps.reduce((all, step) => all.concat(step.taskIds), []));
    const missing = workflow.nodes.map((n) => n.id).filter((id) => !assigned.has(id));
    if (missing.length)
        errors.push({ path: 'steps', message: `流程计划没有覆盖全部任务，不能作为运行顺序：${missing.join('、')}` });
    if (errors.length)
        return { ok: false, schedule: null, errors, warnings };
    let clamped = false;
    const steps = normalized.order.map((id) => {
        const step = normalized.steps.find((s) => s.id === id);
        const agents = Math.min(cap, Math.max(1, step.agents));
        if (agents !== step.agents)
            clamped = true;
        return { id: step.id, taskIds: [...step.taskIds], agents };
    });
    const groups = [];
    for (const group of normalized.groups) {
        const agent = group.auditAgentId
            ? normalized.auditAgents.find((a) => a.id === group.auditAgentId) ?? null
            : normalized.auditAgents.find((a) => a.groupId === group.id) ?? null;
        if (!agent) {
            errors.push({ path: `groups.${group.id}`, message: `审计组 ${group.id} 必须指定主审；不需要审计请显式删除该组` });
            continue;
        }
        const taskIds = normalized.steps.filter((step) => group.stepIds.includes(step.id)).reduce((all, step) => all.concat(step.taskIds), []);
        groups.push({ id: group.id, stepIds: [...group.stepIds], taskIds, auditAgentId: agent.id, label: agent.label });
    }
    if (errors.length)
        return { ok: false, schedule: null, errors, warnings };
    const stepOf = new Map(steps.flatMap((s, i) => s.taskIds.map(id => [id, i])));
    for (const edge of workflow.edges)
        if (stepOf.get(edge.source) > stepOf.get(edge.target))
            errors.push({ path: `edges.${edge.id}`, message: "阶段顺序与真实依赖相冲突" });
    if (errors.length)
        return { ok: false, schedule: null, errors, warnings };
    for (const team of normalized.organization?.teams ?? []) {
        if (groups.some(g => g.id === team.id))
            return { ok: false, schedule: null, errors: [{ path: 'organization.teams', message: '责任组与旧审计组ID冲突' }], warnings };
        const supervisor = normalized.organization.members.find(m => m.id === team.supervisorId);
        const reviewer = normalized.organization.members.find(m => m.id === team.reviewerId);
        groups.push({ id: team.id, stepIds: steps.filter(s => s.taskIds.some(id => team.taskIds.includes(id))).map(s => s.id), taskIds: team.taskIds, auditAgentId: reviewer.id, label: reviewer.label, supervisorId: supervisor.id, supervisorLabel: supervisor.label, supervisorResponsibility: supervisor.responsibility });
    }
    const concurrency = Math.min(cap, Math.max(1, ...steps.map((step) => step.agents)));
    return { ok: true, schedule: { organization: normalized.organization, workflowId: workflow.workflowId, revision: workflow.revision, steps, groups, concurrency, clamped }, errors, warnings };
}
