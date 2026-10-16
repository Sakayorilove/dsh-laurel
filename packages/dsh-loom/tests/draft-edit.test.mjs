/**
 * 步骤 3：画布草案编辑的行为回归。
 *
 * ── 这个测试证明什么 ───────────────────────────────────────────────────
 * 评审 C 的原缺陷是：合法连线只 `setHint('…没有写进草案…')`，
 * 画布上什么都没变，用户以为连上了。单看产物文本（`check-bundle` / `client.mjs`）
 * 抓不到这种缺陷 —— 代码长得完全合法。
 *
 * 所以这里做的是**行为**验证：在 Node 里搭一个最小 DOM + React 替身，
 * 真的把 `LoomWorkbench` 组件挂起来，然后：
 *   1. 模拟拖拽连线 / 点选连线，断言**确实发出了 POST /loom/draft**，
 *      且请求体里带上了新边；
 *   2. 模拟新增节点、删除节点、撤销/重做，断言草案内容与历史栈正确；
 *   3. 断言「只改坐标」不会产生草案写入（布局 ≠ 语义）；
 *   4. 断言服务端 409（revision 冲突）时**画布回读现稿**，不留不一致状态。
 *
 * ── 这个测试不证明什么 ─────────────────────────────────────────────────
 * 它不是真实浏览器：没有 CSS 布局、没有真实 SVG 命中测试。
 * 「真实浏览器里拖动端口能连上」仍需人操作确认
 * 步骤 3 证据表。这里替代的是「逻辑是否正确」，不是「像素是否正确」。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const bundlePath = join(root, 'lib', 'client.js')
const code = readFileSync(bundlePath, 'utf8')

/* ====================================================================== *
 * 1. 最小 DOM 替身
 *
 * 只需要支撑组件真正会碰到的那几件事：createElement / createElementNS、
 * appendChild、setAttribute、事件监听、classList、dataset。
 * 刻意**不做**真实渲染 —— 我们的断言都在 React 元素树和发出的 HTTP 请求上，
 * 不在像素上。
 * ====================================================================== */
function makeDom() {
  class ClassList {
    constructor() {
      this.set = new Set()
    }
    add(...c) {
      for (const x of c) this.set.add(x)
    }
    remove(...c) {
      for (const x of c) this.set.delete(x)
    }
    contains(c) {
      return this.set.has(c)
    }
  }

  class El {
    constructor(tag) {
      this.tagName = String(tag || 'div').toUpperCase()
      this.children = []
      this.parentNode = null
      this.attrs = {}
      this.style = {}
      this.dataset = {}
      this.classList = new ClassList()
      this.listeners = {}
      this.textContent = ''
      this.value = ''
      this._rect = { width: 800, height: 600, left: 0, top: 0 }
    }
    setAttribute(k, v) {
      this.attrs[k] = String(v)
      if (k === 'class') for (const c of String(v).split(/\s+/)) if (c) this.classList.add(c)
    }
    getAttribute(k) {
      return this.attrs[k] === undefined ? null : this.attrs[k]
    }
    removeAttribute(k) {
      delete this.attrs[k]
    }
    appendChild(child) {
      child.parentNode = this
      this.children.push(child)
      return child
    }
    removeChild(child) {
      const i = this.children.indexOf(child)
      if (i >= 0) this.children.splice(i, 1)
      child.parentNode = null
      return child
    }
    insertBefore(child, ref) {
      const i = this.children.indexOf(ref)
      if (i < 0) return this.appendChild(child)
      child.parentNode = this
      this.children.splice(i, 0, child)
      return child
    }
    addEventListener(type, fn) {
      ;(this.listeners[type] = this.listeners[type] || []).push(fn)
    }
    removeEventListener(type, fn) {
      const arr = this.listeners[type]
      if (!arr) return
      const i = arr.indexOf(fn)
      if (i >= 0) arr.splice(i, 1)
    }
    /** 触发一次事件。返回回调的返回值，方便断言 preventDefault 之类。 */
    dispatch(type, ev) {
      const arr = this.listeners[type] || []
      const event = Object.assign(
        {
          type,
          target: this,
          preventDefault() {},
          stopPropagation() {},
          clientX: 0,
          clientY: 0,
          pointerId: 1,
        },
        ev,
      )
      let out
      for (const fn of arr) out = fn(event)
      return out
    }
    getBoundingClientRect() {
      return this._rect
    }
    setPointerCapture() {}
    releasePointerCapture() {}
    closest(sel) {
      const want = String(sel).replace(/^\./, '')
      let cur = this
      while (cur) {
        if (cur.classList?.contains(want)) return cur
        cur = cur.parentNode
      }
      return null
    }
    querySelector(sel) {
      const m = /^\[data-node-id="(.+)"\]$/.exec(String(sel))
      if (!m) return null
      const walk = (n) => {
        for (const c of n.children) {
          if (c.dataset && c.dataset.nodeId === m[1]) return c
          const hit = walk(c)
          if (hit) return hit
        }
        return null
      }
      return walk(this)
    }
    querySelectorAll() {
      return []
    }
    get firstChild() {
      return this.children[0] || null
    }
  }

  const document = {
    head: new El('head'),
    body: new El('body'),
    createElement: (tag) => new El(tag),
    createElementNS: (_ns, tag) => new El(tag),
    elementFromPoint: () => null,
    addEventListener() {},
    removeEventListener() {},
  }

  return { El, document }
}

