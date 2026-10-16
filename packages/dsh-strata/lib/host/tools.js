/**
 * dsh-strata · 宿主半边：模型侧工具
 *
 * ── 为什么不用 `defineTool` ────────────────────────────────────────────
 * `defineTool` 的职责只有一件事：把 schema DSL 编译成 JSON Schema，并校验
 * `timeoutMs`。读完它的实现（`dsh-tools/lib/index.js` 第 838-863 行）后，
 * 这里直接把**编译后的 JSON Schema** 交给 `ctx.tools.register()` ——
 * 那正是 `defineTool` 的返回值，也是官方 README 说的「wire-level 形式」。
 *
 * 换来的好处是：宿主半边**一个非内置 import 都没有**。
 * `@deepseek-ai/dsh-tools` 能不能被解析，取决于宿主的运行时解析机制
 * （`dsh-app-boot` 的 `runtime resolution`），那是宿主的实现细节，
 * 不是契约。少依赖一个，就少一种「插件装上但什么都不发生」的可能。
 */

import { KINDS, SCOPES, workspaceKey } from '../core/config.js'
import { canModify, checkVisibility, commitRecall, recall, renderInjection } from '../core/recall.js'
import { messageText, recallCombined } from '../core/history.js'
import { appendEvent, costLedger, discoverWorkspaces, readSessionLog } from '../core/store.js'
import { extractCandidates, estimateTokens, normalizeBody, stripHarnessPreamble, tokenize } from '../core/text.js'
import { SUMMARY_FRAME, foldEconomics } from '../core/pilot.js'
import { forgetVerified, listVerified, markVerified, verifiedStats } from '../core/verified.js'

/** 文本结果块。宿主 ContentBlock 的最简形态。 */
const text = (value) => [{ type: 'text', text: String(value) }]

/**
 * 组装一个工具定义。刻意保持形状与 `defineTool` 的产物一致：
 * `{ name, description, parameters, output: { schema, render }, execute }`。
 *
 * ── ⚠ 关于 `required` 的写法（踩过一次）────────────────────────────────
 * `defineTool` 收到的 `parameters` 是**作者 DSL**（`{ 属性名: { type, required: true } }`），
 * 它内部用 `parameterSchemaSpecToJsonSchema()` 编译成**标准 JSON Schema** 才交给注册表。
 * 编译规则（`dsh-tools/src/schema.ts` 第 449-458 行）是：
 *
 *     { type: 'object', properties: <编译后的属性表>, required: <字符串数组> }
 *
 * 也就是说 **`required` 是父级的字符串数组**，不是属性里的布尔值。
 * 这里既然直接把 JSON Schema 交给 `register()`，就必须用**数组**形式 ——
 * 写成 `required: true` 会被当成未知关键字丢掉，**必填校验静默失效**，
 * 不报任何错，只是模型漏传参数时不再被拦。
 *
 * `assertRequiredShape()` 就是为这个坑设的闸门，见下。
 */
function tool(spec) {
  if (!spec.name || !spec.description) throw new Error('工具必须有 name 与 description')
  const parameters = spec.parameters ?? { type: 'object', additionalProperties: false, properties: {} }
  const outputSchema = spec.output?.schema
    ?? { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] }
  assertRequiredShape(spec.name, parameters)
  assertRequiredShape(spec.name, outputSchema)
  return {
    name: spec.name,
    description: spec.description,
    parameters,
    output: {
      schema: outputSchema,
      render: (_args, value) => text(value?.text ?? ''),
    },
    async execute(args, exec) {
      const result = await spec.execute(args ?? {}, exec)
      // 工具一律返回 `{ text }`：既喂给模型，也是 CLI 下的可读输出。
      return typeof result === 'string' ? { text: result } : result
    },
  }
}

/**
 * 守住 `required` 的形状。
 *
 * 宿主支持的 JSON Schema 子集里（`dsh-tools/src/json-schema.ts` 的 `JsonSchemaNode`）
 * **只有 `required?: string[]` 这一种**，没有 `required: boolean`。
 * 但作者 DSL 用的是布尔值，写顺手了就会串。
 *
 * 写错的后果特别坏：**不报错、不告警，必填校验直接失效**。
 * 所以这里宁可在装载期抛，也不让它静默降级。
 *
 * @param {string} toolName 工具名，报错时指出来
 * @param {unknown} schema 待检查的 schema 节点
 */
function assertRequiredShape(toolName, schema) {
  if (schema == null || typeof schema !== 'object') return
  const node = /** @type {Record<string, unknown>} */ (schema)
  if ('required' in node && !Array.isArray(node.required)) {
    throw new Error(`工具 ${toolName}：required 必须是字符串数组（收到 ${JSON.stringify(node.required)}）。`
      + ' 这是 JSON Schema 的形状，不是作者 DSL —— 布尔值会被静默忽略，导致必填校验失效。')
  }
  if (Array.isArray(node.required)) {
    const props = node.properties
    if (props && typeof props === 'object') {
      for (const name of node.required) {
        if (!(name in props)) {
          throw new Error(`工具 ${toolName}：required 里的 "${name}" 没有出现在 properties 中。`)
        }
      }
    }
  }
  if (node.properties && typeof node.properties === 'object') {
    for (const [name, child] of Object.entries(node.properties)) {
      if (child && typeof child === 'object' && 'required' in child) {
        throw new Error(`工具 ${toolName}：属性 "${name}" 里写了 required —— `
          + 'required 属于父级数组，写在属性里无效。应写成 required: ["' + name + '"]。')
      }
      assertRequiredShape(toolName, child)
    }
  }
  if (Array.isArray(node.oneOf)) for (const branch of node.oneOf) assertRequiredShape(toolName, branch)
  if (node.items) assertRequiredShape(toolName, node.items)
}

/** 取当前会话上下文。拿不到 agent 就退化成「无工作区」而不是抛。 */
export function contextOf(exec, extra = {}) {
  const session = exec?.agent?.session ?? null
  const header = session?.header ?? null
  return {
    workspace: header?.cwd ?? extra.workspace ?? '',
    workspacePath: header?.cwd ?? extra.workspace ?? '',
    sessionId: session?.id ?? extra.sessionId ?? null,
    lineage: Array.isArray(header?.lineage) ? header.lineage : [],
    ...extra,
  }
}

/** 会话谱系：沿 parentSession 往上爬，最多 8 层。 */
export async function lineageOf(sessionQuery, sessionId, home, maxDepth = 8) {
  const chain = []
  let cursor = sessionId
  for (let depth = 0; depth < maxDepth && cursor; depth++) {
    let header = null
    try {
      if (sessionQuery && typeof sessionQuery.readSession === 'function') {
        const log = await sessionQuery.readSession(cursor)
        const events = Array.isArray(log) ? log : (log?.events ?? [])
        header = log?.session ?? events.find((e) => e?.type === 'session') ?? null
      }
    } catch { /* 落到下面 */ }
    if (!header) break
    if (header.parentSession) { chain.push(header.parentSession); cursor = header.parentSession }
    else break
  }
  return chain
}

/**
 * 构造全部工具。返回一个数组，交给 `ctx.tools.register()`。
 *
 * @param {{store, ledger, config: () => object, home, sessionQuery: () => any, log}} deps
 */
