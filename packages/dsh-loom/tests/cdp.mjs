/**
 * 极小的 CDP（Chrome DevTools Protocol）客户端。
 *
 * 为什么不用 playwright：
 *   本项目「零第三方运行时代码」是硬约束，测试依赖也不想例外 ——
 *   而且 WSL 里已经有一份 Chromium 二进制（在 ms-playwright 缓存目录下），
 *   只缺驱动。驱动本身就是一个 WebSocket + JSON-RPC，用 Node 内置能力就能写完，
 *   不必为了自动化再引一个依赖。
 *
 * 覆盖范围：launch / goto / evaluate / waitForFunction / screenshot / close。
 */
import { spawn } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, connect as netConnect } from 'node:net'

/** 找一个空闲端口。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 在系统里找到 Chromium 可执行文件。
 *
 * 优先用环境变量 `LOOM_CHROME`，其次扫 playwright 的缓存目录
 * （版本号不写死 —— 换版本时不该改测试）。
 */
export function findChrome() {
  if (process.env.LOOM_CHROME && existsSync(process.env.LOOM_CHROME)) return process.env.LOOM_CHROME
  const home = process.env.HOME || ''
  const roots = [join(home, '.cache/ms-playwright'), '/root/.cache/ms-playwright']
  for (const root of roots) {
    if (!existsSync(root)) continue
    let entries = []
    try {
      entries = readdirSync(root)
    } catch {
      continue
    }
    for (const e of entries.sort().reverse()) {
      for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
        const p = join(root, e, rel)
        if (existsSync(p)) return p
      }
    }
  }
  throw new Error('找不到 Chromium 可执行文件；请设置 LOOM_CHROME 指向 chrome 二进制')
}

/* ====================================================================== *
 * WebSocket 客户端（RFC 6455 客户端侧，够用就行）
 * ====================================================================== */
class Ws {
  constructor(url) {
    this.url = url
    this.buf = Buffer.alloc(0)
    this.handlers = { message: [], open: [], close: [], error: [] }
    this.sock = null
  }

  on(ev, fn) {
    this.handlers[ev].push(fn)
    return this
  }

  emit(ev, ...args) {
    for (const fn of this.handlers[ev]) fn(...args)
  }