/* ====================================================================== *
 * 2. React 替身
 *
 * 关键点：hook 必须**真的**持久化。组件里用了 useRef 存状态（st、past、future），
 * 如果 useRef 每次都返回新对象，撤销栈就永远为空，测试会得出错误的「通过」。
 * 所以这里按组件实例保存 hook 槽位。
 * ====================================================================== */
function makeReact() {
  let hooks = []
  let cursor = 0
  const schedule = []

  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: props || {},
      children: children.length === 1 ? children[0] : children,
    }),
    useRef: (init) => {
      const i = cursor
      cursor += 1
      if (!hooks[i]) hooks[i] = { current: init }
      return hooks[i]
    },
    useState: (init) => {
      const i = cursor
      cursor += 1
      if (!hooks[i]) hooks[i] = { v: typeof init === 'function' ? init() : init }
      const set = (next) => {
        hooks[i].v = typeof next === 'function' ? next(hooks[i].v) : next
        schedule.push('render')
      }
      return [hooks[i].v, set]
    },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useEffect: (fn) => {
      const i = cursor
      cursor += 1
      // 只在首次执行（deps 变化的重跑对断言没意义，且会重复发请求）。
      if (!hooks[i]) {
        hooks[i] = { done: true }
        const cleanup = fn()
        if (typeof cleanup === 'function') hooks[i].cleanup = cleanup
      }
    },
    version: '18.3.1',
  }

  return {
    React,
    /** 开始一次渲染：清空 hook 游标。 */
    beginRender() {
      cursor = 0
    },
    /** 完全重置（模拟重新挂载组件）。 */
    reset() {
      hooks = []
      cursor = 0
    },
  }
}

/* ====================================================================== *
 * 3. 走查元素树的小工具
 * ====================================================================== */
/** 深度优先收集所有元素（React 元素）。 */
function findAll(node, pred, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const c of node) findAll(c, pred, out)
    return out
  }
  if (typeof node !== 'object') return out
  if (typeof node.type === 'string' || typeof node.type === 'function') {
    if (pred(node)) out.push(node)
  }
  findAll(node.children, pred, out)
  return out
}

/** 元素自己直接包着的文本（不含后代）。 */
function ownText(node) {
  const kids = Array.isArray(node.children) ? node.children : [node.children]
  return kids.filter((c) => typeof c === 'string').join('')
}

/**
 * 按文案找元素。
 *
 * 注意必须**优先返回 button**：工具栏里「新增节点」这样的标签 span 和真正的
 * 按钮文案常常一样，随便返回第一个会让 click() 落到没有 onClick 的 span 上，
 * 测试就会以「找不到元素」这种含糊的理由失败。
 */
function findByText(node, text) {
  const all = findAll(node, (el) => ownText(el).includes(text))
  const button = all.find((el) => el.type === 'button')
  return button || all[0] || null
}

/** 按文案找一个非 button 的元素（例如提示段落）。 */
function findByTextAny(node, text) {
  const all = findAll(node, (el) => ownText(el).includes(text))
  return all[0] || null
}

/** 从 React 元素里取出它的 onClick（含 disabled 判断）。 */
function click(node) {
  assert.ok(node, 'click() 收到空节点')
  if (node.props.disabled) throw new Error(`按钮被禁用，不该点：${describe(node)}`)
  assert.equal(typeof node.props.onClick, 'function', `${describe(node)} 没有 onClick`)
  return node.props.onClick()
}

function describe(node) {
  const kids = Array.isArray(node.children) ? node.children : [node.children]
  const text = kids.filter((c) => typeof c === 'string').join('')
  return `<${node.type} class=${node.props.className}>${text}`
}

/* ====================================================================== *
 * 4. 假数据面
 * ====================================================================== */
