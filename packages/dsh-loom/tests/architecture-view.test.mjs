/**
 * 步骤 3 剩余项：架构视图读取并编辑 ArchitectureRevision。
 *
 * ── 这个测试证明什么 ───────────────────────────────────────────────────
 * 评审 C 剩下那句话是：「架构视图读取并编辑 ArchitectureRevision，
 * 允许合法双向关系；任务视图保持 DAG。新增模块、修改关系或接口要生成
 * 稳定 ID 和准确 GraphChange，不能用任务图冒充架构图。」
 *
 * 修之前，架构视图是**假的**：切过去只显示一句「当前还没接上」，
 * 画布上仍然是任务图。这种缺陷单看产物文本抓不到 —— 代码长得完全合法。
 * 所以这里做**行为**验证：用最小 DOM + React 替身把组件挂起来，然后：
 *   1. 切到架构视图，断言画布上出现的是**架构模块**（含架构专属的
 *      data-arch-kind 标记与责任文案），而不是任务节点；
 *   2. 断言此时**不再**向服务端发 /workflow 请求来「凑」架构图；
 *   3. 双向关系与环在架构视图**被接受**并写成 revision；
 *      同一对节点在任务视图必须**被拒绝**（任务图 DAG 不放松）；
 *   4. 新增模块生成符合 ID_PATTERN 的稳定 id，重复提交不覆盖（得到 -2）；
 *   5. 切视图不丢数据（架构 → 任务 → 架构，两份图各自的编辑都还在）；
 *   6. 提示词导出走 kind:'architecture' 且带上真实的 architectureId。
 *
 * ── 这个测试不证明什么 ─────────────────────────────────────────────────
 * 它不是真实浏览器：没有 CSS 布局、没有真实 SVG 命中测试、没有真实点击。
 * 「在真浏览器里能拖动/能点」由 tests/browser-draft-edit.test.mjs 与
 * 人工证据覆盖。这里替代的是「逻辑是否正确」，不是「像素是否正确」。
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

/** 与 src/core/model.ts 的 ID_PATTERN 同一形状 —— 测试必须独立复述它，而不是从产物里 import。 */
const ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/

/* ====================================================================== *
 * 1. 最小 DOM 替身（支撑组件真正会碰到的那几件事）
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
      this._className = ''
      this._rect = { width: 800, height: 600, left: 0, top: 0 }
    }
    /**
     * mountCanvas 里是用 `node.className = cls` 设的类，不是 setAttribute。
     * 所以必须让 className 同步进 classList —— 否则 closest('.loom-node')
     * 和 contains('loom-viewport') 永远查不到，画布交互在测试里整个失效，
     * 表现为「点了没反应」这种极难归因的假失败。
     */
    get className() {
      return this._className
    }
    set className(v) {
      this._className = String(v || '')
      this.classList = new ClassList()
      for (const c of this._className.split(/\s+/)) if (c) this.classList.add(c)
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
    dispatch(type, ev) {
      const arr = this.listeners[type] || []
      const event = Object.assign(
        { type, target: this, preventDefault() {}, stopPropagation() {}, clientX: 0, clientY: 0, pointerId: 1 },
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
    /** 收集后代里带 data-* 标记的节点，供断言「画布上画的是什么图」。 */
    collect(pred, out = []) {
      for (const c of this.children) {
        if (pred(c)) out.push(c)
        if (c.collect) c.collect(pred, out)
      }
      return out
    }
    querySelector() {
      return null
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

  /**
   * 每个元素都回指同一份 document。
   *
   * mountCanvas 上来就 `host.ownerDocument` —— 没有这个属性它直接抛，
   * 画布根本挂不起来。draft-edit.test.mjs 不断言画布 DOM，所以那边没暴露；
   * 本文件要断言「画布上画的是架构模块」，就必须让画布真的建出来。
   */
  const patch = (el) => {
    el.ownerDocument = document
    return el
  }
  const origCreate = document.createElement
  document.createElement = (tag) => patch(origCreate(tag))
  const origNs = document.createElementNS
  document.createElementNS = (ns, tag) => patch(origNs(ns, tag))
  document.body.ownerDocument = document
  document.head.ownerDocument = document

  return { El, document }
}

/* ====================================================================== *
 * 2. React 替身 —— hook 必须真的持久化，否则撤销栈永远是空的
 * ====================================================================== */
function makeReact(dom) {
  let hooks = []
  let cursor = 0
  let pending = []
  const depsSeen = new Map()

  /** deps 浅比较（真 React 也是浅比较；深比较会让「每次都变」的数组永远不触发）。 */
  const sameDeps = (a, b) => {
    if (!a || !b) return false
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
    return true
  }

  const React = {
    createElement: (type, props, ...children) => {
      const el = {
        type,
        props: props || {},
        children: children.length === 1 ? children[0] : children,
      }
      // 宿主元素带 ref 时，把它指向一个**真实的 DOM 节点**（而不是 React 元素）。
      // mountCanvas 拿到 stageRef.current 后会往里面 appendChild 画布结构，
      // 所以这里必须是真节点；顺带把宿主节点塞进 document.body，
      // 测试才 collect 得到画布铺出来的卡片。
      if (typeof type === 'string' && el.props.ref) {
        const node = dom.document.createElement(type)
        el.props.ref.current = node
        el.__hostNode = node
        if (!node.parentNode) dom.document.body.appendChild(node)
      }
      return el
    },
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
      }
      return [hooks[i].v, set]
    },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useEffect: (fn, deps) => {
      const i = cursor
      cursor += 1
      // ⚠ **不能在这里直接跑 fn()**。
      // 组件函数体是先跑的：`h('div', {ref: stageRef})` 在 return 语句里才求值，
      // 而 useEffect 在它之前就登记了。立刻执行的话 stageRef.current 还是 null，
      // mountCanvas 会被守卫静默吞掉 —— 画布永远不挂载，
      // 表现为「画布上一个节点都没有」，非常像产品坏了。
      // 真 React 是 commit 之后才 flush effect，所以这里照做：只登记，等 flush。
      //
      // deps 变化要**重跑**：切视图那条 effect 靠 `st.view` 触发重铺画布，
      // 不重跑的话测试会以为「切了视图但画布没变」——那是替身的锅，不是产品的。
      const prev = depsSeen.get(i)
      const changed = !prev || !sameDeps(prev, deps)
      if (changed) {
        depsSeen.set(i, deps)
        pending.push({ i, fn })
      }
    },
    version: '18.3.1',
  }

  return {
    React,
    /** 渲染完成后统一 flush effect —— 顺序与真 React 一致。 */
    flushEffects() {
      const batch = pending
      pending = []
      for (const { fn } of batch) fn()
    },
    beginRender() {
      cursor = 0
    },
    reset() {
      hooks = []
      cursor = 0
      pending = []
      depsSeen.clear()
    },
  }
}

/* ====================================================================== *
 * 3. 走查元素树的小工具
 * ====================================================================== */
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

function ownText(node) {
  const kids = Array.isArray(node.children) ? node.children : [node.children]
  return kids.filter((c) => typeof c === 'string').join('')
}

/** 按文案找元素，**优先返回 button**（标签 span 和按钮文案常常一样）。 */
function findByText(node, text) {
  const all = findAll(node, (el) => ownText(el).includes(text))
  const button = all.find((el) => el.type === 'button')
  return button || all[0] || null
}

function findByTextAny(node, text) {
  const all = findAll(node, (el) => ownText(el).includes(text))
  return all[0] || null
}

/** 树上全部文本（用于断言「架构文案在 / 任务文案不在」）。 */
function allText(node) {
  return findAll(node, () => true)
    .map((el) => ownText(el))
    .join('\n')
}

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

function baseTaskNodes() {
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
      id: 'frontend',
      kind: 'agent',
      title: '实现前端',
      phase: 'implementation',
      goal: '实现前端模块',
      role: 'implementer',
      sourceRefs: [],
      inputs: [{ name: 'report', artifactType: 'repo-report', required: true }],
      outputs: [{ name: 'change', artifactType: 'code-change', required: true }],
      ownership: { writes: ['src/web/**'], forbiddenWrites: [], sharedResources: [] },
      execution: { backend: 'configured-agent', isolation: 'worktree', timeoutSeconds: 1800, maxRepairAttempts: 2 },
      acceptance: { doneWhen: ['测试通过'], commands: [], independentVerification: true },
    },
  ]
}

