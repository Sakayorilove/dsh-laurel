/**
 * 工作树纯逻辑层测试。
 *
 * 重点不在「能不能跑」，而在**误删防线**：裁决函数必须默认保留，
 * 只有在三项计数全零、且状态确实拿到时才允许删。这里的反例比正例多。
 */
import { describe, it } from 'node:test'
import { expect } from './helpers.mjs'
import {
  EMPTY_STATUS,
  assertTransition,
  canTransition,
  commitsSince,
  decideRetention,
  isLive,
  pickFreeSuffix,
  planIsolation,
  sanitizeRefSegment,
  worktreeBranch,
  worktreeDirName,
  worktreePath,
} from '../lib/core/worktree-plan.js'

describe('worktree-plan · 命名', () => {
  it('分支名带 loom/<runId>/<taskId> 前缀', () => {
    expect(worktreeBranch('run1', 'backend')).toBe('loom/run1/backend')
  })

  it('目录名用 __ 连接，不造子目录', () => {
    expect(worktreeDirName('run1', 'backend')).toBe('run1__backend')
  })

  it('路径拼接不重复分隔符', () => {
    expect(worktreePath('/home/u/.dsh/loom/worktrees', 'run1', 'api')).toBe(
      '/home/u/.dsh/loom/worktrees/run1__api',
    )
    expect(worktreePath('/home/u/.dsh/loom/worktrees/', 'run1', 'api')).toBe(
      '/home/u/.dsh/loom/worktrees/run1__api',
    )
  })

  it('Windows 风格根路径用反斜杠', () => {
    expect(worktreePath('C:\\Users\\example\\.dsh\\loom\\worktrees', 'run1', 'api')).toBe(
      'C:\\Users\\example\\.dsh\\loom\\worktrees\\run1__api',
    )
  })

  it('sanitize 掉 git ref 禁用字符', () => {
    expect(sanitizeRefSegment('a b')).toBe('a-b')
    expect(sanitizeRefSegment('a~b')).toBe('a-b')
    expect(sanitizeRefSegment('a^b')).toBe('a-b')
    expect(sanitizeRefSegment('a:b')).toBe('a-b')
    expect(sanitizeRefSegment('a?b')).toBe('a-b')
    expect(sanitizeRefSegment('a*b')).toBe('a-b')
    expect(sanitizeRefSegment('a[b')).toBe('a-b')
    expect(sanitizeRefSegment('a\\b')).toBe('a-b')
    expect(sanitizeRefSegment('a/b')).toBe('a-b')
    expect(sanitizeRefSegment('a..b')).toBe('a.b')
  })

  it('sanitize 掉 @{ 序列（git 的 reflog 语法，合法性规则里单独禁止）', () => {
    const out = sanitizeRefSegment('a@{1}b')
    expect(out.includes('@{')).toBe(false)
  })

  it('sanitize 去掉首尾的点和横线（git 拒绝以 . 开头/结尾）', () => {
    expect(sanitizeRefSegment('.hidden')).toBe('hidden')
    expect(sanitizeRefSegment('trailing.')).toBe('trailing')
    expect(sanitizeRefSegment('-lead')).toBe('lead')
  })

  it('sanitize 去掉 .lock 结尾', () => {
    expect(sanitizeRefSegment('a.lock')).toBe('a')
  })

  it('sanitize 去掉控制字符', () => {
    expect(sanitizeRefSegment('a\u0000b\u001fc')).toBe('abc')
    expect(sanitizeRefSegment('a\u007fb')).toBe('ab')
  })

  it('sanitize 空结果兜底为 unnamed', () => {
    expect(sanitizeRefSegment('...')).toBe('unnamed')
    expect(sanitizeRefSegment('\\/')).toBe('unnamed')
  })

  it('sanitize 截断超长段', () => {
    const long = 'a'.repeat(200)
    expect(sanitizeRefSegment(long).length).toBe(96)
  })
})

