/**
 * Laurel-Center · 客户端服务名白名单（单一真相源）
 *
 * ── 这份名单是干什么的 ──────────────────────────────────────────────────
 * DSH 的客户端模块系统会为 boot graph 里每条 row 建一个 cordis fiber，
 * 依赖取自该插件 bundle 导出的 `exports.inject`。名单里任何一个名字如果在
 * 客户端上下文里 `ctx.get()` 不到，这一行就永远停在 `pending`，整个 web boot
 * 直接失败：
 *
 *     Error: web boot: 1 entry did not activate
 *     laurel-center: pending (waiting for service: uiSettings)
 *
 * 所以「`exports.inject` 里不许写不存在的服务名」是一条硬约束，
 * 本文件提供判定用的白名单，供 check.mjs 与 bootgraph-probe.mjs 共用
 * —— 避免两个脚本各写一份、悄悄不同步（这个坑本项目踩过一次）。
 *
 * ── 名单怎么来的（可复核） ──────────────────────────────────────────────
 * 从本机 DSH 的 `resources/app.asar` 提取全部 59 个
 * `@deepseek-ai/dsh-client-*\/lib/client.js`，取两者并集去重：
 *   · `exports.inject` 声明里出现过的服务名（49 个）
 *   · `provide("...")` 调用里出现过的服务名（14 个）
 * 去重后 **55 个**。复核命令见交接手册 §6.3。
 *
 * ── ⚠ 这份名单的局限，别当圣经 ─────────────────────────────────────────
 * 它是「官方客户端插件**用过**的服务名」，**不等于**「全部合法服务名」——
 * 有些服务由 kernel 直接提供，从未出现在任何 client 包里。
 * 因此白名单宁可**宽**一点：宽了顶多漏报，窄了会把合法服务名误判成错误。
 * 真要新增一个不在这份名单里的服务时，先确认它在客户端上下文真的存在，
 * 再把它加进来。
 *
 * ── 一个易混点 ─────────────────────────────────────────────────────────
 * `uiSettings` **不是**服务名，是包名 `@deepseek-ai/dsh-client-ui-settings`
 * 的尾巴。同理 `uiSlots`、`uiLocale` 也不存在。
 * 而 `slots` 这个服务由 `@deepseek-ai/dsh-client-ui-renderer` 提供；
 * `@deepseek-ai/dsh-client-ui-slots` 是个**纯库包**（无 `lib/client.js`、
 * 无 `dsh.client`），不产出 boot graph row。
 */

/** 客户端上下文里真实存在过的服务名（官方 59 个 client 包的 inject ∪ provide 并集）。 */
export const CLIENT_SERVICES = new Set([
  // ── exports.inject 并集（49）────────────────────────────────────────
  'commandUi', 'configForms', 'connection', 'conversation', 'dynamicCordisRunner',
  'fileUpload', 'inputTriggers', 'jobs', 'layout', 'loader', 'locale', 'modules',
  'remote', 'resources', 'sessions', 'settingsSchema', 'shortcuts',
  'sidebarRight', 'sidebarRightTabs', 'slots', 'theme',
  'uiConversation', 'uiSession', 'uiWorkspace', 'webTerminals', 'workspaces',
  // remote.* 命名空间（inject 里是按完整名写的）
  'remote.account', 'remote.agentPresets', 'remote.commands', 'remote.credentials',
  'remote.directoryPicker', 'remote.dynamicCordisRunner', 'remote.fileReferences',
  'remote.goals', 'remote.llm', 'remote.messageFeedback', 'remote.permissionPresets',
  'remote.pluginInventory', 'remote.pluginManager', 'remote.pluginRegistryProbe',
  'remote.productAnalytics', 'remote.schedule', 'remote.session',
  'remote.sessionFeedback', 'remote.sessionReferenceResolver', 'remote.settings',
  'remote.skills', 'remote.userQuestions', 'remote.workspaceFiles',
  // ── provide() 并集（14）─────────────────────────────────────────────
  'chatFileMentions', 'documentPreviews', 'feedbackUi', 'pluginNavigation',
  'uiRenderer', 'userQuestionPanels',
])

/**
 * 挑出一份 inject 名单里**不是**真实服务名的项。
 * @param {unknown} list 待检查的值（通常是 `exports.inject`）
 * @returns {string[]} 未知服务名；`list` 不是数组时返回空数组（交给别的断言管形状）
 */
export function unknownClientServices(list) {
  if (!Array.isArray(list)) return []
  return list.filter((s) => typeof s !== 'string' || !CLIENT_SERVICES.has(s))
}

/** 判断一个名字是不是「包名式」写法（`@scope/name` 或带斜杠）。服务名不该长这样。 */
export function looksLikePackageName(value) {
  return typeof value === 'string' && (value.startsWith('@') || value.includes('/'))
}