export function createTools(deps) {
  const { store, ledger, home, log } = deps
  const cfg = () => deps.config()

  return [
    /* ---------------------------------------------------------------- *
     * 召回
     * ---------------------------------------------------------------- */
    tool({
      name: 'memory_recall',
      description: [
        'Search long-term memory for facts, preferences, constraints and decisions recorded in past sessions.',
        'Use it when the user references earlier work, asks "do you remember", or when a decision made before',
        'would change what you do now. Results are scoped: this session, this workspace (default), and — only',
        'with an explicit grant — other workspaces. If a result you expect is missing, the answer may name the',
        'workspace that was skipped for lack of a grant.',
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'What to look for. Natural language or keywords; CJK and English both work.' },
          limit: { type: 'integer', description: 'Maximum results (default: the configured recallLimit).' },
          scope: { type: 'string', enum: ['auto', ...SCOPES], description: 'Narrow to one scope. `auto` (default) applies the configured ladder.' },
          workspace: { type: 'string', description: 'Narrow the search to this workspace, without changing the current session identity or granting access.' },
          include_foreign: { type: 'boolean', description: 'Include other workspaces that already have a grant. Uses the workspaces explicitly selected in settings by default.' },
        },
      },
      async execute(args, exec) {
        const config = cfg()
        const context = contextOf(exec)
        if (context.sessionId) context.lineage = await lineageOf(deps.sessionQuery(), context.sessionId, home)
        const result = await recallCombined(deps, {
          config: { ...config, recallLimit: Number.isFinite(args.limit) ? Math.max(0, Math.min(40, args.limit)) : config.recallLimit }, context,
          query: stripHarnessPreamble(args.query) || args.query,
          filters: { scope: args.scope, includeForeign: args.include_foreign, workspace: args.workspace },
          deadlineMs: 3000,
        })
        const hits = result.hits

        if (hits.length === 0) {
          const blocked = result.denied.filter((d) => String(d.reason).startsWith('cross-'))
          return {
            text: blocked.length > 0
              ? `No memory matched. ${blocked.reduce((s, d) => s + d.count, 0)} record(s) were skipped because this workspace has no cross-workspace grant: ${[...new Set(blocked.flatMap((d) => d.workspaces))].join(', ')}.`
              : 'No memory matched.',
          }
        }
        if (!commitRecall(hits, { store, ledger, context, config: cfg() })) return { text: 'Access changed before delivery. Please retry.' }
        const lines = hits.map((h, i) => {
          const where = h.record.scope === 'global' ? 'global' : (h.record.workspacePath || h.record.workspace)
          return `${i + 1}. [${h.record.origin === 'history' ? 'historical quotation' : h.record.kind} · ${h.record.scope} · ${where} · session=${h.record.sessionId ?? '-'} · id=${h.record.id} · seq=${h.record.seq ?? '-'}] ${h.record.body}`
        })
        return { text: `Found ${hits.length} record(s):\n${lines.join('\n')}` }
      },
    }),

    /* ---------------------------------------------------------------- *
     * 写入
     * ---------------------------------------------------------------- */
    tool({
      name: 'memory_remember',
      description: [
        'Store one durable fact, preference, constraint, decision or insight for future sessions.',
        'Store what will still matter next week, not what this turn already says. Do NOT store secrets,',
        'tokens, or anything the user marked private. Choose the narrowest scope that works:',
        '`session` (this conversation only), `workspace` (default, every session in this directory),',
        '`global` (every workspace — requires the plugin to allow global writes).',
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['body'],
        properties: {
          body: { type: 'string', description: 'The memory itself, one self-contained sentence.' },
          kind: { type: 'string', enum: KINDS, description: 'Defaults to `fact`.' },
          scope: { type: 'string', enum: SCOPES, description: 'Defaults to the configured defaultScope.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Free-form tags. Weighted heavily in recall.' },
          entities: { type: 'array', items: { type: 'string' }, description: 'People, projects, files, services this mentions. Weighted most heavily.' },
          salience: { type: 'number', description: '0..1 importance. Default 0.5.' },
          confidence: { type: 'number', description: '0..1 how sure you are. Default 0.6.' },
          quote: { type: 'string', description: 'The user wording this came from, for provenance.' },
        },
      },
      async execute(args, exec) {
        const config = cfg()
        const context = contextOf(exec)
        if (!context.workspace) return { text: 'Refused: current workspace is unknown.' }
        let scope = SCOPES.includes(args.scope) ? args.scope : config.defaultScope
        let downgraded = false
        if (scope === 'global' && !config.allowGlobalWrite) {
          scope = 'workspace'
          downgraded = true
        }
        const body = stripHarnessPreamble(String(args.body ?? ''))
        if (body.length === 0) return { text: 'Refused: empty body.' }
        const { record, created } = store.put({
          body,
          kind: args.kind,
          scope,
          workspace: context.workspace,
          workspacePath: context.workspacePath,
          sessionId: context.sessionId,
          lineage: context.lineage,
          tags: args.tags,
          entities: args.entities,
          salience: args.salience,
          confidence: args.confidence,
          quote: args.quote,
          origin: 'tool',
        })
        const evicted = store.evictIfNeeded(config.maxRecords, config.halfLifeDays)
        return {
          text: `${created ? 'Stored' : 'Refreshed'} memory ${record.id} at scope \`${record.scope}\`.`
            + `${downgraded ? ' (global writes are disabled, downgraded to workspace)' : ''}`
            + `${evicted > 0 ? ` Evicted ${evicted} weakest record(s).` : ''}`,
        }
      },
    }),

    /* ---------------------------------------------------------------- *
     * 遗忘
     * ---------------------------------------------------------------- */
    tool({
      name: 'memory_forget',
      description: [
        'Retire a memory so it stops being recalled. This SUPERSEDES rather than deletes:',
        'the record and its links stay on disk so the history remains auditable.',
        'Pass `id` for one record, or `query` to preview what would match.',
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'The memory id to retire.' },
          query: { type: 'string', description: 'Instead of an id, preview records matching this text (no change is made).' },
        },
      },
      async execute(args, exec) {
        if (args.id) {
          if (!canModify(store.get(args.id), contextOf(exec), cfg())) return { text: 'Refused: this memory is outside the writable scope.' }
          const ok = store.supersede(args.id, 'forgotten-by-tool')
          return { text: ok ? `Retired ${args.id}.` : `No memory with id ${args.id}.` }
        }
        if (args.query) {
          const config = cfg()
          const context = contextOf(exec)
          const result = recall({ store, ledger, config, context, query: args.query })
          if (result.hits.length === 0) return { text: 'Nothing matched; nothing changed.' }
          const visible = result.hits.filter((h) => canModify(h.record, context, config))
          const lines = visible.map((h) => `- ${h.record.id}  ${h.record.body}`)
          return { text: `Preview — ${result.hits.length} record(s) match. Re-run with \`id\` to retire one:\n${lines.join('\n')}` }
        }
        return { text: 'Pass either `id` or `query`.' }
      },
    }),

    /* ---------------------------------------------------------------- *
     * 关联
     * ---------------------------------------------------------------- */
    tool({
      name: 'memory_link',
      description: 'Relate two memories so recalling one surfaces the other. Links are bidirectional and drive the graph channel of recall.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'to'],
        properties: {
          from: { type: 'string', description: 'Memory id.' },
          to: { type: 'string', description: 'Memory id.' },
          weight: { type: 'number', description: '0..1 link strength. Default 0.5.' },
        },
      },
      async execute(args, exec) {
        if (![args.from, args.to].every((id) => canModify(store.get(id), contextOf(exec), cfg()))) return { text: 'Refused: both memories must be in the writable scope.' }
        const ok = store.link(args.from, args.to, Number.isFinite(args.weight) ? args.weight : 0.5)
        return { text: ok ? `Linked ${args.from} ↔ ${args.to}.` : 'Refused: one of the ids does not exist, or they are the same.' }
      },
    }),

    /* ---------------------------------------------------------------- *
     * 作用域与授权 —— 本插件的核心差异点
     * ---------------------------------------------------------------- */
    tool({
      name: 'memory_scope',
      description: 'Inspect reading and writing scope, list workspace grants, revoke a grant or promote an owned memory. Only the user settings menu can create grants; global promotion requires global writes to be enabled.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['status', 'revoke', 'workspaces', 'promote'], description: 'Defaults to `status`.' },
          id: { type: 'string', description: 'For `revoke`: the grant id. For `promote`: the memory id.' },
          scope: { type: 'string', enum: SCOPES, description: 'For `promote`: the target rung (must be higher than the current one).' },
        },
      },
      async execute(args, exec) {
        const action = args.action ?? 'status'
        const config = cfg()

        if (action === 'status') {
          const stats = store.stats()
          const lines = [
            `Scope ladder: session → workspace → global (new memories default to \`${config.defaultScope}\`).`,
            `Cross-workspace reads: ${config.crossWorkspace}. Global writes: ${config.allowGlobalWrite ? 'allowed' : 'disabled'}.`,
            `Memories: ${stats.live} live / ${stats.total} total, by scope ${JSON.stringify(stats.byScope)}.`,
            '',
            'Grants:',
          ]
          const active = ledger.active()
          if (active.length === 0) lines.push('- (none — every other workspace is unreadable until you grant it)')
          else for (const g of active) {
            const left = g.maxUses == null ? 'unlimited' : `${Math.max(0, g.maxUses - (g.uses ?? 0))} left`
            lines.push(`- ${g.id}  ${g.workspace}  [${g.duration}, ${left}, used ${g.uses ?? 0}]${g.note ? ` — ${g.note}` : ''}`)
          }
          const revoked = ledger.grants.filter((g) => g.revokedAt || !ledger.isActive(g))
          if (revoked.length > 0) lines.push(`(${revoked.length} expired/revoked grant(s) kept in the ledger for audit.)`)
          return { text: lines.join('\n') }
        }

        if (action === 'workspaces') {
          const list = discoverWorkspaces(home)
          if (list.length === 0) return { text: 'No workspaces found.' }
          const lines = list.map((w) => {
            const verdict = ledger.check(w.path)
            return `- ${w.path}  [${verdict.allowed ? `granted (${verdict.grant.id})` : `no grant (${verdict.reason})`}]  (${w.source})`
          })
          return { text: `${list.length} workspace(s):\n${lines.join('\n')}` }
        }

        if (action === 'grant') return { text: 'Refused: only the user can select workspaces in Settings → 记忆地层. This tool cannot create or widen grants.' }

        if (action === 'revoke') {
          if (!args.id) return { text: 'Refused: `id` is required for revoke.' }
          const ok = ledger.revoke(args.id)
          return { text: ok ? `Revoked ${args.id}.` : `No grant with id ${args.id}.` }
        }

        if (action === 'promote') {
          if (!args.id || !args.scope) return { text: 'Refused: `id` and `scope` are both required for promote.' }
          const record = store.get(args.id)
          if (!record || !canModify(record, contextOf(exec), config)) return { text: 'Refused: memory is outside the writable scope.' }
          if (args.scope === 'global' && !config.allowGlobalWrite) return { text: 'Refused: global writes are disabled in settings.' }
          const ok = store.promote(args.id, args.scope)
          return {
            text: ok
              ? `Promoted ${args.id}: ${record.scope} → ${args.scope}.`
              : `Refused: ${args.scope} is not higher than the current scope (${record.scope}). The ladder only climbs.`,
          }
        }

        return { text: `Unknown action "${action}".` }
      },
    }),

    /* ---------------------------------------------------------------- *
     * 已核实台账（借自 ACP 的 verifiedReadings）
     *
     * 治的是实测出来的这块浪费：那次 286 步会话里，工具调用参数占总消耗
     * 25.9%，其中 40% 的 write 参数是**整文件重写已经写过的文件**，另有
     * 30 次 read。重读/重写的内容会永久留在上下文里，之后每一步重发一次。
     * 台账把"我读过并核实过哪些文件、文件还没被改过"记下来，跨回合甚至
     * 跨会话可用，省掉重读。
     *
     * ⚠ 台账只记录，不代替判断：文件 mtime/size 一变就自动不算数。
     * ---------------------------------------------------------------- */
    tool({
      name: 'memory_verified',
      description: [
        'Ledger of files this workspace has already read and verified (with mtime+size, so an edited file',
        'automatically stops counting). Record a file after you have genuinely read and confirmed it, then',
        'check the list before re-reading: a listed file has not changed since it was verified.',
        '`mark` records, `list` shows only entries whose file is unchanged, `forget` removes one.',
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['mark', 'list', 'forget'], description: 'What to do. Defaults to `list`.' },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Absolute file paths. Required for `mark` and `forget`; ignored for `list`.',
          },
        },
      },
      async execute(args, exec) {
        const config = cfg()
        const context = contextOf(exec)
        if (config.verifiedLedger === false) {
          return { text: '已核实台账已关闭（设置里 verifiedLedger=false）。' }
        }
        const action = typeof args.action === 'string' ? args.action : 'list'
        const paths = Array.isArray(args.paths) ? args.paths.filter((p) => typeof p === 'string' && p.trim().length > 0) : []

        if (action === 'mark') {
          if (paths.length === 0) return { text: 'mark 需要给出 paths。' }
          const ok = []
          const failed = []
          for (const p of paths) {
            const result = markVerified(home, context.workspace, p)
            if (result.ok) ok.push(result.path)
            else failed.push(`${p}（${result.reason ?? 'unknown'}）`)
          }
          const live = listVerified(home, context.workspace)
          if (ok.length > 0) {
            appendEvent({ kind: 'verified', workspace: context.workspace, sessionId: context.sessionId, count: ok.length, detail: `marked=${ok.length}; failed=${failed.length}` }, home)
          }
          return {
            text: [
              `已核实并记账：${ok.length} 个${ok.length > 0 ? ` — ${ok.join(', ')}` : ''}`,
              failed.length > 0 ? `未能记账：${failed.join(', ')}` : null,
              `本工作区当前有效条目：${live.length} 个。改动过的文件会自动失效，不必手动清。`,
            ].filter(Boolean).join('\n'),
          }
        }

        if (action === 'forget') {
          if (paths.length === 0) return { text: 'forget 需要给出 paths。' }
          const removed = paths.filter((p) => forgetVerified(home, context.workspace, p))
          const live = listVerified(home, context.workspace)
          return { text: `已移除 ${removed.length} 条；本工作区剩余有效条目 ${live.length} 个。` }
        }

        const stats = verifiedStats(home, context.workspace)
        const live = listVerified(home, context.workspace)
        if (live.length === 0) {
          return {
            text: [
              '本工作区还没有有效的已核实条目。',
              stats.recorded > 0 ? `（记过 ${stats.recorded} 条，但文件已改动或过期，全部失效。）` : '',
              '读到确实核实过的文件后，用 memory_verified(action="mark", paths=[...]) 记下来，下一轮就不必重读。',
            ].filter(Boolean).join('\n'),
          }
        }
        return {
          text: [
            SUMMARY_FRAME,
            `本工作区已核实且**文件未改动**：${live.length} 个`,
            ...live.slice(0, 40).map((e) => `  ${e.path}`),
            live.length > 40 ? `  …还有 ${live.length - 40} 个` : null,
            '这些可以不重读；要用内容时按需取用即可。文件一改就自动失效，不必手动维护。',
          ].filter(Boolean).join('\n'),
        }
      },
    }),

    /* ---------------------------------------------------------------- *
     * 统计
     * ---------------------------------------------------------------- */
    tool({
      name: 'memory_stats',
      description: 'Report memory counts, scope distribution, kinds, per-workspace totals, and the storage path. Read-only.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      async execute(_args, exec) {
        const stats = store.stats()
        const config = cfg()
        const cost = costLedger(home)
        const context = contextOf(exec)
        // 会话级缓存/用量体检：数字全部来自宿主 `llm/stream` 上报的 usage。
        // 拿不到就一路 `-`，**绝不用本插件自己的估算冒充宿主账本**。
        const sample = typeof deps.cacheSample === 'function' ? deps.cacheSample(context.sessionId) : null
        const fold = foldEconomics({
          usedTokens: sample?.total,
          cacheReadTokens: sample?.read,
          cacheWriteTokens: sample?.write,
          freshInputTokens: sample?.fresh,
          injectedChars: cost.resident?.chars,
        })
        const verified = verifiedStats(home, context.workspace)
        return {
          text: [
            `${stats.live} live / ${stats.total} total (${stats.superseded} superseded), ${stats.links} link(s).`,
            `By scope: ${JSON.stringify(stats.byScope)}`,
            `By kind:  ${JSON.stringify(stats.byKind)}`,
            `By workspace:`,
            ...Object.entries(stats.byWorkspace).map(([ws, n]) => `  - ${ws}: ${n}`),
            `Storage: ${stats.path} (${stats.logLines} log line(s))`,
            `Recall: limit=${config.recallLimit} minScore=${config.minScore} hops=${config.associationHops} halfLife=${config.halfLifeDays}d`,
            // 手册 §7.5 差异化 #1：能自证花销。诚实标注单位 —— 宿主没有计价服务。
            'Own cost (chars exact; tokens are this plugin\'s own estimate — the host exposes no price service):',
            `  resident block: ${cost.resident ? `${cost.resident.chars} chars / ${cost.resident.tokens ?? 'not recorded'} tok, ${cost.resident.hits} hit(s), mode=${cost.resident.mode} — re-sent on EVERY turn` : 'nothing injected yet'}`,
            `  inject writes : ${cost.total.blocks} block(s), ${cost.total.chars} chars / ${cost.total.tokens} tok cumulative${cost.total.tokenless ? ` (${cost.total.tokenless} predate token accounting)` : ''} — this counts the same resident block again on each replacement, so it is NOT a bill`,
            `  handoffs      : ${cost.total.stored} stored, ${cost.total.bodyChars} chars kept from ${cost.total.materialChars} chars of material`,
            `  model calls   : ${cost.total.paidCalls} call(s), in ${cost.total.paidIn} / out ${cost.total.paidOut} tokens, ${cost.total.paidKept} kept${cost.paidEver ? '' : ' — the paid tier has never been used'}`,
            `  window        : last 24h ${cost.last24h.blocks} inject / ${cost.last24h.paidCalls} call; log covers ${cost.events} event(s)${cost.truncated ? ' (older ones truncated)' : ''} since ${cost.since ?? '—'}`,
            // ── 上下文领航（借自 ACP / acp-kernel）─────────────────────────
            // 宿主只负责"别把窗口撑爆"（本机 1M 窗口要 80 万才动手，实测长会话
            // 最高 42 万 ⇒ 从不触发）。这几行报告我们自己那套"增长式提醒"的状态。
            'Context pilot (host compacts only near 80% of the window; this half is ours):',
            `  nudge         : ${config.contextNudge === false ? 'off' : `on — fires once per turn after +${config.contextNudgeGrowthTokens} tok of growth, above ${config.contextNudgeMinTokens} tok`}`,
            `  context now   : ${fold.usedTokens == null ? 'host did not report this session yet' : `${fold.usedTokens} tok (cacheRead ${fold.cacheReadTokens ?? '-'} / cacheWrite ${fold.cacheWriteTokens ?? '-'} / fresh ${fold.freshInputTokens ?? '-'}, hit ${fold.hitRate == null ? '-' : `${(fold.hitRate * 100).toFixed(1)}%`})`}`,
            `  cache health  : ${fold.note}`,
            `  verified files: ${verified.live} live / ${verified.recorded} recorded (${verified.stale} auto-invalidated by edits) — memory_verified lists them`,
            '  barriers      : policy file (AGENTS.md…) / skill catalog / latest user message are never eligible for compression — the host re-injects them at once, so squeezing them costs a cache rebuild for nothing',
          ].join('\n'),
        }
      },
    }),

    /* ---------------------------------------------------------------- *
     * 回填
     * ---------------------------------------------------------------- */
    tool({
      name: 'memory_backfill',
      description: [
        'Mine past sessions for memories. Pass `apply: false` (default) for a dry run that reports what would be',
        'stored. Backfill reads session logs through the host session service, falling back to reading the',
        'on-disk session files directly. It only extracts durable-looking statements; expect few results,',
        'and expect to add the important ones by hand with memory_remember.',
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessions: { type: 'integer', description: 'How many recent sessions to scan. Defaults to the configured backfillSessions.' },
          workspace: { type: 'string', description: 'Limit to one workspace path. Defaults to the current one.' },
          apply: { type: 'boolean', description: 'Actually store what is found. Default false (dry run).' },
        },
      },
      async execute(args, exec) {
        const config = cfg()
        const context = contextOf(exec)
        const limit = Number.isFinite(args.sessions) ? Math.max(1, Math.min(500, args.sessions)) : config.backfillSessions
        const targetWorkspace = args.workspace ?? context.workspace
        if (!context.workspace || workspaceKey(targetWorkspace) !== workspaceKey(context.workspace)) return { text: 'Refused: backfill only reads and writes the current workspace.' }
        if (config.defaultScope === 'global' && !config.allowGlobalWrite) return { text: 'Refused: global writes are disabled.' }
        const found = await collectBackfillCandidates(deps, { limit, workspace: targetWorkspace, config, context })
        if (found.length === 0) return { text: `Scanned ${limit} session(s) in ${targetWorkspace || '(all)'} — nothing durable-looking found.` }

        if (!args.apply) {
          const lines = found.slice(0, 30).map((c) => `- [${c.kind}] ${c.body}`)
          return {
            text: `Dry run — ${found.length} candidate(s) from ${limit} session(s). Re-run with \`apply: true\` to store them:\n${lines.join('\n')}`
              + (found.length > 30 ? `\n… and ${found.length - 30} more.` : ''),
          }
        }
        let stored = 0
        for (const candidate of found) {
          try {
            const { created } = store.put({ ...candidate, origin: 'backfill' })
            if (created) stored++
          } catch { /* 单条失败不影响其余 */ }
        }
        return { text: `Stored ${stored} new memory(ies) from ${found.length} candidate(s).` }
      },
    }),

    /* ---------------------------------------------------------------- *
     * 交接 —— 手册 §7.3：免费档（默认，零模型调用）＋付费档（显式要才摘要一次）
     * ---------------------------------------------------------------- */
    tool({
      name: 'memory_handoff',
      description: [
        'Compress THIS session into one workspace memory, so the next session can start fresh instead of',
        'carrying the whole transcript. By default it is purely local and costs nothing: it keeps your conclusions',
        'plus the most recent transcript lines verbatim, replaces the middle with a pointer to memory_recall, and',
        'refuses to store anything that is not shorter than the material it replaces. Call it when a topic is',
        'finished, right before suggesting a new session. Only pass `summarize: true` when the user explicitly',
        'asks for a real written summary — that spends exactly one model call.',
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['topic'],
        properties: {
          topic: { type: 'string', description: 'Short title for this handoff; also the recall query written into the pointer.' },
          notes: { type: 'string', description: 'Conclusions / decisions / open todos, one per line, most important first. Kept verbatim.' },
          recent: { type: 'integer', description: 'How many most-recent transcript lines to keep verbatim. Default 3, max 8.' },
          max_chars: { type: 'integer', description: 'Hard budget for the stored body. Default 1200, max 2000.' },
          summarize: { type: 'boolean', description: 'Default false — the free local compression needs no model call, and measured data shows the paid tier is almost never worth its tokens. True spends exactly ONE model call (on this session route) to write a real summary, and it is kept only when it saves at least 30% of the material. Skipped with no money spent when the session material is under 12000 chars, or when the summary does not fit max_chars. The token spend is reported and logged either way.' },
        },
      },
      async execute(args, exec) {
        const config = cfg()
        const context = contextOf(exec)
        if (!context.workspace) return { text: 'Refused: current workspace is unknown.' }
        const topic = stripHarnessPreamble(String(args.topic ?? '')).replace(/\s+/g, ' ').trim().slice(0, 60)
        if (topic.length === 0) return { text: 'Refused: `topic` is required — it becomes the recall query in the pointer.' }
        const sessionMaterial = await currentSessionMaterial(deps, { context, config })
        const shape = {
          topic,
          lines: sessionMaterial.lines,
          transcriptChars: sessionMaterial.transcriptChars,
          transcriptLines: sessionMaterial.transcriptLines,
          recent: args.recent,
          maxChars: args.max_chars,
          sessionId: context.sessionId,
        }
        // 免费档：程序动手，零模型调用。这是默认，也是付费档失败时的退路。
        const free = buildHandoff({ ...shape, notes: String(args.notes ?? '').split('\n') })
        let plan = free
        // 付费档（手册 §7.3）：只有显式要才花这一次钱，且**只在比原文短时才落地**（判据见下）。
        // 没有任何材料时连这一次都不花 —— 白花一次模型调用是最坏的结果。
        // 预检（2026-10-07 用户实测抓到）：素材小到家注摘要**不可能**比原文短时，
        // 这次调用注定白花 —— 那就在拨号之前拒掉，而不是花完再靠净收益守卫丢。
        const tooSmall = args.summarize === true && free.materialChars < HANDOFF_PAID_MIN_MATERIAL_CHARS
        const paid = args.summarize === true && !tooSmall && free.material.trim().length > 0
          ? await summarizeWithModel(deps, exec, { topic, material: free.material })
          : null
        let paidNote = ''
        if (tooSmall) {
          paidNote = ` model call NOT made: the material is only ${free.materialChars} chars, under the ${HANDOFF_PAID_MIN_MATERIAL_CHARS}-char floor`
            + ' — a summary could not come out shorter than that, so the call would have been pure waste. The free local compression is used instead.'
        } else if (paid) {
          const usage = paid.usage
          const spent = ` model call: in=${usage?.inputTokens ?? '-'} out=${usage?.outputTokens ?? '-'} total=${usage?.totalTokens ?? '-'}`
          if (paid.text) {
            const candidate = buildHandoff({ ...shape, notes: paid.text.split('\n') })
            // 判据是手册 §7.3 的原话：**比原文短**才落地（`shorter` 就是 body < materialChars），
            // 不是"比免费档短"——用户显式要的是模型写的那份摘要，因为它多花 5% 的体积
            // 就丢掉，等于把钱花了又把东西扔了。但**没变小要如实说出来**。
            // 2026-10-07 评审加固：光"比原文短"不够 —— "短 1 个字符"也是短，实测那次花
            // 8,468 token 只换来 5% 缩水。付费档唯一正当理由是"花一次换回大段体积"，
            // 所以再加一道 `PAID_MIN_SHRINK_RATIO`：达不到就退回免费档，并把实情说出来。
            const shrunkWell = candidate.materialChars > 0
              && candidate.bodyChars <= candidate.materialChars * PAID_MIN_SHRINK_RATIO
            const unusable = candidate.overBudget
              ? (candidate.headsAllOversized
                ? 'every summary line is longer than the whole budget'
                : `does not fit ${candidate.maxChars} chars`)
              : candidate.shorter ? null : 'not shorter than the material'
            if (!unusable && shrunkWell) {
              plan = candidate
              paidNote = `${spent} → summary kept (free ${free.bodyChars} → paid ${candidate.bodyChars} chars,`
                + ` ${Math.round((1 - candidate.bodyChars / candidate.materialChars) * 100)}% smaller than the material).`
                + (candidate.bodyChars >= free.bodyChars
                  ? ' Note: the paid summary is NOT smaller than the free local one — the tokens bought coverage, not size.'
                  : '')
            } else {
              const reason = unusable ?? `only ${Math.round((1 - candidate.bodyChars / candidate.materialChars) * 100)}% smaller than the material`
                + ` — the paid tier must save at least ${Math.round((1 - PAID_MIN_SHRINK_RATIO) * 100)}% to be worth its tokens`
              paidNote = `${spent} → summary DISCARDED (${reason}); the free version is stored instead.`
            }
          } else {
            paidNote = `${spent} → ${paid.skipped ?? 'no text returned'}; fell back to the free local compression.`
          }
        }
        // 花了钱又没落地也必须留痕 —— 「花掉的钱要能看见」是手册 §7.4 的硬要求。
        if (paid) {
          appendEvent({
            kind: 'handoff', workspace: context.workspace, sessionId: context.sessionId, count: 0,
            detail: `summarize=1 in=${paid.usage?.inputTokens ?? '-'} out=${paid.usage?.outputTokens ?? '-'} finish=${paid.finish ?? '-'} kept=${plan === free ? 0 : 1} skipped=${paid.skipped ?? '-'}`,
          }, home)
        }
        // `overBudget` 现在同时覆盖两种"装不下"：① 单条结论就超过整个预算；② 全部结论
        // 都是超长单行被 oversized 滤掉。两者都必须**说清原因**，不能只说"nothing fits"。
        if (plan.overBudget) {
          const why = plan.headsAllOversized
            ? ' every `notes` line is longer than the whole budget — shorten the conclusions'
            : ' shorten `notes` or raise `max_chars`'
          return { text: `Refused: nothing fits in ${plan.maxChars} chars —${why}.${paidNote}` }
        }
        if (!plan.shorter) {
          return {
            text: `Not stored: no net gain (material ${plan.materialChars} chars → handoff ${plan.bodyChars} chars).`
              + ' Nothing was written. Use `memory_remember` for a single fact instead.'
              + (paidNote || ' No model call was made.'),
          }
        }
        let record
        try {
          record = store.put({
            body: plan.body,
            kind: 'decision',
            scope: 'workspace',
            workspace: context.workspace,
            workspacePath: context.workspacePath,
            sessionId: context.sessionId,
            lineage: context.lineage,
            // `topic` 是**权威字段**（`latestHandoff` 优先读它）；tags 里的第二项只为
            // 兼容老记录与人工检索保留。之前只靠 tags 反解，topic 恰为 'handoff' 时索引行会静默消失。
            topic,
            tags: ['handoff', topic],
            salience: 0.8,
            confidence: 0.7,
            quote: plan.material.slice(0, 400),
            origin: 'handoff',
          }).record
          store.evictIfNeeded(config.maxRecords, config.halfLifeDays)
        } catch (error) {
          // 工具结果里说清原因（磁盘满、工作区键为空…），但**不抛**（C3）。
          return { text: `Refused: the handoff could not be stored (${error?.message ?? error}).` }
        }
        appendEvent({
          kind: 'handoff', workspace: context.workspace, sessionId: context.sessionId, count: plan.kept,
          detail: `material=${plan.materialChars} body=${plan.bodyChars} omitted=${plan.omitted} id=${record.id} summarize=${paid ? 1 : 0}`,
        }, home)
        return {
          text: [
            `Handoff stored as ${record.id} (workspace, ${plan.bodyChars}/${plan.maxChars} chars).`,
            // 逐条降级牺牲掉了一些结论时必须说出口 —— 静默丢输入是 P0-4 明令禁止的。
            ...(plan.headsTotal > plan.headsKept
              ? [`WARNING: ${plan.headsTotal - plan.headsKept} of ${plan.headsTotal} \`notes\` line(s) did not fit in ${plan.maxChars} chars`
                + ` and were dropped (the most important ones are kept first) — raise \`max_chars\` or shorten them if they matter.`]
              : []),
            `Material ${plan.materialChars} → ${plan.bodyChars} chars; ${plan.kept} recent line(s) kept verbatim,`
              + ` ${plan.omitted} replaced by a recall pointer.${paidNote || ' No model call was made.'}`,
            `Next session: start fresh, then memory_recall("${topic}").`,
            '',
            plan.body,
          ].join('\n'),
        }
      },
    }),
  ]
}