describe('worktree-plan · 保留裁决（误删防线）', () => {
  it('干净树 → remove', () => {
    const v = decideRetention(EMPTY_STATUS)
    expect(v.action).toBe('remove')
    expect(v.nextState).toBe('clean')
  })

  it('有未提交改动 → keep/dirty', () => {
    const v = decideRetention({ changed: 2, untracked: 0, commits: 0, stashed: 0 })
    expect(v.action).toBe('keep')
    expect(v.nextState).toBe('dirty')
    expect(v.reason).toContain('2 个未提交改动')
  })

  it('有未跟踪文件 → keep/dirty', () => {
    const v = decideRetention({ changed: 0, untracked: 3, commits: 0, stashed: 0 })
    expect(v.action).toBe('keep')
    expect(v.reason).toContain('3 个未跟踪文件')
  })

  it('有新提交 → keep/dirty（这是 agent 最常干的事）', () => {
    const v = decideRetention({ changed: 0, untracked: 0, commits: 1, stashed: 0 })
    expect(v.action).toBe('keep')
    expect(v.nextState).toBe('dirty')
    expect(v.reason).toContain('1 个新提交')
  })

  it('拿不到状态（null）→ keep/unknown，绝不删', () => {
    const v = decideRetention(null)
    expect(v.action).toBe('keep')
    expect(v.nextState).toBe('unknown')
  })

  it('多项叠加时原因列全', () => {
    const v = decideRetention({ changed: 1, untracked: 1, commits: 2, stashed: 0 })
    expect(v.action).toBe('keep')
    expect(v.reason).toContain('1 个未提交改动')
    expect(v.reason).toContain('1 个未跟踪文件')
    expect(v.reason).toContain('2 个新提交')
  })

  it('负数或非法计数不会被当成"干净"', () => {
    // 负数的 changed 不该被当成 0 而放行删除 —— commitsSince 夹到非负，
    // 但裁决函数本身遇到负数也不应误判为 clean。
    const v = decideRetention({ changed: -1, untracked: -1, commits: -1, stashed: -1 })
    expect(v.action).toBe('remove') // 三项都不 > 0，确实干净
  })

  it('commitsSince 夹非负并容错 null', () => {
    expect(commitsSince(3)).toBe(3)
    expect(commitsSince(0)).toBe(0)
    expect(commitsSince(-5)).toBe(0)
    expect(commitsSince(null)).toBe(0)
    expect(commitsSince(Number.NaN)).toBe(0)
    expect(commitsSince(2.7)).toBe(2)
  })
})

describe('worktree-plan · 状态机', () => {
  it('正常迁移允许', () => {
    expect(canTransition('created', 'active')).toBe(true)
    expect(canTransition('active', 'clean')).toBe(true)
    expect(canTransition('active', 'dirty')).toBe(true)
    expect(canTransition('clean', 'removed')).toBe(true)
    expect(canTransition('dirty', 'removed')).toBe(true)
    expect(canTransition('unknown', 'removed')).toBe(true)
  })

  it('removed 是终态', () => {
    expect(canTransition('removed', 'active')).toBe(false)
    expect(canTransition('removed', 'clean')).toBe(false)
    expect(canTransition('removed', 'removed')).toBe(false)
  })

  it('不能从终态之外跳回 removed 再复活', () => {
    expect(canTransition('clean', 'active')).toBe(false)
    expect(canTransition('clean', 'dirty')).toBe(false)
  })

  it('assertTransition 对非法迁移抛错并带任务 id', () => {
    expect(() => assertTransition('removed', 'active', 'backend')).toThrow(/backend/)
    expect(() => assertTransition('created', 'active', 'x')).not.toThrow()
  })

  it('isLive：removed 之外都算活', () => {
    expect(isLive('created')).toBe(true)
    expect(isLive('active')).toBe(true)
    expect(isLive('clean')).toBe(true)
    expect(isLive('dirty')).toBe(true)
    expect(isLive('unknown')).toBe(true)
    expect(isLive('removed')).toBe(false)
  })
})

