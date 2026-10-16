/** Optional calls into the installed DSH host. No host source is bundled. */
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { assertHostHelpers, type HostHelpers } from './provider.js'

export function loadHostHelpers(): HostHelpers {
  const anchors = [import.meta.url, ...(process.argv[1] && isAbsolute(process.argv[1]) ? [process.argv[1]] : [])]
  for (const anchor of anchors) {
    try {
      const fromHost = createRequire(anchor)
      const subagent = fromHost('@deepseek-ai/dsh-subagent')
      const llm = fromHost('@deepseek-ai/dsh-llm')
      const agent = fromHost('@deepseek-ai/dsh-agent')
      const session = fromHost('@deepseek-ai/dsh-session')
      const brand = fromHost('@deepseek-ai/dsh-brand')
      const tools = fromHost('@deepseek-ai/dsh-tools')
      const helpers = { ...subagent, createUserMessage: llm.createUserMessage,
        foldConsumedWork: agent.foldConsumedWork, sessionLogOffset: session.SessionLogOffset, brandString: brand.brandString,
        assertOutputSchema: tools.assertObjectJsonSchema, validateOutput: tools.validateJsonSchemaValue, ToolArgsError: tools.ToolArgsError }
      assertHostHelpers(helpers)
      if (!helpers.foldConsumedWork || !helpers.sessionLogOffset || !helpers.finalAssistantOutput) throw new Error('result readers unavailable')
      return helpers
    } catch { /* CLI and desktop module contexts differ; fail closed if neither works. */ }
  }
  throw new Error('HOST_HELPERS_UNAVAILABLE: 当前模块解析环境无法加载宿主公开组合 API')
}


export function loadHostShellBindings(): { ShellExecutor: any; applyBashTool: (ctx: any, config: any) => void; bashTools: any } {
  const anchors = [import.meta.url, ...(process.argv[1] && isAbsolute(process.argv[1]) ? [process.argv[1]] : [])]
  for (const anchor of anchors) {
    try {
      const fromHost = createRequire(anchor)
      const shell = fromHost('@deepseek-ai/dsh-shell')
      const tool = fromHost('@deepseek-ai/dsh-tool-bash')
      if (typeof shell.ShellExecutor !== 'function' || typeof tool.apply !== 'function') throw new Error('public shell API unavailable')
      return { ShellExecutor: shell.ShellExecutor, applyBashTool: tool.apply, bashTools: tool }
    } catch { /* fail closed when neither installed host anchor exposes the public seam */ }
  }
  throw new Error('HOST_WSL_SHELL_UNAVAILABLE: 无法加载宿主公开 ShellExecutor/bash API')
}


export function loadHostFsBindings(): { FileSystem: any; FsError: any; fileTools: any } {
  const anchors = [import.meta.url, ...(process.argv[1] && isAbsolute(process.argv[1]) ? [process.argv[1]] : [])]
  for (const anchor of anchors) {
    try {
      const fromHost = createRequire(anchor), fs = fromHost('@deepseek-ai/dsh-fs'), tools = fromHost('@deepseek-ai/dsh-tool-fs')
      if (typeof fs.FileSystem !== 'function' || typeof fs.FsError !== 'function' || typeof tools.apply !== 'function') throw new Error('public FS seam unavailable')
      return { FileSystem: fs.FileSystem, FsError: fs.FsError, fileTools: tools }
    } catch { /* installed host API only; no source copies */ }
  }
  throw new Error('HOST_WSL_FS_UNAVAILABLE: 无法加载宿主公开 FileSystem API')
}
