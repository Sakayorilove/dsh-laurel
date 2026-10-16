import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DEFAULT_WSL_DISTRIBUTION, executeWsl, windowsToWslPath, wslToWindowsPath } from '../lib/bridge.js'
import { WslShellExecution, createWslShellClass } from '../lib/wsl-shell.js'
// 宿主锚点可配置、可校验：只有最后一个子用例要真宿主，其余不需要。
import { hostRequire as host, hostSkipReason } from '../scripts/host-anchor.mjs'

test('WSL bridge maps only our distribution UNC and drive paths', () => {
  // 路径一律用与机器无关的通用名：既不写死某一台机器的用户名，
  // 也不拿脱敏占位符（`<工作区>` 之类）冒充真实路径 —— 后者不是合法 Linux 路径。
  const linux='/home/loom/projects/空间/test'
  assert.equal(windowsToWslPath(wslToWindowsPath(linux)), linux)
  assert.equal(windowsToWslPath(`\\\\wsl$\\${DEFAULT_WSL_DISTRIBUTION}\\home\\loom`),'/home/loom')
  assert.throws(()=>windowsToWslPath('\\\\wsl.localhost\\Debian\\home\\x'),/distribution mismatch/)
  assert.throws(()=>windowsToWslPath('\\\\server\\share\\work'))
  // /mnt/<盘符> 走盘符映射；其余绝对路径走 UNC；相对路径、反斜杠、NUL 一律拒绝。
  assert.equal(wslToWindowsPath('/mnt/d/work/project'), 'D:\\work\\project')
  assert.equal(wslToWindowsPath('/home/loom/projects/空间/test'), `\\\\wsl.localhost\\${DEFAULT_WSL_DISTRIBUTION}\\home\\loom\\projects\\空间\\test`)
  assert.throws(()=>wslToWindowsPath('relative/project'),/invalid Linux path/)
  assert.throws(()=>wslToWindowsPath('/home/loom\\project'),/invalid Linux path/)
})

test('real WSL shell retains read-only/workspace-write policy, stdin, explicit env and lifecycle', async (t) => {
  const root=mkdtempSync(join(tmpdir(),'loom-wsl-shell-')), workspace=join(root,'workspace')
  const {mkdirSync}=await import('node:fs');mkdirSync(workspace)
  const outside=join(root,'outside.txt');writeFileSync(outside,'preserved')
  const spec=(command,mode='workspace-write')=>({command,workdir:workspace,timeoutMs:5000,stdoutMaxBytes:4000,sandboxPolicy:{mode,workspaceRoot:workspace}})
  try {
    await t.test('workspace edits pass, outside workspace stays read-only',async()=>{
      const ex=new WslShellExecution(spec(`printf inside > result.txt; printf forbidden > /etc/loom-forbidden-write`))
      const result=await ex.result();await ex.done
      assert.notEqual(result.exitCode,0);assert.equal(readFileSync(outside,'utf8'),'preserved')
      assert.equal(readFileSync(join(workspace,'result.txt'),'utf8'),'inside')
      assert.equal(result.sandbox.enforcement,'full');assert.equal(result.sandbox.denied,true)
      assert.equal(ex.readOutput().delta.includes('Read-only'),true);assert.equal(ex.readOutput().delta,'')
    })
    await t.test('read-only blocks writes even inside assigned directory',async()=>{
      const result=await new WslShellExecution(spec('printf refused > readonly.txt','read-only')).result()
      assert.notEqual(result.exitCode,0);assert.equal(existsSync(join(workspace,'readonly.txt')),false)
    })
    await t.test('explicit stdin/env survive without leaking ambient credentials',async()=>{
      const saved=process.env.LOOM_AMBIENT_SECRET;process.env.LOOM_AMBIENT_SECRET='must-not-pass'
      try {
        const result=await executeWsl(['bash','-c','read input; printf "%s/%s/%s" "$input" "$LOOM_VISIBLE" "${LOOM_AMBIENT_SECRET-unset}"'],workspace,{stdin:'text\n',env:{LOOM_VISIBLE:'visible'}})
        assert.equal(result.stdout,'text/visible/unset')
      } finally {if(saved===undefined)delete process.env.LOOM_AMBIENT_SECRET;else process.env.LOOM_AMBIENT_SECRET=saved}
    })
    await t.test('kill waits for the owned process group',async()=>{
      const ex=new WslShellExecution(spec('sleep 50'))
      setTimeout(()=>ex.kill(),100)
      const result=await ex.result();await ex.done
      assert.equal(result.aborted,true);assert.equal(ex.status,'killed');assert.equal(ex.kill(),false)
    })
    await t.test('public installed ShellExecutor can be composed without copied host code', { skip: hostSkipReason }, async()=>{
      const {Context}=host('@deepseek-ai/cordis'),{ShellExecutor}=host('@deepseek-ai/dsh-shell')
      const ctx=new Context();const plugin=await ctx.plugin(createWslShellClass(ShellExecutor,workspace))
      try {
        const shell=ctx.shell;assert.ok(shell instanceof ShellExecutor)
        const result=await (await shell.execute(shell.resolve({command:'printf seam'}))).result()
        assert.equal(result.stdout.text,'seam');assert.equal(result.exitCode,0)
        assert.throws(()=>shell.resolve({command:'sleep 10',onExpiry:'none'}),/FOREGROUND_ONLY/)
      } finally {await plugin.dispose();await ctx.fiber.dispose()}
    })
  } finally {rmSync(root,{recursive:true,force:true})}
})