/**
 * 交接正文的默认硬帽。`store.put` 自己截到 2000 字符，这里更早收口，
 * 为的是让「装不下」表现为**整条不收录**而不是 slice（与 P0-4「禁止静默截断」同一条纪律）。
 */
const HANDOFF_MAX_CHARS = 1200

/**
 * 把本次会话压成一条交接正文 —— 手册 §7.3 的**免费档**：全程程序动手，零模型调用。
 *
 * 形状就是 §7.3 那句话：留最近原文、中间的直接砍掉、只留一条「去档案柜查」的指路条。
 * 另外带 §7.5 的**净收益守卫**：`shorter` 为假就不许落地（调用方负责拒写）。
 *
 * 预算不够时**从最旧的原文开始整条挪进「未收录」**，绝不 slice 任何一行。
 *
 * @param {{topic: string, notes?: string[], lines?: string[], transcriptChars?: number|null, recent?: number, maxChars?: number, sessionId?: string|null}} input
 *   `lines` 是会话原文，**旧 → 新**顺序。
 *   `transcriptChars` / `transcriptLines` 是本次会话**白名单原文的总字符数与总行数**（含没进 `lines` 的那些）——
 *   净收益要跟"否则会被一轮轮重读的东西"比，不是跟"正好装得进正文的那几行"比；
 *   指路条报的条数也要按总量算，否则那条数字是假的。
 * @returns {{body: string, material: string, materialChars: number, bodyChars: number, kept: number, headsKept: number, headsTotal: number, headsAllOversized: boolean, omitted: number, maxChars: number, overBudget: boolean, shorter: boolean}}
 */