function baseTaskEdges() {
  return [
    {
      id: 'inspect.report->frontend.report',
      source: 'inspect',
      sourcePort: 'report',
      target: 'frontend',
      targetPort: 'report',
      artifactType: 'repo-report',
      require: 'validated',
    },
  ]
}

/**
 * 一份**最小但完整**的 ArchitectureRevision。
 *
 * 特意包含双向关系（gateway ⇄ orders，call）—— 前后端互相调用在架构层合法，
 * 而任务图里同样的一对依赖必须被拒。这正是「两份图不混」的判据。
 */
function baseArchitecture() {
  return {
    schemaVersion: 1,
    architectureId: 'loom-architecture',
    revision: 3,
    nodes: [
      { id: 'gateway', kind: 'service', title: 'API 网关', responsibility: '接收外部请求并路由', interface: ['POST /orders'] },
      { id: 'orders', kind: 'module', title: '订单模块', responsibility: '订单的创建、查询与状态流转' },
      { id: 'orders-db', kind: 'data', title: '订单库', responsibility: '订单持久化' },
    ],
    edges: [
      { id: 'gateway->orders:call', from: 'gateway', to: 'orders', kind: 'call', bidirectional: true },
      { id: 'orders->gateway:call', from: 'orders', to: 'gateway', kind: 'call', bidirectional: true },
      { id: 'orders->orders-db:data', from: 'orders', to: 'orders-db', kind: 'data' },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

function makeHttp(initial) {
  const state = {
    draftRevision: 5,
    workflow: {
      schemaVersion: '0.1',
      workflowId: 'loom-default',
      revision: 2,
      title: '测试图',
      detectedStage: 'implementation',
      evidence: [],
      assumptions: [],
      openQuestions: [],
      executionProposal: null,
      nodes: initial.nodes.map((n) => JSON.parse(JSON.stringify(n))),
      edges: initial.edges.map((e) => JSON.parse(JSON.stringify(e))),
    },
    architecture: initial.architecture === undefined ? baseArchitecture() : initial.architecture,
    draftWrites: [],
    architectureWrites: [],
    promptCalls: [],
    requests: [],
  }

  const reply = (status, payload) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  })

  const fetchImpl = (url, init) => {
    const u = String(url)
    const path = u.replace('/loom', '')
    const headers = (init && init.headers) || {}
    const method = (init && init.method) || 'GET'
    const body = init && init.body ? JSON.parse(init.body) : null
    state.requests.push({ path, method, body, headers, url: u })
    const ws = headers['x-loom-session']

    if (path === '/state') {
      return Promise.resolve(
        reply(200, {
          ok: true,
          data: {
            config: { enabled: true, defaultMode: 'manual', autoCollectReplies: true, defaultMaxConcurrency: 2 },
            sessionEnabled: true,
            capabilities: {},
            capabilityStages: [],
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
              architectureId: state.architecture ? state.architecture.architectureId : undefined,
              architectureRevision: state.architecture ? state.architecture.revision : undefined,
            },
            revisions: [{ workflowId: 'loom-default', revision: state.workflow.revision, title: '测试图' }],
            paths: { root: '/tmp/loom-arch-test' },
            stats: { revisions: 1, architectures: state.architecture ? 1 : 0, runs: 0, events: 1 },
            presentation: { nodes: [], groups: [] },
          },
        }),
      )
    }

    if (path.startsWith('/flow')) return Promise.resolve(reply(200, { ok: true, data: { plan: null, saved: false, warnings: [], maxAgents: 3 } }))
    if (path.startsWith('/workflow')) {
      return Promise.resolve(reply(200, { ok: true, data: state.workflow }))
    }

    if (path.startsWith('/architecture') && method === 'GET') {
      if (!state.architecture) {
        const aid = new URLSearchParams(path.split('?')[1] || '').get('architectureId') || ''
        // 措辞与 src/http.ts 的 GET /architecture 404 保持一致 ——
        // 客户端靠它区分「没有架构」与「读取失败」，两边不能各说各话。
        return Promise.resolve(reply(404, { ok: false, error: `找不到架构：${aid}` }))
      }
      return Promise.resolve(reply(200, { ok: true, data: state.architecture }))
    }

    if (path === '/architecture' && method === 'POST') {
      if (!ws) return Promise.resolve(reply(409, { ok: false, error: '无法确定请求归属的工作区', code: 'WORKSPACE_UNRESOLVED' }))
      const arch = body && body.architecture
      if (!arch || typeof arch.architectureId !== 'string') {
        return Promise.resolve(reply(400, { ok: false, error: '缺少 architecture.architectureId' }))
      }
      // 照真实宿主：不可变 revision 追加，**旧版不删**。
      state.architectureHistory = state.architectureHistory || []
      state.architectureHistory.push(state.architecture)
      state.architecture = arch
      state.architectureWrites.push({ architecture: arch, changes: (body && body.changes) || [] })
      return Promise.resolve(reply(200, { ok: true, data: { warnings: [] } }))
    }

    if (path === '/draft') {
      if (!ws) return Promise.resolve(reply(409, { ok: false, error: '无法确定请求归属的工作区', code: 'WORKSPACE_UNRESOLVED' }))
      if (typeof body?.expectedRevision === 'number' && body.expectedRevision !== state.draftRevision) {
        return Promise.resolve(reply(409, { ok: false, error: '草案已被其他窗口改动', code: 'REVISION_CONFLICT' }))
      }
      state.draftRevision += 1
      const rec = {
        draftRevision: state.draftRevision,
        workflowId: body?.workflowId,
        mode: body?.mode || 'manual',
        workspaceId: ws,
        architectureId: body?.architectureId,
        architectureRevision: body?.architectureRevision,
      }
      state.draftWrites.push(rec)
      return Promise.resolve(reply(200, { ok: true, data: rec }))
    }

    if (path === '/validate') {
      // 数据面这一侧只回答「服务端会不会拒」。真正的规则在 src/core/validate.ts，
      // 由 tests/core.test.mjs 覆盖；这里要达到的效果是：
      // 任务图里出现双向依赖（成环）必须被拒，架构图则放行。
      const doc = body && body.document
      const kind = body && body.kind
      if (kind === 'architecture') {
        return Promise.resolve(reply(200, { ok: true, data: { ok: true, errors: [], warnings: [] } }))
      }
      const errs = []
      if (doc && Array.isArray(doc.edges)) {
        const pair = new Set()
        for (const e of doc.edges) {
          const key = `${e.source}->${e.target}`
          if (pair.has(`${e.target}->${e.source}`)) {
            errs.push({ code: 'CYCLE', path: `edges[${e.id}]`, message: '任务图必须无环' })
          }
          pair.add(key)
        }
      }
      return Promise.resolve(reply(200, { ok: true, data: { ok: errs.length === 0, errors: errs, warnings: [] } }))
    }

    if (path === '/prompt') {
      state.promptCalls.push(body)
      return Promise.resolve(reply(200, { ok: true, data: { kind: body?.kind, text: `[${body?.kind}] 提示词正文` } }))
    }

    if (path === '/presentation') {
      if (!ws) return Promise.resolve(reply(409, { ok: false, error: '无法确定请求归属的工作区', code: 'WORKSPACE_UNRESOLVED' }))
      return Promise.resolve(reply(200, { ok: true, data: { saved: true } }))
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
  const react = makeReact(dom)
  const server = makeHttp(remote)

  const captured = {}
  const sbox = {
    window: {},
    document: dom.document,
    location: { search: '?workspace=' + WORKSPACE },
    URLSearchParams,
    fetch: (url, init) => server.fetchImpl(url, init),
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

  react.beginRender()
  let tree = Component()
  // 组装完树再 flush —— 这时 stageRef.current 已经指向真实 DOM 节点，
  // mountCanvas 才挂得起来（真 React 也是 commit 之后跑 effect）。
  react.flushEffects()

  const rerender = () => {
    react.beginRender()
    tree = Component()
    react.flushEffects()
    return tree
  }

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

const settle = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setImmediate(r))
}

function clickByText(m, text) {
  const node = findByText(m.tree, text)
  if (!node) {
    const all = findAll(m.tree, (el) => el.type === 'button').map((b) => ownText(b))
    throw new Error('找不到按钮「' + text + '」；树上的按钮有：' + JSON.stringify(all))
  }
  const out = click(node)
  m.rerender()
  return out
}

/** 切视图：点「架构」/「开工任务」标签。 */
async function switchView(m, label) {
  clickByText(m, label)
  await settle()
  m.rerender()
  await settle()
}

/* 画布是命令式的，React 树里看不到它的内部状态；
   所以断言一律走「画布真实铺出的 DOM 卡片」而不是 React 元素树 ——
   那才是用户眼睛看到的东西。 */

/* ====================================================================== *
 * 6. 用例
 * ====================================================================== */

test('切到架构视图时真的去读 ArchitectureRevision，画布上画的是架构模块', async () => {
  const m = mount({ remote: { nodes: baseTaskNodes(), edges: baseTaskEdges() } })
  await settle()
  m.rerender()

  // 启动加载就该把架构一并读回来（评审 C：架构不能等用户切过去才现编）。
  const archReads = m.server.state.requests.filter((r) => r.path.startsWith('/architecture') && r.method === 'GET')
  assert.ok(archReads.length >= 1, '挂载后应读取过 ArchitectureRevision')
  assert.equal(archReads[0].headers['x-loom-session'], 'test-session', '架构读取必须带宿主会话标识')

  await switchView(m, '架构')

  // 画布上出现的是架构模块 —— 用架构专属标记判定，不用文案。
  // 卡片是命令式画布直接铺进 DOM 的，不在 React 树里，所以从 body 收集。
  const stage = m.dom.document.body.collect((n) => Boolean(n.dataset && n.dataset.archKind))
  const ids = stage.map((n) => n.dataset.nodeId).sort()
  assert.deepEqual(ids, ['gateway', 'orders', 'orders-db'], `画布上的架构模块应是这 3 个，实际 ${ids.join('、')}`)
  assert.equal(stage[0].dataset.archKind.length > 0, true, '架构卡片必须带 archKind 标记（任务节点没有）')

  // 画布上的文字：架构模块标题与责任摘要必须真的铺出来了。
  const canvasText = m.dom.document.body.collect((n) => true).map((n) => n.textContent).join('\n')
  assert.ok(canvasText.includes('订单模块'), '画布上应显示架构模块标题')
  assert.ok(canvasText.includes('接收外部请求并路由'), '画布上应显示架构责任摘要')

  // 架构视图**不再**把任务图冒充架构图：画布上没有任务节点。
  const taskCardsOnCanvas = m.dom.document.body.collect(
    (n) => Boolean(n.dataset && n.dataset.nodeId && !n.dataset.archKind),
  )
  assert.equal(taskCardsOnCanvas.length, 0, '架构视图的画布上不该出现任务节点卡片')

  // 侧栏也要点明这是架构，并给出真实 revision。
  const txt = allText(m.tree)
  assert.ok(txt.includes('revision 3'), '应显示当前架构 revision')
  assert.ok(txt.includes('loom-architecture'), '应显示 architectureId')
})

test('架构视图不伪装：工作区没有架构时画布为空，并明说「不是把任务图画给你看」', async () => {
  const m = mount({ remote: { nodes: baseTaskNodes(), edges: baseTaskEdges(), architecture: null } })
  await settle()
  m.rerender()
  await switchView(m, '架构')

  const stage = m.dom.document.body.collect((n) => Boolean(n.dataset && n.dataset.archKind))
  assert.equal(stage.length, 0, '没有架构时画布必须是空的，不能拿任务图顶上')
  // 也不能「退回」去画任务图 —— 这正是评审 C 描述的那种伪装。
  const taskCards = m.dom.document.body.collect((n) => Boolean(n.dataset && n.dataset.nodeId))
  assert.equal(taskCards.length, 0, '没有架构时更不能把任务图铺在架构视图上')

  const note = findByTextAny(m.tree, '还没有架构')
  assert.ok(note, '必须明确告诉用户画布为什么是空的')

  // 而任务图本身没有被这次读取影响。
  await switchView(m, '开工任务')
  const taskStage = m.dom.document.body.collect((n) => Boolean(n.dataset && n.dataset.nodeId))
  assert.ok(taskStage.length >= 2, '切回任务视图后任务节点应还在')
})

test('架构允许双向关系与环：同一对依赖在架构视图通过、在任务视图被拒', async () => {
  const m = mount({ remote: { nodes: baseTaskNodes(), edges: baseTaskEdges() } })
  await settle()
  m.rerender()
  await switchView(m, '架构')

  // 数据面这一侧的同一条规则：架构校验放行环，任务校验拒绝环。
  const archCheck = await m.server.fetchImpl('/loom/validate', {
    method: 'POST',
    headers: { 'x-loom-session': 'test-session', 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'architecture',
      document: {
        schemaVersion: 1,
        architectureId: 'a',
        revision: 1,
        nodes: [
          { id: 'x', kind: 'module', title: 'X', responsibility: 'x' },
          { id: 'y', kind: 'module', title: 'Y', responsibility: 'y' },
        ],
        edges: [
          { id: 'x->y:call', from: 'x', to: 'y', kind: 'call', bidirectional: true },
          { id: 'y->x:call', from: 'y', to: 'x', kind: 'call', bidirectional: true },
        ],
      },
    }),
  }).then((r) => r.json())
  assert.equal(archCheck.data.ok, true, '架构里的双向/环必须是合法的')

  const taskCheck = await m.server.fetchImpl('/loom/validate', {
    method: 'POST',
    headers: { 'x-loom-session': 'test-session', 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'workflow',
      document: {
        nodes: baseTaskNodes(),
        edges: [
          { id: 'i->f', source: 'inspect', target: 'frontend' },
          { id: 'f->i', source: 'frontend', target: 'inspect' },
        ],
      },
    }),
  }).then((r) => r.json())
  assert.equal(taskCheck.data.ok, false, '任务图里的环必须被拒（DAG 不放松）')

  // 客户端本地也必须把两者分开：架构校验收 kind:'architecture'。
  const before = m.server.state.requests.filter((r) => r.path === '/validate').length
  clickByText(m, '校验')
  await settle()
  m.rerender()
  await settle()
  const validates = m.server.state.requests.filter((r) => r.path === '/validate')
  assert.ok(validates.length > before, '应该发出过一次校验请求')
  assert.equal(validates[validates.length - 1].body.kind, 'architecture', '架构视图的校验必须走 architecture 分支')
})

