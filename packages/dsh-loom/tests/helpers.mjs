/**
 * 极小的断言助手。用 node:test + node:assert，不引入任何测试框架。
 * 形状故意做成链式，读起来和主流断言库一样，但代码全在这里。
 */
import assert from 'node:assert/strict'

function matchers(actual, msg, negated) {
  const fail = (ok, text) => {
    if (negated ? ok : !ok) assert.fail(msg ? `${msg}：${text}` : text)
  }
  return {
    toBe(expected) {
      fail(Object.is(actual, expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
    },
    toEqual(expected) {
      let same = true
      try {
        assert.deepStrictEqual(actual, expected)
      } catch {
        same = false
      }
      fail(same, `期望深等于 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
    },
    toContain(needle) {
      const ok = typeof actual === 'string' ? actual.includes(needle) : Array.isArray(actual) && actual.includes(needle)
      fail(ok, `期望包含 ${JSON.stringify(needle)}`)
    },
    toMatch(re) {
      fail(typeof actual === 'string' && re.test(actual), `期望匹配 ${re}`)
    },
    toBeGreaterThan(n) {
      fail(typeof actual === 'number' && actual > n, `期望 > ${n}，实际 ${actual}`)
    },
    toBeNull() {
      fail(actual === null, `期望 null，实际 ${JSON.stringify(actual)}`)
    },
    toBeDefined() {
      fail(actual !== undefined, '期望已定义')
    },
    toBeTruthy() {
      fail(Boolean(actual), `期望为真，实际 ${JSON.stringify(actual)}`)
    },
    toHaveLength(n) {
      fail(actual && actual.length === n, `期望长度 ${n}，实际 ${actual && actual.length}`)
    },
    toHaveProperty(key) {
      fail(actual != null && Object.prototype.hasOwnProperty.call(actual, key), `期望有属性 ${key}`)
    },
    toThrow(matcher) {
      let thrown = null
      try {
        actual()
      } catch (error) {
        thrown = error
      }
      if (!thrown) {
        fail(false, '期望抛错，但没有')
        return
      }
      if (matcher === undefined) {
        fail(true, '')
        return
      }
      // 支持两种写法：传正则匹配 message，传构造函数检查 instanceof。
      if (typeof matcher === 'function') {
        fail(thrown instanceof matcher, `期望抛 ${matcher.name}，实际抛 ${thrown.constructor?.name}：${thrown.message}`)
        return
      }
      fail(matcher.test(String(thrown.message)), `期望错误信息匹配 ${matcher}，实际「${thrown.message}」`)
    },
  }
}

export function expect(actual, msg) {
  const base = matchers(actual, msg, false)
  const neg = matchers(actual, msg, true)
  return Object.assign({}, base, {
    not: {
      toBe: neg.toBe,
      toEqual: neg.toEqual,
      toContain: neg.toContain,
      toMatch: neg.toMatch,
      toBeNull: neg.toBeNull,
      toHaveProperty: neg.toHaveProperty,
      toThrow: neg.toThrow,
    },
  })
}