export function buildHandoff({ topic, notes = [], lines = [], transcriptChars = null, transcriptLines = null, recent = 3, maxChars = HANDOFF_MAX_CHARS, sessionId = null }) {
  const cap = Number.isFinite(maxChars) ? Math.min(2000, Math.max(200, Math.round(maxChars))) : HANDOFF_MAX_CHARS
  const keepRecent = Number.isFinite(recent) ? Math.min(8, Math.max(0, Math.round(recent))) : 3

  const clean = (list) => {
    const out = []
    const seen = new Set()
    for (const raw of list) {
      const line = stripHarnessPreamble(String(raw ?? '')).replace(/\s+/g, ' ').trim()
      if (line.length === 0) continue
      const key = normalizeBody(line)
      if (key.length === 0 || seen.has(key)) continue
      seen.add(key)
      out.push(line)
    }
    return out
  }
  const heads = clean(notes)
  const tails = clean(lines)
  const material = [...heads, ...tails].join('\n')
  // 净收益的分母：模型给的结论 + 本次会话读到的全部白名单原文。
  const readChars = Number.isFinite(transcriptChars) ? Math.max(0, Math.round(transcriptChars)) : tails.join('\n').length
  const materialChars = heads.join('\n').length + readChars
  // 真实会话号常是 `session-<8 位>-…` 形状，直接 slice(0,8) 只会得到没用的 `session-`。
  const sid = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId.replace(/^session-/, '').slice(0, 8) : null
  // 被「只取末尾 40 行」窗口挡在外面的那些行，也要算进指路条的条数里，否则那条数字是假的。
  const windowed = Math.max(0, (Number.isFinite(transcriptLines) ? transcriptLines : lines.length) - lines.length)

  // 单行就超过整块预算的，直接算「未收录」——指路条会把它们指向 memory_recall。
  const fits = (list) => list.filter((line) => line.length <= cap)
  const oversized = (heads.length - fits(heads).length) + (tails.length - fits(tails).length)
  const allHeads = fits(heads)
  const tailRows = fits(tails)
  // 给了结论，但**每一条**都被「单行超预算」滤掉 —— 这是"把摘要写短"能修的问题，
  // 跟"逐条丢光仍装不下"（该抬高 max_chars）不是一回事，调用方要分得清。
  const headsAllOversized = heads.length > 0 && allHeads.length === 0

  // 结论行（heads）原先**全有或全无**：整段超预算就整条拒绝，不像原文那样逐条降级。
  // 2026-10-07 评审改成：从**最后一条**（notes 要求"最重要在前"）开始丢，直到装得下。
  // 这样"最重要的结论"仍然进正文，只有最不重要的那几条被牺牲 —— 比一条都不留好。
  // `headsKept` 如实报"实际进了几条"，调用方据此决定要不要告警。
  const MAX_LOOP = allHeads.length + tailRows.length + 2
  let headsDropped = 0
  for (let guard = 0; guard <= MAX_LOOP; guard++) {
    const headRows = allHeads.slice(0, allHeads.length - headsDropped)
    for (let keep = Math.min(tailRows.length, keepRecent); ; keep--) {
      const omitted = tailRows.length - keep + oversized + headsDropped + windowed
      const rows = [`交接 · ${topic}${sid ? ` · ${sid}` : ''}`, ...headRows.map((line) => `- ${line}`)]
      if (omitted > 0) rows.push(`（中间 ${omitted} 条原文未收录 · 需要细节时 memory_recall("${topic}")）`)
      rows.push(...tailRows.slice(tailRows.length - keep).map((line) => `- ${line}`))
      const body = rows.join('\n')
      // 预算内 + **至少留下一条结论**才算成功。
      // 只剩原文没有结论的"交接"比不存更坏：模型会以为已经交接完毕，而最重要的部分其实丢了。
      // 所以 heads 全部被 oversized 滤掉（或逐条丢光）时不许从这里返回，要掉到下面按 overBudget 拒绝。
      if (body.length <= cap && (heads.length === 0 || headRows.length > 0)) {
        return {
          body,
          material,
          materialChars,
          bodyChars: body.length,
          kept: keep,
          // 结论行真的进了正文几条。0 就说明「最重要的那部分被整条丢掉了」——
          // 这时候报「已采用」是假的（mutation O1 抓到的就是这个）。
          headsKept: headRows.length,
          // 调用方清点输入给了几条结论：headsKept < headsTotal 就是「逐条降级牺牲了几条」，必须说出来。
          headsTotal: heads.length,
          headsAllOversized,
          omitted,
          maxChars: cap,
          overBudget: false,
          shorter: body.length < materialChars,
        }
      }
      if (keep === 0) break
    }
    // 原文已砍到 0、仍装不下 ⇒ 再丢一条结论（从最后一条开始），重试。
    if (headsDropped >= allHeads.length) break
    headsDropped++
  }
  // 连一条结论都放不下 ⇒ 太长的单行/太小预算，按 overBudget 拒绝（调用方会说出来）。
  return {
    body: '',
    material,
    materialChars,
    bodyChars: 0,
    kept: 0,
    headsKept: 0,
    headsTotal: heads.length,
    headsAllOversized,
    omitted: tailRows.length + oversized + allHeads.length + windowed,
    maxChars: cap,
    overBudget: true,
    shorter: false,
  }
}

