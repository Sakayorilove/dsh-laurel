/**
 * 静态检查：把 tests/*.mjs 里 <script> 内联块抽出来做语法检查。
 *
 * 为什么需要：页面的内联脚本是**字符串**，`node --check` 只看得到外层模块，
 * 内联块里少个括号它完全不报 —— 只有真跑起来才知道。
 * 这个检查把「跑起来才知道」提前到「提交前就知道」。
 *
 * 用法：node scripts/check-inline-scripts.mjs tests/browser-harness.mjs
 */
import { readFileSync } from 'node:fs'

const files = process.argv.slice(2)
if (!files.length) {
  console.error('用法：node scripts/check-inline-scripts.mjs <file...>')
  process.exit(2)
}

let bad = 0
for (const file of files) {
  const src = readFileSync(file, 'utf8')

  // 守卫：模板字面量里的反引号会把字符串提前截断，而外层模块语法仍合法，
  // 只有真跑起来才炸。这里直接查「模板体内出现反引号」这个形态。
  // 踩过两次：注释里写 `ref.current`，把整个 <script> 块切碎。
  const tplStart = src.indexOf('return `<!DOCTYPE html>')
  if (tplStart >= 0) {
    const tplEnd = src.indexOf('</body></html>`', tplStart)
    if (tplEnd < 0) {
      bad += 1
      console.error(`✖ ${file}：模板字面量没有正常闭合`)
    } else {
      const inner = src.slice(tplStart + 'return `'.length, tplEnd)
      // 只允许出现在 HTML 属性里的 \" 之类；真出现裸反引号就报。
      const stray = inner.indexOf('`')
      if (stray >= 0) {
        bad += 1
        const line = inner.slice(0, stray).split('\n').length
        console.error(`✖ ${file}：模板体内第 ${line} 行出现反引号，会提前截断字符串`)
      }
    }
  }

  const re = /<script>([\s\S]*?)<\/script>/g
  let m
  let i = 0
  while ((m = re.exec(src)) !== null) {
    i += 1
    try {
      // eslint-disable-next-line no-new-func
      new Function(m[1])
      console.log(`✔ ${file} 内联块 #${i}`)
    } catch (e) {
      bad += 1
      console.error(`✖ ${file} 内联块 #${i}：${e.message}`)
    }
  }
  if (!i) console.log(`· ${file} 没有内联块`)
}
process.exit(bad ? 1 : 0)