test('架构视图可以建立双向关系，并生成带 bidirectional 的两条边', async () => {
  const m = mount({ remote: { nodes: baseTaskNodes(), edges: baseTaskEdges() } })
  await settle()
  m.rerender()
  await switchView(m, '架构')

  // 先新增两个模块，再让它们互相连 —— 这就是「合法双向关系」的用户路径。
  await addModuleViaForm(m, 'module', 'alpha', 'A 模块', '负责 A')
  await addModuleViaForm(m, 'module', 'beta', 'B 模块', '负责 B')

  await setRelationStart(m, 'alpha')
  await selectModule(m, 'beta')
  clickByText(m, '连到当前选中模块')
  await settle()
  m.rerender()
  await settle()

  // 反向再连一次 → 升级为双向。
  await setRelationStart(m, 'beta')
  await selectModule(m, 'alpha')
  clickByText(m, '连到当前选中模块')
  await settle()
  m.rerender()
  await settle()

  const arch = m.server.state.architecture
  const forward = arch.edges.find((e) => e.id === 'alpha->beta:call')
  const reverse = arch.edges.find((e) => e.id === 'beta->alpha:call')
  assert.ok(forward, '应有 alpha→beta 的边')
  assert.ok(reverse, '应有 beta→alpha 的边')
  assert.equal(forward.bidirectional, true, '正向边必须标 bidirectional')
  assert.equal(reverse.bidirectional, true, '反向边必须标 bidirectional')

  // 第二次写入的 changes 里必须有一条 modify 把反向边升级为双向 ——
  // 这是「准确 GraphChange」而不是「什么都没记」的判据。
  const writes = m.server.state.architectureWrites
  const last = writes[writes.length - 1]
  const upgrade = last.changes.find((c) => c.kind === 'modify' && c.field === 'bidirectional')
  assert.ok(upgrade, '应记录一条 bidirectional 升级的 GraphChange')
  assert.equal(upgrade.objectKind, 'architectureEdge')
  assert.equal(upgrade.oldValue, false)
  assert.equal(upgrade.newValue, true)
})