/** 付费档摘要的输入上限。超了只取末尾 —— 绝不为了摘要把整段会话再发一遍。 */
const SUMMARY_INPUT_MAX_CHARS = 24000
/** 付费档的超时。到点就中止，退回免费档，绝不把工具挂住。 */
const SUMMARY_TIMEOUT_MS = 60000
/** 摘要的输出上限。交接正文本身最多 2000 字符，给 1200 token 已经很宽。 */
const SUMMARY_MAX_TOKENS = 1200

/**
 * 付费档的**最低素材量**：低于这个字符数就不许发起模型调用。
 *
 * 为什么要有这道闸（2026-10-07 用户实测抓到）：在一次只有 308 字符素材的会话上跑
 * `summarize:true`，模型回了 357 字符 —— **比原文还长，必然被净收益守卫丢掉**，
 * 于是 638 token 白花，什么都没存下。摘要落地的前提是「比原文短」，而模型写一份
 * 交接备忘通常要 300–800 字符，素材太小时这个前提**在拨号之前就不可能成立**。
 *
 * 值是**判断值不是实测值**，按 2026-10-07 的独立评审上调到 12000：
 *   - 原值 4000 只挡得住"必然更长"的那一档；夹具实测在 8421 token 输入上，
 *     摘要只把正文从 616 压到 584（省 32 字符 / 5%）—— 那已经在亏了，却没被 4000 挡住。
 *   - 现在配合下面 `PAID_MIN_SHRINK_RATIO`（必须真省下 30%）一起用：小素材直接被闸门挡，
 *     大素材还要过"缩水率"这道关，两道一起才真正止血。
 */
