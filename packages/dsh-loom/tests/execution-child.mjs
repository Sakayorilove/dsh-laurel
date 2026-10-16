import { acquireExecutionLease } from '../lib/coordinator.js'
import { fixture,graph } from './execution-fixture.mjs'
const [mode,root]=process.argv.slice(2)
if(mode==='lease'){await acquireExecutionLease(root);process.send({ready:true});setInterval(()=>{},1000)}
else {const f=fixture(root,false);await f.runtime.run(graph(),f.repo,f.ws,f.base,async t=>{process.send({ready:true,runId:t.runId,attemptId:t.attemptId,cwd:t.cwd});await new Promise(()=>{})},{runId:'crashed-run',maxConcurrency:1,maxRepairRounds:0})}
