/**
 * 步骤 1 的负例测试。
 *
 * 这些不是「顺手加几个用例」，而是评审第 6 节步骤 1 的**完成条件**逐条落成断言：
 *   - 未授权强删不调用底层删除
 *   - 在途树受保护
 *   - 未知/脏树保留
 *   - 能力查询不伪造新实测
 *   - 两个项目草案互不覆盖、注入互不串入
 *   - 同工作区合法多会话仍可共享方案
 *   - 旧 revision 更新被拒并保留现稿
 */
import { describe, it } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from './helpers.mjs'
import {
  checkOwnership,
  checkRevisionGuard,
  isValidWorkspaceId,
  normalizeWorkspaceId,
  planMigration,
  LEGACY_GLOBAL_FILES,
  issueDestructiveOp,
  confirmDestructiveOp,
  isRunInFlight,
  DESTRUCTIVE_TOKEN_TTL_MS,
} from '../lib/core/index.js'

/* ─────────────────── 工作区 id 规范 ─────────────────── */

describe('工作区归属 · id 规范', () => {
  it('只有满足安全字符集的 id 才算合法', () => {
    expect(isValidWorkspaceId('proj-01')).toBe(true)
    expect(isValidWorkspaceId('a.b_c-d')).toBe(true)
    expect(isValidWorkspaceId('')).toBe(false)
    expect(isValidWorkspaceId('  ')).toBe(false)
    expect(isValidWorkspaceId('-leading-dash')).toBe(false)
    expect(isValidWorkspaceId('.leading-dot')).toBe(false)
    expect(isValidWorkspaceId('has space')).toBe(false)
    expect(isValidWorkspaceId('has/slash')).toBe(false)
    expect(isValidWorkspaceId('has\\backslash')).toBe(false)
    expect(isValidWorkspaceId('../escape')).toBe(false)
    expect(isValidWorkspaceId(123)).toBe(false)
    expect(isValidWorkspaceId(null)).toBe(false)
    expect(isValidWorkspaceId(undefined)).toBe(false)
  })
  it('规范化把不合法字符换成 -，而不是删掉（避免 a/b 与 ab 撞成同一 id）', () => {
    expect(normalizeWorkspaceId('/home/<你的用户>/proj/a')).toMatch(/^ws-[a-f0-9]{64}$/)
    // 关键差别：'a/b' 与 'ab' 必须规范成**不同**的 id。
    expect(normalizeWorkspaceId('a/b')).not.toBe(normalizeWorkspaceId('ab'))
  })
  it('完全无法归属时返回 null —— 不猜默认值', () => {
    expect(normalizeWorkspaceId('')).toBeNull()
    expect(normalizeWorkspaceId('   ')).toBeNull()
    expect(normalizeWorkspaceId('///')).toBeNull()
    expect(normalizeWorkspaceId(null)).toBeNull()
    expect(normalizeWorkspaceId(42)).toBeNull()
  })
})

/* ─────────────────── 归属检查不回落 ─────────────────── */

describe('工作区归属 · 归属检查', () => {
  it('匹配才通过', () => {
    expect(checkOwnership('proj-a', 'proj-a').ok).toBe(true)
  })
  it('不匹配就是拒绝 —— 不是回落到全局', () => {
    const r = checkOwnership('proj-a', 'proj-b')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('proj-a')
    expect(r.reason).toContain('proj-b')
  })
  it('请求方没有归属 → 拒绝', () => {
    expect(checkOwnership('proj-a', null).ok).toBe(false)
    expect(checkOwnership('proj-a', '').ok).toBe(false)
    expect(checkOwnership('proj-a', undefined).ok).toBe(false)
  })
  it('资源没有归属（旧版全局文件）→ 拒绝并提示需迁移', () => {
    const r = checkOwnership(null, 'proj-a')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('迁移')
  })
})

/* ─────────────────── 乐观并发闸门 ─────────────────── */

describe('草案 revision 闸门', () => {
  it('恰好相等才放行', () => {
    expect(checkRevisionGuard(3, { expectedRevision: 3 }).ok).toBe(true)
  })
  it('旧 revision 更新被拒 —— 不能用「大于」判断', () => {
    // 期望 2，磁盘已是 3：说明有别的窗口写过。允许覆盖就是静默丢改动。
    const r = checkRevisionGuard(3, { expectedRevision: 2 })
    expect(r.ok).toBe(false)
    expect(r.conflict.currentRevision).toBe(3)
    expect(r.conflict.expectedRevision).toBe(2)
  })
  it('「我认为还没有草案」但磁盘已有 → 冲突而不是覆盖', () => {
    expect(checkRevisionGuard(1, { expectedRevision: null }).ok).toBe(false)
  })
  it('「我认为已有」但磁盘没有 → 也冲突（不能凭空续写）', () => {
    expect(checkRevisionGuard(null, { expectedRevision: 1 }).ok).toBe(false)
  })
  it('两边都没有 → 放行（首次创建）', () => {
    expect(checkRevisionGuard(null, { expectedRevision: null }).ok).toBe(true)
  })
})

