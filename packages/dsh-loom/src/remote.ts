/** Carrier adapter: the same Loom handlers over Harness's authenticated RPC.
 * No socket, independent server, credentials, or child application is created. */
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { createHandler, type HandlerDeps } from './http.js'

export interface LoomRequest { sessionId: string; path: string; method: 'GET' | 'POST'; body?: unknown }
// RPC route whitelist: every route lib/client.js calls via requestJSON must be listed here
// (GET -> reads, POST -> writes) — a missing entry silently breaks the feature in real hosts.
// Guarded by tests/remote-routes.test.mjs.
const reads = new Set(['/state', '/config', '/diagnostics', '/scm', '/session/activation', '/capabilities', '/events', '/runs', '/batch', '/workflow', '/architecture', '/flow', '/planning/collect', '/session/planning-mode','/plan/snapshot'])
const writes = new Set(['/config', '/session/activation', '/planning/export', '/planning/preview', '/planning/accept', '/planning/stage', '/validate', '/draft', '/adopt', '/architecture', '/architecture/adopt', '/architecture/preview', '/architecture/accept', '/sourcemap', '/presentation', '/prompt', '/compile', '/flow', '/flow/apply', '/session/planning-mode','/plan/adopt','/plan/resolve'])

export function parseLoomRequest(value: unknown): LoomRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('LOOM_REQUEST_INVALID')
  const x = value as Record<string, unknown>
  if (Object.keys(x).some(k => !['sessionId', 'path', 'method', 'body'].includes(k)) ||
      typeof x.sessionId !== 'string' || x.sessionId.length > 256 ||
      typeof x.path !== 'string' || x.path.length > 4096 || !['GET', 'POST'].includes(String(x.method))) throw new Error('LOOM_REQUEST_INVALID')
  const url = new URL(x.path, 'http://loom.invalid')
  if (!x.path.startsWith('/') || x.path.startsWith('//') || url.origin !== 'http://loom.invalid' ||
      url.hash || url.pathname !== x.path.split('?')[0] ||
      !(x.method === 'GET' ? reads : writes).has(url.pathname)) throw new Error('LOOM_ROUTE_UNAVAILABLE')
  if (!x.sessionId && !(['/config','/diagnostics'].includes(url.pathname) || (x.method === 'GET' && ['/state', '/capabilities'].includes(url.pathname)))) throw new Error('LOOM_SESSION_REQUIRED')
  if (x.method === 'GET' && x.body !== undefined) throw new Error('LOOM_GET_BODY')
  if (Buffer.byteLength(JSON.stringify(x)) > 512 * 1024) throw new Error('LOOM_REQUEST_TOO_LARGE')
  return x as unknown as LoomRequest
}

/** Translate carrier DTOs into the existing handler's stream contract, in memory.
 * Route and business validation remain shared with HTTP; no second write path. */
export function createRemoteRequest(deps: HandlerDeps) {
  const handler = createHandler(deps)
  return async (input: unknown, signal?: AbortSignal) => {
    const request = parseLoomRequest(input)
    signal?.throwIfAborted()
    const req = Readable.from(request.body === undefined ? [] : [Buffer.from(JSON.stringify(request.body))]) as any
    req.url = '/loom' + request.path; req.method = request.method; req.signal = signal
    req.headers = { 'x-loom-session': request.sessionId, 'content-type': 'application/json' }
    let output: any = null
    const res = { headersSent: false, statusCode: 200, setHeader() {}, end(body: string) {
      this.headersSent = true; output = { status: this.statusCode, payload: JSON.parse(body) }
    } }
    await handler(req, res)
    if (!output) throw new Error('LOOM_EMPTY_RESPONSE')
    return output
  }
}

function hostProtocol(): any {
  for (const anchor of [import.meta.url, ...(process.argv[1] && isAbsolute(process.argv[1]) ? [process.argv[1]] : [])]) {
    try { const fromHost = createRequire(anchor); return fromHost('@deepseek-ai/dsh-typert-protocol') } catch {}
  }
  throw new Error('LOOM_REMOTE_HOST_API_UNAVAILABLE')
}

/** Owned registrations use public Cordis and Typert contracts from the host. */
export function installRemote(ctx: any, deps: HandlerDeps): void {
  const { TypertRemoteService, Remote } = hostProtocol()
  const request = createRemoteRequest(deps)
  const initializers: Function[] = []
  class LoomRemote extends TypertRemoteService {
    constructor(serviceCtx: any) { super(serviceCtx, 'loomRemote', { namespace: 'loom' }); for (const f of initializers) f.call(this) }
    request(input: unknown, signal: AbortSignal) { return request(input, signal) }
  }
  Remote(LoomRemote.prototype.request, { kind: 'method', name: 'request', static: false, private: false,
    addInitializer: (f: Function) => initializers.push(f) })
  const resultCodec = { mode: 'strict', typeSymbol: 'LoomResponse', create: () => ({ parse(value: any) {
    if (!value || !Number.isInteger(value.status) || !value.payload || typeof value.payload.ok !== 'boolean') throw new Error('LOOM_RESPONSE_INVALID')
    return value
  } }) }
  const contribution = { package: 'dsh-loom', face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: [{
    id: 'dsh-loom:loom/request:v1', service: 'loomRemote', namespace: 'loom', method: 'request', invocation: { kind: 'direct' },
    parameters: [{ name: 'input', wire: 'input', source: 'json', codec: { mode: 'strict', typeSymbol: 'LoomRequest', create: () => ({ parse: parseLoomRequest }) } }],
    cancellation: { parameter: 'signal' }, result: resultCodec,
  }] }
  ctx.effect(() => ctx.get('typert').register(contribution), 'loom.remote-descriptor')
  ctx.plugin(LoomRemote)
}