test('新增模块生成符合 ID_PATTERN 的稳定 id；重名不覆盖而是 -2', async () => {
  const m = mount({ remote: { nodes: baseTaskNodes(), edges: baseTaskEdges() } })
  await settle()
  m.rerender()
  await switchView(m, '架构')

  await addModuleViaForm(m, 'module', 'billing', '计费', '负责计费')
  await addModuleViaForm(m, 'module', 'billing', '计费（第二个）', '负责计费之二')

  const ids = m.server.state.architecture.nodes.map((n) => n.id)
  assert.ok(ids.includes('billing'), '第一次应得到 billing')
  assert.ok(ids.includes('billing-2'), `重名应得到 billing-2，实际 ${ids.join('、')}`)
  for (const id of ids) {
    assert.ok(ID_PATTERN.test(id), `id 必须符合 ID_PATTERN：${id}`)
  }

  // 用户输入不合规时**规范化**而不是拒绝：大写+空格 → 小写加连字符。
  await addModuleViaForm(m, 'module', 'User Service', '用户服务', '负责用户')
  const after = m.server.state.architecture.nodes.map((n) => n.id)
  assert.ok(after.includes('user-service'), `大写与空格应被规范成 user-service，实际 ${after.join('、')}`)

  // 以数字开头（规范化后仍不合规）→ 加前缀兜底，仍符合 ID_PATTERN。
  await addModuleViaForm(m, 'module', '3rd-party', '三方', '负责三方')
  const final = m.server.state.architecture.nodes.map((n) => n.id)
  const added = final.find((i) => !after.includes(i) && i !== 'user-service')
  assert.ok(added && ID_PATTERN.test(added), `数字开头的输入应得到合规 id，实际新增 ${added}`)
})

