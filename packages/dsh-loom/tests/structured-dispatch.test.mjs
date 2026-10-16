import assert from 'node:assert/strict'
import {createHostDispatcher} from '../lib/runtime.js'
// 宿主锚点可配置、可校验。原来在模块顶层 createRequire 一个占位符路径，
// 没装宿主时整个文件在**加载期**就抛，测试运行器直接停住 —— 现在改成用例内按需取。
import {hostRequire as host,hostTest} from '../scripts/host-anchor.mjs'

hostTest('native delivery schema binds the attempt and uses authoritative captured output despite model prose',async()=>{
  const {assertObjectJsonSchema,validateJsonSchemaValue}=host('@deepseek-ai/dsh-tools')
  let request,disposed=0
  const captured={verdict:'ready',attemptId:'current-attempt',artifactRefs:[]}
  const dispatcher=createHostDispatcher({async start(_name,r){request=r;return{result:Promise.resolve({stopReason:'completed',structured:captured,output:[{type:'text',text:'## 完成了，普通文字不是回执'}]}),async dispose(){disposed++}}}},{id:'parent'})
  const result=await dispatcher({phase:'implementation',runId:'native',attemptId:'current-attempt',prompt:'Preserve full instructions.',signal:new AbortController().signal})
  assert.equal(result.verdict,'ready');assert.equal(disposed,1)
  assertObjectJsonSchema(request.outputSchema)
  assert.deepEqual(validateJsonSchemaValue(request.outputSchema,captured),[])
  assert.ok(validateJsonSchemaValue(request.outputSchema,{...captured,attemptId:'old-attempt'}).length)
  assert.ok(validateJsonSchemaValue(request.outputSchema,{verdict:'ready',artifactRefs:[]}).length)
  assert.match(request.prompt[0].text,/调用 structured_output/)
})

hostTest('read-only reviews can capture structured verdicts while preserving all evidence and rejecting stale snapshots',async()=>{
  const {assertObjectJsonSchema,validateJsonSchemaValue}=host('@deepseek-ai/dsh-tools')
  let request
  const captured={verdict:'pass',attemptId:'review-attempt',snapshotHash:'current-snapshot',findings:[],messages:[]}
  const dispatcher=createHostDispatcher({async start(_name,r){request=r;return{result:Promise.resolve({stopReason:'completed',structured:captured,output:[]}),async dispose(){}}}},{})
  const prompt='任务文字包含 ## 返回格式（TaskResult JSON）\n其后仍有本次已验快照：KEEP-EVIDENCE'
  await dispatcher({phase:'review',runId:'native',attemptId:'review-attempt',snapshotHash:'current-snapshot',prompt,signal:new AbortController().signal})
  assert.deepEqual(request.toolFilter.allow,['read','glob','grep'])
  assert.ok(request.prompt[0].text.includes(prompt))
  assertObjectJsonSchema(request.outputSchema)
  assert.deepEqual(validateJsonSchemaValue(request.outputSchema,captured),[])
  assert.ok(validateJsonSchemaValue(request.outputSchema,{...captured,snapshotHash:'old-snapshot'}).length)
  assert.ok(validateJsonSchemaValue(request.outputSchema,{...captured,verdict:'anything'}).length)
})