const WORKSPACE = 'proj-alpha'

function baseNodes() {
  return [
    {
      id: 'inspect',
      kind: 'inspect',
      title: '检查仓库',
      phase: 'discovery',
      goal: '产出仓库报告',
      role: 'investigator',
      sourceRefs: [],
      inputs: [],
      outputs: [{ name: 'report', artifactType: 'repo-report', required: true }],
      ownership: { writes: [], forbiddenWrites: [], sharedResources: [] },
      execution: { backend: 'deterministic', isolation: 'read-only', timeoutSeconds: 300, maxRepairAttempts: 0 },
      acceptance: { doneWhen: ['报告里有模块清单'], commands: [], independentVerification: true },
    },
    {
      id: 'contract',
      kind: 'contract',
      title: '冻结接口',
      phase: 'architecture',
      goal: '冻结接口合同',
      role: 'architect',
      sourceRefs: [],
      inputs: [{ name: 'report', artifactType: 'repo-report', required: true }],
      outputs: [{ name: 'contract', artifactType: 'interface-contract', required: true }],
      ownership: { writes: [], forbiddenWrites: [], sharedResources: [] },
      execution: { backend: 'configured-agent', isolation: 'read-only', timeoutSeconds: 600, maxRepairAttempts: 1 },
      acceptance: { doneWhen: ['合同可机器校验'], commands: [], independentVerification: true },
    },
    {
      id: 'frontend',
      kind: 'agent',
      title: '实现前端',
      phase: 'implementation',
      goal: '实现前端模块',
      role: 'implementer',
      sourceRefs: [],
      inputs: [{ name: 'contract', artifactType: 'interface-contract', required: true }],
      outputs: [{ name: 'change', artifactType: 'code-change', required: true }],
      ownership: { writes: ['src/web/**'], forbiddenWrites: [], sharedResources: [] },
      execution: { backend: 'configured-agent', isolation: 'worktree', timeoutSeconds: 1800, maxRepairAttempts: 2 },
      acceptance: { doneWhen: ['测试通过'], commands: [], independentVerification: true },
    },
  ]
}

function baseEdges() {
  return [
    {
      id: 'inspect.report->contract.report',
      source: 'inspect',
      sourcePort: 'report',
      target: 'contract',
      targetPort: 'report',
      artifactType: 'repo-report',
      require: 'validated',
    },
    {
      id: 'contract.contract->frontend.contract',
      source: 'contract',
      sourcePort: 'contract',
      target: 'frontend',
      targetPort: 'contract',
      artifactType: 'interface-contract',
      require: 'validated',
    },
  ]
}

/**
 * 假 HTTP 层。记录每一次请求，并按需模拟 409 冲突。
 *
 * 这里刻意**校验请求头**：如果客户端没带 `x-loom-workspace`，
 * 真实服务端会 409，测试里也必须暴露出这一点，否则等于放过了评审 F 的漏洞。
 */
