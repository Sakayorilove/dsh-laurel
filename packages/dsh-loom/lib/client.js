/**
 * dsh-loom · 客户端半边（手写，无构建步骤，无第三方代码）
 *
 * ── 为什么没有打包器 ───────────────────────────────────────────────────
 * 这个文件直接就是 DSH 客户端模块系统要的形状：
 *     window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => {…} })
 * 里面没有 import、没有 JSX、没有任何 npm 依赖，所以不需要打包。
 * `require` 只用来取宿主平台表里的 `react` —— 那是宿主自己的运行时，
 * 不是我们带进来的第三方代码。
 *
 * ── 画布为什么是手写的 ─────────────────────────────────────────────────
 * 节点编辑器用 DOM + SVG 就够，而且更可控：视口变换一个 CSS transform，
 * 连线用 SVG 贝塞尔路径，端口是绝对定位的小圆点。少一层框架，
 * 就少一份要声明来源的代码。
 *
 * ── 交互规格来自 docs/dsh-loom/06 ──────────────────────────────────────
 * 大画布、节点内短配置、左右类型化端口、彩色产物连线、分组框、注释、
 * reroute、缩略图。拖节点只改布局；拖连线改依赖；类型不匹配立即拒绝。
 */
window.__ModuleLoader__.load({
  id: 'dsh-loom',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    function planningFeatureName(ctx) {
      try {
        const active = ctx?.get?.('locale')?.getSnapshot?.()?.active
        if (typeof active === 'string' && active.toLowerCase().startsWith('en')) return 'Visual planning mode'
      } catch { /* The optional locale service must not block the workbench. */ }
      return '可视化规划模式'
    }

    const API = '/loom'
    const PACKAGE_ID = 'dsh-loom'
    const CLIENT_VERSION = '0.8.6'

    /* ================================================================== *
     * 1. 端口类型与颜色
     *    颜色表达数据类型；状态永远用文字 + 独立标记，不混用同一色义。
     * ================================================================== */
    const PORT_COLORS = {
      'repo-report': '#6ea8fe',
      'interface-contract': '#b197fc',
      'code-change': '#8ce99a',
      'test-evidence': '#ffd43b',
      'project-commit': '#ffa94d',
      'delivery-report': '#66d9e8',
    }
    const PORT_LABELS = {
      'repo-report': '仓库报告',
      'interface-contract': '接口合同',
      'code-change': '代码变更',
      'test-evidence': '测试证据',
      'project-commit': '集成提交',
      'delivery-report': '交付报告',
    }
    const KIND_LABELS = {
      inspect: '检查',
      contract: '冻结接口',
      agent: '实现',
      verify: '验收',
      gate: '闸门',
      integrate: '集成',
      report: '报告',
    }
    const STAGE_LABELS = {
      discovery: '调研',
      planning: '计划',
      architecture: '架构',
      implementation: '实现',
      integration: '集成',
      verification: '验收',
    }
    const NODE_W = 224
    const PORT_GAP = 22
    const PORT_TOP = 46
    /** 架构节点没有端口行，锚点取卡片头部下方一点，连线才不会从顶上冒出去。 */
    const ARCH_ANCHOR_TOP = 28

    const colorOf = (t) => PORT_COLORS[t] || '#868e96'
    const labelOf = (t) => PORT_LABELS[t] || t

    /**
     * 架构层的中文标签。
     *
     * 架构节点/关系与任务节点/边是**两套** kind 枚举（见 src/core/architecture.ts）。
     * 混用一套标签会把 `module` 显示成 `gate` 那种错误，所以分开维护，
     * 谁都不认识就原样显示枚举值 —— 宁可露出英文，也不猜。
     */
    const ARCH_KIND_LABELS = {
      module: '模块',
      service: '服务',
      data: '数据',
      interface: '接口',
      decision: '决策',
      external: '外部',
    }
    const ARCH_EDGE_LABELS = {
      call: '调用',
      data: '数据流',
      event: '事件',
      deploy: '部署',
    }
    const ARCH_EDGE_COLORS = {
      call: '#6ea8fe',
      data: '#8ce99a',
      event: '#ffd43b',
      deploy: '#ffa94d',
    }
    const colorOfArchEdge = (k) => ARCH_EDGE_COLORS[k] || '#868e96'

    /**
     * 架构层的枚举值。
     *
     * 客户端**不 import** 宿主半边（bundle 里连一个 import 都不许有），
     * 所以这两份列表是 `src/core/architecture.ts` 里 ARCH_NODE_KINDS /
     * ARCH_EDGE_KINDS 的镜像。改动模型时必须同步改这里 ——
     * 为此 tests/architecture-view.test.mjs 有一条断言把两边钉在一起，
     * 单纯漂移会让测试变红，而不是悄悄放行。
     */
    const ARCH_NODE_KINDS = ['module', 'service', 'data', 'interface', 'decision', 'external']
    const ARCH_EDGE_KINDS = ['call', 'data', 'event', 'deploy']
    /**
     * 卡片上的责任摘要。
     *
     * responsibility 是必填**全文**，模型里明确要求「图里只显示摘要，全文必须保留」。
     * 所以这里只裁显示用的副本，绝不回写、绝不改原文。
     */
    const summary = (text, max) => {
      const s = String(text || '').replace(/\s+/g, ' ').trim()
      const n = max || 88
      return s.length > n ? s.slice(0, n) + '…' : s
    }

    /* ================================================================== *
     * 2. 与宿主数据面通讯
     *    统一处理 `{ ok, data }` / `{ ok, error }`，失败抛真 Error。
     * ================================================================== */

    /** Project identity comes from the host session query. A URL/cwd is not authority. */
    let WORKSPACE = ''
    let hostContext = null
    let resolvedSession = ''
    let sessionGeneration = 0
    const currentSessionId = () => {
      try {
        const ui = hostContext && (hostContext.get?.('uiSession') ?? hostContext.uiSession)
        return ui?.adapter?.current?.getSnapshot?.()?.key || ''
      } catch { return '' }
    }
    const explainError = error => {
      const message = error?.message || String(error)
      const missing = /Unknown agent preset: ([^\s]+)/.exec(message)
      return missing ? `当前会话使用的预设「${missing[1]}」未启用，Harness 无法恢复它。请新建一个「Standard / 标准模式」项目会话，再打开 Loom。Loom 无需安装或启用其他插件。` : message
    }

    /** 工作区是否已确定。未确定时**禁用所有写操作**，而不是让它们静默失败。 */
    const isPreparationSession = () => {
      const id = currentSessionId()
      const sessions = hostContext?.get?.('sessions') ?? hostContext?.sessions
      return !id || sessions?.list?.getSnapshot?.()?.byId?.[id]?.blank === true
    }
    const workspaceKnown = () => WORKSPACE !== ''
    const setWorkspace = (id) => {
      WORKSPACE = typeof id === 'string' ? id : ''
    }

    /**
     * 不依赖工作区的写入端点：它们改的是**会话态开关**，不是项目数据。
     *
     * 守卫的本意是「别把 A 会话的草案写到 B 会话上」——前提是这条写入要落到
     * 某个工作区。规划模式开关（以及总开关）只记在会话上，服务端也只按
     * sessionId 读写，压根用不到 ws。所以它们不该被 `resolvedSession`
     * （=「工作区已绑定」）拦下。
     *
     * 踩过的坑：新对话还没选工作区时点「规划模式」，请求被拦，
     * 聊天框里挂出一行「会话已切换，请等待项目加载后再保存」——
     * 用户看到的是「按钮能点、点完报一句看不懂的错」。
     */
    const SESSION_SCOPED_WRITES = new Set(['/config', '/session/activation', '/session/planning-mode'])

    async function requestJSON(api, path, options) {
      const opts = options || {}
      const init = { method: opts.method || 'GET', headers: {} }
      const globalSettings = path === '/config' || path === '/diagnostics'
      const sessionId = globalSettings ? '' : currentSessionId()
      const generation = sessionGeneration
      if (init.method === 'POST' && !SESSION_SCOPED_WRITES.has(path) && (!sessionId || sessionId !== resolvedSession)) throw new Error('会话已切换，请等待项目加载后再保存')
      if (sessionId) init.headers['x-loom-session'] = sessionId
      if (opts.body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(opts.body)
      }
      let timer = null
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      if (controller) init.signal = controller.signal
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Harness 数据通道响应超时，请重新读取或稍后重试'))
          controller?.abort()
        }, opts.timeoutMs || 10000)
      })
      try {
        return await Promise.race([timeoutPromise, (async () => {
          let res
          let connection = null
          try { connection = hostContext?.get?.('connection') ?? hostContext?.connection } catch {}
          if (connection?.rpc?.call) {
            const response = await connection.rpc.call('/api', 'loom/request', { args: { input: { sessionId, path, method: init.method, ...(opts.body === undefined ? {} : { body: opts.body }) } } }, init.signal)
            if (!response.ok) throw new Error(response.error?.message || 'Harness 数据通道拒绝了请求')
            res = { ok: response.value.status >= 200 && response.value.status < 300, status: response.value.status, json: async () => response.value.payload }
          } else {
            if (typeof location !== 'undefined' && location.protocol === 'file:') throw new Error('桌面宿主缺少 connection.rpc，请核对插件与宿主版本')
            res = await fetch(api + path, init)
          }
          let payload = null
          try {
            payload = await res.json()
          } catch {
            throw new Error(`端点 ${path} 返回的不是 JSON（HTTP ${res.status}）`)
          }
          if (!globalSettings && (sessionId !== currentSessionId() || generation !== sessionGeneration)) throw Object.assign(new Error('会话已切换，已忽略旧项目的响应'), { code: 'STALE_SESSION_RESPONSE' })
          if (!res.ok || payload.ok === false) {
            throw new Error(payload.error || `HTTP ${res.status}`)
          }
          return payload.data
        })()])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    /** Only a completed turn containing our exact durable prompt RPC is eligible.
     * Partial streams, old turns and co-claimed human prompts never become graphs. */
    function readSubmittedReply(window, tracked) {
      const events = (window?.entries || []).filter(e => e.type === 'event').map(e => e.event)
      let turn = null, matchedTurn = null, lastText = '', lastJsonText = '', ambiguous = false
      const otherTurns = new Set()
      for (const e of events) {
        if (!Number.isSafeInteger(e.seq) || e.seq <= tracked.afterSeq) continue
        if (e.type === 'turn/start') turn = e.data.turn
        if (e.type === 'user/message') {
          const message = e.data
          const source = message?.source
          if (source?.kind !== 'user') continue
          if (source.rpcId === tracked.requestId) {
            if (turn === null) throw new Error('本次回复缺少回合起点，请在会话中复制完整 JSON')
            matchedTurn = turn
            const text = (message.content || []).filter(c => c.type === 'text').map(c => c.text).join('')
            if (text !== tracked.text) throw new Error('本次请求的持久化内容不一致，未读取候选')
          } else if (turn !== null && (matchedTurn === turn || !matchedTurn)) {
            // Remember all user RPCs in this turn, even those before our prompt.
            otherTurns.add(turn)
          }
        }
        if (matchedTurn !== null && turn === matchedTurn) {
          ambiguous = otherTurns.has(turn)
          if (e.type === 'assistant/message' && e.data.turn === turn && !e.data.interrupted) {
            const text = (e.data.message?.content || []).filter(c => c.type === 'text').map(c => c.text).join('')
            if (text.trim()) {
              lastText = text
              try { extractPlanningReply(text); lastJsonText = text } catch { /* 这条不是规划 JSON，继续看前一条 */ }
            }
          }
          if (e.type === 'turn/end' && e.data.turn === turn) {
            if (ambiguous) throw new Error('本回合同时处理了其他输入，请复制并核对架构 JSON')
            if (e.data.reason?.kind !== 'completed') throw new Error(`AI 回合结束状态为 ${e.data.reason?.kind || "unknown"}，未导入候选`)
            if (!lastText.trim()) throw new Error('本次 AI 回合没有完整文本回复')
            return lastJsonText || lastText
          }
        }
      }
      return null
    }

    /* ================================================================== *
     * 2b. 规划回复的 JSON 提取
     *
     * 模型经常在 JSON 前后带解释文字或代码围栏；这里从原始回复里取出第一个
     * 完整、可解析且像规划结果的对象，而不是要求回复恰好是纯 JSON。
     * ================================================================== */
    function matchBalancedEnd(text, start) {
      let depth = 0, inString = false, escaped = false
      for (let i = start; i < text.length; i += 1) {
        const ch = text[i]
        if (inString) {
          if (escaped) escaped = false
          else if (ch === '\\') escaped = true
          else if (ch === '"') inString = false
          continue
        }
        if (ch === '"') inString = true
        else if (ch === '{' || ch === '[') depth += 1
        else if (ch === '}' || ch === ']') { depth -= 1; if (depth === 0) return i }
      }
      return -1
    }
    function extractPlanningReply(raw) {
      const original = String(raw === null || raw === undefined ? '' : raw).trim()
      const candidates = []
      const fence = /```(?:json)?\s*\n?([\s\S]*?)```/gi
      let match
      while ((match = fence.exec(original)) !== null) candidates.push(match[1].trim())
      candidates.push(original.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''))
      for (const candidate of candidates) {
        try {
          const value = JSON.parse(candidate)
          if (value && typeof value === 'object' && !Array.isArray(value)) return value
        } catch { /* 继续尝试下一个候选 */ }
      }
      let tried = 0
      for (let start = 0; start < original.length && tried < 8; start += 1) {
        if (original[start] !== '{') continue
        const end = matchBalancedEnd(original, start)
        if (end === -1) continue
        const slice = original.slice(start, end + 1)
        if (!slice.includes('requestId') && !slice.includes('architecture') && !slice.includes('workflow')) continue
        tried += 1
        try {
          const value = JSON.parse(slice)
          if (value && typeof value === 'object' && !Array.isArray(value)) return value
        } catch { /* 继续尝试下一个候选 */ }
      }
      throw new Error('没有找到完整的 JSON 对象：请让 AI 重新回复，或只复制回复中从第一个 { 到最后一个 } 的内容再点「预览候选改动」')
    }

    /** 长请求改写为工作区内文档后，对话里只发这句短指令，模型自己去读。 */
    function requestFileMessage(kind, path) {
      const head = kind === 'repair' ? 'Loom 修正请求' : 'Loom 规划请求'
      return head + '：请先完整读取 ' + path + '（含全部要求、Schema 与数据）；仅规划，不实施。完整任务候选通过 loom_submit_plan 提交，并展示完整文字计划后停止等待批准。若是架构候选或没有提交工具，在回复中给出完整 JSON 与说明；禁止写计划文件。'
    }
    /** 超过 600 字符的请求写成 .loom/plan-request.md，返回真正要发送的文本；写入失败则原样发送。 */
    async function stageOutgoingRequest(text, kind) {
      if (kind==='planning' || kind==='resolution' || typeof text !== 'string' || text.length <= 600) return text
      try {
        const data = await requestJSON(API, '/planning/stage', { method: 'POST', body: { text } })
        return requestFileMessage(kind, data && data.path ? data.path : '.loom/plan-request.md')
      } catch { return text }
    }

    /** 读取模型写入会话目录的 .loom/plan.json；宿主未提供或文件不存在时返回 null。 */
    async function readPlanFile() {
      try {
        const data = await requestJSON(API, '/planning/collect?t=' + Date.now())
        return data && typeof data.text === 'string' ? data : null
      } catch { return null }
    }
    /** 从一段文本里取规划 requestId；不是规划 JSON 就返回 null。 */
    function planRequestId(text) {
      try {
        const value = extractPlanningReply(text)
        return typeof value?.requestId === 'string' ? value.requestId : null
      } catch { return null }
    }
    /** 对话文本与计划文件同时可用时：requestId 与本次请求匹配者优先，对话在前。 */
    function preferPlanFileReply(chatText, fileText, hash) {
      if (planRequestId(chatText) === hash) return chatText
      if (planRequestId(fileText) === hash) return fileText
      return chatText
    }
    /**
     * 没有对话文本时，用项目里的 `.loom/plan.json` 兜底。
     *
     * 窗口重开（渲染进程重建）后内存里的回复缓存必然为空，但模型写进项目的
     * 那份文件还在。**不能见到文件就当候选**：只有文件里的 requestId 与本次
     * 请求一致才认领 —— 旧文件、别的请求写的文件一律返回 null，交回手动路径。
     */
    function restorePlanFileReply(file, hash) {
      if (!file || typeof file.text !== 'string' || !file.text.trim()) return null
      if (typeof hash !== 'string' || !hash) return null
      const reply = preferPlanFileReply('', file.text, hash)
      return reply && reply.trim() ? reply : null
    }
    /**
     * 恢复候选时用哪个 requestId 校验：本次导出优先（同一客户端生命周期内），
     * 其次服务端记录的最新规划请求（窗口重开后唯一可用的凭据）。
     */
    function planRestoreHash(promptText, collect) {
      if (promptText && typeof promptText.payloadHash === 'string' && promptText.payloadHash) return promptText.payloadHash
      const requestId = collect && collect.requestId
      return typeof requestId === 'string' && requestId ? requestId : ''
    }

    /**
     * 低配模型护栏：同一个规划请求连续多次「候选校验未通过」时，多半不是提示词
     * 的问题，而是 Flash 级模型反复产出不合 schema 的 JSON。这时给出换更强模型的
     * 建议，并附一段可直接复制的短指令。
     *
     * 阈值取 2：一次失败可能是模型偶发手滑，连续两次就值得换模型——比让用户
     * 反复点「让 AI 修正」空转更省时间。
     */
    const LOW_MODEL_GUARD_THRESHOLD = 2
    function lowModelGuardText(streak) {
      if (!Number.isFinite(streak) || streak < LOW_MODEL_GUARD_THRESHOLD) return ''
      return [
        `这份方案已经连续 ${streak} 次没通过 Loom 的格式校验。`,
        '请先区分字段格式错误、旧请求/版本冲突，以及权限或宿主问题；连续失败本身不能判定模型等级。',
        '先按下方具体错误修复；确认格式反复出错且修复无效时，再尝试更强的模型。可复制修复指令继续同一请求。',
      ].join('\n')
    }
    /** 换模型重规划时可直接粘贴的短指令（含最小必要修正要求）。 */
    function lowModelGuardCommand(payloadHash, errorText) {
      return [
        `Loom 规划请求 ${payloadHash || '(未记录)'} 连续多次校验未通过，请先核对错误；仅确认格式反复出错时再换用更强的模型。`,
        '重新输出完整候选；任务计划通过 loom_submit_plan 提交并展示完整文字计划，提交后等待批准，不写文件；架构候选可在回复中给出完整 JSON。字段要求：架构边字段用 id/from/to/kind(call/data/event/deploy)；任务节点 inputs/outputs 的 required 必须是布尔值且 outputs 一律 required:false；ownership.sharedResources 只放 id 形状字符串；acceptance.commands 是对象数组，每项固定 {argv,cwdRef:"node-worktree",expectedExitCode:0}。',
        '最近一次校验错误：',
        String(errorText ?? '').slice(0, 2000),
      ].join('\n')
    }

    /** 构造「按校验错误修正」的追问文本：只让模型输出修正后的完整 JSON。 */
    function buildRepairText(payloadHash, errorText) {
      return [
        `Loom 校验上一份方案未通过（requestId 保持 ${payloadHash} 不变）。请只做最小必要修改，然后把修正后的完整 JSON 写入 .loom/plan.json（紧凑 JSON、直接覆盖），对话里只回一句中文说明；只有写入失败时才把 JSON 附在回复末尾，不要代码围栏。`,
        '架构边（architecture.edges）字段是 id、from、to、kind（call/data/event/deploy），可选 description/bidirectional；不要用 source/target/sourcePort/artifactType/require —— 那些是任务依赖边（workflow.edges）的字段。',
        '任务节点：inputs/outputs 的 required 都必须是布尔值，且 outputs 一律 required:false；ownership.sharedResources 只放 id 形状字符串（小写字母开头、只含小写字母/数字/下划线/连字符，如 ["shared-lock"]），不要写说明句；acceptance.commands 必须是对象数组，每项固定 {argv:[程序,参数...],cwdRef:"node-worktree",expectedExitCode:0}，没有可靠命令就用空数组。',
        '校验错误：',
        String(errorText ?? '').slice(0, 4000),
      ].join('\n')
    }

    /** 找回「本次提示词」最近一次已完成、无歧义的 AI 回复（跨工作台实例恢复用）。 */
    function recoverSubmittedReply(window, text) {
      const events = (window?.entries || []).filter(e => e.type === 'event').map(e => e.event)
      const matches = []
      let turn = null
      for (const e of events) {
        if (!Number.isSafeInteger(e.seq)) continue
        if (e.type === 'turn/start') turn = e.data.turn
        if (e.type === 'user/message') {
          const message = e.data, source = message?.source
          if (source?.kind !== 'user') continue
          const content = (message.content || []).filter(c => c.type === 'text').map(c => c.text).join('')
          if (content === text && turn !== null) matches.push(turn)
        }
      }
      for (let i = matches.length - 1; i >= 0; i -= 1) {
        const target = matches[i]
        let current = null, found = false, other = false, lastText = '', lastJsonText = '', completed = false
        for (const e of events) {
          if (!Number.isSafeInteger(e.seq)) continue
          if (e.type === 'turn/start') current = e.data.turn
          if (current !== target) continue
          if (e.type === 'user/message' && e.data?.source?.kind === 'user') {
            const content = (e.data.content || []).filter(c => c.type === 'text').map(c => c.text).join('')
            if (content === text) found = true
            else other = true
          }
          if (e.type === 'assistant/message' && e.data.turn === target && !e.data.interrupted) {
            const chunk = (e.data.message?.content || []).filter(c => c.type === 'text').map(c => c.text).join('')
            if (chunk.trim()) {
              lastText = chunk
              try { extractPlanningReply(chunk); lastJsonText = chunk } catch { /* 这条不是规划 JSON，继续看前一条 */ }
            }
          }
          if (e.type === 'turn/end' && e.data.turn === target) { completed = e.data.reason?.kind === 'completed'; break }
        }
        if (found && !other && completed && lastText.trim()) return lastJsonText || lastText
      }
      return null
    }

    /* ================================================================== *
     * 3. 设置页插槽注册（自己实现，只依赖宿主公开的 slots 服务）
     * ================================================================== */
    // 两路注册：装载机在就聚合进「Laurel总控」，不在就照旧单独占一条设置页。
    // 为什么必须两路都留着：插槽系统「声明即独占渲染权」——聚合插槽是装载机声明的，
    // 用户只装了 loom 没装装载机时，聚合那条路永远等不到声明，设置页就整块消失。
    // 两个 inject 同时挂着，谁先成立谁生效；聚合成立就把独立那份撤掉，免得出现两处。
    const MODULE_SETTINGS_SLOT = 'laurel-center.module'
    function registerSettingsSection(ctx, options) {
      const slots = options.slots
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        throw new Error(`loom: 拿不到 slots 服务，无法注册设置页（${options.id}）`)
      }
      const put = (name) =>
        slots.register({ name, id: options.id, order: options.order, label: options.label }, options.component)
      return ctx.effect(() => {
        let grouped = null
        let standalone = null
        const offGroup = slots.inject(MODULE_SETTINGS_SLOT, () => {
          if (grouped) return () => {}
          if (standalone) { standalone(); standalone = null }
          grouped = put(MODULE_SETTINGS_SLOT)
          return () => { grouped?.(); grouped = null }
        })
        const offStandalone = slots.inject('settings.section', () => {
          if (grouped) return () => {}
          if (standalone) return () => {}
          standalone = put('settings.section')
          return () => { standalone?.(); standalone = null }
        })
        // `?.()`：inject 的契约是返回 disposer，但测试替身未必给 —— 卸载时抛
        // 「offGroup is not a function」会把整个卸载流程带塌。
        return () => { offGroup?.(); offStandalone?.() }
      }, `${options.id}.settings-section`)
    }

    // The frame and Settings share only UI state; persisted authority stays on Host.
    const seat = { open: false, fullscreen: false, canvasOnly: false, activationVersion: 0, config: null, inline: new Map(), busyOwners:new Map(), listeners: new Set() }
    const notifySeat = () => { for (const listener of seat.listeners) listener() }
    const useSeat = () => {
      const [, render] = React.useState(0)
      React.useEffect(() => { const listener = () => render(n => n + 1); seat.listeners.add(listener); const ui = hostContext?.get?.('uiSession') ?? hostContext?.uiSession; let previous = currentSessionId(); const unsubscribe = ui?.adapter?.current?.subscribe?.(() => { const next = currentSessionId(); if (next !== previous) { previous = next; listener() } }); return () => { seat.listeners.delete(listener); unsubscribe?.() } }, [])
      return seat
    }
    let nativeSidebar = null
    const openWorkbench = () => {
      seat.inline.delete(currentSessionId())
      seat.canvasOnly = false
      if (currentSessionId() && nativeSidebar?.openTab) { try {nativeSidebar.openTab('loom-workbench');if(nativeSidebar.isExpanded?.()===false)nativeSidebar.toggleExpanded?.();seat.open=false;notifySeat();return} catch(error){console.warn('Loom 原生工作台未打开，使用会话窗口',error)} }
      seat.open = true; notifySeat()
    }
    const viewCache = new Map()
    const canvasLayouts = new Map()
    const preparationActivations = new Set()
    /** 已经为哪个会话从项目计划文件恢复过候选：同一会话只尝试一次，避免重复请求。 */
    const planRestoreAttempted = new Set()
    function LoomNativePane(props) {
      useSeat()
      const tab = props?.useTabInfo?.()
      if(tab && !tab.tab.visible)return null
      if(seat.open)return h('p',{role:'status'},'工作台正在全屏中；返回会话后继续。')
      if(seat.inline.has(currentSessionId()))return h('div',null,h('p',{role:'status'},'画布已在对话回复下展开。'),h('button',{type:'button',disabled:seat.workbenchBusy||seat.entryBusy,onClick:openWorkbench},'回到侧栏工作台'))
      return h('section',{'data-loom-native-pane':'',style:{height:'100%',minHeight:0,overflow:'auto',padding:12}},
        h('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8,marginBottom:12}},h('strong',null,'可视化规划模式'),
          h('button',{type:'button',disabled:seat.workbenchBusy||seat.entryBusy,title:seat.workbenchBusy||seat.entryBusy?'等待当前操作完成后再全屏':undefined,onClick:()=>{if(seat.workbenchBusy||seat.entryBusy)return;seat.open=true;seat.fullscreen=true;notifySeat()}},'全屏工作台')),
        h(LoomWorkbench))
    }

    /** 规划模式：跨插槽共享的会话级状态（聊天框按钮、着色层、工作台都读它）。 */
    const planningModeStore = { enabled: false, color: '#6ea8fe', version: 0, listeners: new Set() }
    const setPlanningMode = (patch) => {
      Object.assign(planningModeStore, patch)
      planningModeStore.version += 1
      for (const listener of planningModeStore.listeners) listener()
      try { window.dispatchEvent(new CustomEvent('loom:planning-mode', { detail: { enabled: planningModeStore.enabled, color: planningModeStore.color } })) } catch { /* 无 CustomEvent 环境忽略 */ }
    }
    const usePlanningMode = () => {
      const [, render] = React.useState(0)
      React.useEffect(() => { const listener = () => render((n) => n + 1); planningModeStore.listeners.add(listener); return () => planningModeStore.listeners.delete(listener) }, [])
      return planningModeStore
    }

    const PLANNING_SWATCHES = ['#6ea8fe', '#62d6a4', '#c792ea', '#f78ca2', '#ffd166', '#4dd0e1', '#ffa94d', '#b197fc']
    /** 聊天框里的「规划模式」开关（颜色在设置 → 外观里调，带预览）。 */
    function PlanningModeLine() {
      const store = usePlanningMode()
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      React.useEffect(() => {
        let disposed = false
        const load = async () => {
          try {
            const config = await requestJSON(API, '/config')
            const sessionId = currentSessionId()
            const mode = sessionId ? await requestJSON(API, '/session/planning-mode') : { planningMode: false }
            if (disposed) return
            setPlanningMode({ enabled: mode.planningMode === true, color: (config && config.planningModeColor) || '#6ea8fe' })
          } catch (err) { if (!disposed) setError(String((err && err.message) || err)) }
        }
        load()
        let seen=''
        const timer=setInterval(async()=>{
          const id=currentSessionId();if(!id)return
          try{
            const snapshot=await requestJSON(API,'/state')
            if(disposed||id!==currentSessionId())return
            const candidate=snapshot.planning?.candidate, rejected=snapshot.planning?.rejected
            if(rejected&&(id+':rejected:'+rejected.at)!==seen){seen=id+':rejected:'+rejected.at;seat.canvasOnly=false;openWorkbench()}
            if(candidate&&(id+':'+candidate.id)!==seen){seen=id+':'+candidate.id;seat.canvasOnly=false;openWorkbench()}
            window.dispatchEvent(new CustomEvent('loom:plan-updated',{detail:{sessionId:id,candidateId:candidate?.id||null}}))
          }catch{}
        },2000)
        const ui = hostContext?.get?.('uiSession') ?? hostContext?.uiSession
        let previous = currentSessionId()
        const unsubscribe = ui?.adapter?.current?.subscribe?.(() => { const next = currentSessionId(); if (next !== previous) { previous = next; load() } })
        const onConfig = (event) => {
          const config = event && event.detail
          if (config && typeof config.planningModeColor === 'string') setPlanningMode({ color: config.planningModeColor })
        }
        const canListen = typeof window.addEventListener === 'function'
        if (canListen) window.addEventListener('loom:config-changed', onConfig)
        return () => { disposed = true; clearInterval(timer); unsubscribe?.(); if (canListen) window.removeEventListener('loom:config-changed', onConfig) }
      }, [])
      React.useEffect(() => {
        // 关掉时返回 false 不是「失败」，只有开着却找不到目标才记成失败。
        const ok = applyComposerGlow(typeof document === 'undefined' ? null : document, store.enabled, store.color)
        appearanceStatus.composerGlow = store.enabled ? ok === true : null
        appearanceStatus.at = Date.now()
      }, [store.enabled, store.color])
      const toggle = async () => {
        if (busy) return
        const sessionId = currentSessionId()
        if (!sessionId) { setError('还没有会话，先进入项目会话'); return }
        setBusy(true); setError('')
        try {
          const data = await requestJSON(API, '/session/planning-mode', { method: 'POST', body: { planningMode: !store.enabled } })
          const sessions=hostContext?.get?.('sessions')??hostContext?.sessions
          if(sessions?.using)await sessions.using(sessionId,{source:'controllerOperation'},async ref=>{const binding=await ref.ready;if(sessionId!==currentSessionId())throw new Error('会话已切换');await binding.session.command(data.planningMode?'/plan':'/plan off')})
          setPlanningMode({ enabled: data.planningMode === true })
        } catch (err) { setError(String((err && err.message) || err)) } finally { setBusy(false) }
      }
const pill = { display: 'inline-flex', alignItems: 'center', gap: '6px', borderRadius: '999px', border: '1px solid rgba(128,128,128,.4)', padding: '2px 10px', fontSize: '12px', lineHeight: '18px', background: 'transparent', color: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap' }
      return h('span', { className: 'loom-plan-line', 'data-loom-planning-mode': store.enabled ? 'on' : 'off' },
        h('button', {
          className: 'loom-plan-toggle' + (store.enabled ? ' is-on' : ''), type: 'button', disabled: busy, 'aria-pressed':store.enabled,
          title: store.enabled ? '规划中：读取资料并提交候选，批准当前版本后才执行' : '开启规划：直接发送需求生成文字和流程图；关闭开关不会批准计划',
          style: store.enabled
            ? { ...pill, borderColor: store.color, color: store.color, boxShadow: '0 0 10px ' + store.color + '66', fontWeight: 600 }
            : pill,
          onClick: toggle,
        },
          h('span', { className: 'loom-plan-dot', style: { background: store.color, boxShadow: store.enabled ? '0 0 8px ' + store.color : 'none' } }),
          '规划模式'),
        error ? h('span', { className: 'loom-plan-error' }, error) : null,
      )
    }

    /**
     * 规划模式整框发光：只靠 slot 覆盖层只能盖住输入行的一部分（用户反馈图一）。
     * 这里从自己的按钮往上找到「包住 textarea 的输入框层」，给整层加光晕；
     * 失败静默（宿主结构变化时不做任何事，不影响其它功能）。
     */
    function applyComposerGlow(documentRef, enabled, color) {
      try {
        const doc = documentRef
        if (!doc || !doc.body) return false
        const painted = doc.querySelectorAll('[data-loom-plan-glow]')
        if (!enabled) {
          painted.forEach((node) => {
            node.removeAttribute('data-loom-plan-glow')
            node.style.borderColor = ''
            node.style.boxShadow = ''
          })
          return false
        }
        const anchor = doc.querySelector('[data-loom-planning-mode]') || doc.querySelector('.loom-plan-line')
        if (!anchor) return false
        let box = anchor
        for (let i = 0; i < 8; i += 1) {
          const parent = box.parentElement
          if (!parent) break
          box = parent
          if (box.querySelector && box.querySelector('textarea')) break
        }
        if (!box || !box.style) return false
        box.setAttribute('data-loom-plan-glow', '')
        box.style.borderColor = color
        box.style.boxShadow = '0 0 20px ' + color + '66, inset 0 0 22px ' + color + '2e'
        return true
      } catch { return false }
    }

    /** 聊天框着色层（官方 conversation.input.overlay 插槽，不碰宿主 DOM 结构）。 */
    function PlanningTint() {
      const store = usePlanningMode()
      if (!store.enabled) return null
      return h('div', {
        className: 'loom-plan-tint', 'data-loom-planning-tint': '',
        style: {
          position: 'absolute', inset: 0, pointerEvents: 'none',
          background: store.color + '14',
          boxShadow: 'inset 0 0 26px ' + store.color + '55',
          border: '1px solid ' + store.color + '66',
          borderRadius: 'inherit',
        },
      })
    }

    /** 欢迎页题词样式（纯函数，便于单测）。 */
    function welcomeLineStyle(config) {
      const glow = Number(config && config.welcomeGlow) || 0
      const stroke = Number(config && config.welcomeStroke) || 0
      const color = (config && config.welcomeColor) || '#e6e8ea'
      const shadow = glow <= 0 ? 'none'
        : glow === 1 ? '0 0 8px ' + color + '99'
          : glow === 2 ? '0 0 12px ' + color + 'aa, 0 0 3px ' + color
            : '0 0 18px ' + color + ', 0 0 6px ' + color
      const style = {
        fontFamily: (config && config.welcomeFont) || 'inherit',
        fontSize: String((config && config.welcomeFontSize) || 16) + 'px',
        color,
        textShadow: shadow,
      }
      if (stroke > 0) style.WebkitTextStroke = stroke + 'px ' + ((config && config.welcomeStrokeColor) || '#0b0d10')
      return style
    }

    /**
     * 欢迎页题词：宿主的 hero 插槽（brand.mark / workspace / agentPreset）都是
     * **single 且已被官方占用**，同优先级注册会抛错，所以这里改成**受控 DOM 注入**：
     * 只认标题文本（中英文都认），找不到就静默不动；每次调用都可失败无害。
     */
    function applyWelcomeLine(documentRef, config) {
      try {
        const doc = documentRef
        if (!doc || !doc.body) return false
        const existing = doc.querySelector('[data-loom-welcome]')
        if (!config || config.enabled === false || config.welcomeEnabled === false) {
          if (existing) existing.remove()
          return false
        }
        let host = existing
        if (!host) {
          const nodes = [...doc.querySelectorAll('span,div,h1,h2')]
          const headline = nodes.find((node) => node.childElementCount === 0 && /探索未至之境|Into the Unknown/.test(node.textContent || ''))
          if (!headline) return false
          // 从标题往外爬到「标题组」整行（图标+标题+预览徽标），插到它下面，
          // 而不是插在行内 —— 行内会变成右侧并排（用户反馈的图二）。
          let row = headline.parentElement || headline
          for (let i = 0; i < 3; i += 1) {
            const parent = row.parentElement
            if (!parent || parent.children.length > 3) break
            const text = (parent.textContent || '').replace('欢迎使用可视化规划模式', '').trim()
            if (text.length > 40) break
            row = parent
          }
          host = doc.createElement('div')
          host.setAttribute('data-loom-welcome', '')
          host.className = 'loom-welcome-line'
          row.insertAdjacentElement('afterend', host)
        }
        host.textContent = '欢迎使用可视化规划模式'
        const style = welcomeLineStyle(config)
        host.style.display = 'block'
        host.style.width = '100%'
        host.style.textAlign = 'center'
        host.style.marginTop = '6px'
        host.style.fontFamily = style.fontFamily
        host.style.fontSize = style.fontSize
        host.style.color = style.color
        host.style.textShadow = style.textShadow
        host.style.webkitTextStroke = style.WebkitTextStroke || style.webkitTextStroke || ''
        return true
      } catch { return false }
    }

    function SessionLoomAction(props) {
      useSeat()
      const [status, setStatus] = React.useState({ sessionId: '', enabled: false, busy: false, error: '' })
      React.useEffect(() => {
        let disposed = false, serial = 0
        const refresh = async () => {
          const attempt = ++serial, sessionId = currentSessionId()
          if (props?.sessionId && props.sessionId !== sessionId) { setStatus({ sessionId: '', enabled: false, busy: false, error: '' }); return }
          try {
            const config = await requestJSON(API, '/config')
            const activation = sessionId ? await requestJSON(API, '/session/activation') : { enabled: false }
            if (disposed || attempt !== serial || sessionId !== currentSessionId()) return
            seat.config = config; notifySeat()
            setStatus({ sessionId, enabled: activation.enabled, busy: false, error: '' })
          } catch (error) { if (!disposed && attempt === serial && error.code !== 'STALE_SESSION_RESPONSE') setStatus({ sessionId, enabled: false, busy: false, error: error.message }) }
        }
        refresh()
        const ui = hostContext?.get?.('uiSession') ?? hostContext?.uiSession
        let previous = currentSessionId()
        const unsubscribe = ui?.adapter?.current?.subscribe?.(() => { const next = currentSessionId(); if (next !== previous) { previous = next; refresh() } })
        return () => { disposed = true; serial++; unsubscribe?.() }
      }, [seat.open, seat.activationVersion, props?.sessionId])
      const enableAndOpen = async () => {
        if (status.busy || seat.entryBusy) return
        seat.entryBusy = true; notifySeat()
        setStatus({ ...status, busy: true, error: '' })
        try {
          if (!seat.config?.enabled) { setStatus({ ...status, busy: false, error: '' }); openWorkbench(); return }
          if (currentSessionId() && !status.enabled) await requestJSON(API, '/session/activation', { method: 'POST', body: { enabled: true } })
          setStatus({ ...status, enabled: true, busy: false, error: '' }); openWorkbench()
        } catch (error) { setStatus({ ...status, busy: false, error: error.message }) }
        finally { seat.entryBusy = false; notifySeat() }
      }
      if (props?.sessionId && props.sessionId !== currentSessionId()) return null
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        h('button', { type: 'button', 'aria-label': props?.preparation ? '打开可视化规划模式' : status.enabled ? '打开可视化规划模式' : '在本会话启用可视化规划模式', disabled: status.busy || seat.entryBusy || (!status.sessionId && !props?.preparation), onClick: enableAndOpen,
          title: status.error || (seat.config?.enabled ? '架构与并行任务工作台' : '可视化规划模式已关闭'),
          style: { font: 'inherit', borderRadius: 7, border: '1px solid var(--dsw-alias-border-l2, #666)', padding: '5px 10px', background: 'var(--dsw-alias-bg-layer-1, transparent)', color: 'inherit', cursor: 'pointer' } }, status.busy ? '规划模式…' : props?.preparation ? '可视化规划模式' : seat.config?.enabled === false ? '可视化规划模式 · 已关闭' : status.enabled ? '可视化规划模式 · 已启用' : '启用可视化规划模式'),
        status.error ? h('span', { role: 'status', style: { maxWidth: 240, fontSize: 12, overflowWrap: 'anywhere' } }, status.error) : null)
    }

    // Additive completed-turn slot: one live editor for the current project,
    // anchored to an explicit reply. Never replaces Host message renderers.
    function LoomHistoricalPlan({version}) {
      const wf=version.preview?.workflow
      if(!wf)return h('p',{role:'status'},version.markdown)
      const nodes=wf.nodes.map((node,i)=>({node,x:20+(i%3)*250,y:20+Math.floor(i/3)*110}))
      const byId=new Map(nodes.map(n=>[n.node.id,n]))
      return h('section',{'data-loom-plan-history':version.id,'aria-label':'此回复的计划快照'},
        h('p',null,'计划快照 · '+wf.workflowId+'@'+wf.revision+' · '+version.id.slice(0,12)+'；此记录保留提交时的版本。'),
        h('button',{type:'button',onClick:openWorkbench},'编辑当前项目计划'),
        h('div',{style:{overflow:'auto'}},h('svg',{role:'img','aria-label':'历史计划依赖图',viewBox:'0 0 770 '+(Math.ceil(nodes.length/3)*110+20),style:{width:'100%',minWidth:500}},
          ...wf.edges.map((edge,i)=>{const a=byId.get(edge.source),b=byId.get(edge.target);return a&&b?h('path',{key:'edge-'+i,d:`M${a.x+220},${a.y+35} L${b.x},${b.y+35}`,stroke:'currentColor',fill:'none'}):null}),
          ...nodes.map(({node,x,y})=>h('g',{key:node.id,transform:`translate(${x},${y})`},h('rect',{width:220,height:72,rx:8,fill:'var(--dsw-alias-bg-base, #202734)',stroke:'currentColor'}),h('text',{x:12,y:30,fill:'currentColor',fontSize:14},node.title.slice(0,16)),h('text',{x:12,y:52,fill:'currentColor',fontSize:12},node.id))))),
        h('pre',{style:{whiteSpace:'pre-wrap',fontFamily:'inherit'}},version.markdown))
    }

    function LoomInlineCanvas(props) {
      useSeat()
      const [problem, setProblem] = React.useState('')
      const [historical,setHistorical]=React.useState(null)
      const mounted = React.useRef(false)
      React.useEffect(() => { mounted.current = true; injectCss(); return () => { mounted.current = false } }, [])
      const sessionId = props?.sessionId
      if (!sessionId || sessionId !== currentSessionId()) return null
      const target = String(props.turn?.turn ?? props.turn)
      const active = seat.inline.get(sessionId) === target && !seat.open
      const unavailable = seat.entryBusy || seat.workbenchBusy
      const open = async () => {
        if (seat.entryBusy || seat.workbenchBusy) return
        seat.entryBusy = true; notifySeat(); setProblem('')
        try {
          const config = await requestJSON(API, '/config')
          const activation = await requestJSON(API, '/session/activation')
          const snapshot=await requestJSON(API,'/state')
          const version=(snapshot.planning?.history||[]).filter(v=>String(v.turn)===target).at(-1)
          setHistorical(version||null)
          if (sessionId !== currentSessionId()) return
          if (config.enabled && !activation.enabled) await requestJSON(API, '/session/activation', { method: 'POST', body: { enabled: true } })
          if (sessionId !== currentSessionId()) return
          seat.config = config; seat.inline.set(sessionId, target)
          seat.open = false; seat.canvasOnly = true; seat.activationVersion++
          // Free the conversation width only when Loom owns the active pane.
          try { if (nativeSidebar?.active?.()?.kind === 'loom-workbench' && nativeSidebar.isExpanded?.()) nativeSidebar.toggleExpanded?.() } catch (error) { console.warn('Loom 对话画布已打开，侧栏保持现状', error) }
          notifySeat()
        } catch (error) { if (mounted.current && sessionId === currentSessionId()) setProblem(error.message) }
        finally { seat.entryBusy = false; notifySeat() }
      }
      const close = () => { if (seat.entryBusy || seat.workbenchBusy) return; seat.inline.delete(sessionId); seat.canvasOnly = false; notifySeat() }
      return h('section', { 'data-loom-inline': '', 'data-loom-inline-open': String(active), 'aria-label': '回复中的规划画布' },
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
          active ? h('strong', null, historical?'此回复的计划版本':'当前项目画布') : null,
          h('button', { type: 'button', disabled: unavailable, onClick: active ? close : open }, active ? '收起对话画布' : '在此回复下打开规划画布'),
          active ? h('button', { type: 'button', disabled: unavailable, onClick: () => { if (seat.entryBusy || seat.workbenchBusy) return; seat.open = true; seat.fullscreen = true; notifySeat() } }, '全屏画布') : null),
        problem ? h('p', { role: 'alert' }, problem) : null,
        active ? h('div', { 'data-loom-inline-body': '', style: { height: 'max(560px, 70vh)', minHeight: 320, maxHeight: '85vh', resize: 'vertical', overflow: 'auto', marginTop: 12, padding: 12, border: '1px solid var(--dsw-alias-border-l2, #666)', borderRadius: 12 } }, historical?h(LoomHistoricalPlan,{version:historical}):h(LoomWorkbench)) : null)
    }

    function NewSessionLoomAction() {
      const [, refresh] = React.useState(0)
      React.useEffect(() => {
        const ui = hostContext?.get?.('uiSession') ?? hostContext?.uiSession
        const sessions = hostContext?.get?.('sessions') ?? hostContext?.sessions
        const change = () => refresh(n => n + 1)
        const disposers = [ui?.adapter?.current?.subscribe?.(change), sessions?.list?.subscribe?.(change)]
        return () => disposers.forEach(dispose => dispose?.())
      }, [])
      if (!isPreparationSession()) return null
      return h('div', { 'data-loom-new-session-entry': '', style: { position: 'fixed', top: 'calc(var(--dsh-frame-chrome-top, var(--dsh-frame-top-clearance, 0px)) + 14px)', right: 64, zIndex: 40, pointerEvents: 'auto' } }, h(SessionLoomAction, { preparation: true }))
    }

    /**
     * 分层自动排版：把节点排成从左到右的列。
     *
     * 为什么需要：采纳进来的图只有语义、没有坐标；旧实现按「每行 3 个」的
     * 序号网格铺开，依赖一多线就互相穿插（用户反馈「捆成麻花」）。
     * 这里按边的方向分层（DFS 标记回边，架构允许环也不会炸）：
     *   - 层 = 最长路径层级：没有入边的节点从第 0 列开始；
     *   - 列内顺序 = 前驱节点行号的重心（减少交叉）；
     *   - 每一列垂直居中，整体是一张从左到右的流程图。
     * 节点对象就地写回 x/y；已有保存坐标的节点由调用方覆盖回来。
     */
    function autoArrangeGraph(nodes, edges, shape, metrics) {
      const col = (metrics && metrics.col) || 320
      const row = (metrics && metrics.row) || (shape === 'task' ? 235 : 200)
      const pad = (metrics && metrics.pad) || 0
      const byId = new Map(nodes.map((n) => [n.id, n]))
      const out = new Map(nodes.map((n) => [n.id, []]))
      const inc = new Map(nodes.map((n) => [n.id, []]))
      const sourceOf = (e) => (shape === 'architecture' ? e.from : e.source)
      const targetOf = (e) => (shape === 'architecture' ? e.to : e.target)
      for (const e of edges) {
        const a = sourceOf(e)
        const b = targetOf(e)
        if (!byId.has(a) || !byId.has(b) || a === b) continue
        out.get(a).push(b)
        inc.get(b).push(a)
      }
      const state = new Map()
      const backEdges = new Set()
      const order = []
      const visit = (id) => {
        state.set(id, 1)
        for (const next of out.get(id)) {
          if (state.get(next) === 1) { backEdges.add(id + '->' + next); continue }
          if (!state.get(next)) visit(next)
        }
        state.set(id, 2)
        order.push(id)
      }
      for (const n of nodes) if (!state.get(n.id)) visit(n.id)
      const level = new Map(nodes.map((n) => [n.id, 0]))
      for (let i = order.length - 1; i >= 0; i -= 1) {
        const id = order[i]
        for (const next of out.get(id)) {
          if (backEdges.has(id + '->' + next)) continue
          if (level.get(next) < level.get(id) + 1) level.set(next, level.get(id) + 1)
        }
      }
      const columns = new Map()
      for (const n of nodes) {
        const L = level.get(n.id)
        if (!columns.has(L)) columns.set(L, [])
        columns.get(L).push(n)
      }
      const levels = [...columns.keys()].sort((a, b) => a - b)
      const maxRows = Math.max(1, ...levels.map((L) => columns.get(L).length))
      const rowIndex = new Map()
      const original = new Map(nodes.map((n, i) => [n.id, i]))
      // 列内排序：先按前驱重心（正向），再按后继重心（反向），再正向收敛一次。
      // 单向一遍只能消掉「同层内」的交叉；往返两遍能显著改善。
      const orderPass = (direction) => {
        const sequence = direction === 'back' ? [...levels].reverse() : levels
        for (const L of sequence) {
          const list = columns.get(L)
          const refs = direction === 'back' ? out : inc
          const barycenter = (id) => {
            const known = refs.get(id).map((r) => rowIndex.get(r)).filter((v) => v !== undefined)
            if (!known.length) return original.get(id)
            return known.reduce((sum, v) => sum + v, 0) / known.length
          }
          list.sort((p, q) => (barycenter(p.id) - barycenter(q.id)) || (original.get(p.id) - original.get(q.id)))
          list.forEach((n, i) => { rowIndex.set(n.id, i) })
        }
      }
      orderPass('forward')
      orderPass('back')
      orderPass('forward')
      for (const L of levels) {
        const list = columns.get(L)
        list.forEach((n, i) => {
          n.x = pad + L * col
          n.y = pad + (i + (maxRows - list.length) / 2) * row
        })
      }
      return nodes
    }

    /** 连线样式（工具条可切换；默认平滑曲线）。 */
    const EDGE_STYLES = [
      { value: 'curve', label: '平滑曲线' },
      { value: 'step', label: '直角折线' },
      { value: 'straight', label: '直线' },
      { value: 'mindmap', label: '思维导图' },
    ]
    /** 生成一条边的 path：按当前样式给出曲线/折线/直线。 */
    function edgePathFor(a, b, style, lane, orientation) {
      const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5)
      if (style === 'straight') return `M ${a.x} ${a.y} L ${b.x} ${b.y}`
      if (style === 'step' && orientation === 'vertical') {
        // 竖排（步骤自上而下）：先竖直、再横移、再竖直 —— 与横向布局完全镜像。
        if (Math.abs(b.x - a.x) < 1) return `M ${a.x} ${a.y} L ${b.x} ${b.y}`
        const vmid = a.y + Math.max(30, (b.y - a.y) / 2) + (lane || 0)
        const vdir = b.x > a.x ? 1 : -1
        const vr = Math.min(10, Math.abs(b.x - a.x) / 2)
        return `M ${a.x} ${a.y} L ${a.x} ${vmid - vr} Q ${a.x} ${vmid} ${a.x + vdir * vr} ${vmid} L ${b.x - vdir * vr} ${vmid} Q ${b.x} ${vmid} ${b.x} ${vmid + vr} L ${b.x} ${b.y}`
      }
      if (style === 'step') {
        if (Math.abs(b.y - a.y) < 1) return `M ${a.x} ${a.y} L ${b.x} ${b.y}`
        const mid = a.x + Math.max(30, (b.x - a.x) / 2) + (lane || 0)
        const dir = b.y > a.y ? 1 : -1
        const r = Math.min(10, Math.abs(b.y - a.y) / 2)
        return `M ${a.x} ${a.y} L ${mid - r} ${a.y} Q ${mid} ${a.y} ${mid} ${a.y + dir * r} L ${mid} ${b.y - dir * r} Q ${mid} ${b.y} ${mid + r} ${b.y} L ${b.x} ${b.y}`
      }
      if (style === 'mindmap') {
        const k = Math.max(70, Math.abs(b.x - a.x) * 0.85)
        return `M ${a.x} ${a.y} C ${a.x + k} ${a.y}, ${b.x - k} ${b.y}, ${b.x} ${b.y}`
      }
      return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`
    }

    /** 整条流程线的主色盘：深底可读、彼此可分；超过 8 条流程循环使用。 */
    const FLOW_PALETTE = ['#62d6a4', '#6ea8fe', '#c792ea', '#f78ca2', '#ffd166', '#4dd0e1', '#ffa94d', '#b197fc']
    /** 箭头动画开关：auto 跟随系统「减少动态效果」，on 始终滚动，off 静止。 */
    function edgeMotionEnabled(mode, reduced) {
      const value = mode || 'auto'
      if (value === 'on') return true
      if (value === 'off') return false
      return !reduced
    }
    const EDGE_MOTIONS = [
      { value: 'auto', label: '跟随系统动态效果' },
      { value: 'on', label: '始终流动（忽略系统动态效果）' },
      { value: 'off', label: '静止不动' },
    ]
    /** 居中偏移：count 条里第 index 条的对称偏移（跨度 span）。锚点扇形与折线分道共用。 */
    function centeredOffset(index, count, span) {
      if (!(count > 1) || !(span > 0)) return 0
      return -span / 2 + (index * span) / (count - 1)
    }

    /**
     * 按「整条流程线」给边着色，让一条线的进→出能一眼跟到底：
     * - 节点顺序按画布从左到右（x，再次 y、id）确定，保证确定性；
     * - 没有上游颜色的节点（源），每条出边各取一个调色板颜色 —— 扇出即分色；
     * - 已有上游颜色的节点，其全部出边继承同色 —— 一条流程线中途换列也不换色；
     * - 到汇合点时**先到者得色**，后来的支线保持自己的颜色，所以合并前后也可追踪。
     */
    function flowEdgeColors(nodes, edges) {
      const order = [...nodes].sort((p, q) => (p.x - q.x) || (p.y - q.y) || String(p.id).localeCompare(String(q.id))).map((n) => n.id)
      const out = new Map()
      for (const e of edges) {
        const s = e.from === undefined ? e.source : e.from
        if (!out.has(s)) out.set(s, [])
        out.get(s).push(e)
      }
      const inbound = new Map()
      const colors = new Map()
      const seen = new Set()
      let next = 0
      for (const id of order) {
        if (seen.has(id)) continue
        seen.add(id)
        const inherited = inbound.get(id)
        for (const e of out.get(id) || []) {
          const color = inherited || FLOW_PALETTE[next++ % FLOW_PALETTE.length]
          colors.set(e.id, color)
          const target = e.to === undefined ? e.target : e.to
          if (!inbound.has(target)) inbound.set(target, color)
        }
      }
      return colors
    }

    function PlanningCandidateDiagram({ architecture }) {
      const placed = architecture.nodes.map((node) => ({ id: node.id, x: 0, y: 0, node }))
      autoArrangeGraph(placed, architecture.edges.map((edge) => ({ from: edge.from, to: edge.to })), 'architecture', { col: 250, row: 94, pad: 14 })
      const positions = new Map(placed.map((node) => [node.id, { x: node.x, y: node.y }]))
      const width = Math.max(120, ...placed.map((node) => node.x)) + 228 + 14
      const height = Math.max(120, ...placed.map((node) => node.y)) + 74 + 14
      return h('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'AI 规划架构流程图', style: { display: 'block', width: '100%', maxHeight: 360, border: '1px solid var(--dsw-alias-border-l1, #666)', borderRadius: 8, marginBottom: 12 } },
        ...architecture.edges.map(edge => {
          const from = positions.get(edge.from), to = positions.get(edge.to)
          if (!from || !to) return null
          return h('path', { key: edge.id, d: `M${from.x + 228},${from.y + 38} C${from.x + 260},${from.y + 38} ${to.x - 30},${to.y + 38} ${to.x},${to.y + 38}`, fill: 'none', stroke: colorOfArchEdge(edge.kind), strokeWidth: 2 })
        }),
        ...architecture.nodes.map(node => {
          const at = positions.get(node.id)
          return h('g', { key: node.id, transform: `translate(${at.x},${at.y})` },
            h('rect', { width: 228, height: 74, rx: 8, fill: 'var(--dsw-alias-bg-layer-2, #272d36)', stroke: 'var(--dsw-alias-border-l2, #6f7885)' }),
            h('text', { x: 12, y: 24, fill: 'var(--dsw-alias-label-primary, #eee)', fontSize: 14 }, summary(node.title, 16)),
            h('text', { x: 12, y: 48, fill: 'var(--dsw-alias-label-secondary, #abb5c3)', fontSize: 12 }, summary(node.responsibility, 22)))
        }))
    }

    function LoomOverlay() {
      useSeat()
      const box = React.useRef(null)
      React.useEffect(() => {
        if (!seat.open) return
        const previous = document.activeElement
        const close = () => { seat.open = false; notifySeat(); previous?.focus?.() }
        const keyboard = event => {
          if (event.key === 'Escape') { event.preventDefault(); close() }
          if (event.key === 'Tab') {
            const controls = [...(box.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]') || [])]
            if (!controls.length) return
            if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1).focus() }
            else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus() }
          }
        }
        box.current?.querySelector('button')?.focus()
        document.addEventListener('keydown', keyboard)
        return () => { document.removeEventListener('keydown', keyboard); previous?.focus?.() }
      }, [seat.open])
      if (!seat.open) return h(NewSessionLoomAction)
      return h('div', { 'data-loom-window': '', 'data-loom-fullscreen': String(seat.fullscreen), style: { position: 'fixed', inset: 'var(--dsh-frame-chrome-top, var(--dsh-frame-top-clearance, 0px)) 0 0', zIndex: 900, pointerEvents: 'auto', padding: seat.fullscreen ? 0 : 'clamp(8px, 2vw, 24px)', background: 'rgba(0, 0, 0, .4)', display: 'flex' } },
        h('section', { ref: box, role: 'dialog', 'aria-modal': true, 'aria-label': '可视化规划模式', style: { width: '100%', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRadius: seat.fullscreen ? 0 : 12, background: 'var(--dsw-alias-bg-layer-1, #202329)', color: 'var(--dsw-alias-label-primary, #eee)', boxShadow: seat.fullscreen ? 'none' : '0 20px 70px rgba(0,0,0,.3)' } },
          h('div', { style: { flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 16px', background: 'var(--dsw-alias-bg-layer-1, #202329)', borderBottom: '1px solid var(--dsw-alias-border-l1, #666)' } },
            h('strong', null, '可视化规划模式'),
            h('div', { style: { display: 'flex', gap: 8 } },
              h('button', { type: 'button', 'aria-pressed': seat.fullscreen, disabled: seat.workbenchBusy || seat.entryBusy, onClick: () => { seat.fullscreen = !seat.fullscreen; notifySeat() } }, seat.fullscreen ? '还原窗口' : '全屏工作台'),
              h('button', { type: 'button', onClick: () => { seat.open = false; notifySeat() } }, '返回会话'))),
          h('div', { 'data-loom-window-body': '', style: { flex: 1, minHeight: 0, overflow: seat.canvasOnly ? 'hidden' : 'auto', padding: 16 } }, h(LoomWorkbench))))
    }

    /** Settings has no graph, session retention, or model submission lifecycle. */
    function LoomSettings() {
      useSeat()
      const [config, setConfig] = React.useState(seat.config)
      const [problem, setProblem] = React.useState('')
      const [retry, setRetry] = React.useState(0)
      const [diagnostic, setDiagnostic] = React.useState(null)
      const [diagnosticError,setDiagnosticError]=React.useState('')
      const [busy, setBusy] = React.useState(false)
      const mounted = React.useRef(false)
      React.useEffect(() => {
        injectCss(); mounted.current = true; setProblem('');setDiagnosticError('')
        requestJSON(API,'/diagnostics').then(value=>{if(mounted.current)setDiagnostic(value)}).catch(error=>{if(mounted.current)setDiagnosticError(error.message)})
        requestJSON(API, '/config').then(value => {
          if (!mounted.current) return
          setConfig(value); seat.config = value; notifySeat()
        }).catch(error => { if (mounted.current) setProblem(error.message) })
        return () => { mounted.current = false }
      }, [retry])
      const update = async patch => {
        if (busy) return
        setBusy(true); setProblem('')
        try {
          const value = await requestJSON(API, '/config', { method: 'POST', body: patch })
          seat.config = value; notifySeat()
          if (mounted.current) setConfig(value)
          // 规划模式开关与欢迎题词都在别的插槽里，靠这个事件实时跟随设置。
          try { window.dispatchEvent(new CustomEvent('loom:config-changed', { detail: value })) } catch { /* 无 CustomEvent 环境忽略 */ }
        } catch (error) { if (mounted.current) setProblem(error.message) }
        finally { if (mounted.current) setBusy(false) }
      }
      return h('div', { 'data-loom-root': '', 'data-loom-surface': 'settings', 'data-laurel-module': '' },
        h('strong', { className: 'lc-embedded-heading' }, 'Loom 设置'),
        h('p', { className: 'loom-note lc-embedded-description' }, `v${CLIENT_VERSION} · 使用 Harness 原生会话与子代理，无需安装其他插件。`),
        h('p', null, '编辑流程图：回到项目会话，点击标题栏的「Loom」入口。工作台支持全屏和专注画布。'),
        problem ? h('p', { className: 'loom-error', role: 'alert' }, problem) : null,
        diagnosticError?h('p',{role:'alert',className:'loom-warning'},'诊断读取失败：'+diagnosticError+'。旧后台可能尚未重启。',h('button',{type:'button',onClick:()=>setRetry(n=>n+1)},'重新读取诊断')):null,
        diagnostic ? h('div',{'data-loom-diagnostics':'',role:'status'},h('p',null,`已安装 ${diagnostic.installedVersion || '未知'} · 后台已加载 ${diagnostic.loadedVersion || '未知'} · 前端 ${CLIENT_VERSION}`),...(diagnostic.recommendations || []).map((message,i)=>h('p',{key:i,className:'loom-warning'},message)),diagnostic.loadedVersion&&diagnostic.loadedVersion!==CLIENT_VERSION?h('p',{className:'loom-warning'},'前后台版本不同，请完全退出并重新打开 Harness。'):null) : null,
        config ? h('div', { className: 'loom-settings-fields', 'aria-busy': busy },
          h('label', null, h('input', { type: 'checkbox', checked: config.enabled, disabled: busy, onChange: e => update({ enabled: e.target.checked }) }), ' 启用 Loom（总开关）'),
          h('label', null, '默认模式 ', h('select', { value: config.defaultMode, disabled: busy, onChange: e => update({ defaultMode: e.target.value }) }, h('option', { value: 'auto' }, '自动读取并预览'), h('option', { value: 'manual' }, '手动调整与预览'))),
          h('label', null, '默认并行任务 ', h('select', { value: config.defaultMaxConcurrency, disabled: busy, onChange: e => update({ defaultMaxConcurrency: Number(e.target.value) }) }, ...[1, 2, 3].map(n => h('option', { key: n, value: n }, `${n} 个`)))),
          h('label',null,'验收失败后最多修复 ',h('select',{value:config.maxRepairRounds??1,disabled:busy,onChange:e=>update({maxRepairRounds:Number(e.target.value)})},...[0,1,2,3].map(n=>h('option',{key:n,value:n},n+' 轮')))),
          h('label', null, h('input', { type: 'checkbox', checked: config.autoCollectReplies, disabled: busy, onChange: e => update({ autoCollectReplies: e.target.checked }) }), ' 读取本次完整 AI 回复'),
          h('label', null, h('input', { type: 'checkbox', checked: config.injectDraftSummary, disabled: busy, onChange: e => update({ injectDraftSummary: e.target.checked }) }), ' 向已启用会话注入当前草案摘要'),
          h('label', null, h('input', { type: 'checkbox', checked: config.edgeArrows !== false, disabled: busy, onChange: e => update({ edgeArrows: e.target.checked }) }), ' 画布连线显示方向箭头'),
          h('label', null, '箭头流动 ', h('select', { value: config.edgeMotion || 'auto', disabled: busy || config.edgeArrows === false, onChange: e => update({ edgeMotion: e.target.value }) },
            EDGE_MOTIONS.map((motion) => h('option', { key: motion.value, value: motion.value }, motion.label)))),
          h('label', null, h('input', { type: 'checkbox', checked: config.planningModeDefault === true, disabled: busy, onChange: e => update({ planningModeDefault: e.target.checked }) }), ' 新会话默认开启规划模式（该会话手动改过之后以会话为准）'),
          h('p', { className: 'loom-note', style: { marginTop: 10 } }, '外观'),
          h('p', { className: 'loom-note', 'data-loom-injection-status': '' },
            '注入状态 · 规划模式整框发光：' + appearanceInjectionText(appearanceStatus.composerGlow) +
            '；欢迎页题词：' + appearanceInjectionText(appearanceStatus.welcomeLine)),
          h('p', { className: 'loom-note' }, '显示「未找到目标」说明宿主页面结构变了（多见于宿主升级）。这两处都是静默注入，失败不影响其它功能；排查：确认该会话聊天框已渲染、新会话页已打开，然后回到这里再看一次。'),
          h('label', null, '规划模式颜色 ', h('input', { type: 'color', value: config.planningModeColor || '#6ea8fe', disabled: busy, onChange: e => update({ planningModeColor: e.target.value }) })),
          h('div', { className: 'loom-swatches' },
            ...PLANNING_SWATCHES.map(color => h('button', {
              key: color, type: 'button', className: 'loom-plan-swatch', disabled: busy,
              style: { background: color, outline: (config.planningModeColor || '').toLowerCase() === color ? '2px solid #ffffff' : 'none' },
              title: color, onClick: () => update({ planningModeColor: color }),
            }))),
          h('label', null, h('input', { type: 'checkbox', checked: config.welcomeEnabled !== false, disabled: busy, onChange: e => update({ welcomeEnabled: e.target.checked }) }), ' 欢迎页题词（欢迎使用可视化规划模式）'),
          h('label', null, '题词字体 ', h('input', { className: 'loom-input', type: 'text', value: config.welcomeFont || 'inherit', disabled: busy || config.welcomeEnabled === false, onChange: e => update({ welcomeFont: e.target.value }) })),
          h('label', null, '题写字号 ', h('input', { className: 'loom-input', type: 'number', min: 12, max: 28, value: config.welcomeFontSize ?? 16, disabled: busy || config.welcomeEnabled === false, onChange: e => update({ welcomeFontSize: Number(e.target.value) }) })),
          h('label', null, '题词颜色 ', h('input', { type: 'color', value: config.welcomeColor || '#e6e8ea', disabled: busy || config.welcomeEnabled === false, onChange: e => update({ welcomeColor: e.target.value }) })),
          h('label', null, '题词发光 ', h('select', { className: 'loom-select', value: config.welcomeGlow ?? 1, disabled: busy || config.welcomeEnabled === false, onChange: e => update({ welcomeGlow: Number(e.target.value) }) }, ...[0, 1, 2, 3].map(n => h('option', { key: n, value: n }, n === 0 ? '无' : '级别 ' + n)))),
          h('label', null, '题词描边 ', h('select', { className: 'loom-select', value: config.welcomeStroke ?? 0, disabled: busy || config.welcomeEnabled === false, onChange: e => update({ welcomeStroke: Number(e.target.value) }) }, ...[0, 1, 2].map(n => h('option', { key: n, value: n }, n === 0 ? '无' : n + 'px')))),
          h('label', null, '描边颜色 ', h('input', { type: 'color', value: config.welcomeStrokeColor || '#0b0d10', disabled: busy || config.welcomeEnabled === false, onChange: e => update({ welcomeStrokeColor: e.target.value }) })),
          h('div', { className: 'loom-appearance-preview', 'data-loom-preview': 'appearance' },
            h('p', { className: 'loom-note' }, '预览（改设置即时生效）'),
            config.welcomeEnabled === false
              ? h('p', { className: 'loom-note' }, '题词已关闭')
              : h('div', { className: 'loom-welcome-line', style: welcomeLineStyle(config) }, '欢迎使用可视化规划模式'),
            h('div', null,
              h('span', { className: 'loom-note' }, '规划模式输入框 '),
              h('span', { className: 'loom-plan-preview', style: { borderColor: config.planningModeColor || '#6ea8fe', boxShadow: '0 0 20px ' + (config.planningModeColor || '#6ea8fe') + '66, inset 0 0 22px ' + (config.planningModeColor || '#6ea8fe') + '2e' } }, 'AI 输入框示意'),)),

          h('p', { className: 'loom-note' }, '总开关控制插件行为；每个会话在工作台中单独启用。自动模式读取并预览，采纳与开工仍由你决定。')) : problem ? h('button', { type: 'button', onClick: () => setRetry(n => n + 1) }, '重新读取设置') : h('p', { role: 'status' }, '读取插件设置中…'))
    }

    /* ================================================================== *
     * 4. 手写画布：DOM + SVG
     *
     *    结构：
     *      host
     *        └ .viewport（裁剪 + 处理指针/滚轮）
     *            └ .world（transform: translate + scale）
     *                ├ svg.edges   （贝塞尔连线 + 拖拽预览线）
     *                ├ .nodes      （节点卡片，绝对定位）
     *                └ .frames     （分组框，只影响展示）
     *            └ svg.minimap（右下角）
     *
     *    不变量：布局只活在画布内部，语义改动一律回调出去由后端校验。
     * ================================================================== */
    function mountCanvas(host, cb) {
      const doc = host.ownerDocument
      const el = (tag, cls, parent) => {
        const node = doc.createElement(tag)
        if (cls) node.className = cls
        if (parent) parent.appendChild(node)
        return node
      }
      const svgEl = (tag, attrs, parent) => {
        const node = doc.createElementNS('http://www.w3.org/2000/svg', tag)
        for (const k in attrs) node.setAttribute(k, String(attrs[k]))
        if (parent) parent.appendChild(node)
        return node
      }

      const viewport = el('div', 'loom-viewport', host)
      const world = el('div', 'loom-world', viewport)
      /** 流程泳道层：在连线与卡片之下，跟着世界一起平移缩放。 */
      const laneLayer = el('div', 'loom-lanes', world)
      let flowLanes = null
      /** 画布上方浮层（流程工具条）的实测高度：取景时留出这段，免得压住第一条泳道。 */
      let flowInset = 0
      const edgeSvg = svgEl('svg', { class: 'loom-edges' }, world)
      /**
       * 箭头定义。**架构允许双向关系**，而双向不能只靠文案表达 ——
       * 画布上必须看得出「这两个模块互相依赖」。所以两种箭头各定义一个 marker:
       * 终点箭头（所有边）与起点箭头（双向边的起点端）。
       *
       * ⚠ 单独放一个 <svg class="loom-arrow-defs">，**不放进 edgeSvg**。
       * renderEdges() 每帧会清空 edgeSvg 再重铺 path；若 defs 在里面，
       * 每帧都会被删掉，箭头随之消失（而且不报错，只是「看起来没箭头」）。
       * 分开之后，清 path 永远碰不到 marker 定义。
       */
      const ARROW_END_ID = 'loom-arrow-end'
      const ARROW_START_ID = 'loom-arrow-start'
      const arrowDefsSvg = svgEl('svg', { class: 'loom-arrow-defs', width: 0, height: 0 }, world)
      const defs = svgEl('defs', {}, arrowDefsSvg)
      const arrowMarker = (id, refX, orientRef) => {
        const m = svgEl('marker', {
          id, viewBox: '0 0 10 10', refX, refY: 5,
          markerWidth: 6, markerHeight: 6, orient: 'auto', markerUnits: 'strokeWidth',
        }, defs)
        // context-stroke 让箭头跟着线自己的颜色走（一条双向边两种颜色也不串）。
        svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'context-stroke' }, m)
        // 起点箭头方向与终点相反，用原生 auto-start-reverse 让它自动翻转。
        if (orientRef) m.setAttribute('orient', orientRef)
      }
      arrowMarker(ARROW_END_ID, 9, null)
      arrowMarker(ARROW_START_ID, 1, 'auto-start-reverse')
      const nodeLayer = el('div', 'loom-nodes', world)
      const frameLayer = el('div', 'loom-frames', world)
      const marquee = el('div','loom-marquee',world)
      marquee.hidden=true
      const minimap = svgEl('svg', { class: 'loom-minimap' }, viewport)
      const hint = el('div', 'loom-hint', viewport)

      let view = { x: 40, y: 30, k: 1 }
      let graph = { nodes: [], edges: [], shape: 'task' }
      let selected = null
      let picked = new Set(),spaceHeld=false
      const publishSelection=()=>{if(cb.onSelection)cb.onSelection([...picked])}
      const groupBounds=g=>{
        const members=graph.nodes.filter(n=>g.memberIds.includes(n.id))
        if(!members.length)return null
        return {id:g.id,x:Math.min(...members.map(n=>n.x))-18,y:Math.min(...members.map(n=>n.y))-30,
          right:Math.max(...members.map(n=>n.x+NODE_W))+18,bottom:Math.max(...members.map(n=>n.y+(cardHeights.get(n.id)||150)))+18}
      }
      let preview = null // 连线预览 { from:{x,y}, to:{x,y}, type }
      let drag = null // 节点拖拽或视口平移
      /** 拖拽期间全局禁用文字选择：否则指针越过卡片/面板文字会把它们选蓝。 */
      const blockSelection = (on) => { if (doc.body) doc.body.style.userSelect = on ? 'none' : '' }

      const applyView = () => {
        world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`
      }
      const toWorld = (clientX, clientY) => {
        const r = viewport.getBoundingClientRect()
        return { x: (clientX - r.left - view.x) / view.k, y: (clientY - r.top - view.y) / view.k }
      }
      /**
       * 端口锚点。
       *
       * 任务图端口按 artifactType 类型化，用端口下标定位；
       * 架构图节点没有类型化端口 —— 它只有「一个整体」，所以两侧各留一个
       * 固定的虚拟锚点（起点/终点）。把差异收在这一个函数里，渲染与交互
       * 两条路径就都不会各自去猜形状。
       */
      /** 卡片真实高度（renderNodes 量出来）：架构锚点按它垂直居中。 */
      const cardHeights = new Map()
      /** 端口栈整体下移量（内容比端口栈高时居中）：任务锚点必须与端口点一致。 */
      const portShift = new Map()
      const portAnchor = (nodeId, side, index, total) => {
        const n = graph.nodes.find((x) => x.id === nodeId)
        if (!n) return { x: 0, y: 0 }
        if (graph.shape === 'architecture') {
          const count = Math.max(1, total || 1)
          const height = cardHeights.get(nodeId) || 0
          const centre = height ? height / 2 : ARCH_ANCHOR_TOP
          const span = height ? Math.min(Math.max(0, height - 24), (count - 1) * 10) : Math.min(28, (count - 1) * 8)
          return { x: side === 'out' ? n.x + NODE_W : n.x, y: n.y + centre + centeredOffset(index || 0, count, span) }
        }
        const y = n.y + PORT_TOP + index * PORT_GAP + PORT_GAP / 2 + (portShift.get(nodeId) || 0)
        return { x: side === 'out' ? n.x + NODE_W : n.x, y }
      }

      /** 一条边在「任务图 / 架构图」里的端点解析。两者端点字段名不同。 */
      const edgeEnds = (e) =>
        graph.shape === 'architecture'
          ? { source: e.from, target: e.to }
          : { source: e.source, target: e.target }

      /** 边的语义颜色：任务图按产物类型，架构图按关系种类。 */
      const edgeColor = (e) =>
        graph.shape === 'architecture' ? colorOfArchEdge(e.kind) : colorOf(e.artifactType)

      /** 这一端在节点卡片上有没有真实的类型化端口圆点。架构图没有。 */
      const hasTypedPorts = () => graph.shape !== 'architecture'

      /* ---------- 渲染 ---------- */
      function renderEdges() {
        // 只清 path。箭头 marker 定义在**另一个** svg（loom-arrow-defs）里，
        // 不受这里影响 —— 若放在本 svg 内会被每帧清掉，箭头就没了。
        while (edgeSvg.firstChild) edgeSvg.removeChild(edgeSvg.firstChild)
        const paths = []
        const edgeStyle = graph.edgeStyle || 'curve'
        // 流程视图竖排时，折线要按竖直方向走（先竖再横），分道也沿竖直方向分。
        const routeOrientation = graph.flowOrientation === 'vertical' ? 'vertical' : 'horizontal'
        const corridorKey = (from, to) => (routeOrientation === 'vertical' ? (from.y + ':' + to.y) : ((from.x + NODE_W) + ':' + to.x))
        const flowColors = flowEdgeColors(graph.nodes, graph.edges)
        // 直角折线分道：同一走廊之间的多条边各走一条车道，避免叠在一起互相遮挡。
        const corridorTotals = new Map()
        const corridorSeen = new Map()
        if (edgeStyle === 'step') {
          for (const e of graph.edges) {
            const ends = edgeEnds(e)
            const from = graph.nodes.find((x) => x.id === ends.source)
            const to = graph.nodes.find((x) => x.id === ends.target)
            if (!from || !to) continue
            const key = corridorKey(from, to)
            corridorTotals.set(key, (corridorTotals.get(key) || 0) + 1)
          }
        }
        const fanOutIndex = new Map()
        const fanInIndex = new Map()
        const fanOutTotal = new Map()
        const fanInTotal = new Map()
        if (graph.shape === 'architecture') {
          for (const e of graph.edges) {
            fanOutTotal.set(e.from, (fanOutTotal.get(e.from) || 0) + 1)
            fanInTotal.set(e.to, (fanInTotal.get(e.to) || 0) + 1)
          }
        }
        for (const e of graph.edges) {
          const ends = edgeEnds(e)
          const from = graph.nodes.find((x) => x.id === ends.source)
          const to = graph.nodes.find((x) => x.id === ends.target)
          if (!from || !to) continue
          let ai = 0
          let bi = 0
          if (hasTypedPorts()) {
            const oi = (from.node.outputs || []).findIndex((p) => p.name === e.sourcePort)
            const ii = (to.node.inputs || []).findIndex((p) => p.name === e.targetPort)
            if (oi < 0 || ii < 0) continue
            ai = oi
            bi = ii
          }
          const fanNext = (map, key) => { const next = map.get(key) || 0; map.set(key, next + 1); return next }
          const a = portAnchor(ends.source, 'out', hasTypedPorts() ? ai : fanNext(fanOutIndex, ends.source), hasTypedPorts() ? 0 : fanOutTotal.get(ends.source) || 1)
          const b = portAnchor(ends.target, 'in', hasTypedPorts() ? bi : fanNext(fanInIndex, ends.target), hasTypedPorts() ? 0 : fanInTotal.get(ends.target) || 1)
          let lane = 0
          if (edgeStyle === 'step') {
            const key = routeOrientation === 'vertical' ? (from.y + ':' + to.y) : (a.x + ':' + b.x)
            const total = corridorTotals.get(key) || 1
            const index = corridorSeen.get(key) || 0
            corridorSeen.set(key, index + 1)
            lane = centeredOffset(index, total, Math.min(60, Math.max(0, (total - 1) * 7)))
          }
          // 架构允许**双向关系**：双向边两端都画箭头，单向边只画终点箭头。
          // 任务图的边没有 bidirectional 概念（它必须无环），永远只画终点箭头。
          const bidi = graph.shape === 'architecture' && Boolean(e.bidirectional)
          paths.push({
            d: edgePathFor(a, b, edgeStyle, lane, routeOrientation),
            color: flowColors.get(e.id) || edgeColor(e),
            bidi,
          })
        }
        if (preview && graph.shape !== 'architecture') {
          const a = preview.from
          const b = preview.to
          paths.push({ d: edgePathFor(a, b, edgeStyle), color: colorOf(preview.type), dashed: true, bidi: false })
        }
        const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
        // 拖拽/连线预览期间不铺动画箭头：每帧重建会让箭头不断「跳回起点」。
        // 箭头动画跟随用户选择：跟随系统 / 始终滚动 / 静止（后者无视系统偏好）。
        const showArrows = graph.edgeArrows !== false
        const animate = showArrows && edgeMotionEnabled(graph.edgeMotion, reducedMotion) && !drag && !preview && paths.filter((p) => !p.dashed).length <= 80
        let pathIndex = 0
        for (const p of paths) {
          // 底晕：同路径加粗、低透明度 —— 比滤镜便宜，缩放平移也稳定。
          svgEl('path', {
            d: p.d,
            fill: 'none',
            stroke: p.color,
            'stroke-width': p.dashed ? 4 : 7,
            'stroke-linecap': 'round',
            opacity: p.dashed ? 0.12 : 0.16,
          }, edgeSvg)
          const path = svgEl('path', {
            d: p.d,
            fill: 'none',
            stroke: p.color,
            'stroke-width': 1.6,
            'stroke-dasharray': p.dashed ? '5 4' : 'none',
            // 双向边加起点箭头（marker-start）；所有边都有终点箭头。
            // 这两条属性就是「允许合法双向关系」在画布上的可见证据。
            'marker-end': 'url(#' + ARROW_END_ID + ')',
            'marker-start': p.bidi ? 'url(#' + ARROW_START_ID + ')' : 'none',
            'data-bidi': p.bidi ? 'true' : 'false',
            opacity: p.dashed ? 0.9 : 0.85,
          }, edgeSvg)
          if (p.dashed || !showArrows) continue
          let length = 0
          try { length = path.getTotalLength() || 0 } catch { length = 0 }
          if (!length) continue
          // V 形箭头：尺寸按世界坐标固定，随画布缩放一起放大缩小。
          const chevron = 'M -4.6 -5.2 L 3.2 0 L -4.6 5.2'
          const paint = (carrier) => svgEl('path', { d: chevron, fill: 'none', stroke: p.color, 'stroke-width': 2.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, carrier)
          if (animate) {
            // 滚动小箭头：V 形沿路径匀速流动，方向就是数据流方向（出 → 进）。
            const pathId = 'loom-edge-track-' + (pathIndex++)
            path.setAttribute('id', pathId)
            const dur = Math.min(12, Math.max(3.5, length / 70))
            const arrows = length > 300 ? 3 : length > 150 ? 2 : 1
            for (let k = 0; k < arrows; k += 1) {
              const carrier = svgEl('g', { opacity: 1, 'pointer-events': 'none' }, edgeSvg)
              paint(carrier)
              const motion = doc.createElementNS('http://www.w3.org/2000/svg', 'animateMotion')
              motion.setAttribute('dur', dur.toFixed(2) + 's')
              motion.setAttribute('repeatCount', 'indefinite')
              motion.setAttribute('rotate', 'auto')
              motion.setAttribute('begin', (-(dur * k) / arrows).toFixed(2) + 's')
              const track = doc.createElementNS('http://www.w3.org/2000/svg', 'mpath')
              track.setAttribute('href', '#' + pathId)
              motion.appendChild(track)
              carrier.appendChild(motion)
            }
          } else {
            // 静止兜底：不动效（系统偏好/拖拽中/图太大）时也在路径上摆箭头，方向依然可读。
            const spots = length > 260 ? [0.4, 0.72] : [0.55]
            for (const t of spots) {
              const at = path.getPointAtLength(length * t)
              const ahead = path.getPointAtLength(Math.min(length, length * t + 12))
              const deg = Math.atan2(ahead.y - at.y, ahead.x - at.x) * 180 / Math.PI
              const carrier = svgEl('g', { opacity: 1, 'pointer-events': 'none', transform: 'translate(' + at.x.toFixed(1) + ' ' + at.y.toFixed(1) + ') rotate(' + deg.toFixed(1) + ')' }, edgeSvg)
              paint(carrier)
            }
          }
        }
      }

      function renderNodes() {
        while (nodeLayer.firstChild) nodeLayer.removeChild(nodeLayer.firstChild)
        for (const n of graph.nodes) {
          const card = el('div', 'loom-node', nodeLayer)
          card.style.left = n.x + 'px'
          card.style.top = n.y + 'px'
          card.style.width = NODE_W + 'px'
          if (n.id === selected || picked.has(n.id)) card.classList.add('is-selected')
          card.setAttribute('aria-selected',String(n.id===selected||picked.has(n.id)))
          card.tabIndex=0
          card.addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();selected=n.id;if(ev.shiftKey){picked.has(n.id)?picked.delete(n.id):picked.add(n.id)}else picked=new Set([n.id]);cb.onSelect?.(n.id);publishSelection();renderNodes()}})
          if (n.issues && n.issues.length) card.classList.add('has-issue')
          // 架构节点可以被用户锁定（locked）：模型不得改它。
          // 锁是**语义状态**，必须在画布上看得出来，不能只藏在右侧面板里 ——
          // 否则用户会以为「这个模块没人锁」，而模型其实动不了它。
          if (n.node && n.node.locked) card.classList.add('is-locked')
          card.dataset.nodeId = n.id

          const head = el('div', 'loom-node-head', card)
          const title = el('span', 'loom-node-title', head)
          title.textContent = n.node.title
          if(n.members?.length){const agents=el('div','loom-node-agents',card);for(const member of n.members){const chip=el('span','loom-chip',agents);chip.textContent=member.label;chip.dataset.loomAgent=member.id;chip.draggable=true;chip.tabIndex=0;chip.title='拖到另一模块，为它指定负责人';chip.addEventListener('dragstart',ev=>{ev.dataTransfer.setData('application/x-loom-member',member.id);ev.dataTransfer.effectAllowed='copyMove'})}}
          card.addEventListener('dragover',ev=>{if(ev.dataTransfer?.types.includes('application/x-loom-member'))ev.preventDefault()})
          card.addEventListener('drop',ev=>{const member=ev.dataTransfer?.getData('application/x-loom-member');if(member){ev.preventDefault();ev.stopPropagation();cb.onAgentDrop?.(member,n.id)}})
          if(n.team){const tag=el('div','loom-flow-group-tag',card);tag.textContent=n.team;tag.setAttribute('data-loom-task-team',n.team)}
          const kind = el('span', 'loom-node-kind', head)
          kind.textContent =
            graph.shape === 'architecture'
              ? ARCH_KIND_LABELS[n.node.kind] || n.node.kind
              : KIND_LABELS[n.node.kind] || n.node.kind
          if (n.node && n.node.locked) {
            const lock = el('span', 'loom-lock', head)
            lock.textContent = '[锁定]'
            lock.title = '已锁定：模型不得修改这个模块（可在右侧通过会话命令解除冻结）'
          }

          const body = el('div', 'loom-node-body', card)

          if (graph.shape === 'architecture') {
            /* 架构节点：显示责任摘要与接口，不显示「隔离/阶段」这类任务字段。
               responsibility 是必填全文，卡片上只截前一段 —— 全文在右侧面板。 */
            const meta = el('div', 'loom-node-meta', body)
            meta.textContent = '责任：' + summary(n.node.responsibility)
            const ifaces = n.node.interface || []
            if (ifaces.length) {
              const chips = el('div', 'loom-chips', body)
              for (const it of ifaces) {
                const chip = el('span', 'loom-chip', chips)
                chip.textContent = it
                chip.style.borderColor = '#b197fc'
                chip.style.color = '#b197fc'
              }
            }
            const refs = n.node.sourceRefs || []
            if (refs.length) {
              const src = el('div', 'loom-node-scope', body)
              src.textContent = '出处 ' + refs.join('、')
            }
            if (n.issues && n.issues.length) {
              const bad = el('div', 'loom-node-issue', body)
              bad.textContent = `${n.issues.length} 条校验问题`
            }
            card.dataset.archKind = n.node.kind
            continue
          }

          const meta = el('div', 'loom-node-meta', body)
          meta.textContent = `${STAGE_LABELS[n.node.phase] || n.node.phase} · 隔离 ${n.node.execution.isolation}`

          const chips = el('div', 'loom-chips', body)
          for (const p of n.node.outputs || []) {
            const chip = el('span', 'loom-chip', chips)
            chip.textContent = p.name
            chip.style.borderColor = colorOf(p.artifactType)
            chip.style.color = colorOf(p.artifactType)
            chip.title = labelOf(p.artifactType)
          }
          const writes = (n.node.ownership && n.node.ownership.writes) || []
          if (writes.length) {
            const scope = el('div', 'loom-node-scope', body)
            scope.textContent = '范围 ' + writes.join('、')
          }
          if (n.issues && n.issues.length) {
            const bad = el('div', 'loom-node-issue', body)
            bad.textContent = `${n.issues.length} 条校验问题`
          }

          /* 端口：左侧输入、右侧输出，各自绝对定位 */
          const inputs = n.node.inputs || []
          const outputs = n.node.outputs || []
          const dots = []
          inputs.forEach((p, i) => {
            const dot = el('div', 'loom-port loom-port-in', card)
            dot.style.top = PORT_TOP + i * PORT_GAP + 'px'
            dot.style.background = colorOf(p.artifactType)
            dot.title = `${p.name} · ${labelOf(p.artifactType)}${p.required ? '（必需）' : ''}`
            dot.dataset.port = `in:${p.name}`
            dot.dataset.node = n.id
            dot.dataset.type = p.artifactType
            dot.dataset.row = String(i)
            dots.push(dot)
          })
          outputs.forEach((p, i) => {
            const dot = el('div', 'loom-port loom-port-out', card)
            dot.style.top = PORT_TOP + i * PORT_GAP + 'px'
            dot.style.background = colorOf(p.artifactType)
            dot.title = `${p.name} · ${labelOf(p.artifactType)}`
            dot.dataset.port = `out:${p.name}`
            dot.dataset.node = n.id
            dot.dataset.type = p.artifactType
            dot.dataset.row = String(i)
            dots.push(dot)
          })
          /* 端口多、内容少时端口栈会排到卡片外（连线看着像"没对齐"）：
             卡片至少和端口栈一样高，并在卡片可用区里把端口栈垂直居中。
             锚点（portAnchor 的任务分支）加同一个 shift，两边必须一致。 */
          const rows = Math.max(inputs.length, outputs.length)
          if (rows) {
            const span = (rows - 1) * PORT_GAP
            const minHeight = PORT_TOP + span + 30
            if ((card.offsetHeight || 0) < minHeight) card.style.minHeight = minHeight + 'px'
            const height = Math.max(card.offsetHeight || 0, minHeight)
            const shift = Math.max(0, Math.round((height - minHeight) / 2))
            if (shift) for (const dot of dots) dot.style.top = PORT_TOP + Number(dot.dataset.row) * PORT_GAP + shift + 'px'
            portShift.set(n.id, shift)
          } else {
            portShift.set(n.id, 0)
          }
        }
        // 记录真实卡片高度：连线锚点要按它垂直居中（锚点挤在顶部会看着没对齐）。
        for (const n of graph.nodes) {
          const card = nodeLayer.querySelector(`[data-node-id="${n.id}"]`)
          cardHeights.set(n.id, card ? card.offsetHeight || 0 : 0)
        }
      }

      function renderFrames() {
        while (frameLayer.firstChild) frameLayer.removeChild(frameLayer.firstChild)
        // 分组是**布局**概念，只存在于任务图的 presentation 里。
        // 架构 revision 没有分组字段，所以架构视图不画分组框。
        if (graph.shape === 'architecture') return
        for (const g of graph.groups || []) {
          const members = graph.nodes.filter((n) => g.memberIds.indexOf(n.id) >= 0)
          if (!members.length) continue
          const minX = Math.min.apply(null, members.map((m) => m.x)) - 18
          const minY = Math.min.apply(null, members.map((m) => m.y)) - 30
          const maxX = Math.max.apply(null, members.map((m) => m.x + NODE_W)) + 18
          const maxY = Math.max.apply(null, members.map((m) => m.y + 150)) + 18
          const box = el('div', 'loom-frame', frameLayer)
          box.dataset.loomTeam=g.id
          box.style.left = minX + 'px'
          box.style.top = minY + 'px'
          box.style.width = maxX - minX + 'px'
          box.style.height = maxY - minY + 'px'
          const t = el('div', 'loom-frame-title', box)
          t.textContent = `${g.title} · ${members.length} 个节点`
          if(g.semanticTeam){t.style.pointerEvents='auto';t.tabIndex=0;t.setAttribute('role','button');t.setAttribute('aria-label','选择 '+g.title);const choose=ev=>{ev.stopPropagation();picked=new Set(g.memberIds);selected=null;cb.onSelect?.(null);publishSelection();renderNodes()};t.addEventListener('pointerdown',choose);t.addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();choose(ev)}})}
        }
      }

      function renderMinimap() {
        while (minimap.firstChild) minimap.removeChild(minimap.firstChild)
        minimap.style.display = graph.nodes.length ? '' : 'none'
        if (!graph.nodes.length) return
        const minX = Math.min.apply(null, graph.nodes.map((n) => n.x))
        const minY = Math.min.apply(null, graph.nodes.map((n) => n.y))
        const maxX = Math.max.apply(null, graph.nodes.map((n) => n.x + NODE_W))
        const maxY = Math.max.apply(null, graph.nodes.map((n) => n.y + 150))
        const w = 168
        const scale = w / Math.max(1, maxX - minX)
        const hgt = Math.max(40, Math.round((maxY - minY) * scale))
        minimap.setAttribute('viewBox', `${minX} ${minY} ${maxX - minX} ${maxY - minY}`)
        minimap.setAttribute('width', String(w))
        minimap.setAttribute('height', String(hgt))
        for (const n of graph.nodes) {
          svgEl('rect', {
            x: n.x, y: n.y, width: NODE_W, height: 150,
            rx: 6, fill: n.id === selected ? 'rgba(110,168,254,.55)' : 'rgba(128,128,128,.35)',
          }, minimap)
        }
      }

      const renderLanes = () => {
        while (laneLayer.firstChild) laneLayer.removeChild(laneLayer.firstChild)
        if (!flowLanes) return
        for (const lane of flowLanes) {
          const band = el('div', 'loom-lane', laneLayer)
          band.style.left = lane.x + 'px'
          band.style.top = lane.y + 'px'
          band.style.width = lane.width + 'px'
          band.style.height = lane.height + 'px'
          band.dataset.lane = lane.id
          const label = el('span', 'loom-lane-label', band)
          label.textContent = lane.label
          // 步骤先后按钮：泳道层是 pointer-events:none，按钮自己打开并吃掉事件，
          // 否则 mousedown 会被画布当成空白处拖拽（平移）。
          for (const move of lane.moves || []) {
            const button = el('button', 'loom-lane-move', label)
            button.type = 'button'
            button.textContent = move.glyph
            button.title = move.title
            button.dataset.laneMove = move.delta < 0 ? 'back' : 'forward'
            button.dataset.lane = lane.id
            // 只 stopPropagation：对 pointerdown 调 preventDefault 会连带压掉后续
            // 的 click（Chromium 的兼容鼠标事件），按钮就点不动了。
            button.addEventListener('pointerdown', (ev) => { ev.stopPropagation() })
            button.addEventListener('click', (ev) => {
              ev.stopPropagation(); ev.preventDefault()
              if (typeof lane.onMove === 'function') lane.onMove(move.delta)
            })
          }
        }
      }
      const renderAll = () => {
        renderLanes()
        renderFrames()
        renderNodes()
        renderEdges()
        renderMinimap()
      }
      const setHint = (text, kind) => {
        hint.textContent = text || ''
        hint.className = 'loom-hint' + (kind ? ' is-' + kind : '')
        hint.style.display = text ? 'block' : 'none'
      }

      function fit() {
        if (!graph.nodes.length) return
        const r = viewport.getBoundingClientRect()
        if (!r.width) return
        // 取景要把**泳道**算进去：流程视图里步骤栏标签（步骤名 + 步骤先后按钮）
        // 在栏的左上角，只按节点包围盒取景会把它推到可视区外面，用户点不到。
        const boxes = graph.nodes.map((n) => ({ x1: n.x, y1: n.y, x2: n.x + NODE_W, y2: n.y + 150 }))
        for (const lane of flowLanes || []) boxes.push({ x1: lane.x, y1: lane.y, x2: lane.x + lane.width, y2: lane.y + lane.height })
        const minX = Math.min.apply(null, boxes.map((b) => b.x1))
        const minY = Math.min.apply(null, boxes.map((b) => b.y1))
        const maxX = Math.max.apply(null, boxes.map((b) => b.x2))
        const maxY = Math.max.apply(null, boxes.map((b) => b.y2))
        // 流程工具条是压在画布上的浮层：取景必须给它留出上边距，否则第一条泳道
        // （含它的标签与按钮）会被压在浮层底下点不到。高度由 React 侧实测传入。
        const top = flowLanes ? Math.max(30, flowInset + 14) : 30
        const k = Math.min(1.2, Math.max(0.25, Math.min((r.width - 80) / (maxX - minX), (r.height - top - 40) / (maxY - minY))))
        view = { k, x: 40 - minX * k, y: top - minY * k }
        applyView()
      }

      /* ---------- 指针交互 ---------- */
      const onPointerDown = (ev) => {
        const t = ev.target
        if(t.closest?.('[data-loom-agent]'))return
        if (t.classList && t.classList.contains('loom-port')) {
          // 端口拖拽只属于任务图。架构图没有类型化端口：它的连线靠架构工具条
          // （选起点/终点）完成，因为架构关系的两端是**模块**，不是端口。
          if (graph.shape === 'architecture') return
          // 从端口拖出：只允许从输出端口发起（输入端口的方向由后端校验决定）
          if (String(t.dataset.port).indexOf('out:') !== 0) return
          const node = graph.nodes.find((n) => n.id === t.dataset.node)
          const oi = (node.node.outputs || []).findIndex((p) => p.name === String(t.dataset.port).slice(4))
          const from = portAnchor(t.dataset.node, 'out', oi, 0)
          preview = { from, to: toWorld(ev.clientX, ev.clientY), type: t.dataset.type, source: t.dataset.node, sourcePort: String(t.dataset.port).slice(4) }
          blockSelection(true)
          viewport.setPointerCapture(ev.pointerId)
          renderEdges()
          ev.preventDefault()
          return
        }
        const card = t.closest ? t.closest('.loom-node') : null
        if (card) {
          const id = card.dataset.nodeId
          selected = id
          if (cb.onSelect) cb.onSelect(id)
          if(ev.shiftKey||ev.ctrlKey||ev.metaKey){picked.has(id)?picked.delete(id):picked.add(id);publishSelection();renderNodes();ev.preventDefault();return}
          if(!picked.has(id))picked=new Set([id])
          publishSelection()
          const node = graph.nodes.find((n) => n.id === id)
          drag = { kind: 'node', id, start:toWorld(ev.clientX,ev.clientY),origins:graph.nodes.filter(n=>picked.has(n.id)).map(n=>({id:n.id,x:n.x,y:n.y})),targets:(graph.groups||[]).filter(g=>g.semanticTeam).map(groupBounds).filter(Boolean), dx: toWorld(ev.clientX, ev.clientY).x - node.x, dy: toWorld(ev.clientX, ev.clientY).y - node.y, moved: false }
          blockSelection(true)
          viewport.setPointerCapture(ev.pointerId)
          renderNodes()
          renderMinimap()
          ev.preventDefault()
          return
        }
        selected = null
        if (cb.onSelect) cb.onSelect(null)
        if(ev.button===1||spaceHeld||ev.altKey)drag = { kind: 'pan', x: ev.clientX, y: ev.clientY, ox: view.x, oy: view.y }
        else {drag={kind:'select',start:toWorld(ev.clientX,ev.clientY),seed:ev.shiftKey?[...picked]:[]};picked=new Set(drag.seed);marquee.hidden=false}
        blockSelection(true)
        viewport.setPointerCapture(ev.pointerId)
        renderNodes()
        renderMinimap()
        ev.preventDefault()
      }

      const onPointerMove = (ev) => {
        if (preview) {
          preview.to = toWorld(ev.clientX, ev.clientY)
          renderEdges()
          return
        }
        if (!drag) return
        if(drag.kind==='select') {
          const at=toWorld(ev.clientX,ev.clientY),x=Math.min(at.x,drag.start.x),y=Math.min(at.y,drag.start.y),right=Math.max(at.x,drag.start.x),bottom=Math.max(at.y,drag.start.y)
          Object.assign(marquee.style,{left:x+'px',top:y+'px',width:right-x+'px',height:bottom-y+'px'})
          picked=new Set([...drag.seed,...graph.nodes.filter(n=>n.x<right&&n.x+NODE_W>x&&n.y<bottom&&n.y+(cardHeights.get(n.id)||150)>y).map(n=>n.id)])
          renderNodes();return
        }
        if (drag.kind === 'pan') {
          view.x = drag.ox + (ev.clientX - drag.x)
          view.y = drag.oy + (ev.clientY - drag.y)
          applyView()
          return
        }
        const w = toWorld(ev.clientX, ev.clientY)
        const node = graph.nodes.find((n) => n.id === drag.id)
        if (!node) return
        const dx=w.x-drag.start.x,dy=w.y-drag.start.y
        if(Math.abs(dx)+Math.abs(dy)<3&&!drag.moved)return
        drag.moved = true
        for(const origin of drag.origins){const item=graph.nodes.find(n=>n.id===origin.id);if(!item)continue;item.x=Math.round(origin.x+dx);item.y=Math.round(origin.y+dy);const card=nodeLayer.querySelector(`[data-node-id="${item.id}"]`);if(card){card.style.left=item.x+'px';card.style.top=item.y+'px'}}
        renderEdges()
        renderFrames()
      }

      const onPointerUp = (ev) => {
        if(drag?.kind==='select'){marquee.hidden=true;selected=picked.size===1?[...picked][0]:null;cb.onSelect?.(selected);publishSelection();renderNodes()}
        if (preview) {
          const target = doc.elementFromPoint(ev.clientX, ev.clientY)
          const p = preview
          preview = null
          if (target && target.classList && target.classList.contains('loom-port') && String(target.dataset.port).indexOf('in:') === 0) {
            if (cb.onConnect) {
              cb.onConnect({
                source: p.source,
                sourcePort: p.sourcePort,
                target: target.dataset.node,
                targetPort: String(target.dataset.port).slice(3),
                sourceType: p.type,
              })
            }
          }
          renderEdges()
          blockSelection(false)
          return
        }
        if (drag && drag.kind === 'node' && drag.moved && cb.onLayoutChange) {
          const at=toWorld(ev.clientX,ev.clientY),target=drag.targets.filter(g=>at.x>=g.x&&at.x<=g.right&&at.y>=g.y&&at.y<=g.bottom).sort((a,b)=>(a.right-a.x)*(a.bottom-a.y)-(b.right-b.x)*(b.bottom-b.y))[0]
          if(ev.type!=='pointercancel'&&target&&cb.onGroupDrop)cb.onGroupDrop([...picked],target.id)
          else cb.onLayoutChange(graph.nodes.map((n) => ({ nodeId: n.id, x: n.x, y: n.y })))
        }
        drag = null
        blockSelection(false)
        // 拖拽期间为了不让箭头每帧「跳回起点」，renderEdges 走的是**静止兜底**分支
        // （animate=false）。松手后必须重铺一次，否则滚动箭头永远停在那儿 ——
        // 用户看到的就是「拖一下就再也不动了」。
        renderEdges()
      }

      const onWheel = (ev) => {
        ev.preventDefault()
        const r = viewport.getBoundingClientRect()
        const mx = ev.clientX - r.left
        const my = ev.clientY - r.top
        const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12
        const k = Math.min(2.5, Math.max(0.2, view.k * factor))
        view.x = mx - ((mx - view.x) / view.k) * k
        view.y = my - ((my - view.y) / view.k) * k
        view.k = k
        applyView()
      }

      viewport.addEventListener('pointerdown', onPointerDown)
      viewport.addEventListener('pointermove', onPointerMove)
      viewport.addEventListener('pointerup', onPointerUp)
      viewport.addEventListener('pointercancel', onPointerUp)
      viewport.addEventListener('wheel', onWheel, { passive: false })
      viewport.tabIndex=0
      const onKeyDown=ev=>{if(!host.contains(ev.target)||/INPUT|TEXTAREA|SELECT/.test(ev.target.tagName))return;if(ev.code==='Space'){spaceHeld=true;ev.preventDefault()}if(ev.key==='Escape'){picked.clear();selected=null;marquee.hidden=true;drag=null;blockSelection(false);publishSelection();cb.onSelect?.(null);renderNodes()}}
      const onKeyUp=ev=>{if(ev.code==='Space')spaceHeld=false}
      doc.addEventListener('keydown',onKeyDown);doc.addEventListener('keyup',onKeyUp)
      const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => renderMinimap()) : null
      resizeObserver?.observe(viewport)

      applyView()
      setHint('', null)

      return {
        setGraph(next) {
          graph = next
          renderAll()
        },
        /** 重新铺一遍当前图。切视图/换图源后由 React 层调用。 */
        redraw() {
          renderAll()
        },
        /** 当前画布画的是哪一种图（'task' / 'architecture'）。 */
        shape() {
          return graph.shape || 'task'
        },
        setHint,
        fit,
        /** 流程泳道（null 清除）。opts.topInset ＝ 画布上方浮层（流程工具条）的实测高度。 */
        setFlowLanes(lanes, opts) {
          flowLanes = Array.isArray(lanes) && lanes.length ? lanes : null
          flowInset = flowLanes && opts && Number.isFinite(opts.topInset) ? Math.max(0, opts.topInset) : 0
          renderLanes()
        },
        /** 批量设置节点坐标（流程分层铺位用）。 */
        setPositions(list) {
          const byId = new Map(graph.nodes.map((n) => [n.id, n]))
          for (const item of list || []) {
            const node = byId.get(item.nodeId)
            if (node) { node.x = item.x; node.y = item.y }
          }
          renderAll()
        },
        /** 当前节点坐标（流程顺序从摆位反推用）。 */
        nodePositions() {
          return graph.nodes.map((n) => ({ nodeId: n.id, x: n.x, y: n.y }))
        },
        /**
         * 自动排版：分层排布当前图、重绘并回到适配视图。
         * 位置只作用于客户端画布；任务图要落盘仍走「保存布局」。
         */
        autoArrange() {
          autoArrangeGraph(graph.nodes, graph.edges, graph.shape)
          renderAll()
          if (typeof cb.onLayoutChange === 'function') cb.onLayoutChange(graph.nodes.map((n) => ({ nodeId: n.id, x: n.x, y: n.y })))
          fit()
        },
        select(id) {
          selected = id
          picked=new Set(id?[id]:[])
          renderNodes()
          renderMinimap()
        },
        /**
         * 把一条已经通过端口/类型/单来源校验的连线**画进图里**。
         *
         * 评审 09 C：旧实现的 onConnect 只 setHint 一句「没有写进草案」，
         * 画布上什么都没变 —— 用户拖完以为连上了，其实图毫无变化。
         * 现在由调用方（React 层）在确认草案写入成功后调用这里，
         * 保证「画布看到的 = 草案里的」。
         *
         * `edge.unidirectional` 是一个**内部**标记：架构图里它表示这条线没有
         * 配对的反向线，画的时候要画箭头（单向调用与双向调用视觉上必须可区分）。
         * 它绝不写进数据模型 —— 架构边的真相只有 `bidirectional` 一个字段。
         */
        applyEdge(edge) {
          graph = { nodes: graph.nodes, edges: graph.edges.concat([edge]), groups: graph.groups, shape: graph.shape }
          renderEdges()
          renderMinimap()
        },
        addNodeCard(item) {
          graph = { nodes: graph.nodes.concat([item]), edges: graph.edges, groups: graph.groups, shape: graph.shape }
          renderAll()
        },
        removeNodeCard(nodeId) {
          const nextNodes = graph.nodes.filter((n) => n.id !== nodeId)
          const nextEdges = graph.edges.filter((e) => {
            const ends = graph.shape === 'architecture' ? { source: e.from, target: e.to } : { source: e.source, target: e.target }
            return ends.source !== nodeId && ends.target !== nodeId
          })
          graph = { nodes: nextNodes, edges: nextEdges, groups: graph.groups, shape: graph.shape }
          if (selected === nodeId) selected = null
          renderAll()
        },
        removeEdge(edgeId) {
          graph = { nodes: graph.nodes, edges: graph.edges.filter((e) => e.id !== edgeId), groups: graph.groups, shape: graph.shape }
          renderEdges()
          renderMinimap()
        },
        /** 当前画布上的布局（未落盘），供「保存布局」与撤销捕获坐标用。 */
        snapshotLayout() {
          return graph.nodes.map((n) => ({ nodeId: n.id, x: Math.round(n.x), y: Math.round(n.y) }))
        },
        destroy() {
          resizeObserver?.disconnect()
          viewport.removeEventListener('pointerdown', onPointerDown)
          doc.removeEventListener('keydown',onKeyDown);doc.removeEventListener('keyup',onKeyUp)
          viewport.removeEventListener('pointermove', onPointerMove)
          viewport.removeEventListener('pointerup', onPointerUp)
          viewport.removeEventListener('pointercancel', onPointerUp)
          viewport.removeEventListener('wheel', onWheel)
          if (host.contains(viewport)) host.removeChild(viewport)
        },
      }
    }

    /* ================================================================== *
     * 5. 样式（限定在 [data-loom-root] 下，不覆盖别的插件）
     * ================================================================== */
    const CSS = `
[data-loom-root]{display:grid;gap:10px;padding-bottom:24px;font-size:13px;min-width:0;container-type:inline-size}
[data-loom-inline-body] [data-loom-focus="true"] .loom-viewbar>.loom-bar{display:none}
[data-loom-inline-body] [data-loom-focus="true"] .loom-editbar{flex-wrap:nowrap;overflow-x:auto;flex-shrink:0;padding-bottom:6px}
[data-loom-inline-body] [data-loom-focus="true"] .loom-editbar>*{flex-shrink:0}
[data-loom-root] .loom-settings-fields{display:grid;gap:16px;padding-top:8px}
[data-loom-root][data-loom-focus="true"]{height:100%;min-height:0;display:flex;flex-direction:column;padding-bottom:0}
[data-loom-root][data-loom-focus="true"]>:not(.loom-main):not(.loom-viewbar):not(.loom-editbar):not(.loom-focus-banner):not(.loom-approvalbar):not([role="alert"]){display:none}
[data-loom-root][data-loom-focus="true"] .loom-main{flex:1;min-height:0;align-items:stretch;grid-template-columns:minmax(0,1fr)}
[data-loom-root][data-loom-focus="true"] .loom-stage{height:100%;min-height:0}
[data-loom-root][data-loom-focus="true"] .loom-main>aside{display:none!important}
[data-loom-root] :is(input,textarea,select){caret-color:var(--dsw-alias-label-primary,#eef0f3)}
[data-loom-root] ::selection{background:#285fc7;color:#fff}
[data-loom-root] :is(button,input,textarea,select,summary):focus-visible{outline:2px solid #6ea8fe;outline-offset:3px}
[data-loom-root]{--loom-panel-bg:#f3f5f7;--loom-input-bg:#fff;--loom-panel-fg:#17212e}
body[data-ds-dark-theme] [data-loom-root]{--loom-panel-bg:#252a32;--loom-input-bg:#1b1e23;--loom-panel-fg:#ecf0f6}
[data-loom-root] .loom-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
[data-loom-root] .loom-bar .grow{flex:1 1 auto}
[data-loom-root] .loom-approvalbar{position:sticky;top:0;z-index:30;flex-shrink:0;display:grid;gap:8px;padding:12px;background:var(--loom-panel-bg);color:var(--loom-panel-fg);border:1px solid var(--dsw-alias-border-l2,#666);border-radius:12px;min-width:0}
[data-loom-root] .loom-approvalbar p{margin:0;overflow-wrap:anywhere}
[data-loom-root] .loom-approvalbar details{min-width:0;max-height:28vh;overflow:auto}
[data-loom-root] .loom-approvalbar summary{cursor:pointer;font-weight:600}
[data-loom-root] .loom-approvalbar li{margin:6px 0;overflow-wrap:anywhere}
[data-loom-root] .loom-seg{display:inline-flex;gap:0;border:1px solid rgba(128,128,128,.35);border-radius:7px;overflow:hidden}
[data-loom-root] .loom-seg button{border:0;border-radius:0;background:transparent;color:inherit;padding:4px 10px;cursor:pointer}
[data-loom-root] .loom-seg button[aria-pressed="true"]{background:rgba(110,168,254,.24)}
[data-loom-root] .loom-seg button:disabled{opacity:.45;cursor:not-allowed}
[data-loom-root] .loom-btn{border:1px solid rgba(128,128,128,.35);border-radius:7px;background:transparent;color:inherit;padding:4px 10px;cursor:pointer;font:inherit}
[data-loom-root] .loom-primary{background:#285fc7;border-color:#285fc7;color:#fff;font-weight:600;padding:7px 12px}
[data-loom-root] .loom-btn:focus-visible{outline:2px solid #285fc7;outline-offset:3px}
[data-loom-root] .loom-btn:disabled{opacity:.45;cursor:not-allowed}
[data-loom-root] .loom-note{font-size:12px;margin:0;opacity:.8}
[data-loom-root] .loom-error{color:#ff8787;font-size:12px;margin:0}
[data-loom-root] .loom-lownmodel-guard{border:1px solid rgba(255,193,7,.5);background:rgba(255,193,7,.12);border-radius:8px;padding:8px 10px;margin:0 0 8px;display:flex;flex-direction:column;gap:6px;align-items:flex-start}
[data-loom-root] .loom-lownmodel-guard .loom-warning{margin:0}
[data-loom-root] .loom-ok{color:#8ce99a;font-size:12px;margin:0}
[data-loom-root] .loom-main{display:grid;grid-template-columns:minmax(0,1fr) 292px;gap:12px;align-items:start;min-width:0}
[data-loom-root] .loom-main{position:relative;grid-template-columns:minmax(0,1fr)}
[data-loom-root] .loom-main[data-loom-plan-split="false"]>.loom-readable-plan{display:none}
[data-loom-root] .loom-main>aside.loom-inspector{position:absolute;right:12px;top:12px;z-index:12;width:min(320px,calc(100% - 24px));max-height:calc(100% - 24px);overflow:auto;background:var(--loom-panel-bg);color:var(--loom-panel-fg);padding:12px;border:1px solid var(--dsw-alias-border-l2,#666);border-radius:8px;box-shadow:0 10px 28px rgba(0,0,0,.18)}
[data-loom-root] .loom-main[data-loom-plan-split="true"]>aside.loom-inspector{grid-column:auto;grid-row:auto}
[data-loom-root][data-loom-focus="true"] .loom-main>aside.loom-inspector{display:grid!important}
[data-loom-root][data-loom-focus="true"] .loom-main>aside.loom-inspector[hidden]{display:none!important}
[data-loom-root] .loom-canvas-tools{position:absolute;bottom:12px;left:12px;z-index:8;display:flex;gap:8px;align-items:center;flex-wrap:wrap;max-width:calc(100% - 210px);padding:10px 12px;background:var(--loom-panel-bg);color:var(--loom-panel-fg);border:1px solid var(--dsw-alias-border-l2,#666);border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.12)}
[data-loom-root] .loom-canvas-tools details[open]{flex-basis:100%;max-height:230px;overflow:auto}
[data-loom-root] .loom-marquee{position:absolute;border:1px solid #2860c9;background:rgba(40,96,201,.12);pointer-events:none;z-index:6}
[data-loom-root] .loom-marquee[hidden]{display:none}
@container (max-width:760px){[data-loom-root] .loom-canvas-tools{max-width:calc(100% - 24px)}[data-loom-root] .loom-minimap{display:none}}
[data-loom-root] .loom-main[data-loom-plan-split="true"]{grid-template-columns:minmax(240px,320px) minmax(0,1fr)}
[data-loom-root] .loom-readable-plan{min-width:0;max-height:70vh;overflow:auto;line-height:1.6;padding:12px;background:var(--loom-panel-bg);color:var(--loom-panel-fg);border-radius:12px}
[data-loom-root] .loom-readable-plan h3{margin:0 0 12px;font-size:18px}
[data-loom-root] .loom-readable-plan h4{margin:24px 0 8px}
[data-loom-root] .loom-readable-plan p{overflow-wrap:anywhere}
[data-loom-root] .loom-readable-plan textarea{display:block;width:100%;box-sizing:border-box;min-height:70px;margin:6px 0 12px;background:var(--loom-input-bg);color:inherit;border:1px solid var(--dsw-alias-border-l2,#666);padding:8px;border-radius:6px;font:inherit}
[data-loom-root] .loom-readable-plan [data-selected="true"]{outline:2px solid #6ea8fe;outline-offset:4px}
[data-loom-root] .loom-main[data-loom-plan-split="true"]>.loom-stage{grid-column:2;grid-row:1 / span 2}
[data-loom-root] .loom-main[data-loom-plan-split="true"]>aside{grid-column:1;grid-row:2}
[data-loom-root][data-loom-focus="true"] .loom-readable-plan{display:none}
[data-loom-root][data-loom-focus="true"] .loom-main[data-loom-plan-split="true"]{grid-template-columns:minmax(0,1fr)}
[data-loom-root][data-loom-focus="true"] .loom-main[data-loom-plan-split="true"]>.loom-stage{grid-column:1;grid-row:1}
@container (max-width:760px){[data-loom-root] .loom-main[data-loom-plan-split="true"]{grid-template-columns:minmax(0,1fr)}[data-loom-root] .loom-main[data-loom-plan-split="true"]>.loom-stage,[data-loom-root] .loom-main[data-loom-plan-split="true"]>aside{grid-column:1;grid-row:auto}}
[data-loom-root] .loom-main[data-loom-empty="true"]{grid-template-columns:minmax(0,1fr)}
@container (max-width:760px){[data-loom-root] .loom-main{grid-template-columns:minmax(0,1fr)}}
[data-loom-root] .loom-stage{position:relative;height:58vh;min-height:320px;border:1px solid rgba(128,128,128,.3);border-radius:9px;overflow:hidden;background:rgba(128,128,128,.06)}
[data-loom-root] .loom-viewport{position:absolute;inset:0;overflow:hidden;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;
  background-image:radial-gradient(rgba(128,128,128,.28) 1px, transparent 1px);background-size:20px 20px}
[data-loom-root] .loom-world{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform}
[data-loom-root] .loom-more-slot{position:relative;display:inline-block}
[data-loom-root] .loom-more-menu{display:none}
[data-loom-root] .loom-more-menu.is-open{position:absolute;right:0;top:calc(100% + 6px);z-index:40;display:grid;gap:6px;min-width:150px;padding:8px;border-radius:10px;border:1px solid rgba(128,128,128,.35);background:rgba(24,26,30,.97);box-shadow:0 12px 32px rgba(0,0,0,.45)}
[data-loom-root] .loom-flowboard{position:absolute;inset:0;z-index:6;overflow:auto;padding:10px;background:rgba(18,20,24,.94);color:#e6e8ea;font-size:12px}
[data-loom-root] .loom-flow-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}
[data-loom-root] .loom-flow-steps{display:flex;gap:10px;align-items:flex-start;overflow-x:auto;padding-bottom:8px}
[data-loom-root] .loom-flow-step{min-width:190px;max-width:250px;border:1px solid rgba(128,128,128,.35);border-radius:10px;padding:8px;background:rgba(128,128,128,.08);display:grid;gap:6px}
[data-loom-root] .loom-flow-step-head{display:flex;align-items:center;gap:6px}
[data-loom-root] .loom-flow-step-title{font-size:12px;opacity:.85}
[data-loom-root] .loom-flow-badge{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;border-radius:999px;background:#6ea8fe;color:#0b0d10;font-size:12px;font-weight:700}
[data-loom-root] .loom-flow-pool .loom-flow-badge{background:rgba(128,128,128,.5);color:#fff}
[data-loom-root] .loom-flow-agents{display:flex;align-items:center;gap:6px}
[data-loom-root] .loom-flow-tasks{list-style:none;margin:0;padding:0;display:grid;gap:4px;font-size:12px}
[data-loom-root] .loom-flow-tasks li{overflow-wrap:anywhere}
[data-loom-root] .loom-flow-pool{border-style:dashed}
[data-loom-root] .loom-flow-group-tag{margin-top:2px;font-size:11px;display:flex;gap:6px;align-items:center;border:1px solid rgba(110,168,254,.5);border-radius:8px;padding:2px 6px;box-shadow:0 0 10px rgba(110,168,254,.25)}
[data-loom-root] .loom-flow-groups{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px}
[data-loom-root] .loom-flow-groupbox{display:inline-flex;align-items:center;gap:6px;border:1px solid rgba(199,146,234,.6);border-radius:10px;padding:4px 8px;font-size:12px;box-shadow:0 0 12px rgba(199,146,234,.3)}
[data-loom-root] .loom-flow-audit{border:1px dashed rgba(128,128,128,.5);border-radius:999px;padding:2px 10px;font-size:12px;opacity:.8}
[data-loom-root] .loom-flow-audit.is-bound{border-style:solid;border-color:rgba(110,168,254,.7);box-shadow:0 0 10px rgba(110,168,254,.35);opacity:1}
[data-loom-root] .loom-flow-empty{padding:24px;opacity:.8}
[data-loom-root] .loom-select{background:rgba(24,26,30,.55);color:inherit;border:1px solid rgba(128,128,128,.4);border-radius:7px;padding:2px 6px}
[data-loom-root] .loom-select option{background:#1c1e22;color:#e6e8ea}
[data-body-dark] [data-loom-root] .loom-select,body[data-ds-dark-theme] [data-loom-root] .loom-select{color-scheme:dark}
body[data-ds-dark-theme] [data-loom-root] .loom-select option{background:#1c1e22;color:#e6e8ea}
.loom-appearance-preview{margin-top:10px;padding:10px;border:1px dashed rgba(128,128,128,.4);border-radius:10px;display:grid;gap:8px;justify-items:start}
.loom-plan-preview{display:inline-block;padding:6px 12px;border:1px solid;border-radius:10px;color:#e6e8ea}
.loom-swatches{display:flex;gap:6px;align-items:center}
[data-loom-root] .loom-lanes{position:absolute;left:0;top:0;pointer-events:none}
[data-loom-root] .loom-lane{position:absolute;border:1px dashed rgba(110,168,254,.5);border-radius:16px;background:rgba(110,168,254,.06)}
[data-loom-root] .loom-lane-label{position:absolute;left:12px;top:8px;font-size:12px;opacity:.85;color:#9db9ea}
[data-loom-root] .loom-lane-move{pointer-events:auto;margin-left:6px;padding:0 5px;font-size:11px;line-height:15px;border:1px solid rgba(128,128,128,.45);border-radius:4px;background:rgba(18,20,24,.85);color:#cfe0ff;cursor:pointer}
[data-loom-root] .loom-lane-move:hover{background:rgba(110,168,254,.3)}
[data-loom-root] .loom-flowstrip{position:absolute;left:8px;right:8px;top:8px;z-index:7;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 10px;border:1px solid rgba(128,128,128,.35);border-radius:10px;background:var(--loom-panel-bg);color:var(--loom-panel-fg);pointer-events:none}
[data-loom-root] .loom-flowstrip button{pointer-events:auto}
[data-loom-root] .loom-flow-row{display:flex;align-items:center;gap:8px;justify-content:space-between}
.loom-plan-line{display:inline-flex;align-items:center;gap:6px;position:relative}
.loom-plan-toggle{display:inline-flex;align-items:center;gap:6px;border:1px solid rgba(128,128,128,.4);border-radius:999px;background:transparent;color:inherit;padding:2px 10px;font:inherit;font-size:12px;cursor:pointer}
.loom-plan-toggle.is-on{font-weight:600}
.loom-plan-dot{width:8px;height:8px;border-radius:999px;display:inline-block}
.loom-plan-palette-btn{border:1px solid rgba(128,128,128,.4);border-radius:999px;background:transparent;color:inherit;padding:2px 8px;font:inherit;font-size:12px;cursor:pointer}
.loom-plan-palette{position:absolute;bottom:calc(100% + 8px);left:0;z-index:60;display:flex;gap:6px;align-items:center;padding:8px;border:1px solid rgba(128,128,128,.35);border-radius:10px;background:rgba(24,26,30,.97);box-shadow:0 12px 32px rgba(0,0,0,.45)}
.loom-plan-swatch{width:18px;height:18px;border-radius:999px;border:1px solid rgba(255,255,255,.35);cursor:pointer;padding:0}
.loom-plan-picker{width:26px;height:22px;padding:0;border:1px solid rgba(128,128,128,.4);border-radius:6px;background:transparent}
.loom-plan-error{font-size:12px;color:#f78ca2;max-width:220px}
.loom-welcome-line{text-align:center;margin-top:6px;letter-spacing:.04em}
[data-loom-root] .loom-edges{position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible;pointer-events:none}
/* 箭头 marker 的宿主 svg：0×0、不占位、不拦指针，只有 defs 在里面。 */
[data-loom-root] .loom-arrow-defs{position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none}
[data-loom-root] .loom-nodes,[data-loom-root] .loom-frames{position:absolute;left:0;top:0}
[data-loom-root] .loom-frames{pointer-events:none}
[data-loom-root] .loom-frame{position:absolute;border:1px dashed rgba(128,128,128,.5);border-radius:10px;background:rgba(128,128,128,.05)}
[data-loom-root] .loom-frame-title{position:absolute;left:8px;top:-18px;font-size:11px;opacity:.75}
[data-loom-root] .loom-node{position:absolute;border:1px solid rgba(128,128,128,.35);border-left:3px solid #6ea8fe;
  border-radius:8px;background:var(--dsw-alias-bg-layer-1,var(--vscode-editor-background,#1b1e23));color:var(--dsw-alias-label-primary,var(--vscode-editor-foreground,#eef0f3));box-shadow:0 1px 3px rgba(0,0,0,.25);cursor:grab}
[data-loom-root] .loom-node.is-selected{box-shadow:0 0 0 2px #6ea8fe}
[data-loom-root] .loom-node.has-issue{border-color:#ff8787;border-left-color:#ff8787}
/* 锁定的架构节点：左边框改黄 + 淡淡底色 + 记号，一眼能和可改节点分开。 */
[data-loom-root] .loom-node.is-locked{border-left-color:#ffd43b;background:rgba(255,212,59,.07)}
[data-loom-root] .loom-lock{color:#ffd43b;font-weight:700;white-space:nowrap}
[data-loom-root] .loom-node-head{display:flex;justify-content:space-between;gap:8px;padding:5px 8px;background:rgba(128,128,128,.12);font-weight:600;font-size:12px;border-radius:6px 6px 0 0}
[data-loom-root] .loom-node-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[data-loom-root] .loom-node-kind{opacity:.7;font-weight:400;white-space:nowrap}
[data-loom-root] .loom-node-body{padding:6px 8px;display:grid;gap:4px;font-size:11.5px}
[data-loom-root] .loom-node-meta{opacity:.72}
[data-loom-root] .loom-node-scope{opacity:.72;overflow-wrap:anywhere}
[data-loom-root] .loom-node-issue{color:#ff8787}
[data-loom-root] .loom-chips{display:flex;gap:5px;flex-wrap:wrap}
[data-loom-root] .loom-chip{border:1px solid;border-radius:999px;padding:0 7px;font-size:10.5px;line-height:16px}
[data-loom-root] .loom-port{position:absolute;width:10px;height:10px;border-radius:50%;border:1.5px solid rgba(0,0,0,.45);cursor:crosshair}
[data-loom-root] .loom-port-in{left:-6px}
[data-loom-root] .loom-port-out{right:-6px}
[data-loom-root] .loom-minimap{position:absolute;right:10px;bottom:10px;border:1px solid rgba(128,128,128,.35);border-radius:6px;background:rgba(0,0,0,.35);pointer-events:none}
[data-loom-root] .loom-hint{position:absolute;left:10px;bottom:10px;max-width:70%;padding:5px 9px;border-radius:7px;font-size:11.5px;
  background:rgba(0,0,0,.55);color:#fff;display:none}
[data-loom-root] .loom-hint.is-error{background:rgba(200,40,40,.8)}
[data-loom-root] .loom-hint.is-ok{background:rgba(30,120,60,.8)}
[data-loom-root] .loom-panel{border:1px solid rgba(128,128,128,.3);border-radius:9px;padding:10px;display:grid;gap:6px;font-size:12px}
[data-loom-root] .loom-planner label{display:grid;gap:6px}
[data-loom-root] .loom-planner textarea{width:100%;box-sizing:border-box;resize:vertical;min-height:72px;line-height:1.6}
[data-loom-root] .loom-planner textarea[aria-label="项目目标"]{min-height:110px}
[data-loom-root] .loom-panel h4{margin:0 0 2px;font-size:12px}
[data-loom-root] .loom-panel ul{margin:0 0 0 16px;padding:0}
[data-loom-root] .loom-panel li{overflow-wrap:anywhere}
[data-loom-root] details{border:1px solid rgba(128,128,128,.3);border-radius:9px;padding:10px}
[data-loom-root] summary{cursor:pointer}
[data-loom-root] pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;max-height:260px;overflow:auto;margin:8px 0 0}
[data-loom-root] .loom-empty{padding:20px;font-size:12px;opacity:.78;line-height:1.7}
[data-loom-root] .loom-input,[data-loom-root] .loom-select{border:1px solid rgba(128,128,128,.35);border-radius:7px;
  background:transparent;color:inherit;padding:4px 8px;font:inherit;font-size:12px;min-width:0}
[data-loom-root] .loom-input:disabled,[data-loom-root] .loom-select:disabled{opacity:.45}
[data-loom-root] .loom-input::placeholder{opacity:.55}
/* 架构节点没有类型化端口，边界改成中性色 —— 别让用户以为那是一个可拖的端口。 */
[data-loom-root] .loom-node.arch{border-left-color:#b197fc}
`
    let cssDone = false
    function injectCss() {
      if (cssDone || typeof document === 'undefined') return
      const s = document.createElement('style')
      s.setAttribute('data-loom', 'style')
      s.textContent = CSS
      document.head.appendChild(s)
      cssDone = true
    }

    /* ================================================================== *
     * 6. 主组件
     * ================================================================== */

    /**
     * 语义图规范化 —— 与宿主 `contentDigest` 同一目标：**只表达语义**。
     *
     * 评审 09 C 的完成条件之一：「仅移动位置不产生语义变化」。
     * 布局存在 presentation 里，本来就不该进语义快照；这里把节点/边排序并按
     * 语义字段序列化，用来判断「有没有真正的改动」。任何坐标、选中态、
     * 数组顺序变化都不应让 hash 变。
     */
    function semanticDigest(workflow) {
      if (!workflow) return ''
      const nodes = (workflow.nodes || [])
        .map((n) => ({
          id: n.id,
          kind: n.kind,
          title: n.title,
          sourceRefs: n.sourceRefs || [],
          phase: n.phase,
          role: n.role,
          goal: n.goal,
          userVisibleGoal: n.userVisibleGoal,
          inputs: (n.inputs || []).map((p) => `${p.name}:${p.artifactType}:${p.required}`).sort(),
          outputs: (n.outputs || []).map((p) => `${p.name}:${p.artifactType}:${p.required}`).sort(),
          backend: n.execution && n.execution.backend,
          maxRepairAttempts: n.execution && n.execution.maxRepairAttempts,
          isolation: n.execution && n.execution.isolation,
          timeoutSeconds: n.execution && n.execution.timeoutSeconds,
          writes: ((n.ownership && n.ownership.writes) || []).slice().sort(),
          forbiddenWrites: ((n.ownership && n.ownership.forbiddenWrites) || []).slice().sort(),
          doneWhen: (n.acceptance && n.acceptance.doneWhen) || [],
          commands: ((n.acceptance && n.acceptance.commands) || []).map((c) => ({ argv: c.argv, cwdRef: c.cwdRef, expectedExitCode: c.expectedExitCode })),
          independentVerification: n.acceptance && n.acceptance.independentVerification,
          sharedResources: ((n.ownership && n.ownership.sharedResources) || []).slice().sort(),
          budget: n.acceptance && n.acceptance.budget,
        }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      const edges = (workflow.edges || [])
        .map((e) => `${e.source}.${e.sourcePort}->${e.target}.${e.targetPort}:${e.artifactType}:${e.require}:${e.id}`)
        .sort()
      const questions = (workflow.openQuestions || [])
        .map((q) => typeof q === 'string' ? q : JSON.stringify(q))
        .sort()
      return JSON.stringify({
        workflowId: workflow.workflowId,
        title: workflow.title,
        detectedStage: workflow.detectedStage,
        evidence: workflow.evidence || [],
        assumptions: workflow.assumptions || [],
        executionProposal: workflow.executionProposal,
        nodes,
        edges,
        questions,
      })
    }

    /** 深拷贝语义图。所有草案编辑都改副本，成功后才换上去。 */
    function cloneWorkflow(wf) {
      return JSON.parse(JSON.stringify(wf))
    }

    /**
     * 架构 revision 的语义快照。
     *
     * 与 `semanticDigest` 同构：只序列化**语义字段**，排序后比较，
     * 用来判断架构草案是否与已提交的 revision 有真实差异。
     * constraints / openQuestions / unmapped 也算语义 —— 它们是用户可见的约束，
     * 丢了就等于把用户的锁定条件静默吞掉。
     */
    function archDigest(arch) {
      if (!arch) return ''
      const nodes = (arch.nodes || [])
        .map((n) => ({
          id: n.id,
          kind: n.kind,
          title: n.title,
          responsibility: n.responsibility,
          interface: (n.interface || []).slice().sort(),
          sourceRefs: (n.sourceRefs || []).slice().sort(),
          locked: Boolean(n.locked),
        }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      const edges = (arch.edges || [])
        .map((e) => `${e.from}->${e.to}:${e.kind}:${e.bidirectional ? 'bi' : 'uni'}`)
        .sort()
      return JSON.stringify({
        architectureId: arch.architectureId,
        revision: arch.revision,
        nodes,
        edges,
        constraints: (arch.constraints || []).slice().sort(),
        openQuestions: (arch.openQuestions || []).slice().sort(),
        unmapped: (arch.unmapped || []).slice().sort(),
      })
    }

    /**
     * 稳定 id 分配。
     *
     * 数据模型的 ID_PATTERN 是 `^[a-z][a-z0-9_-]{0,63}$`。用户的输入
     * 未必合规，而**改 id 等于改标识**（引用会断），所以策略是：
     *   1. 能规范就规范（大写转小写、非法字符换成 -），而不是直接拒绝；
     *   2. 规范后仍不合规（例如以数字开头）才加前缀兜底；
     *   3. 撞了就追加 -2 / -3 …… **绝不静默复用**别人的 id。
     * 这样「加两次同名的模块」会得到 `api` 与 `api-2`，两个都存在，
     * 而不是第二个把第一个覆盖掉。
     */
    function allocStableId(raw, taken, fallbackPrefix) {
      const used = new Set(taken || [])
      const cleaned = String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
      let base = cleaned
      if (!/^[a-z]/.test(base)) base = `${fallbackPrefix || 'node'}-${base || 'new'}`
      base = base.slice(0, 64).replace(/[^a-z0-9_-]+$/, '') || `${fallbackPrefix || 'node'}-1`
      if (!used.has(base)) return base
      for (let i = 2; i < 1000; i += 1) {
        const suffix = `-${i}`
        const cut = base.slice(0, 64 - suffix.length).replace(/[^a-z0-9_-]+$/, '')
        const cand = cut + suffix
        if (!used.has(cand)) return cand
      }
      throw new Error(`无法为 ${raw} 分配不冲突的 id`)
    }

    /**
     * 造一条 GraphChange。
     *
     * 形状严格来自 `src/core/graphchange-types.ts`：只有
     * kind / objectKind / objectId / field / oldValue / newValue / reason。
     * **没有 payload 字段**，所以「准确记录改了什么」的办法是把真正变动的
     * oldValue/newValue 填进去 —— 不是另起一套我们自己的格式。
     * `objectKind` 用 `architectureNode` / `architectureEdge`（同一份类型里的枚举）。
     */
    function makeChange(kind, objectKind, objectId, opts) {
      const o = opts || {}
      const c = { kind, objectKind, objectId }
      if (o.field !== undefined) c.field = o.field
      if (o.oldValue !== undefined) c.oldValue = o.oldValue
      if (o.newValue !== undefined) c.newValue = o.newValue
      if (o.reason !== undefined) c.reason = o.reason
      return c
    }

    /** 架构边的稳定 id：`from->to:kind`。双向由 `bidirectional` 表达，不进 id。 */
    function archEdgeId(from, to, kind) {
      return `${from}->${to}:${kind}`
    }

    /**
     * 本地即时校验（镜像 src/core/architecture.ts 的 validateArchitecture）。
     *
     * 为什么要有两份：服务端仍是**唯一裁决**（保存时以它的 400 为准），
     * 但用户点「删除模块」不该等一下才被告知「这会让某条边悬空」。
     * 这份只做能在本地确定的检查 —— schemaVersion / id 唯一 / 端点存在 /
     * kind 合法 / 自环。**环只报 warning 不报 error**：架构允许环，
     * 借任务图那套拓扑规则过来才是 bug。
     *
     * 返回值形状与服务端 errors/warnings 一致（code/path/message），
     * 因此可以直接塞进 st.archValidation 而不必分两种渲染分支。
     */
    function validateArchitectureLocal(doc) {
      const errors = []
      const warnings = []
      const push = (code, path, message) => errors.push({ code, path, message })
      if (!doc || typeof doc !== 'object') {
        push('ARCH_NOT_OBJECT', 'architecture', '架构必须是一个对象')
        return { ok: false, errors, warnings }
      }
      if (doc.schemaVersion !== 1) push('ARCH_SCHEMA_VERSION', 'schemaVersion', 'schemaVersion 必须为 1')
      if (typeof doc.architectureId !== 'string' || !doc.architectureId) push('ARCH_ID_EMPTY', 'architectureId', 'architectureId 不能为空')
      if (!Number.isInteger(doc.revision) || doc.revision < 1) push('ARCH_REVISION', 'revision', 'revision 必须是不小于 1 的整数')
      const nodes = Array.isArray(doc.nodes) ? doc.nodes : null
      const edges = Array.isArray(doc.edges) ? doc.edges : null
      if (!nodes) push('ARCH_NODES_ARRAY', 'nodes', 'nodes 必须是数组')
      if (!edges) push('ARCH_EDGES_ARRAY', 'edges', 'edges 必须是数组')
      const nodeIds = {}
      ;(nodes || []).forEach((n, i) => {
        const at = `nodes[${i}]`
        if (!n || typeof n.id !== 'string' || !n.id) push('ARCH_NODE_ID', `${at}.id`, '节点 id 不能为空')
        else if (nodeIds[n.id]) push('ARCH_NODE_ID_DUP', `${at}.id`, `节点 id 重复：${n.id}`)
        else nodeIds[n.id] = true
        if (!n || ARCH_NODE_KINDS.indexOf(n.kind) < 0) push('ARCH_NODE_KIND', `${at}.kind`, `节点 kind 不合法：${n && n.kind}`)
        if (!n || typeof n.title !== 'string' || !n.title.trim()) push('ARCH_NODE_TITLE', `${at}.title`, '节点 title 不能为空')
        if (!n || typeof n.responsibility !== 'string' || !n.responsibility.trim()) push('ARCH_NODE_RESP', `${at}.responsibility`, '节点 responsibility 不能为空（架构必填）')
      })
      const seenEdge = {}
      const adj = {}
      ;(edges || []).forEach((e, i) => {
        const at = `edges[${i}]`
        if (!e || typeof e.id !== 'string' || !e.id) push('ARCH_EDGE_ID', `${at}.id`, '边 id 不能为空')
        else if (seenEdge[e.id]) push('ARCH_EDGE_ID_DUP', `${at}.id`, `边 id 重复：${e.id}`)
        else seenEdge[e.id] = true
        if (!e || !nodeIds[e.from]) push('ARCH_EDGE_FROM', `${at}.from`, `边的 from 不是已有模块：${e && e.from}`)
        if (!e || !nodeIds[e.to]) push('ARCH_EDGE_TO', `${at}.to`, `边的 to 不是已有模块：${e && e.to}`)
        if (!e || ARCH_EDGE_KINDS.indexOf(e.kind) < 0) push('ARCH_EDGE_KIND', `${at}.kind`, `边 kind 不合法：${e && e.kind}`)
        if (e && e.from && e.from === e.to) push('EDGE_SELF_LOOP', at, '架构图也不接受自环：一个模块不能连到自己')
        if (e && e.from && e.to) {
          if (!adj[e.from]) adj[e.from] = []
          adj[e.from].push(e.to)
        }
      })
      // 环检测：DFS 三色。架构允许环 —— 这里只产 warning（ARCH_HAS_CYCLE）。
      const color = {}
      let hasCycle = false
      const visit = (id) => {
        if (hasCycle) return
        color[id] = 1
        const outs = adj[id] || []
        for (let i = 0; i < outs.length; i += 1) {
          const next = outs[i]
          if (color[next] === 1) { hasCycle = true; return }
          if (!color[next]) visit(next)
          if (hasCycle) return
        }
        color[id] = 2
      }
      Object.keys(adj).forEach((id) => { if (!color[id]) visit(id) })
      if (hasCycle) {
        warnings.push({ code: 'ARCH_HAS_CYCLE', path: 'edges', message: '架构里存在环（架构层合法，转任务图时需打断）', severity: 'warning' })
      }
      return { ok: errors.length === 0, errors, warnings }
    }


    /**
     * 架构工具的连线模式提示。
     *
     * 与任务图的 LINK_MODE_HINT 分开写：架构图的合法连线集合更大
     * （允许双向、允许成环），所以那一套「会让任务图成环」的措辞在这里是错的。
     */
    function ARCH_LINK_HINT(st) {
      if (!st.archLinkFrom) return '点「设为起点」后点另一个模块的「设为终点」，即可建立关系'
      return `架构连线：已选起点 ${st.archLinkFrom}${st.archLinkFromPort ? '（' + st.archLinkFromPort + '）' : ''}，再点目标`
    }

    /**
     * 连线模式的说明文字。
     *
     * 拖拽对精细操作不友好，也无键盘通路 —— 连线模式是它的无障碍替代：
     * 点起点、点终点即连线。两种方式走的是同一段校验与草案写入。
     */
    function LINK_MODE_HINT(st) {
      if (!st.linkMode) return '拖动节点只改布局；从右侧端口拖到左侧端口才改依赖'
      if (!st.linkFrom) return '连线模式：先点一个源节点'
      return `连线模式：已选 ${st.linkFrom}，再点目标节点（自动挑类型兼容的端口）`
    }

    /**
     * 步骤栏标签上的「挪一位」按钮：竖排用 ▲▼、横排用 ◀▶（方向感与排列方向一致）。
     *
     * 0.7.3 起泳道里只能调「栏内顺序」，步骤之间的先后没法动 —— 这里把它补上：
     * 按钮改的是 `plan.order`，改完立刻重铺。纯函数，便于单测。
     */
    function flowLaneMoves(orientation, index, total) {
      const horizontal = orientation === 'horizontal'
      const moves = []
      if (index > 0) moves.push({ glyph: horizontal ? '◀' : '▲', delta: -1, title: '把这一步往前挪一位' })
      if (index < total - 1) moves.push({ glyph: horizontal ? '▶' : '▼', delta: 1, title: '把这一步往后挪一位' })
      return moves
    }

    /**
     * 审计组收据 → 可复制的纯文本报告。
     *
     * 运行视图里审计以前只有一行拼接的 findings，看不全也带不走。这里生成一份
     * 自包含的报告（结论、覆盖任务、逐条发现），复制按钮和 <pre> 都用它。
     * 纯函数，便于单测；缺字段不抛错，写「无额外结论」。
     */
    function auditReportText(audit) {
      const value = audit && typeof audit === 'object' ? audit : {}
      const findings = Array.isArray(value.findings) ? value.findings.filter((f) => typeof f === 'string' && f.trim()) : []
      const taskIds = Array.isArray(value.taskIds) ? value.taskIds : []
      const lines = [
        `审计组 ${value.groupId || '(未命名)'} · 主审 ${value.label || '(未指定)'} · ${value.verdict === 'pass' ? '通过' : '未通过'}`,
        `覆盖任务：${taskIds.length ? taskIds.join('、') : '无'}`,
        '结论：',
      ]
      if (findings.length) for (const finding of findings) lines.push('- ' + finding.trim())
      else lines.push('- 无额外结论')
      return lines.join('\n')
    }

    /**
     * 外观注入的实测状态：两处 DOM 启发式（整框发光 / 欢迎题词）失败时是**静默**的，
     * 宿主升级后用户只会看到「没反应」。这里把最后一次注入结果记下来，设置页 → 外观
     * 直接显示「已注入 / 未找到目标」，并把排查说明给出来。
     */
    const appearanceStatus = { composerGlow: null, welcomeLine: null, at: 0 }

    /**
     * 欢迎题词该不该显示。
     *
     * 宿主的 hero（「探索未至之境」那一块）**不只是新会话页**：任何**空会话**都渲染它
     * —— 所以只按「标题在不在」注入，会让用户在已有对话里也看到这句品牌文案（用户
     * 明确要求删掉）。判据用宿主当前选中的会话：没选中会话才是全新会话页。
     */
    function welcomeLineVisible(config, sessionKey) {
      if (!config || config.enabled === false || config.welcomeEnabled === false) return false
      return !sessionKey
    }

    /** 注入状态文案（纯函数，便于单测）。'conversation' ＝ 开着但当前是已有对话。 */
    function appearanceInjectionText(status) {
      if (status === 'conversation') return '已有对话里不显示（只在全新会话页注入）'
      if (status === null || status === undefined) return '还没试过（打开一次会话聊天框 / 新会话页后更新）'
      return status ? '已注入' : '未找到目标（宿主结构可能已变；功能已静默跳过，不影响其他功能）'
    }

    function LoomWorkbench() {
      const stageRef = React.useRef(null)
      const canvasRef = React.useRef(null)
      const graphRef = React.useRef({ nodes: [], edges: [], groups: [] })
      const [, forceRender] = React.useState(0)
      const s = React.useRef(null)
      const bump = React.useCallback(() => {
        // The replacement surface renders before the previous surface's passive
        // cleanup. Cache each edit now, so fullscreen reads the current draft.
        const state = s.current
        if (state?.boundSession !== undefined) viewCache.set(state.boundSession, { goal: state.goal, planningConstraints: state.planningConstraints, mode: state.mode, view: state.view, promptText: state.promptText, replyText: state.replyText, replyPreview: state.replyPreview, lastPreviewError: state.lastPreviewError, edgeStyle: state.edgeStyle, flowOrientation: state.flowOrientation })
        forceRender((n) => n + 1)
      }, [])
      if (s.current === null) {
        s.current = {
          goal: '',
          planningConstraints: '',
          globalConfig: null,
          configError: '',
          preparing: false,
          preparationError: '',
          preparationWorkspace: '',
          sessionEnabled: false,
          ready: false,
          busy: false,
          problem: '',
          notice: '',
          mode: 'manual',
          view: 'workflow',
          edgeStyle: 'curve',
          flow: null,
          flowServerDigest: null,
          directCandidate: null,
          directHistory: [],
          flowOrientation: 'vertical',
          flowSaved: false,
          flowWarnings: [],
          flowDirty: false,
          /** 流程面板里勾选的步骤 id（「结为审计组」用；勾任意两步，不必相邻）。 */
          flowPicked: [],
          teamPicked: [],
          flowPast: [],
          flowFuture: [],
          /** 每步子代理数量下拉的上限：由服务端 /flow 返回，与宿主调度上限同源。 */
          flowMaxAgents: 3,
          planningMode: false,
          snapshot: null,
          workflow: null,
          /**
           * 当前架构 revision。**与 workflow 相互独立** —— 视图切换只是换「画哪个」，
           * 不清空另一个，否则切回来就要重新拉，还会丢掉未提交的架构编辑。
           */
          architecture: null,
          /** 架构是否已加载过（null 也可能意味着「已查过、服务端没有」）。 */
          archLoaded: false,
          /** 已提交架构 revision 的语义快照，判断架构草案脏不脏。 */
          archServerDigest: '',
          /** 架构读取失败的原因（空串表示没有失败）。与「还没有架构」严格区分。 */
          archLoadError: '',
          /** 架构侧的校验结果（与任务图的 validation 分开，两份图不能共用一份结论）。 */
          archValidation: null,
          /** 服务端最新已采纳 revision 的**语义快照**，用来判断草案脏不脏。 */
          serverDigest: '',
          validation: null,
          compile: null,
          promptText: null,
          replyText: '',
          replyWaiting: false,
          replyPreview: null,
          lastPreviewError: '',
          /** 同一规划请求连续「候选校验未通过」的次数，用于低配模型护栏（见 lowModelGuardText）。 */
          invalidStreak: 0,
          promptKind: 'coordinator',
          selectedNodeId: null,
          canvasPicked: [],
          inspectorOpen: false,
          textPlanOpen: false,
          /** 待新增节点的表单状态。 */
          newNode: { kind: 'agent', id: '', goal: '' },
          /** 任务图连线模式。打开时点击两个节点即可连线（拖拽之外的键盘/无障碍替代）。 */
          linkMode: false,
          linkFrom: null,
          /** 架构视图的连线选点状态：起点节点 + 关系类型。 */
          archLinkFrom: null,
          archLinkFromPort: null,
          archEdgeKind: 'call',
          /** 待新增模块的表单状态。 */
          newModule: { kind: 'module', id: '', title: '', responsibility: '' },
        }
        s.current.boundSession = currentSessionId()
        Object.assign(s.current, viewCache.get(s.current.boundSession) || {})
      }
      const st = s.current
      const layoutKey = () => { const graph = st.view === 'architecture' ? st.architecture : st.workflow; return JSON.stringify([st.boundSession, st.view === 'architecture' ? 'architecture' : 'task', graph?.architectureId || graph?.workflowId, graph?.revision]) }
      const [, refreshWorkspaceList] = React.useState(0)
      React.useEffect(() => {
        const workspaces = hostContext?.get?.('workspaces') ?? hostContext?.workspaces
        return workspaces?.list?.subscribe?.(() => refreshWorkspaceList(n => n + 1))
      }, [])
      const busyOwner=React.useRef(Symbol('loom-workbench')).current
      const refreshBusy=()=>{const busy=[...seat.busyOwners.values()].some(owner=>owner.sessionId===currentSessionId()&&owner.busy);if(seat.workbenchBusy!==busy){seat.workbenchBusy=busy;notifySeat()}}
      React.useEffect(()=>{seat.busyOwners.set(busyOwner,{sessionId:st.boundSession,busy:Boolean(st.busy||st.replyWaiting||st.preparing)});refreshBusy()})
      React.useEffect(()=>()=>{seat.busyOwners.delete(busyOwner);refreshBusy()},[])

      React.useEffect(()=>()=>{viewCache.set(st.boundSession,{goal:st.goal,planningConstraints:st.planningConstraints,mode:st.mode,view:st.view,promptText:st.promptText,replyText:st.replyText,replyPreview:st.replyPreview,lastPreviewError:st.lastPreviewError,edgeStyle:st.edgeStyle,flowOrientation:st.flowOrientation})},[])

      React.useEffect(() => {
        injectCss()
      }, [])

      /**
       * 拉取当前工作区的架构 revision。
       *
       * 评审 C 的原缺陷：切到架构视图只显示一句「还没接上」，然后继续把**任务图**
       * 画在画布上 —— 用户看到的是另一种图，却以为在看架构。
       * 这里把「架构从哪来」变成一次真实的读取：
       *   - 先看草案记的 architectureId（那是本工作区正在编辑的架构）；
       *   - 没有就直接问服务端「最近一份架构」——`GET /architecture` 在
       *     architectureId 为空时返回 store 里的最后一份，这正是我们要的默认值；
       *   - **「还没有架构」与「读取失败」必须分开**：
       *       · 404 是合法结果 —— 置 null，界面说「这个工作区还没有架构」；
       *       · 其它错误（网络、500）绝不能变成「架构是空的」，
       *         那是把失败伪装成空态，用户会以为自己的架构丢了。
       *     所以这里保留错误原因，由界面显式呈现。
       */
      const loadArchitecture = React.useCallback(async (architectureId) => {
        const generation = sessionGeneration
        const draft = (st.snapshot && st.snapshot.draft) || null
        // 取 id 的优先级：
        //   1. 调用方显式指定；
        //   2. 草案记的 architectureId（本工作区正在编辑的那一份）；
        //   3. `/state` 里 architectures 的**最后一份** —— 那是「最近提交的架构」。
        // 第 3 条很关键：真实宿主的 `GET /architecture` 在 id 为空时会返回
        // 最后一份，但把筛选交给服务端总不如自己带一个真实 id ——
        // 后者对「按 id 严格匹配」的实现同样成立。
        const listed = (st.snapshot && st.snapshot.architectures) || []
        const fallbackId = listed.length ? listed[listed.length - 1].architectureId : ''
        const wanted = architectureId || (draft && draft.architectureId) || fallbackId || ''
        st.archLoadError = ''
        try {
          const arch = await requestJSON(API, `/architecture?architectureId=${encodeURIComponent(wanted)}`)
          if (generation !== sessionGeneration) return null
          st.architecture = arch
          st.archServerDigest = archDigest(arch)
        } catch (error) {
          if (generation !== sessionGeneration) return null
          const msg = (error && error.message) || String(error)
          st.architecture = null
          st.archServerDigest = ''
          // 只有「找不到」才是「还没有架构」。判据是措辞，因为 requestJSON
          // 只把错误文本带上来；这里宁可窄一点 —— 误判成「空」比多显示一条
          // 错误要危险得多（前者会让用户以为架构没了）。
          const notFound = /找不到架构|ARCHITECTURE_NOT_FOUND/.test(msg)
          st.archLoadError = notFound ? '' : msg
        }
        st.archLoaded = true
        return st.architecture
      }, [st])

      const load = React.useCallback(
        async (workflowId) => {
          const sessionId = currentSessionId()
          const generation = sessionGeneration
          if (!sessionId) { resolvedSession = ''; setWorkspace(''); st.ready = true; return }
          const snapshot = await requestJSON(API, '/state')
          if (sessionId !== currentSessionId() || generation !== sessionGeneration) return
          resolvedSession = snapshot.workspaceId ? sessionId : ''
          st.snapshot = snapshot
          st.directCandidate = snapshot.planning?.candidate || null
          if(st.directCandidate)st.view='workflow'
          st.directHistory = snapshot.planning?.history || []
          st.globalConfig = snapshot.config || seat.config
          if (snapshot.config) { seat.config = snapshot.config; notifySeat() }
          st.sessionEnabled = snapshot.sessionEnabled === true
          if (preparationActivations.has(sessionId) && snapshot.workspaceId && snapshot.config?.enabled) {
            const activation = await requestJSON(API, '/session/activation', { method: 'POST', body: { enabled: true } })
            if (sessionId !== currentSessionId() || generation !== sessionGeneration) return
            st.sessionEnabled = activation.enabled; preparationActivations.delete(sessionId)
            seat.activationVersion++; notifySeat()
          }
          // 工作区只采用宿主会话查询结果。
          setWorkspace(snapshot.workspaceId || '')
          st.mode = (snapshot.draft && snapshot.draft.mode) || snapshot.config?.defaultMode || st.mode
          const savedDraft = snapshot.draft
          const wanted = workflowId || (savedDraft && savedDraft.workflowId) || (snapshot.revisions.at(-1) && snapshot.revisions.at(-1).workflowId)
          if (wanted) {
            let detail = null
            if (snapshot.revisions.some((r) => r.workflowId === wanted)) detail = await requestJSON(API, `/workflow?workflowId=${encodeURIComponent(wanted)}`)
            if (sessionId !== currentSessionId() || generation !== sessionGeneration) return
            st.workflow = detail
            // 记录服务端现稿的语义指纹：之后「脏不脏」靠它判断，不靠人眼。
            st.serverDigest = detail ? semanticDigest(detail) : ''
            if (sessionId !== currentSessionId() || generation !== sessionGeneration) return
            if (savedDraft && savedDraft.candidate && savedDraft.candidate.workflowId === wanted && (!detail || semanticDigest(savedDraft.candidate) !== semanticDigest(detail))) st.workflow = cloneWorkflow(savedDraft.candidate)
          } else {
            st.workflow = null
            st.serverDigest = ''
          }
          // 架构与任务图各读各的。任务图缺失**不该**拖住架构读取。
          await loadArchitecture()
          if(st.workflow && !st.flow && snapshot.revisions.some(r=>r.workflowId===st.workflow.workflowId)) {
            const flow=await requestJSON(API,'/flow?workflowId='+encodeURIComponent(st.workflow.workflowId))
            if(sessionId!==currentSessionId()||generation!==sessionGeneration)return
            st.flow=flow.plan;st.flowServerDigest=flow.digest||null;st.flowSaved=Boolean(flow.saved)
            if(Number.isInteger(flow.maxAgents))st.flowMaxAgents=flow.maxAgents
          }
          if (sessionId !== currentSessionId() || generation !== sessionGeneration) return
          st.ready = true
          syncGraph()
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [],
      )

      const run = React.useCallback(
        async (fn, okText) => {
          if (st.busy) return
          const generation = sessionGeneration
          st.busy = true
          st.problem = ''
          st.notice = ''
          bump()
          try {
            await fn()
            // okText 为空时不要清掉 fn() 内部自己设置的 notice ——
            // 草案编辑的提示语是在 commitDraft 里按实际结果拼的，比一句泛化的
            // 「已完成」信息量大得多。
            if (okText && generation === sessionGeneration) st.notice = okText
          } catch (error) {
            if (generation === sessionGeneration) st.problem = explainError(error)
          } finally {
            if (generation === sessionGeneration) { st.busy = false; bump() }
          }
        },
        [bump],
      )

      /**
       * 把当前的图推给画布。
       *
       * **架构视图与任务视图是两份独立数据**：切视图只换画布上的图源，
       * 不互相覆盖、不清空对方的编辑。所以这里先按 `st.view` 分流，
       * 而不是「无论什么视图都画任务图」——后者正是评审 C 描述的缺陷。
       *
       * 布局只影响坐标，不产生语义 diff。
       */
      const syncGraph = React.useCallback(() => {
        const api = canvasRef.current
        if (!api) return
        if (st.view === 'architecture') {
          syncArchitecture()
          return
        }
        const wf = st.directCandidate?.preview?.workflow || st.workflow
        if (!wf) {
          api.setGraph({ nodes: [], edges: [], groups: [], shape: 'task' })
          return
        }
        const layout = canvasLayouts.get(layoutKey()) || (st.snapshot && st.snapshot.presentation && st.snapshot.presentation.nodes) || []
        const issuesByNode = {}
        const errs = (st.validation && st.validation.errors) || []
        for (const e of errs) {
          const m = /^nodes\[([a-z0-9_-]+)\]/.exec(e.path || '')
          if (!m) continue
          issuesByNode[m[1]] = (issuesByNode[m[1]] || []).concat([e])
        }
        const nodes = wf.nodes.map((n) => ({ id: n.id, x: 0, y: 0, node: n, members:(st.flow?.organization?.members||[]).filter(m=>m.role==='executor'&&m.taskIds.includes(n.id)), team:st.flow?.organization?.teams?.find(t=>t.taskIds.includes(n.id))?.label, issues: issuesByNode[n.id] || [] }))
        autoArrangeGraph(nodes, wf.edges.map((e) => ({ source: e.source, target: e.target })), 'task')
        for (const item of nodes) {
          const found = layout.find((l) => l.nodeId === item.id)
          if (found) { item.x = found.x; item.y = found.y }
        }
        graphRef.current = {
          nodes,
          shape: 'task',
          edgeStyle: st.edgeStyle || 'curve',
          edgeMotion: st.globalConfig?.edgeMotion || 'auto',
          flowOrientation: st.flowOrientation || 'vertical',
          edgeArrows: st.globalConfig?.edgeArrows !== false,
          edges: wf.edges.map((e) => ({
            id: e.id,
            source: e.source,
            sourcePort: e.sourcePort,
            target: e.target,
            targetPort: e.targetPort,
            artifactType: e.artifactType,
          })),
          groups: [...((st.snapshot && st.snapshot.presentation && st.snapshot.presentation.groups) || []),...(st.flow?.organization?.teams||[]).map(t=>({id:t.id,title:t.label,memberIds:t.taskIds,semanticTeam:true}))],
        }
        api.setGraph(graphRef.current)
      }, [st])

      /**
       * 把 ArchitectureRevision 铺到画布上。
       *
       * 与任务图的三个差别，每一条都是有意的：
       *   1. **节点没有端口** —— 架构关系连的是模块，不是类型化端口；
       *   2. **边用 from/to/kind**，不是 source/target/artifactType；
       *   3. **允许双向与环** —— 画布层不做任何拓扑检查，那属于架构校验，
       *      而架构校验明确把环当**警告**而非错误。
       * 布局：架构没有 presentation 分区，坐标按序号排一个稳定网格。
       * 拖拽仍然改得了坐标（纯展示），只是不会落盘。
       */
      const syncArchitecture = React.useCallback(() => {
        const api = canvasRef.current
        if (!api) return
        const arch = st.architecture
        if (!arch) {
          api.setGraph({ nodes: [], edges: [], groups: [], shape: 'architecture' })
          return
        }
        const issuesByIndex = {}
        const errs = (st.archValidation && st.archValidation.errors) || []
        for (const e of errs) {
          const m = /^nodes\[(\d+)\]/.exec(e.path || '')
          if (!m) continue
          issuesByIndex[m[1]] = (issuesByIndex[m[1]] || []).concat([e])
        }
        const layout = canvasLayouts.get(layoutKey()) || []
        const nodes = arch.nodes.map((n, i) => ({ id: n.id, x: 0, y: 0, node: n, issues: issuesByIndex[String(i)] || [] }))
        autoArrangeGraph(nodes, arch.edges.map((e) => ({ from: e.from, to: e.to })), 'architecture')
        for (const item of nodes) {
          const found = layout.find((entry) => entry.nodeId === item.id)
          if (found) { item.x = found.x; item.y = found.y }
        }
        // 双向关系只画一根线：`from->to` 与它配对的反向线是**同一条**关系的两面，
        // 画两根会让人以为有两段独立依赖。这里只保留字典序在前的那根，
        // 并标明它是双向的；非双向的线画箭头以区分方向。
        const seen = new Set()
        const edges = []
        for (const e of arch.edges) {
          const ends =
            e.bidirectional && e.from > e.to ? [e.to, e.from] : [e.from, e.to]
          const key = `${ends[0]}->${ends[1]}:${e.kind}`
          if (seen.has(key)) continue
          seen.add(key)
          const paired =
            e.bidirectional &&
            arch.edges.some((o) => o.kind === e.kind && o.from === ends[1] && o.to === ends[0] && o.bidirectional)
          edges.push({
            id: e.id,
            from: ends[0],
            to: ends[1],
            kind: e.kind,
            description: e.description,
            bidirectional: Boolean(e.bidirectional),
            // flip 表示画出来的方向与数据里的 from/to 相反（仅为了去重折叠）；
            // 影响不大，但记录下来，交互层要做重定向时不用再推导。
            flip: e.from !== ends[0],
            unidirectional: !paired,
          })
        }
        graphRef.current = { nodes, edges, groups: [], shape: 'architecture', edgeStyle: st.edgeStyle || 'curve', edgeMotion: st.globalConfig?.edgeMotion || 'auto', edgeArrows: st.globalConfig?.edgeArrows !== false, flowOrientation: st.flowOrientation || 'vertical' }
        api.setGraph(graphRef.current)
      }, [st])

      /* ---------------------------------------------------------------- *
       * 草案编辑状态机（评审 09 C）
       *
       * 三条硬约束：
       *   1. 画布看到的 = 草案里的。校验通过后不是「提示一句」，而是真的写草案。
       *   2. 撤销/重做操作的是**语义图快照**，并且重做栈在每次新编辑时清空
       *      —— 这是线性 undo 语义，避免出现分叉历史让用户困惑。
       *   3. 运行中的旧 revision 不改。草案只写 /loom/draft，采纳新 revision 是
       *      另一个显式动作（/loom/adopt）。
       * ---------------------------------------------------------------- */
      const past = React.useRef([])
      const future = React.useRef([])

      /**
       * 历史栈是**分开**的：任务图与架构各有一条。
       *
       * 共用一个栈会出很怪的事 —— 在架构视图按撤销，可能把任务图的一步撤掉。
       * 两个视图、两条历史，语义才自洽。
       */
      const archPast = React.useRef([])
      const archFuture = React.useRef([])

      const draftDirty = () => Boolean(st.workflow) && semanticDigest(st.workflow) !== st.serverDigest

      /** 架构草案是否与已提交 revision 有语义差异。 */
      const archDirty = () => Boolean(st.architecture) && archDigest(st.architecture) !== st.archServerDigest

      const pushArchHistory = () => {
        archPast.current.push(JSON.parse(JSON.stringify(st.architecture)))
        if (archPast.current.length > 100) archPast.current.shift()
        archFuture.current = []
      }

      const canArchUndo = () => archPast.current.length > 0
      const canArchRedo = () => archFuture.current.length > 0

      /**
       * 一次完整的架构本地编辑：压历史 + 换文档 + 立刻本地校验 + 通知渲染 + 异步落盘。
       *
       * 顺序是有意的：**校验必须在 bump() 之前**，否则界面会先画一帧
       * 「旧的校验结论配新的图」—— 用户会看到「删除成功」和「悬空的边」
       * 同时出现。历史也必须在改文档之前压，撤销才有东西可回。
       */
      const pushArchEdit = (next, changes, okText) => {
        pushArchHistory()
        st.architecture = next
        st.archValidation = validateArchitectureLocal(next)
        if (st.selectedNodeId && !next.nodes.some((n) => n.id === st.selectedNodeId)) st.selectedNodeId = null
        if (st.archLinkFrom && !next.nodes.some((n) => n.id === st.archLinkFrom)) {
          st.archLinkFrom = null
          st.archLinkFromPort = null
        }
        bump()
        run(async () => {
          await commitArchitecture(changes, okText)
        }, '')
      }

      const pushHistory = () => {
        past.current.push(cloneWorkflow(st.workflow))
        if (past.current.length > 100) past.current.shift()
        future.current = []
      }

      const canUndo = () => past.current.length > 0
      const canRedo = () => future.current.length > 0

      /**
       * 写草案。
       *
       * 服务端按工作区分区（评审 F），工作区解析不出来时 409；
       * `expectedRevision` 是乐观并发闸门 —— 别的窗口先写了就拒绝我们，
       * 由我们重读再改，绝不静默覆盖。
       */
      const writeDraft = React.useCallback(
        async (patch) => {
          if (!workspaceKnown()) {
            throw new Error('无法确定工作区，写草案已停用（宿主未提供会话工作区）')
          }
          const current = (st.snapshot && st.snapshot.draft) || null
          const body = Object.assign(
            {
              workflowId: (st.workflow && st.workflow.workflowId) || 'loom-default',
              expectedRevision: current ? current.draftRevision : null,
            },
            patch,
          )
          const next = await requestJSON(API, '/draft', { method: 'POST', body })
          // 用返回的 draft 参与下次 expectedRevision 计算，避免读旧快照。
          if (st.snapshot) st.snapshot.draft = next
          // ⚠ 这里**绝不能**刷新 serverDigest。
          // serverDigest 是「服务端**已采纳** revision」的语义快照，只由 load() 写。
          // 草案写进 /draft 只是工作台暂存，**不等于已采纳**。
          // 若在这里把 serverDigest 设成当前图，则 `draftDirty()` 立刻变 false，
          // 「采纳为新 revision」按钮会永久禁用 —— 用户改完永远提交不了。
          // （这个坑真的发生过：一次重写把这里的字段从草案指纹错写成 serverDigest。）
          return next
        },
        [st],
      )

      /** 把一次草案编辑落库。语义图已经改好，这里只负责持久化 + 记后果。 */
      const commitDraft = React.useCallback(
        async (okText) => {
          try {
            await writeDraft({ candidate: cloneWorkflow(st.workflow) })
            st.notice = okText || '草案已保存'
          } catch (error) {
            st.problem = (error && error.message) || String(error)
            st.notice = '草案保存失败：本地编辑未生效，画布仍是服务端现稿'
            // 服务端拒绝了就回读现稿，绝不留下「画布和磁盘不一致」的状态。
            try {
              await load(st.workflow && st.workflow.workflowId)
            } catch {
              /* 回读失败也要让 problem 留在界面上 */
            }
          }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [st],
      )

      /**
       * 删除节点：连同它的入边/出边一起摘掉。
       *
       * 只改 `nodes` / `edges` 两处 —— 数据模型明确规定「依赖只放在 edges 一处，
       * 不另设 dependsOn」。多写一个冗余字段就会和边的真相分歧。
       * 关联边被连带删除，必须在提示里报数，不能静默丢弃用户画的线。
       */
      const editRemoveNode = (nodeId) => {
        const wf = st.workflow
        if (!wf || !workspaceKnown()) return
        const related = wf.edges.filter((e) => e.source === nodeId || e.target === nodeId)
        pushHistory()
        const next = cloneWorkflow(wf)
        next.nodes = next.nodes.filter((n) => n.id !== nodeId)
        next.edges = next.edges.filter((e) => e.source !== nodeId && e.target !== nodeId)
        st.workflow = next
        if (st.selectedNodeId === nodeId) st.selectedNodeId = null
        bump()
        run(async () => {
          await commitDraft(`已删除节点 ${nodeId}（${wf.nodes.length}→${next.nodes.length} 个节点，连带 ${related.length} 条边）`)
        }, '')
      }

      const editUndo = () => {
        if (!canUndo()) return
        future.current.push(cloneWorkflow(st.workflow))
        const prev = past.current.pop()
        st.workflow = prev
        if (!st.workflow.nodes.some((n) => n.id === st.selectedNodeId)) st.selectedNodeId = null
        bump()
        run(async () => {
          await commitDraft('已撤销上一步')
        }, '')
      }

      const editRedo = () => {
        if (!canRedo()) return
        past.current.push(cloneWorkflow(st.workflow))
        const next = future.current.pop()
        st.workflow = next
        bump()
        run(async () => {
          await commitDraft('已重做')
        }, '')
      }

      /* ---------------------------------------------------------------- *
       * 架构草案编辑（评审 09 C 剩下的一块）
       *
       * 架构与任务图走**两条独立的持久化通路**，因为它们存的是两种东西：
       *   - 任务图：/loom/draft 只落草案元数据，成图要等 /loom/adopt 校验后 appendRevision；
       *   - 架构：/loom/architecture 直接 append 一份**不可变**的 ArchitectureRevision。
       * 所以这里不能复刻 commitDraft 那套「写草案」，而是要「写新 revision」。
       *
       * 同时必须解决「模型会以为你在看任务图」的问题：/loom/draft 除了元数据，
       * 还会记下 architectureId / architectureRevision（见 src/http.ts 的 /draft 分支）
       * —— 那是给**架构提示词导出**用的真实基线。我们先把它落下去，
       * 导出时才知道「这一轮改的是哪个架构、基于哪一版」。
       * ---------------------------------------------------------------- */

      /**
       * 把架构改动落盘为一份新的不可变 revision。
       *
       * 三条纪律：
       *   1. **revision 单调递增且不覆盖**：提交的是 `现revision + 1`，
       *      旧版仍在 store 里（架构也是追加式事实日志）。用户点「撤销」不会
       *      去改历史，而是生成又一份新 revision —— 与任务图同一套哲学。
       *   2. **changes 是准确的 GraphChange 列表**，形状照 graphchange-types 来；
       *      不夹带私有字段。服务端不消费它（见交付说明），但它是「改了什么」的
       *      权威记录，将来接 /graphchange 端点时直接用。
       *   3. **失败必须回读**，绝不留下「画布和磁盘不一致」。
       */
      const commitArchitecture = React.useCallback(
        async (changes, okText) => {
          const arch = st.architecture
          if (!arch) return
          const next = Object.assign({}, arch, {
            revision: arch.revision + 1,
            createdAt: new Date().toISOString(),
          })
          try {
            const res = await requestJSON(API, '/architecture', {
              method: 'POST',
              body: { architecture: next, changes, expectedRevision: arch.revision },
            })
            st.architecture = next
            st.archServerDigest = archDigest(next)
            const warns = (res && res.warnings) || []
            st.archValidation = {
              ok: true,
              errors: [],
              warnings: warns,
            }
            // 把「本轮基于哪一版架构」写进草案元数据 —— 架构提示词导出的
            // baseRevision 就从这里取（评审 09 D：基线必须来自真实记录）。
            try {
              await writeDraft({ architectureId: next.architectureId, architectureRevision: next.revision })
            } catch {
              /* 草案元数据写不进去不影响架构本身已经落盘；导出时会再提示一次 */
            }
            st.notice = (okText || '架构已保存为新 revision') + `（revision ${next.revision}）`
          } catch (error) {
            st.problem = (error && error.message) || String(error)
            st.notice = '架构保存失败：本地编辑未生效，画布仍是服务端现版'
            try {
              await loadArchitecture()
            } catch {
              /* 回读失败也让 problem 留在界面上 */
            }
          }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [st],
      )

      /**
       * 新增一个模块。
       *
       * - **稳定 id**：由 allocStableId 规范化 + 去冲突，符合 ID_PATTERN；
       *   重名不会覆盖，而是得到 `api-2`。
       * - **准确 GraphChange**：objectKind='architectureNode'、kind='add'，
       *   newValue 是**完整节点**（这才是「加的是什么」的权威记录）。
       * - 校验放在落盘后由服务端做（validateArchitecture 是唯一裁决），
       *   本地只做「id 会不会撞」这类确定性检查。
       */
      const editAddArchNode = () => {
        const arch = st.architecture
        if (!arch || !workspaceKnown()) return
        const form = st.newModule
        const kind = ARCH_NODE_KINDS.indexOf(form.kind) >= 0 ? form.kind : 'module'
        const taken = arch.nodes.map((n) => n.id)
        let nodeId
        try {
          nodeId = allocStableId(form.id || form.title || kind, taken, 'module')
        } catch (error) {
          st.problem = (error && error.message) || String(error)
          bump()
          return
        }
        const title = (form.title || '').trim() || nodeId
        const responsibility = (form.responsibility || '').trim() || `（待填写）${title} 的责任说明`
        const node = { id: nodeId, kind, title, responsibility }
        const next = JSON.parse(JSON.stringify(arch))
        next.nodes = next.nodes.concat([node])
        st.newModule = { kind, id: '', title: '', responsibility: '' }
        st.selectedNodeId = nodeId
        pushArchEdit(
          next,
          [makeChange('add', 'architectureNode', nodeId, { newValue: node, reason: '用户在架构视图新增模块' })],
          `已新增架构模块 ${nodeId}（${ARCH_KIND_LABELS[kind] || kind}）`,
        )
      }

      /**
       * 删除一个模块 —— **必须级联删掉所有关联边**。
       *
       * 为什么不能只删节点：validateArchitecture 会因「边的 from/to 不存在」
       * 直接判 400（`ARCH_EDGE_FROM`/`ARCH_EDGE_TO`），落盘必然失败，
       * 于是画布和磁盘就分叉了。所以「删模块」在语义上就是
       * 「删模块 + 删它的全部关联边」这一组原子改动。
       *
       * **每条被级联删掉的边各产生一条 GraphChange**，reason 固定为
       * 「源节点被删除」—— 这是评审明确要求的形状：事后看变更日志，
       * 能分清「用户主动断开」和「因为删了模块被动消失」。
       * 关联包括**入边和出边**：只删出边会留下指向虚空的反向线。
       */
      const editRemoveArchNode = (nodeId) => {
        const arch = st.architecture
        if (!arch || !workspaceKnown()) return
        const node = arch.nodes.find((n) => n.id === nodeId)
        if (!node) return
        // ⚠ **锁定是闸门，不是装饰。**
        // 早先这里只画了「[锁定]」标签、把按钮文案在「锁定/解锁」间切换，
        // 但既不拦 UI 也不拦写入 —— 实测点「删除此模块」照样把 locked 节点删掉
        // 并发出了 POST /architecture。这违反 src/core/graphchange.ts 里
        // detectConflicts 的语义：锁定对象被 remove/modify/unlock 必须被拒。
        // 守卫放在**函数入口**，不只靠 UI 禁用 —— 否则快捷键/批量调用会绕过。
        if (node.locked === true) {
          st.problem = `模块 ${nodeId} 已被锁定，不能删除；请先「解锁模块」`
          st.notice = ''
          bump()
          return
        }
        const related = arch.edges.filter((e) => e.from === nodeId || e.to === nodeId)
        const next = JSON.parse(JSON.stringify(arch))
        next.nodes = next.nodes.filter((n) => n.id !== nodeId)
        next.edges = next.edges.filter((e) => e.from !== nodeId && e.to !== nodeId)
        const changes = [
          makeChange('remove', 'architectureNode', nodeId, {
            oldValue: node,
            reason: '用户在架构视图删除模块',
          }),
        ].concat(
          related.map((e) =>
            makeChange('remove', 'architectureEdge', e.id, {
              oldValue: e,
              reason: '源节点被删除',
            }),
          ),
        )
        pushArchEdit(
          next,
          changes,
          related.length
            ? `已删除模块 ${nodeId}，并级联删除 ${related.length} 条关联关系`
            : `已删除模块 ${nodeId}（它没有关联关系）`,
        )
      }

      /**
       * 改模块的一个字段（title / responsibility / interface / kind / locked 之外的通用入口）。
       *
       * 只记**真正变了**的字段：值没变就直接返回，不压历史、不发请求。
       * 否则用户点一下输入框再失焦就会凭空产出一个 revision。
       * `oldValue`/`newValue` 都填真实值 —— 形状是 graphchange-types 的，
       * 不是我们自己的 diff 格式。
       */
      const editArchNodeField = (nodeId, field, value) => {
        const arch = st.architecture
        if (!arch || !workspaceKnown()) return
        const node = arch.nodes.find((n) => n.id === nodeId)
        if (!node) return
        // 锁定节点不可改字段（`locked` 本身除外 —— 解锁必须走得通，
        // 否则锁上就再也解不开）。同样放在入口，不只靠 UI。
        if (node.locked === true && field !== 'locked') {
          st.problem = `模块 ${nodeId} 已被锁定，不能修改「${
            field === 'title' ? '标题' : field === 'responsibility' ? '责任' : field === 'interface' ? '接口' : field
          }」；请先「解锁模块」`
          st.notice = ''
          bump()
          return
        }
        const clean = typeof value === 'string' ? value.trim() : value
        const oldValue = node[field]
        if (Array.isArray(oldValue) && Array.isArray(clean)) {
          if (oldValue.length === clean.length && oldValue.every((v, i) => v === clean[i])) return
        } else if (oldValue === clean) {
          return
        }
        if (typeof clean === 'string' && !clean && (field === 'title' || field === 'responsibility')) {
          st.problem = `${field} 不能为空（架构校验必填）；已保留原值`
          bump()
          return
        }
        const next = JSON.parse(JSON.stringify(arch))
        const target = next.nodes.find((n) => n.id === nodeId)
        target[field] = clean
        const label = field === 'title' ? '标题' : field === 'responsibility' ? '责任' : field === 'interface' ? '接口' : field
        pushArchEdit(
          next,
          [makeChange('modify', 'architectureNode', nodeId, { field, oldValue, newValue: clean, reason: `用户在架构视图修改模块${label}` })],
          `已修改模块 ${nodeId} 的${label}`,
        )
      }

      /**
       * 改模块类型（kind）。
       *
       * 语义上是 `relink` 而非 `modify`：kind 决定了这个模块在架构里**扮演什么角色**
       * （服务/数据/接口…），把它从一个角色换成另一个是重新归类，
       * 不是改一个描述性字段。类型枚举里 relink 就是干这个的。
       */
      const editArchNodeKind = (nodeId, kindRaw) => {
        const arch = st.architecture
        if (!arch || !workspaceKnown()) return
        const kind = ARCH_NODE_KINDS.indexOf(kindRaw) >= 0 ? kindRaw : null
        if (!kind) return
        const node = arch.nodes.find((n) => n.id === nodeId)
        if (!node || node.kind === kind) return
        const next = JSON.parse(JSON.stringify(arch))
        next.nodes.find((n) => n.id === nodeId).kind = kind
        pushArchEdit(
          next,
          [makeChange('relink', 'architectureNode', nodeId, {
            field: 'kind',
            oldValue: node.kind,
            newValue: kind,
            reason: `用户在架构视图把模块 ${nodeId} 的类型由 ${ARCH_KIND_LABELS[node.kind] || node.kind} 改为 ${ARCH_KIND_LABELS[kind] || kind}`,
          })],
          `已把模块 ${nodeId} 的类型改为 ${ARCH_KIND_LABELS[kind] || kind}`,
        )
      }

      /**
       * 锁定/解锁模块。
       *
       * 用 `lock` / `unlock` 这两个**专属 kind**，而不是 `modify {field:'locked'}` ——
       * 锁定是「冻结这个模块的设计」这一独立意图，单独成 kind 才能在变更日志里
       * 被单独检索；用 modify 会把「改了标题」和「冻结了模块」混成一类。
       */
      const editToggleArchLock = (nodeId) => {
        const arch = st.architecture
        if (!arch || !workspaceKnown()) return
        const node = arch.nodes.find((n) => n.id === nodeId)
        if (!node) return
        const wasLocked = Boolean(node.locked)
        if (wasLocked) {
          void run(async () => {
            requireActive()
            if (archDirty()) throw new Error('请先保存架构改动，再解除冻结')
            if (!commandCarrierAvailable()) throw new Error('宿主未提供可信解锁入口，不能解除设计冻结')
            const generation = sessionGeneration, id = currentSessionId(), expectedRevision = arch.revision
            await sessionCommand(`/loom unlock ${arch.architectureId} ${nodeId} ${expectedRevision}`)
            // Session.command confirms admission, never completion. Read the actual
            // immutable revision before enabling edits or reporting success.
            const deadline = Date.now() + 10000
            while (Date.now() < deadline) {
              if (generation !== sessionGeneration || id !== currentSessionId()) throw new Error('会话已切换，停止确认解除冻结')
              const actual = await requestJSON(API, `/architecture?architectureId=${encodeURIComponent(arch.architectureId)}`)
              const actualNode = actual.nodes.find(n => n.id === nodeId)
              if (actual.revision === expectedRevision + 1 && actualNode?.locked === false) {
                stopReplyWatch(); st.promptText = null; st.replyPreview = null; st.replyText = ''
                archPast.current = []; archFuture.current = []
                await load()
                if (generation !== sessionGeneration || id !== currentSessionId()) return
                st.notice = `已解除模块 ${nodeId} 的设计冻结（架构版本 ${actual.revision}）；请重新规划或确认任务映射`
                return
              }
              if (actual.revision !== expectedRevision) throw new Error('架构版本已变化，无法确认本次解除冻结；请刷新并检查会话命令反馈')
              await new Promise(resolve => setTimeout(resolve, 150))
            }
            throw new Error('尚未确认解除冻结完成，模块仍受保护；请查看会话命令反馈后刷新')
          })
          return
        }
        const next = JSON.parse(JSON.stringify(arch))
        const target = next.nodes.find((n) => n.id === nodeId)
        if (wasLocked) delete target.locked
        else target.locked = true
        pushArchEdit(
          next,
          [makeChange(wasLocked ? 'unlock' : 'lock', 'architectureNode', nodeId, {
            field: 'locked',
            oldValue: wasLocked,
            newValue: !wasLocked,
            reason: wasLocked ? '用户解锁模块（解除设计冻结）' : '用户锁定模块（冻结其设计）',
          })],
          wasLocked ? `已解锁模块 ${nodeId}` : `已锁定模块 ${nodeId}`,
        )
      }

      /**
       * 在架构视图里建立两模块之间的关系。
       *
       * **架构允许双向关系与环，这里不做任何拓扑检查** —— 前后端互相调用、
       * 事件回环在架构层是合法的；把它当错误才是 bug。任务图那套「会成环就拒绝」
       * 的逻辑绝不能借过来用（评审 C 明确要求两者不混）。
       *
       * 双向的编码方式：模型里 `bidirectional` 是**边自己的一个布尔**，
       * 我们用「from↔to 同 kind 的两条边，都标 bidirectional」来表达它。
       * 这样单看任一条边都能回答「它是不是双向的」，也不需要在边上另设
       * 反向引用字段（那会制造两个真相）。
       */
      const editAddArchEdge = (fromId, toId, kindRaw) => {
        const arch = st.architecture
        const api = canvasRef.current
        if (!arch) return
        if (!workspaceKnown()) {
          if (api) api.setHint('无法确定工作区；架构编辑已停用（宿主未提供会话工作区）', 'error')
          return
        }
        const kind = ARCH_EDGE_KINDS.indexOf(kindRaw) >= 0 ? kindRaw : 'call'
        if (!fromId || !toId) return
        if (fromId === toId) {
          if (api) api.setHint('架构图也不接受自环：一个模块不能连到自己', 'error')
          return
        }
        const hasNode = (id) => arch.nodes.some((n) => n.id === id)
        if (!hasNode(fromId) || !hasNode(toId)) {
          if (api) api.setHint('关系的两端必须都是架构里已有的模块', 'error')
          return
        }
        const forwardId = archEdgeId(fromId, toId, kind)
        if (arch.edges.some((e) => e.id === forwardId)) {
          if (api) api.setHint(`这条关系已经在架构里了：${forwardId}`, 'error')
          return
        }
        const label = ARCH_EDGE_LABELS[kind] || kind
        const next = JSON.parse(JSON.stringify(arch))
        const forward = { id: forwardId, from: fromId, to: toId, kind }
        next.edges = next.edges.concat([forward])
        // 反向线已存在 → 这是一条**合法双向关系**，两边都标 bidirectional。
        const reverseId = archEdgeId(toId, fromId, kind)
        const reverse = next.edges.find((e) => e.id === reverseId)
        const changes = []
        if (reverse) {
          forward.bidirectional = true
          reverse.bidirectional = true
          changes.push(
            makeChange('add', 'architectureEdge', forwardId, {
              newValue: forward,
              reason: `用户建立 ${fromId} 与 ${toId} 之间的双向${label}关系`,
            }),
          )
          changes.push(
            makeChange('modify', 'architectureEdge', reverseId, {
              field: 'bidirectional',
              oldValue: false,
              newValue: true,
              reason: '反向线已存在，这对关系升级为双向',
            }),
          )
        } else {
          changes.push(
            makeChange('add', 'architectureEdge', forwardId, {
              newValue: forward,
              reason: `用户建立 ${fromId} → ${toId} 的${label}关系`,
            }),
          )
        }
        // 环在这里**不写死 warning**：pushArchEdit 会跑 validateArchitectureLocal，
        // 由它统一判定（双向关系天然成环 → 自然得到 ARCH_HAS_CYCLE）。
        // 手写一份 warning 会和本地校验出的那份重复；两个来源 = 两个真相。
        pushArchEdit(
          next,
          changes,
          reverse ? `已建立双向${label}关系 ${fromId} ⇄ ${toId}` : `已建立关系 ${fromId} → ${toId}（${label}）`,
        )
      }

      /** 断开一条架构关系。双向关系要**两条一起删**，否则会留下悬空的反向线。 */
      const editRemoveArchEdge = (edgeId) => {
        const arch = st.architecture
        if (!arch || !workspaceKnown()) return
        const edge = arch.edges.find((e) => e.id === edgeId)
        if (!edge) return
        const next = JSON.parse(JSON.stringify(arch))
        const removeIds = [edgeId]
        if (edge.bidirectional) {
          const reverseId = archEdgeId(edge.to, edge.from, edge.kind)
          if (next.edges.some((e) => e.id === reverseId)) removeIds.push(reverseId)
        }
        const removed = next.edges.filter((e) => removeIds.indexOf(e.id) >= 0)
        next.edges = next.edges.filter((e) => removeIds.indexOf(e.id) < 0)
        pushArchEdit(
          next,
          removed.map((e) =>
            makeChange('remove', 'architectureEdge', e.id, { oldValue: e, reason: '用户在架构视图断开关系' }),
          ),
          `已断开 ${edge.from} ${edge.bidirectional ? '⇄' : '→'} ${edge.to}`,
        )
      }

      const editArchUndo = () => {
        if (!canArchUndo()) return
        archFuture.current.push(JSON.parse(JSON.stringify(st.architecture)))
        const prev = archPast.current.pop()
        st.architecture = prev
        if (st.architecture && !st.architecture.nodes.some((n) => n.id === st.selectedNodeId)) st.selectedNodeId = null
        bump()
        run(async () => {
          await commitArchitecture(
            [makeChange('modify', 'architectureNode', prev.architectureId, { field: 'revision', oldValue: prev.revision - 1, newValue: prev.revision, reason: '撤销回退到上一版' })],
            '已撤销上一步架构编辑',
          )
        }, '')
      }

      const editArchRedo = () => {
        if (!canArchRedo()) return
        archPast.current.push(JSON.parse(JSON.stringify(st.architecture)))
        const next = archFuture.current.pop()
        st.architecture = next
        bump()
        run(async () => {
          await commitArchitecture([], '已重做架构编辑')
        }, '')
      }

      /** 采纳架构 —— 架构本身已经是不可变 revision 追加，不存在「草案待采纳」。 */
      const adoptArchitecture = () =>
        run(async () => {
          if (!st.architecture) return
          await commitArchitecture([], '架构已是不可变 revision（每次保存即产生新版本）')
        }, '')

      /**
       * 连线。评审 09 C 的原始缺陷：合法连线只 setHint 一句「没有写进草案」。
       *
       * 现在分三层：
       *   1. 本地即时校验（端口存在、类型一致、单来源）——快反馈，但不是裁决；
       *   2. 真的改草案并写盘 ——「画布看到的 = 草案里的」；
       *   3. 写盘成功后让画布把这根线画上，并更新本地依赖记录。
       * 服务端 /loom/validate 仍是最终裁决；本地校验只是省一次往返。
       *
       * 无向环由服务端负责（任务图必须无环），这里不重复实现拓扑检查 ——
       * 重复实现两份环检测只会产生两个不一致的答案。
       */
      const tryConnect = (sourceId, targetId, givenSourcePort, givenTargetPort) => {
        const wf = st.workflow
        const api = canvasRef.current
        if (!wf || !api) return
        if (!workspaceKnown()) {
          api.setHint('无法确定工作区；连线的草案写入已停用（宿主未提供会话工作区）', 'error')
          return
        }
        const from = wf.nodes.find((n) => n.id === sourceId)
        const to = wf.nodes.find((n) => n.id === targetId)
        if (!from || !to) {
          api.setHint('连线的两端必须都是图中已有的节点', 'error')
          return
        }
        // 端口没给全时自动挑第一对类型兼容的端口（连线模式下的便捷路径）。
        let outPort = givenSourcePort ? (from.outputs || []).find((p) => p.name === givenSourcePort) : null
        let inPort = givenTargetPort ? (to.inputs || []).find((p) => p.name === givenTargetPort) : null
        if (!outPort || !inPort) {
          for (const o of from.outputs || []) {
            const hit = (to.inputs || []).find((p) => p.artifactType === o.artifactType)
            if (hit) {
              outPort = o
              inPort = hit
              break
            }
          }
        }
        if (!outPort || !inPort) {
          api.setHint(`${from.id} 与 ${to.id} 之间没有类型兼容的端口（需要相同 artifactType）`, 'error')
          return
        }
        if (outPort.artifactType !== inPort.artifactType) {
          api.setHint(
            `类型不匹配：${from.id}.${outPort.name} 是 ${labelOf(outPort.artifactType)}，${to.id}.${inPort.name} 是 ${labelOf(inPort.artifactType)}`,
            'error',
          )
          return
        }
        const dup = wf.edges.some((e) => e.target === to.id && e.targetPort === inPort.name)
        if (dup) {
          api.setHint(`${to.id}.${inPort.name} 已经有来源；多来源汇合请用汇合节点，不要静默覆盖`, 'error')
          return
        }
        const selfLoop = wf.edges.some(
          (e) => e.source === to.id && e.target === from.id && e.artifactType === outPort.artifactType,
        )
        if (selfLoop) {
          api.setHint('这两点之间已有反向同类连线；双向依赖会让任务图成环', 'error')
          return
        }
        const edgeId = `${from.id}.${outPort.name}->${to.id}.${inPort.name}`
        if (wf.edges.some((e) => e.id === edgeId)) {
          api.setHint('这条连线已经在草案里了', 'error')
          return
        }
        pushHistory()
        const next = cloneWorkflow(wf)
        next.edges = next.edges.concat([
          {
            id: edgeId,
            source: from.id,
            sourcePort: outPort.name,
            target: to.id,
            targetPort: inPort.name,
            artifactType: outPort.artifactType,
            require: 'validated',
          },
        ])
        st.workflow = next
        bump()
        run(async () => {
          await commitDraft(`已连线 ${from.id}.${outPort.name} → ${to.id}.${inPort.name}（${labelOf(outPort.artifactType)}）并写入草案`)
        }, '')
      }

      /** 断开一条边。仍然要回写草案，否则截图上少一条线的图和磁盘对不上。 */
      const editRemoveEdge = (edgeId) => {
        const wf = st.workflow
        if (!wf || !workspaceKnown()) return
        const edge = wf.edges.find((e) => e.id === edgeId)
        if (!edge) return
        pushHistory()
        const next = cloneWorkflow(wf)
        next.edges = next.edges.filter((e) => e.id !== edgeId)
        st.workflow = next
        bump()
        run(async () => {
          await commitDraft(`已断开 ${edge.source} → ${edge.target}（${labelOf(edge.artifactType)}）`)
        }, '')
      }

      /** 采纳草案为新 revision。旧 revision 不变，运行中的图不受影响。 */
      const adoptDraft = () =>
        run(async () => {
          const wf = st.workflow
          if (!wf) return
          const result = await requestJSON(API, '/adopt', {
            method: 'POST',
            body: {
              workflowId: wf.workflowId,
              candidate: { workflow: wf },
              expectedRevision: (st.snapshot.revisions.filter((r) => r.workflowId === wf.workflowId).at(-1) || {}).revision ?? null,
              revision: wf.revision + 1,
            },
          })
          await load(wf.workflowId)
          if (result && result.workflow) {
            st.notice = `已采纳为新 revision ${result.workflow.revision}（旧版 ${wf.revision} 保持不变）`
          }
        }, '')

      /**
       * 在草案里新增一个节点。
       *
       * 新节点的字段要**齐全**：数据模型里 `inputs/outputs/ownership/execution/
       * acceptance` 都是必填，缺一个就会被 /loom/validate 判死。所以这里按 kind
       * 给出一套保守默认值，而不是留空 —— 留空等于造一个必然校验失败的节点。
       *
       * 用户拿到的是一个「可编辑的骨架」：目标、端口、完成条件都能在右侧面板改。
       */
      const KIND_DEFAULTS = {
        inspect: { role: 'investigator', phase: 'discovery', outputs: [['report', 'repo-report']], isolation: 'read-only', backend: 'deterministic' },
        contract: { role: 'architect', phase: 'architecture', outputs: [['contract', 'interface-contract']], isolation: 'read-only', backend: 'configured-agent' },
        agent: { role: 'implementer', phase: 'implementation', outputs: [['change', 'code-change']], isolation: 'worktree', backend: 'configured-agent' },
        verify: { role: 'verifier', phase: 'verification', outputs: [['evidence', 'test-evidence']], isolation: 'read-only', backend: 'deterministic' },
        gate: { role: 'gatekeeper', phase: 'integration', outputs: [], isolation: 'read-only', backend: 'deterministic' },
        integrate: { role: 'integrator', phase: 'integration', outputs: [['commit', 'project-commit']], isolation: 'integration-worktree', backend: 'deterministic' },
        report: { role: 'reporter', phase: 'verification', outputs: [['report', 'delivery-report']], isolation: 'read-only', backend: 'deterministic' },
      }

      const editAddNode = () => {
        const wf = st.workflow
        if (!wf || !workspaceKnown()) return
        const kind = st.newNode.kind
        const rawId = (st.newNode.id || '').trim()
        const nodeId = rawId || `${kind}-${wf.nodes.length + 1}`
        if (!/^[a-z][a-z0-9_-]{0,63}$/.test(nodeId)) {
          st.problem = `节点 id "${nodeId}" 不合规：必须以小写字母开头，只含小写字母/数字/下划线/连字符，长度 ≤64`
          st.notice = ''
          bump()
          return
        }
        if (wf.nodes.some((n) => n.id === nodeId)) {
          st.problem = `节点 id "${nodeId}" 已存在；id 是稳定标识，不能重复`
          st.notice = ''
          bump()
          return
        }
        const d = KIND_DEFAULTS[kind] || KIND_DEFAULTS.agent
        const goal = (st.newNode.goal || '').trim() || `（待填写）${nodeId} 的目标`
        const node = {
          id: nodeId,
          kind,
          title: st.newNode.title && st.newNode.title.trim() ? st.newNode.title.trim() : nodeId,
          phase: d.phase,
          goal,
          role: d.role,
          sourceRefs: [],
          inputs: [],
          outputs: d.outputs.map(([name, artifactType]) => ({ name, artifactType, required: true })),
          ownership: { writes: [], forbiddenWrites: [], sharedResources: [] },
          execution: { backend: d.backend, isolation: d.isolation, timeoutSeconds: 900, maxRepairAttempts: 1 },
          acceptance: { doneWhen: ['（待填写）可独立核对的结果'], commands: [], independentVerification: true },
        }
        pushHistory()
        const next = cloneWorkflow(wf)
        next.nodes = next.nodes.concat([node])
        st.workflow = next
        st.selectedNodeId = nodeId
        st.newNode = { kind, id: '', goal: '' }
        bump()
        if (canvasRef.current) canvasRef.current.select(nodeId)
        run(async () => {
          await commitDraft(`已新增节点 ${nodeId}（${KIND_LABELS[kind] || kind}）。目标与完成条件是待填占位，采纳前请补全。`)
        }, '')
      }

      /**
       * 改节点字段。
       *
       * 只允许改「语义字段」，且必须重新跑校验 —— 端口类型一改，
       * 挂在它上面的边就可能变成类型不匹配，那种图不能采纳执行。
       */
      const editNodeField = (nodeId, path, value) => {
        const wf = st.workflow
        if (!wf || !workspaceKnown()) return
        pushHistory()
        const next = cloneWorkflow(wf)
        const target = next.nodes.find((n) => n.id === nodeId)
        if (!target) return
        const segs = path.split('.')
        let cur = target
        for (let i = 0; i < segs.length - 1; i += 1) {
          if (cur[segs[i]] === undefined || cur[segs[i]] === null) cur[segs[i]] = {}
          cur = cur[segs[i]]
        }
        cur[segs[segs.length - 1]] = value
        st.workflow = next
        bump()
        run(async () => {
          await commitDraft(`已修改 ${nodeId}.${path}`)
        }, '')
      }

      React.useEffect(() => {
        if (!stageRef.current || canvasRef.current) return
        canvasRef.current = mountCanvas(stageRef.current, {
          onAgentDrop: (memberId,taskId) => {if(!st.busy&&st.flow&&organization().members.some(m=>m.id===memberId&&m.role==='executor'))assignMember(taskId,memberId)},
          onSelection: ids => {st.canvasPicked=ids;st.teamPicked=ids;st.flowPicked=st.flow?st.flow.order.filter(id=>st.flow.steps.find(s=>s.id===id)?.taskIds.some(task=>ids.includes(task))):[];bump()},
          onGroupDrop: (ids,teamId) => {
            if(st.busy||!st.flow||st.view==='architecture')return
            editOrganization(org=>{org.teams=org.teams.map(t=>({...t,taskIds:t.id===teamId?[...new Set([...t.taskIds,...ids])]:t.taskIds.filter(id=>!ids.includes(id))})).filter(t=>t.taskIds.length)})
            st.notice='已调整责任组，保存后生效';bump()
          },
          onSelect: (id) => {
            st.selectedNodeId = id
            const textTask=document.querySelector?.('[data-loom-plan-task="'+id+'"]');textTask?.scrollIntoView?.({block:'nearest'})
            // 架构视图的选点只用来选「关系的起终点」，不走任务图的连线模式。
            if (st.view === 'architecture') {
              if (!id) st.archLinkFrom = null
              bump()
              return
            }
            if (st.linkMode && id) {
              // 连线模式：第一次点选是起点，第二次点选是终点。
              if (!st.linkFrom) {
                st.linkFrom = id
                bump()
                return
              }
              if (st.linkFrom === id) {
                st.linkFrom = null
                bump()
                return
              }
              const from = st.linkFrom
              st.linkFrom = null
              bump()
              void tryConnect(from, id)
              return
            }
            bump()
          },
          onConnect: (conn) => {
            if (st.view === 'architecture') return
            void tryConnect(conn.source, conn.target, conn.sourcePort, conn.targetPort)
          },
          onLayoutChange: layout => {
            canvasLayouts.set(layoutKey(), layout)
            if (st.view === 'flow' && st.flow) {
              // 卡片必须落在步骤栏里：拖动后吸附（横向位置＝栏内顺序，保留用户摆的顺序）。
              canvasRef.current.setPositions(snapFlowPositions(layout))
              st.flowDirty = true
              canvasRef.current.setHint('流程顺序已改（尚未保存）。点「保存流程」，需要写进依赖就点「应用为新依赖」。', null)
              bump()
              return
            }
            if (st.view === 'architecture') {
              // 架构没有 presentation 分区：坐标改了只在本次会话里有效，明确说出来。
              canvasRef.current.setHint('架构图布局只在本次会话生效（架构不存布局，布局属于任务图）', null)
              return
            }
            if (!workspaceKnown()) {
              canvasRef.current.setHint('布局改动只在本地；宿主未提供工作区，无法保存', 'error')
              return
            }
            canvasRef.current.setHint('布局已改（尚未保存）。布局不影响执行语义。', null)
          },
        })
        return () => {
          if (canvasRef.current) {
            canvasRef.current.destroy()
            canvasRef.current = null
          }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      React.useEffect(() => {
        run(() => load())
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      /**
       * 视图切换：换的是**画布上的图源**，不是数据本身。
       *
       * 这条 effect 依赖 st.view，所以切标签页时重铺画布；
       * st.workflow / st.architecture 都不动 —— 这就是「切视图不丢数据」。
       * 如果架构还没加载过，顺带补一次读取（不阻塞任务图渲染）。
       */
      React.useEffect(() => {
        syncGraph()
        // 画布刚被重铺（位置来自布局缓存）时，流程视图要再吸回步骤栏一次。
        if (st.view === 'flow' && st.flow) flowLayout()
        if (st.view === 'architecture' && !st.archLoaded && st.ready) {
          run(async () => {
            await loadArchitecture()
          }, '')
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [st.workflow, st.validation, st.snapshot, st.view, st.architecture, st.edgeStyle, st.flowOrientation, st.globalConfig, syncGraph])

      /* ---------- 动作 ---------- */
      const saveLayout = () =>
        run(async () => {
          const wf = st.workflow
          if (!wf) return
          const layout = graphRef.current.nodes.map((n) => ({ nodeId: n.id, x: Math.round(n.x), y: Math.round(n.y) }))
          await requestJSON(API, '/presentation', {
            method: 'POST',
            body: {
              presentation: {
                schemaVersion: 1,
                workflowId: wf.workflowId,
                forRevision: wf.revision,
                nodes: layout,
                groups: (st.snapshot.presentation && st.snapshot.presentation.groups) || [],
                reroutes: [],
                annotations: [],
              },
            },
          })
          await load(wf.workflowId)
        }, '布局已保存（不影响执行语义）')

      const doValidate = () =>
        run(async () => {
          if (st.view === 'architecture') {
            if (!st.architecture) return
            st.archValidation = await requestJSON(API, '/validate', {
              method: 'POST',
              body: { kind: 'architecture', document: st.architecture },
            })
            return
          }
          if (!st.workflow) return
          st.validation = await requestJSON(API, '/validate', {
            method: 'POST',
            body: { kind: 'workflow', document: st.workflow },
          })
        }, '结构校验完成（不代表可执行）')

      const doCompile = () =>
        run(async () => {
          if (!st.workflow) return
          if (draftDirty()) throw new Error('请先采纳任务草案，再编译画布上的任务版本')
          st.compile = await requestJSON(API, '/compile', {
            method: 'POST',
            body: { workflowId: st.workflow.workflowId, revision: st.workflow.revision },
          })
        }, '已生成编译预览（未派发）')

      const doPrompt = (kind) =>
        run(async () => {
          const k = kind || st.promptKind
          if (k !== 'architecture' && draftDirty()) throw new Error('请先采纳任务草案，再导出对应版本的任务或协调提示词')
          st.promptKind = k
          // 三条独立路线（评审 09 D）：architecture / task / coordinator。
          // 架构路线在还没有任务图时也能导出，所以这里不因缺 workflow 而短路
          // —— 旧代码开头那句 `if (!st.workflow) return` 正好把这条路堵死了。
          const body = { kind: k }
          if (k === 'coordinator') {
            if (!st.workflow) {
              st.problem = '协调总提示词需要一个任务图；请先采纳一份任务图'
              return
            }
            body.workflowId = st.workflow.workflowId
            body.revision = st.workflow.revision
          } else if (k === 'task') {
            if (!st.workflow) {
              st.problem = '任务包需要一个任务图'
              return
            }
            body.workflowId = st.workflow.workflowId
            body.revision = st.workflow.revision
            if (st.selectedNodeId) body.nodeId = st.selectedNodeId
          } else {
            if (!st.architecture) {
              st.problem = '架构提示词需要一份 ArchitectureRevision；请先在架构视图新增模块并保存，或让模型提交架构'
              return
            }
            // architectureId 直接取自**画布上正在看的这份架构** —— 导出的内容
            // 与用户看到的必须一致，不能拿草案里过期的一个 id 去导出。
            body.architectureId = st.architecture.architectureId
            if (st.selectedNodeId) {
              body.nodeId = st.selectedNodeId
              body.scope = { nodeIds: [st.selectedNodeId] }
            } else {
              body.scope = 'all'
            }
          }
          st.promptText = await requestJSON(API, '/prompt', { method: 'POST', body })
        }, kind === 'architecture' ? '已导出架构优化提示词' : kind === 'task' ? '已导出任务包' : '已导出协调总提示词')

      const setMode = (mode) => {
        if (st.replyWaiting) { st.problem = 'AI 正在生成方案：现在切换模式会让本次请求失效（草案基线变化）。请等读取完成，或先点「停止读取回复」再切换。'; bump(); return }
        if (mode === st.mode) {
          st.notice = mode === 'auto' ? '已处于自动模式（草案与锁定约束保留）' : '已处于手动模式（草案与锁定约束保留）'
          bump()
          return Promise.resolve()
        }
        return run(async () => {
          await writeDraft({ mode })
          await load(st.workflow && st.workflow.workflowId)
        }, mode === 'auto' ? '已切到自动模式（草案与锁定约束保留）' : '已切到手动模式（草案与锁定约束保留）')
      }

      const newWorkflow = () => run(async () => {
        st.workflow = { schemaVersion: '0.1', workflowId: 'loom-default', revision: 1,
          title: '新项目任务图', detectedStage: 'planning', evidence: [], assumptions: [], openQuestions: [],
          executionProposal: { runtime: 'wsl', maxConcurrency: st.globalConfig?.defaultMaxConcurrency || 2, requiredBaseline: 'selected-frozen-commit',
            requiredCapabilities: ['real-parent-agent', 'parallel-agents', 'worktree', 'cancel-cleanup', 'artifact-verification', 'wsl-execution'] },
          nodes: [], edges: [] }
        st.serverDigest = ''
        await writeDraft({ candidate: cloneWorkflow(st.workflow) })
        syncGraph()
      }, '已建立空白任务草案，可以添加节点')

      const newArchitecture = () => run(async () => {
        const architecture = { schemaVersion: 1, architectureId: 'loom-architecture', revision: 1,
          nodes: [], edges: [], constraints: [], createdAt: new Date().toISOString() }
        await requestJSON(API, '/architecture', { method: 'POST', body: { architecture, expectedRevision: null } })
        await writeDraft({ architectureId: architecture.architectureId, architectureRevision: 1 })
        await load()
      }, '已建立空白架构，可以添加模块')

      React.useEffect(() => {
        let unsubscribe = null
        try {
          const ui = hostContext && (hostContext.get?.('uiSession') ?? hostContext.uiSession)
          let previous = currentSessionId()
          unsubscribe = ui?.adapter?.current?.subscribe?.(() => {
            const next = currentSessionId()
            if (next === previous) return
            viewCache.set(st.boundSession,{goal:st.goal,planningConstraints:st.planningConstraints,mode:st.mode,view:st.view,edgeStyle:st.edgeStyle,flowOrientation:st.flowOrientation,promptText:st.promptText,replyText:st.replyText,replyPreview:st.replyPreview,lastPreviewError:st.lastPreviewError})
            st.boundSession=next
            previous = next; sessionGeneration++; resolvedSession = ''; setWorkspace('')
            seat.canvasOnly = false; notifySeat()
            st.workflow = null; st.architecture = null; st.ready = false; st.busy = false
            st.snapshot = null; st.selectedNodeId = null; st.promptText = null; st.flow = null; st.flowDirty = false
            st.replyText = ''; st.replyPreview = null; st.lastPreviewError = ''; st.problem = ''; st.notice = ''; st.archLoaded = false; st.goal = ''; st.planningConstraints = ''; st.sessionEnabled = false
            Object.assign(st,viewCache.get(next)||{})
            past.current = []; future.current = []; archPast.current = []; archFuture.current = []
            bump()
            load().then(bump).catch((e) => { if (e.code !== 'STALE_SESSION_RESPONSE') { st.problem = e.message; bump() } })
          })
        } catch { /* missing session service is shown by unresolved workspace */ }
        return () => { if (typeof unsubscribe === 'function') unsubscribe() }
      }, [load])

      const previewReply = () => run(async () => {
        st.replyPreview = null
        st.lastPreviewError = ''
        if (!st.promptText || !['architecture', 'planning'].includes(st.promptText.kind)) throw new Error('请先导出规划或架构提示词')
        const reply = extractPlanningReply(st.replyText)
        try {
          st.replyPreview = await requestJSON(API, st.promptText.kind === 'planning' ? '/planning/preview' : '/architecture/preview', { method: 'POST', body: { payloadHash: st.promptText.payloadHash, reply } })
          st.invalidStreak = 0
        } catch (error) {
          st.lastPreviewError = String((error && error.message) || error)
          // 连续失败计数：给低配模型护栏用（连续 N 次后提示换更强模型）。
          st.invalidStreak = (Number.isFinite(st.invalidStreak) ? st.invalidStreak : 0) + 1
          throw error
        }
      }, '候选已校验，请查看改动后采纳')

      const acceptReply = () => run(async () => {
        if (!st.replyPreview) return
        const preview = st.replyPreview
        const reply = extractPlanningReply(st.replyText)
        const planning = st.promptText?.kind === 'planning'
        await requestJSON(API, planning ? '/planning/accept' : '/architecture/accept', { method: 'POST', body: { payloadHash: st.promptText.payloadHash, reply, candidateHash: preview.candidateHash, ...(planning ? { expectedArchitectureRevision: preview.expectedArchitectureRevision, expectedWorkflowRevision: preview.expectedWorkflowRevision } : { expectedRevision: preview.expectedRevision }) } })
        if (planning) st.view = 'architecture'
        st.replyPreview = null; st.replyText = ''; st.promptText = null; st.lastPreviewError = ''; st.invalidStreak = 0
        await load()
      }, '已采纳 AI 优化方案，旧架构版本保留')

      const replyWatch = React.useRef(null)
      const stopReplyWatch = () => {
        const watch = replyWatch.current; replyWatch.current = null
        st.replyWaiting = false
        if (watch) { clearTimeout(watch.timer); clearTimeout(watch.retry); watch.dispose?.(); watch.ref?.release?.() }
      }
      React.useEffect(() => {
        const ui = hostContext && (hostContext.get?.('uiSession') ?? hostContext.uiSession)
        const unsubscribe = ui?.adapter?.current?.subscribe?.(() => { if (replyWatch.current && replyWatch.current.id !== currentSessionId()) stopReplyWatch() })
        return () => { unsubscribe?.(); stopReplyWatch() }
      }, [])

      const submitText = (text, statusMessage, kind) => run(async () => {
        if (st.globalConfig?.enabled === false) throw new Error('请先打开 Loom 总开关')
        if (!st.promptText || !st.promptText.text) throw new Error('请先导出提示词')
        const id = currentSessionId(), generation = sessionGeneration
        if (!id || id !== resolvedSession) throw new Error('会话已切换，请先重新导出提示词')
        const sessions = hostContext && (hostContext.get?.('sessions') ?? hostContext.sessions)
        if (!sessions || typeof sessions.using !== 'function') throw new Error('当前宿主没有会话发送入口，请复制提示词发送')
        const outgoing = await stageOutgoingRequest(text, kind)
        st.promptText.sentText = outgoing
        const exported = st.promptText
        stopReplyWatch()
        const send = async (binding, ref) => {
          if (id !== currentSessionId() || generation !== sessionGeneration) throw new Error('会话已切换，未发送')
          const session = binding.session
          const submission = session.beginSubmission({ mode: 'queue', text: outgoing, attachments: [] })
          const source = binding.eventSource
          let watch = null
          if (ref && source?.subscribe && source?.getSnapshot) {
            const entries = source.getSnapshot().entries || []
            watch = { id, ref, requestId: submission.requestId, text: outgoing, afterSeq: Math.max(-1, ...entries.filter(e => e.type === 'event').map(e => e.event.seq)), accepted: false, sentAt: Date.now() }
            const collect = async () => {
              if (!watch.accepted || replyWatch.current !== watch || watch.settling) return
              if (generation !== sessionGeneration || id !== currentSessionId() || st.promptText !== exported) { stopReplyWatch(); return }
              try {
                const reply = readSubmittedReply(source.getSnapshot(), watch)
                if (reply === null) return
                if (st.mode === 'auto' && st.busy) { clearTimeout(watch.retry); watch.retry = setTimeout(collect, 50); return }
                watch.settling = true
                const planFile = await readPlanFile()
                if (generation !== sessionGeneration || id !== currentSessionId() || st.promptText !== exported) { stopReplyWatch(); return }
                stopReplyWatch()
                const fresh = planFile && (!watch.sentAt || !planFile.mtimeMs || planFile.mtimeMs >= watch.sentAt - 5000) ? planFile.text : null
                st.replyText = preferPlanFileReply(reply, fresh, exported.payloadHash); st.replyPreview = null; bump()
                if (st.mode === 'auto' && st.globalConfig?.autoCollectReplies !== false) previewReply()
                else { st.notice = '已读取本次 AI 回复，请预览候选改动'; bump() }
              } catch (error) { stopReplyWatch(); st.problem = error.message; bump() }
            }
            watch.dispose = source.subscribe(collect); watch.collect = collect
            replyWatch.current = watch; st.replyWaiting = true
            watch.timer = setTimeout(() => { if (replyWatch.current === watch) { stopReplyWatch(); st.notice = '等待 AI 回复已超过 20 分钟，请在会话中检查状态并粘贴完整 JSON'; bump() } }, 20 * 60 * 1000)
          }
          try {
            const result = await session.prompt([{ type: 'text', text: outgoing }], 'queue', undefined, submission.requestId)
            if (!result || !result.ok) throw new Error(result?.error?.message || '宿主拒绝提示词提交')
            if (watch) { watch.accepted = true; setTimeout(watch.collect, 0) }
          } catch (error) { submission.abandon(); stopReplyWatch(); throw error }
        }
        if (['architecture', 'planning'].includes(exported.kind) && st.globalConfig?.autoCollectReplies !== false && typeof sessions.retain === 'function') {
          const ref = sessions.retain(id, { source: 'controllerOperation' })
          try { await send(await ref.ready, ref); if (replyWatch.current?.ref !== ref) ref.release() }
          catch (error) { ref.release(); throw error }
        } else await sessions.using(id, { source: 'controllerOperation' }, async ref => send(await ref.ready, null))
      }, statusMessage)

      /* ---------- 流程视图（0.6.0）：顺序 / 子代理数量 / 审计分组 ---------- */
      const loadFlow = () => run(async () => {
        if (!st.workflow) throw new Error('先在规划里采纳一份任务图，流程视图才有东西可排')
        const data = await requestJSON(API, '/flow?workflowId=' + encodeURIComponent(st.workflow.workflowId))
        st.flow = data.plan
        st.flowServerDigest = data.digest || null
        st.flowSaved = Boolean(data.saved)
        st.flowWarnings = Array.isArray(data.warnings) ? data.warnings : []
        st.flowDirty = !data.saved && st.flowWarnings.length>0
        st.flowPicked = []
        if (Number.isInteger(data.maxAgents) && data.maxAgents >= 1) st.flowMaxAgents = data.maxAgents
      })
      const flowCheckpoint=()=>{if(st.flow){st.flowPast.push(JSON.parse(JSON.stringify(st.flow)));if(st.flowPast.length>50)st.flowPast.shift();st.flowFuture=[]}}
      const organization=()=>st.flow.organization||{members:st.workflow.nodes.map(n=>({id:'member-'+n.id,label:n.title,role:'executor',responsibility:n.role,taskIds:[n.id]})),teams:[],communicationRounds:1}
      const editOrganization=(fn)=>{if(!st.flow)return;flowCheckpoint();const org=JSON.parse(JSON.stringify(organization()));fn(org);st.flow={...st.flow,organization:org};st.flowDirty=true;syncGraph();flowLayout();bump()}
      const addMember=(role)=>editOrganization(org=>{let i=1;while(org.members.some(m=>m.id==='member-'+role+'-'+i))i++;const ids=role==='executor'?[...st.canvasPicked]:[];if(ids.length)org.members.forEach(m=>{if(m.role==='executor')m.taskIds=m.taskIds.filter(id=>!ids.includes(id))});org.members.push({id:'member-'+role+'-'+i,label:(role==='executor'?'执行负责人':role==='supervisor'?'分管':'独立审查')+' '+i,role,responsibility:role==='executor'?'实现所负责模块并提交可核验产物':role==='supervisor'?'汇总组内文件、协调接口并回传证据':'独立检查合同、实现与验证结果',taskIds:ids})})
      const removeMember=id=>editOrganization(org=>{org.members=org.members.filter(m=>m.id!==id)})
      const assignMember=(taskId,id)=>editOrganization(org=>{org.members.forEach(m=>{m.taskIds=m.taskIds.filter(t=>t!==taskId);if(m.id===id)m.taskIds.push(taskId)})})
      const newTeam=()=>editOrganization(org=>{
        if(!st.teamPicked.length)return
        let i=1;while(org.teams.some(t=>t.id==='team-'+i))i++
        const ids=[...st.teamPicked],supervisorId='lead-'+i,reviewerId='reviewer-'+i
        org.teams=org.teams.map(t=>({...t,taskIds:t.taskIds.filter(id=>!ids.includes(id))})).filter(t=>t.taskIds.length)
        if(!org.members.some(m=>m.id===supervisorId))org.members.push({id:supervisorId,label:'分管 '+i,role:'supervisor',responsibility:'汇总本组任务、协调共享接口并回传证据',taskIds:[]})
        if(!org.members.some(m=>m.id===reviewerId))org.members.push({id:reviewerId,label:'独立审查 '+i,role:'reviewer',responsibility:'独立检查本组合同和文件证据，阻断失败交付',taskIds:[]})
        org.teams.push({id:'team-'+i,label:'责任组 '+i,taskIds:ids,supervisorId,reviewerId});st.teamPicked=[]
      })
      const mergePickedSteps=()=>{
        if(!st.flow||st.flowPicked.length<2)return
        const picked=st.flow.order.filter(id=>st.flowPicked.includes(id)),positions=picked.map(id=>st.flow.order.indexOf(id))
        if(Math.max(...positions)-Math.min(...positions)+1!==picked.length){st.problem='合并阶段需要相邻步骤；先调整顺序。真实任务依赖会保留。';bump();return}
        flowCheckpoint();const keep=picked[0],tasks=st.flow.steps.filter(s=>picked.includes(s.id)).flatMap(s=>s.taskIds),agents=Math.max(...st.flow.steps.filter(s=>picked.includes(s.id)).map(s=>s.agents))
        st.flow={...st.flow,steps:st.flow.steps.filter(s=>!picked.includes(s.id)||s.id===keep).map(s=>s.id===keep?{...s,taskIds:tasks,agents}:s),order:st.flow.order.filter(id=>!picked.includes(id)||id===keep),groups:st.flow.groups.map(g=>({...g,stepIds:[...new Set(g.stepIds.map(id=>picked.includes(id)?keep:id))]}))}
        st.flowPicked=[];st.flowDirty=true;flowLayout();bump()
      }
      const splitPickedStep=()=>{
        if(!st.flow||st.flowPicked.length!==1)return
        const step=st.flow.steps.find(s=>s.id===st.flowPicked[0]);if(!step||step.taskIds.length<2)return
        const remaining=new Set(step.taskIds),ordered=[]
        while(remaining.size){const id=step.taskIds.find(id=>remaining.has(id)&&!st.workflow.edges.some(e=>e.target===id&&remaining.has(e.source)));if(!id){st.problem='步骤内依赖无法拆分，请检查 DAG';bump();return}ordered.push(id);remaining.delete(id)}
        flowCheckpoint();let i=1;const ids=new Set(st.flow.steps.map(s=>s.id)),parts=ordered.map(taskId=>{let id;do{id=step.id+'-part-'+i++}while(ids.has(id));ids.add(id);return{id,taskIds:[taskId],agents:1}})
        st.flow={...st.flow,steps:st.flow.steps.flatMap(s=>s.id===step.id?parts:[s]),order:st.flow.order.flatMap(id=>id===step.id?parts.map(s=>s.id):[id]),groups:st.flow.groups.map(g=>({...g,stepIds:g.stepIds.flatMap(id=>id===step.id?parts.map(s=>s.id):[id])}))};st.flowPicked=[];st.flowDirty=true;flowLayout();bump()
      }
      const flowUndo=()=>{if(!st.flowPast.length)return;st.flowFuture.push(JSON.parse(JSON.stringify(st.flow)));st.flow=st.flowPast.pop();st.flowDirty=true;flowLayout();bump()}
      const flowRedo=()=>{if(!st.flowFuture.length)return;st.flowPast.push(JSON.parse(JSON.stringify(st.flow)));st.flow=st.flowFuture.pop();st.flowDirty=true;flowLayout();bump()}
      const flowMove = (stepId, delta) => {
        if (!st.flow) return
        flowCheckpoint()
        const order = st.flow.order.slice()
        const at = order.indexOf(stepId)
        const to = at + delta
        if (at < 0 || to < 0 || to >= order.length) return
        order.splice(at, 1)
        order.splice(to, 0, stepId)
        st.flow = { ...st.flow, order }
        st.flowDirty = true
        bump()
      }
      const flowAgents = (stepId, agents) => {
        if (!st.flow) return
        flowCheckpoint()
        st.flow = { ...st.flow, steps: st.flow.steps.map((step) => (step.id === stepId ? { ...step, agents } : step)) }
        st.flowDirty = true
        bump()
      }
      /** 步骤栏标签上的 ▲▼/◀▶：改 order 后立刻重铺（重铺会把 dirty 清掉，这里补回来）。 */
      const flowMoveStep = (stepId, delta) => {
        if (!st.flow) return
        flowMove(stepId, delta)
        flowLayout()
        if (st.flow) { st.flowDirty = true; bump() }
      }
      const flowPick = (stepId, picked) => {
        if (!st.flow) return
        const rest = st.flowPicked.filter((id) => id !== stepId)
        st.flowPicked = picked ? [...rest, stepId] : rest
        bump()
      }
      /**
       * 任意两步结组：把勾选的步骤结成一个审计组。
       * 勾选数 2..3（服务端一个组最多 3 步）；已经属于别的组的步骤会被**移出来**，
       * 空掉的组自动消失，免得留下「组里没人」的非法计划。
       */
      const flowGroupPicked = () => {
        if (!st.flow) return
        const picked = st.flowPicked.filter((id) => st.flow.steps.some((step) => step.id === id))
        if (picked.length < 2) return
        const rest = st.flow.groups
          .map((group) => ({ ...group, stepIds: group.stepIds.filter((id) => !picked.includes(id)) }))
          .filter((group) => group.stepIds.length)
        const used = new Set(rest.map((group) => group.id))
        let next = rest.length + 1
        while (used.has('group-' + next)) next += 1
        const groups = [...rest, { id: 'group-' + next, stepIds: picked, auditAgentId: null }]
        const alive = new Set(groups.map((group) => group.id))
        const auditAgents = st.flow.auditAgents.map((agent) => (agent.groupId && !alive.has(agent.groupId) ? { ...agent, groupId: null } : agent))
        st.flow = { ...st.flow, groups, auditAgents }
        st.flowPicked = []
        st.flowDirty = true
        bump()
      }
      const flowToggleTask = (stepId, taskId, include) => {
        if (!st.flow) return
        const steps = st.flow.steps.map((step) => ({ ...step, taskIds: step.taskIds.filter((id) => id !== taskId) }))
        if (include) {
          const target = steps.find((step) => step.id === stepId)
          if (target) target.taskIds = [...target.taskIds, taskId]
        }
        st.flow = { ...st.flow, steps }
        st.flowDirty = true
        bump()
      }
      const flowUngroup = (groupId) => {
        if (!st.flow) return
        st.flow = {
          ...st.flow,
          groups: st.flow.groups.filter((group) => group.id !== groupId),
          auditAgents: st.flow.auditAgents.map((agent) => (agent.groupId === groupId ? { ...agent, groupId: null } : agent)),
        }
        st.flowDirty = true
        bump()
      }
      const flowAutoGroup = () => {
        if (!st.flow) return
        const order = st.flow.order
        const groups = []
        for (let i = 0; i < order.length; i += 2) groups.push({ id: 'group-' + (groups.length + 1), stepIds: order.slice(i, i + 2), auditAgentId: null })
        const auditAgents = st.flow.auditAgents.map((agent, i) => ({ ...agent, groupId: groups.length ? groups[i % groups.length].id : null }))
        const bound = groups.map((group) => ({ ...group, auditAgentId: (auditAgents.find((agent) => agent.groupId === group.id) || {}).id || null }))
        st.flow = { ...st.flow, groups: bound, auditAgents }
        st.flowDirty = true
        bump()
      }
      const flowAudit = (groupId, agentId) => {
        if (!st.flow) return
        const groups = st.flow.groups.map((group) => (group.id === groupId ? { ...group, auditAgentId: agentId } : group))
        const auditAgents = st.flow.auditAgents.map((agent) => {
          if (agent.id === agentId) return { ...agent, groupId }
          if (agent.groupId === groupId) return { ...agent, groupId: null }
          return agent
        })
        st.flow = { ...st.flow, groups, auditAgents }
        st.flowDirty = true
        bump()
      }
      const flowSave = () => run(async () => {
        deriveFlow()
        if (!st.flow) return
        const data = await requestJSON(API, '/flow', { method: 'POST', body: { workflowId: st.flow.workflowId, plan: st.flow, expectedDigest:st.flowServerDigest } })
        st.flow = data.plan
        st.flowServerDigest = data.digest || null
        st.flowSaved = true
        st.flowDirty = false
        st.flowWarnings = Array.isArray(data.warnings) ? data.warnings : []
      }, '流程计划已保存')
      const flowApply = () => run(async () => {
        deriveFlow()
        if (!st.flow) return
        const data = await requestJSON(API, '/flow/apply', { method: 'POST', body: { workflowId: st.flow.workflowId, plan: st.flow,expectedDigest:st.flowServerDigest } })
        st.flowSaved = true
        st.flowDirty = false
        await load()
        st.view = 'flow'
        st.notice = `已按流程顺序生成 ${data.addedEdges.length} 条新依赖（草案）；到「开工任务」采纳为新 revision 后生效`
      })

      const sendPrompt = () => submitText(st.promptText ? st.promptText.text : '', '提示词已提交当前 AI 会话；支持事件读取的宿主会自动接收本次架构回复，采纳仍由你决定')
      const resolveQuestions = async () => {
        let prepared=null
        await run(async () => {
          requireActive()
          if(st.directCandidate||st.replyPreview)throw new Error('请先查看并采纳当前候选')
          if(!st.workflow||draftDirty()||archDirty()||st.flowDirty)throw new Error('请先保存并采纳你的任务、架构和编组修改')
          if(!st.architecture)await loadArchitecture()
          const data=await requestJSON(API,'/flow?workflowId='+encodeURIComponent(st.workflow.workflowId))
          prepared=await requestJSON(API,'/plan/resolve',{method:'POST',body:{workflowId:st.workflow.workflowId,revision:st.workflow.revision,architectureRevision:st.architecture?.revision,flowHash:data.digest}})
          st.promptText=prepared
        },'已准备 AI 处理请求')
        if(prepared)await submitText(prepared.text,'已交给当前 AI：查证技术问题、给处理建议；完成后查看并采纳，尚未开工','resolution')
      }
      const repairReply = () => {
        if (!st.promptText || !st.lastPreviewError) return Promise.resolve()
        const text = buildRepairText(st.promptText.payloadHash, st.lastPreviewError)
        st.lastPreviewError = ''
        return submitText(text, '已把校验错误发给 AI；修正回复会自动重新预览候选', 'repair')
      }

      React.useEffect(() => {
        if (!st.ready || !st.promptText || !st.promptText.text || st.replyWaiting || st.replyText || st.replyPreview || st.lastPreviewError) return
        if (!st.sessionEnabled || st.globalConfig?.autoCollectReplies === false) return
        if (!['architecture', 'planning'].includes(st.promptText.kind)) return
        const id = currentSessionId()
        if (!id || id !== resolvedSession) return
        const sessions = hostContext && (hostContext.get?.('sessions') ?? hostContext.sessions)
        if (!sessions || typeof sessions.using !== 'function') return
        let disposed = false
        sessions.using(id, { source: 'controllerOperation' }, async ref => {
          try {
            const binding = await ref.ready
            if (disposed || id !== currentSessionId() || st.replyText || st.replyPreview || st.lastPreviewError) return
            const source = binding.eventSource
            if (!source?.getSnapshot) return
            const reply = recoverSubmittedReply(source.getSnapshot(), st.promptText.sentText || st.promptText.text)
            if (disposed) return
            const planFile = await readPlanFile()
            if (disposed) return
            // 会话事件里找不到回复（会话被重载/精简、回复已过期）时，用项目里的
            // `.loom/plan.json` 兜底；requestId 与本次导出一致才认领，否则当没有。
            const chosen = reply || restorePlanFileReply(planFile, planRestoreHash(st.promptText, planFile))
            if (!chosen) return
            st.replyText = preferPlanFileReply(chosen, planFile ? planFile.text : null, st.promptText.payloadHash); st.replyPreview = null; bump()
            if (st.mode === 'auto' && st.globalConfig?.autoCollectReplies !== false) previewReply()
            else { st.notice = '已找回本次 AI 回复，请预览候选改动'; bump() }
          } catch { /* 找回失败不影响手动粘贴路径 */ }
        }).catch(() => {})
        return () => { disposed = true }
      }, [st.ready, st.promptText, st.boundSession, st.sessionEnabled])

      /**
       * 计划文件恢复候选（窗口重开）。
       *
       * 回复与导出记录都只活在客户端内存里，窗口重开（渲染进程重建）后全没了；
       * 但模型写进项目的 `.loom/plan.json` 还在，服务端也记着最近一次规划请求的
       * requestId（`GET /planning/collect` 一并返回）。这里把两者对上：对得上就把
       * 文件当候选并自动预览；对不上、读不到、校验不过都**静默**，手动粘贴与重新
       * 导出的路径保持可用。同一会话只尝试一次。
       */
      React.useEffect(() => {
        if (!st.ready || st.promptText || st.replyWaiting || st.replyText || st.replyPreview || st.lastPreviewError) return
        if (!st.sessionEnabled || st.globalConfig?.autoCollectReplies === false) return
        const id = currentSessionId()
        if (!id || id !== resolvedSession || planRestoreAttempted.has(id)) return
        planRestoreAttempted.add(id)
        let disposed = false
        ;(async () => {
          try {
            const file = await readPlanFile()
            if (disposed || id !== currentSessionId()) return
            const hash = planRestoreHash(null, file)
            const reply = restorePlanFileReply(file, hash)
            if (!reply) return
            // 文件对上了：补出这次请求的身份，让既有的预览/采纳路径原样可用。
            st.promptText = { kind: 'planning', payloadHash: hash, text: '', restored: true }
            st.replyText = reply
            st.notice = '已从项目里的 .loom/plan.json 找回上次的方案，正在校验候选'
            bump()
            try {
              const preview = await requestJSON(API, '/planning/preview', { method: 'POST', body: { payloadHash: hash, reply: extractPlanningReply(reply) } })
              if (disposed || id !== currentSessionId() || st.promptText?.payloadHash !== hash) return
              st.replyPreview = preview
              st.invalidStreak = 0
              st.notice = '已找回上次的方案候选，确认无误后点「采纳 AI 候选方案」'
            } catch (error) {
              // 找回的方案本身没通过校验：把错误**完整**交给既有的错误面板，
              // 而不是只写一句截断的 notice。这样重开窗口后用户看到的是和关
              // 窗口前一样的「候选校验未通过」面板，也能用上低配模型护栏。
              if (disposed || id !== currentSessionId() || st.promptText?.payloadHash !== hash) return
              st.lastPreviewError = String((error && error.message) || error)
              st.invalidStreak = (Number.isFinite(st.invalidStreak) ? st.invalidStreak : 0) + 1
              st.notice = '已从项目里的 .loom/plan.json 找回上次的方案，但校验没通过 —— 下面列出了完整错误'
            }
            bump()
          } catch { /* 静默：恢复失败不影响手动粘贴与重新导出 */ }
        })()
        return () => { disposed = true }
      }, [st.ready, st.promptText, st.boundSession, st.sessionEnabled])

      React.useEffect(() => {
        let disposed = false
        requestJSON(API, '/config').then(config => { if (!disposed) { st.globalConfig = config; seat.config = config; bump() } }).catch(error => { if (!disposed) { st.configError = error.message; bump() } })
        requestJSON(API, '/session/planning-mode').then(data => { if (!disposed) { st.planningMode = data.planningMode === true; bump() } }).catch(() => {})
        const listener = (event) => { st.planningMode = Boolean(event && event.detail && event.detail.enabled); bump() }
        const canListen = typeof window.addEventListener === 'function'
        if (canListen) window.addEventListener('loom:planning-mode', listener)
        return () => { disposed = true; if (canListen) window.removeEventListener('loom:planning-mode', listener) }
      }, [st.boundSession])
      const toggleSession = enabled => run(async () => {
        const activation = await requestJSON(API, '/session/activation', { method: 'POST', body: { enabled } })
        st.sessionEnabled = activation.enabled; seat.activationVersion++; if (!activation.enabled) stopReplyWatch(); notifySeat()
      }, enabled ? '已在本会话启用 Loom' : '已关闭本会话的 Loom 自动注入与开工入口')
      // Only the native navigation's beforeOpen callback transfers a preparatory
      // draft. Ordinary session switches keep their existing isolation semantics.
      const enterPreparationWorkspace = async (pickDirectory = false) => {
        if (st.preparing) return
        const origin = currentSessionId(), generation = sessionGeneration
        const draft = { goal: st.goal, planningConstraints: st.planningConstraints, mode: st.mode, view: st.view }
        const ui = hostContext?.get?.('uiWorkspace') ?? hostContext?.uiWorkspace
        const workspaces = hostContext?.get?.('workspaces') ?? hostContext?.workspaces
        st.preparing = true; st.preparationError = ''; bump()
        try {
          if (!ui?.openWorkspace) throw new Error('当前宿主未提供项目导航，请返回新会话页选择项目；需求仍保留在这里')
          let workspaceId = st.preparationWorkspace
          if (pickDirectory) {
            if (!ui.pickDirectory || !workspaces?.create) throw new Error('当前宿主没有文件夹选择入口，请在新会话页选择项目')
            const path = await ui.pickDirectory()
            if (!path) return
            if (origin !== currentSessionId() || generation !== sessionGeneration) return
            workspaceId = (await workspaces.create({ path })).workspaceId
          }
          if (!workspaceId) throw new Error('请先选择一个项目，或选择项目文件夹')
          if (origin !== currentSessionId() || generation !== sessionGeneration) return
          await ui.openWorkspace(workspaceId, id => {
            if (origin !== currentSessionId() || generation !== sessionGeneration) throw new Error('会话已切换，需求保留在原工作台')
            viewCache.set(id, draft); preparationActivations.add(id)
          })
        } catch (error) { st.preparationError = error.message }
        finally { st.preparing = false; bump() }
      }
      const requireActive = () => {
        if (st.globalConfig?.enabled === false) throw new Error('请先打开 Loom 总开关')
        if (!st.sessionEnabled) throw new Error('请先在本会话启用 Loom')
      }
      const exportPlanning = () => run(async () => {
        requireActive()
        if (!st.goal.trim()) throw new Error('请填写项目目标')
        const exported = await requestJSON(API, '/planning/export', { method: 'POST', body: {
          goal: st.goal.trim(), constraints: st.planningConstraints.split('\n').map(line => line.trim()).filter(Boolean),
          architectureId: st.architecture?.architectureId || 'loom-architecture', workflowId: st.workflow?.workflowId || 'loom-default',
          expectedArchitectureRevision: st.architecture?.revision ?? null, expectedWorkflowRevision: st.snapshot?.revisions?.filter(r => r.workflowId === st.workflow?.workflowId).at(-1)?.revision ?? null } })
        stopReplyWatch(); st.promptText = { ...exported, kind: 'planning', text: exported.text || exported.prompt }
        st.replyPreview = null; st.replyText = ''; st.lastPreviewError = ''; st.invalidStreak = 0
      }, '规划提示词已生成，可以复制或发送到当前会话')
      const planAndSend = async () => {
        const before = st.promptText
        await exportPlanning()
        if (st.promptText !== before && st.promptText?.kind === 'planning') await sendPrompt()
      }
      const commandCarrierAvailable = () => Boolean((hostContext?.get?.('sessions') ?? hostContext?.sessions)?.using)
      const sessionCommand = async line => {
        const id = currentSessionId(), generation = sessionGeneration
        const sessions = hostContext?.get?.('sessions') ?? hostContext?.sessions
        if (!sessions?.using || !id || id !== resolvedSession) throw new Error('当前会话尚未绑定，无法执行命令')
        await sessions.using(id, { source: 'controllerOperation' }, async ref => {
          const binding = await ref.ready
          if (id !== currentSessionId() || generation !== sessionGeneration) throw new Error('会话已切换，未执行命令')
          const result = await binding.session.command(line)
          if (!result?.ok) throw new Error(result?.error?.message || '宿主拒绝了 Loom 命令')
          if (!result.value?.matched) throw new Error('宿主未注册 /loom 命令，请核对插件是否加载')
        })
      }
      const executionBlocks = () => {
        if (!st.workflow) return []
        const blocks = []
        if (!st.workflow.nodes.length) blocks.push('请先添加实现任务')
        if (!Array.isArray(st.workflow.executionProposal?.requiredCapabilities)) blocks.push('此任务图缺少执行提议，请补全或重新规划')
        else if (st.workflow.executionProposal.requiredCapabilities.includes('integration')) blocks.push('此计划要求自动集成；请重新生成模块计划或调整执行要求')
        for (const node of st.workflow.nodes) {
          if (node.execution.backend !== 'configured-agent' || node.execution.isolation !== 'worktree') blocks.push(`${node.id} 是规划阶段节点；当前开工支持独立工作树中的实现任务`)
          else {
            if (!node.ownership.writes.length) blocks.push(`${node.id} 需要明确可写文件范围`)
            if (!node.goal.trim() || /待填写/.test(node.goal)) blocks.push(`${node.id} 需要具体目标`)
            if (!node.acceptance.doneWhen.length || node.acceptance.doneWhen.some(line => /待填写/.test(line))) blocks.push(`${node.id} 需要具体完成条件`)
          }
        }
        return blocks
      }
      const activeRun = () => st.snapshot?.runs?.find(r=>r.sessionId===currentSessionId() && ['queued','running','produced','validating'].includes(r.state))
      const runStateText = state => ({queued:'正在准备开工',running:'正在执行',produced:'正在验证产物',validating:'正在验收',validated:'验收通过，等待人工集成',failed:'执行失败',cancelled:'已取消',interrupted:'已中断',refused:'未获准执行'})[state] || state
      const runReasonText = reason => reason==='USER_CANCELLED'?'已由用户取消，已有文件和工作树保留':reason
      const approvalBlocks = () => {
        const blocks=[]
        if(activeRun())blocks.push('本会话正在执行，请查看运行进度，无需重复批准')
        if(st.busy||!st.ready)blocks.push('正在读取或保存计划，请稍候')
        if(!st.workflow)blocks.push('请先采纳一份任务计划')
        if(st.directCandidate||st.replyPreview)blocks.push('请先查看并采纳正在预览的候选方案')
        if(!st.sessionEnabled)blocks.push('请先在本会话启用 Loom')
        if(st.globalConfig?.enabled===false)blocks.push('请先打开 Loom 总开关')
        if(draftDirty())blocks.push('任务修改尚未保存，请点「采纳为新 revision」')
        if(archDirty())blocks.push('架构修改尚未保存，请点「保存架构新 revision」')
        if(st.flowDirty)blocks.push('步骤或编组修改尚未保存，请点「保存编排」或「保存流程」')
        blocks.push(...(st.workflow?.openQuestions||[]),...(st.architecture?.openQuestions||[]))
        if(st.snapshot?.stale?.stale?.length)blocks.push('架构已更新，'+st.snapshot.stale.stale.length+' 个任务需要重新规划或确认映射')
        blocks.push(...executionBlocks())
        return [...new Set(blocks)]
      }
      const renderApprovalBar = () => {
        if(!st.workflow||st.directCandidate||st.replyPreview)return null
        const active=activeRun()
        if(active) {
          const record=st.snapshot?.execution?.records?.find(r=>r.runId===active.runId)
          const names=new Map((st.workflow.nodes||[]).map(n=>[n.id,n.title||n.id]))
          const phases={implementation:'实现中',verification:'验证中',review:'审查中'}
          const tasks=(record?.tasks||[]).filter(t=>t.active && phases[t.phase])
          return h('section',{className:'loom-approvalbar','data-loom-approval':'','data-loom-active-run':active.runId,'aria-label':'运行进度'},
            h('div',{className:'loom-bar'},h('strong',null,runStateText(active.state)),h('span',{className:'grow'}),h('button',{className:'loom-btn',type:'button',onClick:()=>{st.view='run';bump()}},'查看运行进度'),h('button',{className:'loom-btn loom-primary',type:'button',disabled:true},'正在执行')),
            h('p',{role:'status'},tasks.length?tasks.map(t=>(names.get(t.nodeId)||t.nodeId)+' · '+phases[t.phase]).join('；'):'开工已受理，正在准备任务或检查结果。'),
            h('p',{className:'loom-note'},'无需再次批准。已验任务 '+(record?.tasks?.filter(t=>t.phase==='validated').length||0)+' / '+(record?.approvedPlan?.flow?.steps?.flatMap(s=>s.taskIds||[]).length||st.workflow.nodes.length)+'；如需停止，可在运行页取消。'))
        }
        const blocks=approvalBlocks()
        return h('section',{className:'loom-approvalbar','data-loom-approval':'','aria-label':'批准计划'},
          h('div',{className:'loom-bar'},h('strong',null,blocks.length?'开工前还有待处理事项':'计划已采纳，可以批准'),h('span',{className:'grow'}),
            (st.workflow.openQuestions?.length||st.architecture?.openQuestions?.length)?h('button',{className:'loom-btn',type:'button','data-loom-resolve':'',disabled:st.busy||!st.ready||!st.sessionEnabled||st.globalConfig?.enabled===false||draftDirty()||archDirty()||st.flowDirty,onClick:resolveQuestions},'让 AI 处理这些问题'):null,
            h('button',{className:'loom-btn loom-primary',type:'button',disabled:blocks.length>0,'aria-describedby':'loom-approval-help',onClick:startRun},'批准当前版本并开工')),
          h('p',{id:'loom-approval-help',role:'status'},blocks.length?'完成下面的事项后才能批准；采纳不会自动开工。':'点击后将按当前计划派发子代理并开始执行。'),
          st.snapshot?.executionTarget?h('p',{'data-loom-execution-target':'',className:'loom-note'},'开发目录：'+st.snapshot.executionTarget):null,
          blocks.length?h('details',{'data-loom-approval-blocks':''},h('summary',null,'查看 '+blocks.length+' 项阻塞原因'),h('ul',null,...blocks.map((message,i)=>h('li',{key:i},message)))):null)
      }
      const editTaskText = (node, field, text, kind) => {
        try {
          const value = kind === 'number' ? Number(text) : kind === 'json' ? JSON.parse(text || '[]') : text.split('\n').map(line => line.trim()).filter(Boolean)
          if (kind === 'number' && (!Number.isInteger(value) || value < 1 || value > 86400)) throw new Error('超时需要 1..86400 的整数秒数')
          if (kind === 'json' && (!Array.isArray(value) || value.some(command => !Array.isArray(command.argv) || !command.argv.length || command.argv.some(arg => typeof arg !== 'string') || command.cwdRef !== 'node-worktree' || command.expectedExitCode !== 0))) throw new Error('验收命令需要 argv 字符串数组、cwdRef:"node-worktree" 与 expectedExitCode:0')
          editNodeField(node.id, field, value)
        } catch (error) { st.problem = error.message; bump() }
      }
      const startRun = () => run(async () => {
        requireActive()
        if(activeRun()){st.view='run';bump();return}
        if (!st.workflow || draftDirty() || archDirty() || st.flowDirty) throw new Error('请先保存并采纳画布上的架构与任务版本')
        const blocked = executionBlocks()
        if (blocked.length) throw new Error(blocked.join('；'))
        const scm = await requestJSON(API, '/scm')
        if (scm.dirty) throw new Error('请先提交或保存当前 Git 基线；工作树从已提交版本开工，不会带入未提交修改')
        if (!/^[a-f0-9]{40,64}$/.test(scm.head || '')) throw new Error('宿主未提供有效 Git HEAD，不能冻结执行基线')
        const plan=await requestJSON(API,'/plan/snapshot?workflowId='+encodeURIComponent(st.workflow.workflowId)+'&baseSha='+encodeURIComponent(scm.head))
        if(plan.revision!==st.workflow.revision || (st.flowServerDigest && plan.flowHash!==st.flowServerDigest))throw new Error('计划已被另一窗口修改，请刷新并重新审核后批准')
        if(!st.flowServerDigest && (plan.flow.organization || plan.flow.groups?.length))throw new Error('请先打开流程视图，审核保存的编组后批准')
        await sessionCommand(`/loom approve-run ${st.workflow.workflowId} ${st.workflow.revision} ${scm.head} ${plan.hash}`)
        const mode=await requestJSON(API,'/session/planning-mode');st.planningMode=mode.planningMode===true;setPlanningMode({enabled:st.planningMode})
        st.view = 'run'; await load()
      }, '开工命令已送达当前会话，请查看运行记录；若没有新记录，返回会话查看命令反馈')
      const resumeRun = runId => run(async () => {
        const record=st.snapshot.runs.find(r=>r.runId===runId)
        if(!record)throw new Error('运行记录已变化，请刷新')
        if(activeRun()||!['failed','cancelled','interrupted'].includes(record.state))throw new Error('运行尚未结束，请先查看进度')
        if(st.flowDirty||draftDirty()||archDirty())throw new Error('请先保存并审核修改后的计划')
        const scm=await requestJSON(API,'/scm')
        const plan=await requestJSON(API,'/plan/snapshot?workflowId='+encodeURIComponent(record.workflowId)+'&baseSha='+encodeURIComponent(scm.head))
        if(plan.workflowId!==st.workflow?.workflowId||plan.revision!==st.workflow?.revision||(st.flowServerDigest&&plan.flowHash!==st.flowServerDigest))throw new Error('当前计划或编组已变化，请刷新后审核再恢复')
        await sessionCommand(`/loom approve-resume ${runId} ${plan.hash}`)
        st.view='run';await load()
      },'已按当前计划批准恢复：保留旧工作树，旧草稿重新验收')
      const cancelRun = runId => run(async () => { await sessionCommand(`/loom cancel ${runId}`); await load() }, '已提交取消请求，工作树和已有产物保留')
      React.useEffect(() => {
        let disposed=false,polling=false
        const timer = setInterval(async () => {
          if(disposed||polling||st.busy||!st.ready||!workspaceKnown())return
          polling=true
          try {
            const snapshot=await requestJSON(API,'/state')
            if(disposed)return
            // Progress refresh never replaces locally edited plans or layouts.
            st.snapshot.runs=snapshot.runs;st.snapshot.execution=snapshot.execution
            bump()
          }catch(error){if(!disposed&&error.code!=='STALE_SESSION_RESPONSE'){st.problem='运行进度刷新失败：'+error.message;bump()}}
          finally{polling=false}
        }, 3000)
        return () => {disposed=true;clearInterval(timer)}
      }, [])

      /* ---------- 渲染 ---------- */
      const seg = (current, value, label, onClick, disabled) =>
        h(
          'button',
          {
            type: 'button',
            'aria-pressed': current === value,
            disabled: disabled || st.busy || !st.ready,
            onClick,
          },
          label,
        )

      const selected = st.workflow && st.workflow.nodes.find((n) => n.id === st.selectedNodeId)
      /**
       * 能力面板按**四档**呈现（评审 09 E）。
       *
       * 旧代码读 `caps[key].available` —— 那个字段在评审 E 之后就不存在了，
       * 面板会一直显示「未验证」，把「已声明但没接线」和「探测过但不可用」
       * 混成一句话。现在逐档展示，并明确标出 `usable` 与缺口。
       */
      const capRows = (st.snapshot && st.snapshot.capabilityStages) || []
      const degradations = (st.snapshot && st.snapshot.degradations) || []
      const STAGE_TEXT = {
        'not-implemented': '未实现',
        'implemented-unverified': '已实现，环境未验证',
        'implemented-unavailable': '已实现，环境不可用',
        'usable-unverified': '可用（本次运行未验）',
        'verified': '本次运行已验',
      }

      /**
       * 测试钩子：**只在显式开启时挂**，默认不存在。
       *
       * 为什么需要：锁定是**闸门**，闸门必须在「绕过 UI」时也拦得住
       * （快捷键、批量调用、将来模型自动改图都会绕过按钮）。要证明这一点，
       * 测试必须能直接调编辑函数 —— 而真实浏览器里没有别的入口。
       *
       * 为什么默认不挂：这是生产 bundle，不该给页面留一个「随便改图」的后门。
       * 宿主只要显式设 `window.__loomExposeEdit = true`（测试壳里设）才生效，
       * 仅在测试壳中暴露编辑动作，生产环境默认关闭。
       */
      if (typeof window !== 'undefined' && window.__loomExposeEdit === true) {
        window.__loomEdit = {
          editRemoveArchNode,
          editArchNodeField,
          editToggleArchLock,
          editArchNodeKind,
          editAddArchNode,
          editAddArchEdge,
          getState: () => st,
        }
      }

      /** 步骤栏几何：竖排＝每条步骤自上而下排（栏内自左而右＝顺序）；横排＝自左而右排（栏内自上而下＝顺序）。 */
      const flowLaneRects = (steps) => {
        const horizontal = st.flowOrientation === 'horizontal'
        if (horizontal) {
          const heights = steps.map((step) => 60 + step.taskIds.length * 240 + 180)
          const height = Math.max(620, ...heights)
          return steps.map((step, i) => ({ id: step.id, label: `${i + 1} · ${step.id}`, x: 40 + i * 340, y: -40, width: 300, height }))
        }
        const width=Math.max(780,...steps.map(step=>60+Math.min(3,step.taskIds.length)*300+220))
        let y=40
        return steps.map((step,i)=>{const height=Math.max(230,Math.ceil(step.taskIds.length/3)*240);const lane={id:step.id,label:`${i+1} · ${step.id}`,x:-160,y,width,height};y+=height+20;return lane})
      }

      /** 把坐标吸附回步骤栏：竖排固定行高、横排固定列宽，栏内另一个方向保留（＝用户的顺序）。 */
      const snapFlowPositions = (layout) => {
        if (!st.flow) return layout
        const steps = st.flow.order.map((id) => st.flow.steps.find((s) => s.id === id)).filter(Boolean)
        const lanes = flowLaneRects(steps)
        if (!lanes.length) return layout
        const horizontal = st.flowOrientation === 'horizontal'
        const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
        return layout.map((item) => {
          let best = lanes[0]
          let bestDist = Infinity
          for (const lane of lanes) {
            const d = horizontal ? Math.abs(item.x - lane.x) : (item.y>=lane.y&&item.y<lane.y+lane.height?0:Math.abs(item.y-(lane.y+lane.height/2)))
            if (d < bestDist) { bestDist = d; best = lane }
          }
          return horizontal
            ? { nodeId: item.nodeId, x: best.x + 50, y: clamp(item.y, best.y + 40, best.y + best.height - 200) }
            : { nodeId: item.nodeId, x: clamp(item.x, best.x + 50, best.x + best.width - 280), y: clamp(item.y,best.y+50,best.y+best.height-180) }
        })
      }

      /** 流程工具条压在画布上，实测它的高度：取景时留出来，别压住第一条泳道的标签。 */
      const flowStripHeight = () => {
        try {
          const stage = stageRef.current && stageRef.current.parentElement
          const strip = stage && stage.querySelector ? stage.querySelector('.loom-flowstrip') : null
          const height = strip && strip.getBoundingClientRect ? strip.getBoundingClientRect().height : 0
          return Number.isFinite(height) ? Math.round(height) : 0
        } catch { return 0 }
      }

      /**
       * 复制到剪贴板：先试异步 clipboard API，不可用（无权限/非安全上下文）再退回
       * 隐藏 textarea + execCommand。两条都失败返回 false，由调用方给出提示。
       */
      const copyToClipboard = async (text) => {
        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(text)
            return true
          }
        } catch { /* 落到降级路径 */ }
        try {
          const area = document.createElement('textarea')
          area.value = text
          area.setAttribute('readonly', '')
          area.style.position = 'fixed'
          area.style.top = '-1000px'
          document.body.appendChild(area)
          area.select()
          const ok = document.execCommand('copy')
          document.body.removeChild(area)
          return ok === true
        } catch { return false }
      }
      /** 低配模型护栏的「复制修复指令」：复制后把它发给当前模型即可原样重试。 */
      const copyLowModelGuardCommand = () => {
        const text = lowModelGuardCommand(st.promptText?.payloadHash || '', st.lastPreviewError)
        void copyToClipboard(text).then((ok) => {
          st.notice = ok ? '已复制修复指令：可以切到更强模型后连同这段一起发出去' : '复制失败：请手动选中「完整校验错误」手动复制'
          bump()
        })
      }
      const copyAuditReport = (audit) => {
        void copyToClipboard(auditReportText(audit)).then((ok) => {
          st.notice = ok ? `已复制审计报告（${audit && audit.groupId ? audit.groupId : '审计组'}）` : '复制失败：请手动选中下面的报告文本复制'
          bump()
        })
      }

      /** 把流程计划铺进画布：每条步骤一条栏，栏内按计划顺序摆。 */
      const flowLayout = () => {
        const api = canvasRef.current
        if (!api || !st.flow || !st.workflow) return
        const steps = st.flow.order.map((id) => st.flow.steps.find((s) => s.id === id)).filter(Boolean)
        const lanes = flowLaneRects(steps).map((lane, index) => ({
          ...lane,
          moves: flowLaneMoves(st.flowOrientation, index, steps.length),
          onMove: (delta) => flowMoveStep(lane.id, delta),
        }))
        const horizontal = st.flowOrientation === 'horizontal'
        const positions = []
        steps.forEach((step, i) => {
          const lane = lanes[i]
          step.taskIds.forEach((taskId, j) => {
            positions.push(horizontal
              ? { nodeId: taskId, x: lane.x + 50, y: lane.y + 60 + j * 240 }
              : { nodeId: taskId, x: lane.x + 220 + (j%3) * 300, y: lane.y + 50 + Math.floor(j/3)*240 })
          })
        })
        api.setFlowLanes(lanes, { topInset: flowStripHeight() })
        api.setPositions(positions)
        api.fit()
        bump()
      }

      /** 从画布摆位反推流程计划：哪条步骤栏 + 栏内谁在前。 */
      const deriveFlow = () => {
        const api = canvasRef.current
        if (!api || !st.flow || !st.workflow) return st.flow
        const positions = api.nodePositions()
        const steps = st.flow.order.map((id) => st.flow.steps.find((s) => s.id === id)).filter(Boolean)
        const lanes = flowLaneRects(steps)
        const horizontal = st.flowOrientation === 'horizontal'
        const laneOf = (p) => {
          let best = 0
          let bestDist = Infinity
          lanes.forEach((lane, i) => {
            const d = horizontal ? Math.abs(p.x - lane.x) : (p.y>=lane.y&&p.y<lane.y+lane.height?0:Math.abs(p.y-(lane.y+lane.height/2)))
            if (d < bestDist) { bestDist = d; best = i }
          })
          return best
        }
        const buckets = steps.map(() => [])
        for (const p of positions) buckets[laneOf(p)].push(p)
        const nextSteps = steps.map((step, i) => ({
          ...step,
          taskIds: buckets[i].sort(horizontal ? (a, b) => a.y - b.y : (a, b) => a.y-b.y||a.x-b.x).map((p) => p.nodeId),
        }))
        st.flow = { ...st.flow, steps: nextSteps, order: steps.map((s) => s.id) }
        return st.flow
      }

      const adoptDirectCandidate=()=>run(async()=>{
        if(!st.directCandidate)return
        await requestJSON(API,'/plan/adopt',{method:'POST',body:{candidateId:st.directCandidate.id}})
        st.directCandidate=null;st.view='flow';await load()
        const data=await requestJSON(API,'/flow?workflowId='+encodeURIComponent(st.workflow.workflowId));st.flow=data.plan;st.flowServerDigest=data.digest;st.flowDirty=false;syncGraph();flowLayout()
      },'计划已采纳，可在文字或图中编辑；尚未开工')
      React.useEffect(()=>{
        let seen=st.directCandidate?.id||null
        const listener=event=>{const data=event.detail;if(data?.sessionId!==currentSessionId()||data.candidateId===seen)return;if(!st.busy&&!draftDirty()&&!archDirty()&&!st.flowDirty)load().then(()=>{seen=data.candidateId;bump()}).catch(error=>{st.problem=error.message;bump()})}
        window.addEventListener?.('loom:plan-updated',listener)
        return()=>window.removeEventListener?.('loom:plan-updated',listener)
      },[])
      const renderReadablePlan=()=>{
        const wf=st.directCandidate?.preview?.workflow||st.workflow
        if(!wf)return null
        const candidate=!!st.directCandidate, steps=!candidate&&st.flow?st.flow.order.map(id=>st.flow.steps.find(s=>s.id===id)).filter(Boolean):[{id:'候选任务',agents:wf.executionProposal?.maxConcurrency||1,taskIds:wf.nodes.map(n=>n.id)}]
        return h('section',{className:'loom-readable-plan','aria-label':'文字计划','data-loom-readable-plan':''},
          h('h3',null,wf.title),h('p',{role:'status'},candidate?'候选待审，尚未采纳或执行':wf.workflowId+'@'+wf.revision+(st.flowDirty?' · 流程未保存':' · 待批准')),
          candidate?h('button',{className:'loom-btn loom-primary',disabled:st.busy,onClick:adoptDirectCandidate},'采纳候选并编辑'):null,
          wf.evidence?.some(e=>e.inputId==='preflight')?h('details',{'data-loom-resolution-report':'',open:candidate},h('summary',null,'AI 对开工前问题的处理建议'),h('p',null,'以下是 AI 提出的方案和依据；采纳后才生效，尚未批准开工。'),...wf.evidence.filter(e=>e.inputId==='preflight'||e.inputId==='preflight-source').map((e,i)=>h('p',{key:i},e.locator+'：'+e.observation))):null,
          ...steps.map((step,i)=>h('section',{key:step.id},h('h4',null,(i+1)+'. '+step.id+' · 最多 '+step.agents+' 并发'),
            ...step.taskIds.map(id=>{const task=wf.nodes.find(n=>n.id===id);if(!task)return null;const picked=st.selectedNodeId===id;return h('div',{key:id,'data-loom-plan-task':id,'data-selected':String(picked)},
              h('button',{className:'loom-btn',disabled:st.busy||candidate,onClick:()=>{st.selectedNodeId=id;if(st.view==='architecture')st.view='workflow';syncGraph();canvasRef.current?.select(id);bump()}},task.title),
              h('label',null,'任务目标',h('textarea',{'aria-label':task.title+' 任务目标',defaultValue:task.goal,key:task.goal,disabled:st.busy||candidate,onBlur:e=>{if(e.target.value!==task.goal)editNodeField(id,'goal',e.target.value)}})),
              h('p',null,'职责：'+task.role),h('p',null,'修改：'+task.ownership.writes.join('、')),
              h('p',null,'依赖：'+(wf.edges.filter(e=>e.target===id).map(e=>e.source).join('、')||'无')),
              h('label',null,'完成条件',h('textarea',{'aria-label':task.title+' 完成条件',defaultValue:task.acceptance.doneWhen.join('\n'),key:task.acceptance.doneWhen.join('\n'),disabled:st.busy||candidate,onBlur:e=>{if(e.target.value!==task.acceptance.doneWhen.join('\n'))editTaskText(task,'acceptance.doneWhen',e.target.value,'lines')}})))}))),
          ...(wf.openQuestions||[]).map((q,i)=>h('p',{key:i,className:'loom-warning'},q)))
      }

      /** 画布上的流程工具条（不遮画布，只压一条窄带）。 */
      const renderFlowStrip = () => {
        if (!st.workflow) return h('div', { className: 'loom-flowstrip', 'data-loom-flow': '' }, h('span', { className: 'loom-note' }, '先在规划里采纳一份任务图，流程泳道才有东西可排'))
        if (!st.flow) return h('div', { className: 'loom-flowstrip', 'data-loom-flow': '' }, h('span', { className: 'loom-note' }, '正在读取流程计划…（可点「重载」）'))
        const steps = st.flow.order.map((id) => st.flow.steps.find((s) => s.id === id)).filter(Boolean)
        const assigned = st.flow.steps.reduce((all, step) => all.concat(step.taskIds), []).length
        return h('div', { className: 'loom-flowstrip', 'data-loom-flow': '' },
          h('strong', null, '流程泳道'),
          h('span', { className: 'loom-note' }, `${steps.length} 条步骤栏 · 已纳入 ${assigned}/${st.workflow.nodes.length} · ` + (st.flowOrientation === 'horizontal' ? '步骤自左而右、栏内自上而下＝顺序' : '步骤自上而下、栏内自左而右＝顺序') + '；卡片会吸附在步骤栏里，需要硬依赖就切「连线模式」手动连'),
          h('span', { className: 'loom-note', style: { marginLeft: 8 } }, '步骤方向'),
          h('span', { className: 'loom-seg' },
            seg(st.flowOrientation === 'horizontal' ? 'horizontal' : 'vertical', 'vertical', '竖排', () => { st.flowOrientation = 'vertical'; st.flowDirty = true; flowLayout() }),
            seg(st.flowOrientation === 'horizontal' ? 'horizontal' : 'vertical', 'horizontal', '横排', () => { st.flowOrientation = 'horizontal'; st.flowDirty = true; flowLayout() }),
          ),
          h('span', { className: 'grow' }),
          h('button', { className: 'loom-btn', type: 'button', disabled: st.busy, onClick: () => loadFlow().then(() => flowLayout()) }, '重载'),
          h('button', { className: 'loom-btn', type: 'button', disabled: st.busy, onClick: flowLayout }, '重新分层'),
          h('button', { className: 'loom-btn', type: 'button', disabled: st.busy || !st.flowDirty, onClick: flowSave }, '保存流程'),
          h('button', { className: 'loom-btn loom-primary', type: 'button', disabled: st.busy || !st.flowDirty, onClick: flowApply }, '应用为新依赖'),
        )
      }

      /** 右侧：每泳道子代理数量 + 审计分组（分组在同一条泳道里的相邻两步之间结）。 */
      const renderCanvasTools = () => {
        const ids=st.canvasPicked.filter(id=>st.workflow?.nodes.some(n=>n.id===id)),org=st.flow&&st.workflow?organization():null
        const disabled=st.busy||!st.ready||Boolean(st.directCandidate)
        return h('div',{className:'loom-canvas-tools','data-loom-canvas-tools':'','aria-label':'画布操作'},
          h('span',{className:'loom-note'},ids.length?'已选 '+ids.length+' 个模块':'拖动空白处框选 · 空格拖动平移'),
          h('button',{className:'loom-btn',type:'button','aria-pressed':st.textPlanOpen,onClick:()=>{st.textPlanOpen=!st.textPlanOpen;bump()}},st.textPlanOpen?'收起文字计划':'文字计划'),
          h('button',{className:'loom-btn',type:'button',disabled:st.busy||!st.ready,'aria-expanded':st.inspectorOpen,onClick:()=>{st.inspectorOpen=!st.inspectorOpen;bump()}},st.inspectorOpen?'收起详细设置':'详细设置'),
          org&&ids.length?h('button',{className:'loom-btn',type:'button',disabled,onClick:()=>{st.teamPicked=ids;newTeam()}},'编为一组'):null,
          org&&ids.length?h('select',{'aria-label':'移动所选模块到组',className:'loom-select',value:'',disabled,onChange:e=>{const teamId=e.target.value;if(!teamId)return;editOrganization(o=>{o.teams=o.teams.map(t=>({...t,taskIds:t.id===teamId?[...new Set([...t.taskIds,...ids])]:t.taskIds.filter(id=>!ids.includes(id))})).filter(t=>t.taskIds.length)})}},h('option',{value:''},'加入已有组'),...org.teams.map(t=>h('option',{key:t.id,value:t.id},t.label))):null,
          org&&ids.length?h('button',{className:'loom-btn',type:'button',disabled,onClick:()=>addMember('executor')},'增加子代理'):null,
          org&&st.flowPicked.length>1?h('button',{className:'loom-btn',disabled,onClick:mergePickedSteps},'合并所选步骤'):null,
          org&&st.flowPicked.length===1&&st.flow.steps.find(s=>s.id===st.flowPicked[0])?.taskIds.length>1?h('button',{className:'loom-btn',disabled,onClick:splitPickedStep},'拆分所选步骤'):null,
          org&&st.flowPicked.length===1?h('select',{'aria-label':'所选步骤并发代理数',value:st.flow.steps.find(s=>s.id===st.flowPicked[0])?.agents,disabled,onChange:e=>flowAgents(st.flowPicked[0],Number(e.target.value))},...Array.from({length:st.flowMaxAgents},(_,i)=>h('option',{key:i,value:i+1},'同时 '+(i+1)+' 个代理'))):null,
          org&&ids.length?h('details',null,h('summary',null,'子代理与职责'),...org.members.filter(m=>m.taskIds.some(id=>ids.includes(id))||org.teams.some(t=>t.taskIds.some(id=>ids.includes(id))&&(t.supervisorId===m.id||t.reviewerId===m.id))).map(m=>h('div',{key:m.id,'data-loom-member':m.id},h('strong',null,m.label+' · '+({executor:'执行',supervisor:'分管',reviewer:'审查'}[m.role])),h('textarea',{'aria-label':m.label+' 负责什么',defaultValue:m.responsibility,disabled,onBlur:e=>{if(e.target.value!==m.responsibility)editOrganization(o=>{o.members.find(x=>x.id===m.id).responsibility=e.target.value})}}),m.role==='executor'?h('button',{className:'loom-btn',disabled,onClick:()=>removeMember(m.id)},'移除子代理'):null))):null,
          st.flowDirty?h('button',{className:'loom-btn loom-primary',disabled,onClick:flowSave},'保存编排'):null,
          st.flowPast.length?h('button',{className:'loom-btn',disabled,onClick:flowUndo},'撤销编排'):null)
      }
      const renderFlowPanel = () => {
        if (!st.flow || !st.workflow) return h('div', { className: 'loom-panel' }, h('h4', null, '流程设置'), h('p', { className: 'loom-note' }, '还没有可编排的流程。'))
        const steps = st.flow.order.map((id) => st.flow.steps.find((s) => s.id === id)).filter(Boolean)
        return h('div', { className: 'loom-panel' },
          h('h4', null, '流程设置'),
          h('p', { className: 'loom-note' }, `每步子代理数量（1..${st.flowMaxAgents}，与宿主调度上限同源；真实并发还会被宿主上限封顶）。步骤栏角上的 ` + (st.flowOrientation === 'horizontal' ? '◀▶' : '▲▼') + ' 调步骤先后；勾选任意两步（可跨栏）再点「结为审计组」，不必相邻。'),
          ...steps.map((step, index) => h('div', { key: step.id, className: 'loom-flow-row' },
            h('input', { type: 'checkbox', 'aria-label': '勾选步骤 ' + step.id, checked: st.flowPicked.includes(step.id), disabled: st.busy, onChange: (e) => flowPick(step.id, e.target.checked) }),
            h('span', { className: 'loom-note' }, `${index + 1} · ${step.id}（${step.taskIds.length}）`),
            h('select', { className: 'loom-select', value: step.agents, disabled: st.busy, onChange: (e) => flowAgents(step.id, Number(e.target.value)) },
              ...Array.from({ length: Math.max(1, st.flowMaxAgents) }, (_, i) => i + 1).map((n) => h('option', { key: n, value: n }, n + ' 代理'))))),
          h('div', { className: 'loom-bar' },
            h('button', {className:'loom-btn',type:'button',disabled:st.busy||st.flowPicked.length<2,onClick:mergePickedSteps},'合并为并行阶段'),
            h('button',{className:'loom-btn',type:'button',disabled:st.busy||st.flowPicked.length!==1,onClick:splitPickedStep},'拆分所选步骤'),
            h('button',{className:'loom-btn',type:'button',disabled:st.busy||!st.flowPast.length,onClick:flowUndo},'撤销流程编辑'),
            h('button',{className:'loom-btn',type:'button',disabled:st.busy||!st.flowFuture.length,onClick:flowRedo},'重做流程编辑'),
            h('button', { className: 'loom-btn', type: 'button', disabled: st.busy || st.flowPicked.length < 2, onClick: flowGroupPicked }, st.flowPicked.length ? `结为审计组（已勾 ${st.flowPicked.length}）` : '结为审计组'),
            h('button', { className: 'loom-btn', type: 'button', disabled: st.busy || !st.flowPicked.length, onClick: () => { st.flowPicked = []; bump() } }, '取消勾选'),
            h('button', { className: 'loom-btn', type: 'button', disabled: st.busy || steps.length < 2, onClick: flowAutoGroup }, '两两结组（相邻两步）')),
          ...st.flow.groups.map((group) => h('div', { key: group.id, className: 'loom-flow-groupbox' },
            h('span', null, group.id + '：' + group.stepIds.join(' + ')),
            h('select', { className: 'loom-select', value: group.auditAgentId || '', disabled: st.busy, onChange: (e) => flowAudit(group.id, e.target.value || null) },
              h('option', { value: '' }, '无主审'),
              ...st.flow.auditAgents.map((agent) => h('option', { key: agent.id, value: agent.id }, agent.label))),
            h('button', { className: 'loom-btn', type: 'button', disabled: st.busy, onClick: () => flowUngroup(group.id) }, '解散'))),
          ...st.flow.auditAgents.map((agent) => h('span', { key: agent.id, className: 'loom-flow-audit' + (agent.groupId ? ' is-bound' : '') }, '主审 ' + agent.label + '（' + (agent.groupId || '未绑定') + '）')),
          h('h4',null,'团队与模块分组'),
          h('p',{className:'loom-note'},'成员数量与并发额度分开。勾选任意任务建立责任组；分管只读汇总，独立审查通过后才解锁后续阶段。'),
          ...st.workflow.nodes.map(task=>h('div',{key:'assign-'+task.id,className:'loom-flow-row'},
            h('input',{type:'checkbox','aria-label':'分组任务 '+task.title,checked:st.teamPicked.includes(task.id),disabled:st.busy,onChange:e=>{st.teamPicked=e.target.checked?[...st.teamPicked,task.id]:st.teamPicked.filter(id=>id!==task.id);bump()}}),
            h('span',null,task.title),h('select',{'aria-label':task.title+' 负责人',className:'loom-select',disabled:st.busy,value:organization().members.find(m=>m.role==='executor'&&m.taskIds.includes(task.id))?.id||'',onChange:e=>assignMember(task.id,e.target.value)},h('option',{value:''},'待指定负责人'),...organization().members.filter(m=>m.role==='executor').map(m=>h('option',{key:m.id,value:m.id},m.label))))),
          h('button',{className:'loom-btn',disabled:st.busy||!st.teamPicked.length,onClick:newTeam},'所选模块建立责任组'),
          h('div',{className:'loom-bar'},h('button',{className:'loom-btn',disabled:st.busy,onClick:()=>addMember('executor')},'增加执行负责人'),h('button',{className:'loom-btn',disabled:st.busy,onClick:()=>addMember('supervisor')},'增加分管'),h('button',{className:'loom-btn',disabled:st.busy,onClick:()=>addMember('reviewer')},'增加独立审查')),
          ...organization().members.map(member=>h('details',{key:member.id},h('summary',null,member.label+' · '+({executor:'执行',supervisor:'分管',reviewer:'独立审查'}[member.role])),
            h('label',null,'名称',h('input',{'aria-label':member.id+' 名称',defaultValue:member.label,onBlur:e=>{if(e.target.value!==member.label)editOrganization(org=>{org.members.find(m=>m.id===member.id).label=e.target.value})}})),
            h('label',null,'职责',h('textarea',{'aria-label':member.id+' 职责',defaultValue:member.responsibility,onBlur:e=>{if(e.target.value!==member.responsibility)editOrganization(org=>{org.members.find(m=>m.id===member.id).responsibility=e.target.value})}})),
            h('p',null,'任务：'+(member.taskIds.join('、')||'按检查点唤醒')),
            h('button',{className:'loom-btn',disabled:st.busy,onClick:()=>removeMember(member.id)},'移除成员'))),
          ...organization().teams.map(team=>h('section',{key:team.id,className:'loom-team-settings'},h('h4',null,team.label),h('p',null,team.taskIds.join('、')),
            h('label',null,'分管',h('select',{'aria-label':team.id+' 分管',value:team.supervisorId,onChange:e=>editOrganization(org=>{org.teams.find(t=>t.id===team.id).supervisorId=e.target.value})},...organization().members.filter(m=>m.role==='supervisor').map(m=>h('option',{key:m.id,value:m.id},m.label)))),
            h('label',null,'独立审查',h('select',{'aria-label':team.id+' 独立审查',value:team.reviewerId,onChange:e=>editOrganization(org=>{org.teams.find(t=>t.id===team.id).reviewerId=e.target.value})},...organization().members.filter(m=>m.role==='reviewer').map(m=>h('option',{key:m.id,value:m.id},m.label)))),
            h('button',{className:'loom-btn',disabled:st.busy,onClick:()=>editOrganization(org=>{org.teams=org.teams.filter(t=>t.id!==team.id)})},'解散责任组'))),
          h('label',null,'跨组沟通轮数',h('select',{value:organization().communicationRounds,onChange:e=>editOrganization(org=>{org.communicationRounds=Number(e.target.value)})},...[0,1,2].map(n=>h('option',{key:n,value:n},n+' 轮')))),
          ...(st.flowWarnings || []).map((warning, i) => h('p', { key: 'fw' + i, className: 'loom-warning' }, typeof warning === 'string' ? warning : warning.message)),
        )
      }

      return h(
        'div',
        { 'data-loom-root': '', 'data-loom-surface': 'workbench', 'data-loom-focus': String(seat.canvasOnly), 'aria-busy': String(st.busy || !st.ready || st.preparing) },

        seat.canvasOnly && st.replyPreview ? h('div', { className: 'loom-bar loom-focus-banner' },
          h('span', { className: 'loom-note', role: 'status' }, st.promptText?.kind === 'planning' ? `候选方案已就绪：${(st.replyPreview.architecture?.nodes || []).length} 个模块 · ${(st.replyPreview.workflow?.nodes || []).length} 个任务` : '候选改动已就绪'),
          h('button', { className: 'loom-btn loom-primary', type: 'button', onClick: () => { seat.canvasOnly = false; if (st.promptText?.kind === 'planning') st.view = 'architecture'; notifySeat(); bump() } }, '查看并采纳')) : null,
        seat.canvasOnly && !st.replyPreview && st.replyWaiting ? h('div', { className: 'loom-bar loom-focus-banner' },
          h('span', { className: 'loom-note', role: 'status' }, 'AI 正在生成方案；完成后这里会出现「查看并采纳」。')) : null,
        seat.canvasOnly && !st.replyPreview && !st.replyWaiting && st.lastPreviewError ? h('div', { className: 'loom-bar loom-focus-banner' },
          h('span', { className: 'loom-note', role: 'status' }, '候选校验未通过；可让 AI 按校验错误修正。'),
          h('button', { className: 'loom-btn loom-primary', type: 'button', onClick: () => { seat.canvasOnly = false; notifySeat(); bump() } }, '查看错误并修正')) : null,

        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
          h('strong', null, isPreparationSession() ? '可视化规划模式 · 准备' : '可视化规划模式'),
          h('span', { className: 'loom-note' }, `v${CLIENT_VERSION}`),
        ),
        h('p', { className: 'loom-note' }, '写下需求，让 AI 生成项目方案图。你可以在图上调整，再决定是否让子代理开工。'),
        h('details', null,
          h('summary', null, '第一次使用？按这三个步骤来'),
          h('ol', { style: { margin: '10px 0 0', paddingLeft: 24, lineHeight: 1.8 } },
            h('li', null, '在聊天框开启「规划模式」，直接发送需求；也可在工作台填写项目目标。'),
            h('li', null, '等方案预览出现，先看文字与图，点「采纳候选并编辑」后修改任务、步骤和编组。'),
            h('li', null, '在「架构」看模块，在「开工任务」看分工。准备好后才点「批准当前版本并开工」。')),
          h('p', { className: 'loom-note' }, '第一次先做到出现方案图即可，设置保持默认。完成的模块会保留在各自工作目录，暂不自动合并。')),

        h('div', { className: 'loom-bar' },
          st.configError ? h('p', { className: 'loom-error', role: 'alert' }, st.configError) : null,
          st.globalConfig ? h(React.Fragment, null,
            currentSessionId() ? h('label', null, h('input', { type: 'checkbox', checked: st.sessionEnabled, disabled: st.busy || !workspaceKnown() || !st.globalConfig.enabled, onChange: e => toggleSession(e.target.checked) }), ' 在当前会话启用') : h('span', { className: 'loom-note' }, '先整理需求，选择项目后继续规划'),
            h('span', { className: 'loom-note' }, st.globalConfig.enabled ? '原生 Harness 会话 · 设置页仅管理选项' : '可视化规划模式已关闭，请到设置 → 可视化规划模式打开')) : h('p', null, '读取插件设置中…')),
        h('details', { className: 'loom-panel loom-planner', open: !st.promptText && (isPreparationSession() || (!st.workflow && !st.architecture)) },
          h('summary', null, '1. 写需求，让 AI 生成方案图'),
          h('p', { className: 'loom-note' }, '描述你想做的功能即可。第一次可以填入示例，再改成自己的需求。这里生成方案，开工是后面的单独操作。'),
          h('label', null, '项目目标', h('textarea', { className: 'loom-input', rows: 3, 'aria-label': '项目目标', value: st.goal, onChange: e => { st.goal = e.target.value; bump() } })),
          h('label', null, '要求（可选，每行一条）', h('textarea', { className: 'loom-input', rows: 2, 'aria-label': '规划约束', value: st.planningConstraints, onChange: e => { st.planningConstraints = e.target.value; bump() } })),
          !currentSessionId() ? h('div', { 'data-loom-preparation': '' },
            h('p', { className: 'loom-note' }, '可以先写需求。选择项目并进入会话后，再发送给 AI；这里不会提前调用模型。'),
            h('label', null, '规划所在项目', h('select', { className: 'loom-input', 'aria-label': '规划所在项目', value: st.preparationWorkspace, disabled: st.preparing, onChange: e => { st.preparationWorkspace = e.target.value; bump() } },
              h('option', { value: '' }, '选择项目'),
              ...((hostContext?.get?.('workspaces') ?? hostContext?.workspaces)?.list?.getSnapshot?.()?.items || []).map(w => h('option', { key: w.workspaceId, value: w.workspaceId }, w.title || w.path)))),
            h('div', { className: 'loom-bar' },
              h('button', { className: 'loom-btn loom-primary', type: 'button', disabled: st.preparing || !st.preparationWorkspace, onClick: () => enterPreparationWorkspace() }, st.preparing ? '正在进入项目…' : '进入项目会话'),
              h('button', { className: 'loom-btn', type: 'button', disabled: st.preparing, onClick: () => enterPreparationWorkspace(true) }, '选择项目文件夹')),
            st.preparationError ? h('p', { className: 'loom-error', role: 'alert' }, st.preparationError) : null)
            : !workspaceKnown() ? h('p', { className: 'loom-note' }, '当前会话的项目尚未读取成功，请刷新后再生成方案；已写需求会保留。') : null,
          h('div', { className: 'loom-bar' },
            h('button', { className: 'loom-btn loom-primary', type: 'button', disabled: st.busy || !workspaceKnown() || !st.goal.trim() || !st.sessionEnabled || st.globalConfig?.enabled === false, onClick: planAndSend }, '规划并发送给 AI'),
            h('button', { className: 'loom-btn', type: 'button', disabled: st.busy || Boolean(st.goal.trim()), title: st.goal.trim() ? '清空目标后可以填入示例，不会覆盖你的需求' : '填入可修改的示例，不会发送给 AI', onClick: () => {
              st.goal = '做一个个人待办网页，可以添加任务、勾选完成、删除任务，刷新后任务还在。使用 HTML、CSS 和 JavaScript，本地保存数据，不需要登录和后台服务器。划分为页面界面和数据保存两个模块，先给我方案和分工。';
              st.notice = '示例已填入。你可以修改，再点「规划并发送给 AI」。'; bump()
            } }, '填入示例需求'),
            h('button', { className: 'loom-btn', type: 'button', disabled: st.busy || !workspaceKnown() || !st.goal.trim() || !st.sessionEnabled || st.globalConfig?.enabled === false, onClick: exportPlanning }, '生成规划提示词')),
          h('p', { className: 'loom-note' }, '「规划并发送」会调用当前会话的 AI；「生成规划提示词」只准备文字，供你复制。')),

        st.promptText && !st.promptText.restored && !st.replyWaiting && !st.replyPreview ? h('div', { className: 'loom-panel' },
          h('button', { className: 'loom-btn', type: 'button', disabled: st.busy || !workspaceKnown(), onClick: sendPrompt }, '发送给当前 AI 会话'),
          h('p', { className: 'loom-note' }, '提示词已准备好。点击上面的按钮，交给当前会话的 AI；发送使用当前模型与额度。')
        ) : null,
        st.promptText && ['architecture', 'planning'].includes(st.promptText.kind) ? h('div', { className: 'loom-panel' },
          h('h4', null, st.promptText.kind === 'planning' ? '2. 查看方案图，满意后确认采用' : '查看这次架构调整'),
          st.replyWaiting ? h('div', null, h('p', { className: 'loom-note', role: 'status' }, 'AI 正在生成方案，回复完成后会显示在这里。你可以返回会话查看进度。'),
            h('button', { className: 'loom-btn', type: 'button', onClick: () => { stopReplyWatch(); st.notice = '已停止自动读取；AI 回合继续运行，可以粘贴回复'; bump() } }, '停止读取回复')) : null,
          h('p', { className: 'loom-note' }, '先看模块分工是否符合你的想法，再点「采纳 AI 候选方案」。这一步只保存方案，开工需要另外点击按钮。'),
          h('details', { open: st.mode === 'manual' || (!st.replyWaiting && !st.replyPreview) },
            h('summary', null, '没有自动出现图？粘贴本次 AI 回复'),
            h('p', { className: 'loom-note' }, '复制 AI 本次完整回复，粘贴后点「预览候选改动」。无需自己填写回复格式。'),
            h('textarea', { className: 'loom-input', rows: 8, 'aria-label': 'AI 架构 JSON 回复', value: st.replyText,
              onChange: (e) => { st.replyText = e.target.value; st.replyPreview = null; bump() } }),
            h('button', { className: 'loom-btn', type: 'button', disabled: st.busy || !st.replyText.trim(), onClick: previewReply }, '预览候选改动')),
          st.replyPreview ? h('div', null,
            h('p', null, st.promptText.kind === 'planning' ? `${st.replyPreview.architecture.nodes.length} 个架构模块 · ${st.replyPreview.workflow.nodes.length} 个任务 · ${st.replyPreview.sourceMap.entries.length} 个已校验来源映射` : `基于 revision ${st.replyPreview.expectedRevision}，共 ${st.replyPreview.changes.length} 处语义改动`),
            st.replyPreview.blocked ? h('p', { className: 'loom-warning' }, '方案仍有未决问题，可采纳并继续调整，解决后才能开工。') : null,
            st.replyPreview.explanation ? h('p', null, st.replyPreview.explanation) : null,
            st.promptText.kind === 'planning' ? h('div', null, h(PlanningCandidateDiagram, { architecture: st.replyPreview.architecture }), h('ul', null, ...st.replyPreview.workflow.nodes.map(node => h('li', { key: node.id }, `${node.id}：${node.goal} · ${node.ownership.writes.join('、')}`))), ...(st.replyPreview.warnings || []).map((warning, i) => h('p', { key: i, className: 'loom-warning' }, typeof warning === 'string' ? warning : warning.message))) : null,
            h('ul', null, (st.replyPreview.changes || []).map((c, i) => h('li', { key: i }, `${c.kind} ${c.objectKind}:${c.objectId}${c.field ? '.' + c.field : ''}：${JSON.stringify(c.oldValue)} → ${JSON.stringify(c.newValue)}`))),
            h('button', { className: 'loom-btn', type: 'button', disabled: st.busy, onClick: acceptReply }, '采纳 AI 候选方案')
          ) : null
        ) : null,
        st.lastPreviewError ? h('div', { className: 'loom-panel' },
          h('h4', null, '候选校验未通过'),
          // 低配模型护栏：连续多次不过时，与其让用户反复点「修正」空转，不如提示换更强模型。
          lowModelGuardText(st.invalidStreak) ? h('div', { className: 'loom-lownmodel-guard', 'data-loom-lownmodel-guard': String(st.invalidStreak) },
            h('p', { className: 'loom-warning' }, lowModelGuardText(st.invalidStreak)),
            h('button', { className: 'loom-btn', type: 'button', disabled: st.busy || st.replyWaiting, onClick: () => copyLowModelGuardCommand() }, '复制修复指令（发给当前模型再试）')) : null,
          h('p', { className: 'loom-error', role: 'alert' }, `共 ${String(st.lastPreviewError).split('; ').length} 项错误：` + String(st.lastPreviewError).slice(0, 400) + (String(st.lastPreviewError).length > 400 ? '…' : '')),
          h('details', null,
            h('summary', null, '完整校验错误'),
            h('pre', { style: { whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto' } }, st.lastPreviewError)),
          h('div', { className: 'loom-bar' },
            h('button', { className: 'loom-btn loom-primary', type: 'button', disabled: st.busy || st.replyWaiting, onClick: repairReply }, '让 AI 按校验错误修正'),
            h('button', { className: 'loom-btn', type: 'button', onClick: () => { st.lastPreviewError = ''; st.problem = ''; st.invalidStreak = 0; bump() } }, '忽略'))) : null,
        st.promptText && !st.promptText.restored
          ? h('details', null,
              h('summary', null, '导出的提示词（可复制）'),
              h('pre', null, st.promptText.text),
            )
          : null,

        (st.planningMode || st.snapshot?.planning?.waitingApproval) ? h('p', { className: 'loom-note', 'data-loom-planning-banner': '' }, '规划中：直接在聊天框发送需求，先看文字和图。采纳后可以继续编辑；批准当前版本并开工才会执行。',h('button',{className:'loom-btn',type:'button',disabled:st.busy,onClick:()=>run(async()=>{await sessionCommand('/loom cancel-plan');await load();const mode=await requestJSON(API,'/session/planning-mode');st.planningMode=mode.planningMode===true;setPlanningMode({enabled:st.planningMode})},'本次规划已放弃，历史保留，未开工')},'放弃本次规划')) : null,
        st.snapshot?.planning?.rejected ? h('div', {className:'loom-error',role:'alert','data-loom-rejected-plan':''},h('strong',null,'计划未通过校验，候选已保留'),h('p',null,'可以让 AI 按错误局部修正，无需重写整份计划。当前仍未批准、未执行。'),h('pre',{style:{whiteSpace:'pre-wrap'}},st.snapshot.planning.rejected.error)) : null,
        st.problem ? h('p', { className: 'loom-error', role: 'alert' }, String(st.problem).slice(0, 600) + (String(st.problem).length > 600 ? '…' : '')) : null,
        st.notice ? h('p', { className: 'loom-ok' }, st.notice) : null,

        h('div', { className: 'loom-bar loom-viewbar' },
          h('span', { className: 'loom-note' }, '工作模式'),
          h('span', { className: 'loom-seg' },
            seg(st.mode, 'auto', '自动', () => setMode('auto')),
            seg(st.mode, 'manual', '手动', () => setMode('manual')),
          ),
          h('span', { className: 'loom-note', style: { marginLeft: 8 } }, '视图'),
          h('span', { className: 'loom-seg' },
            seg(st.view, 'architecture', '架构', () => { st.view = 'architecture'; bump() }),
            seg(st.view, 'workflow', '开工任务', () => { st.view = 'workflow'; bump() }),
            seg(st.view, 'flow', '流程', () => { st.view = 'flow'; st.flow = null; bump(); loadFlow().then(() => flowLayout()) }),
            st.planningMode ? null : seg(st.view, 'run', '运行', () => { st.view = 'run'; bump() }),
          ),
          h('span', { className: 'loom-note', style: { marginLeft: 8 } }, '连线样式'),
          h('select', { className: 'loom-select', 'aria-label': '连线样式', value: st.edgeStyle || 'curve', disabled: st.busy || !st.ready,
            onChange: (e) => { st.edgeStyle = e.target.value; bump() } },
            EDGE_STYLES.map((style) => h('option', { key: style.value, value: style.value }, style.label)),
          ),
          h('span', { className: 'grow' }),
          !seat.inline.has(currentSessionId()) ? h('button', { className: 'loom-btn', type: 'button', disabled: st.busy || !st.ready || seat.entryBusy, onClick: () => { if (st.busy || !st.ready || seat.entryBusy) return; seat.open = true; seat.fullscreen = true; seat.canvasOnly = true; notifySeat() } }, '全屏画布') : null,
          h('button', { className: 'loom-btn', type: 'button', 'aria-pressed': seat.canvasOnly, onClick: () => { seat.canvasOnly = !seat.canvasOnly; notifySeat(); bump() } }, seat.canvasOnly ? '显示规划面板' : '专注画布'),
          h('button', { className: 'loom-btn', type: 'button', disabled: st.busy || !st.ready, onClick: () => run(() => load()) }, '刷新'),
          (st.workflow || st.architecture) ? h('span', { className: 'loom-bar' },
          h('div', { className: 'loom-more-slot' },
            h('button', { className: 'loom-btn', type: 'button', 'aria-expanded': seat.moreOpen ? 'true' : 'false', onClick: () => { seat.moreOpen = !seat.moreOpen; bump() } }, seat.moreOpen ? '收起 ▴' : '更多 ▾'),
            h('div', { className: 'loom-more-menu' + (seat.moreOpen ? ' is-open' : '') },
              h('button', {
                className: 'loom-btn', type: 'button',
                disabled: st.busy || (st.view === 'architecture' ? !st.architecture : !st.workflow),
                onClick: doValidate,
              }, '校验'),
              st.planningMode ? null : h('button', { className: 'loom-btn', type: 'button', disabled: st.busy || !st.workflow, onClick: doCompile }, '编译预览'),
              h('button', { className: 'loom-btn', type: 'button', disabled: st.busy || st.view === 'architecture' || !st.workflow, onClick: saveLayout }, '保存布局'),
              h('button', { className: 'loom-btn', type: 'button', disabled: !canvasRef.current, onClick: () => canvasRef.current && canvasRef.current.autoArrange() }, '自动排版'),
              h('button', { className: 'loom-btn', type: 'button', disabled: !canvasRef.current, onClick: () => canvasRef.current && canvasRef.current.fit() }, '适配视图'),
              st.planningMode ? null : h('button', { className: 'loom-btn', type: 'button', disabled: st.busy || !st.workflow, onClick: () => doPrompt('task') }, '导出任务包'),
              st.planningMode ? null : h('button', { className: 'loom-btn', type: 'button', disabled: st.busy || !st.workflow, onClick: () => doPrompt('coordinator') }, '导出协调提示词'),
              // 架构路线**不因为「当前在看任务图」而禁用**：三条路线是独立的。
              h('button', { className: 'loom-btn', type: 'button', disabled: st.busy, onClick: () => doPrompt('architecture') }, '导出架构提示词'),
            ),
          )
          ) : null,
        ),

        /* ---- 草案编辑工具条（评审 09 C）----
           按视图换**数据源与动作目标**：架构视图的撤销/采纳/导出都针对架构 revision，
           任务视图针对任务草案。共用一条工具条、但动作不混，用户不用去猜
           「撤销」这一步撤的是哪一份图。 */
        (st.workflow || st.architecture) ? h('div', { className: 'loom-bar loom-editbar' },
          h('span', { className: 'loom-note' }, st.view === 'architecture' ? '架构编辑' : '草案编辑'),
          st.view === 'architecture'
            ? h('button', {
                className: 'loom-btn', type: 'button',
                disabled: st.busy || !st.architecture || !canArchUndo() || !workspaceKnown(),
                onClick: editArchUndo,
              }, '撤销')
            : h('button', {
                className: 'loom-btn', type: 'button',
                disabled: st.busy || !st.workflow || !canUndo() || !workspaceKnown(),
                onClick: editUndo,
              }, '撤销'),
          st.view === 'architecture'
            ? h('button', {
                className: 'loom-btn', type: 'button',
                disabled: st.busy || !st.architecture || !canArchRedo() || !workspaceKnown(),
                onClick: editArchRedo,
              }, '重做')
            : h('button', {
                className: 'loom-btn', type: 'button',
                disabled: st.busy || !st.workflow || !canRedo() || !workspaceKnown(),
                onClick: editRedo,
              }, '重做'),
          st.view === 'architecture'
            ? h('span', { className: 'loom-note' }, ARCH_LINK_HINT(st))
            : h('span', { className: 'loom-seg' },
                seg(st.linkMode ? 'on' : 'off', 'on', '连线模式', () => {
                  st.linkMode = true
                  st.linkFrom = null
                  bump()
                }, !st.workflow),
                seg(st.linkMode ? 'on' : 'off', 'off', '选择模式', () => {
                  st.linkMode = false
                  st.linkFrom = null
                  bump()
                }, !st.workflow),
              ),
          st.view === 'architecture' ? null : h('span', { className: 'loom-note' }, LINK_MODE_HINT(st)),
          h('span', { className: 'grow' }),
          st.view === 'architecture'
            ? h('button', {
                className: 'loom-btn', type: 'button',
                disabled: st.busy || !st.architecture || !archDirty() || !workspaceKnown(),
                onClick: adoptArchitecture,
              }, '保存架构新 revision')
            : h('button', {
                className: 'loom-btn', type: 'button',
                disabled: st.busy || !st.workflow || !draftDirty() || !workspaceKnown(),
                onClick: adoptDraft,
              }, '采纳为新 revision'),
        ) : null,
        (st.workflow || st.architecture) ? h('p', { className: 'loom-note' }, '架构：项目由哪些模块组成。开工任务：每个子代理负责做什么。运行：查看进度和结果。') : null,

        /* ---- 新增模块（架构视图）---- */
        st.view === 'architecture' && st.architecture
          ? h('div', { className: 'loom-bar' },
              h('span', { className: 'loom-note' }, '新增模块'),
              h('select', {
                className: 'loom-select',
                value: st.newModule.kind,
                disabled: st.busy || !workspaceKnown(),
                onChange: (e) => { st.newModule.kind = e.target.value; bump() },
              }, ARCH_NODE_KINDS.map((k) => h('option', { key: k, value: k }, ARCH_KIND_LABELS[k] || k))),
              h('input', {
                className: 'loom-input',
                type: 'text',
                placeholder: 'id（可留空，自动生成稳定 id）',
                value: st.newModule.id,
                disabled: st.busy || !workspaceKnown(),
                onChange: (e) => { st.newModule.id = e.target.value; bump() },
              }),
              h('input', {
                className: 'loom-input',
                type: 'text',
                placeholder: '标题',
                value: st.newModule.title,
                disabled: st.busy || !workspaceKnown(),
                onChange: (e) => { st.newModule.title = e.target.value; bump() },
              }),
              h('input', {
                className: 'loom-input',
                type: 'text',
                placeholder: '责任（responsibility，架构必填）',
                style: { flex: '1 1 240px' },
                value: st.newModule.responsibility,
                disabled: st.busy || !workspaceKnown(),
                onChange: (e) => { st.newModule.responsibility = e.target.value; bump() },
              }),
              h('button', {
                className: 'loom-btn', type: 'button',
                disabled: st.busy || !st.architecture || !workspaceKnown(),
                onClick: editAddArchNode,
              }, '添加模块'),
              workspaceKnown() ? null : h('span', { className: 'loom-error' }, '宿主未提供工作区，编辑已停用'),
            )
          : null,

        st.inspectorOpen && st.view === 'workflow' && selected && st.architecture && st.snapshot
          ? h('div', { className: 'loom-bar' },
              h('span', { className: 'loom-note' }, `任务 ${selected.id} 的架构来源`),
              ...st.architecture.nodes.map((module) => {
                const entry = st.snapshot.sourceMap?.workflowId === st.workflow.workflowId
                  ? st.snapshot.sourceMap.entries.find((e) => e.workflowNodeId === selected.id) : null
                return h('label', { key: module.id }, h('input', { type: 'checkbox',
                  'aria-label': `关联模块 ${module.id}`, disabled: st.busy || draftDirty() || !workspaceKnown(),
                  checked: Boolean(entry?.architectureNodeIds.includes(module.id)),
                  onChange: () => run(async () => {
                    const existing = st.snapshot.sourceMap?.workflowId === st.workflow.workflowId ? st.snapshot.sourceMap.entries : []
                    const ids = new Set(entry?.architectureNodeIds || [])
                    if (ids.has(module.id)) ids.delete(module.id); else ids.add(module.id)
                    const entries = existing.filter((e) => e.workflowNodeId !== selected.id)
                    if (ids.size) entries.push({ workflowNodeId: selected.id, architectureNodeIds: [...ids], decisionIds: [...ids].filter((id) => st.architecture.nodes.some((m) => m.id === id && m.kind === 'decision')) })
                    const sourceMap = { schemaVersion: 1, architectureId: st.architecture.architectureId, workflowId: st.workflow.workflowId, entries }
                    await requestJSON(API, '/sourcemap', { method: 'POST', body: { sourceMap,
                      confirmedNodeIds: [selected.id], expectedWorkflowRevision: st.workflow.revision, expectedArchitectureRevision: st.architecture.revision } })
                    await load()
                  }, '已确认此任务的架构来源；其他任务需各自确认') }), module.title)
              }),
              h('button', { className: 'loom-btn', disabled: st.busy || draftDirty() || !workspaceKnown(),
                onClick: () => run(async () => {
                  const sourceMap = st.snapshot.sourceMap
                  if (!sourceMap?.entries.some((e) => e.workflowNodeId === selected.id)) throw new Error('请先选择此任务关联的架构模块')
                  await requestJSON(API, '/sourcemap', { method: 'POST', body: { sourceMap,
                    confirmedNodeIds: [selected.id], expectedWorkflowRevision: st.workflow.revision, expectedArchitectureRevision: st.architecture.revision } })
                  await load()
                }, '已确认此任务仍符合当前架构') }, '确认此任务映射'),
              draftDirty() ? h('span', { className: 'loom-note' }, '先采纳任务草案，再确认来源映射') : null)
          : null,
        !st.directCandidate&&!st.replyPreview&&(st.workflow?.openQuestions?.length || st.architecture?.openQuestions?.length) ? h('section', { className: 'loom-warning','data-loom-question-help':'' }, h('strong',null,'这些问题可以先交给 AI 处理'),h('p',null,'点击上方「让 AI 处理这些问题」。AI 会查证技术细节、建议稳妥方案，并安排后续验证；需要你决定的范围或授权，会改成易懂的选择。你的任务和编组会保留。'),h('details',null,h('summary',null,'查看原始待处理事项'), h('ul', null, ...[...new Set([...(st.architecture?.openQuestions || []), ...(st.workflow?.openQuestions || [])])].map((question, i) => h('li', { key: i }, question))))) : null,
        executionBlocks().length ? h('details', { className: 'loom-panel' }, h('summary', null, '开工前需要补齐的任务配置'), h('ul', null, ...executionBlocks().map((message, i) => h('li', { key: i }, message)))) : null,
        st.snapshot?.stale?.stale?.length ? h('div', { className: 'loom-warning' },
          `架构已更新，${st.snapshot.stale.stale.length} 个任务需要重新规划或确认映射`) : null,

        /* ---- 新增节点（任务视图）---- */
        !st.inspectorOpen || st.view === 'architecture' || !st.workflow
          ? null
          : h('div', { className: 'loom-bar' },
              h('span', { className: 'loom-note' }, '新增节点'),
              h('select', {
                className: 'loom-select',
                value: st.newNode.kind,
                disabled: st.busy || !workspaceKnown(),
                onChange: (e) => { st.newNode.kind = e.target.value; bump() },
              }, Object.keys(KIND_LABELS).map((k) => h('option', { key: k, value: k }, KIND_LABELS[k]))),
              h('input', {
                className: 'loom-input',
                type: 'text',
                placeholder: 'id（小写字母开头）',
                value: st.newNode.id,
                disabled: st.busy || !workspaceKnown(),
                onChange: (e) => { st.newNode.id = e.target.value; bump() },
              }),
              h('input', {
                className: 'loom-input',
                type: 'text',
                placeholder: '目标（goal，采纳前必须补全）',
                style: { flex: '1 1 240px' },
                value: st.newNode.goal,
                disabled: st.busy || !workspaceKnown(),
                onChange: (e) => { st.newNode.goal = e.target.value; bump() },
              }),
              h('button', {
                className: 'loom-btn', type: 'button',
                disabled: st.busy || !st.workflow || !workspaceKnown(),
                onClick: editAddNode,
              }, '添加节点'),
              workspaceKnown() ? null : h('span', { className: 'loom-error' }, '宿主未提供工作区，编辑已停用'),
            ),

        st.view === 'architecture'
          ? h('div', { className: 'loom-bar' },
              h('span', { className: 'loom-note' }, '新增关系'),
              h('select', {
                className: 'loom-select',
                value: st.archEdgeKind,
                disabled: st.busy || !workspaceKnown(),
                onChange: (e) => { st.archEdgeKind = e.target.value; bump() },
              }, ARCH_EDGE_KINDS.map((k) => h('option', { key: k, value: k }, ARCH_EDGE_LABELS[k] || k))),
              h('span', { className: 'loom-note' }, st.archLinkFrom ? `起点 ${st.archLinkFrom}` : '起点：在左侧「选中模块」面板点「设为关系起点」'),
              h('button', {
                className: 'loom-btn', type: 'button',
                disabled: st.busy || !st.archLinkFrom || !st.selectedNodeId || st.archLinkFrom === st.selectedNodeId,
                onClick: () => {
                  const from = st.archLinkFrom
                  st.archLinkFrom = null
                  bump()
                  void editAddArchEdge(from, st.selectedNodeId, st.archEdgeKind)
                },
              }, '连到当前选中模块'),
              h('button', {
                className: 'loom-btn', type: 'button',
                disabled: st.busy || !st.archLinkFrom,
                onClick: () => { st.archLinkFrom = null; bump() },
              }, '清除起点'),
              h('span', { className: 'loom-note' }, '架构允许双向关系与环；两点互相连会合并成一条双向关系'),
            )
          : null,

        st.workflow && st.view !== 'architecture' && draftDirty()
          ? h('p', { className: 'loom-note', style: { color: '#ffd43b' } },
              `草案与已采纳 revision ${st.workflow.revision} 有差异。草案改动不影响正在运行的旧版；` +
              '要让改动生效，点「采纳为新 revision」。')
          : null,

        st.architecture && st.view === 'architecture' && archDirty()
          ? h('p', { className: 'loom-note', style: { color: '#ffd43b' } },
              `架构有未提交的改动（当前 revision ${st.architecture.revision}）。` +
              '点「保存架构新 revision」才会落盘为新的不可变版本。')
          : null,

        st.view === 'architecture' && st.archLoadError
          ? h('p', { className: 'loom-error' }, `架构读取失败：${st.archLoadError}（这不等于「没有架构」，请刷新或检查端点）`)
          : null,

        st.view === 'architecture'
          ? h('p', { className: 'loom-note' },
              st.architecture
                ? `架构 ${st.architecture.architectureId} · revision ${st.architecture.revision} · ` +
                  `${st.architecture.nodes.length} 个模块 / ${st.architecture.edges.length} 条关系。` +
                  '架构是独立于开工任务的图：它允许双向关系与环，节点通过来源映射多对多关联到任务。'
                : '这个工作区还没有架构。先点「新建架构草案」，再添加模块或导出架构提示词。')
          : null,
        st.view === 'run'
          ? h('div', { className: 'loom-panel' },
              h('h4', null, '项目运行记录'),
              h('p', { className: 'loom-note' }, '运行记录每 3 秒刷新。开工使用当前会话的真实 Agent，并从同一 Git HEAD 创建各任务工作树；模块验收与集成状态以记录为准。'),
              st.snapshot?.execution?.error ? h('p',{role:'alert',className:'loom-error'},st.snapshot.execution.error) : null,
              ...(st.snapshot?.execution?.records || []).map(record=>h('details',{key:record.runId,'data-loom-execution':''},h('summary',null,`${record.runId} · ${record.state==='validated'?'验收通过，等待人工集成':record.state} · ${record.tasks.filter(t=>t.phase==='validated').length} 个已验任务`),h('p',null,'阶段：采纳需求 → 实现 → 命令和产物验证 → 独立审查 → 人工集成'),h('ul',null,...record.tasks.map(task=>h('li',{key:task.attemptId},`${task.nodeId} · 第 ${task.number} 次 · ${({implementation:'实现中',verification:'验证中',review:'审查中',validated:'验收通过',failed:'失败',cancelled:'已取消',interrupted:'已中断'})[task.phase]||task.phase}${task.error?' · '+task.error:''}`,task.snapshotHash?h('small',{style:{display:'block',overflowWrap:'anywhere'}},'审查快照 '+task.snapshotHash):null))))),
              st.snapshot?.runs?.length
                ? h('ul', null, ...st.snapshot.runs.map((r) => h('li', { key: r.runId },
                    `${r.runId} · ${r.workflowId}@${r.revision} · ${runStateText(r.state)} · ${r.startedAt}${r.endedAt ? ' → ' + r.endedAt : ''}${r.reason ? ' · ' + runReasonText(r.reason) : ''}`,
                    ['failed','cancelled','interrupted'].includes(r.state) && (!r.sessionId||r.sessionId===currentSessionId()) ? h('button',{className:'loom-btn',type:'button',disabled:st.busy||Boolean(activeRun()),onClick:()=>resumeRun(r.runId)},'批准恢复运行') : null,
                    ['running', 'queued'].includes(r.state) ? h('button', { className: 'loom-btn', type: 'button', disabled: st.busy, onClick: () => cancelRun(r.runId) }, '取消运行') : null,
                    r.receipt ? h('details', null, h('summary', null, '运行产物与工作树'),
                      h('p', null, `已验证任务：${(r.receipt.completed || []).join('、') || '无'}；${r.receipt.integrated ? '已集成' : '工作树保留，尚未集成到项目分支'}`),
                    r.receipt.audits && r.receipt.audits.length ? h('div', null,
                      h('p', null, '审计组（可展开看完整结论，或复制报告）'),
                      h('ul', null, ...r.receipt.audits.map((audit, i) => h('li', { key: i },
                        h('details', { 'data-loom-audit': audit.groupId || 'audit-' + (i + 1) },
                          h('summary', null, `${audit.groupId} · 主审 ${audit.label} · ${audit.verdict === 'pass' ? '通过' : '未通过'}（覆盖 ${(audit.taskIds || []).length} 个任务）`),
                          (audit.findings || []).length
                            ? h('ul', null, ...audit.findings.map((finding, j) => h('li', { key: j }, finding)))
                            : h('p', { className: 'loom-note' }, '无额外结论'),
                          h('pre', { 'data-loom-audit-text': '', style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', userSelect: 'text', margin: '6px 0 0' } }, auditReportText(audit)),
                          h('button', { className: 'loom-btn', type: 'button', disabled: st.busy, onClick: () => copyAuditReport(audit) }, '复制审计报告')))))) : null,
                      (r.receipt.execution?.supervisionReports||[]).length?h('details',null,h('summary',null,'分管回传'),...(r.receipt.execution.supervisionReports).map((report,i)=>h('p',{key:i},report.memberId+' · '+report.groupId+' · '+(report.findings.join('；')||'本组证据核对通过')))):null,
                      (r.receipt.execution?.communications||[]).length?h('details',null,h('summary',null,'跨组沟通'),...(r.receipt.execution.communications).map(message=>h('p',{key:message.id},message.from+' → '+message.to+'：'+message.body))):null,
                      r.receipt.execution?.approvedPlan?h('details',null,h('summary',null,'本次批准的计划版本'),h('p',null,r.receipt.execution.approvedPlan.hash),h('pre',null,r.receipt.execution.approvedPlan.markdown)):null,
                      r.receipt.error ? h('p', { className: 'loom-error' }, r.receipt.error) : null,
                      h('ul', null, ...(r.receipt.worktrees || []).map((tree, i) => h('li', { key: i }, `${tree.taskId} · ${tree.state} · ${tree.branch}`, h('div', { style: { overflowWrap: 'anywhere', userSelect: 'text' } }, tree.path), h('small', null, `冻结基线 ${tree.baseSha}`)))),
                      h('ul', null, ...(r.receipt.artifacts || []).map((artifact, i) => h('li', { key: i }, `${artifact.nodeId}.${artifact.port}`, h('div', { style: { overflowWrap: 'anywhere', userSelect: 'text' } }, artifact.ref), h('small', { style: { overflowWrap: 'anywhere', userSelect: 'text' } }, `SHA-256 ${artifact.contentHash}`)))),
                      h('ul', null, ...(r.receipt.checks || []).map((check, i) => h('li', { key: i }, `${(check.argv || []).join(' ')} · ${check.state} · exit ${check.exitCode ?? '—'}`, h('div', { style: { overflowWrap: 'anywhere' } }, `${check.cwd} · ${check.platform} · PID ${check.pid}`), h('small', { style: { overflowWrap: 'anywhere' } }, `stdout ${check.stdoutHash} · stderr ${check.stderrHash}`))))) : null)))
                : h('p', null, '本项目还没有运行记录'))
          : null,

        renderApprovalBar(),
        h('div', { className: 'loom-main', 'data-loom-plan-split':String(st.view!=='architecture'&&Boolean(st.directCandidate||st.textPlanOpen)), 'data-loom-empty': String(!st.workflow && !st.architecture && !st.directCandidate) },
          st.view!=='architecture'?renderReadablePlan():null,
          h('div', { className: 'loom-stage' }, h('div', { ref: stageRef, style: { position: 'absolute', inset: 0 } }), st.view === 'flow' ? renderFlowStrip() : null,renderCanvasTools()),
          h('aside', {className:'loom-inspector',hidden:!st.inspectorOpen, 'aria-label':'详细设置', style: { display: st.inspectorOpen&&(st.workflow || st.architecture) ? 'grid' : 'none', gap: 10 } },
            h('button',{className:'loom-btn',type:'button',onClick:()=>{st.inspectorOpen=false;bump()}},'收起详细设置'),
            st.view === 'flow' ? renderFlowPanel() : st.view === 'architecture'
              ? h('div', { className: 'loom-panel' },
                  h('h4', null, '选中模块'),
                  st.architecture && st.architecture.nodes.find((n) => n.id === st.selectedNodeId)
                    ? (() => {
                        const m = st.architecture.nodes.find((n) => n.id === st.selectedNodeId)
                        const editable = !st.busy && workspaceKnown()
                        // 锁定是闸门，不是装饰：锁定模块的字段与删除按钮一律禁用，
                        // 解除冻结只走人类会话命令并回读新版本，普通写入仍不能解锁。
                        const canEdit = editable && m.locked !== true
                        const relatedCount = st.architecture.edges.filter((e) => e.from === m.id || e.to === m.id).length
                        return h('div', null,
                          h('div', null, `${m.id} · ${ARCH_KIND_LABELS[m.kind] || m.kind}`),
                          m.locked
                            ? h('div', { className: 'loom-lock', style: { marginTop: 2 } }, '已锁定（设计冻结）—— 字段与删除已禁用；解除冻结会保留历史并使旧任务映射过期')
                            : null,
                          // 标题与责任用受控输入：onChange 只改本地副本，
                          // onBlur 才生成 modify 并落盘 —— 否则每敲一个字符
                          // 都会产出一次 revision。
                          h('div', { style: { marginTop: 6, display: 'grid', gap: 4 } },
                            h('label', { className: 'loom-note' }, '标题（失焦写入）'),
                            h('input', {
                              className: 'loom-input', type: 'text',
                              value: m.title,
                              disabled: !canEdit,
                              onChange: (e) => { m.title = e.target.value; bump() },
                              onBlur: (e) => editArchNodeField(m.id, 'title', e.target.value),
                            }),
                            h('label', { className: 'loom-note' }, '责任（必填，失焦写入）'),
                            h('textarea', {
                              className: 'loom-input',
                              rows: 3,
                              style: { width: '100%', boxSizing: 'border-box' },
                              value: m.responsibility,
                              disabled: !canEdit,
                              onChange: (e) => { m.responsibility = e.target.value; bump() },
                              onBlur: (e) => editArchNodeField(m.id, 'responsibility', e.target.value),
                            }),
                            h('label', { className: 'loom-note' }, '接口（每行一个，失焦写入）'),
                            h('textarea', {
                              className: 'loom-input',
                              rows: 2,
                              style: { width: '100%', boxSizing: 'border-box' },
                              value: (m.interface || []).join('\n'),
                              disabled: !canEdit,
                              onChange: (e) => { m.interface = e.target.value.split('\n'); bump() },
                              onBlur: (e) => editArchNodeField(
                                m.id,
                                'interface',
                                e.target.value.split('\n').map((s) => s.trim()).filter(Boolean),
                              ),
                            }),
                            h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                              h('span', { className: 'loom-note' }, '类型'),
                              h('select', {
                                className: 'loom-select',
                                value: m.kind,
                                disabled: !canEdit,
                                onChange: (e) => editArchNodeKind(m.id, e.target.value),
                              }, ARCH_NODE_KINDS.map((k) => h('option', { key: k, value: k }, ARCH_KIND_LABELS[k] || k))),
                            ),
                            h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                              h('button', {
                                className: 'loom-btn', type: 'button',
                                disabled: !editable || (m.locked && !commandCarrierAvailable()),
                                onClick: () => editToggleArchLock(m.id),
                              }, m.locked ? (commandCarrierAvailable() ? '解除冻结' : '模块已锁定') : '锁定模块'),
                              h('button', {
                                className: 'loom-btn', type: 'button',
                                disabled: !editable,
                                onClick: () => { st.archLinkFrom = m.id; st.archLinkFromPort = null; bump() },
                              },
                                st.archLinkFrom === m.id ? `已设为起点（${st.archEdgeKind}）` : '设为关系起点'),
                              h('button', {
                                className: 'loom-btn', type: 'button',
                                disabled: !canEdit,
                                onClick: () => editRemoveArchNode(m.id),
                              }, `删除此模块${relatedCount ? `（连带 ${relatedCount} 条关系）` : ''}`),
                            ),
                            relatedCount
                              ? h('div', { className: 'loom-note' }, `删除会级联删掉它的 ${relatedCount} 条关联关系（每条各记一条 GraphChange）。`)
                              : null,
                          ),
                        )
                      })()
                    : h('div', { style: { opacity: .7 } }, '点一个模块看责任与接口，并在上面直接改'),
                )
              : h('div', { className: 'loom-panel' },
              h('h4', null, '选中节点'),
              selected
                ? h('div', null,
                    h('div', null, `${selected.id} · ${KIND_LABELS[selected.kind] || selected.kind}`),
                    h('div', { style: { opacity: .8 } }, selected.goal),
                    h('div', null, `角色 ${selected.role}`),
                    h('div', null, `可写 ${(selected.ownership.writes || []).join('、') || '—'}`),
                    h('div', null, `禁止 ${(selected.ownership.forbiddenWrites || []).join('、') || '—'}`),
                    h('div', null, `隔离 ${selected.execution.isolation} · 超时 ${selected.execution.timeoutSeconds}s`),
                    h('div', { style: { opacity: .8, marginTop: 4 } }, '完成条件'),
                    h('ul', null, (selected.acceptance.doneWhen || []).map((d, i) => h('li', { key: i }, d))),
                    h('div', { style: { marginTop: 6, display: 'grid', gap: 4 } },
                      h('label', { className: 'loom-note' }, '目标（编辑后写入草案）'),
                      h('input', {
                        className: 'loom-input',
                        type: 'text',
                        value: selected.goal,
                        disabled: st.busy || !workspaceKnown(),
                        onChange: (e) => {
                          // 受控输入直接改草案会让每次按键都发一次请求；
                          // 这里只更新本地副本，失焦/回车时才落盘。
                          selected.goal = e.target.value
                          bump()
                        },
                        onBlur: (e) => editNodeField(selected.id, 'goal', e.target.value),
                      }),
                      ...[
                        ['ownership.writes', '可写文件范围（每行一个相对路径或 glob）', selected.ownership.writes.join('\n'), 'lines'],
                        ['ownership.forbiddenWrites', '禁止写入范围（每行一个）', selected.ownership.forbiddenWrites.join('\n'), 'lines'],
                        ['acceptance.doneWhen', '完成条件（每行一条）', selected.acceptance.doneWhen.join('\n'), 'lines'],
                        ['acceptance.commands', '验收命令（argv JSON 数组）', JSON.stringify(selected.acceptance.commands, null, 2), 'json'],
                      ].map(([field, label, value, kind]) => h('label', { key: `${selected.id}:${field}`, className: 'loom-note' }, label,
                        h('textarea', { key: `${selected.id}:${field}:${value}`, className: 'loom-input', rows: field === 'acceptance.commands' ? 5 : 3, 'aria-label': label,
                          defaultValue: value, disabled: st.busy || !workspaceKnown(), onBlur: e => { if (e.target.value !== value) editTaskText(selected, field, e.target.value, kind) } }))),
                      h('p', { className: 'loom-note' }, '验收命令示例：[{"argv":["pnpm","test"],"cwdRef":"node-worktree","expectedExitCode":0}]。只填写仓库真实可运行的命令；留空时仍需可核验的文件产物。'),
                      h('label', { className: 'loom-note' }, '任务超时（秒）', h('input', { key: `${selected.id}:timeout:${selected.execution.timeoutSeconds}`, className: 'loom-input', type: 'number', min: 1, max: 86400,
                        defaultValue: selected.execution.timeoutSeconds, disabled: st.busy || !workspaceKnown(), onBlur: e => { if (Number(e.target.value) !== selected.execution.timeoutSeconds) editTaskText(selected, 'execution.timeoutSeconds', e.target.value, 'number') } })),
                      h('button', {
                        className: 'loom-btn', type: 'button',
                        disabled: st.busy || !workspaceKnown(),
                        onClick: () => editRemoveNode(selected.id),
                      }, '删除此节点'),
                    ),
                  )
                : h('div', { style: { opacity: .7 } }, '点一个节点看详情'),
            ),
            st.view === 'architecture' && st.architecture && st.architecture.edges.length
              ? h('div', { className: 'loom-panel' },
                  h('h4', null, '关系（可断开）'),
                  h('ul', null, st.architecture.edges.map((e) =>
                    h('li', { key: e.id },
                      `${e.from} ${e.bidirectional ? '⇄' : '→'} ${e.to} · ${ARCH_EDGE_LABELS[e.kind] || e.kind}`,
                      h('button', {
                        className: 'loom-btn', type: 'button',
                        style: { marginLeft: 6 },
                        disabled: st.busy || !workspaceKnown(),
                        onClick: () => editRemoveArchEdge(e.id),
                      }, '断开'),
                    ),
                  )),
                )
              : null,
            h('details', { className: 'loom-panel' },
              h('summary', null, '执行能力与验证详情'),
              capRows.length
                ? h('ul', null, capRows.map((row) =>
                    h('li', { key: row.key, className: row.usable ? null : 'loom-node-issue' },
                      `${row.key}：${STAGE_TEXT[row.stage] || row.stage}`,
                      `（${row.backend === 'host' ? '宿主提供' : '本项目自建'}）`,
                      row.gaps && row.gaps.length ? h('span', { style: { opacity: .75 } }, ` · 缺口 ${row.gaps.join('、')}`) : null,
                    ),
                  ))
                : h('div', { style: { opacity: .7 } }, '加载中'),
            ),
            degradations.length
              ? h('details', { className: 'loom-panel' },
                  h('summary', null, '当前执行限制与替代路径'),
                  h('ul', null, degradations.map((d) => h('li', { key: d.key }, `${d.key}（${d.state}）→ ${d.fallback}`))),
                )
              : null,
            h('div', { className: 'loom-panel' },
              h('h4', null, '数据目录'),
              h('div', { style: { overflowWrap: 'anywhere', opacity: .8 } },
                (st.snapshot && st.snapshot.paths && st.snapshot.paths.root) || '—'),
              h('div', { style: { opacity: .8 } },
                `revision ${(st.snapshot && st.snapshot.stats && st.snapshot.stats.revisions) || 0} · ` +
                `架构 ${(st.snapshot && st.snapshot.stats && st.snapshot.stats.architectures) || 0} · ` +
                `运行记录 ${(st.snapshot && st.snapshot.stats && st.snapshot.stats.runs) || 0}`),
            ),
          ),
        ),

        !st.workflow && st.view !== 'architecture'
          ? h('div', { className: 'loom-empty' },
              h('p', null, '还没有方案图。先在上方填写目标，让 AI 规划；想自己画，也可以从空白任务图开始。'),
              h('button', { type: 'button', className: 'loom-btn', disabled: st.busy || !workspaceKnown(), onClick: newWorkflow }, '新建任务草案'))
          : null,
        !st.architecture && st.view === 'architecture'
          ? h('div', { className: 'loom-empty' },
              h('p', null, '还没有方案图。先在上方填写目标，让 AI 规划；想自己画，也可以从空白架构图开始。'),
              h('button', { type: 'button', className: 'loom-btn', disabled: st.busy || !workspaceKnown(), onClick: newArchitecture }, '新建架构草案'))
          : null,

        st.view === 'architecture' && st.archValidation
          ? h('details', { open: !st.archValidation.ok },
              h('summary', null,
                `架构校验：${st.archValidation.ok ? '通过' : st.archValidation.errors.length + ' 条错误'} · ${st.archValidation.warnings.length} 条警告`),
              h('ul', null,
                st.archValidation.errors.map((e, i) => h('li', { key: 'ae' + i }, `[${e.code}] ${e.path}：${e.message}`))
                  .concat(st.archValidation.warnings.map((w, i) => h('li', { key: 'aw' + i, style: { opacity: .75 } }, `[${w.code}] ${w.path}：${w.message}`))),
              ),
              h('p', { className: 'loom-note' }, '架构允许环与双向关系；上面若有环提示，那是**警告**，不是错误。'),
            )
          : null,

        st.view !== 'architecture' && st.validation
          ? h('details', { open: !st.validation.ok },
              h('summary', null,
                `校验：${st.validation.ok ? '通过' : st.validation.errors.length + ' 条错误'} · ${st.validation.warnings.length} 条警告`),
              h('ul', null,
                st.validation.errors.map((e, i) => h('li', { key: 'e' + i }, `[${e.code}] ${e.path}：${e.message}`))
                  .concat(st.validation.warnings.map((w, i) => h('li', { key: 'w' + i, style: { opacity: .75 } }, `[${w.code}] ${w.path}：${w.message}`))),
              ),
            )
          : null,

        st.compile
          ? h('details', { open: true },
              h('summary', null, `编译预览 · planHash ${st.compile.planHash}`),
              st.compile.missingCapabilities && st.compile.missingCapabilities.length
                ? h('p', { className: 'loom-error' },
                    `计划要求但当前不可用的能力：${st.compile.missingCapabilities.join('、')} —— 这些批次不可派发`)
                : null,
              h('ul', null, (st.compile.batches || []).map((b) =>
                h('li', { key: b.index }, `批次 ${b.index} · ${b.nodeIds.join('、')} · agent 调用 ${b.agentCalls} · scriptHash ${b.scriptHash.slice(0, 12)}`))),
              h('p', { className: 'loom-note' }, '编译不等于执行。开始执行是另一个动作，且当前会先核对能力。'),
            )
          : null,


      )
    }

    const inject = ['slots', 'uiSession', 'sessions']

    function apply(ctx) {
      hostContext = ctx
      if (ctx.uiSession || ctx.get?.('uiSession')) {
        ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'loom-session', order: 30 }, SessionLoomAction)), 'loom.session-entry')
        ctx.effect(() => ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({ name: 'conversation.chat.turnTail', id: 'loom-inline-canvas', order: 80 }, LoomInlineCanvas)), 'loom.inline-canvas')
        ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'loom-workbench', order: 80 }, LoomOverlay)), 'loom.overlay')
        /* 宿主插槽规则（从宿主 bundle 的 schema 逐条核对）：
         * - composer.bar / hero.* / input.permission / input.plan / input.model 是 **single 且已被官方占用**，
         *   同优先级注册会抛错，并把整条客户端激活链打断（0.7.0 实机验收就是这样红的）；
         * - 能安全追加的是 **list** 插槽：input.left / input.right / input.dock / input.overlay。
         * 每次注册都独立 try/catch：任何一个插槽失败都不许影响其它功能。 */
        const safeEffect = (label, fn) => {
          try { ctx.effect(fn, 'loom.' + label) } catch (error) {
            try { console.warn('[loom] ' + label + ' 挂载失败（已跳过）：' + String((error && error.message) || error)) } catch { /* 无 console 环境忽略 */ }
          }
        }
        // input.left 是 list 插槽、且在最左侧：按钮不随窗口拉伸漂移（input.right 会跟着右侧内容走）。
        safeEffect('planning-mode', () => ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: 'loom-planning-mode', order: 60 }, PlanningModeLine)))
        safeEffect('planning-tint', () => ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({ name: 'conversation.input.overlay', id: 'loom-planning-tint', order: 90 }, PlanningTint)))
        safeEffect('welcome-line', () => {
          let config = null
          let pending = false
          const sync = () => {
            try {
              if (!config) return
              // 只注入全新会话页；已有对话（哪怕还是空会话、宿主同样渲染 hero）
              // 一律不注入，并把之前注入过的撤掉。
              const sessionKey = currentSessionId()
              if (!welcomeLineVisible(config, sessionKey)) {
                const node = document.querySelector('[data-loom-welcome]')
                if (node) node.remove()
                const enabled = config.enabled !== false && config.welcomeEnabled !== false
                appearanceStatus.welcomeLine = enabled && sessionKey ? 'conversation' : null
                appearanceStatus.at = Date.now()
                return
              }
              const ok = applyWelcomeLine(document, config)
              appearanceStatus.welcomeLine = ok === true
              appearanceStatus.at = Date.now()
            } catch { /* 注入失败不能影响宿主 */ }
          }
          const schedule = () => {
            if (pending) return
            pending = true
            setTimeout(() => { pending = false; sync() }, 250)
          }
          requestJSON(API, '/config').then((value) => { config = value; sync() }).catch(() => {})
          const onConfig = (event) => { if (event && event.detail) { config = event.detail; sync() } }
          const canListen = typeof window.addEventListener === 'function'
          if (canListen) window.addEventListener('loom:config-changed', onConfig)
          const observer = typeof MutationObserver === 'function' ? new MutationObserver(schedule) : null
          try { observer?.observe(document.body, { childList: true, subtree: true }) } catch { /* 忽略 */ }
          sync()
          return () => {
            observer?.disconnect()
            if (canListen) window.removeEventListener('loom:config-changed', onConfig)
            try { const node = document.querySelector('[data-loom-welcome]'); if (node) node.remove() } catch { /* 忽略 */ }
          }
        })
      }
      if(typeof ctx.inject==='function')ctx.inject(['sidebarRight','sidebarRightTabs'],native=>{
        native.effect(()=>native.sidebarRightTabs.register({id:'loom-workbench',kind:'loom-workbench',title:()=> planningFeatureName(ctx)}),'loom.native-tab')
        native.effect(()=>native.slots.inject('sidebar.right.pane.tab',()=>{
          const dispose=native.slots.register({name:'sidebar.right.pane.tab',key:'loom-workbench'},LoomNativePane)
          nativeSidebar=native.sidebarRight
          return()=>{if(nativeSidebar===native.sidebarRight)nativeSidebar=null;dispose?.()}
        }),'loom.native-pane')
      })
      registerSettingsSection(ctx, {
        id: 'loom',
        order: 58,
        label: () => planningFeatureName(ctx),
        component: LoomSettings,
        slots: ctx && ctx.slots,
      })
    }

    const module = { exports: {} }
    module.exports.apply = apply
    module.exports.inject = inject
    module.exports.PACKAGE_ID = PACKAGE_ID
    if (window.__loomAllowTestHooks) { module.exports.readSubmittedReply = readSubmittedReply; module.exports.semanticDigest = semanticDigest; module.exports.Workbench = LoomWorkbench; module.exports.extractPlanningReply = extractPlanningReply; module.exports.buildRepairText = buildRepairText; module.exports.recoverSubmittedReply = recoverSubmittedReply; module.exports.autoArrangeGraph = autoArrangeGraph; module.exports.edgePathFor = edgePathFor; module.exports.preferPlanFileReply = preferPlanFileReply; module.exports.restorePlanFileReply = restorePlanFileReply; module.exports.planRestoreHash = planRestoreHash; module.exports.requestFileMessage = requestFileMessage; module.exports.welcomeLineStyle = welcomeLineStyle; module.exports.applyWelcomeLine = applyWelcomeLine; module.exports.flowEdgeColors = flowEdgeColors; module.exports.edgeMotionEnabled = edgeMotionEnabled; module.exports.centeredOffset = centeredOffset; module.exports.flowLaneMoves = flowLaneMoves; module.exports.auditReportText = auditReportText; module.exports.appearanceInjectionText = appearanceInjectionText; module.exports.appearanceStatus = appearanceStatus; module.exports.welcomeLineVisible = welcomeLineVisible; module.exports.lowModelGuardText = lowModelGuardText; module.exports.lowModelGuardCommand = lowModelGuardCommand; module.exports.LOW_MODEL_GUARD_THRESHOLD = LOW_MODEL_GUARD_THRESHOLD }
    return module.exports
  },
})
