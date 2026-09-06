import { CommandDetails } from './command-summary'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { Activity, HostTools, ProviderAdapter, ProviderInfo, RunHandle, RunRequest } from '../../shared/contracts'
import { contextReceipt, abortError, capture, deferred, drainAll, errorText, findExecutable, finishWithCleanup, interruptAndWait, nativePrompt, providerEnv, retryableCleanup, spawnProviderProcess, stopProcess, type Emit, type Json } from './common'
import { HostMcpBridge } from './mcp-bridge'

/** Native permission scope is authoritative; tool inputs only explain the triggering action. */
function permissionDetail(permission: Json, parts: Map<string, Json>, sessionId: string): string {
  const patterns = Array.isArray(permission.patterns) ? permission.patterns : []
  const scope = patterns.length ? patterns.map((pattern: unknown) => typeof pattern === 'string' ? pattern : JSON.stringify(pattern)).join('\n') : 'No permission patterns supplied.'
  const sections = [`Requested permission: ${permission.permission || 'Unspecified'}\nPermission scope supplied by OpenCode:\n${scope}`]
  if (patterns.some((pattern: unknown) => typeof pattern === 'string' && pattern.includes('*'))) sections.push('This scope contains a wildcard. The tool details below do not narrow the requested permission.')
  const reference = permission.tool
  const matched = reference && typeof reference.callID === 'string' && typeof reference.messageID === 'string'
    ? [...parts.values()].find(part => part.type === 'tool' && part.sessionID === sessionId && part.messageID === reference.messageID && part.callID === reference.callID)
    : undefined
  const formatDetails = (value: unknown) => { const text = JSON.stringify(value, null, 2); return text.length > 16000 ? text.slice(0, 16000) + '\n[Additional tool details truncated]' : text }
  const metadata = permission.metadata && typeof permission.metadata === 'object' && Object.keys(permission.metadata).length ? permission.metadata : undefined
  if (matched) sections.push(`Triggering tool: ${matched.tool || 'Unnamed tool'}\nTool input:\n${formatDetails(matched.state?.input ?? {})}`)
  if (metadata) sections.push(`Details supplied with this permission request:\n${formatDetails(metadata)}`)
  if (!matched && !metadata) sections.push('No additional tool details were supplied for this permission request.')
  return sections.join('\n\n')
}

