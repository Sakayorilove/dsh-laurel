/**
 * 测试夹具：与 docs/dsh-loom/examples/module-parallel.workflow.json 同构的七节点图。
 * 前端 / 后端 / 作业三个模块在同一依赖层，可以并行。
 */

const brief = (locator, observation) => ({
  inputId: 'example-brief',
  locator,
  observation,
})

export function samplePlannerOutput() {
  return {
    schemaVersion: '0.1',
    workflowId: 'example-module-parallel',
    revision: 1,
    title: '示例：前端、后端、作业模块基于冻结接口并行交付',
    detectedStage: 'planning',
    evidence: [brief('示例需求：任务管理应用', '演示性输入，假定需求含前端、API 与异步作业；不是本机项目扫描证据。')],
    assumptions: ['示例目标仓库有 apps/web、apps/api、apps/worker、packages/contracts 及对应 pnpm 脚本。'],
    openQuestions: [],
    executionProposal: {
      runtime: 'wsl',
      maxConcurrency: 2,
      requiredBaseline: 'freeze-after-contract',
      requiredCapabilities: [
        'real-parent-agent',
        'parallel-agents',
        'worktree',
        'cancel-cleanup',
        'artifact-verification',
        'wsl-execution',
        'integration',
      ],
    },
    nodes: [
      {
        id: 'inspect',
        kind: 'inspect',
        title: '检查输入仓库与基线',
        phase: 'discovery',
        goal: '只读核实需求、目录、测试脚本、Git 状态和执行环境，标明未覆盖资料。',
        role: 'repository-inspector',
        sourceRefs: [brief('输入选择', '示例仓库结构必须由扫描验证。')],
        inputs: [],
        outputs: [{ name: 'repository', artifactType: 'repo-report', required: false }],
        ownership: { writes: [], forbiddenWrites: ['**'], sharedResources: [] },
        execution: { backend: 'deterministic', isolation: 'read-only', timeoutSeconds: 120, maxRepairAttempts: 0 },
        acceptance: {
          doneWhen: ['记录实际执行 OS、cwd、Git base 和未提交改动。', '确认示例路径与 pnpm 命令确实存在，不满足则阻塞。'],
          commands: [],
          independentVerification: true,
        },
      },
      {
        id: 'contract',
        kind: 'contract',
        title: '冻结 API、共享类型与 mock',
        phase: 'architecture',
        goal: '在专用准备工作区定义任务接口、作业事件和前端 mock，验证后产生共同 baseline。',
        role: 'contract-designer',
        sourceRefs: [brief('模块交互约定', '先定义任务字段、API 错误响应和作业事件。')],
        inputs: [{ name: 'repository', artifactType: 'repo-report', required: true }],
        outputs: [{ name: 'contract', artifactType: 'interface-contract', required: false }],
        ownership: {
          writes: ['packages/contracts/**', 'tests/contract/**'],
          forbiddenWrites: ['apps/**', 'pnpm-lock.yaml'],
          sharedResources: ['contract-types', 'repository-metadata'],
        },
        execution: { backend: 'configured-agent', isolation: 'prepared-baseline', timeoutSeconds: 1800, maxRepairAttempts: 1 },
        acceptance: {
          doneWhen: ['接口、共享类型和 mock 可检查，contractHash 和 baseSha 有实际对象来源。', '未提交到用户原工作区。'],
          commands: [{ argv: ['pnpm', '--filter', '@example/contracts', 'test'], cwdRef: 'prepared-baseline', expectedExitCode: 0 }],
          independentVerification: true,
        },
      },
      {
        id: 'frontend',
        kind: 'agent',
        title: '实现前端任务界面',
        phase: 'implementation',
        goal: '基于冻结 schema 和 mock 实现任务列表、编辑和错误状态。',
        role: 'frontend-developer',
        sourceRefs: [brief('前端模块', '用同版本 mock，避免等待后端才开始。')],
        inputs: [{ name: 'contract', artifactType: 'interface-contract', required: true }],
        outputs: [{ name: 'changes', artifactType: 'code-change', required: false }],
        ownership: {
          writes: ['apps/web/**'],
          forbiddenWrites: ['packages/contracts/**', 'apps/api/**', 'apps/worker/**', 'pnpm-lock.yaml'],
          sharedResources: [],
        },
        execution: { backend: 'configured-agent', isolation: 'worktree', timeoutSeconds: 3600, maxRepairAttempts: 1 },
        acceptance: {
          doneWhen: ['实际 diff 仅属于前端范围，共同 baseSha 和 contractHash 一致。', '加载、空状态、保存失败和重试有实际检查记录。'],
          commands: [{ argv: ['pnpm', '--filter', '@example/web', 'test'], cwdRef: 'node-worktree', expectedExitCode: 0 }],
          independentVerification: true,
        },
      },
      {
        id: 'backend',
        kind: 'agent',
        title: '实现任务 API',
        phase: 'implementation',
        goal: '遵守冻结 API 和错误协议实现任务存取，不修改接口定义。',
        role: 'backend-developer',
        sourceRefs: [brief('API 模块', 'API 和前端共享已冻结 schema。')],
        inputs: [{ name: 'contract', artifactType: 'interface-contract', required: true }],
        outputs: [{ name: 'changes', artifactType: 'code-change', required: false }],
        ownership: {
          writes: ['apps/api/**'],
          forbiddenWrites: ['packages/contracts/**', 'apps/web/**', 'apps/worker/**', 'pnpm-lock.yaml'],
          sharedResources: ['api-test-database'],
        },
        execution: { backend: 'configured-agent', isolation: 'worktree', timeoutSeconds: 3600, maxRepairAttempts: 1 },
        acceptance: {
          doneWhen: ['有效请求、无效参数和错误响应与合同一致。', '测试 DB 独立 namespace，实际 diff 不修改共享接口。'],
          commands: [{ argv: ['pnpm', '--filter', '@example/api', 'test'], cwdRef: 'node-worktree', expectedExitCode: 0 }],
          independentVerification: true,
        },
      },
      {
        id: 'worker',
        kind: 'agent',
        title: '实现异步作业模块',
        phase: 'implementation',
        goal: '按冻结事件协议处理任务，验证重复事件、失败与重试。',
        role: 'worker-developer',
        sourceRefs: [brief('作业模块', '作业模块可依合同单独开发，使用测试事件。')],
        inputs: [{ name: 'contract', artifactType: 'interface-contract', required: true }],
        outputs: [{ name: 'changes', artifactType: 'code-change', required: false }],
        ownership: {
          writes: ['apps/worker/**'],
          forbiddenWrites: ['packages/contracts/**', 'apps/web/**', 'apps/api/**', 'pnpm-lock.yaml'],
          sharedResources: ['worker-test-queue'],
        },
        execution: { backend: 'configured-agent', isolation: 'worktree', timeoutSeconds: 3600, maxRepairAttempts: 1 },
        acceptance: {
          doneWhen: ['按同版本事件协议处理并留下实际测试证据。', '重复事件不重复执行业务副作用，测试队列与其他任务隔离。'],
          commands: [{ argv: ['pnpm', '--filter', '@example/worker', 'test'], cwdRef: 'node-worktree', expectedExitCode: 0 }],
          independentVerification: true,
        },
      },
      {
        id: 'integrate',
        kind: 'integrate',
        title: '集成三个模块并联调',
        phase: 'integration',
        goal: '在专用集成工作树检查并应用验收后的三份提交，验证完整任务流。',
        role: 'integration-controller',
        sourceRefs: [brief('项目验收', '单模块通过还要验证 API、界面和事件组合。')],
        inputs: [
          { name: 'web', artifactType: 'code-change', required: true },
          { name: 'api', artifactType: 'code-change', required: true },
          { name: 'jobs', artifactType: 'code-change', required: true },
        ],
        outputs: [{ name: 'integrated', artifactType: 'project-commit', required: false }],
        ownership: {
          writes: ['apps/**', 'tests/integration/**', 'package.json', 'pnpm-lock.yaml'],
          forbiddenWrites: ['packages/contracts/**'],
          sharedResources: ['repository-metadata', 'integration-test-environment'],
        },
        execution: { backend: 'deterministic', isolation: 'integration-worktree', timeoutSeconds: 1800, maxRepairAttempts: 0 },
        acceptance: {
          doneWhen: ['三个实际提交及其模块验收证据已核对，按明确顺序集成。', '接口和端到端测试针对本次集成 sourceSha 通过。'],
          commands: [
            { argv: ['pnpm', 'typecheck'], cwdRef: 'integration-worktree', expectedExitCode: 0 },
            { argv: ['pnpm', 'test:integration'], cwdRef: 'integration-worktree', expectedExitCode: 0 },
          ],
          independentVerification: true,
        },
      },
      {
        id: 'report',
        kind: 'report',
        title: '生成可检查交付报告',
        phase: 'verification',
        goal: '把需求映射到真实任务、commit、文件和检查，列出未解决问题。',
        role: 'delivery-reporter',
        sourceRefs: [brief('交付说明', '交付需要可追踪产物和验证，不能只有一句完成。')],
        inputs: [{ name: 'integrated', artifactType: 'project-commit', required: true }],
        outputs: [{ name: 'report', artifactType: 'delivery-report', required: false }],
        ownership: { writes: [], forbiddenWrites: ['**'], sharedResources: [] },
        execution: { backend: 'deterministic', isolation: 'read-only', timeoutSeconds: 120, maxRepairAttempts: 0 },
        acceptance: {
          doneWhen: ['所有必需需求可定位到产物和当次验证证据。', '实测、预估和未验证内容分别说明。'],
          commands: [],
          independentVerification: true,
        },
      },
    ],
    edges: [
      { id: 'e-repo-contract', source: 'inspect', sourcePort: 'repository', target: 'contract', targetPort: 'repository', artifactType: 'repo-report', require: 'validated' },
      { id: 'e-contract-web', source: 'contract', sourcePort: 'contract', target: 'frontend', targetPort: 'contract', artifactType: 'interface-contract', require: 'validated' },
      { id: 'e-contract-api', source: 'contract', sourcePort: 'contract', target: 'backend', targetPort: 'contract', artifactType: 'interface-contract', require: 'validated' },
      { id: 'e-contract-worker', source: 'contract', sourcePort: 'contract', target: 'worker', targetPort: 'contract', artifactType: 'interface-contract', require: 'validated' },
      { id: 'e-web-integrate', source: 'frontend', sourcePort: 'changes', target: 'integrate', targetPort: 'web', artifactType: 'code-change', require: 'validated' },
      { id: 'e-api-integrate', source: 'backend', sourcePort: 'changes', target: 'integrate', targetPort: 'api', artifactType: 'code-change', require: 'validated' },
      { id: 'e-worker-integrate', source: 'worker', sourcePort: 'changes', target: 'integrate', targetPort: 'jobs', artifactType: 'code-change', require: 'validated' },
      { id: 'e-integrate-report', source: 'integrate', sourcePort: 'integrated', target: 'report', targetPort: 'integrated', artifactType: 'project-commit', require: 'validated' },
    ],
  }
}