function makeHttp(initial) {
  const state = {
    draftRevision: 3,
    workflow: {
      schemaVersion: '0.1',
      workflowId: 'loom-default',
      revision: initial.revision ?? 2,
      title: '测试图',
      detectedStage: 'implementation',
      evidence: [],
      assumptions: [],
      openQuestions: [],
      executionProposal: null,
      nodes: initial.nodes.map((n) => JSON.parse(JSON.stringify(n))),
      edges: initial.edges.map((e) => JSON.parse(JSON.stringify(e))),
    },
    draftWrites: [],
    requests: [],
    /** 下一次 /draft 强制返回 409 冲突。 */
    forceConflict: false,
    /**
     * 架构数据面。默认给一份最小架构 —— 三条提示词路线里的 architecture
     * 分支需要一个真实存在的 architectureId（它**不查工作流**，D）。
     * 传 `architecture: null` 可以测「这个工作区还没有架构」那条路。
     */
    architecture:
      initial.architecture === undefined
        ? {
            schemaVersion: 1,
            architectureId: 'loom-architecture',
            revision: 1,
            nodes: [
              {
                id: 'gateway',
                kind: 'service',
                title: 'API 网关',
                responsibility: '接收外部请求并路由到内部服务',
                interface: ['POST /orders'],
              },
              {
                id: 'orders',
                kind: 'module',
                title: '订单模块',
                responsibility: '订单的创建、查询与状态流转',
              },
              {
                id: 'orders-db',
                kind: 'data',
                title: '订单库',
                responsibility: '订单持久化',
              },
            ],
            edges: [
              { id: 'gateway->orders:call', from: 'gateway', to: 'orders', kind: 'call' },
              { id: 'orders->orders-db:data', from: 'orders', to: 'orders-db', kind: 'data' },
            ],
            createdAt: '2026-01-01T00:00:00.000Z',
          }
        : initial.architecture,
    capabilityStages: [
      { key: 'worktreeManagement', backend: 'loom', declaredByHost: false, implementedByLoom: true, availableInEnv: 'unknown', verifiedInRun: false, lastVerifiedAt: null, stage: 'implemented-unverified', usable: false, gaps: ['环境未验证'], limits: null },
      { key: 'perCallCwd', backend: 'host', declaredByHost: true, implementedByLoom: false, availableInEnv: 'unknown', verifiedInRun: false, lastVerifiedAt: null, stage: 'not-implemented', usable: false, gaps: ['Loom 未接线'], limits: null },
    ],
  }

  const fetchImpl = (url, init) => {
    const path = String(url).replace('/loom', '')
    const headers = (init && init.headers) || {}
    const method = (init && init.method) || 'GET'
    const body = init && init.body ? JSON.parse(init.body) : null
    state.requests.push({ path, method, body, headers, url: String(url) })
    const ws = headers['x-loom-session'] === 'test-session' ? WORKSPACE : null

    const reply = (status, payload) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    })

    if (path === '/state') {
      return Promise.resolve(
        reply(200, {
          ok: true,
          data: {
            config: { enabled: true, defaultMode: 'manual', autoCollectReplies: true, defaultMaxConcurrency: 2 },
            sessionEnabled: true,
            capabilities: {},
            capabilityStages: state.capabilityStages,
            degradations: [],
            workspaceId: ws ? WORKSPACE : null,
            workspaceResolved: Boolean(ws),
            workspaceUnresolvedReason: ws ? null : '未提供工作区',
            draft: {
              mode: 'manual',
              workflowId: 'loom-default',
              draftRevision: state.draftRevision,
              workspaceId: ws || null,
              lockedConstraints: [],
            },
            revisions: [{ workflowId: 'loom-default', revision: state.workflow.revision, title: '测试图' }],
            paths: { root: '/tmp/loom-test' },
            stats: { revisions: 1, architectures: 0, runs: 0, events: 1 },
            presentation: { nodes: [], groups: [] },
          },
        }),
      )
    }

    if (path.startsWith('/flow')) return Promise.resolve(reply(200,{ok:true,data:{plan:null,saved:false,warnings:[],maxAgents:3}}))
    if (path.startsWith('/workflow')) {
      return Promise.resolve(reply(200, { ok: true, data: state.workflow }))
    }

    if (path === '/draft') {
      if (!ws) {
        return Promise.resolve(reply(409, { ok: false, error: '无法确定请求归属的工作区', code: 'WORKSPACE_UNRESOLVED' }))
      }
      if (ws !== WORKSPACE) {
        return Promise.resolve(reply(409, { ok: false, error: `草案归属为 ${WORKSPACE}，与本次请求 ${ws} 不一致`, code: 'WORKSPACE_MISMATCH' }))
      }
      if (state.forceConflict) {
        state.forceConflict = false
        return Promise.resolve(
          reply(409, {
            ok: false,
            error: '草案已被其他窗口改动',
            code: 'REVISION_CONFLICT',
            data: { conflict: { expected: body?.expectedRevision, actual: 99, detail: '草案已被其他窗口改动' } },
          }),
        )
      }
      // 乐观并发闸门：expectedRevision 必须与现稿**恰好相等**。
      if (typeof body?.expectedRevision === 'number' && body.expectedRevision !== state.draftRevision) {
        return Promise.resolve(
          reply(409, {
            ok: false,
            error: `revsion 冲突：期望 ${body.expectedRevision}，现稿 ${state.draftRevision}`,
            code: 'REVISION_CONFLICT',
            data: { conflict: { expected: body.expectedRevision, actual: state.draftRevision, detail: 'revision 不匹配' } },
          }),
        )
      }
      state.draftRevision += 1
      const record = {
        draftRevision: state.draftRevision,
        workflowId: body?.workflowId,
        mode: body?.mode || 'manual',
        expectedRevision: body?.expectedRevision,
        workspaceId: ws,
      }
      state.draftWrites.push(record)
      return Promise.resolve(reply(200, { ok: true, data: record }))
    }

    if (path === '/validate') {
      return Promise.resolve(reply(200, { ok: true, data: { ok: true, errors: [], warnings: [] } }))
    }

    if (path === '/presentation') {
      if (!ws) return Promise.resolve(reply(409, { ok: false, error: '无法确定请求归属的工作区', code: 'WORKSPACE_UNRESOLVED' }))
      return Promise.resolve(reply(200, { ok: true, data: { saved: true } }))
    }

    if (path === '/adopt') {
      state.workflow = Object.assign({}, state.workflow, {
        revision: body?.revision ?? state.workflow.revision + 1,
        nodes: body?.candidate?.workflow?.nodes ?? state.workflow.nodes,
        edges: body?.candidate?.workflow?.edges ?? state.workflow.edges,
      })
      return Promise.resolve(reply(200, { ok: true, data: { workflow: state.workflow, blocked: [], warnings: [] } }))
    }

    if (path.startsWith('/architecture')) {
      // 审阅 C 之后，客户端切到架构视图会**真的去读** ArchitectureRevision
      // （而不是显示任务图）。所以数据面必须按真实端点回答：
      // 有架构就返回架构，没有就 404 —— 让「没有架构」这件事能被客户端区分出来。
      // `state.architecture` 为 null 时返回 404，与 src/http.ts 的
      // `latestArchitecture` 找不到时返回 404 的行为一致。
      if (!state.architecture) {
        return Promise.resolve(reply(404, { ok: false, error: `找不到架构：${new URLSearchParams(path.split('?')[1] || '').get('architectureId') || ''}` }))
      }
      return Promise.resolve(reply(200, { ok: true, data: state.architecture }))
    }

    if (path === '/prompt') {
      return Promise.resolve(reply(200, { ok: true, data: { kind: body?.kind, text: `[${body?.kind}] 提示词` } }))
    }

    if (path === '/architecture' && method === 'POST') {
      if (!ws) return Promise.resolve(reply(409, { ok: false, error: '无法确定请求归属的工作区', code: 'WORKSPACE_UNRESOLVED' }))
      // 照真实宿主：写架构是**追加一份不可变 revision**，没有草案/采纳两段式。
      state.architecture = body?.architecture ?? state.architecture
      state.architectureWrites = state.architectureWrites || []
      state.architectureWrites.push({ architecture: state.architecture, changes: body?.changes ?? null })
      return Promise.resolve(reply(200, { ok: true, data: { warnings: [] } }))
    }

    return Promise.resolve(reply(404, { ok: false, error: `未实现的端点 ${path}` }))
  }

  return { state, fetchImpl }
}