class OpenCodeServer {
  private child?: ChildProcessWithoutNullStreams
  private url = ''
  private password = randomBytes(32).toString('hex')
  private stopped = false
  readonly exited = deferred<void>()
  constructor(private executable: string, readonly cwd: string, private config: Json = {}) { void this.exited.promise.catch(() => {}) }
  async start() {
    const started = deferred<void>()
    let output = ''
    const executable = await findExecutable(this.executable)
    if (this.stopped) throw abortError()
    this.child = spawnProviderProcess(executable, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: this.cwd, env: providerEnv({ OPENCODE_SERVER_PASSWORD: this.password, OPENCODE_CONFIG_CONTENT: JSON.stringify(this.config) }) })
    const timer = setTimeout(() => { started.reject(new Error('OpenCode server startup timed out')); void this.dispose().catch(() => {}) }, 25_000)
    const receive = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-10000)
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)
      if (match) { this.url = match[1]; started.resolve() }
    }
    this.child.stdout.on('data', receive); this.child.stderr.on('data', receive)
    this.child.on('error', error => { started.reject(error); this.exited.reject(error) })
    this.child.on('close', code => { const error = new Error(`OpenCode server exited ${code}: ${output.slice(-3000)}`); started.reject(error); this.exited.reject(error) })
    try { await started.promise } finally { clearTimeout(timer) }
  }
  private headers() { return { Authorization: `Basic ${Buffer.from('opencode:' + this.password).toString('base64')}`, 'Content-Type': 'application/json' } }
  async request(path: string, body?: Json, method?: string, timeout = 30_000): Promise<any> {
    const separator = path.includes('?') ? '&' : '?'
    const response = await fetch(`${this.url}${path}${separator}directory=${encodeURIComponent(this.cwd)}`, { method: method || (body ? 'POST' : 'GET'), headers: this.headers(), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) })
    const text = await response.text()
    if (!response.ok) throw new Error(`OpenCode ${response.status}: ${text.slice(0, 2000)}`)
    return text ? JSON.parse(text) : null
  }
  async events(signal: AbortSignal): Promise<Response> {
    const response = await fetch(`${this.url}/event?directory=${encodeURIComponent(this.cwd)}`, { headers: this.headers(), signal })
    if (!response.ok || !response.body) throw new Error(`Cannot subscribe to OpenCode events (${response.status})`)
    return response
  }
  async dispose() { this.stopped = true; if (this.child) await stopProcess(this.child) }
}
export async function* readSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<Json> {
  const reader = stream.getReader(), decoder = new TextDecoder(); let pending = ''
  try {
    for (;;) {
      const { value, done } = await reader.read(); pending += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n')
      if (pending.length > 16_000_000) throw new Error('OpenCode event exceeds 16 MB')
      let boundary: number
      while ((boundary = pending.indexOf('\n\n')) !== -1) {
        const block = pending.slice(0, boundary); pending = pending.slice(boundary + 2)
        const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (data && data !== '[DONE]') yield JSON.parse(data)
      }
      if (done) break
    }
  } finally { reader.releaseLock() }
}
export class OpenCodeProvider implements ProviderAdapter {
  readonly id = 'opencode' as const
  private servers = new Set<OpenCodeServer>()
  private active = new Map<Promise<unknown>, { cancel: () => void; cleanup: () => Promise<void> }>()
  constructor(private hostTools: HostTools, private executable = 'opencode') {}
  async discover(): Promise<ProviderInfo> {
    const capabilities = { resume: true, steer: false, tools: true, approvals: true, images: true }
    const server = new OpenCodeServer(this.executable, tmpdir())
    this.servers.add(server)
    try {
      const [, version] = await Promise.all([server.start(), capture(this.executable, ['--version'])])
      const catalog = await server.request('/provider')
      const connected: string[] = catalog.connected || []
      const models = (catalog.all || []).filter((p: Json) => connected.includes(p.id)).flatMap((p: Json) => Object.values(p.models || {}).filter((m: any) => m.status !== 'deprecated').map((m: any) => ({ id: `${p.id}/${m.id}`, name: `${m.name || m.id} · ${p.name}`, description: m.family, efforts: Object.keys(m.variants || {}), contextWindow: m.limit?.context })))
      return { id: this.id, name: 'OpenCode', available: true, authenticated: connected.length > 0, version: version.trim(), models, capabilities, connectionLabel: connected.length ? `Connected: ${connected.join(', ')}` : 'Connect an account in OpenCode', error: connected.length ? undefined : 'No connected OpenCode providers. Run opencode auth login in Terminal.' }
    } catch (error) { return { id: this.id, name: 'OpenCode', available: false, models: [], capabilities, connectionLabel: 'OpenCode unavailable', error: errorText(error) } }
    finally { await server.dispose(); this.servers.delete(server) }
  }
  run(request: RunRequest, emit: Emit): RunHandle {
    const controller = new AbortController(), finished = deferred<void>()
    void finished.promise.catch(() => {})
    const bridge = new HostMcpBridge(this.hostTools, { taskId: request.task.id, turnId: request.turnId, cwd: request.cwd, mode: request.task.mode }, controller.signal)
    let server: OpenCodeServer | undefined, sessionId = '', cancelled = false, startedTurn = false, seenBusy = false, finishing = false, settled = false
    const commands = new CommandDetails()
    const messages = new Map<string, string>(), parts = new Map<string, Json>(), activities = new Map<string, Activity>(), pending = new Map<string, Json>()
    const startTime = Date.now()
    const finish = async () => {
      if (finishing) return; finishing = true
      try {
        const history: Json[] = await server!.request(`/session/${sessionId}/message?limit=30`)
        const assistants = history.filter(m => m.info?.role === 'assistant' && m.info.time?.created >= startTime - 1000)
        const latest = assistants.at(-1)
        if (latest?.info.error) throw new Error(latest.info.error.data?.message || latest.info.error.name || JSON.stringify(latest.info.error))
        const text = latest?.parts?.filter((p: Json) => p.type === 'text').map((p: Json) => p.text).join('\n\n') || ''
        if (!text.trim()) throw new Error('OpenCode finished without a final answer')
        emit({ type: 'final', text })
        emit({ type: 'usage', usage: { inputTokens: assistants.reduce((n, m) => n + (m.info.tokens?.input || 0), 0), outputTokens: assistants.reduce((n, m) => n + (m.info.tokens?.output || 0), 0), costUsd: assistants.reduce((n, m) => n + (m.info.cost || 0), 0) } })
        finished.resolve()
      } catch (error) { finished.reject(error) }
    }
    const receive = (event: Json) => {
      const p = event.properties || {}, part = p.part, scoped = p.sessionID || p.info?.sessionID || part?.sessionID
      if (scoped !== sessionId) return
      if (event.type === 'message.updated') messages.set(p.info.id, p.info.role)
      if (event.type === 'message.part.delta' && p.field === 'text' && parts.get(p.partID)?.type === 'text' && messages.get(p.messageID) === 'assistant') {
        const previous = parts.get(p.partID) || { type: 'text', text: '', id: p.partID }
        previous.text += p.delta; parts.set(p.partID, previous); emit({ type: 'delta', text: p.delta })
      }
      if (event.type === 'message.part.updated' && part) {
        const previous = parts.get(part.id)
        if (part.type === 'text' && messages.get(part.messageID) === 'assistant' && part.text?.length > (previous?.text?.length || 0)) emit({ type: 'delta', text: part.text.slice(previous?.text?.length || 0) })
        parts.set(part.id, part)
        if (part.type === 'tool') {
          const state = part.state || {}, old = activities.get(part.id)
          const activity: Activity = { id: part.id, kind: part.tool === 'bash' ? 'command' : ['edit', 'write', 'apply_patch'].includes(part.tool) ? 'file' : 'tool', ...(part.tool === 'bash' ? commands.update(part.id, state.input?.command, state.output ?? state.error) : { title: state.title || part.tool || 'Tool', detail: (state.output || state.error || JSON.stringify(state.input || {}, null, 2)).slice(0, 100_000) }), status: state.status === 'completed' ? 'completed' : state.status === 'error' ? 'failed' : 'running', startedAt: old?.startedAt || state.time?.start || Date.now(), endedAt: state.time?.end, filePath: state.input?.filePath }
          activities.set(part.id, activity); emit({ type: 'activity', activity })
        }
      }
      if (event.type === 'permission.asked') { pending.set(p.id, { ...p, kind: 'approval' }); emit({ type: 'pending', request: { id: p.id, kind: 'approval', title: `Allow ${p.permission}?`, detail: permissionDetail(p, parts, sessionId), choices: ['Allow once', 'Deny'] } }) }
      if (event.type === 'question.asked') { pending.set(p.id, { ...p, kind: 'question' }); emit({ type: 'pending', request: { id: p.id, kind: 'question', title: 'OpenCode needs your input', questions: (p.questions || []).map((q: Json, i: number) => ({ id: String(i), question: q.question, options: q.options })) } }) }
      if (event.type === 'session.error') finished.reject(new Error(p.error?.data?.message || p.error?.name || JSON.stringify(p.error)))
      if (event.type === 'session.status' && p.status?.type === 'busy') seenBusy = true
      if (startedTurn && (seenBusy || messages.size > 0) && (event.type === 'session.idle' || (event.type === 'session.status' && p.status?.type === 'idle'))) void finish()
    }
    const start = (async () => {
      if (cancelled) throw abortError()
      const url = await bridge.listen()
      if (cancelled) throw abortError()
      const mcp: Json = { akorith: { type: 'remote', url, headers: { Authorization: `Bearer ${bridge.token}` }, oauth: false } }
      for (const s of request.mcpServers.filter(s => s.enabled)) mcp[s.id] = { type: 'local', command: [s.command, ...s.args], enabled: true }
      const permission = request.task.mode === 'full' ? { '*': 'allow' } : request.task.mode === 'read' ? { '*': 'ask', edit: 'deny', bash: 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', webfetch: 'allow' } : { '*': 'ask', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', edit: 'allow', webfetch: 'allow', external_directory: 'ask' }
      server = new OpenCodeServer(this.executable, request.cwd, { mcp, permission, share: 'disabled' }); this.servers.add(server)
      await server.start(); void server.exited.promise.catch(error => finished.reject(cancelled ? abortError() : error))
      if (cancelled) throw abortError()
      if (request.task.nativeSessions.opencode) { sessionId = request.task.nativeSessions.opencode; await server.request(`/session/${sessionId}`) }
      else sessionId = (await server.request('/session', { title: request.task.title })).id
      emit({ type: 'session', id: sessionId })
      const events = await server.events(controller.signal)
      void (async () => { for await (const event of readSse(events.body!)) receive(event); if (!finishing) throw new Error('OpenCode event connection closed unexpectedly') })().catch(error => { if (!controller.signal.aborted) finished.reject(error) })
      const imageParts = []
      for (const attachment of request.attachments.filter(a => a.mimeType.startsWith('image/'))) {
        if (attachment.size > 20 * 1024 * 1024) throw new Error('Image attachments must be smaller than 20 MB')
        imageParts.push({ type: 'file', mime: attachment.mimeType, filename: attachment.name, url: `data:${attachment.mimeType};base64,${(await readFile(attachment.path)).toString('base64')}` })
      }
      const slash = request.task.model.indexOf('/')
      if (slash <= 0) throw new Error('Choose an OpenCode provider/model first')
      controller.signal.throwIfAborted()
      startedTurn = true
      await server.request(`/session/${sessionId}/prompt_async`, { model: { providerID: request.task.model.slice(0, slash), modelID: request.task.model.slice(slash + 1) }, variant: request.task.effort || undefined, system: request.systemContext, parts: [{ type: 'text', text: nativePrompt(request) }, ...imageParts] })
      contextReceipt(request, emit, { stage: 'accepted', channel: 'native-prompt' })
      if (cancelled) throw abortError()
    })().catch(error => finished.reject(error))
    const cleanup = retryableCleanup(async () => {
      controller.abort(); pending.clear()
      await drainAll([server?.dispose() || Promise.resolve(), bridge.dispose()])
      await start
      if (server) await server.dispose()
      await bridge.dispose()
      if (server) this.servers.delete(server)
      settled = true; this.active.delete(done)
    })
    const done = finishWithCleanup(finished.promise, cleanup, emit)
    this.active.set(done, { cancel: () => { cancelled = true; controller.abort(); finished.reject(abortError()) }, cleanup })
    return {
      done,
      dispose: async () => { cancelled = true; controller.abort(); finished.reject(abortError()); await cleanup() },
      interrupt: async () => {
        if (settled) { await done.catch(() => {}); return }
        cancelled = true; controller.abort()
        await interruptAndWait(done, async () => {
          if (server && sessionId) { try { await server.request(`/session/${sessionId}/abort`, {}, undefined, 3000) } finally { finished.reject(abortError()) } }
          else { await start; finished.reject(abortError()) }
        }, async () => { await server?.dispose(); finished.reject(abortError()) })
      },
      respond: async (id, response) => {
        const item = pending.get(id)
        if (!item || !server) throw new Error('This OpenCode request is no longer pending')
        if (item.kind === 'question') {
          const value = typeof response === 'object' && response !== null ? response as Json : {}
          await server.request(`/question/${id}/reply`, { answers: item.questions.map((_: Json, i: number) => { const answer = value.answers?.[i] ?? (typeof response === 'string' ? response : ''); return Array.isArray(answer) ? answer : [String(answer)] }) })
        } else await server.request(`/permission/${id}/reply`, { reply: ['Allow once', 'allow', 'accept'].includes(String(response)) ? 'once' : 'reject' })
        pending.delete(id)
      }
    }
  }
  async dispose() {
    const active = [...this.active]
    for (const [, run] of active) run.cancel()
    await drainAll([...this.servers].map(server => server.dispose()).concat(active.map(([, run]) => run.cleanup())))
    await Promise.allSettled(active.map(([done]) => done)); this.servers.clear()
  }
}
