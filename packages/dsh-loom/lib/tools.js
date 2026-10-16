/**
 * dsh-loom · 宿主半边：模型侧工具。
 *
 * ── 为什么不用 `defineTool` ────────────────────────────────────────────
 * `defineTool` 只做两件事：把作者 DSL 编译成 JSON Schema、校验 `timeoutMs`。
 * 这里直接把**编译后的 JSON Schema** 交给 `ctx.tools.register()` ——
 * 那正是 `defineTool` 的返回值，也是官方 README 说的 wire-level 形式。
 * 好处是宿主半边**零非内置 import**（core 会被打包进来，不靠运行时解析）。
 *
 * ── ⚠ `required` 必须是父级字符串数组 ─────────────────────────────────
 * 宿主的 `JsonSchemaNode` 只支持 `required?: string[]`，**没有** `required: boolean`。
 * 写成布尔值会被当未知关键字丢掉：**不报错、不告警，必填校验静默失效**。
 * 所以 `assertRequiredShape()` 在装载期就抛，见下。
 */
import { CAPABILITY_KEYS, adoptPlannerOutput, capabilityGaps, compileArchitecturePrompt, compileCoordinatorPrompt, compileWorkflow, contentDigest, describeDegradations, knownCapabilities, missingCapabilities, normalizeWorkspaceId, planMigration, stageLabel, validateAdoptedRevision, validateArchitecture, validateWorkflow, buildTaskPackage, } from './core/index.js';
import { toolWorkspace } from './workspace.js';
import { existsSync } from 'node:fs';
const text = (value) => [{ type: 'text', text: String(value) }];
// Tool values retain JSON receipts beside their rendered text. The host validates
// this schema after execution, so these structured fields must be admitted.
const OUT_TEXT = {
    type: 'object',
    additionalProperties: true,
    properties: { text: { type: 'string' } },
    required: ['text'],
};
function tool(spec) {
    if (!spec.name || !spec.description)
        throw new Error('工具必须有 name 与 description');
    const parameters = spec.parameters ?? { type: 'object', additionalProperties: false, properties: {} };
    const outputSchema = spec.output?.schema ?? OUT_TEXT;
    assertRequiredShape(spec.name, parameters);
    assertRequiredShape(spec.name, outputSchema);
    return {
        name: spec.name,
        description: spec.description,
        parameters,
        output: {
            schema: outputSchema,
            render: (_args, value) => text(value?.text ?? ''),
        },
        async execute(args, exec) {
            const result = await spec.execute(args ?? {}, exec);
            return typeof result === 'string' ? { text: result } : result;
        },
    };
}
/**
 * 守住 `required` 的形状。
 * 宿主的 JSON Schema 子集只有 `required?: string[]`；写成布尔值会静默失效。
 */