export function sampleWorkflow() {
  const p = samplePlannerOutput()
  return {
    ...p,
    inputDigest: 'a'.repeat(64),
    compilerVersion: 'loom-compiler/0.1.0',
    adoptedAt: '2026-10-02T04:00:00.000Z',
  }
}

/** 深拷贝并改一处，用来构造反例。 */
export function mutate(value, patch) {
  const copy = structuredClone(value)
  patch(copy)
  return copy
}

/** 造一条「integrate → frontend」的回边，用来构造真实的环。 */
export function addCycle(d) {
  d.nodes[5].outputs.push({ name: 'handoff', artifactType: 'code-change', required: false })
  d.nodes[2].inputs.push({ name: 'handoff', artifactType: 'code-change', required: false })
  d.edges.push({
    id: 'e-integrate-front',
    source: 'integrate',
    sourcePort: 'handoff',
    target: 'frontend',
    targetPort: 'handoff',
    artifactType: 'code-change',
    require: 'validated',
  })
}

/**
 * 一份能通过初始规划校验的模型回复：架构 + 两个可执行任务 + 显式映射。
 * `request` 取 `/planning/export` 返回的 request（含 payloadHash / 期望 revision）。
 * 给「计划文件恢复」这类需要**真实候选**的用例用，省得每个用例手搓 schema。
 */
