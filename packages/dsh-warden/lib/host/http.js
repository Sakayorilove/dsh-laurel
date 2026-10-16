/**
 * dsh-warden · 宿主半边：HTTP 数据面
 *
 * 设置页（客户端半边）通过这几个端点读写。响应统一是 `{ ok, data }` /
 * `{ ok, error }` —— 与 Laurel 系列同一套约定。
 *
 * 路由前缀 `/warden` 要三处一致：本文件、`lib/index.js`、`lib/client/index.mjs`。
 *
 * ── 保存成功不能只看 HTTP 200（R7）─────────────────────────────────────
 * 旧版 `setConfig()` 把 `saveSettings()` 的 false 丢掉了，于是磁盘写不进去时
 * 这里照样回 `{ ok: true }`，设置页显示"保存成功"，重启后配置全丢。
 * 现在响应里带 `persisted` 与 `reason`，写失败时 `ok:false` + HTTP 500，
 * 并且明确区分"内存已生效"与"已落盘"。
 */

import { PACKAGE_NAME, PRESETS, PRESET_LABELS, PRESET_VALUES, VERSION } from '../core/config.js'
import { readEvents } from '../core/store.js'

/** 读请求体（带上限）。不是合法 JSON 就返回 null。 */
export function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { resolve(null); req.destroy?.(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

function send(res, status, payload, method = 'GET') {
  if (res.headersSent) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(method === 'HEAD' ? undefined : JSON.stringify(payload))
}

/**
 * 造 HTTP handler。宿主半边把它注册在
 * `webServer.register({ kind: 'prefix', path: '/warden' })`。
 *
 * @param {{home: string, getConfig: () => any,
 *          setConfig: (patch: object) => {config: object, persisted: boolean|null, reason: string},
 *          getPersistence: () => object, verifyPersisted: () => object,
 *          locks: any, evidence: any, counters: any, progress?: any, stages?: any,
 *          ledger?: any, governance?: any, capabilities?: any, clock?: any,
 *          stats: () => any, log?: any}} deps
 */
export function createHandler(deps) {
  const { getConfig, setConfig, locks, evidence, stats } = deps

  /** 状态快照：设置页与"用户可见状态"（S5）共用这一份。 */
  const statusPayload = () => {
    const config = getConfig()
    const now = deps.clock?.now?.() ?? Date.now()
    return {
      package: PACKAGE_NAME,
      version: VERSION,
      config,
      presets: PRESETS.map((id) => ({ id, label: PRESET_LABELS[id] ?? id, values: PRESET_VALUES[id] ?? null })),
      persistence: deps.getPersistence?.() ?? { persisted: null, reason: '未知' },
      persistedCheck: deps.verifyPersisted?.() ?? { exists: false, matches: false, reason: '未接' },
      capabilities: deps.capabilities?.snapshot?.() ?? [],
      governance: deps.governance?.snapshot?.() ?? [],
      locks: Object.values(locks?.list?.(now) ?? {}),
      lockStats: locks?.snapshot?.() ?? {},
      evidence: evidence?.stats?.() ?? { total: 0, artifacts: 0 },
      evidenceRows: evidence?.list?.(40) ?? [],
      stages: deps.stages?.list?.(20) ?? [],
      stageStats: deps.stages?.stats?.() ?? { total: 0, byStatus: {} },
      progress: deps.progress?.snapshot?.() ?? [],
      usage: deps.ledger?.list?.() ?? [],
      events: readEvents(deps.home, 60),
      stats: stats?.() ?? [],
    }
  }

  return async function handler(req, res) {
    const method = String(req.method ?? 'GET').toUpperCase()
    let path = '/'
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      path = url.pathname.replace(/^\/warden/, '') || '/'
    } catch { path = '/' }

    try {
      if (method === 'GET' || method === 'HEAD') {
        if (path === '/' || path === '/status') {
          return send(res, 200, { ok: true, data: statusPayload() }, method)
        }
        if (path === '/events') {
          return send(res, 200, { ok: true, data: { events: readEvents(deps.home, 120) } }, method)
        }
        if (path === '/capabilities') {
          return send(res, 200, {
            ok: true,
            data: {
              capabilities: deps.capabilities?.snapshot?.() ?? [],
              governance: deps.governance?.snapshot?.() ?? [],
            },
          }, method)
        }
        return send(res, 404, { ok: false, error: `未知路径 ${path}` }, method)
      }

      if (method === 'POST') {
        const body = await readJsonBody(req)
        if (path === '/config' || path === '/preset') {
          if (path === '/preset') {
            const preset = body?.preset
            if (typeof preset !== 'string' || !PRESETS.includes(preset)) {
              return send(res, 400, { ok: false, error: `preset 必须是 ${PRESETS.join(' / ')} 之一` })
            }
            // 预设就是"整份取值表换一套"；`custom` 只把当前档位标记成自定义，不改值。
            const patch = preset === 'custom' ? { preset } : { preset, ...(PRESET_VALUES[preset] ?? {}) }
            const result = setConfig(patch)
            return respondConfig(res, result)
          }
          if (!body || typeof body !== 'object' || typeof body.config !== 'object' || body.config === null) {
            return send(res, 400, { ok: false, error: '请求体必须是 { config: {...} }' })
          }
          /**
           * ⚠ 只要改单项，就把档位标成 `custom` —— **这一步必须由宿主做，不能只靠前端**。
           *
           * 原因：`normalizeConfig` 在 `input.preset` 缺失时会退回 base 的档位。
           * 于是 `{ config: { archiveToolResults: false } }` 这种请求会得到
           * 「preset 写着 balanced、但那个字段已经变了」的**幽灵状态** ——
           * 界面显示"均衡"，实际取值却偏离了，正是这套预设设计要避免的东西。
           */
          const patch = 'preset' in body.config ? body.config : { ...body.config, preset: 'custom' }
          const result = setConfig(patch)
          return respondConfig(res, result)
        }
        if (path === '/lock/release') {
          const name = body?.name
          if (typeof name !== 'string' || name.length === 0) {
            return send(res, 400, { ok: false, error: '需要 name 或 resource' })
          }
          // 设置页背后是真人，所以 actor='user'：允许强制释放活锁，
          // 但会记账（模型侧的 force 仍然只能回收陈旧锁）。
          const result = locks.release({
            resourceId: typeof body?.resource === 'string' ? body.resource : '',
            name,
            owner: '',
            force: body?.force === true,
            actor: 'user',
          })
          if (!result.ok) return send(res, 200, { ok: false, error: result.reason ?? '释放失败', data: { result } })
          return send(res, 200, { ok: true, data: { result } })
        }
        return send(res, 404, { ok: false, error: `未知路径 ${path}` })
      }

      return send(res, 405, { ok: false, error: `不支持的方法 ${method}` })
    } catch (error) {
      return send(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }
}

/**
 * 配置写入的统一响应。
 *
 * `persisted:false` 时回 **500** —— 内存里生效了但重启会丢，
 * 这不是"保存成功"，界面必须显示失败原因。
 */
function respondConfig(res, result) {
  if (result?.persisted === false) {
    return send(res, 500, {
      ok: false,
      error: `配置已在内存生效，但**写盘失败**（重启后会丢失）：${result.reason}`,
      data: { config: result.config, persisted: false, reason: result.reason },
    })
  }
  return send(res, 200, {
    ok: true,
    data: { config: result.config, persisted: result.persisted !== false, reason: result.reason ?? '已落盘' },
  })
}
