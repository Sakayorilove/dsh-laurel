import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,symlinkSync,statSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createWslFileSystemClass} from '../lib/wsl-fs.js'
// 宿主锚点可配置、可校验：本用例要真宿主的公开 FileSystem。
import {hostRequire as host,hostTest} from '../scripts/host-anchor.mjs'

hostTest('native WSL filesystem preserves public FS semantics and policy',async(t)=>{
  const root=mkdtempSync(join(tmpdir(),'loom-wsl-fs-')), cwd=join(root,'workspace'), outside=join(root,'outside')
  mkdirSync(cwd);mkdirSync(outside)
  const {Context}=host('@deepseek-ai/cordis'),{FileSystem,FsError}=host('@deepseek-ai/dsh-fs')
  const ctx=new Context();ctx.provide('sandboxPolicy',{defaultMode:'workspace-write',resolve:()=>({mode:'workspace-write',workspaceRoot:cwd})})
  const plugin=await ctx.plugin(createWslFileSystemClass(FileSystem,FsError,cwd)), fs=ctx.fs
  try{
    await t.test('create/read/edit are native Linux atomic writes with CRLF preservation',async()=>{
      const target=await fs.resolve('nested/code.txt'),created=await fs.writeText(target,'before\r\nline\r\n',{kind:'createIfAbsent'})
      assert.equal(created.operation,'create');assert.equal(created.after,'before\nline\n')
      assert.equal(await fs.readText(target),'before\r\nline\r\n')
      const changed=await fs.editText(target,{oldString:'before',newString:'after',replaceAll:false},{version:created.version})
      assert.equal(changed.before,'before\nline\n');assert.equal(changed.after,'after\nline\n')
      assert.equal(readFileSync(join(cwd,'nested/code.txt'),'utf8'),'after\r\nline\r\n')
    })
    await t.test('stale guards and createIfAbsent refuse overwrites',async()=>{
      const target=await fs.resolve('nested/code.txt'),old=await fs.stat(target)
      writeFileSync(join(cwd,'nested/code.txt'),'external')
      await assert.rejects(fs.writeText(target,'overwrite',{kind:'replaceIfVersion',version:old.version}),e=>e.code==='FS_STALE_VERSION')
      await assert.rejects(fs.writeText(target,'overwrite',{kind:'createIfAbsent'}),e=>e.code==='FS_NOT_OBSERVED')
      assert.equal(readFileSync(join(cwd,'nested/code.txt'),'utf8'),'external')
    })
    await t.test('concurrent guarded creates serialize and exactly one wins',async()=>{
      const target=await fs.resolve('race.txt')
      const result=await Promise.allSettled([fs.writeText(target,'a',{kind:'createIfAbsent'}),fs.writeText(target,'b',{kind:'createIfAbsent'})])
      assert.equal(result.filter(r=>r.status==='fulfilled').length,1)
      assert.equal(result.find(r=>r.status==='rejected').reason.code,'FS_NOT_OBSERVED')
    })
    await t.test('symlink escape and read-only mutations are denied before publication',async()=>{
      symlinkSync(outside,join(cwd,'alias'))
      const target=await fs.resolve('alias/escaped.txt')
      await assert.rejects(fs.writeText(target,'blocked'),e=>e.code==='FS_SANDBOX_DENIED')
      const own=await fs.resolve('read-only.txt')
      await assert.rejects(fs.writeText(own,'blocked',undefined,undefined,{mode:'read-only',workspaceRoot:cwd}),e=>e.code==='FS_SANDBOX_DENIED')
      assert.deepEqual((await fs.listDir(await fs.resolve(outside))).map(e=>e.name),[])
    })
    await t.test('literal ambiguity and binary data expose typed errors',async()=>{
      const target=await fs.resolve('ambiguous.txt');await fs.writeText(target,'same same')
      await assert.rejects(fs.editText(target,{oldString:'same',newString:'x',replaceAll:false}),e=>e.code==='FS_AMBIGUOUS_EDIT')
      assert.equal((await fs.editText(target,{oldString:'same',newString:'x',replaceAll:true})).after,'x x')
      writeFileSync(join(cwd,'binary'),Buffer.from([0,1,2]))
      await assert.rejects(fs.readText(await fs.resolve('binary')),e=>e.code==='FS_NOT_TEXT')
    })
    await t.test('chunked UTF-8 reads and byte windows stay bounded',async()=>{
      const target=await fs.resolve('utf8.txt'),content='词'.repeat(50000);await fs.writeText(target,content)
      let streamed='';for await(const chunk of await fs.streamText(target))streamed+=chunk
      assert.equal(streamed,content)
      assert.equal((await fs.readByteRange(target,{offset:3,length:6})).toString(),'词词')
      await assert.rejects(fs.readBytes(target,undefined,2),e=>e.code==='FS_TOO_LARGE')
      const abort=new AbortController();abort.abort();await assert.rejects(fs.readText(target,abort.signal),e=>e.code==='FS_ABORTED')
    })
  }finally{await plugin.dispose();await ctx.fiber.dispose();rmSync(root,{recursive:true,force:true})}
})