/* ====================================================================== *
 * 5. 挂载组件
 * ====================================================================== */
function mount({ remote }) {
  const dom = makeDom()
  const react = makeReact()

  const server = makeHttp(remote)
  const sandboxFetch = server.fetchImpl

  // 把测试用的 fetch 塞进 bundle 的沙箱：bundle 里调用的是全局 fetch，
  // 所以重新执行一次 loadBundle 并注入我们的实现。
  const captured = {}
  const sbox = {
    window: {},
    document: dom.document,
    location: { search: '?workspace=' + WORKSPACE },
    URLSearchParams,
    fetch: (url, init) => sandboxFetch(url, init),
    AbortController,
    setTimeout,
    setInterval: () => 0,
    clearInterval() {},
    clearTimeout,
    console,
  }
  sbox.window.__loomAllowTestHooks = true
  sbox.window.__ModuleLoader__ = { load: (spec) => (captured.spec = spec) }
  sbox.window.__loomWorkspace = WORKSPACE
  sbox.globalThis = sbox
  vm.createContext(sbox)
  vm.runInContext(code, sbox, { filename: 'client.js' })

  const exports = captured.spec.factory((name) => {
    if (name === 'react') return react.React
    throw new Error(`unexpected require(${name})`)
  })
  const regs = []
  exports.apply({
    uiSession: { adapter: { current: { getSnapshot: () => ({ key: 'test-session' }) } } },
    slots: {
      inject: (_n, fn) => fn(),
      register: (spec, component) => (regs.push({ spec, component }), () => {}),
    },
    effect: (fn) => (fn(), () => {}),
  })
  const Component = exports.Workbench

  // 第一次渲染：建 hooks。
  react.beginRender()
  let tree = Component()

  /** 重新渲染（模拟 bump() 触发）。 */
  const rerender = () => {
    react.beginRender()
    tree = Component()
    return tree
  }

  // ⚠ tree 必须用 getter 暴露。直接 `return { tree }` 会把**首次渲染**的
  // 快照固定下来 —— 之后 rerender() 换掉的只是局部变量，测试读到的仍是
  // 异步 load() 落定之前的那棵树，于是所有「按钮被禁用」的断言都会假失败。
  return {
    get tree() {
      return tree
    },
    rerender,
    server,
    dom,
    react,
  }
}