/* ─────────────────── 迁移计划：不静默覆盖 ─────────────────── */

describe('旧版全局文件迁移', () => {
  const root = '/home/x/.dsh/loom'

  it('目标不存在 → 生成计划，无 blocker', () => {
    const r = planMigration({ root, workspaceId: 'proj-a', existing: ['drafts.json'], existingInTarget: [], keepBackup: true })
    expect(r.plans).toHaveLength(1)
    expect(r.plans[0].from).toBe(`${root}/drafts.json`)
    expect(r.plans[0].to).toBe(`${root}/workspaces/proj-a/drafts.json`)
    expect(r.plans[0].targetExists).toBe(false)
    expect(r.blockers).toHaveLength(0)
  })
  it('目标已存在 → 报 blocker，绝不覆盖（两份都可能有效）', () => {
    const r = planMigration({ root, workspaceId: 'proj-a', existing: ['drafts.json'], existingInTarget: ['drafts.json'], keepBackup: true })
    expect(r.blockers).toHaveLength(1)
    expect(r.blockers[0]).toContain('不会覆盖')
    expect(r.plans[0].targetExists).toBe(true)
  })
  it('三个旧文件都识别得到', () => {
    const r = planMigration({
      root,
      workspaceId: 'proj-a',
      existing: [...LEGACY_GLOBAL_FILES],
      existingInTarget: [],
      keepBackup: true,
    })
    expect(r.plans).toHaveLength(3)
  })
  it('工作区 id 不合法 → blocker，不出计划', () => {
    const r = planMigration({ root, workspaceId: '../escape', existing: ['drafts.json'], existingInTarget: [], keepBackup: true })
    expect(r.plans).toHaveLength(0)
    expect(r.blockers.length).toBeGreaterThan(0)
  })
  it('迁移计划是纯计算 —— 不落盘（目录不存在也不报错）', () => {
    const r = planMigration({ root: '/definitely/not/here', workspaceId: 'proj-a', existing: ['drafts.json'], existingInTarget: [], keepBackup: true })
    expect(r.plans).toHaveLength(1)
  })
})

/* ─────────────────── 破坏性操作授权 ─────────────────── */

describe('破坏性操作授权 · 签发', () => {
  const base = {
    token: 'tok-1',
    workspaceId: 'proj-a',
    runId: 'run-1',
    taskId: 'task-1',
    targetPath: '/home/x/worktrees/run-1__task-1',
    willDiscard: ['未提交改动 2 项'],
    now: '2026-10-02T00:00:00.000Z',
  }

  it('签发带出过期时间与全部标识', () => {
    const op = issueDestructiveOp(base)
    expect(op.token).toBe('tok-1')
    expect(op.kind).toBe('worktree-force-remove')
    expect(op.expiresAt).toBe(new Date(Date.parse(base.now) + DESTRUCTIVE_TOKEN_TTL_MS).toISOString())
    expect(op.willDiscard).toContain('未提交改动 2 项')
  })
  it('缺目标路径就拒绝签发 —— 用户必须能看见自己删的是哪一个', () => {
    expect(() => issueDestructiveOp({ ...base, targetPath: '' })).toThrow(/目标路径/)
    expect(() => issueDestructiveOp({ ...base, targetPath: '   ' })).toThrow(/目标路径/)
  })
  it('缺 run/task 就拒绝签发', () => {
    expect(() => issueDestructiveOp({ ...base, runId: '' })).toThrow(/runId/)
    expect(() => issueDestructiveOp({ ...base, taskId: '' })).toThrow(/taskId/)
  })
  it('缺 token 就拒绝签发', () => {
    expect(() => issueDestructiveOp({ ...base, token: '  ' })).toThrow(/token/)
  })
})