const HANDOFF_PAID_MIN_MATERIAL_CHARS = 12000

/**
 * 付费摘要必须把正文压到原文的多少比例以下才许落地（0.7 = 至少省 30%）。
 *
 * 这是 2026-10-07 评审逼出来的第二道闸：净收益守卫只管"比原文短"，而"短 1 个字符"
 * 也算短 —— 实测那次花 8,468 token 只换来 5% 的缩水。付费档的**唯一**正当理由是
 * 「花一次钱换回大段体积」，所以要求它至少省 30%：达不到就照实说、退回免费档，
 * 钱已经花了但**不再自我欺骗**说它划算。
 */
const PAID_MIN_SHRINK_RATIO = 0.7

/**
 * 通过宿主的 `ctx.llm` 做**一次**前台摘要 —— 手册 §7.3 的「付费档」。
 *
 * 契约是逐字读过 0.2.0-rc.2 的声明文件的（`@deepseek-ai/dsh-llm/lib/types/*`）：
 *   `llm.stream({ provider, model, system?, messages, maxTokens?, temperature?, signal?, sessionId?, purpose? })`
 *   → `AsyncIterable<StreamChunk>`；`text-delta` 带 `.text`，`usage` 带 `.usage`
 *   （`{inputTokens, outputTokens, totalTokens?…}`），`finish` 带 `.reason.kind`
 *   （`stop | tool-calls | max-tokens | aborted | error`；适配器报错会被归一成
 *   终态 finish，不会抛出来）。路由取自 `exec.agent.session.requestHeader().config`。
 *
 * 四条纪律：
 *   1. **零 import**：只走 `ctx.get('llm')`（本插件纪律 1：顶层 `inject` 留空）。
 *   2. **只有显式 `summarize: true` 才花这次钱**；默认与失败都走免费档。
 *   3. **任何异常/超时/中止/拿不到路由都不许冒泡**（C3）—— 一律返回 `skipped`。
 *   4. **花掉的 token 必须回传**给调用方记进 `events.log`（手册 §7.4：花掉的钱要看得见）。
 *
 * @returns {Promise<{text: string, usage: object|null, finish: string|null, skipped: string|null}>}
 */