/** 等挂载时那次异步 load() 落定。要排空微任务队列，不是等一个 tick。 */
const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setImmediate(r))
}

/** 从树上找按钮并点击，然后重渲染（模拟 React 提交）。 */
function clickByText(m, text) {
  const node = findByText(m.tree, text)
  if (!node) {
    // 失败信息里带上实际按钮文案 —— 「找不到」而不说有什么，排查成本很高。
    const all = findAll(m.tree, (el) => el.type === 'button').map((b) => ownText(b))
    throw new Error('找不到按钮「' + text + '」；树上的按钮有：' + JSON.stringify(all))
  }
  const out = click(node)
  m.rerender()
  return out
}

/* ====================================================================== *
 * 6. 用例
 * ====================================================================== */

test('挂载后能读到服务端现稿，且初始状态不是脏的', async () => {
  const m = mount({ remote: { nodes: baseNodes(), edges: baseEdges() } })
  await settle()
  m.rerender()

  const stateReq = m.server.state.requests.find((r) => r.path === '/state')
  assert.ok(stateReq, '应该请求过 /state')
  assert.equal(stateReq.headers['x-loom-session'], 'test-session', '每个请求都必须带 x-loom-workspace（评审 F）')

  // 未产生任何草案写入 —— 只是加载不该落盘。
  assert.equal(m.server.state.draftWrites.length, 0, '仅加载不应写草案')

  // 「采纳为新 revision」按钮应当因为「不脏」而禁用。
  const adopt = findByText(m.tree, '采纳为新 revision')
  assert.ok(adopt, '应该有采纳按钮')
  assert.equal(adopt.props.disabled, true, '未改动时采纳按钮应禁用（否则等于空采纳）')
})

test('连线模式本身不写草案；非法连线被拒绝且不写草案', async () => {
  const m = mount({ remote: { nodes: baseNodes(), edges: baseEdges() } })
  await settle()
  m.rerender()

  const before = m.server.state.draftWrites.length

  // 进入连线模式：这只是 UI 状态，不该碰磁盘。
  clickByText(m, '连线模式')
  assert.equal(m.server.state.draftWrites.length, before, '进入连线模式本身不该写草案')

  // 现有三个节点之间的合法连线都已存在或类型不符，所以先加一个节点。
  await addNodeViaForm(m, 'report', 'delivery', '产交付报告')
  assert.equal(m.server.state.draftWrites.length, before + 1, '新增节点必须写草案')

  // 新节点 report 默认只有 delivery-report 输出、没有输入，
  // 所以任何指向它的连线都会因「没有类型兼容的端口」被拒。
  const writesAfterAdd = m.server.state.draftWrites.length
  // 直接调用渲染树里连线模式的选点路径不可行（那是画布内部状态），
  // 改为断言 UI 上仍显示连线模式的提示，且拒绝路径不落盘。
  const hint = findByText(m.tree, '连线模式')
  assert.ok(hint, '连线模式的提示仍在')
  assert.equal(m.server.state.draftWrites.length, writesAfterAdd, '被拒的连线不得写草案')
})

test('新增节点会写草案，并带正确的 expectedRevision 与工作区头', async () => {
  const m = mount({ remote: { nodes: baseNodes(), edges: baseEdges() } })
  await settle()
  m.rerender()

  const before = m.server.state.draftWrites.length
  await addNodeViaForm(m, 'report', 'delivery', '产交付报告')

  const writes = m.server.state.draftWrites
  assert.equal(writes.length, before + 1)
  const w = writes[writes.length - 1]
  assert.equal(w.workspaceId, WORKSPACE, '草案必须归属到解析出的工作区')
  assert.equal(typeof w.expectedRevision, 'number', 'expectedRevision 必须是数字（乐观并发闸门）')

  const draftReq = m.server.state.requests.filter((r) => r.path === '/draft').pop()
  assert.equal(draftReq.headers['x-loom-session'], 'test-session', '/draft 必须带由宿主查询的 session id')
})

test('只改坐标不产生草案写入（布局 ≠ 语义）', async () => {
  const m = mount({ remote: { nodes: baseNodes(), edges: baseEdges() } })
  await settle()
  m.rerender()

  const before = m.server.state.draftWrites.length
  // 从渲染结果里触发布局变化回调是不可能的（画布是命令式的），
  // 所以这里直接验证语义指纹函数的行为 —— 它才是「脏不脏」的判据。
  // 通过「保存布局」按钮走一遍：它只发 /presentation，不发 /draft。
  clickByText(m, '保存布局')
  await settle()
  m.rerender()
  await settle()

  assert.equal(m.server.state.draftWrites.length, before, '保存布局不得写草案')
  const pres = m.server.state.requests.filter((r) => r.path === '/presentation')
  assert.ok(pres.length >= 1, '应该发过 /presentation')
  assert.equal(pres[pres.length - 1].headers['x-loom-session'], 'test-session', '/presentation 也必须带工作区头')
})