export function assertRequiredShape(toolName, schema) {
    if (schema == null || typeof schema !== 'object')
        return;
    const node = schema;
    if (node['required'] !== undefined && !Array.isArray(node['required'])) {
        throw new TypeError(`工具 ${toolName} 的 required 必须是字符串数组（宿主只支持 required?: string[]），收到 ${JSON.stringify(node['required'])}`);
    }
    const props = node['properties'];
    if (props && typeof props === 'object' && !Array.isArray(props)) {
        for (const [key, child] of Object.entries(props)) {
            if (child && typeof child === 'object' && child['required'] !== undefined) {
                throw new TypeError(`工具 ${toolName} 的 properties.${key}.required 写法错误：required 只能放在父级、且必须是字符串数组`);
            }
            assertRequiredShape(`${toolName}.${key}`, child);
        }
    }
    if (Array.isArray(node['items'])) {
        node['items'].forEach((item, i) => assertRequiredShape(`${toolName}.items[${i}]`, item));
    }
    else if (node['items']) {
        assertRequiredShape(`${toolName}.items`, node['items']);
    }
    for (const key of ['oneOf', 'anyOf', 'allOf']) {
        const list = node[key];
        if (Array.isArray(list))
            list.forEach((item, i) => assertRequiredShape(`${toolName}.${key}[${i}]`, item));
    }
}
function parseJsonArg(args, key) {
    const raw = args[key];
    if (typeof raw !== 'string')
        return raw;
    try {
        return JSON.parse(raw);
    }
    catch (error) {
        throw new Error(`参数 ${key} 不是合法 JSON：${error.message}`);
    }
}
/** 收窄成字符串数组：丢掉非字符串项，不抛 —— 调用方已经会校验空列表。 */
function asStringArray(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((v) => typeof v === 'string' && v.length > 0);
}
export function createTools(deps) {
    const caps = () => deps.capabilities?.() ?? knownCapabilities();
    return [
        ...(deps.planning ? [tool({ name: 'loom_resolve_questions', description: '逐项提交有依据的开工建议；不实施或批准。document 为 {requestId,answers:[{index,status,decision,reason,sources,taskIds,verification,question,options,recommended}]} JSON。status: researched/default/deferred/ask/blocked。decision/reason 各最多700字符；sources最多6条，locator300/observation1000；verification1000/question500/options各200。失败答案保留，可用 {requestId,retry:true,answers:[{index,需修改字段}]} 局部修正。成功后简短提示查看采纳，不输出整份JSON。', parameters: { type: 'object', additionalProperties: false, properties: { document: { type: 'string' } }, required: ['document'] }, async execute(args, exec) { const value = deps.planning.resolveQuestions(exec?.agent, parseJsonArg(args, 'document'), exec?.callId); return { candidateId: value.candidateId, waitingApproval: true, text: '处理建议已准备好。请在计划面板查看并采纳，再批准开工。尚未实施。' }; } })] : []),
        ...(deps.planning ? [tool({ name: 'loom_submit_plan', description: '提交待批准完整 JSON 候选。失败候选会保留：document 可为 {"retry":true,"removeFields":["/architecture/nodes/1/nodeKind"]} 删除指定未知字段，或 {"retry":true,"restoreConstraints":true} 补回原始约束，无需重传任务图。严格校验仍生效。成功仅保存计划，返回完整文字和图，然后等待用户批准。', parameters: { type: 'object', additionalProperties: false, properties: { document: { type: 'string' } }, required: ['document'] }, async execute(args, exec) { const value = deps.planning.submit(exec?.agent, parseJsonArg(args, 'document'), exec?.callId); return { ...value, text: value.markdown + '\n\n计划已提交，等待用户修改并批准。' }; } })] : []),
        /* ------------------------------------------------------------------ */
        tool({
            name: 'loom_capabilities',
            description: '报告 Loom 在当前 DSH 组合下的能力矩阵。**四档分开**：宿主是否声明入口 / Loom 是否实现 / 环境是否探测到 / 这次运行是否验证过。' +
                '任一档为真都不蕴含其余为真 —— 「宿主有入口」不等于「当前能跑」。不按包名或版本号猜能力。',
            parameters: { type: 'object', additionalProperties: false, properties: {} },
            async execute() {
                const c = caps();
                const rows = describeDegradations(c);
                const lines = [];
                lines.push(`宿主版本：${c.hostVersion}`);
                lines.push(`生效引擎：${c.engine.workflowEnginePackage}（provider=${c.engine.subagentProvider}）`);
                lines.push(`探测时间：${c.probedAt}`);
                lines.push('');
                lines.push('| 能力 | 宿主声明 | Loom 实现 | 环境探测 | 运行验证 | 卡在哪一档 | 来源 |');
                lines.push('|---|---|---|---|---|---|---|');
                for (const key of CAPABILITY_KEYS) {
                    const f = c[key];
                    const yn = (v) => (v ? '✅' : '❌');
                    const env = f.availableInEnv === true ? '✅' : f.availableInEnv === false ? '❌' : '❔';
                    const backend = f.backend === 'host' ? '宿主提供' : '本项目自建';
                    lines.push(`| ${key} | ${yn(f.declaredByHost)} | ${yn(f.implementedByLoom)} | ${env} | ${yn(f.verifiedInRun)} | ${stageLabel(f)} | ${backend} |`);
                }
                lines.push('');
                lines.push('说明：`✅`＝成立，`❌`＝不成立，`❔`＝未探测。');
                lines.push('「环境探测」为 ❔ 的项，其 `lastVerifiedAt` 必然为空 —— 没有验证就没有时间戳。');
                if (rows.length) {
                    lines.push('');
                    lines.push('## 未完成 / 未验证项（含 limits，不再被过滤）');
                    for (const r of rows) {
                        lines.push(`- **${r.key}**（${r.state}）`);
                        for (const g of r.gaps)
                            lines.push(`    · ${g}`);
                        lines.push(`    → 替代路径：${r.fallback}`);
                    }
                }
                lines.push('');
                lines.push('## 逐项证据');
                for (const key of CAPABILITY_KEYS) {
                    const f = c[key];
                    lines.push(`### ${key}（lastVerifiedAt=${f.lastVerifiedAt ?? '（从未验证）'}）`);
                    for (const e of f.evidence) {
                        lines.push(`- [${e.kind}] ${e.where}${e.at ? ` （${e.at}）` : ''}`);
                    }
                    if (f.evidence.length === 0)
                        lines.push('- （无证据）');
                }
                return { text: lines.join('\n') };
            },
        }),
        /* ------------------------------------------------------------------ */
        tool({
            name: 'loom_validate',
            description: '校验一份 Loom 任务图（planner-output 形状）或架构图。返回可定位到节点/字段的错误与警告。只做结构校验，不代表任何执行授权。',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    kind: { type: 'string', enum: ['workflow', 'architecture'], description: '要校验的图类型' },
                    document: { type: 'string', description: '待校验的 JSON 文本' },
                },
                required: ['kind', 'document'],
            },
            async execute(args, exec) {
                const doc = parseJsonArg(args, 'document');
                const kind = args['kind'] === 'architecture' ? 'architecture' : 'workflow';
                const result = kind === 'architecture' ? validateArchitecture(doc) : validateWorkflow(doc);
                const lines = [];
                lines.push(result.ok ? `✅ ${kind} 校验通过` : `❌ ${kind} 校验未通过`);
                if (result.errors.length) {
                    lines.push('', `## 错误（${result.errors.length}）`);
                    for (const e of result.errors.slice(0, 50))
                        lines.push(`- [${e.code}] ${e.path}：${e.message}`);
                }
                if (result.warnings.length) {
                    lines.push('', `## 警告（${result.warnings.length}）`);
                    for (const w of result.warnings.slice(0, 50))
                        lines.push(`- [${w.code}] ${w.path}：${w.message}`);
                }
                return { text: lines.join('\n'), ok: result.ok, errors: result.errors, warnings: result.warnings };
            },
        }),
        /* ------------------------------------------------------------------ */
        tool({
            name: 'loom_compile',
            description: '把一份已采纳的任务 revision 按依赖批次编译成 PTC workflow 脚本。批内用 parallel()，批间由消费端独立验收后再启动下一批。只编译，不执行、不派发。',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    workflowId: { type: 'string', description: '工作流 id' },
                    revision: { type: 'number', description: '要编译的 revision；省略则取最新' },
                    baseSha: { type: 'string', description: '所有模块共同的基线 commit' },
                    cwdTemplate: { type: 'string', description: '执行目录模板，支持 {nodeId} 占位' },
                },
                required: ['workflowId'],
            },
            async execute(args, exec) {
                const workflowId = String(args['workflowId']);
                const revision = typeof args['revision'] === 'number' ? args['revision'] : undefined;
                const wf = revision === undefined ? deps.store.latestRevision(workflowId, requiredWorkspace(exec)) : deps.store.revisionAt(workflowId, revision, requiredWorkspace(exec));
                if (!wf)
                    throw new Error(`找不到 revision：${workflowId}${revision === undefined ? '' : `@${revision}`}`);
                const adopted = validateAdoptedRevision(wf);
                if (!adopted.ok) {
                    return { text: `revision 未通过校验，无法编译：\n${adopted.errors.map((e) => `- [${e.code}] ${e.path}：${e.message}`).join('\n')}` };
                }
                const c = caps();
                const missing = missingCapabilities(c, wf);
                const template = typeof args['cwdTemplate'] === 'string' ? args['cwdTemplate'] : '<cwd>/{nodeId}';
                const baseSha = typeof args['baseSha'] === 'string' ? args['baseSha'] : '<unset-baseSha>';
                let plan;
                try {
                    plan = compileWorkflow(wf, c, {
                        resolveCwd: (n) => template.replace('{nodeId}', n.id),
                        baseSha,
                    });
                }
                catch (error) {
                    return { text: `编译被拒绝：${error.message}` };
                }
                const lines = [];
                lines.push(`编译完成：${plan.workflowId}@${plan.revision}，${plan.batches.length} 个批次`);
                lines.push(`planHash：${plan.planHash}`);
                if (missing.length) {
                    lines.push('');
                    lines.push(`⚠ 计划要求但当前不可用的能力：${missing.join('、')}。这些批次**不可派发**。`);
                }
                lines.push('');
                for (const b of plan.batches) {
                    lines.push(`### 批次 ${b.index}（agent 调用 ${b.agentCalls}，并发上限 ${plan.concurrency[b.index]}）`);
                    lines.push(`节点：${b.nodeIds.join('、')}`);
                    lines.push(`scriptHash：${b.scriptHash}`);
                    lines.push('');
                }
                lines.push('（脚本正文请用 HTTP `GET /loom/batch?workflowId=...&revision=...&index=...` 取，避免塞爆上下文。）');
                return { text: lines.join('\n'), planHash: plan.planHash, batches: plan.batches.map((b) => ({ index: b.index, nodeIds: b.nodeIds, scriptHash: b.scriptHash })) };
            },
        }),
        /* ------------------------------------------------------------------ */
        tool({
            name: 'loom_prompt',
            description: '确定性导出提示词。kind=architecture 生成「架构优化请求」；kind=coordinator 生成「协调总提示词」；kind=task 生成单个模块的 TaskPackage。不改动图或派发；架构请求身份保存在本项目，供候选预览和采纳校验。',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    kind: { type: 'string', enum: ['architecture', 'coordinator', 'task'], description: '提示词种类' },
                    workflowId: { type: 'string', description: '工作流 id' },
                    architectureId: { type: 'string', description: '架构 id（kind=architecture 时用）' },
                    revision: { type: 'number', description: 'revision；省略取最新' },
                    nodeId: { type: 'string', description: '节点 id（kind=task 时用）' },
                    baseSha: { type: 'string', description: 'kind=task 时的基线 commit' },
                },
                required: ['kind'],
            },
            async execute(args, exec) {
                const kind = String(args['kind']);
                if (kind === 'task') {
                    const workflowId = String(args['workflowId'] ?? '');
                    const wf = args['revision'] === undefined ? deps.store.latestRevision(workflowId, requiredWorkspace(exec)) : deps.store.revisionAt(workflowId, Number(args['revision']), requiredWorkspace(exec));
                    if (!wf)
                        throw new Error(`找不到工作流：${workflowId}`);
                    const node = wf.nodes.find((n) => n.id === args['nodeId']);
                    if (!node)
                        throw new Error(`找不到节点：${String(args['nodeId'])}`);
                    const textOut = buildTaskPackage({
                        workflow: { workflowId: wf.workflowId, revision: wf.revision, inputDigest: wf.inputDigest },
                        node,
                        upstream: wf.edges
                            .filter((e) => e.target === node.id)
                            .map((e) => ({ nodeId: e.source, port: e.sourcePort, type: e.artifactType, ref: `artifact://${e.source}/${e.sourcePort}` })),
                        cwd: `<cwd>/${node.id}`,
                        baseSha: typeof args['baseSha'] === 'string' ? args['baseSha'] : '<unset-baseSha>',
                        allowedChecks: node.acceptance.commands.map((c) => c.argv.join(' ')),
                    });
                    return { text: textOut };
                }
                if (kind === 'coordinator') {
                    const workflowId = String(args['workflowId'] ?? '');
                    const wf = args['revision'] === undefined ? deps.store.latestRevision(workflowId, requiredWorkspace(exec)) : deps.store.revisionAt(workflowId, Number(args['revision']), requiredWorkspace(exec));
                    if (!wf)
                        throw new Error(`找不到工作流：${workflowId}`);
                    const layers = [];
                    const layerOf = new Map();
                    const indeg = new Map();
                    const adj = new Map();
                    for (const n of wf.nodes) {
                        indeg.set(n.id, 0);
                        adj.set(n.id, []);
                    }
                    for (const e of wf.edges) {
                        adj.get(e.source)?.push(e.target);
                        indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
                    }
                    const q = [];
                    for (const [id, d] of indeg)
                        if (d === 0) {
                            layerOf.set(id, 0);
                            q.push(id);
                        }
                    const rem = new Map(indeg);
                    while (q.length) {
                        const id = q.shift();
                        for (const nx of adj.get(id) ?? []) {
                            layerOf.set(nx, Math.max(layerOf.get(nx) ?? 0, (layerOf.get(id) ?? 0) + 1));
                            const d = (rem.get(nx) ?? 0) - 1;
                            rem.set(nx, d);
                            if (d === 0)
                                q.push(nx);
                        }
                    }
                    for (const n of wf.nodes) {
                        const l = layerOf.get(n.id) ?? 0;
                        while (layers.length <= l)
                            layers.push([]);
                        layers[l].push(n.id);
                    }
                    return { text: compileCoordinatorPrompt(wf, layers.filter((l) => l.length)) };
                }
                // architecture
                const ws = requiredWorkspace(exec);
                const architectureId = String(args['architectureId'] ?? '');
                const draft = deps.store.latestArchitecture(architectureId, requiredWorkspace(exec));
                if (!draft)
                    throw new Error(`找不到架构：${architectureId}`);
                const context = deps.store.architectureContext(architectureId, ws);
                const pkg = compileArchitecturePrompt({
                    projectId: ws,
                    proposalId: `${architectureId}-prop`,
                    baseRevision: context.baseRevision,
                    base: deps.store.architectureAt(architectureId, context.baseRevision, ws) ?? undefined,
                    draftRevision: draft.revision,
                    inputDigest: contentDigest(draft),
                    scope: 'all',
                    draft,
                    changes: context.changes,
                    lockedConstraints: draft.constraints ?? [],
                    sources: [],
                });
                deps.store.saveRefinementRequest(ws, { payloadHash: pkg.payloadHash, architectureId, baseRevision: context.baseRevision, draftRevision: draft.revision, scope: 'all' });
                return { text: pkg.text, payloadHash: pkg.payloadHash };
            },
        }),
        /* ------------------------------------------------------------------ */
        tool({
            name: 'loom_status',
            description: '返回 Loom 当前状态：草案模式、最新 revision、能力缺口、未完成项与最近事件。只读。' +
                '草案/布局/来源映射按工作区分区，必须提供 workspaceId。',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    workspaceId: {
                        type: 'string',
                        description: '工作区 id（工作区路径或项目标识）。草案/布局/来源映射按它分区。',
                    },
                },
            },
            async execute(args, exec) {
                const c = caps();
                const workspaceId = toolWorkspace(exec);
                const rawWs = workspaceId;
                const draft = workspaceId === null ? null : deps.store.readDraft(workspaceId);
                const stats = workspaceId ? deps.store.stats(workspaceId) : { revisions: 0, architectures: 0, runs: 0, events: 0 };
                const degradations = describeDegradations(c);
                const lines = [];
                lines.push(`# Loom 状态`);
                if (workspaceId === null) {
                    lines.push(`- 工作区：**未提供**（收到「${String(rawWs)}」）。草案/布局/来源映射按工作区分区，` +
                        '没有它就查不到 —— 不会回落到全局文件，那会跨项目串数据。');
                    lines.push(`- 已分区的工作区：${(workspaceId ? [workspaceId] : []).join('、') || '（无）'}`);
                }
                else {
                    lines.push(`- 工作区：${workspaceId}`);
                    lines.push(`- 分区目录：${deps.store.workspacePaths(workspaceId).dir}`);
                    lines.push(`- 模式：${draft?.mode ?? '（未设置）'}`);
                    lines.push(`- 当前工作流：${draft?.workflowId ?? '（无）'}`);
                    if (draft?.architectureId !== undefined) {
                        lines.push(`- 架构基线：${draft.architectureId}@${String(draft.architectureRevision ?? '?')}`);
                    }
                }
                lines.push(`- revision 数：${stats.revisions}；架构数：${stats.architectures}；运行记录：${stats.runs}`);
                lines.push(`- 数据目录：${deps.store.paths.root}`);
                const legacy = deps.store.legacyFilesPresent();
                if (legacy.drafts || legacy.presentation || legacy.sourcemap) {
                    lines.push(`- ⚠ 检测到旧版全局文件：${[
                        legacy.drafts ? 'drafts.json' : '',
                        legacy.presentation ? 'presentation.json' : '',
                        legacy.sourcemap ? 'sourcemap.json' : '',
                    ]
                        .filter(Boolean)
                        .join('、')}。它们不再被读写，请用 \`loom_worktree action=migrate\` 预览迁移（会保留备份）。`);
                }
                lines.push('');
                lines.push('## 能力状态（逐档，不合并成「可用/不可用」）');
                for (const key of CAPABILITY_KEYS) {
                    const f = c[key];
                    lines.push(`- ${key}：${stageLabel(f)}（backend=${f.backend}）`);
                }
                lines.push('');
                lines.push('## 未完成 / 未验证项');
                for (const d of degradations) {
                    lines.push(`- ${d.key}（${d.state}）`);
                    for (const g of d.gaps)
                        lines.push(`    · ${g}`);
                    lines.push(`    → 替代路径：${d.fallback}`);
                }
                lines.push('');
                lines.push('## 最近事件');
                for (const e of deps.store.readEvents(10, workspaceId ?? 'unresolved').reverse())
                    lines.push(`- ${e.at} ${e.kind}${e.detail ? ` · ${e.detail}` : ''}`);
                return { text: lines.join('\n') };
            },
        }),
        /* ------------------------------------------------------------------ */
        tool({
            name: 'loom_adopt',
            description: '把一份通过校验的候选任务图采纳成不可变的 revision。这是**写操作**：默认只允许用户从画布发起（allowModelDraftWrite=false 时模型调用会被拒绝）。采纳不等于执行。',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    workflowId: { type: 'string', description: '工作流 id' },
                    candidate: { type: 'string', description: '候选任务图 JSON 文本（planner-output 形状）' },
                    inputDigest: { type: 'string', description: '可选：输入快照摘要' },
                },
                required: ['workflowId', 'candidate'],
            },
            async execute(args, exec) {
                if (!deps.getConfig().allowModelDraftWrite) {
                    return {
                        text: '❌ 拒绝：`allowModelDraftWrite` 为 false。采纳 revision 会改变后续编译的输入，属于写操作，' +
                            '默认只允许用户在画布里发起。请在 Loom 设置页打开该项，或改用 HTTP `POST /loom/adopt`。',
                        adopted: false,
                    };
                }
                const workflowId = String(args['workflowId']);
                const candidate = parseJsonArg(args, 'candidate');
                const revision = (deps.store.latestRevision(workflowId, requiredWorkspace(exec))?.revision ?? 0) + 1;
                const result = adoptPlannerOutput(candidate, {
                    inputDigest: typeof args['inputDigest'] === 'string' ? args['inputDigest'] : undefined,
                    adoptedAt: new Date().toISOString(),
                });
                if (!result.accepted || !result.workflow) {
                    return {
                        text: `❌ 候选图未通过校验，未产生 revision：\n${result.errors
                            .slice(0, 20)
                            .map((e) => `- [${e.code}] ${e.path}：${e.message}`)
                            .join('\n')}`,
                        adopted: false,
                        errors: result.errors,
                    };
                }
                const next = { ...result.workflow, workflowId, revision };
                deps.store.appendRevision(next, requiredWorkspace(exec));
                deps.store.event({ workspaceId: requiredWorkspace(exec), kind: 'adopt', workflowId, revision, detail: `nodes=${next.nodes.length} via=tool` });
                return {
                    text: `✅ 已采纳 ${workflowId}@${revision}（${summarizeWorkflow(next)}）。采纳不等于执行。${result.blocked.length ? `\n阻塞项：${result.blocked.map((b) => b.reason).join('；')}` : ''}`,
                    adopted: true,
                    revision,
                };
            },
        }),
        /* ------------------------------------------------------------------ */
        tool({
            name: 'loom_run',
            description: '请求执行一个已采纳的任务 revision。需完整冻结 baseSha 与实际父会话。需 Loom provider 注册成功；支持 WSL 原生和 Windows→WSL 独立工作树模块 DAG，完整阶段管线与自动集成暂不支持。',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    workflowId: { type: 'string', description: '工作流 id' },
                    revision: { type: 'number', description: '要执行的 revision' },
                    reason: { type: 'string', description: '为什么要执行' },
                    baseSha: { type: 'string', description: '已经冻结的完整 Git commit SHA（40 位）' },
                },
                required: ['workflowId', 'revision'],
            },
            async execute(args, exec) {
                const sid = exec?.agent?.session?.id ?? exec?.agent?.session?.header?.id;
                if (sid && (deps.planning ? deps.planning.held(sid, exec.agent) : (deps.store.readSessionPlanningModeExplicit(sid) ?? deps.getConfig().planningModeDefault)))
                    throw new Error('LOOM_WAITING_APPROVAL: 规划阶段不能开工');
                const workflowId = String(args['workflowId']);
                const revision = Number(args['revision']);
                const wf = deps.store.revisionAt(workflowId, revision, requiredWorkspace(exec));
                if (!wf)
                    throw new Error(`找不到 revision：${workflowId}@${revision}`);
                if (deps.runWorkflow) {
                    const result = await deps.runWorkflow(wf, exec, args);
                    const audits = Array.isArray(result.audits) && result.audits.length
                        ? '\n审计组：' + result.audits.map((audit) => `${audit.groupId}·主审 ${audit.label}·${audit.verdict === 'pass' ? '通过' : '未通过'}${audit.findings.length ? '（' + audit.findings.join('；') + '）' : ''}`).join('；')
                        : '';
                    return { ...result, text: `运行 ${result.runId}: ${result.state}。已验收 ${result.completed.length} 个模块；工作树保留，尚未集成。${result.error ?? ''}${audits}` };
                }
                const c = caps();
                const missing = missingCapabilities(c, wf);
                const now = new Date().toISOString();
                const runId = `run-${contentDigest({ workflowId, revision, now }).slice(0, 12)}`;
                if (missing.length > 0) {
                    deps.store.appendRun({
                        workspaceId: requiredWorkspace(exec),
                        runId,
                        workflowId,
                        revision,
                        planHash: '<not-compiled>',
                        attempt: 1,
                        state: 'refused',
                        startedAt: now,
                        endedAt: now,
                        reason: `缺少能力：${missing.join('、')}`,
                    });
                    deps.store.event({ workspaceId: requiredWorkspace(exec), kind: 'run-refused', workflowId, revision, runId, detail: missing.join('、') });
                    return {
                        text: [
                            `❌ 拒绝派发：当前运行时缺少计划要求的能力。`,
                            `缺少：${missing.join('、')}`,
                            '',
                            'Loom 不会用共享 cwd 多代理写代码来假装并行，也不会把这件事外包给任何第三方插件。',
                            '可选替代路径：',
                            '1. 用 `loom_prompt kind=coordinator` 导出协调提示词，人工在 WSL 里执行；',
                            '2. 用 `loom_prompt kind=task nodeId=...` 逐个导出任务包；',
                            '3. 核对宿主平台与 provider 的注册结果；确保所选 WSL 发行版与用户、Node、Git 和宿主公开服务可用。',
                        ].join('\n'),
                        runId,
                        state: 'refused',
                        missing,
                    };
                }
                deps.store.appendRun({
                    workspaceId: requiredWorkspace(exec),
                    runId,
                    workflowId,
                    revision,
                    planHash: '<not-compiled>',
                    attempt: 1,
                    state: 'refused',
                    startedAt: now,
                    endedAt: now,
                    reason: '当前宿主未注册可用的执行通路',
                });
                return {
                    text: [
                        '❌ 当前宿主未注册可用的 Loom 执行通路。',
                        '缺少的关键一环：把子代理落进 WSL 独立工作树的最小执行桥（见 ADR-001）。',
                        '在此之前不显示 running，也不伪造 runId 之外的回执。',
                    ].join('\n'),
                    runId,
                    state: 'refused',
                };
            },
        }),
        tool({
            name: 'loom_worktree',
            description: '管理「逐任务独立工作树」与工作区分区迁移。\n' +
                'action=list 查看当前状态；action=preview 只算路径不落盘；' +
                'action=create 为一批任务建独立 git 工作树（要求同一仓库、同一 baseSha）；' +
                'action=settle 结算（干净树自动移除，有改动/新提交/状态未知的树保留）；' +
                'action=migrate 预览旧版全局文件的分区迁移。\n' +
                '⚠ **强制删除不在这里** —— 它是破坏性操作，需要用户在设置页显式确认，' +
                '不走模型工具。模型无法用一个参数证明用户同意。',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    action: {
                        type: 'string',
                        description: 'list | preview | create | settle | migrate',
                        enum: ['list', 'preview', 'create', 'settle', 'migrate'],
                    },
                    runId: { type: 'string', description: '本次运行 id（create/settle 必填）' },
                    repoPath: { type: 'string', description: '源码仓库绝对路径（create 必填）' },
                    taskIds: {
                        type: 'array',
                        items: { type: 'string' },
                        description: '任务 id 列表（create/preview 必填）',
                    },
                    taskId: { type: 'string', description: '单个任务 id（settle 可选）' },
                    workspaceId: { type: 'string', description: '工作区 id（migrate 必填）' },
                },
                required: ['action'],
            },
            async execute(args, exec) {
                const manager = deps.getWorktrees?.();
                if (manager === undefined)
                    throw new Error('工作树管理器未挂载');
                const action = String(args['action'] ?? '');
                const ws = action === 'remove' ? null : requiredWorkspace(exec);
                const parentCwd = exec?.agent?.session?.header?.cwd;
                if (action === 'list') {
                    const live = manager.listLive(typeof args['runId'] === 'string' ? String(args['runId']) : undefined).filter((r) => normalizeWorkspaceId(r.repoPath) === ws);
                    if (live.length === 0) {
                        return { text: '当前没有活着的工作树。', action, count: 0, worktrees: [] };
                    }
                    const lines = live.map((w) => `· [${w.state}] ${w.taskId} → ${w.path}\n  分支 ${w.branch} · base ${w.baseSha.slice(0, 8)}${w.reason ? ` · ${w.reason}` : ''}`);
                    return { text: `活着的工作树 ${live.length} 棵：\n${lines.join('\n')}`, action, count: live.length, worktrees: live };
                }
                if (action === 'preview') {
                    const runId = String(args['runId'] ?? '<run>');
                    const taskIds = asStringArray(args['taskIds']);
                    if (taskIds.length === 0)
                        throw new Error('preview 需要 taskIds');
                    const plans = manager.preview(runId, taskIds);
                    const lines = plans.map((p) => `· ${p.taskId}\n  路径 ${p.path}\n  分支 ${p.branch}`);
                    return { text: `将建 ${plans.length} 棵树（未落盘）：\n${lines.join('\n')}`, action, plans };
                }
                if (action === 'create') {
                    const runId = String(args['runId'] ?? '');
                    const repoPath = String(args['repoPath'] ?? '');
                    const taskIds = asStringArray(args['taskIds']);
                    if (runId === '')
                        throw new Error('create 需要 runId');
                    if (repoPath === '')
                        throw new Error('create 需要 repoPath');
                    if (normalizeWorkspaceId(repoPath) !== ws)
                        throw new Error('WORKSPACE_MISMATCH: 不能在其他项目建树');
                    if (taskIds.length === 0)
                        throw new Error('create 需要 taskIds');
                    deps.store.event({ kind: 'worktree-create', runId, detail: `${repoPath} → ${taskIds.join('、')}` });
                    const result = await manager.create(runId, repoPath, taskIds);
                    if (!result.ok) {
                        deps.store.event({ kind: 'worktree-create-failed', runId, detail: result.problems.join(' | ') });
                        return {
                            text: `❌ 建树失败，未留下任何半成品：\n${result.problems.map((p) => `· ${p}`).join('\n')}`,
                            action,
                            ok: false,
                            problems: result.problems,
                        };
                    }
                    const lines = result.records.map((w) => `· ${w.taskId}\n  路径 ${w.path}\n  分支 ${w.branch}`);
                    return {
                        text: [
                            `✅ 已建 ${result.records.length} 棵独立工作树。`,
                            `仓库 ${result.repoPath}`,
                            `共同 baseSha ${result.baseSha}`,
                            '',
                            ...lines,
                            '',
                            '注意：建树只证明**目录建好了**，不证明子代理已经在里面跑。',
                            '任务派发由当前宿主 Loom provider 接管；请查看 `loom_capabilities`，采纳计划后再执行。',
                        ].join('\n'),
                        action,
                        ok: true,
                        baseSha: result.baseSha,
                        repoPath: result.repoPath,
                        worktrees: result.records,
                    };
                }
                if (action === 'settle') {
                    const runId = String(args['runId'] ?? '');
                    if (runId === '')
                        throw new Error('settle 需要 runId');
                    const taskId = typeof args['taskId'] === 'string' ? String(args['taskId']) : '';
                    if (manager.listLive(runId).some((r) => normalizeWorkspaceId(r.repoPath) !== ws))
                        throw new Error('WORKSPACE_MISMATCH: 不能结算其他项目工作树');
                    if (deps.store.latestRuns(10000).some((r) => r.runId === runId && ['running', 'queued', 'produced', 'validating'].includes(r.state)))
                        throw new Error('IN_FLIGHT: 不能结算在途工作树');
                    const verdicts = taskId === ''
                        ? await manager.settleRun(runId)
                        : [await manager.settle(runId, taskId)];
                    const removed = verdicts.filter((v) => v.action === 'remove').length;
                    const kept = verdicts.length - removed;
                    const lines = verdicts.map((v) => `· ${v.action === 'remove' ? '已移除' : '已保留'} — ${v.reason}`);
                    deps.store.event({ kind: 'worktree-settle', runId, detail: `移除 ${removed} · 保留 ${kept}` });
                    return {
                        text: [
                            `结算完成：移除 ${removed} 棵，保留 ${kept} 棵。`,
                            ...lines,
                            '',
                            '保留策略永远是「不确定就留」：拿不到 git 状态的树一律保留。',
                        ].join('\n'),
                        action,
                        removed,
                        kept,
                        verdicts,
                    };
                }
                if (action === 'migrate') {
                    const workspaceId = requiredWorkspace(exec);
                    if (workspaceId === null) {
                        throw new Error(`migrate 需要合法的 workspaceId（收到「${String(args['workspaceId'])}」）。` +
                            '不猜归属 —— 猜错的代价是把 A 项目的约束注入 B 项目。');
                    }
                    const legacy = deps.store.legacyFilesPresent();
                    const existing = ['drafts.json', 'presentation.json', 'sourcemap.json'].filter((f) => f === 'drafts.json' ? legacy.drafts : f === 'presentation.json' ? legacy.presentation : legacy.sourcemap);
                    if (existing.length === 0) {
                        return {
                            text: '没有旧版全局文件需要迁移。',
                            action,
                            workspaceId,
                            plans: [],
                            blockers: [],
                        };
                    }
                    const targetPaths = deps.store.workspacePaths(workspaceId);
                    const existingInTarget = existing.filter((f) => {
                        const p = f === 'drafts.json' ? targetPaths.drafts : f === 'presentation.json' ? targetPaths.presentation : targetPaths.sourcemap;
                        return existsSync(p);
                    });
                    const plan = planMigration({
                        root: deps.store.paths.root,
                        workspaceId,
                        existing,
                        existingInTarget,
                        keepBackup: true,
                    });
                    const lines = plan.plans.map((p) => `· ${p.file}\n  ${p.from}\n  → ${p.to}${p.targetExists ? '  ⚠ 目标已存在' : ''}`);
                    return {
                        text: [
                            `迁移预览（**未落盘**）：${plan.plans.length} 个文件 → 工作区「${workspaceId}」。`,
                            '',
                            ...lines,
                            '',
                            plan.blockers.length
                                ? `❌ 存在阻塞，拒绝执行：\n${plan.blockers.map((b) => `· ${b}`).join('\n')}`
                                : '✅ 无阻塞。实际迁移需用户在设置页确认（会保留 `.migrated-backup`）。',
                            '',
                            '模型不能直接执行迁移：它改写全局状态，属于需要用户确认的操作。',
                        ].join('\n'),
                        action,
                        workspaceId,
                        plans: plan.plans,
                        blockers: plan.blockers,
                    };
                }
                throw new Error(`未知 action：${action}`);
            },
        }),
    ];
}
/** 供测试断言用：暴露一个能构造 WorkflowRevision 的便捷函数。 */
export function summarizeWorkflow(wf) {
    return `${wf.workflowId}@${wf.revision} · ${wf.nodes.length} 节点 / ${wf.edges.length} 边`;
}
function requiredWorkspace(exec) {
    const ws = toolWorkspace(exec);
    if (!ws)
        throw new Error('WORKSPACE_UNRESOLVED: 必须由真实调用 Agent 的会话 cwd 确定工作区');
    return ws;
}