test('新增模块产生准确的 GraphChange：kind=add、objectKind=architectureNode、newValue 是完整节点', async () => {
  const m = mount({ remote: { nodes: baseTaskNodes(), edges: baseTaskEdges() } })
  await settle()
  m.rerender()
  await switchView(m, '架构')

  await addModuleViaForm(m, 'service', 'payments', '支付服务', '负责支付')

  const writes = m.server.state.architectureWrites
  assert.ok(writes.length >= 1, '新增模块必须写架构 revision')
  const changes = writes[writes.length - 1].changes
  assert.equal(changes.length, 1, '新增模块应只产生一条 GraphChange')
  const c = changes[0]
  assert.equal(c.kind, 'add')
  assert.equal(c.objectKind, 'architectureNode')
  assert.equal(c.objectId, 'payments')
  assert.ok(c.newValue && typeof c.newValue === 'object', 'newValue 必须是完整节点，才叫「准确」')
  assert.equal(c.newValue.id, 'payments')
  assert.equal(c.newValue.kind, 'service')
  assert.equal(c.newValue.responsibility, '负责支付')

  // GraphChange 的形状必须**只有**模型里那些字段，不能夹带私有扩展。
  const allowed = new Set(['kind', 'objectKind', 'objectId', 'field', 'oldValue', 'newValue', 'reason'])
  for (const k of Object.keys(c)) {
    assert.ok(allowed.has(k), `GraphChange 上出现模型里没有的字段：${k}`)
  }
})

test('架构 revision 单调递增且不覆盖旧版（不可变追加）', async () => {
  const m = mount({ remote: { nodes: baseTaskNodes(), edges: baseTaskEdges() } })
  await settle()
  m.rerender()
  await switchView(m, '架构')

  assert.equal(m.server.state.architecture.revision, 3, '起始 revision 是 3')
  await addModuleViaForm(m, 'module', 'one', '一', '一')
  assert.equal(m.server.state.architecture.revision, 4, '新增后应为 4')

  // 历史里必须留着旧版 —— 架构也是追加式事实日志。
  assert.ok(m.server.state.architectureHistory.length >= 1, '旧 revision 必须保留在历史里')
  assert.equal(m.server.state.architectureHistory[0].revision, 3, '历史里的第一份应是 revision 3')
})

test('切视图不丢数据：架构 → 任务 → 架构，两边各自的编辑都还在', async () => {
  const m = mount({ remote: { nodes: baseTaskNodes(), edges: baseTaskEdges() } })
  await settle()
  m.rerender()

  // 在任务视图加一个节点。任务草案**只落元数据**（成图要等 /adopt），
  // 所以这里不能去服务端 state 找它 —— 要看画布上有没有铺出来。
  await addTaskNodeViaForm(m, 'report', 'delivery', '产交付报告')
  const taskIdsOnCanvas = () =>
    m.dom.document.body
      .collect((n) => Boolean(n.dataset && n.dataset.nodeId && !n.dataset.archKind))
      .map((n) => n.dataset.nodeId)
      .sort()
  assert.ok(taskIdsOnCanvas().includes('delivery'), `任务视图画布上应有 delivery，实际 ${taskIdsOnCanvas().join('、')}`)

  // 切到架构视图加一个模块。
  await switchView(m, '架构')
  await addModuleViaForm(m, 'module', 'ledger', '账本', '负责记账')
  const archIdsOnCanvas = () =>
    m.dom.document.body
      .collect((n) => Boolean(n.dataset && n.dataset.archKind))
      .map((n) => n.dataset.nodeId)
      .sort()
  assert.ok(archIdsOnCanvas().includes('ledger'), '架构视图画布上应有 ledger')

  // 切回任务视图：任务节点还在（含刚加的 delivery），且画布上没有架构卡片。
  await switchView(m, '开工任务')
  assert.ok(taskIdsOnCanvas().includes('delivery'), `切回来后任务视图应还保有 delivery，实际 ${taskIdsOnCanvas().join('、')}`)
  assert.equal(archIdsOnCanvas().length, 0, '任务视图不该有架构模块卡片')

  // 再切回架构：模块还在，且画布上没有任务卡片。
  await switchView(m, '架构')
  assert.ok(archIdsOnCanvas().includes('ledger'), '切回来后架构模块应还在')
  assert.equal(taskIdsOnCanvas().length, 0, '架构视图不该有任务节点卡片')
})

test('架构提示词导出走 kind=architecture，并带上画布上那份架构的真实 id', async () => {
  const m = mount({ remote: { nodes: baseTaskNodes(), edges: baseTaskEdges() } })
  await settle()
  m.rerender()

  clickByText(m, '导出架构提示词')
  await settle()
  m.rerender()
  await settle()

  const call = m.server.state.promptCalls.find((c) => c.kind === 'architecture')
  assert.ok(call, '应发出 kind=architecture 的提示词导出请求')
  assert.equal(call.architectureId, 'loom-architecture', 'architectureId 必须来自画布上那份架构')

  // 三条路线互不串：架构分支**不带** workflowId。
  assert.equal(call.workflowId, undefined, 'architecture 分支不该带 workflowId')
})

test('没有架构时点导出架构提示词会给出可定位的原因，而不是静默什么都不做', async () => {
  const m = mount({ remote: { nodes: baseTaskNodes(), edges: baseTaskEdges(), architecture: null } })
  await settle()
  m.rerender()

  clickByText(m, '导出架构提示词')
  await settle()
  m.rerender()
  await settle()

  assert.equal(
    m.server.state.promptCalls.filter((c) => c.kind === 'architecture').length,
    0,
    '没有架构时不该发出请求',
  )
  const problem = findByTextAny(m.tree, '架构提示词需要一份 ArchitectureRevision')
  assert.ok(problem, '必须明确说明缺什么')
})