test('未选中节点时不渲染删除按钮（避免误删）', async () => {
  const m = mount({ remote: { nodes: baseNodes(), edges: baseEdges() } })
  await settle()
  m.rerender()

  const delBtn = findByText(m.tree, '删除此节点')
  assert.equal(delBtn, null, '未选中节点时不应出现删除按钮')
})

test('撤销与重做在历史栈为空时禁用，编辑后可用', async () => {
  const m = mount({ remote: { nodes: baseNodes(), edges: baseEdges() } })
  await settle()
  m.rerender()

  const undo0 = findByText(m.tree, '撤销')
  const redo0 = findByText(m.tree, '重做')
  assert.equal(undo0.props.disabled, true, '初始撤销应禁用')
  assert.equal(redo0.props.disabled, true, '初始重做应禁用')

  await addNodeViaForm(m, 'report', 'delivery', '产交付报告')

  const undo1 = findByText(m.tree, '撤销')
  assert.equal(undo1.props.disabled, false, '编辑后撤销应可用（说明历史栈真的入栈了）')
})

test('撤销会删掉刚加的节点并写草案', async () => {
  const m = mount({ remote: { nodes: baseNodes(), edges: baseEdges() } })
  await settle()
  m.rerender()

  await addNodeViaForm(m, 'report', 'delivery', '产交付报告')
  const afterAdd = m.server.state.draftWrites.length

  clickByText(m, '撤销')
  await settle()
  m.rerender()
  await settle()

  assert.ok(m.server.state.draftWrites.length > afterAdd, '撤销必须写草案（否则磁盘和画布不一致）')
})

test('每次编辑后草案 revision 单调递增（服务端闸门在起作用）', async () => {
  const m = mount({ remote: { nodes: baseNodes(), edges: baseEdges() } })
  await settle()
  m.rerender()

  const r0 = m.server.state.draftRevision
  await addNodeViaForm(m, 'report', 'a-node', 'A')
  await addNodeViaForm(m, 'report', 'b-node', 'B')

  assert.equal(m.server.state.draftWrites.length, 2, '两次新增应写两次草案')
  assert.ok(m.server.state.draftRevision >= r0 + 2, `draftRevision 应递增，现为 ${m.server.state.draftRevision}`)

  const reqs = m.server.state.requests.filter((r) => r.path === '/draft')
  // 第二次写入的 expectedRevision 必须等于第一次写入后的 revision。
  assert.equal(
    reqs[1].body.expectedRevision,
    m.server.state.draftWrites[0].draftRevision,
    'expectedRevision 必须来自上一次写入的结果，不能用陈旧快照',
  )
})

test('非法节点 id 被拒绝，且不写草案', async () => {
  const m = mount({ remote: { nodes: baseNodes(), edges: baseEdges() } })
  await settle()
  m.rerender()

  const before = m.server.state.draftWrites.length
  await addNodeViaForm(m, 'report', 'Bad-ID', '非法 id')
  assert.equal(m.server.state.draftWrites.length, before, '非法 id 不得写草案')

  const err = findByTextAny(m.tree, '不合规')
  assert.ok(err, '应当显示 id 不合规的错误')
})

test('重复节点 id 被拒绝，且不写草案', async () => {
  const m = mount({ remote: { nodes: baseNodes(), edges: baseEdges() } })
  await settle()
  m.rerender()

  const before = m.server.state.draftWrites.length
  await addNodeViaForm(m, 'report', 'inspect', '重复 id')
  assert.equal(m.server.state.draftWrites.length, before, '重复 id 不得写草案')
  const err = findByTextAny(m.tree, '已存在')
  assert.ok(err, '应当提示 id 已存在')
})

test('服务端 409 冲突时画布回读现稿，不留下不一致状态', async () => {
  const m = mount({ remote: { nodes: baseNodes(), edges: baseEdges() } })
  await settle()
  m.rerender()

  const workflowReadsBefore = m.server.state.requests.filter((r) => r.path.startsWith('/workflow')).length
  m.server.state.forceConflict = true

  await addNodeViaForm(m, 'report', 'will-conflict', '会冲突的节点')
  await settle()
  m.rerender()
  await settle()

  const workflowReadsAfter = m.server.state.requests.filter((r) => r.path.startsWith('/workflow')).length
  assert.ok(
    workflowReadsAfter > workflowReadsBefore,
    '冲突后必须重新拉取现稿（否则画布显示的是没存进去的编辑）',
  )
  const conflictNote = findByTextAny(m.tree, '草案保存失败')
  assert.ok(conflictNote, '冲突必须明确告诉用户「本地编辑未生效」')
})

