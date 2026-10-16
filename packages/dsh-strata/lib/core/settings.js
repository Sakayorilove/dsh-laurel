/**
 * dsh-strata · 设置文件读写
 *
 * 三层归一化，与 Laurel 同一套：
 *
 *     patch 默认值（cordis.patch.yml）  →  settings.json（设置页写的）  →  生效值
 *              (最低)                                                          (权威)
 *
 * 宿主 `apply(ctx, config)` 拿到的就是 patch 那份，当**默认值**用；
 * 设置页通过 HTTP POST 写 settings.json，再读时盖在上面。
 *
 * 为什么不用宿主的 `ctx.settings`：它在 0.2.x 线换过一次接口
 * （`settings.register()` 被移除、改成 SettingsForms），而设置卡片的挂载点
 * 是**客户端**的 `ctx.slots`（见 `lib/client/index.mjs`）。
 * 走自己的 settings.json 没有版本耦合，而且这份文件你能直接打开改、能 diff、能备份。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { atomicWrite } from './atomic.js'
import { pluginPaths } from './config.js'

/** 只保留已知键，写盘前用一次，避免把临时字段写进 settings.json。 */
function sanitize(config, keys) {
  const out = {}
  for (const key of keys) out[key] = config?.[key]
  return out
}

/** 读 settings.json；文件不存在或坏了都返回 `{config: null}`（调用方退回 patch 默认值）。 */
export function loadSettings(home) {
  const paths = pluginPaths(home)
  try {
    if (!existsSync(paths.settings)) return { config: null, path: paths.settings, exists: false }
    const parsed = JSON.parse(readFileSync(paths.settings, 'utf8'))
    return {
      config: parsed && typeof parsed === 'object' ? parsed : null,
      path: paths.settings,
      exists: true,
    }
  } catch {
    // 坏掉的 settings.json 不该让插件带病运行 —— 退回默认值，并且不覆盖那个文件，
    // 留给你自己去看它坏在哪。
    return { config: null, path: paths.settings, exists: false, broken: true }
  }
}

/**
 * 原子写：先写临时文件再改名，避免设置页写一半时宿主读到半个 JSON。
 *
 * @param {object} config 生效配置
 * @param {string} home
 * @param {string[]} keys 允许写盘的键（传 DEFAULT_CONFIG 的键集）
 */
export function saveSettings(config, home, keys) {
  const paths = pluginPaths(home)
  mkdirSync(paths.dir, { recursive: true })
  const payload = `${JSON.stringify(keys ? sanitize(config, keys) : config, null, 2)}\n`
  atomicWrite(paths.settings, payload)
  return paths.settings
}