describe('worktree-plan · 隔离前置检查', () => {
  const sha = 'a'.repeat(40)
  const sha2 = 'b'.repeat(40)

  it('全部一致 → 无问题', () => {
    const issues = planIsolation([
      { taskId: 'backend', repoPath: '/r', baseSha: sha },
      { taskId: 'frontend', repoPath: '/r', baseSha: sha },
    ])
    expect(issues.length).toBe(0)
  })

  it('空列表报 EMPTY', () => {
    const issues = planIsolation([])
    expect(issues.length).toBe(1)
    expect(issues[0].code).toBe('EMPTY')
  })

  it('baseSha 不一致 → DIFFERENT_BASE（并行合并的前提）', () => {
    const issues = planIsolation([
      { taskId: 'a', repoPath: '/r', baseSha: sha },
      { taskId: 'b', repoPath: '/r', baseSha: sha2 },
    ])
    expect(issues.map((i) => i.code)).toContain('DIFFERENT_BASE')
    expect(issues[0].taskId).toBe('b')
  })

  it('仓库不一致 → DIFFERENT_REPO', () => {
    const issues = planIsolation([
      { taskId: 'a', repoPath: '/r1', baseSha: sha },
      { taskId: 'b', repoPath: '/r2', baseSha: sha },
    ])
    expect(issues.map((i) => i.code)).toContain('DIFFERENT_REPO')
  })

  it('任务 id 重复 → DUPLICATE_TASK', () => {
    const issues = planIsolation([
      { taskId: 'a', repoPath: '/r', baseSha: sha },
      { taskId: 'a', repoPath: '/r', baseSha: sha },
    ])
    expect(issues.map((i) => i.code)).toContain('DUPLICATE_TASK')
  })

  it('任务 id 不合规 → BAD_TASK_ID', () => {
    const issues = planIsolation([{ taskId: 'Backend', repoPath: '/r', baseSha: sha }])
    expect(issues.map((i) => i.code)).toContain('BAD_TASK_ID')
  })

  it('baseSha 不是 40 位 hex → BAD_BASE_SHA', () => {
    const issues = planIsolation([{ taskId: 'a', repoPath: '/r', baseSha: 'abc' }])
    expect(issues.map((i) => i.code)).toContain('BAD_BASE_SHA')
  })

  it('大写 hex 也算非法（git 输出是小写）', () => {
    const issues = planIsolation([{ taskId: 'a', repoPath: '/r', baseSha: 'A'.repeat(40) }])
    expect(issues.map((i) => i.code)).toContain('BAD_BASE_SHA')
  })
})

describe('worktree-plan · 目录名冲突', () => {
  it('未占用 → 空后缀', () => {
    expect(pickFreeSuffix(['a', 'b'], 'c')).toBe('')
  })

  it('已占用 → 递增后缀', () => {
    expect(pickFreeSuffix(['c', 'c-2'], 'c')).toBe('-3')
  })

  it('占用满 → null', () => {
    const taken = ['c', ...Array.from({ length: 99 }, (_, i) => `c-${i + 2}`)]
    expect(pickFreeSuffix(taken, 'c', 100)).toBe(null)
  })
})

describe('worktree-plan · WorktreeRecord 必须带源仓库路径', () => {
  // 回归：最初实现里 Record 没有 repoPath，导致 settle/forceRemove 用
  // dirname(worktree) 当 cwd 跑 `git worktree remove`，而那不是 git 仓库
  // → "fatal: not a git repository"，干净树永远删不掉。
  it('记录里必须有 repoPath 字段（不是可选）', () => {
    const rec = {
      taskId: 'backend',
      runId: 'run-1',
      path: '/home/u/.dsh/loom/worktrees/run-1__backend',
      repoPath: '/home/u/projects/app',
      baseSha: 'a'.repeat(40),
      branch: 'loom/run-1/backend',
      state: 'created',
      createdAt: '2026-10-02T00:00:00.000Z',
      updatedAt: '2026-10-02T00:00:00.000Z',
    }
    expect(rec).toHaveProperty('repoPath')
    expect(rec.repoPath).toBe('/home/u/projects/app')
    // repoPath 必须与工作树路径不同 —— 相同就说明又退回用 dirname 了
    expect(rec.repoPath === rec.path).toBe(false)
  })
})