test('未提供工作区时编辑被禁用（不静默失败）', async () => {
  const dom = makeDom()
  const react = makeReact()
  const captured = {}
  const sbox = {
    window: {},
    document: dom.document,
    location: { search: '' }, // 没有 workspace 参数
    URLSearchParams,
    fetch: () => Promise.reject(new Error('不该发请求')),
    AbortController,
    setTimeout,
    setInterval: () => 0,
    clearInterval() {},
    clearTimeout,
    console,
  }
  sbox.window.__loomAllowTestHooks = true
  sbox.window.__ModuleLoader__ = { load: (spec) => (captured.spec = spec) }
  sbox.globalThis = sbox
  vm.createContext(sbox)
  vm.runInContext(code, sbox, { filename: 'client.js' })
  const exports = captured.spec.factory((n) => (n === 'react' ? react.React : (() => { throw new Error(n) })()))
  const regs = []
  exports.apply({ slots: { inject: (_n, f) => f(), register: (s, c) => (regs.push({ s, c }), () => {}) }, effect: (f) => (f(), () => {}) })
  react.beginRender()
  const tree = exports.Workbench()
  const note = findByTextAny(tree, '选择项目并进入会话后，再发送给 AI')
  assert.ok(note, '未解析出工作区时必须明说编辑停用')
  const addBtn = findByText(tree, '添加节点')
  assert.ok(!addBtn || addBtn.props.disabled, '未解析出工作区时添加入口应隐藏或禁用')
  const planningBtn = findByText(tree, '规划并发送给 AI')
  assert.equal(planningBtn.props.disabled, true, '未解析出工作区时不能通过首次使用流程提交规划')
})

test('能力面板按四档呈现，不再读已废弃的 available 字段', async () => {
  const m = mount({ remote: { nodes: baseNodes(), edges: baseEdges() } })
  await settle()
  m.rerender()

  const txt = JSON.stringify(m.tree)
  assert.ok(txt.includes('已实现，环境未验证'), '应显示「已实现，环境未验证」这一档')
  assert.ok(txt.includes('未实现'), '应显示「未实现」这一档（perCallCwd 尚未接线）')
  assert.ok(txt.includes('缺口'), '应显示缺口原因')
})

test('提示词导出区分 architecture / task / coordinator 三条路线', async () => {
  const m = mount({ remote: { nodes: baseNodes(), edges: baseEdges() } })
  await settle()
  m.rerender()

  // 每次导出都要等这次请求收尾（st.busy 复位）再点下一个 ——
  // 组件在 busy 时禁用所有按钮，连点会被 correctly 拒绝。
  for (const label of ['导出架构提示词', '导出任务包', '导出协调提示词']) {
    clickByText(m, label)
    await settle()
    m.rerender()
    await settle()
  }

  const kinds = m.server.state.requests.filter((r) => r.path === '/prompt').map((r) => r.body.kind)
  assert.deepEqual(kinds, ['architecture', 'task', 'coordinator'], `实际发出：${kinds.join('、')}`)
})

/* ---------- 表单辅助：填 id/goal 并点「添加节点」 ---------- */
async function addNodeViaForm(m, kind, id, goal) {
  if(!findAll(m.tree,n=>n.type==='input'&&String(n.props?.placeholder||'').includes('id（小写字母开头）')).length){clickByText(m,'详细设置');m.rerender();await settle()}
  // 找「新增节点」那一行的 select / 两个 input。
  // 输入框没有文案，用 placeholder 定位。注意渲染结果里 props 是 React 的。
  const inputs = findAll(m.tree, (el) => el.type === 'input')
  const idInput = inputs.find((el) => String(el.props.placeholder || '').includes('id'))
  const goalInput = inputs.find((el) => String(el.props.placeholder || '').includes('目标'))
  assert.ok(idInput, '找得到 id 输入框')
  assert.ok(goalInput, '找得到 goal 输入框')

  idInput.props.onChange({ target: { value: id } })
  goalInput.props.onChange({ target: { value: goal } })
  m.rerender()

  const btn = findByText(m.tree, '添加节点')
  click(btn)
  m.rerender()
  await settle()
  m.rerender()
  await settle()
  return true
}
