/**
 * 注入摘要消息形状回归（实机缺陷：本轮运行失败 "Cannot read properties of undefined (reading 'kind')"）。
 *
 * 实机证据（2026-10-05，会话 session-2d41159f 的 v4 会话日志）：
 *   - seq 11 agent/inbox/spliced 放入 Loom 规划提示词；
 *   - seq 12 turn/start → seq 14 turn/end，reason.kind === 'error'，
 *     error.message 正是该 TypeError；崩溃点在 step/start 之前，即 agent/pre-step 组装阶段。
 *
 * 机制：
 *   - 官方 prepend 监听会逐条读 decision.messages[i].source.kind
 *     （dsh-session-reference 的 prepareDirectMessages、dsh-time-context 的 browserTimeZone）；
 *   - 0.5.0 的注入摘要消息只有 { role, content }，没有 source / id；
 *   - 于是 note.source.kind 抛 TypeError，整轮在模型请求前死亡。
 *
 * 本文件锁死注入消息的宿主形状：id + role + content + source.kind，
 * 并模拟「按 source.kind 逐条读取」的宿主监听，确保步骤批次可被安全消费。
 */
import { describe, it } from 'node:test'
import { expect } from './helpers.mjs'
import { installInjection, resolveAgentWorkspace } from '../lib/inject.js'

// 与机器无关的通用 cwd：不写死任何一台机器的用户名，也不用脱敏占位符冒充真实路径。
// id 是 normalizeWorkspaceId 的摘要锁 —— 算法或编码一变，这里立刻红。
const CWD = 'D:\\projects\\loom-workspace'
const CWD_WORKSPACE_ID = 'ws-24f37cd942b6d111352b428aab130acabaa71bb5766b6fe5b9426a6999dfddf5'

function makeCtx() {
  const handlers = []
  return {
    handlers,
    ctx: {
      on(name, handler) { handlers.push({ name, handler }); return () => {} },
      off() {},
    },
  }
}

function makeDeps(overrides = {}) {
  const draft = overrides.draft === undefined
    ? {
        mode: 'auto',
        workflowId: 'loom-default',
        draftRevision: 2,
        lockedConstraints: [],
        architectureId: 'loom-architecture',
        architectureRevision: 1,
      }
    : overrides.draft
  return {
    store: { readDraft: () => draft },
    getConfig: () => ({ enabled: true, injectDraftSummary: true, maxInjectChars: 1200, ...(overrides.config || {}) }),
    isSessionActive: () => overrides.active !== false,
    log: { warn: overrides.warn ?? (() => {}) },
  }
}

function claimedMessage() {
  return {
    id: 'u-1',
    role: 'user',
    content: [{ type: 'text', text: '给我做一个装载机' }],
    source: { kind: 'user', rpcId: 'rpc-1', clientTimeZone: 'Asia/Hong_Kong' },
  }
}

async function runInjection(overrides = {}) {
  const { ctx, handlers } = makeCtx()
  installInjection(ctx, makeDeps(overrides))
  expect(handlers).toHaveLength(1)
  const claimed = claimedMessage()
  const payload = {
    agent: { session: { header: { cwd: overrides.cwd === undefined ? CWD : overrides.cwd } } },
    step: overrides.step === undefined ? 1 : overrides.step,
    turn: 1,
  }
  const decision = await handlers[0].handler(payload, async () => ({ kind: 'enter', messages: [claimed] }))
  return { decision, claimed }
}

describe('注入摘要 · 宿主消息形状', () => {
  it('注入消息带 id/role/content/source，整批可通过宿主的 source.kind 逐条读取', async () => {
    const { decision, claimed } = await runInjection()
    expect(decision.kind).toBe('enter')
    expect(decision.messages).toHaveLength(2)
    const note = decision.messages[1]
    expect(note === claimed).toBe(false)
    expect(note.role).toBe('user')
    expect(typeof note.id).toBe('string')
    expect(note.source && typeof note.source.kind).toBe('string')
    expect(Object.isFrozen(note)).toBe(true)

    // 模拟 dsh-session-reference.prepareDirectMessages / dsh-time-context.browserTimeZone：
    // 对批次里每一条都读 message.source.kind；0.5.0 的 { role, content } 形状会在这里抛 TypeError。
    for (const message of decision.messages) {
      expect(typeof message.source.kind).toBe('string')
    }
  })

  it('摘要文本包含模式与修订号，便于在会话记录里核对', async () => {
    const { decision } = await runInjection()
    const text = decision.messages[1].content[0].text
    expect(text).toContain('[Loom]')
    expect(text).toContain('draftRevision=2')
  })

  it('草案缺失 / 注入关闭 / 会话停用 / 工作区解析不出都不注入', async () => {
    for (const overrides of [
      { draft: null },
      { config: { injectDraftSummary: false } },
      { active: false },
      { cwd: '' },
    ]) {
      const { decision } = await runInjection(overrides)
      expect(decision.messages).toHaveLength(1)
    }
  })

  it('只在每轮第一步注入一次，后续步骤不重复', async () => {
    const { decision } = await runInjection({ step: 2 })
    expect(decision.messages).toHaveLength(1)
  })

  it('归属不一致时跳过并告警，不把别的项目草案注入本会话', async () => {
    const warnings = []
    const { decision } = await runInjection({
      draft: { mode: 'auto', workflowId: 'loom-default', draftRevision: 1, lockedConstraints: [], workspaceId: 'ws-other' },
      warn: (text) => warnings.push(text),
    })
    expect(decision.messages).toHaveLength(1)
    expect(warnings).toHaveLength(1)
  })
})

describe('注入摘要 · 工作区解析', () => {
  it('只认 agent 会话 cwd，解析出的工作区 id 与摘要算法锁死', () => {
    expect(resolveAgentWorkspace({ agent: { session: { header: { cwd: CWD } } } })).toBe(CWD_WORKSPACE_ID)
    expect(resolveAgentWorkspace({ agent: {} })).toBeNull()
    expect(resolveAgentWorkspace(undefined)).toBeNull()
  })
})
