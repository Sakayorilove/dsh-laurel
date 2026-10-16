/**
 * 真实浏览器验证的共用壳：页面骨架 + 挂载逻辑。
 *
 * 抽出来是为了让测试和一次性探针不会各写一份、然后慢慢不一致。
 *
 * ⚠ 这个壳里包含一个**极简 React 替身**。它不是「差不多就行」——
 * 替身和真 React 在语义上不一致的地方，会直接变成假失败/假通过。
 * 踩过的三个坑（都真的把测试跑红过）：
 *
 *   1. useEffect 必须**按依赖数组重跑**。
 *      最初写成「每个 hook 位只跑一次」，于是 `useEffect(syncGraph, [st.workflow])`
 *      在 st.workflow 还是 null 时跑了一次就再也不跑 → 画布永远 0 个节点。
 *      症状看起来像是产品渲染坏了，其实是替身太笨。
 *
 *   2. SVG 子树必须用 createElementNS 建。
 *      `<svg>` 下的 `<path>` 若用 createElement('path') 建，浏览器会当成
 *      HTMLUnknownElement，`document.querySelectorAll('.loom-edges path')` 直接查不到。
 *
 *   3. useCallback 必须真记忆化。
 *      `useCallback(fn, deps)` 每次渲染返回新函数，会让下游
 *      `useEffect(..., [callback])` 每帧都重跑。这里按依赖数组记忆化。
 */
