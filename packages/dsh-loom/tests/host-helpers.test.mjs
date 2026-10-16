import assert from 'node:assert/strict'
import { loadHostHelpers } from '../lib/host-helpers.js'
// 宿主锚点可配置、可校验：原来这里写死了一个占位符路径，既不可能是真的，
// 也让这个用例在任何人机器上「看着像跑了」——现在没有宿主就明确 skip 并说明怎么准备。
import { hostTest, hostAnchor } from '../scripts/host-anchor.mjs'

hostTest('installed host public exports resolve (no sessions or model calls)', () => {
  const entry = process.argv[1]
  try {
    // loadHostHelpers() 从 process.argv[1] 起解析宿主模块，所以这里把锚点临时放进去。
    process.argv[1] = hostAnchor
    const helpers = loadHostHelpers()
    for (const key of ['createUserMessage', 'childSessionMeta', 'resolveChildAgentOptions', 'foldConsumedWork', 'finalAssistantOutput']) assert.equal(typeof helpers[key], 'function', key)
  } finally { process.argv[1] = entry }
})
