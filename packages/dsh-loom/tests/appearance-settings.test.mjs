import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { DEFAULT_CONFIG, normalizeConfig, validateConfigPatch } from '../lib/config.js'

let loaded
const window = { __loomAllowTestHooks: true, __ModuleLoader__: { load: x => { loaded = x } } }
runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), { window })
const welcomeLineStyle = loaded.factory(() => ({})).welcomeLineStyle
const clientExports = loaded.factory(() => ({}))

test('appearance settings: defaults, normalization and validation', () => {
  assert.equal(DEFAULT_CONFIG.planningModeColor, '#6ea8fe')
  assert.equal(DEFAULT_CONFIG.welcomeEnabled, true)
  assert.equal(DEFAULT_CONFIG.welcomeFontSize, 16)
  assert.equal(normalizeConfig({}).planningModeColor, '#6ea8fe')
  assert.equal(normalizeConfig({ planningModeColor: 'not-a-color' }).planningModeColor, '#6ea8fe', '非法颜色回落默认')
  assert.equal(normalizeConfig({ planningModeColor: '#62D6A4' }).planningModeColor, '#62D6A4')
  assert.equal(normalizeConfig({ welcomeFontSize: 99 }).welcomeFontSize, 28, '字号钳到上限 28')
  assert.equal(normalizeConfig({ welcomeGlow: 9 }).welcomeGlow, 3, '发光强度钳到上限 3')
  validateConfigPatch({ planningModeColor: '#62d6a4', welcomeEnabled: false, welcomeFontSize: 20, welcomeGlow: 3, welcomeStroke: 1, welcomeStrokeColor: '#000000' })
  assert.throws(() => validateConfigPatch({ planningModeColor: 'red' }), /planningModeColor/)
  assert.throws(() => validateConfigPatch({ welcomeFontSize: 100 }), /welcomeFontSize/)
  assert.throws(() => validateConfigPatch({ welcomeGlow: -1 }), /welcomeGlow/)
  assert.throws(() => validateConfigPatch({ welcomeStroke: 3 }), /welcomeStroke/)
  assert.throws(() => validateConfigPatch({ welcomeEnabled: 'yes' }), /welcomeEnabled/)
})

test('welcomeLineStyle maps config to font, colour, glow and stroke', () => {
  const base = welcomeLineStyle({ welcomeFont: 'inherit', welcomeFontSize: 16, welcomeColor: '#e6e8ea', welcomeGlow: 1, welcomeStroke: 0, welcomeStrokeColor: '#0b0d10' })
  assert.equal(base.fontFamily, 'inherit')
  assert.equal(base.fontSize, '16px')
  assert.equal(base.color, '#e6e8ea')
  assert.match(base.textShadow, /#e6e8ea/)
  assert.equal(Object.hasOwn(base, 'WebkitTextStroke'), false, '描边为 0 时不应设置 -webkit-text-stroke')
  const strong = welcomeLineStyle({ welcomeFont: 'Georgia', welcomeFontSize: 22, welcomeColor: '#62d6a4', welcomeGlow: 3, welcomeStroke: 1.5, welcomeStrokeColor: '#101010' })
  assert.equal(strong.fontFamily, 'Georgia')
  assert.equal(strong.fontSize, '22px')
  assert.equal(strong.WebkitTextStroke, '1.5px #101010')
  assert.equal(welcomeLineStyle({ welcomeGlow: 0 }).textShadow, 'none', '发光 0 时不加阴影')
  assert.equal(welcomeLineStyle({}).fontSize, '16px', '缺配置时用安全默认')
})

test('default planning mode is a typed setting, off unless asked (S7)', () => {
  assert.equal(DEFAULT_CONFIG.planningModeDefault, false, '默认不开启：老用户行为不变')
  assert.equal(normalizeConfig({}).planningModeDefault, false)
  assert.equal(normalizeConfig({ planningModeDefault: true }).planningModeDefault, true)
  assert.equal(normalizeConfig({ planningModeDefault: 'yes' }).planningModeDefault, false, '非布尔值回落默认')
  validateConfigPatch({ planningModeDefault: true })
  assert.throws(() => validateConfigPatch({ planningModeDefault: 'yes' }), /planningModeDefault/)
})

test('injection status tells the user whether the DOM heuristics found their target (S7)', () => {
  const status = clientExports.appearanceInjectionText
  assert.match(status(true), /已注入/)
  assert.match(status(false), /未找到目标/)
  assert.match(status(false), /不影响其他功能/)
  assert.match(status('conversation'), /已有对话里不显示/)
  assert.match(status(null), /还没试过/)
  assert.match(status(undefined), /还没试过/)
  // 设置页读的就是这份状态；字段名变化要让这个用例先红。
  assert.deepEqual(Object.keys(clientExports.appearanceStatus).sort(), ['at', 'composerGlow', 'welcomeLine'])
})

test('the welcome line belongs to the brand-new session page only (user request)', () => {
  const visible = clientExports.welcomeLineVisible
  const on = { enabled: true, welcomeEnabled: true }
  // 已有对话（宿主选中了会话）里不显示 —— 哪怕这个会话还是空的（宿主对空会话同样渲染 hero）。
  assert.equal(visible(on, 'session-abc'), false)
  // 全新会话页（没选中会话）才显示。
  assert.equal(visible(on, ''), true)
  assert.equal(visible(on, undefined), true)
  assert.equal(visible(on, null), true)
  // 总开关 / 题词开关关掉：哪都不显示。
  assert.equal(visible({ ...on, welcomeEnabled: false }, ''), false)
  assert.equal(visible({ ...on, enabled: false }, ''), false)
  assert.equal(visible(null, ''), false)
})
