export const ARCH_SCHEMA_VERSION = 1;
export const ARCH_NODE_KINDS = [
    'module',
    'service',
    'data',
    'interface',
    'decision',
    'external',
];
export const ARCH_EDGE_KINDS = ['call', 'data', 'event', 'deploy'];
function err(code, path, message) {
    return { code, path, message, severity: 'error' };
}
function warn(code, path, message) {
    return { code, path, message, severity: 'warning' };
}
function isObj(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
export function validateArchitecture(input) {
    const errors = [];
    const warnings = [];
    if (!isObj(input)) {
        return { ok: false, errors: [err('ROOT_NOT_OBJECT', '', '顶层必须是对象')], warnings };
    }
    if (input['schemaVersion'] !== ARCH_SCHEMA_VERSION) {
        errors.push(err('SCHEMA_VERSION', 'schemaVersion', `必须是 ${ARCH_SCHEMA_VERSION}`));
    }
    if (typeof input['architectureId'] !== 'string' || input['architectureId'].length === 0) {
        errors.push(err('ARCH_ID_MISSING', 'architectureId', 'architectureId 必须是非空字符串'));
    }
    if (!Number.isInteger(input['revision']) || input['revision'] < 1) {
        errors.push(err('REVISION_INVALID', 'revision', 'revision 必须是 >= 1 的整数'));
    }
    const keys = new Set(['schemaVersion', 'architectureId', 'revision', 'nodes', 'edges', 'constraints', 'openQuestions', 'createdAt', 'unmapped', 'note']);
    for (const key of Object.keys(input))
        if (!keys.has(key))
            errors.push(err('UNKNOWN_FIELD', key, '未知字段，请放入 unmapped 并解释'));
    if (typeof input['createdAt'] !== 'string' || Number.isNaN(Date.parse(input['createdAt'])))
        errors.push(err('CREATED_AT_INVALID', 'createdAt', '需要合法时间'));
    const strings = (value, path) => {
        if (value !== undefined && (!Array.isArray(value) || value.some((v) => typeof v !== 'string')))
            errors.push(err('STRING_ARRAY_REQUIRED', path, '必须为字符串数组'));
    };
    for (const key of ['constraints', 'openQuestions', 'unmapped'])
        strings(input[key], key);
    if (input['note'] !== undefined && typeof input['note'] !== 'string')
        errors.push(err('NOTE_INVALID', 'note', '必须为字符串'));
    const rawNodes = input['nodes'];
    const rawEdges = input['edges'];
    if (!Array.isArray(rawNodes))
        errors.push(err('NODES_NOT_ARRAY', 'nodes', 'nodes 必须是数组'));
    if (!Array.isArray(rawEdges))
        errors.push(err('EDGES_NOT_ARRAY', 'edges', 'edges 必须是数组'));
    if (!Array.isArray(rawNodes) || !Array.isArray(rawEdges))
        return { ok: false, errors, warnings };
    const ids = new Set();
    rawNodes.forEach((n, i) => {
        if (!isObj(n)) {
            errors.push(err('NODE_NOT_OBJECT', `nodes[${i}]`, '节点必须是对象'));
            return;
        }
        const id = n['id'];
        strings(n['interface'], `nodes[${i}].interface`);
        strings(n['sourceRefs'], `nodes[${i}].sourceRefs`);
        if (n['locked'] !== undefined && typeof n['locked'] !== 'boolean')
            errors.push(err('LOCK_INVALID', `nodes[${i}].locked`, 'locked 必须是布尔值'));
        const nodeKeys = new Set(['id', 'kind', 'title', 'responsibility', 'interface', 'sourceRefs', 'locked']);
        for (const key of Object.keys(n))
            if (!nodeKeys.has(key))
                errors.push(err('UNKNOWN_FIELD', `nodes[${i}].${key}`, '未知节点字段'));
        if (typeof id !== 'string' || id.length === 0) {
            errors.push(err('NODE_ID_MISSING', `nodes[${i}].id`, '缺少 id'));
        }
        else if (ids.has(id)) {
            errors.push(err('NODE_ID_DUPLICATE', `nodes[${i}].id`, `id 重复：${id}`));
        }
        else {
            ids.add(id);
        }
        if (typeof n['kind'] !== 'string' || !ARCH_NODE_KINDS.includes(n['kind'])) {
            errors.push(err('NODE_KIND_UNKNOWN', `nodes[${i}].kind`, `kind 必须是 ${ARCH_NODE_KINDS.join(' / ')}`));
        }
        if (typeof n['title'] !== 'string' || n['title'].trim() === '') {
            errors.push(err('NODE_TITLE_MISSING', `nodes[${i}].title`, 'title 不能为空'));
        }
        if (typeof n['responsibility'] !== 'string' || n['responsibility'].trim() === '') {
            errors.push(err('NODE_RESPONSIBILITY_MISSING', `nodes[${i}].responsibility`, 'responsibility 不能为空（图里只显示摘要，全文必须保留）'));
        }
    });
    const edgeIds = new Set();
    rawEdges.forEach((e, i) => {
        if (!isObj(e)) {
            errors.push(err('EDGE_NOT_OBJECT', `edges[${i}]`, '边必须是对象'));
            return;
        }
        if (e['bidirectional'] !== undefined && typeof e['bidirectional'] !== 'boolean')
            errors.push(err('BIDIRECTIONAL_INVALID', `edges[${i}].bidirectional`, '必须为布尔值'));
        if (e['description'] !== undefined && typeof e['description'] !== 'string')
            errors.push(err('DESCRIPTION_INVALID', `edges[${i}].description`, '必须为字符串'));
        const edgeKeys = new Set(['id', 'from', 'to', 'kind', 'bidirectional', 'description']);
        for (const key of Object.keys(e))
            if (!edgeKeys.has(key))
                errors.push(err('UNKNOWN_FIELD', `edges[${i}].${key}`, '未知关系字段'));
        if (typeof e['id'] !== 'string' || e['id'].length === 0) {
            errors.push(err('EDGE_ID_MISSING', `edges[${i}].id`, '缺少 id'));
        }
        else if (edgeIds.has(e['id'])) {
            errors.push(err('EDGE_ID_DUPLICATE', `edges[${i}].id`, `id 重复：${e['id']}`));
        }
        else {
            edgeIds.add(e['id']);
        }
        for (const end of ['from', 'to']) {
            const v = e[end];
            if (typeof v !== 'string' || !ids.has(v)) {
                errors.push(err('EDGE_ENDPOINT_UNKNOWN', `edges[${i}].${end}`, `找不到节点：${String(v)}`));
            }
        }
        if (typeof e['kind'] !== 'string' || !ARCH_EDGE_KINDS.includes(e['kind'])) {
            errors.push(err('EDGE_KIND_UNKNOWN', `edges[${i}].kind`, `kind 必须是 ${ARCH_EDGE_KINDS.join(' / ')}`));
        }
        if (e['from'] === e['to']) {
            errors.push(err('EDGE_SELF_LOOP', `edges[${i}]`, '架构图也不接受自环'));
        }
    });
    // 架构**允许**环 —— 这里只给提示，不算错误。
    const cycles = findArchitectureCycles(rawNodes.filter(isObj), rawEdges.filter(isObj));
    if (cycles.length > 0) {
        warnings.push(warn('ARCH_HAS_CYCLE', 'edges', `检测到 ${cycles.length} 组通信环（架构层合法）：${cycles.map((c) => c.join(' → ')).join(' | ')}`));
    }
    return { ok: errors.length === 0, errors, warnings };
}
/** 架构层的强连通分组，仅用于展示与「转任务时要打断哪些环」的提示。 */
export function findArchitectureCycles(nodes, edges) {
    const adj = new Map();
    for (const n of nodes)
        adj.set(n.id, []);
    for (const e of edges) {
        adj.get(e.from)?.push(e.to);
        if (e.bidirectional)
            adj.get(e.to)?.push(e.from);
    }
    const index = new Map();
    const low = new Map();
    const onStack = new Set();
    const stack = [];
    const out = [];
    let counter = 0;
    const strongconnect = (v) => {
        index.set(v, counter);
        low.set(v, counter);
        counter += 1;
        stack.push(v);
        onStack.add(v);
        for (const w of adj.get(v) ?? []) {
            if (!index.has(w)) {
                strongconnect(w);
                low.set(v, Math.min(low.get(v), low.get(w)));
            }
            else if (onStack.has(w)) {
                low.set(v, Math.min(low.get(v), index.get(w)));
            }
        }
        if (low.get(v) === index.get(v)) {
            const comp = [];
            for (;;) {
                const w = stack.pop();
                if (w === undefined)
                    break;
                onStack.delete(w);
                comp.push(w);
                if (w === v)
                    break;
            }
            // 只报真正的环：>1 个节点，或自环。
            const selfLoop = comp.length === 1 && (adj.get(comp[0]) ?? []).includes(comp[0]);
            if (comp.length > 1 || selfLoop)
                out.push(comp.reverse());
        }
    };
    for (const n of nodes)
        if (!index.has(n.id))
            strongconnect(n.id);
    return out;
}