  connect() {
    return new Promise((resolve, reject) => {
      const u = new URL(this.url)
      const key = randomBytes(16).toString('base64')
      const sock = netConnect(Number(u.port), u.hostname, () => {
        sock.write(
          `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
            `Host: ${u.host}\r\n` +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            `Sec-WebSocket-Key: ${key}\r\n` +
            'Sec-WebSocket-Version: 13\r\n\r\n',
        )
      })
      this.sock = sock
      sock.on('error', (e) => {
        this.emit('error', e)
        reject(e)
      })
      let handshaken = false
      sock.on('data', (chunk) => {
        if (!handshaken) {
          this.buf = Buffer.concat([this.buf, chunk])
          const end = this.buf.indexOf('\r\n\r\n')
          if (end < 0) return
          const head = this.buf.slice(0, end).toString('latin1')
          const expect = createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64')
          if (!/HTTP\/1\.1 101/.test(head)) {
            reject(new Error(`WebSocket 握手失败：${head.split('\r\n')[0]}`))
            return
          }
          if (!head.toLowerCase().includes(expect.toLowerCase())) {
            reject(new Error('WebSocket accept 校验失败'))
            return
          }
          handshaken = true
          this.buf = this.buf.slice(end + 4)
          this.emit('open')
          resolve()
          this.drain()
          return
        }
        this.buf = Buffer.concat([this.buf, chunk])
        this.drain()
      })
      sock.on('close', () => this.emit('close'))
    })
  }

  drain() {
    for (;;) {
      const frame = this.readFrame()
      if (!frame) return
      if (frame.opcode === 1) this.emit('message', frame.payload.toString('utf8'))
      else if (frame.opcode === 8) {
        this.emit('close')
        return
      } else if (frame.opcode === 9) {
        this.sendFrame(10, frame.payload)
      }
    }
  }

  readFrame() {
    const b = this.buf
    if (b.length < 2) return null
    const fin = (b[0] & 0x80) !== 0
    const opcode = b[0] & 0x0f
    const masked = (b[1] & 0x80) !== 0
    let len = b[1] & 0x7f
    let off = 2
    if (len === 126) {
      if (b.length < off + 2) return null
      len = b.readUInt16BE(off)
      off += 2
    } else if (len === 127) {
      if (b.length < off + 8) return null
      len = Number(b.readBigUInt64BE(off))
      off += 8
    }
    let mask = null
    if (masked) {
      if (b.length < off + 4) return null
      mask = b.slice(off, off + 4)
      off += 4
    }
    if (b.length < off + len) return null
    const payload = Buffer.from(b.slice(off, off + len))
    if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]
    this.buf = b.slice(off + len)
    if (!fin) throw new Error('不支持分片帧')
    return { opcode, payload }
  }

  sendFrame(opcode, payload) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
    const len = data.length
    let header
    if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len])
    else if (len < 65536) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 126
      header.writeUInt16BE(len, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(len), 2)
    }
    const mask = randomBytes(4)
    const masked = Buffer.from(data)
    for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4]
    this.sock.write(Buffer.concat([header, mask, masked]))
  }

  send(text) {
    this.sendFrame(1, text)
  }

  close() {
    try {
      this.sendFrame(8, Buffer.alloc(0))
      this.sock.end()
    } catch {
      /* 已经断了就算了 */
    }
  }
}

/* ====================================================================== *
 * 浏览器
 * ====================================================================== */

/**
 * 本机 Playwright 的 Chromium 缺系统库（libnspr4 / libnss3 / libasound2 等），
 * 机器上单独放了一份在 `~/.local/chromium-libs/usr/lib/x86_64-linux-gnu`。
 * 启动前把它并进 `LD_LIBRARY_PATH`（只追加、不覆盖，已有则不动），
 * 省掉每次跑浏览器用例前手动 export —— 忘了就是 `libnspr4.so: cannot open`。
 * 覆盖：`LOOM_CHROMIUM_LIBS` 指定别的目录。
 */
export function chromiumEnv(base = process.env) {
  const libs = process.env.LOOM_CHROMIUM_LIBS || join(base.HOME || '', '.local/chromium-libs/usr/lib/x86_64-linux-gnu')
  if (!libs || !existsSync(libs)) return base
  const current = base.LD_LIBRARY_PATH || ''
  if (current.split(':').includes(libs)) return base
  return { ...base, LD_LIBRARY_PATH: current ? `${libs}:${current}` : libs }
}

export async function launchBrowser(opts = {}) {
  const exe = opts.executablePath || findChrome()
  const port = await freePort()
  const userDataDir = mkdtempSync(join(tmpdir(), 'loom-chrome-'))
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--metrics-recording-only',
    '--mute-audio',
    `--window-size=${opts.width || 1400},${opts.height || 900}`,
    'about:blank',
  ]
  const proc = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], env: chromiumEnv() })
  let stderr = ''
  proc.stderr.on('data', (d) => {
    stderr += d.toString()
  })

  // 等 devtools 端点起来
  let targetWs = null
  for (let i = 0; i < 100; i += 1) {
    await sleep(100)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) {
        const info = await res.json()
        if (info.webSocketDebuggerUrl) {
          targetWs = info.webSocketDebuggerUrl
          break
        }
      }
    } catch {
      /* 还没起来 */
    }
    if (proc.exitCode !== null) break
  }
  if (!targetWs) {
    proc.kill('SIGKILL')
    throw new Error(`Chromium 未能在超时内启动。stderr 尾部：\n${stderr.slice(-1500)}`)
  }

  const browser = new Browser({ proc, port, browserWsUrl: targetWs, userDataDir, stderr: () => stderr })
  await browser._attach()
  return browser
}

class Browser {
  constructor(o) {
    Object.assign(this, o)
    this.ws = null
    this.nextId = 1
    this.pending = new Map()
    this.sessions = new Map()
    this.events = []
  }

  async _attach() {
    this.ws = new Ws(this.browserWsUrl)
    this.ws.on('message', (raw) => this._onMessage(raw))
    await this.ws.connect()
  }

  _onMessage(raw) {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) reject(new Error(`${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ''}`))
      else resolve(msg.result)
      return
    }
    if (msg.method) {
      this.events.push(msg)
      const h = this.sessions.get(msg.sessionId)
      if (h) h(msg)
    }
  }

  /** 发一条 browser 级 CDP 命令。 */
  send(method, params = {}, sessionId) {
    const id = this.nextId++
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify(payload))
      const timeout = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP 超时：${method}`))
        }
      }, 30000)
      timeout.unref()
    })
  }

  /** 开一个新页签并 attach。返回 page 对象（命令都带 sessionId）。 */
  async newPage(url = 'about:blank') {
    const { targetId } = await this.send('Target.createTarget', { url })
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true })
    const page = new Page(this, sessionId, targetId)
    await page.init()
    return page
  }

  async close() {
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
    try {
      this.proc.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }
}

