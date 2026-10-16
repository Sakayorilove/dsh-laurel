import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
let loaded
const window = { __loomAllowTestHooks: true, __ModuleLoader__: { load: x => { loaded = x } } }
runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), { window })
const clientExports = loaded.factory(() => ({}))
const read = clientExports.readSubmittedReply
const extract = clientExports.extractPlanningReply
const prefer = clientExports.preferPlanFileReply
const messageFor = clientExports.requestFileMessage
const tracked = () => ({ requestId: 'ours', text: 'current prompt', afterSeq: 10 })
const event = (seq, type, data) => ({ type: 'event', event: { seq, type, data } })
const start = event(11, 'turn/start', { turn: 4 })
const user = event(12, 'user/message', { source: { kind: 'user', rpcId: 'ours' }, content: [{ type: 'text', text: 'current prompt' }] })
const assistant = event(13, 'assistant/message', { turn: 4, message: { content: [{ type: 'text', text: '{"candidate":{}}' }] } })
const end = event(14, 'turn/end', { turn: 4, reason: { kind: 'completed' } })
const readEvents = (entries, t = tracked()) => read({ entries }, t)

test('only exact current prompt and completed durable answer can be collected', () => {
  assert.equal(readEvents([start,user,assistant,end]), '{"candidate":{}}')
  assert.equal(readEvents([start,user,assistant]), null, 'partial turn cannot be collected')
  assert.equal(readEvents([start,user,assistant,end], {...tracked(),requestId:'different'}), null)
  assert.equal(readEvents([start,user,assistant,end], {...tracked(),afterSeq:20}), null)
})
test('history, transient stream and reasoning cannot masquerade as architecture JSON', () => {
  assert.equal(readEvents([event(1,'turn/start',{turn:1}),event(2,'assistant/message',assistant.event.data),start,user,{type:'transient',event:{seq:13,type:'assistant/live-chunk',data:{text:'bad'}}}]),null)
  assert.throws(()=>readEvents([start,user,event(13,'assistant/message',{turn:4,message:{content:[{type:'reasoning',text:'secret'}]}}),end]),/完整文本/)
})
test('cancelled, failed and truncated turns never produce candidates', () => {
  for (const kind of ['aborted','error','blocked','max-tokens','legacy-orphan']) assert.throws(()=>readEvents([start,user,assistant,event(14,'turn/end',{turn:4,reason:{kind}})]),/结束状态/)
  assert.throws(()=>readEvents([start,user,event(13,'assistant/message',{...assistant.event.data,interrupted:true}),end]),/完整文本/)
})
test('co-claimed user prompts and altered prompt contents require manual review', () => {
  const other = event(12,'user/message',{source:{kind:'user',rpcId:'other'},content:[{type:'text',text:'also do this'}]})
  assert.throws(()=>readEvents([start,other,user,assistant,end]),/其他输入/)
  assert.throws(()=>readEvents([start,user,other,assistant,end]),/其他输入/)
  assert.throws(()=>readEvents([start,{...user,event:{...user.event,data:{...user.event.data,content:[{type:'text',text:'changed'}]}}},assistant,end]),/内容不一致/)
  assert.throws(()=>readEvents([user,assistant,end]),/回合起点/)
})

test('planning replies are extracted from prose and code fences', () => {
  const payload = { requestId: 'abc', architecture: { nodes: [] }, workflow: { nodes: [] }, mappings: [], explanation: 'ok' }
  const json = JSON.stringify(payload)
  for (const input of [json, '```json\n' + json + '\n```', 'Here you go.\n\n```json\n' + json + '\n```\n\nNote: done.', 'intro {not json} more\n' + json + '\ntail']) {
    assert.equal(JSON.stringify(extract(input)), json)
  }
  assert.throws(() => extract('no json here'), /没有找到/)
  assert.throws(() => extract(''), /没有找到/)
})

test('repair text keeps requestId, carries the edge-shape hint and caps errors', () => {
  const text = clientExports.buildRepairText('hash-123', ('INVALID_ARCHITECTURE: x; '.repeat(500)))
  assert.match(text, /hash-123/)
  assert.match(text, /from、to、kind/)
  assert.match(text, /sharedResources/)
  const errorPart = (text.split('校验错误：')[1] || '').trim()
  assert.ok(errorPart.length <= 4000)
})