export function shellHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Loom 步骤3 浏览器验证</title>
<style>html,body{margin:0;height:100%;background:#1b1e23;color:#e6e6e6;font-family:system-ui,sans-serif}
#root{height:100%;overflow:auto;padding:12px}</style>
</head><body>
<div id="root"></div>
<script>
/* ============ 极简 React（真 hook 语义，够跑这个组件） ============ */
(function () {
  let hooks = [], cursor = 0, rootEl = null, Comp = null, dirty = false
  /** 本轮渲染登记的 effect，commit 之后 flush —— 见 useEffect 里的说明。 */
  let pendingEffects = []
  const SVG_NS = 'http://www.w3.org/2000/svg'
  const SVG_TAGS = new Set(['svg','path','rect','circle','line','polyline','polygon','g','text','tspan','defs','marker','use','ellipse','clipPath','mask','pattern','linearGradient','radialGradient','stop'])
  function scheduleRender() {
    if (dirty) return
    dirty = true
    Promise.resolve().then(() => { dirty = false; doRender() })
  }
  /**
   * 渲染/提交轨迹。默认关，测试里 window.__loomTrace = [] 打开。
   *
   * 为什么内置而不是靠探针临时注入：注入式埋点要靠字符串替换改 harness，
   * 替换点一漂移就把 harness 改坏（踩过 —— 报「reconcile 不是函数」这种
   * 莫名其妙的错）。埋点写在这里，替换不进来，永远准。
   */
  function trace(at) {
    const t = window.__loomTrace
    if (!t) return
    t.push({
      at,
      vps: document.querySelectorAll('.loom-viewport').length,
      nodes: document.querySelectorAll('.loom-node').length,
      eff: pendingEffects.length,
    })
  }
  function doRender() {
    cursor = 0
    pendingEffects = []
    trace('render:start')
    // ⚠ 这里**不能** rootEl.innerHTML = '' 再重铺。
    // 真 React 会复用同一批 DOM 节点；整棵重建会让
    // mountCanvas 挂进 stageRef 的子节点在被清空时连带销毁
    // ——画布每帧被重建，表现出来就是「节点永远 0 个」。
    // 所以走一个按位置复用的最小 reconciler。
    reconcile(rootEl, [Comp()], null)
    trace('render:committed')
    // commit 之后才跑 effect —— 这时 ref.current 已指向真实 DOM 节点。
    const batch = pendingEffects
    pendingEffects = []
    for (const { i, fn } of batch) {
      const prev = hooks[i]
      if (prev && typeof prev.cleanup === 'function') {
        try { prev.cleanup() } catch (e) { console.error('effect cleanup', e) }
      }
      try {
        const c = fn()
        if (typeof c === 'function') hooks[i].cleanup = c
      } catch (e) { console.error('effect', e) }
    }
    trace('effects:done')
  }

  /**
   * 最小 reconciler。
   *
   * ── 为什么不能简单按「第 i 个托管子节点」对齐 ─────────────────────────
   * 组件里到处是「cond ? h(...) : null」（problem/notice/各类面板）。
   * 这些 null 一旦出现或消失，**后面所有子节点的下标都会平移**，
   * 于是 .loom-main 拿到的是上一次的 .loom-bar，类型不匹配 →
   * 整棵重建 → 挂在 stage 里的画布被连带销毁。
   * 表现出来就是「画布节点永远是 0 个」，非常像产品渲染坏了。
   *
   * 用真正的 key-based diff 才对：把每个元素按「组件路径 + 顺序」当 key 存，
   * 重渲染时按 key 找旧节点，找不到才新建。null 只是不渲染，不占位。
   *
   * ── 手工节点怎么办 ────────────────────────────────────────────────
   * 只处理带 __loomManaged 的节点；mountCanvas 塞进 stage 的那些
   * （viewport/world/svg/nodes…）没有这个标记，永远不被触碰 ——
   * 和真 React 一样，它不认识的手工 DOM 不会去动。
   */
  function reconcile(parent, children, ns) {
    // 1) 展开成扁平列表，同时给每个位置算一个**稳定**的 key。
    //
    //    key 只由「组件层级路径 + 在该层数组里的下标」组成，
    //    **绝不能用「已展开元素的累计个数」**。
    //    踩过的坑：早先用 flat.length 当序号，结果一个条件段落出现时
    //    后面所有 key 全部平移 → 全部当成新节点重建 →
    //    .loom-main 被判定该删 → 挂在 stage 里的画布被连带销毁。
    //    症状是「一通交互画布就空了」，看起来像产品渲染坏了。
    //
    //    这里对「非数组子节点」用一份逐层递增的位置号，且**不跳过 null**：
    //    null 占位，所以前面多一个条件节点不会影响后面的编号。
    const flat = []
    const walk = (c, path) => {
      if (Array.isArray(c)) {
        c.forEach((x, i) => walk(x, path + ':' + i))
        return
      }
      if (c === null || c === undefined || c === false || c === true) return
      if (typeof c === 'object' && typeof c.type === 'function') {
        const out = c.type(Object.assign({}, c.props, { children: c.children }))
        // 函数组件可能返回一个数组（Fragment 风格）。展开时给每个成员编号，
        // 否则它们会抢同一个 key，复用时张冠李戴。
        walk(out, path + '@')
        return
      }
      flat.push({ child: c, key: path })
    }
    // 同一父节点下，用「在原始 children 数组里的下标」当路径尾号。
    // null 也占位，所以前面多一个条件节点不会让后面的编号漂移 ——
    // 这正是旧实现（累计计数器）错的地方。
    const walkChildren = (list, prefix) => {
      list.forEach((c, idx) => walk(c, prefix + '/' + idx))
    }
    walkChildren(Array.isArray(children) ? children : [children], '$')

    // 2) 把父节点已有的托管子节点按 key 建索引。
    //    没有 key 的（上一版遗留）进 orphan，最后清掉。
    const byKey = new Map()
    const orphans = []
    for (const n of parent.childNodes) {
      if (!n.__loomManaged) continue
      if (n.__loomKey) byKey.set(n.__loomKey, n)
      else orphans.push(n)
    }

    // 3) 逐位置保证节点存在（复用旧节点或新建），再统一按声明顺序重排。
    for (const { child, key } of flat) {
      const prev = byKey.get(key) || null
      const node = typeof child !== 'object'
        ? reconcileText(parent, prev, String(child))
        : reconcileElement(parent, prev, child, ns, key)
      if (!node) continue
      node.__loomKey = key
      node.__loomManaged = true
      byKey.set(key, node)
    }

    // 重排：幂等，已经有序时不动 DOM（否则每帧抖动会让命中测试不稳）。
    let cursor = null
    for (const { key } of flat) {
      const node = byKey.get(key)
      if (!node) continue
      if (cursor === null) {
        if (parent.firstChild !== node) parent.insertBefore(node, parent.firstChild)
      } else if (cursor.nextSibling !== node) {
        parent.insertBefore(node, cursor.nextSibling)
      }
      cursor = node
    }

    // 4) 清掉本轮没出现的托管节点 —— 手工节点（无 __loomManaged）不在名单里。
    const keep = new Set(flat.map((f) => f.key))
    for (const [k, dead] of byKey) {
      if (!keep.has(k)) {
        trace('garbage:' + (dead.className || dead.nodeName))
        dead.remove()
      }
    }
    for (const dead of orphans) {
      trace('orphan:' + (dead.className || dead.nodeName))
      dead.remove()
    }
  }

  function reconcileText(parent, prev, text) {
    if (prev && prev.nodeType === Node.TEXT_NODE) {
      if (prev.data !== text) prev.data = text
      return prev
    }
    const t = document.createTextNode(text)
    if (prev && prev.parentNode === parent) { parent.insertBefore(t, prev); prev.remove() }
    else parent.appendChild(t)
    return t
  }

  function reconcileElement(parent, prev, node, ns, key) {
    const p = node.props || {}
    const tag = String(node.type)
    const useNs = ns === SVG_NS || SVG_TAGS.has(tag)
    let el = prev
    const sameType = el && el.nodeType === 1 &&
      (useNs ? el.namespaceURI === SVG_NS && el.localName === tag : el.tagName === tag.toUpperCase())
    if (!sameType) {
      el = useNs ? document.createElementNS(SVG_NS, tag) : document.createElement(tag)
      if (prev && prev.parentNode === parent) { parent.insertBefore(el, prev); prev.remove() }
      else parent.appendChild(el)
    }
    el.__loomManaged = true
    el.__loomKey = key
    applyProps(el, p)
    reconcile(el, Array.isArray(node.children) ? node.children : [node.children], useNs ? SVG_NS : ns)
    return el
  }

  /**
   * 把 props 落到元素上。
   *
   * 事件监听器**每次渲染都重新挂**（先摘旧的），否则闭包会一直指向上一次的
   * state，点按钮像点了旧版本 —— 这类 bug 在真 React 里靠合成事件避免，
   * 替身里只能每次换新。
   */
  /**
   * React 的 onChange 到底映射到哪个 DOM 事件 —— 替身里最容易搞错的一处。
   *
   * React **不是**把 onChange 直接挂到 DOM 的 change 上。它在文本类
   * 输入（input / textarea / select）上模拟成 input，因为 DOM 的
   * change 只在失焦/回车时才发 —— 真 React 是**每次按键**都回调。
   *
   * 早先替身一概用 k.slice(2).toLowerCase()，于是 onChange 挂到了
   * change。后果很隐蔽：探针用真实 input 事件注入值时，DOM 上的
   * value 确实变了（探针会以为成功），但组件的 onChange 根本没被调用，
   * st.newNode.id 一直是空 ——「新增节点」于是回落到自动 id，用例
   * 断言 id 应该是 persist-node 就挂了，而看代码完全看不出问题。
   *
   * 这里按真 React 的规则映射：文本类 → input；复选框/单选 → click
   * （真 React 也是用 click 归一 change）；其余保持同名小写。
   */  function domEventFor(el, key) {
    const name = key.slice(2).toLowerCase()
    if (name !== 'change') return name
    const tag = (el.tagName || '').toUpperCase()
    const type = String(el.type || '').toLowerCase()
    if (tag === 'SELECT') return 'change'
    if (tag === 'INPUT' && (type === 'checkbox' || type === 'radio' || type === 'file')) return 'click'
    if (tag === 'INPUT' || tag === 'TEXTAREA') return 'input'
    return 'change'
  }

  function applyProps(el, p) {
    const prevProps = el.__loomProps || {}
    for (const k of Object.keys(prevProps)) {
      if (k === 'children' || k === 'key' || k === 'ref' || k === 'style') continue
      if (k.startsWith('on') && typeof prevProps[k] === 'function') {
        el.removeEventListener(domEventFor(el, k), prevProps[k])
      } else if (!(k in p)) {
        if(k==='className')el.removeAttribute('class')
        else if(k==='disabled'||k==='checked')el[k]=false
        else el.removeAttribute(k)
      }
    }
    for (const k of Object.keys(p)) {
      const v = p[k]
      if (k === 'children' || k === 'key') continue
      if (k === 'ref') {
        if (typeof v === 'function') v(el)
        else if (v && typeof v === 'object') v.current = el
        continue
      }
      if (k === 'style' && v && typeof v === 'object') {
        for (const s of Object.keys(v)) { try { el.style[s] = v[s] } catch (e) { /* 有的属性名要驼峰 */ } }
        continue
      }
      if (k === 'className') { el.setAttribute('class', v == null ? '' : v); continue }
      if (k === 'value') {
        // 受控输入：只在用户没在打字时覆盖，否则光标会跳。
        if (document.activeElement !== el) el.value = v == null ? '' : v
        continue
      }
      if (k === 'checked') { el.checked = !!v; continue }
      if (k === 'dangerouslySetInnerHTML') continue
      if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(domEventFor(el, k), v)
        continue
      }
      if (typeof v === 'boolean') { if (v) el.setAttribute(k, ''); else el.removeAttribute(k); continue }
      if (v === null || v === undefined) { el.removeAttribute(k); continue }
      el.setAttribute(k, String(v))
      if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && document.activeElement !== el) el.value = String(v)
      if (el.tagName === 'SELECT') el.value = String(v)
    }
    el.__loomProps = p
  }
  /* 依赖数组比较：undefined = 每次都跑；[] = 只跑一次。 */
  function depsChanged(prev, next) {
    // prev/next 都是**原始依赖数组**，不是 hook 槽。
    // ⚠ 早先这里传的是 hook 槽对象，prev.length 恒为 undefined，
    // 于是空依赖数组每次都判成「变了」→ 挂载 effect 反复 cleanup，
    // 把画布 destroy 掉又不再挂回来。症状是「一交互画布就空」。
    if (!prev) return true
    if (!next) return true
    if (prev.length !== next.length) return true
    for (let i = 0; i < next.length; i += 1) if (!Object.is(prev[i], next[i])) return true
    return false
  }
  const REACT = {
    createElement: (type, props, ...children) =>
      ({ type, props: props || {}, children: children.length === 1 ? children[0] : children }),
    Fragment: Symbol.for('react.fragment'),
    useRef: (init) => { const i = cursor++; if (!hooks[i]) hooks[i] = { current: init }; return hooks[i] },
    useState: (init) => {
      const i = cursor++
      if (!hooks[i]) hooks[i] = { v: typeof init === 'function' ? init() : init }
      return [hooks[i].v, (next) => {
        const v = typeof next === 'function' ? next(hooks[i].v) : next
        // 与 React 一致：Object.is 相等就不重渲染。少这一条会让
        // 「st.xxx = v; bump()」这类模式在替身里跑得比真 React 还勤。
        if (Object.is(v, hooks[i].v)) return
        hooks[i].v = v
        scheduleRender()
      }]
    },
    useCallback: (fn, deps) => {
      const i = cursor++
      const slot = hooks[i]
      if (!slot || depsChanged(slot.deps, deps)) { hooks[i] = { fn, deps }; return fn }
      return slot.fn
    },
    useMemo: (fn, deps) => {
      const i = cursor++
      const slot = hooks[i]
      if (!slot || depsChanged(slot.deps, deps)) { const v = fn(); hooks[i] = { v, deps }; return v }
      return slot.v
    },
    useEffect: (fn, deps) => {
      const i = cursor++
      const prev = hooks[i]
      if (prev && !depsChanged(prev.deps, deps)) { return }
      // ⚠ 关键：**不能在这里直接跑 fn()**。
      // 真 React 的 effect 在 DOM commit 之后才执行；而组件函数体是先跑的，
      // 此时 renderDom 还没建出元素，ref.current 全是 null。
      // 直接跑会让「if (!stageRef.current) return」这种守卫静默吞掉整个挂载，
      // 表现为「画布永远空着」—— 一度被误判成产品 bug。
      // 所以这里只登记，由 doRender 在 commit 之后 flush。
      hooks[i] = { deps }
      pendingEffects.push({ i, fn })
    },
    version: '18.3.1',
  }

  window.__loomTest = {
    mount(Comp2, host) {
      Comp = Comp2
      rootEl = host
      hooks = []
      doRender()
    },
    rerender: doRender,
  }
  window.__loomReact = REACT
})();
</script>
<script>
/* ============ kernel：模块系统 + fetch 拦截 ============ */
(function () {
  const WS = 'proj-alpha'
  window.__loomWorkspace = WS
  window.__loomLog = { requests: [], planningPreviews: [], draftWrites: [] }

  /* ---- 内存数据面 ----
   *
   * 「服务端」这一侧要能扛住 Page.reload —— 否则「刷新后还在」根本无从验起
   * （页面一重载，服务端自己也忘了，那不叫持久化，那叫一起失忆）。
   * 真实宿主写盘，这里写 sessionStorage：**跨 reload 存活，但换个标签页就干净**，
   * 正好是每个用例该有的隔离度。
   */
  const SKEY = '__loomServerDUMP__'
  const SAVED = (function () {
    try { return JSON.parse(sessionStorage.getItem(SKEY) || 'null') } catch (e) { return null }
  })()
  const persist = () => {
    try {
      sessionStorage.setItem(SKEY, JSON.stringify({
        draftRevision: st.draftRevision, draftCandidate: st.draftCandidate, workflow: st.workflow, revisions: st.revisions,
        presentations: st.presentations, promptCalls: st.promptCalls, architectures: st.architectures,
      }))
    } catch (e) { /* 无痕模式之类，存不下就算了，不影响断言 */ }
  }

  /* ---- 内存数据面 ---- */
  const st = {
    draftRevision: 3,
    // 外观注入（欢迎题词 / 聊天框着色）读这份配置。默认全开 ——
    // 要验「该注入的地方注入、不该注入的地方不注入」，前提是开关本身是开的。
    config: {
      enabled: true,
      welcomeEnabled: true,
      // 题词文本**不是**配置项：2026-10-12 功能命名轮把它从
      // 「欢迎使用 Avel-Loom 工作规划系统」改成「欢迎使用可视化规划模式」，
      // 由 lib/client.js 直接渲染。这里原先留着一个没人读的 welcomeText，已删。
      welcomeColor: '#e6e6e6',
      welcomeFontSize: 18,
      planningModeColor: '#6ea8fe',
      maxConcurrency: 2,
    },
    // 会话态总开关。默认打开 —— 工作台里「生成规划提示词 / 预览候选改动」
    // 等按钮的 disabled 条件里都有 !sessionEnabled，关着就点不动。
    sessionEnabled: true,
    workflow: {
      schemaVersion: '0.1', workflowId: 'loom-default', revision: 2, title: '测试图',
      detectedStage: 'implementation', evidence: [], assumptions: [], openQuestions: [],
      executionProposal: null,
      nodes: [
        { id: 'inspect', kind: 'inspect', title: '检查仓库', phase: 'discovery', goal: '产出仓库报告', role: 'investigator', sourceRefs: [],
          inputs: [], outputs: [{ name: 'report', artifactType: 'repo-report', required: true }],
          ownership: { writes: [], forbiddenWrites: [], sharedResources: [] },
          execution: { backend: 'deterministic', isolation: 'read-only', timeoutSeconds: 300, maxRepairAttempts: 0 },
          acceptance: { doneWhen: ['报告里有模块清单'], commands: [], independentVerification: true } },
        { id: 'contract', kind: 'contract', title: '冻结接口', phase: 'architecture', goal: '冻结接口合同', role: 'architect', sourceRefs: [],
          inputs: [{ name: 'report', artifactType: 'repo-report', required: true }],
          outputs: [{ name: 'contract', artifactType: 'interface-contract', required: true }],
          ownership: { writes: [], forbiddenWrites: [], sharedResources: [] },
          execution: { backend: 'configured-agent', isolation: 'read-only', timeoutSeconds: 600, maxRepairAttempts: 1 },
          acceptance: { doneWhen: ['合同可机器校验'], commands: [], independentVerification: true } },
        { id: 'frontend', kind: 'agent', title: '实现前端', phase: 'implementation', goal: '实现前端模块', role: 'implementer', sourceRefs: [],
          inputs: [{ name: 'contract', artifactType: 'interface-contract', required: true }],
          outputs: [{ name: 'change', artifactType: 'code-change', required: true }],
          ownership: { writes: ['src/web/**'], forbiddenWrites: [], sharedResources: [] },
          execution: { backend: 'configured-agent', isolation: 'worktree', timeoutSeconds: 1800, maxRepairAttempts: 2 },
          acceptance: { doneWhen: ['测试通过'], commands: [], independentVerification: true } },
        { id: 'report', kind: 'report', title: '交付报告', phase: 'verification', goal: '产出交付报告', role: 'reporter', sourceRefs: [],
          inputs: [{ name: 'change', artifactType: 'code-change', required: true }],
          outputs: [{ name: 'report', artifactType: 'delivery-report', required: true }],
          ownership: { writes: [], forbiddenWrites: [], sharedResources: [] },
          execution: { backend: 'deterministic', isolation: 'read-only', timeoutSeconds: 300, maxRepairAttempts: 0 },
          acceptance: { doneWhen: ['报告覆盖两个模块'], commands: [], independentVerification: true } },
      ],
      edges: [
        { id: 'inspect.report->contract.report', source: 'inspect', sourcePort: 'report', target: 'contract', targetPort: 'report', artifactType: 'repo-report', require: 'validated' },
        { id: 'contract.contract->frontend.contract', source: 'contract', sourcePort: 'contract', target: 'frontend', targetPort: 'contract', artifactType: 'interface-contract', require: 'validated' },
      ],
    },
    revisions: [{ workflowId: 'loom-default', revision: 2, title: '测试图' }],
    presentations: [],
    promptCalls: [],
    /**
     * 架构 revision 表。**与任务图分开**：架构不是任务图的投影，
     * 它有独立 id / revision / 校验规则（允许环、允许双向）。
     * 这里预置一份最小架构，让「架构视图」有真实东西可渲染 ——
     * 空表只能验「没数据时提示对不对」，验不了「能不能编辑」。
     */
    architectures: [
      {
        schemaVersion: 1,
        architectureId: 'loom-architecture',
        revision: 1,
        nodes: [
          { id: 'web', kind: 'module', title: '前端模块', responsibility: '渲染工作台界面，维护画布交互状态。', interface: ['UI 事件', 'REST 调用'], sourceRefs: [], locked: false },
          { id: 'core', kind: 'service', title: '核心服务', responsibility: '承载校验、编译与版本化存储。', interface: ['/loom/* HTTP API'], sourceRefs: [], locked: true },
          { id: 'store', kind: 'data', title: '工作台数据目录', responsibility: '按工作区分区持久化草案、布局、架构与 revision。', sourceRefs: [], locked: false },
        ],
        edges: [
          { id: 'web-core', from: 'web', to: 'core', kind: 'call', bidirectional: false, description: '前端调用核心服务' },
          { id: 'core-store', from: 'core', to: 'store', kind: 'data', bidirectional: true, description: '核心服务与数据目录双向读写（架构层合法）' },
        ],
        constraints: ['零第三方运行时代码'],
        openQuestions: [],
        createdAt: '2026-10-01T00:00:00.000Z',
      },
    ],
  }
  // 上一次「进程」留下的盘上状态优先 —— 这就是重载后还能读到改动的原因。
  if (SAVED) {
    if (typeof SAVED.draftRevision === 'number') st.draftRevision = SAVED.draftRevision
    if (SAVED.workflow) st.workflow = SAVED.workflow
    if (SAVED.draftCandidate) st.draftCandidate = SAVED.draftCandidate
    if (Array.isArray(SAVED.revisions)) st.revisions = SAVED.revisions
    if (Array.isArray(SAVED.presentations)) st.presentations = SAVED.presentations
    if (Array.isArray(SAVED.promptCalls)) st.promptCalls = SAVED.promptCalls
    if (Array.isArray(SAVED.architectures) && SAVED.architectures.length) st.architectures = SAVED.architectures
  }
  window.__loomState = st

  /**
   * 候选图校验（数据面这一侧）。
   *
   * 只实现浏览器测试真正会踩到的那几条：缺必填字段、id 形状、
   * 边的端口存在性与类型一致、单来源、任务图必须无环。
   * 真源在 src/core/model.ts + src/core/validate.ts，这里不重复它的全部规则
   * —— 这里要回答的是「服务端会不会拒」，不是「校验写得对不对」
   * （后者由 tests/core.test.mjs 覆盖）。
   */
  function validateCandidate(wf) {
    const errs = []
    if (!wf || !Array.isArray(wf.nodes)) return [{ path: 'workflow', message: '候选图没有 nodes' }]
    const ids = new Set()
    for (const n of wf.nodes) {
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(String(n.id || ''))) errs.push({ path: 'nodes['+n.id+']', message: 'id 不合规' })
      if (ids.has(n.id)) errs.push({ path: 'nodes['+n.id+']', message: 'id 重复' })
      ids.add(n.id)
      for (const f of ['kind', 'title', 'phase', 'goal', 'role', 'ownership', 'execution', 'acceptance']) {
        if (n[f] === undefined || n[f] === null) errs.push({ path: 'nodes['+n.id+']', message: '缺必填字段 '+f })
      }
      if (!Array.isArray(n.inputs)) errs.push({ path: 'nodes['+n.id+']', message: '缺 inputs' })
      if (!Array.isArray(n.outputs)) errs.push({ path: 'nodes['+n.id+']', message: '缺 outputs' })
      if (typeof n.goal === 'string' && !n.goal.trim()) errs.push({ path: 'nodes['+n.id+']', message: 'goal 不能为空' })
    }
    const byId = new Map(wf.nodes.map((n) => [n.id, n]))
    const srcUse = new Map()
    const adj = new Map(wf.nodes.map((n) => [n.id, []]))
    for (const e of wf.edges || []) {
      const s = byId.get(e.source)
      const t = byId.get(e.target)
      if (!s || !t) { errs.push({ path: 'edges['+e.id+']', message: '端点不存在' }); continue }
      const op = (s.outputs || []).find((p) => p.name === e.sourcePort)
      const ip = (t.inputs || []).find((p) => p.name === e.targetPort)
      if (!op) { errs.push({ path: 'edges['+e.id+']', message: '源端口 '+e.sourcePort+' 不存在' }); continue }
      if (!ip) { errs.push({ path: 'edges['+e.id+']', message: '目标端口 '+e.targetPort+' 不存在' }); continue }
      if (op.artifactType !== ip.artifactType) {
        errs.push({ path: 'edges['+e.id+']', message: '类型不匹配：'+op.artifactType+' → '+ip.artifactType })
        continue
      }
      // 单来源：一个输入端口只能被一条边喂。镜像 src/core/validate.ts 的规则。
      const key = e.target + '.' + e.targetPort
      if (srcUse.has(key)) errs.push({ path: 'edges['+e.id+']', message: '输入端口 '+key+' 有多个来源' })
      srcUse.set(key, e.sourcePort)
      adj.get(e.source).push(e.target)
    }
    // 任务图必须无环（架构图允许环，所以这里只判开工任务图）。
    const state = new Map()
    const dfs = (id) => {
      state.set(id, 1)
      for (const nx of adj.get(id) || []) {
        if (state.get(nx) === 1) { errs.push({ path: 'nodes['+id+']', message: '检测到环，开工任务图必须无环' }); return }
        if (!state.get(nx)) dfs(nx)
      }
      state.set(id, 2)
    }
    for (const n of wf.nodes) if (!state.get(n.id)) dfs(n.id)
    return errs
  }

  /**
   * 架构候选校验（数据面这一侧）。**与 validateCandidate 是两套规则**。
   *
   * 关键差异（评审反复强调，也是「不能用任务图冒充架构图」的落点）：
   * - 架构**允许环** → 只出 warning，绝不出 error；
   * - 架构边没有端口/类型一致/单来源这套约束（那是任务图的依赖语义）；
   * - 架构**不接受自环**（from === to → error），这条与任务图一致。
   *
   * 真源在 src/core/architecture.ts 的 validateArchitecture，
   * 这里只回答「服务端会不会拒」，不重写它的全部规则。
   */
  function validateArchitectureCandidate(a) {
    const errors = []
    const warnings = []
    const err = (code, path, message) => errors.push({ code, path, message, severity: 'error' })
    if (!a || typeof a !== 'object' || Array.isArray(a)) {
      return { errors: [{ code: 'ROOT_NOT_OBJECT', path: '', message: '顶层必须是对象' }], warnings: [] }
    }
    if (a.schemaVersion !== 1) err('SCHEMA_VERSION', 'schemaVersion', '必须是 1')
    if (typeof a.architectureId !== 'string' || !a.architectureId) err('ARCH_ID_MISSING', 'architectureId', 'architectureId 必须是非空字符串')
    if (!Number.isInteger(a.revision) || a.revision < 1) err('REVISION_INVALID', 'revision', 'revision 必须是 >= 1 的整数')
    if (!Array.isArray(a.nodes)) err('NODES_NOT_ARRAY', 'nodes', 'nodes 必须是数组')
    if (!Array.isArray(a.edges)) err('EDGES_NOT_ARRAY', 'edges', 'edges 必须是数组')
    if (!Array.isArray(a.nodes) || !Array.isArray(a.edges)) return { errors, warnings }
    const KINDS = ['module', 'service', 'data', 'interface', 'decision', 'external']
    const EKINDS = ['call', 'data', 'event', 'deploy']
    const ids = new Set()
    a.nodes.forEach((n, i) => {
      if (!n || typeof n !== 'object') { err('NODE_NOT_OBJECT', 'nodes[' + i + ']', '节点必须是对象'); return }
      if (typeof n.id !== 'string' || !n.id) err('NODE_ID_MISSING', 'nodes[' + i + '].id', '缺少 id')
      else if (ids.has(n.id)) err('NODE_ID_DUPLICATE', 'nodes[' + i + '].id', 'id 重复：' + n.id)
      else ids.add(n.id)
      if (!KINDS.includes(n.kind)) err('NODE_KIND_UNKNOWN', 'nodes[' + i + '].kind', 'kind 必须是 ' + KINDS.join(' / '))
      if (typeof n.title !== 'string' || !n.title.trim()) err('NODE_TITLE_MISSING', 'nodes[' + i + '].title', 'title 不能为空')
      if (typeof n.responsibility !== 'string' || !n.responsibility.trim()) err('NODE_RESPONSIBILITY_MISSING', 'nodes[' + i + '].responsibility', 'responsibility 不能为空（图里只显示摘要，全文必须保留）')
    })
    const edgeIds = new Set()
    a.edges.forEach((e, i) => {
      if (!e || typeof e !== 'object') { err('EDGE_NOT_OBJECT', 'edges[' + i + ']', '边必须是对象'); return }
      if (typeof e.id !== 'string' || !e.id) err('EDGE_ID_MISSING', 'edges[' + i + '].id', '缺少 id')
      else if (edgeIds.has(e.id)) err('EDGE_ID_DUPLICATE', 'edges[' + i + '].id', 'id 重复：' + e.id)
      else edgeIds.add(e.id)
      for (const end of ['from', 'to']) {
        if (typeof e[end] !== 'string' || !ids.has(e[end])) err('EDGE_ENDPOINT_UNKNOWN', 'edges[' + i + '].' + end, '找不到节点：' + String(e[end]))
      }
      if (!EKINDS.includes(e.kind)) err('EDGE_KIND_UNKNOWN', 'edges[' + i + '].kind', 'kind 必须是 ' + EKINDS.join(' / '))
      if (e.from === e.to) err('EDGE_SELF_LOOP', 'edges[' + i + ']', '架构图也不接受自环')
    })
    // 架构允许环 —— 只给 warning。把环判成 error 就是拿任务图规则冒充架构规则。
    const adj = new Map(a.nodes.map((n) => [n.id, []]))
    for (const e of a.edges) {
      if (adj.has(e.from)) adj.get(e.from).push(e.to)
      if (e.bidirectional && adj.has(e.to)) adj.get(e.to).push(e.from)
    }
    const seen = new Set()
    const instack = new Set()
    let cyclic = false
    const dfs = (v) => {
      seen.add(v); instack.add(v)
      for (const w of adj.get(v) || []) {
        if (instack.has(w)) { cyclic = true; return }
        if (!seen.has(w)) dfs(w)
      }
      instack.delete(v)
    }
    for (const n of a.nodes) if (!seen.has(n.id)) dfs(n.id)
    if (cyclic) warnings.push({ code: 'ARCH_HAS_CYCLE', path: 'edges', message: '检测到通信环（架构层合法）', severity: 'warning' })
    return { errors, warnings }
  }

  const reply = (status, payload) => ({ ok: status < 300, status, json: async () => payload })

  window.fetch = function (url, init) {
    const u = String(url)
    if (!u.includes('/loom')) return Promise.reject(new Error('测试页面不该请求 ' + u))
    const path = u.slice(u.indexOf('/loom') + 5)
    const headers = (init && init.headers) || {}
    const method = (init && init.method) || 'GET'
    const body = init && init.body ? JSON.parse(init.body) : null
    const ws = headers['x-loom-session'] === 'test-session' ? WS : null
    window.__loomLog.requests.push({ path, method, body, ws, fullUrl: u })

    if (path === '/state') {
      return Promise.resolve(reply(200, { ok: true, data: {
        config: {}, capabilities: {},
        capabilityStages: [
          { key: 'worktreeManagement', backend: 'loom', declaredByHost: false, implementedByLoom: true, availableInEnv: 'unknown', verifiedInRun: false, lastVerifiedAt: null, stage: 'implemented-unverified', usable: false, gaps: ['环境未验证'], limits: null },
          { key: 'perCallCwd', backend: 'host', declaredByHost: true, implementedByLoom: false, availableInEnv: 'unknown', verifiedInRun: false, lastVerifiedAt: null, stage: 'not-implemented', usable: false, gaps: ['Loom 未接线'], limits: null },
        ],
        degradations: [],
        workspaceId: ws || null, workspaceResolved: !!ws,
        // 会话态总开关。客户端读 snapshot.sessionEnabled（=== true）就是这里。
        // 少了它，工作台里带 !sessionEnabled 的按钮全点不动。
        sessionEnabled: st.sessionEnabled === true,
        workspaceUnresolvedReason: ws ? null : '未提供工作区',
        draft: { mode: 'manual', workflowId: 'loom-default', draftRevision: st.draftRevision, candidate: st.draftCandidate, workspaceId: ws || null, lockedConstraints: [] },
        revisions: st.revisions.slice(),
        paths: { root: '/tmp/loom-browser' },
        stats: { revisions: st.revisions.length, architectures: st.architectures.length, runs: 0, events: 1 },
        // 照真实 /state：架构列表**只有计数**，没有图。要拿真图必须再 GET /architecture。
        // 客户端若偷懒拿这里的 nodes 当图渲染，就会立刻暴露。
        architectures: st.architectures.map((a) => ({
          architectureId: a.architectureId,
          revision: a.revision,
          nodes: a.nodes.length,
          edges: a.edges.length,
          createdAt: a.createdAt,
        })),
        presentation: { nodes: st.presentations.length ? st.presentations[st.presentations.length - 1].nodes : [], groups: [] },
        // 一条带完整回执的运行记录：运行视图的审计/工作树/产物/命令小节都靠它渲染。
        execution: st.execution,
        runs: st.runs || [{
          runId: 'run-fixture-1', workflowId: 'loom-default', revision: 2, state: 'validated',
          startedAt: '2026-10-06T00:00:00.000Z', endedAt: '2026-10-06T00:10:00.000Z',
          receipt: {
            completed: ['inspect', 'contract'], integrated: false,
            audits: [
              { groupId: 'group-1', label: '审计 1', verdict: 'pass', taskIds: ['inspect', 'contract'], findings: ['接口契约与实现一致', '缺一条边界用例'] },
              { groupId: 'group-2', label: '审计 2', verdict: 'fail', taskIds: ['frontend'], findings: [] },
            ],
            worktrees: [{ taskId: 'inspect', state: 'kept', branch: 'loom/run-fixture-1/inspect', path: '/tmp/loom-browser/wt/inspect', baseSha: 'a'.repeat(40) }],
            artifacts: [{ nodeId: 'inspect', port: 'report', ref: '/tmp/loom-browser/wt/inspect/report.md', contentHash: 'b'.repeat(64) }],
            checks: [{ argv: ['pnpm', 'test'], state: 'passed', exitCode: 0, cwd: '/tmp/loom-browser/wt/inspect', platform: 'linux', pid: 1234, stdoutHash: 'c'.repeat(64), stderrHash: 'd'.repeat(64) }],
          },
        }],
      } }))
    }
    if (path.startsWith('/workflow')) return Promise.resolve(reply(200, { ok: true, data: st.workflow }))
    if (path.startsWith('/architecture')) {
      // GET：按 architectureId 取最新一份。找不到 → 404（照 src/http.ts）。
      // POST：提交一份新架构；**校验不过 400 且不落盘**（照 src/http.ts）。
      const archId = decodeURIComponent((u.split('architectureId=')[1] || '').split('&')[0])
      if (method === 'POST') {
        const arch = body && body.architecture
        if (!arch || typeof arch.architectureId !== 'string') {
          return Promise.resolve(reply(400, { ok: false, error: '缺少 architecture.architectureId' }))
        }
        const r = validateArchitectureCandidate(arch)
        if (r.errors.length) {
          return Promise.resolve(reply(400, { ok: false, error: '架构未通过校验', data: { ok: false, errors: r.errors, warnings: r.warnings } }))
        }
        st.architectures.push(arch)
        persist()
        return Promise.resolve(reply(200, { ok: true, data: { warnings: r.warnings } }))
      }
      const found = st.architectures.filter((a) => a.architectureId === archId)
      if (!found.length) {
        return Promise.resolve(reply(404, { ok: false, error: '找不到架构：' + archId }))
      }
      return Promise.resolve(reply(200, { ok: true, data: found[found.length - 1] }))
    }
    if (path.startsWith('/flow')) {
      if (!ws) return Promise.resolve(reply(409, { ok: false, error: '无法确定请求归属的工作区', code: 'WORKSPACE_UNRESOLVED' }))
      window.__loomLog.flow = window.__loomLog.flow || { gets: 0, saves: [], applies: [] }
      if (method === 'GET') {
        window.__loomLog.flow.gets += 1
        const ids = (st.workflow.nodes || []).map((n) => n.id)
        const plan = st.flowPlan || {
          workflowId: st.workflow.workflowId, revision: st.workflow.revision,
          steps: ids.map((id, i) => ({ id: 'step-' + (i + 1), taskIds: [id], agents: 2 })),
          order: ids.map((id, i) => 'step-' + (i + 1)),
          groups: [], auditAgents: [{ id: 'audit-1', label: '审计 1', groupId: null }, { id: 'audit-2', label: '审计 2', groupId: null }],
          updatedAt: '2026-10-05T00:00:00.000Z',
        }
        // maxAgents 故意给 2（真实是 3）：客户端必须用服务端返回的上限，
        // 不能自己写死 —— 下拉里出现 3 就说明它没读这个字段。
        return Promise.resolve(reply(200, { ok: true, data: { plan, saved: Boolean(st.flowPlan), warnings: [], maxAgents: 2 } }))
      }
      if (path.startsWith('/flow/apply')) {
        window.__loomLog.flow.applies.push(body)
        st.draftRevision += 1
        return Promise.resolve(reply(200, { ok: true, data: { addedEdges: [{ id: 'flow-inspect-contract', source: 'inspect', sourcePort: 'report', target: 'contract', targetPort: 'report', artifactType: 'repo-report', require: 'validated' }], draft: { draftRevision: st.draftRevision } } }))
      }
      window.__loomLog.flow.saves.push(body && body.plan)
      st.flowPlan = body && body.plan
      return Promise.resolve(reply(200, { ok: true, data: { plan: body && body.plan, warnings: [] } }))
    }
    if (path === '/config') {
      // 外观注入（欢迎题词、聊天框着色）要靠这份配置才跑得起来。
      // 之前这里没有 /config，config 恒为 null，welcome-line 的 effect
      // 在开头那句「配置为空就返回」就直接退出了 —— 表现为「注入了的东西
      // 一个都没有」，很容易被误读成产品逻辑坏掉。
      if (method === 'POST') {
        Object.assign(st.config, body || {})
      }
      return Promise.resolve(reply(200, { ok: true, data: { ...st.config } }))
    }
    if (path === '/session/activation') {
      // 会话态总开关。之前这里没有这个端点：客户端 GET 拿到 404 → sessionEnabled
      // 恒为 false → 工作台里「生成规划提示词」「预览候选改动」等按钮永远 disabled。
      if (method === 'POST') {
        if (typeof (body || {}).enabled !== 'boolean') return Promise.resolve(reply(400, { ok: false, code: 'SESSION_INVALID', error: '只允许布尔值 enabled' }))
        st.sessionEnabled = body.enabled
        return Promise.resolve(reply(200, { ok: true, data: { sessionId: 'test-session', enabled: st.sessionEnabled } }))
      }
      return Promise.resolve(reply(200, { ok: true, data: { sessionId: 'test-session', enabled: st.sessionEnabled === true } }))
    }
    if (path === '/planning/export') {
      // 导出规划提示词：客户端把它当 promptText（kind=planning），随后
      // 走 /planning/preview 校验模型回复。这里给一个稳定的 payloadHash。
      st.planningExport = { payloadHash: 'plan-harness-1', text: '[planning] 规划提示词正文' }
      return Promise.resolve(reply(200, { ok: true, data: { payloadHash: st.planningExport.payloadHash, text: st.planningExport.text, prompt: st.planningExport.text } }))
    }
    if (path === '/planning/preview') {
      // 低配模型护栏用例的驱动点：window.__loomPreviewFail 设成数字 N 时，
      // 前 N 次预览返回 422 INVALID_CANDIDATE，之后正常返回。
      if (typeof window.__loomPreviewFail === 'number' && window.__loomPreviewFail > 0) {
        window.__loomPreviewFail -= 1
        window.__loomLog.planningPreviews.push({ path, ok: false })
        return Promise.resolve(reply(422, { ok: false, error: 'INVALID_CANDIDATE: payload.nodes[0].goal: 必填', code: 'CANDIDATE_INVALID' }))
      }
      window.__loomLog.planningPreviews.push({ path, ok: true })
      // 成功分支要带够渲染字段：客户端预览面板会读
      // architecture.nodes / workflow.nodes / sourceMap.entries / changes。
      const arch = { schemaVersion: 1, architectureId: 'loom-architecture', revision: 2, constraints: [], edges: [], nodes: [{ id: 'web', kind: 'module', title: 'Web', responsibility: '页面' }] }
      const wf = { workflowId: 'loom-default', revision: 3, nodes: [{ id: 'frontend', goal: '实现前端模块', ownership: { writes: ['src/web/**'] } }] }
      return Promise.resolve(reply(200, { ok: true, data: { candidateHash: 'cand-1', changes: [], warnings: [], sourceMap: { entries: [] }, blocked: false, architecture: arch, workflow: wf } }))
    }
    if (path === '/session/planning-mode') {
      if (method === 'POST') {
        const want = body && body.planningMode
        if (typeof want !== 'boolean' || Object.keys(body || {}).some((key) => key !== 'planningMode')) return Promise.resolve(reply(400, { ok: false, code: 'SESSION_INVALID', error: '只允许布尔值 planningMode' }))
        st.planningMode = want
        return Promise.resolve(reply(200, { ok: true, data: { sessionId: 'test-session', planningMode: want } }))
      }
      return Promise.resolve(reply(200, { ok: true, data: { sessionId: 'test-session', planningMode: st.planningMode === true } }))
    }
    if (path === '/draft') {
      if (!ws) return Promise.resolve(reply(409, { ok: false, error: '无法确定请求归属的工作区', code: 'WORKSPACE_UNRESOLVED' }))
      if (typeof body?.expectedRevision === 'number' && body.expectedRevision !== st.draftRevision) {
        return Promise.resolve(reply(409, { ok: false, error: '草案已被其他窗口改动', code: 'REVISION_CONFLICT', data: { conflict: { expected: body.expectedRevision, actual: st.draftRevision, detail: '草案已被其他窗口改动' } } }))
      }
      st.draftRevision += 1
      // Mirrors the fixed /draft contract. This fixture uses sessionStorage; the real HTTP/disk test supplies independent persistence evidence.
      if (body?.candidate) st.draftCandidate = body.candidate
      const rec = { draftRevision: st.draftRevision, workflowId: body?.workflowId, mode: body?.mode || 'manual', expectedRevision: body?.expectedRevision, workspaceId: ws }
      window.__loomLog.draftWrites.push(rec)
      persist()
      return Promise.resolve(reply(200, { ok: true, data: rec }))
    }
    if (path === '/validate') {
      // 照真实 /validate：kind 决定用哪套校验。架构与任务**规则不同**
      // （架构允许环、允许双向；任务图必须 DAG）。混用会让架构图的环
      // 被误判成错误 —— 那正是评审要防的「两张图互相冒名」。
      const kind = body && body.kind === 'architecture' ? 'architecture' : 'workflow'
      if (kind === 'architecture') {
        const r = validateArchitectureCandidate(body && body.document)
        return Promise.resolve(reply(200, { ok: true, data: { ok: r.errors.length === 0, errors: r.errors, warnings: r.warnings } }))
      }
      const errs = validateCandidate(body && body.document)
      return Promise.resolve(reply(200, { ok: true, data: { ok: errs.length === 0, errors: errs, warnings: [] } }))
    }
    if (path === '/presentation') {
      if (!ws) return Promise.resolve(reply(409, { ok: false, error: '无法确定请求归属的工作区', code: 'WORKSPACE_UNRESOLVED' }))
      st.presentations.push(body && body.presentation)
      persist()
      return Promise.resolve(reply(200, { ok: true, data: { saved: true } }))
    }
    if (path === '/prompt') {
      st.promptCalls.push(body)
      // 三条路线形状不同：architecture 分支靠 architectureId 取架构，
      // 不查工作流；task/coordinator 靠 workflowId。
      if (body && body.kind === 'architecture') {
        const archId = String(body.architectureId || '')
        const found = st.architectures.filter((a) => a.architectureId === archId)
        if (!found.length) {
          return Promise.resolve(reply(404, { ok: false, error: '找不到架构：' + archId + '（architecture 分支不需要工作流；请先提交 architecture）', code: 'ARCHITECTURE_NOT_FOUND' }))
        }
        const arch = found[found.length - 1]
        const nodeId = typeof body.nodeId === 'string' && body.nodeId ? body.nodeId : null
        if (nodeId && !arch.nodes.some((n) => n.id === nodeId)) {
          return Promise.resolve(reply(404, { ok: false, error: '架构中找不到节点：' + nodeId, code: 'NODE_NOT_FOUND' }))
        }
        // scope 必须进 hash：全图与「只优化某模块」是两条不同指令，
        // 不能因为 draft 相同就共享 hash。
        const scopeKey = nodeId ? 'scope:' + nodeId : 'scope:all'
        return Promise.resolve(reply(200, { ok: true, data: {
          kind: 'architecture',
          architectureId: arch.architectureId,
          revision: arch.revision,
          baseRevision: arch.revision,
          nodeId,
          payloadHash: 'arch-' + arch.revision + '-' + scopeKey,
          text: '[architecture] 架构优化提示词正文（范围 ' + scopeKey + '）',
        } }))
      }
      return Promise.resolve(reply(200, { ok: true, data: { kind: body?.kind, text: '[' + body?.kind + '] 提示词正文' } }))
    }
    if (path === '/adopt') {
      // 照真实宿主：候选图先校验，过了才 appendRevision。
      // 校验失败返回 400，**不产生 revision** —— 这是「非法边不能采用执行」
      // 在数据面的那一半。
      const cand = (body && body.candidate && body.candidate.workflow) || null
      const errs = validateCandidate(cand)
      if (errs.length) {
        return Promise.resolve(reply(400, { ok: false, error: '候选图未通过校验，未产生 revision', data: { ok: false, errors: errs } }))
      }
      st.workflow = Object.assign({}, cand, {
        revision: typeof body?.revision === 'number' ? body.revision : st.workflow.revision + 1,
      })
      st.revisions.push({ workflowId: st.workflow.workflowId, revision: st.workflow.revision, title: st.workflow.title })
      persist()
      return Promise.resolve(reply(200, { ok: true, data: { workflow: st.workflow, blocked: [], warnings: [] } }))
    }
    return Promise.resolve(reply(404, { ok: false, error: '未实现的端点 ' + path }))
  }

  /* ---- 模块系统：照真实形状，只允许 require('react') ---- */
  const loaded = []
  window.__ModuleLoader__ = {
    load(spec) { loaded.push(spec) },
  }
  window.__loomLoaded = loaded
  window.__loomRequire = (name) => { if (name === 'react') return window.__loomReact; throw new Error('unexpected require(' + name + ')') }
})();
</script>
<script src="__BUNDLE__"></script>
</body></html>`
}

/** 把壳里的 inline script 按序注入，再把 bundle 灌进去。 */
/**
 * 清掉上一个用例留在页面里的「服务端盘上状态」。
 *
 * 每个用例必须从同一份初始图出发 —— 否则用例之间会通过 sessionStorage
 * 互相污染，跑单个过、跑全套挂。openWorkbench 在装壳之前调它。
 */
export async function resetServerState(page) {
  await page.evaluate(() => {
    try { window.sessionStorage.removeItem('__loomServerDUMP__') } catch (e) { /* ignore */ }
  })
}

/**
 * 装页面壳 + 注入 bundle。
 *
 * `opts.exposeEdit`：开后门给测试直接调编辑函数（默认关）。
 * 生产 bundle 默认不带这个后门（见 client.js 里 `window.__loomExposeEdit` 的说明）；
 * 只有要验「绕过 UI 时闸门是否仍拦得住」的测试才开 —— 这条正是锁定闸门的关键证据。
 */
export async function installShell(page, shell, bundle, opts) {
  if (opts && opts.exposeEdit) {
    await page.evaluate(() => { window.__loomExposeEdit = true })
  }
  const scripts = []
  const re = /<script>([\s\S]*?)<\/script>/g
  let m
  while ((m = re.exec(shell)) !== null) scripts.push(m[1])
  for (const src of scripts) {
    await page.evaluate(new Function('s', 'return eval(s)'), { args: [src] })
  }
  const injected = await page.evaluate(
    new Function('code', `
      try {
        const s = document.createElement('script')
        s.textContent = code
        document.head.appendChild(s)
        return { ok: true }
      } catch (e) { return { ok: false, why: String(e && e.message) } }
    `),
    { args: [bundle] },
  )
  if (!injected.ok) throw new Error(`bundle 注入失败：${injected.why}`)
  return scripts.length
}

/** 从 __ModuleLoader__ 取 factory、走 apply、把组件挂到 #root。 */
export async function mountWorkbench(page, opts = {}) {
  const sessionKey = opts.sessionKey === undefined ? 'test-session' : (opts.sessionKey ?? '')
  return page.evaluate(({key, commandSpy}) => {
    const specs = window.__loomLoaded
    if (!specs.length) return { ok: false, why: 'bundle 没有向 __ModuleLoader__ 注册' }
    try {
      window.__loomAllowTestHooks = true
      const ex = specs[0].factory(window.__loomRequire)
      const regs = []
      ex.apply({
        ...(commandSpy ? { sessions: { using: async (_key, _options, fn) => fn({ready:Promise.resolve({session:{command:async line=>{(window.__loomCommands ||= []).push(line);return {ok:true,value:{matched:true}}}}})}) } } : {}),
        connection: { rpc: { call: async (_channel, _endpoint, payload, signal) => {
          const input = payload.args.input
          const response = await window.fetch('/loom' + input.path, { method: input.method, headers: { 'x-loom-session': input.sessionId, 'content-type': 'application/json' }, ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }), signal })
          return { ok: true, value: { status: response.status || 200, payload: await response.json() } }
        } } },
        // 会话键可运行时改（window.__loomSessionKey），用来模拟「从已有对话切到全新会话页」。
        uiSession: { adapter: { current: { getSnapshot: () => ({ key: window.__loomSessionKey === undefined ? key : window.__loomSessionKey }) } } },
        // 只把**聚合插槽**当作「没被声明」—— 这就是「没装装载机」的环境：inject 不回调，
        // 模块应当走兜底注册 settings.section。其余插槽照常回调（真实里它们由官方声明，
        // 白名单式的写法会把 loom 注册的其他插槽一起挡掉，那是错的）。
        slots: { inject: (n, f) => (n === 'laurel-center.module' ? () => {} : f()), register: (spec, comp) => (regs.push({ spec, comp }), () => {}) },
        effect: (f) => (f(), () => {}),
      })
      if (!regs.length) return { ok: false, why: 'apply 没有注册设置页插槽' }
      window.__loomSlots = regs.map((r) => r.spec.name)
      window.__loomExports = ex
      const workbench = regs.find(r => r.spec.name === 'settings.section'); window.__loomTest.mount(ex.Workbench, document.getElementById('root'))
      return { ok: true, id: specs[0].id, slotId: workbench.spec.id }
    } catch (e) {
      return { ok: false, why: 'throw: ' + String((e && e.stack) || e).slice(0, 800) }
    }
  }, { args: [{key:sessionKey,commandSpy:opts.commandSpy===true}] })
}