class Page {
  constructor(browser, sessionId, targetId) {
    this.browser = browser
    this.sessionId = sessionId
    this.targetId = targetId
    this.consoleLogs = []
    this.pageErrors = []
    this.failedRequests = []
    this.requests = []
  }

  send(method, params = {}) {
    return this.browser.send(method, params, this.sessionId)
  }

  async init() {
    this.browser.sessions.set(this.sessionId, (msg) => this._onEvent(msg))
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    await this.send('Network.enable')
  }

  _onEvent(msg) {
    const m = msg.method
    if (m === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || [])
        .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type))
        .join(' ')
      this.consoleLogs.push({ type: msg.params.type, text })
    } else if (m === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      this.pageErrors.push(d.exception?.description || d.text || 'unknown page error')
    } else if (m === 'Network.requestWillBeSent') {
      this.requests.push({
        url: msg.params.request.url,
        method: msg.params.request.method,
        postData: msg.params.request.postData,
        headers: msg.params.request.headers,
      })
    } else if (m === 'Network.loadingFailed') {
      this.failedRequests.push({ errorText: msg.params.errorText, type: msg.params.type })
    }
  }

  async goto(url, { waitUntil = 'load' } = {}) {
    const loaded = this.waitForEvent('Page.loadEventFired', 20000)
    await this.send('Page.navigate', { url })
    if (waitUntil === 'load') await loaded
  }

  waitForEvent(method, timeoutMs = 10000) {
    const start = Date.now()
    return new Promise((resolve, reject) => {
      const check = () => {
        const hit = this.browser.events.find((e) => e.method === method && e.sessionId === this.sessionId)
        if (hit) return resolve(hit)
        if (Date.now() - start > timeoutMs) return reject(new Error(`等待事件 ${method} 超时`))
        setTimeout(check, 30)
      }
      check()
    })
  }

  /** 在页面里求值。返回 JSON 化的结果。 */
  async evaluate(fnOrExpr, { args = [], awaitPromise = true } = {}) {
    const expr =
      typeof fnOrExpr === 'string'
        ? fnOrExpr
        : `(${fnOrExpr.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`
    const res = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    })
    if (res.exceptionDetails) {
      throw new Error(`页面内求值抛错：${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`)
    }
    return res.result.value
  }

  /** 反复求值直到返回真值。 */
  async waitForFunction(fnOrExpr, { timeoutMs = 10000, pollMs = 50, args = [] } = {}) {
    const start = Date.now()
    for (;;) {
      const v = await this.evaluate(fnOrExpr, { args })
      if (v) return v
      if (Date.now() - start > timeoutMs) throw new Error('waitForFunction 超时')
      await sleep(pollMs)
    }
  }

  async screenshot(path) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(path, Buffer.from(data, 'base64'))
    return path
  }

  /** 真实鼠标拖拽：从 (x1,y1) 按 steps 步移动到 (x2,y2)。 */
  async dragMouse(x1, y1, x2, y2, steps = 12) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, button: 'none', buttons: 0 })
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1 })
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(x1 + (x2 - x1) * t),
        y: Math.round(y1 + (y2 - y1) * t),
        button: 'left',
        buttons: 1,
      })
      await sleep(8)
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1 })
  }

  async clickAt(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  }
}

export { sleep }