const recover = clientExports.recoverSubmittedReply
const rEvent = (seq, type, data) => ({ type: 'event', event: { seq, type, data } })
test('completed reply is recoverable for the same prompt after a surface switch', () => {
  const prompt = 'current prompt'
  const entries = [
    rEvent(1, 'turn/start', { turn: 1 }),
    rEvent(2, 'user/message', { source: { kind: 'user', rpcId: 'a' }, content: [{ type: 'text', text: prompt }] }),
    rEvent(3, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'old-json' }] } }),
    rEvent(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    rEvent(5, 'turn/start', { turn: 2 }),
    rEvent(6, 'user/message', { source: { kind: 'user', rpcId: 'b' }, content: [{ type: 'text', text: prompt }] }),
    rEvent(7, 'assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'new-json' }] } }),
    rEvent(8, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
  ]
  assert.equal(recover({ entries }, prompt), 'new-json')
  assert.equal(recover({ entries: entries.slice(0, 7) }, prompt), 'old-json')
  assert.equal(recover({ entries }, 'other prompt'), null)
})
test('recovery skips ambiguous and non-completed turns', () => {
  const prompt = 'current prompt'
  const ambiguous = [
    rEvent(1, 'turn/start', { turn: 1 }),
    rEvent(2, 'user/message', { source: { kind: 'user', rpcId: 'a' }, content: [{ type: 'text', text: prompt }] }),
    rEvent(3, 'user/message', { source: { kind: 'user', rpcId: 'x' }, content: [{ type: 'text', text: 'also this' }] }),
    rEvent(4, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'json' }] } }),
    rEvent(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
  assert.equal(recover({ entries: ambiguous }, prompt), null)
  const aborted = [
    rEvent(1, 'turn/start', { turn: 1 }),
    rEvent(2, 'user/message', { source: { kind: 'user', rpcId: 'a' }, content: [{ type: 'text', text: prompt }] }),
    rEvent(3, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'json' }] } }),
    rEvent(4, 'turn/end', { turn: 1, reason: { kind: 'aborted' } }),
  ]
  assert.equal(recover({ entries: aborted }, prompt), null)
})

test('a chat note after the plan does not hide the JSON from the same turn', () => {
  const plan = '{"requestId":"x","architecture":{},"workflow":{},"mappings":[],"explanation":""}'
  const entries = [
    start, user,
    event(13, 'assistant/message', { turn: 4, message: { content: [{ type: 'text', text: plan }] } }),
    event(14, 'assistant/message', { turn: 4, message: { content: [{ type: 'text', text: '计划已在上一条回复中定稿输出，我不重发。' }] } }),
    event(15, 'turn/end', { turn: 4, reason: { kind: 'completed' } }),
  ]
  assert.equal(readEvents(entries), plan)
})
test('recovery prefers the planning JSON over a trailing chat note in the same turn', () => {
  const prompt = 'current prompt'
  const plan = '{"requestId":"x","architecture":{},"workflow":{},"mappings":[]}'
  const entries = [
    rEvent(1, 'turn/start', { turn: 1 }),
    rEvent(2, 'user/message', { source: { kind: 'user', rpcId: 'a' }, content: [{ type: 'text', text: prompt }] }),
    rEvent(3, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: plan }] } }),
    rEvent(4, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'note' }] } }),
    rEvent(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
  assert.equal(recover({ entries }, prompt), plan)
})

test('a plan file is preferred when the chat reply carries no matching JSON', () => {
  const hash = 'hash-1'
  const fromFile = '{"requestId":"hash-1","architecture":{}}'
  assert.equal(prefer(fromFile, null, hash), fromFile)
  assert.equal(prefer('已写入 .loom/plan.json', fromFile, hash), fromFile)
  assert.equal(prefer('{"requestId":"hash-1"}', '{"requestId":"old"}', hash), '{"requestId":"hash-1"}')
  assert.equal(prefer('{"requestId":"old"}', '{"requestId":"older"}', hash), '{"requestId":"old"}')
})

test('a plan file restores the candidate only when its requestId matches', () => {
  const restore = clientExports.restorePlanFileReply
  const restoreHash = clientExports.planRestoreHash
  const hash = 'hash-1'
  const file = { text: '{"requestId":"hash-1","architecture":{}}', requestId: 'hash-1' }
  // 有文件且 requestId 与本次请求一致 → 可以自动预览。
  assert.equal(restore(file, hash), file.text)
  // 文件不匹配（旧文件 / 别的请求写的文件）→ 不预览。
  assert.equal(restore({ text: '{"requestId":"old","architecture":{}}', requestId: 'old' }, hash), null)
  assert.equal(restore({ text: '已把方案写入 .loom/plan.json', requestId: 'hash-1' }, hash), null, '文件里没有规划 JSON 时不能当候选')
  assert.equal(restore({ text: null, requestId: null }, hash), null)
  assert.equal(restore(null, hash), null)
  assert.equal(restore(file, ''), null, '没有可核对的请求 id 就不认领')
  // 窗口重开后唯一的凭据是服务端记录的最新规划请求 requestId。
  const collect = { text: '{"requestId":"server","architecture":{}}', requestId: 'server' }
  assert.equal(restore(collect, restoreHash(null, collect)), collect.text)
  assert.equal(restore(collect, restoreHash(null, { requestId: 'other' })), null)
})

test('the restore hash prefers the live export and falls back to the server record', () => {
  const restoreHash = clientExports.planRestoreHash
  assert.equal(restoreHash({ payloadHash: 'live' }, { requestId: 'server' }), 'live')
  assert.equal(restoreHash(null, { requestId: 'server' }), 'server')
  assert.equal(restoreHash(null, { requestId: null }), '')
  assert.equal(restoreHash(null, null), '')
  assert.equal(restoreHash({ payloadHash: '' }, {}), '')
})

test('long planning requests are sent as a short file pointer', () => {
  const planning = messageFor('planning', '.loom/plan-request.md')
  assert.match(planning, /\.loom\/plan-request\.md/)
  assert.match(planning, /完整文字计划/)
  assert.match(planning, /loom_submit_plan/)
  assert.doesNotMatch(planning, /只回 1-2 句|把最终 JSON 写入/)
  assert.match(planning, /禁止写计划文件/)
  assert.ok(planning.length < 200)
  assert.match(messageFor('repair', '.loom/plan-request.md'), /修正请求/)
})
