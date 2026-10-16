import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync, statSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve, join } from 'node:path'
import { assertEvidenceVersion } from './manifest-guard.mjs'

const root = resolve(import.meta.dirname, '..')
const delivery = process.env.LOOM_DELIVERY_ROOT || resolve(root, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const verification = JSON.parse(readFileSync(join(root, '.verification/results.json'), 'utf8'))
if (!verification.passed || !verification.browser) throw new Error('Full browser/backend verification must pass before delivery')
const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
if (git(['status', '--porcelain'])) throw new Error('Commit the reviewed source before creating a release manifest')
const tgz = `${pkg.name}-${pkg.version}.tgz`
const hash = (path) => ({ path, bytes: statSync(join(root, path)).size, sha256: createHash('sha256').update(readFileSync(join(root, path))).digest('hex') })
const walk = (dir) => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((d) => d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)])
const staleScreenshots = new Set(['13-unlocked-panel.png', '14-deleted-after-unlock.png', 'complete-host-session-entry.png'])
const artifacts = [tgz, 'package.json', 'cordis.patch.yml', 'LICENSE', 'README.md', 'THIRD-PARTY.md', ...walk('lib'), ...walk('src'), ...walk('scripts'), ...walk('tests'), ...walk('docs'), ...walk('.verification'), ...walk('.browser-evidence').filter((p) => !staleScreenshots.has(p.split('/').at(-1)))].sort().map(hash)
const readEvidence = (name) => { const path = join(root, '.verification', name); return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null }
// `.verification/` 会被整个拷进新版本的 evidence 目录（见文件末尾），而它里面的
// installation-record / desktop-activation 是**上一版留下的**。不核对版本就会出现
// 「0.7.6 的证据目录里躺着 0.7.5 的安装记录」这种串版本事故（2026-10-06 实测）。
// 这里 fail-closed：版本对不上就不许出交付 manifest。规则与用例见 scripts/manifest-guard.mjs。
const windowsEvidence = readEvidence('windows-wsl-product.json')
const windowsProduct = windowsEvidence?.packageVersion === pkg.version ? windowsEvidence : null
const fullHost = readEvidence('planning-host.json')
if(!fullHost?.passed||fullHost.packageVersion!==pkg.version)throw new Error('Current complete-host planning acceptance must pass before delivery')
const runtimeHasher=createHash('sha256');for(const file of walk('lib').sort())runtimeHasher.update(file+'\0').update(readFileSync(join(root,file)))
if(fullHost.runtimeFingerprint!==runtimeHasher.digest('hex'))throw new Error('Complete-host evidence runtime fingerprint differs from current lib; rerun acceptance')