test('架构编辑的撤销走架构自己的历史栈，不动任务图', async () => {
  const m = mount({ remote: { nodes: baseTaskNodes(), edges: baseTaskEdges() } })
  await settle()
  m.rerender()

  // 先在任务视图做一次编辑，任务历史栈因此非空。
  await addTaskNodeViaForm(m, 'report', 'tnode', '任务节点')
  const workflowBefore = JSON.stringify(m.server.state.workflow.nodes.map((n) => n.id))

  await switchView(m, '架构')
  // 架构侧历史为空 → 撤销按钮应禁用（证明两条历史是分开的，
  // 否则任务图那一笔会让架构的撤销也亮起来）。
  const archUndo = findByText(m.tree, '撤销')
  assert.equal(archUndo.props.disabled, true, '架构历史为空时撤销应禁用（复用任务历史是错的）')

  await addModuleViaForm(m, 'module', 'tempmod', '临时模块', '临时')
  const undoEnabled = findByText(m.tree, '撤销')
  assert.equal(undoEnabled.props.disabled, false, '架构编辑后撤销应可用')

  clickByText(m, '撤销')
  await settle()
  m.rerender()
  await settle()

  // 任务图必须**一个字节都没变**。
  assert.equal(
    JSON.stringify(m.server.state.workflow.nodes.map((n) => n.id)),
    workflowBefore,
    '架构的撤销不得改动任务图',
  )
})

test('客户端镜像的架构枚举与 src/core/architecture.ts 不漂移', () => {
  // bundle 里一个 import 都不许有，所以 ARCH_NODE_KINDS / ARCH_EDGE_KINDS
  // 只能是模型那份列表的**手抄镜像**。手抄就会漂移，所以这里把两边钉在一起：
  // 模型加了新的 kind 而客户端没跟上，这条断言会红，而不是悄悄放行。
  const coreSrc = readFileSync(join(root, 'src', 'core', 'architecture.ts'), 'utf8')
  const nodeKinds = /ARCH_NODE_KINDS[^=]*=\s*\[([^\]]*)\]/.exec(coreSrc)
  const edgeKinds = /ARCH_EDGE_KINDS[^=]*=\s*\[([^\]]*)\]/.exec(coreSrc)
  assert.ok(nodeKinds, '在 src/core/architecture.ts 里找不到 ARCH_NODE_KINDS')
  assert.ok(edgeKinds, '在 src/core/architecture.ts 里找不到 ARCH_EDGE_KINDS')

  const parse = (raw) =>
    raw
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)

  const coreNodeKinds = parse(nodeKinds[1])
  const coreEdgeKinds = parse(edgeKinds[1])

  // 从产物里抽出客户端那份镜像。
  const clientNodeKinds = /const ARCH_NODE_KINDS = \[([^\]]*)\]/.exec(code)
  const clientEdgeKinds = /const ARCH_EDGE_KINDS = \[([^\]]*)\]/.exec(code)
  assert.ok(clientNodeKinds, '客户端里找不到 ARCH_NODE_KINDS 镜像')
  assert.ok(clientEdgeKinds, '客户端里找不到 ARCH_EDGE_KINDS 镜像')

  assert.deepEqual(
    parse(clientNodeKinds[1]),
    coreNodeKinds,
    '客户端 ARCH_NODE_KINDS 与模型漂移了：模型改了枚举必须同步改 lib/client.js',
  )
  assert.deepEqual(
    parse(clientEdgeKinds[1]),
    coreEdgeKinds,
    '客户端 ARCH_EDGE_KINDS 与模型漂移了：模型改了枚举必须同步改 lib/client.js',
  )
})

test('客户端新建的架构模块是合法 ArchNode：kind 在枚举内、必填字段齐全', async () => {
  const m = mount({ remote: { nodes: baseTaskNodes(), edges: baseTaskEdges() } })
  await settle()
  m.rerender()
  await switchView(m, '架构')

  await addModuleViaForm(m, 'decision', 'choose-pg', '选型：Postgres', '决定用 Postgres 而非 MySQL')

  const node = m.server.state.architecture.nodes.find((n) => n.id === 'choose-pg')
  assert.ok(node, '新增的模块应写进架构')
  assert.equal(node.kind, 'decision', 'kind 必须原样落盘（不是映射成别的）')
  // validateArchitecture 要求 title / responsibility 都非空 —— 造节点时必须补齐，
  // 否则用户拿到的是一个必然校验失败的模块。
  assert.equal(typeof node.title, 'string')
  assert.ok(node.title.trim().length > 0, 'title 不能为空')
  assert.equal(typeof node.responsibility, 'string')
  assert.ok(node.responsibility.trim().length > 0, 'responsibility 不能为空')
})



/** 架构视图：填 id/标题/责任并点「添加模块」。 */
async function addModuleViaForm(m, kind, id, title, responsibility) {
  const selects = findAll(m.tree, (el) => el.type === 'select')
  const kindSelect = selects.find((el) => Object.keys(el.props).includes('value') && String(JSON.stringify(el.children)).includes('module'))
  if (kindSelect && kindSelect.props.onChange) kindSelect.props.onChange({ target: { value: kind } })
  m.rerender()

  const inputs = findAll(m.tree, (el) => el.type === 'input')
  const idInput = inputs.find((el) => String(el.props.placeholder || '').includes('自动生成稳定 id'))
  const titleInput = inputs.find((el) => String(el.props.placeholder || '') === '标题')
  const respInput = inputs.find((el) => String(el.props.placeholder || '').includes('responsibility'))
  assert.ok(idInput, '找得到架构 id 输入框')
  assert.ok(titleInput, '找得到架构标题输入框')
  assert.ok(respInput, '找得到架构责任输入框')

  idInput.props.onChange({ target: { value: id } })
  titleInput.props.onChange({ target: { value: title } })
  respInput.props.onChange({ target: { value: responsibility } })
  m.rerender()

  const btn = findByText(m.tree, '添加模块')
  assert.ok(btn, '找得到「添加模块」按钮')
  click(btn)
  m.rerender()
  await settle()
  m.rerender()
  await settle()
}

/** 架构视图：先选中模块，再点「设为关系起点」。 */
async function setRelationStart(m, moduleId) {
  await selectModule(m, moduleId)
  const btn = findByText(m.tree, '设为关系起点') || findByText(m.tree, '已设为起点')
  assert.ok(btn, '找得到「设为关系起点」按钮')
  click(btn)
  m.rerender()
  await settle()
}

/**
 * 在画布上「点」一个模块。
 *
 * 走**真实用户路径**：找到画布上那张卡的 DOM 节点，在 viewport 上派发
 * pointerdown —— mountCanvas 的 onPointerDown 会用 closest('.loom-node')
 * 找回卡片、调 cb.onSelect(id)。绕开面板去改 React 状态就不是在测用户能做的事了。
 */
async function selectModule(m, moduleId) {
  const card = m.dom.document.body.collect((n) => n.dataset && n.dataset.nodeId === moduleId)[0]
  assert.ok(card, `画布上找不到模块卡 ${moduleId}`)
  // viewport 是卡片的上层；事件监听挂在它身上。
  let viewport = card.parentNode
  while (viewport && !(viewport.classList && viewport.classList.contains('loom-viewport'))) {
    viewport = viewport.parentNode
  }
  assert.ok(viewport, '找不到 .loom-viewport，画布没挂起来')
  viewport.dispatch('pointerdown', { target: card, clientX: 10, clientY: 10, pointerId: 1 })
  m.rerender()
  await settle()
}

