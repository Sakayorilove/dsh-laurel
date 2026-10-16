export const resolutionLabels = {
    researched: '资料支持的处理建议', default: '建议采用的默认方案', deferred: '安排到任务中验证',
    ask: '需要你决定', blocked: '暂时无法继续',
};
const fail = (path = 'document', detail = '字段格式不正确') => { throw new Error('RESOLUTION_INVALID: ' + path + ': ' + detail); };
function text(value, limit = 2000, path = 'document') {
    if (typeof value !== 'string' || !value.trim())
        return fail(path, '需要非空文字');
    if (value.length > limit)
        return fail(path, '最多 ' + limit + ' 字符，当前 ' + value.length + '；只缩短这个字段');
    return value.trim();
}
function keys(value, allowed, path = 'document') {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        fail(path, '需要对象');
    const extra = Object.keys(value).filter(k => !allowed.includes(k));
    if (extra.length)
        fail(path, '未知字段：' + extra.join('、'));
}
// Decorative recommendation suffixes do not change the actual choice.
function optionIdentity(value) { return value.replace(/\s*(?:（推荐）|\(推荐\)|\(Recommended\))\s*$/i, '').trim(); }
export function resolutionDocument(base, input) {
    keys(input, ['requestId', 'answers']);
    if (input.requestId !== base.id)
        throw new Error('RESOLUTION_STALE: 回复不属于当前处理请求');
    if (!Array.isArray(input.answers) || input.answers.length !== base.questions.length)
        fail('answers', '需要完整回答 ' + base.questions.length + ' 个问题；修正单项请用 retry，不要漏答');
    const workflow = structuredClone(base.workflow), architecture = structuredClone(base.architecture);
    workflow.revision += 1;
    architecture.revision += 1;
    delete workflow.adoptedAt;
    const remaining = [], report = ['## AI 处理建议（采纳后才生效）'], seen = new Set();
    for (const [position, answer] of input.answers.entries()) {
        const path = 'answers[' + position + ']';
        keys(answer, ['index', 'status', 'decision', 'reason', 'sources', 'taskIds', 'verification', 'verifications', 'question', 'options', 'recommended'], path);
        if (!Number.isInteger(answer.index) || answer.index < 0 || answer.index >= base.questions.length || seen.has(answer.index))
            fail(path + '.index', '下标必须有效且不能重复');
        if (!Object.hasOwn(resolutionLabels, answer.status))
            fail(path + '.status', '需要 researched/default/deferred/ask/blocked');
        seen.add(answer.index);
        const original = base.questions[answer.index], decision = text(answer.decision, 700, path + '.decision'), reason = text(answer.reason, 700, path + '.reason');
        const sources = answer.sources ?? [];
        if (!Array.isArray(sources) || sources.length > 6)
            fail(path + '.sources', '最多 6 条来源');
        const evidence = sources.map((source, i) => { const p = path + '.sources[' + i + ']'; keys(source, ['locator', 'observation'], p); return { locator: text(source.locator, 300, p + '.locator'), observation: text(source.observation, 1000, p + '.observation') }; });
        if (answer.status === 'researched' && !evidence.length)
            fail(path + '.sources', '查证结果需要至少一条依据');
        if (answer.verifications !== undefined && !Array.isArray(answer.verifications))
            fail(path + '.verifications', '需要按任务列出验证条件数组');
        const taskIds = answer.taskIds ?? answer.verifications?.map((v) => v?.taskId) ?? [];
        if (!Array.isArray(taskIds) || taskIds.length > workflow.nodes.length || new Set(taskIds).size !== taskIds.length || taskIds.some((id) => !workflow.nodes.some((n) => n.id === id)))
            fail(path + '.taskIds', '只能指派现有任务且不能重复');
        if (answer.status === 'deferred' || answer.verification !== undefined || answer.verifications !== undefined) {
            if (!taskIds.length)
                fail(path + '.taskIds', '验证必须有负责的现有任务');
            let verifications;
            if (answer.verifications !== undefined) {
                if (answer.verification !== undefined)
                    fail(path + '.verification', '不能同时填写 verification 和 verifications');
                if (!Array.isArray(answer.verifications) || !answer.verifications.length || answer.verifications.length > workflow.nodes.length)
                    fail(path + '.verifications', '需要按任务列出验证条件');
                const assigned = new Set();
                verifications = answer.verifications.map((v, i) => { const p = path + '.verifications[' + i + ']'; keys(v, ['taskId', 'criterion'], p); if (!taskIds.includes(v.taskId) || assigned.has(v.taskId))
                    fail(p + '.taskId', '只能指派现有负责的任务，且不能重复'); assigned.add(v.taskId); return { taskId: v.taskId, criterion: text(v.criterion, 1000, p + '.criterion') }; });
            }
            else {
                if (taskIds.length !== 1)
                    fail(path + '.verification', '多个任务必须使用 verifications:[{taskId,criterion}] 分别写各自负责的验收，不能把整段测试重复压给每一步');
                verifications = [{ taskId: taskIds[0], criterion: text(answer.verification, 1000, path + '.verification') }];
            }
            for (const v of verifications) {
                for (const n of workflow.nodes)
                    if (n.id !== v.taskId && v.criterion.includes(n.id + ' 完成条件追加'))
                        fail(path + '.verifications', '验收条件指向另一任务 ' + n.id + '；请移到它的 taskId');
                const node = workflow.nodes.find((n) => n.id === v.taskId);
                node.acceptance.doneWhen = [...new Set([...node.acceptance.doneWhen, '开工前问题的后续验证：' + v.criterion])];
            }
        }
        if (answer.status === 'default' || answer.status === 'researched') {
            // Decisions must reach implementers, not just the plan's global notes.
            for (const node of workflow.nodes.filter((n) => !taskIds.length || taskIds.includes(n.id)))
                node.acceptance.doneWhen = [...new Set([...node.acceptance.doneWhen, '采纳的开工前处理方案：' + decision])];
        }
        if (answer.status === 'ask') {
            const question = text(answer.question, 500, path + '.question'), proposed = text(answer.recommended, 200, path + '.recommended');
            if (!Array.isArray(answer.options) || answer.options.length < 2 || answer.options.length > 3)
                fail(path + '.options', '需要 2..3 个文字选项');
            const options = answer.options.map((v, i) => text(v, 200, path + '.options[' + i + ']'));
            const identities = options.map(optionIdentity), matches = options.filter((v) => optionIdentity(v) === optionIdentity(proposed));
            if (new Set(identities).size !== options.length || identities.some((v) => !v))
                fail(path + '.options', '选项内容不能重复或为空');
            if (matches.length !== 1)
                fail(path + '.recommended', '必须对应一个现有选项；不会自动替用户选择');
            const recommended = matches[0];
            remaining.push('需要你决定：' + question + '（建议：' + recommended + '；可选：' + options.join(' / ') + '）');
        }
        else if (answer.status === 'blocked')
            remaining.push('暂时无法继续：' + original + '；' + reason);
        else if (answer.status === 'default' || answer.status === 'deferred')
            workflow.assumptions.push(resolutionLabels[answer.status] + '：' + decision + '；' + reason);
        const summary = resolutionLabels[answer.status] + '：' + decision + '；依据/取舍：' + reason;
        workflow.evidence.push({ inputId: 'preflight', locator: original.slice(0, 300), observation: summary });
        for (const source of evidence)
            workflow.evidence.push({ inputId: 'preflight-source', ...source });
        report.push('### ' + (answer.index + 1) + '. ' + original, summary, ...evidence.map((e) => '参考：' + e.locator + '；' + e.observation), ...(taskIds.length ? ['负责验证的任务：' + taskIds.join('、')] : []));
    }
    // Keep all remaining decisions in one place; both architecture and execution gates see them.
    if (base.gitAvailable === false)
        remaining.push('暂时无法继续：当前会话没有可读的 Git 仓库和冻结基线；必须先完成真实仓库准备，不能通过 AI 建议跳过。');
    architecture.openQuestions = remaining;
    workflow.openQuestions = remaining;
    return { requestId: base.requestId, architecture, workflow, mappings: base.mappings, explanation: report.join('\n\n') };
}