async function summarizeWithModel(deps, exec, { topic, material }) {
  const fail = (skipped, usage = null, finish = null) => ({ text: '', usage, finish, skipped })
  const llm = deps.llm?.()
  if (typeof llm?.stream !== 'function') return fail('宿主没有提供 llm 服务（付费档不可用）')
  const route = exec?.agent?.session?.requestHeader?.()?.config
  const provider = typeof route?.provider === 'string' ? route.provider : ''
  const model = typeof route?.model === 'string' ? route.model : ''
  if (!provider || !model) return fail('拿不到当前会话的模型路由')
  const input = material.length > SUMMARY_INPUT_MAX_CHARS ? material.slice(-SUMMARY_INPUT_MAX_CHARS) : material
  let text = ''
  let usage = null
  let finish = null
  try {
    const stream = llm.stream({
      provider,
      model,
      system: '你把一段工作会话压成一条交接备忘。只输出备忘正文：先结论与决定，再待办，最后一行写「细节可用 memory_recall 取回」。'
        + '不要客套、不要复述本指令、不要 Markdown 标题、不要编造会话里没有的内容。',
      messages: [{ role: 'user', content: [{ type: 'text', text: `话题：${topic}\n\n${input}` }] }],
      maxTokens: SUMMARY_MAX_TOKENS,
      temperature: 0.2,
      purpose: 'compaction',
      signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
      sessionId: exec?.agent?.session?.id,
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta') text += typeof chunk.text === 'string' ? chunk.text : ''
      else if (chunk?.type === 'usage') usage = chunk.usage ?? usage
      else if (chunk?.type === 'finish') finish = chunk.reason?.kind ?? 'unknown'
    }
  } catch (error) {
    return fail(`模型调用抛错（${error?.message ?? error}）`, usage, finish)
  }
  if (finish === 'aborted' || finish === 'error') return fail(`模型调用终态为 ${finish}`, usage, finish)
  const trimmed = text.trim()
  return trimmed.length === 0 ? fail('模型没返回正文', usage, finish) : { text: trimmed, usage, finish, skipped: null }
}

/**
 * 读**本次会话**的原文行。
 *
 * 只走 `history.js` 的 `messageText()` —— 也就是 `source.kind` 白名单。
 * 这一条是 0.3.0 事故（「96 项全绿却 0 注入」）的正面：注入内容
 * （`strata-memory` / `runtime-context` / `plugin:*` …）绝不能被当成交接材料收进来。
 *
 * 只取末尾 40 行进正文（交接要的是最近的原文，同时给读盘量封顶），
 * 但 `transcriptChars` 统计**全部**读到的行——那是净收益守卫的分母。
 *
 * @returns {Promise<{lines: string[], transcriptChars: number, transcriptLines: number}>}
 */
async function currentSessionMaterial(deps, { context, config }) {
  const none = { lines: [], transcriptChars: 0, transcriptLines: 0 }
  const sessionId = context.sessionId
  if (!sessionId) return none
  const sessionQuery = deps.sessionQuery?.() ?? null
  const fallback = { home: deps.home, maxBytes: config.maxSessionBytes }
  try {
    let events = await readSessionLog(sessionQuery, sessionId, fallback)
    if (events.length === 0) {
      // 宿主服务没给（离线、或它不认识这个会话）就自己找目录切帧。
      const hit = (await scanSessionDirs(deps.home, context.workspace, config.extraSessionRoots)).find((entry) => entry.id === sessionId)
      if (hit) events = await readSessionLog(sessionQuery, sessionId, { ...fallback, dir: hit.dir })
    }
    const texts = events.map((event) => messageText(event)).filter((line) => line.length > 0)
    return { lines: texts.slice(-40), transcriptChars: texts.reduce((sum, line) => sum + line.length, 0), transcriptLines: texts.length }
  } catch { return none }
}

/**
 * 回填：扫历史会话，抽候选记忆。
 *
 * 走 `sessionQuery` 优先（它懂实时会话与格式），拿不到才自己切 zstd 帧。
 * 只看 `user/message` 事件 —— 助手自己说的话不是「用户的记忆」。
 */
async function collectBackfillCandidates(deps, { limit, workspace, config, context }) {
  const { home } = deps
  const sessionQuery = deps.sessionQuery()
  const out = []
  const seen = new Set()

  let sessions = []
  try {
    if (sessionQuery && typeof sessionQuery.listSessions === 'function') {
      const listed = await sessionQuery.listSessions()
      sessions = (Array.isArray(listed) ? listed : []).map((s) => ({ id: s.header?.id ?? s.id ?? s.sessionId, cwd: s.header?.cwd ?? s.cwd }))
    }
  } catch { /* 落到目录扫描 */ }

  if (sessions.length === 0) {
    sessions = await scanSessionDirs(home, workspace, config.extraSessionRoots)
  }
  if (workspace) {
    const key = workspaceKey(workspace)
    sessions = sessions.filter((s) => !!s.cwd && workspaceKey(s.cwd) === key)
  }
  if (config.readScope === 'session' || config.defaultScope === 'session') sessions = sessions.filter((s) => s.id === context.sessionId)
  sessions = sessions.slice(0, limit)

  for (const session of sessions) {
    if (!session.id) continue
    let events = []
    try {
      events = await readSessionLog(sessionQuery, session.id, {
        home,
        dir: session.dir,
        maxBytes: config.maxSessionBytes,
      })
    } catch { continue }
    for (const event of events) {
      if (event?.type !== 'user/message') continue
      const text = extractText(event.data)
      if (!text) continue
      for (const candidate of extractCandidates(text, config.autoExtractMax)) {
        const key = candidate.body
        if (seen.has(key)) continue
        seen.add(key)
        out.push({
          ...candidate,
          scope: config.defaultScope,
          workspace: session.cwd ?? workspace ?? '',
          workspacePath: session.cwd ?? workspace ?? '',
          sessionId: session.id,
          salience: 0.4,
          confidence: 0.4,
          quote: text.slice(0, 200),
        })
      }
    }
  }
  return out
}

/** 从事件里抽出纯文本。DSH 的消息 content 是块数组。 */
function extractText(data) {
  if (!data) return ''
  if (typeof data.content === 'string') return data.content
  if (!Array.isArray(data.content)) return ''
  return data.content.filter((block) => block?.type === 'text').map((block) => block.text ?? '').join('\n')
}

/**
 * 扫会话目录，拿到 `{id, dir, cwd}` 列表（按修改时间倒序）。
 *
 * 除了 `$DSH_HOME/sessions`，还会扫 `extraSessionRoots` 里给的目录 ——
 * 因为会话日志会被清空（2026-10-02 本机就发生过），备份目录是回填的重要来源。
 *
 * @param {string} home
 * @param {string} workspace 只看这个工作区（空 = 全部）
 * @param {string[]} extraRoots 额外的会话根目录
 */
async function scanSessionDirs(home, workspace, extraRoots = []) {
  const { readdirSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { readSessionHeader } = await import('../core/store.js')
  const { pluginPaths } = await import('../core/config.js')
  const roots = [pluginPaths(home).sessions, ...extraRoots.filter((r) => typeof r === 'string' && r.length > 0)]
  const out = []
  for (const root of roots) {
    let workspaceDirs = []
    try { workspaceDirs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()) } catch { continue }
    for (const entry of workspaceDirs) {
      const wsDir = join(root, entry.name)
      let sessionIds = []
      try { sessionIds = readdirSync(wsDir) } catch { continue }
      for (const sessionId of sessionIds) {
        const dir = join(wsDir, sessionId)
        let mtime = 0
        try { mtime = statSync(dir).mtimeMs } catch { /* 读不到就算了 */ }
        const header = readSessionHeader(dir, home)
        // 头部读不出来的（空壳会话）直接跳过 —— 回填对它们无能为力。
        if (!header) continue
        if (workspace && header.cwd && workspaceKey(header.cwd) !== workspaceKey(workspace)) continue
        out.push({ id: header.id ?? sessionId, dir, cwd: header.cwd ?? null, mtime })
      }
    }
  }
  // 同一个会话可能同时存在于 live 与备份里，按 id 去重并保留较新的。
  const byId = new Map()
  for (const session of out) {
    const existing = byId.get(session.id)
    if (!existing || session.mtime > existing.mtime) byId.set(session.id, session)
  }
  return [...byId.values()].sort((a, b) => b.mtime - a.mtime)
}

/** 给设置页用的召回测试（不走工具层，直接调核心）。 */
export function recallForUi(deps, { query, context }) {
  const config = deps.config()
  return recall({ store: deps.store, ledger: deps.ledger, config, query: query ?? '', context })
}

export { renderInjection, checkVisibility, tokenize, estimateTokens }