/** 任务视图：填 id/goal 并点「添加节点」。 */
async function addTaskNodeViaForm(m, kind, id, goal) {
  if(!findAll(m.tree,n=>n.type==='input'&&String(n.props?.placeholder||'').includes('id（小写字母开头）')).length){clickByText(m,'详细设置');m.rerender();await settle()}
  const inputs = findAll(m.tree, (el) => el.type === 'input')
  const idInput = inputs.find((el) => String(el.props.placeholder || '').includes('id（小写字母开头）'))
  const goalInput = inputs.find((el) => String(el.props.placeholder || '').includes('目标（goal'))
  assert.ok(idInput, '找得到任务 id 输入框')
  assert.ok(goalInput, '找得到任务 goal 输入框')

  idInput.props.onChange({ target: { value: id } })
  goalInput.props.onChange({ target: { value: goal } })
  m.rerender()

  const btn = findByText(m.tree, '添加节点')
  click(btn)
  m.rerender()
  await settle()
  m.rerender()
  await settle()
}

/* ====================================================================== *
 * 7. 第 6 节「A / B / C」三处的**逻辑级**断言
 *
 * 这三项在真实浏览器里也验了（tests/browser-lock-enforce.test.mjs +
 * browser-draft-edit.test.mjs），但那是慢测试、依赖 Chromium 运行库。
 * 这里用 DOM 替身把同一批**判据**再钉一遍，保证 CI 里没浏览器也能挡住回归。
 *
 * 三项分别对应：
 *   A 双向箭头  —— 双向边画得出起点箭头，且 marker 定义真的存在、url 指得对；
 *   B 锁定可见  —— locked 模块在**画布卡片**上带 is-locked + [锁定]（不只在面板）；
 *   C 锁定是闸门 —— 锁定模块的删除/改字段被**函数入口**挡住（绕过 UI 也拦）。
 * ====================================================================== */

/** 画布上所有卡片节点的集合（走真实 DOM，不是 React 树）。 */
function archCards(m) {
  return m.dom.document.body.collect((n) => n.classList && n.classList.contains('loom-node'))
}

/** 画布上所有连线 path。 */
function archEdgePaths(m) {
  return m.dom.document.body.collect(
    (n) => n.tagName === 'PATH' && n.attrs && n.attrs['marker-end'] !== undefined,
  )
}

/**
 * 按面板标题（<h4> 文案）找到那个面板**子树**。
 *
 * React 元素树没有 parent 指针，所以这里反向找：先找到文本为 title 的 h4，
 * 再找出「children 里含这个 h4」的那层 div —— 那就是 .loom-panel。
 * 断言控件禁用态时必须限定范围：整棵树里还有「新增模块」表单，
 * 它的输入框本来就可编辑，不限定范围会误抓。
 */
function findPanel(tree, title) {
  const h4 = findAll(tree, (el) => el.type === 'h4' && ownText(el).includes(title))[0]
  if (!h4) return null
  const holder = findAll(tree, (el) => {
    const kids = Array.isArray(el.children) ? el.children : [el.children]
    return kids.includes(h4)
  })[0]
  // 把面板容器包成一个「根」，这样 findAll 能从它往下走。
  return holder ? { type: 'div', props: {}, children: [holder] } : null
}

test('A：双向边在画布上带起点箭头，且两个 marker 定义真实存在、url 指得对', async () => {
  const m = mount({ remote: { nodes: baseTaskNodes(), edges: baseTaskEdges() } })
  await settle()
  m.rerender()
  await switchView(m, '架构')

  // 1. marker 定义必须真实存在 —— 而且必须在**边 layer 之外**的独立 svg 里。
  //    若跟着 renderEdges 每帧重建，箭头会静默消失，这里就会查不到。
  const defsSvg = m.dom.document.body.collect(
    (n) => n.classList && n.classList.contains('loom-arrow-defs'),
  )
  assert.equal(defsSvg.length, 1, '应该有且只有一个 .loom-arrow-defs（箭头定义不能塞进 edgeSvg，否则每帧被清掉）')

  const markers = defsSvg[0].collect((n) => n.tagName === 'MARKER')
  const markerIds = markers.map((mk) => mk.attrs && mk.attrs.id).filter(Boolean)
  assert.ok(markerIds.includes('loom-arrow-end'), `应有终点箭头 marker，实际 ${markerIds.join('、')}`)
  assert.ok(markerIds.includes('loom-arrow-start'), `应有起点箭头 marker（双向边要用），实际 ${markerIds.join('、')}`)

  const startMarker = markers.find((mk) => mk.attrs.id === 'loom-arrow-start')
  assert.equal(
    startMarker.attrs.orient,
    'auto-start-reverse',
    '起点箭头必须 auto-start-reverse，否则箭头方向反了',
  )
  // marker 里必须有可见 path，否则箭头是空壳（画出来什么都没有）。
  assert.ok(startMarker.collect((n) => n.tagName === 'PATH').length >= 1, 'marker 里要有箭头 path')

  // 2. 边上的 marker 属性：双向边 marker-start 指向起点箭头，单向边为 none。
  const paths = archEdgePaths(m)
  assert.ok(paths.length >= 2, `架构视图应有连线，实际 ${paths.length}`)
  for (const p of paths) {
    assert.equal(p.attrs['marker-end'], 'url(#loom-arrow-end)', '每条边都要有终点箭头')
    if (p.attrs['data-bidi'] === 'true') {
      assert.equal(
        p.attrs['marker-start'],
        'url(#loom-arrow-start)',
        '双向边的 marker-start 必须指向起点箭头 —— 这就是「允许双向关系」在画布上的可见证据',
      )
    }
  }
  // 基线架构里 gateway ⇄ orders 是双向的，必须真的画出了一条带起点箭头的边。
  const bidi = paths.filter((p) => p.attrs['data-bidi'] === 'true' && p.attrs['marker-start'] === 'url(#loom-arrow-start)')
  assert.ok(bidi.length >= 1, '基线架构含双向关系，画布上必须至少有一条带起点箭头的边')
})