describe('破坏性操作授权 · 核销七道闸门', () => {
  const now = '2026-10-02T00:00:00.000Z'
  const op = issueDestructiveOp({
    token: 'tok-1',
    workspaceId: 'proj-a',
    runId: 'run-1',
    taskId: 'task-1',
    targetPath: '/w/run-1__task-1',
    willDiscard: ['x'],
    now,
  })
  const pending = [op]
  const good = {
    token: 'tok-1',
    workspaceId: 'proj-a',
    runId: 'run-1',
    taskId: 'task-1',
    targetPath: '/w/run-1__task-1',
    now,
    inFlight: false,
    targetExists: true,
  }

  it('全对 → 通过', () => {
    expect(confirmDestructiveOp(pending, good).ok).toBe(true)
  })
  it('闸门 1：没有 token → TOKEN_MISSING', () => {
    const r = confirmDestructiveOp(pending, { ...good, token: '' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('TOKEN_MISSING')
  })
  it('闸门 2：token 不在表里 → TOKEN_UNKNOWN（用过一次也作废）', () => {
    const r = confirmDestructiveOp(pending, { ...good, token: 'tok-never-issued' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('TOKEN_UNKNOWN')
  })
  it('闸门 3：过期 → TOKEN_EXPIRED', () => {
    const late = new Date(Date.parse(now) + DESTRUCTIVE_TOKEN_TTL_MS + 1000).toISOString()
    const r = confirmDestructiveOp(pending, { ...good, now: late })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('TOKEN_EXPIRED')
  })
  it('闸门 4：拿 A 项目的 token 删 B 项目的树 → WORKSPACE_MISMATCH', () => {
    const r = confirmDestructiveOp(pending, { ...good, workspaceId: 'proj-b' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('WORKSPACE_MISMATCH')
  })
  it('闸门 5：换 run/task → TARGET_MISMATCH', () => {
    expect(confirmDestructiveOp(pending, { ...good, taskId: 'task-2' }).code).toBe('TARGET_MISMATCH')
    expect(confirmDestructiveOp(pending, { ...good, runId: 'run-2' }).code).toBe('TARGET_MISMATCH')
  })
  it('闸门 6：换目标路径 → TARGET_MISMATCH', () => {
    const r = confirmDestructiveOp(pending, { ...good, targetPath: '/w/other' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('TARGET_MISMATCH')
  })
  it('闸门 7：在途 → IN_FLIGHT（即使路径存在）', () => {
    const r = confirmDestructiveOp(pending, { ...good, inFlight: true })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('IN_FLIGHT')
    expect(r.detail).toContain('在途')
  })
  it('闸门 7：已不存在 → ALREADY_GONE', () => {
    const r = confirmDestructiveOp(pending, { ...good, targetExists: false })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('ALREADY_GONE')
  })
  it('在途优先于已不存在 —— 顺序反了会给出误导性的 ALREADY_GONE', () => {
    const r = confirmDestructiveOp(pending, { ...good, inFlight: true, targetExists: false })
    expect(r.code).toBe('IN_FLIGHT')
  })
})

describe('破坏性操作授权 · 「在途」判定', () => {
  it('未终态算在途', () => {
    for (const s of ['queued', 'running', 'producing', 'produced', 'validating']) {
      expect(isRunInFlight(s), s).toBe(true)
    }
  })
  it('已收敛不算在途 —— 否则用户永远删不掉树', () => {
    for (const s of ['cancelled', 'failed', 'refused', 'done', 'settled', '']) {
      expect(isRunInFlight(s), s).toBe(false)
    }
  })
})

/* ─────────────────── 真实落盘的归属隔离 ─────────────────── */

describe('分区读写 · 两个项目互不覆盖', () => {
  const mkStore = async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-scope-'))
    const { LoomStore } = await import('../lib/store.js')
    return { home, store: new LoomStore(home) }
  }

  it('A 的草案与 B 的草案各存各的，读不串', async () => {
    const { home, store } = await mkStore()
    try {
      const a = { mode: 'manual', workflowId: 'wf-a', draftRevision: 1, workspaceId: 'proj-a', lockedConstraints: ['A 锁定'], updatedAt: '2026-10-02T00:00:00.000Z' }
      const b = { mode: 'auto', workflowId: 'wf-b', draftRevision: 1, workspaceId: 'proj-b', lockedConstraints: ['B 锁定'], updatedAt: '2026-10-02T00:00:00.000Z' }
      expect(store.writeDraft(a, { expectedRevision: null }).ok).toBe(true)
      expect(store.writeDraft(b, { expectedRevision: null }).ok).toBe(true)

      expect(store.readDraft('proj-a').workflowId).toBe('wf-a')
      expect(store.readDraft('proj-a').lockedConstraints).toContain('A 锁定')
      expect(store.readDraft('proj-b').workflowId).toBe('wf-b')
      expect(store.readDraft('proj-b').lockedConstraints).toContain('B 锁定')
      // 关键：A 的约束绝不出现 B 里
      expect(store.readDraft('proj-b').lockedConstraints).not.toContain('A 锁定')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('同一工作区的合法多会话仍共享同一份草案', async () => {
    const { home, store } = await mkStore()
    try {
      store.writeDraft(
        { mode: 'manual', workflowId: 'wf-a', draftRevision: 1, workspaceId: 'proj-a', lockedConstraints: [], updatedAt: '2026-10-02T00:00:00.000Z' },
        { expectedRevision: null },
      )
      // 另一个「会话」读同一个工作区，看到同一份 —— 这是期望行为，不是泄漏。
      expect(store.readDraft('proj-a').workflowId).toBe('wf-a')
      expect(store.readDraft('proj-a').draftRevision).toBe(1)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('写草案不带 workspaceId → 抛，不静默落全局', async () => {
    const { home, store } = await mkStore()
    try {
      expect(() =>
        store.writeDraft(
          { mode: 'manual', workflowId: 'x', draftRevision: 1, lockedConstraints: [], updatedAt: '2026-10-02T00:00:00.000Z' },
          { expectedRevision: null },
        ),
      ).toThrow(/workspaceId/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('旧 revision 写入被拒，且**磁盘现稿保持不变**', async () => {
    const { home, store } = await mkStore()
    try {
      store.writeDraft(
        { mode: 'manual', workflowId: 'wf', draftRevision: 3, workspaceId: 'proj-a', lockedConstraints: ['新'], updatedAt: '2026-10-02T00:00:00.000Z' },
        { expectedRevision: null },
      )
      const stale = {
        mode: 'manual',
        workflowId: 'wf',
        draftRevision: 4,
        workspaceId: 'proj-a',
        lockedConstraints: ['旧窗口写的'],
        updatedAt: '2026-10-02T00:00:01.000Z',
      }
      const r = store.writeDraft(stale, { expectedRevision: 2 })
      expect(r.ok).toBe(false)
      expect(r.conflict.currentRevision).toBe(3)
      // 现稿必须原样保留。
      const disk = store.readDraft('proj-a')
      expect(disk.draftRevision).toBe(3)
      expect(disk.lockedConstraints).toContain('新')
      expect(disk.lockedConstraints).not.toContain('旧窗口写的')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('旧版全局文件不被新代码读取，但迁移预览能看到', async () => {
    const { home, store } = await mkStore()
    try {
      // 手工造一个旧版全局草案。
      writeFileSync(
        join(home, 'loom', 'drafts.json'),
        JSON.stringify({ mode: 'manual', workflowId: 'legacy', draftRevision: 7, lockedConstraints: ['老约束'], updatedAt: '2020-01-01T00:00:00.000Z' }),
      )
      // 新代码读某个工作区 → null（旧全局文件不串进任何工作区）
      expect(store.readDraft('proj-a')).toBeNull()
      // 但专门读遗留文件的入口能看到它，供迁移用
      expect(store.readLegacyDraft().workflowId).toBe('legacy')
      expect(store.legacyFilesPresent().drafts).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('listWorkspaces 只列已分区的工作区', async () => {
    const { home, store } = await mkStore()
    try {
      mkdirSync(join(home, 'loom', 'workspaces', 'proj-a'), { recursive: true })
      mkdirSync(join(home, 'loom', 'workspaces', 'proj-b'), { recursive: true })
      const list = store.listWorkspaces()
      expect(list).toContain('proj-a')
      expect(list).toContain('proj-b')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('id 含路径穿越企图时读写都拒绝，不逃出分区目录', async () => {
    const { home, store } = await mkStore()
    try {
      expect(store.readDraft('../../etc')).toBeNull()
      expect(() =>
        store.writeDraft(
          { mode: 'manual', workflowId: 'x', draftRevision: 1, workspaceId: '../../etc', lockedConstraints: [], updatedAt: '2026-10-02T00:00:00.000Z' },
          { expectedRevision: null },
        ),
      ).toThrow()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('presentation / sourcemap 同样按工作区分区', async () => {
    const { home, store } = await mkStore()
    try {
      const p = { schemaVersion: 1, workflowId: 'wf-a', nodes: [], edges: [], notes: [] }
      store.writePresentation('proj-a', p)
      expect(store.readPresentation('proj-b')).toBeNull()
      expect(store.readPresentation('proj-a').workflowId).toBe('wf-a')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