const installation = assertEvidenceVersion(pkg.version, 'installation-record.json', readEvidence('installation-record.json'))
const desktop = assertEvidenceVersion(pkg.version, 'desktop-activation.json', readEvidence('desktop-activation.json'))
const manifest = { formatVersion: 4, generatedAt: new Date().toISOString(), package: pkg.name, version: pkg.version,
  authoritativeSource: root, vcs: { isGitRepo: true, commit: git(['rev-parse', 'HEAD']), dirty: false },
  environment: { os: execFileSync('uname', ['-sr'], { encoding: 'utf8' }).trim(), user: execFileSync('id', ['-un'], { encoding: 'utf8' }).trim(), node: process.version, pnpm: execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim(), inspectedHostPackages: 'DSH 0.2.0-rc.2; evidence scopes recorded separately' },
  artifacts, verification, deployment: { installation, desktop }, productVerification: { windowsProduct, inheritedWindowsProduct: windowsProduct ? null : windowsEvidence && { version: windowsEvidence.packageVersion, evidence: 'windows-wsl-product.json', scope: 'Historical runtime-only validation; not rerun for this client change' }, fullHost, executionRecovery: readEvidence('execution-recovery.json'), historicalSessionRepair: 'evidence/0.3.3/session-log-windows.json; historical, not rerun' },
  independentEvidence: ['real HTTP + disk', 'Chromium + real HTTP backend; React/session fixture', 'real WSL command receipts and process-group cancellation', 'real temporary Git worktrees + deterministic program tasks', 'read-only installed host public export resolution', 'installed real Cordis/SystemPrompt/ToolRuntime/Typert Registry/Gateway plugin mount and unload; session query fixture', 'Chromium + installed Harness React/ReactDOM/Cordis platform + real Gateway; slot/session fixtures; RPC only'],
  notVerified: [...(!windowsProduct ? ['Windows→WSL product专项本次未重跑；历史版本与范围见 inheritedWindowsProduct'] : []), ...(!desktop?.backendMounted ? ['live DSH desktop backend mounting'] : []), ...(!desktop?.frontendVerified ? ['full Electron client composition and live UI interaction'] : []), '外部模型路由执行', 'actual Laurel-Center nine-task completion; prior run failed, revised plan awaits fresh human recovery approval', 'native HTTP POST abort lifecycle; legitimate GUI RPC requires live verification', 'automatic integration', 'automatic allocation among independent main sessions'],
  runtimeScope: 'Schema-validated child structured_output capture bound to attempt/snapshot identity; verified full upstream and transitive input materialization, all artifact references retained; per-task acceptance corrections and freshly approved compatible recovery with unverified old drafts rechecked; Session-scoped idempotent admission, visible active tasks, terminal-only recovery, lock-proven cold interruption, preserved cancellation reasons; direct canvas rectangle/multiple selection, semantic group drag membership, agent responsibility controls, step merge/split and on-demand inspectors; Field-specific cached preflight answer repairs, cosmetic recommendation matching, concise tool responses, session-bound prepared execution repository shared by SCM/approval/runtime/provider, verified preservation of adopted user plans and explicit candidate recovery without approval; Snapshot-bound compact AI preflight recommendations, original task/group preservation, defaults and deferred verification in task contracts, retained Git blockers, explicit proposal adoption and separate human execution approval; Guarded ordinary chat planning, text/graph projection, immutable historical candidates, explicit one-use semantic approval, split/merged stages, responsibility teams with supervisors and reviewers, bounded evidence-based peer coordination; Natural-language goal to structured architecture/module DAG preview and explicit adoption; New Session preparatory workbench and native project navigation with scoped draft transfer; caption-safe responsive canvas, empty fullscreen and interactive current-project canvas in completed reply tails with one active editor; native session pane; frozen-base configured-agent module DAG; durable attempts and explicit cold recovery; independent snapshot-bound review and bounded repair; validated is not integrated',
  license: 'MIT; no third-party source or assets bundled; optional installed host public APIs and host React used' }
writeFileSync(join(root, 'handoff-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
const handoff = join(delivery, 'docs/dsh-loom/handoff'), evidence = join(handoff, 'evidence', pkg.version)
mkdirSync(evidence, { recursive: true }); mkdirSync(join(delivery, '安装包'), { recursive: true })
copyFileSync(join(root, tgz), join(delivery, '安装包', tgz))
for (const name of ['README.md', 'THIRD-PARTY.md', 'LICENSE', 'handoff-manifest.json']) copyFileSync(join(root, name), join(handoff, name))
copyFileSync(join(root, 'docs/使用手册.md'), join(handoff, '使用手册.md'))
mkdirSync(join(handoff, 'docs'), { recursive: true })
for (const name of readdirSync(join(root, 'docs'))) if (statSync(join(root, 'docs', name)).isFile()) copyFileSync(join(root, 'docs', name), join(handoff, 'docs', name))
for (const name of readdirSync(join(root, '.verification'))) copyFileSync(join(root, '.verification', name), join(evidence, name))
for (const name of readdirSync(join(root, '.browser-evidence'))) if (name.endsWith('.png') && !staleScreenshots.has(name)) copyFileSync(join(root, '.browser-evidence', name), join(evidence, name))
console.log(JSON.stringify({ commit: manifest.vcs.commit, version: pkg.version, artifact: hash(tgz), manifest: join(handoff, 'handoff-manifest.json') }, null, 2))