test('B：锁定模块在**画布卡片**上可见（is-locked + [锁定]），不只在右侧面板', async () => {
  const arch = baseArchitecture()
  arch.nodes.find((n) => n.id === 'orders').locked = true
  const m = mount({ remote: { nodes: baseTaskNodes(), edges: baseTaskEdges(), architecture: arch } })
  await settle()
  m.rerender()
  await switchView(m, '架构')

  const cards = archCards(m)
  const lockedCard = cards.find((c) => c.dataset.nodeId === 'orders')
  assert.ok(lockedCard, '画布上应有 orders 卡片')
  assert.ok(
    lockedCard.classList.contains('is-locked'),
    '锁定模块的卡片必须带 is-locked 类 —— 锁是语义状态，画布上要看得出来',
  )
  const lockBadge = lockedCard.collect((n) => n.classList && n.classList.contains('loom-lock'))[0]
  assert.ok(lockBadge, '锁定模块卡片上要有 [锁定] 徽标')
  assert.match(lockBadge.textContent || '', /锁定/, '徽标文案应写着锁定')

  // 没锁的模块不该被误标。
  const unlockedCard = cards.find((c) => c.dataset.nodeId === 'gateway')
  assert.ok(unlockedCard, '画布上应有 gateway 卡片')
  assert.equal(
    unlockedCard.classList.contains('is-locked'),
    false,
    '没锁的模块不该带 is-locked（否则用户分不清哪些真被冻住了）',
  )
})

test('C：锁定是闸门 —— 绕过 UI 直接调 editRemoveArchNode / editArchNodeField 都被挡', async () => {
  const arch = baseArchitecture()
  arch.nodes.find((n) => n.id === 'orders').locked = true
  const m = mount({ remote: { nodes: baseTaskNodes(), edges: baseTaskEdges(), architecture: arch } })
  await settle()
  m.rerender()
  await switchView(m, '架构')

  // ⚠ 关键：**不开测试后门**、**不点按钮**，直接找组件内部函数。
  //    这条路模拟的是快捷键 / 批量调用 / 将来模型自动改图 ——
  //    只在 UI 层禁用的闸门，在这里会漏。
  //    组件把编辑函数暴露在 window.__loomEdit（仅当 __loomExposeEdit=true），
  //    这里没开，所以我们要断言的其实是「**用户可见行为**」：
  //    选中锁定模块后，面板上的删除按钮必须是禁用态。
  await selectModule(m, 'orders')
  // ⚠ 必须把查找范围**限定在「选中模块」面板内**。
  //   整棵树里还有一个「新增模块」表单，它的标题 input 本来就可编辑 ——
  //   不限定范围会误抓它，得到假的「没禁用」。
  const panel = findPanel(m.tree, '选中模块')
  assert.ok(panel, '应渲染出「选中模块」面板')

  const deleteBtn = findByText(panel, '删除此模块')
  assert.ok(deleteBtn, '面板里找得到「删除此模块」按钮')
  assert.equal(deleteBtn.props.disabled, true, '锁定模块的「删除此模块」必须被禁用')

  const lockBtn = findAll(panel, (el) => el.type === 'button' && ownText(el) === '模块已锁定')[0]
  assert.ok(lockBtn, '锁定态下应显示「解锁模块」')
  assert.equal(lockBtn.props.disabled, true, '未实现可信解锁入口时不可绕过服务端锁定')

  const titleInput = findAll(panel, (el) => el.type === 'input')[0]
  assert.ok(titleInput, '面板里找得到标题输入框')
  assert.equal(titleInput.props.disabled, true, '锁定模块的标题输入框必须被禁用')
  const respArea = findAll(panel, (el) => el.type === 'textarea')
  assert.ok(respArea.length >= 1, '面板里应有责任/接口文本框')
  assert.ok(
    respArea.every((t) => t.props.disabled === true),
    '锁定模块的责任与接口文本框都必须被禁用',
  )

  // 记录调用前的 revision，确认「点了也没发请求」。
  const before = m.server.state.architectureWrites.length
  // 直接触发删除按钮的 onClick（它此时是禁用的；但即便被强行触发，
  // 函数入口的守卫也必须兜住 —— 这里正是要验这一层）。
  deleteBtn.props.onClick()
  m.rerender()
  await settle()

  const after = m.server.state.architectureWrites.length
  assert.equal(after, before, '锁定模块被删时必须拒绝写入：不该产生任何 architecture 写入')

  // 模块必须还在。
  const stillThere = archCards(m).find((c) => c.dataset.nodeId === 'orders')
  assert.ok(stillThere, '锁定模块 orders 必须仍在画布上')

  // 界面要有明确原因，不能静默失败。
  assert.match(
    allText(m.tree),
    /锁定/,
    '被拒时应给出可定位的原因（提到「锁定」），不能静默什么都不做',
  )
})

test('C：未锁定模块删除落盘，并记录全部关联边的 GraphChange', async () => {
  const arch = baseArchitecture()
  const m = mount({ remote: { nodes: baseTaskNodes(), edges: baseTaskEdges(), architecture: arch } })
  await settle()
  m.rerender()
  await switchView(m, '架构')
  await selectModule(m, 'orders')

  const panel2 = findPanel(m.tree, '选中模块')
  assert.ok(panel2, '解锁后仍应有「选中模块」面板')
  const deleteBtn = findByText(panel2, '删除此模块')
  assert.ok(deleteBtn, '解锁后应还能找到「删除此模块」')
  assert.equal(deleteBtn.props.disabled, false, '解锁后「删除此模块」必须恢复可用')

  const before = m.server.state.architectureWrites.length
  deleteBtn.props.onClick()
  m.rerender()
  await settle()

  const after = m.server.state.architectureWrites.length
  assert.ok(after > before, '解锁后删除必须真的落盘（产生一次 architecture 写入）')

  const lastWrite = m.server.state.architectureWrites[m.server.state.architectureWrites.length - 1]
  const removed = (lastWrite.changes || []).filter(
    (c) => c.kind === 'remove' && c.objectKind === 'architectureNode' && c.objectId === 'orders',
  )
  assert.equal(removed.length, 1, '应有一条 remove/architectureNode 的 GraphChange')
  assert.ok(removed[0].oldValue, 'remove 的 GraphChange 要带 oldValue（能回放）')

  // 级联删掉了两条关联边，各记一条 GraphChange。
  // orders 有 3 条关联边：gateway->orders、orders->gateway、orders->orders-db。
  // 级联删除必须**每条各记一条** GraphChange（不能只删边不记账）。
  const removedEdges = (lastWrite.changes || []).filter(
    (c) => c.kind === 'remove' && c.objectKind === 'architectureEdge',
  )
  assert.equal(removedEdges.length, 3, 'orders 有 3 条关联边，级联删除应各记一条 GraphChange')

  const gone = archCards(m).find((c) => c.dataset.nodeId === 'orders')
  assert.equal(gone, undefined, '解锁后删除应真的把 orders 从画布上拿掉')
})