export function samplePlanningReply(request) {
  const all = samplePlannerOutput()
  const architecture = {
    schemaVersion: 1,
    architectureId: request.architectureId,
    revision: (request.expectedArchitectureRevision ?? 0) + 1,
    createdAt: '2026-10-06T00:00:00.000Z',
    constraints: [...request.constraints],
    edges: [],
    nodes: [
      { id: 'api', kind: 'service', title: 'API', responsibility: '后端服务', locked: true },
      { id: 'web', kind: 'module', title: 'Web', responsibility: '页面' },
    ],
  }
  const workflow = {
    ...all,
    workflowId: request.workflowId,
    revision: (request.expectedWorkflowRevision ?? 0) + 1,
    detectedStage: 'implementation',
    executionProposal: {
      ...all.executionProposal,
      maxConcurrency: request.maxConcurrency,
      requiredBaseline: 'selected-frozen-commit',
      requiredCapabilities: ['real-parent-agent', 'parallel-agents', 'worktree', 'cancel-cleanup', 'artifact-verification', 'wsl-execution'],
    },
    nodes: all.nodes.filter((n) => ['frontend', 'backend'].includes(n.id)).map((n) => ({ ...n, inputs: [] })),
    edges: [],
  }
  return {
    requestId: request.payloadHash,
    architecture,
    workflow,
    mappings: [
      { workflowNodeId: 'frontend', architectureNodeIds: ['web'] },
      { workflowNodeId: 'backend', architectureNodeIds: ['api'], decisionIds: [] },
    ],
    explanation: '依据真实用户输入拆分',
  }
}
