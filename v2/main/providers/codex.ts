import { CommandDetails } from './command-summary'
import type { Activity, HostTools, ProviderAdapter, ProviderInfo, RunHandle, RunRequest } from '../../shared/contracts'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { contextReceipt, JsonProcess, abortError, capture, deferred, drainAll, errorText, findExecutable, finishWithCleanup, interruptAndWait, nativePrompt, retryableCleanup, type Emit, type Json } from './common'

interface ActiveRun {
  request: RunRequest; emit: Emit; threadId: string; turnId?: string; interrupted: boolean
  finished: ReturnType<typeof deferred<void>>; activities: Map<string, Activity>; items: Map<string, Json>
  commands: CommandDetails; finalText: string; requests: Map<string, Json>; controller: AbortController
  usage: { inputTokens: number; outputTokens: number }; lastUsageTotal?: Json; hostCalls: Set<Promise<unknown>>
  connection?: JsonProcess; cleanup?: () => Promise<void>
}
const capabilities = { resume: true, steer: true, tools: true, approvals: true, images: true }
export async function resolveCodexExecutable(): Promise<string> {
  if (process.env.AKORITH_CODEX_PATH) return findExecutable(process.env.AKORITH_CODEX_PATH)
  const architecture = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  const platform = process.platform === 'darwin' ? 'apple-darwin' : process.platform === 'win32' ? 'pc-windows-msvc' : 'unknown-linux-musl'
  try {
    const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    const resolver = createRequire(join(process.cwd(), 'package.json'))
    const packagePath = resolver.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`, { paths: [typeof __dirname === 'string' ? __dirname : process.cwd(), process.cwd(), ...(resources ? [join(resources, 'app.asar')] : [])] })
    const binary = join(dirname(packagePath), 'vendor', `${architecture}-${platform}`, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex').replace(/app\.asar\//, 'app.asar.unpacked/')
    return await findExecutable(binary)
  } catch { return findExecutable('codex') }
}
export function codexPolicies(request: RunRequest) {
  return request.task.mode === 'full'
    ? { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } }
    : request.task.mode === 'read'
      ? { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } }
      : { approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [request.cwd], networkAccess: true } }
}
export class CodexProvider implements ProviderAdapter {
  readonly id = 'codex' as const
  private connection?: JsonProcess
  private opening?: JsonProcess
  private ownedConnections = new Set<JsonProcess>()
  private connecting?: Promise<JsonProcess>
  private generation = 0
  private runs = new Map<string, ActiveRun>()
  private active = new Set<ActiveRun>()
  constructor(private hostTools: HostTools, private executable?: string) {}
  private async executablePath() { return this.executable ? findExecutable(this.executable) : resolveCodexExecutable() }
  private async connect(): Promise<JsonProcess> {
    if (this.connection?.alive) return this.connection
    if (this.connecting) return this.connecting
    const generation = this.generation
    this.connecting = (async () => {
      const executable = await this.executablePath()
      if (generation !== this.generation) throw abortError()
      const rpc = new JsonProcess(executable, ['app-server', '--stdio']); this.opening = rpc; this.ownedConnections.add(rpc)
      rpc.onMessage = message => this.receive(rpc, message)
      rpc.onClose = error => { for (const run of this.runs.values()) run.finished.reject(error); this.runs.clear(); if (this.connection === rpc) this.connection = undefined }
      try {
        await rpc.request('initialize', { clientInfo: { name: 'akorith_workspace_v2', title: 'Akorith Next', version: '2.0.0' }, capabilities: { experimentalApi: true } })
        if (generation !== this.generation) throw abortError()
        rpc.send({ method: 'initialized' }); this.connection = rpc; return rpc
      } catch (error) {
        await finishWithCleanup(Promise.reject(error), async () => { await rpc.dispose(); this.ownedConnections.delete(rpc) })
        throw error
      }
      finally { if (this.opening === rpc) this.opening = undefined }
    })().finally(() => { this.connecting = undefined })
    return this.connecting
  }
  async discover(): Promise<ProviderInfo> {
    try {
      const rpc = await this.connect()
      const [catalog, account, version] = await Promise.all([rpc.request('model/list', { includeHidden: false, limit: 100 }), rpc.request('account/read', { refreshToken: false }), this.executablePath().then(path => capture(path, ['--version']))])
      const models = (catalog.data || []).filter((m: Json) => !m.hidden).map((m: Json) => ({ id: m.model || m.id, name: m.displayName || m.model, description: m.description, efforts: (m.supportedReasoningEfforts || []).map((e: Json) => e.reasoningEffort) }))
      const authenticated = !!account.account || account.requiresOpenaiAuth === false
      return { id: this.id, name: 'Codex', available: true, authenticated, version: version.trim(), models, capabilities, connectionLabel: authenticated ? account.account?.type === 'chatgpt' ? 'ChatGPT account · Codex CLI' : 'Codex CLI connection' : 'Sign in with codex login', error: authenticated ? undefined : 'Codex needs authentication. Run codex login in Terminal.' }
    } catch (error) { return { id: this.id, name: 'Codex', available: false, models: [], capabilities, connectionLabel: 'Codex CLI unavailable', error: errorText(error) } }
  }
  run(request: RunRequest, emit: Emit): RunHandle {
    const finished = deferred<void>()
    let settled = false
    // Attach a rejection observer immediately: startup may reject before callers await done.
    void finished.promise.catch(() => {})
    const run: ActiveRun = { request, emit, threadId: '', interrupted: false, finished, activities: new Map(), items: new Map(), commands: new CommandDetails(), finalText: '', requests: new Map(), controller: new AbortController(), usage: { inputTokens: 0, outputTokens: 0 }, hostCalls: new Set() }
    this.active.add(run)
    const start = (async () => {
      const rpc = await this.connect()
      run.connection = rpc
      if (run.interrupted) throw abortError()
      const policy = codexPolicies(request)
      // Akorith supplies the selected skill context. Do not inherit the desktop's automatic
      // skill-instruction catalog (which can refer to tools unavailable in this host).
      const mcpConfig: Json = { 'skills.include_instructions': false }
      for (const server of request.mcpServers.filter(s => s.enabled)) mcpConfig[`mcp_servers.${server.id.replace(/[^A-Za-z0-9_-]/g, '_')}`] = { command: server.command, args: server.args, enabled: true }
      const params: Json = { cwd: request.cwd, model: request.task.model || undefined, approvalPolicy: policy.approvalPolicy, sandbox: policy.sandbox, developerInstructions: request.systemContext || undefined, config: mcpConfig }
      const sessionId = request.task.nativeSessions.codex
      const session = sessionId
        ? await rpc.request('thread/resume', { ...params, threadId: sessionId, excludeTurns: true }, 60_000)
        : await rpc.request('thread/start', { ...params, ephemeral: false, dynamicTools: this.hostTools.definitions.map(t => ({ type: 'function', name: t.name, description: t.description, inputSchema: t.inputSchema })) }, 60_000)
      contextReceipt(request, emit, { stage: 'accepted', channel: 'native-session', notes: ['Codex accepted the session configuration carrying Akorith developer instructions. Native inheritance and model compliance are not certified.'] })
      run.threadId = session.thread.id
      if (this.runs.has(run.threadId)) throw new Error('This Codex session already has an active turn')
      emit({ type: 'session', id: run.threadId })
      if (run.interrupted) throw abortError()
      this.runs.set(run.threadId, run)
      const input: Json[] = [{ type: 'text', text: nativePrompt(request), text_elements: [] }]
      for (const attachment of request.attachments.filter(a => a.mimeType.startsWith('image/'))) input.push({ type: 'localImage', path: attachment.path })
      const response = await rpc.request('turn/start', { threadId: run.threadId, input, cwd: request.cwd, model: request.task.model || undefined, effort: request.task.effort || undefined, sandboxPolicy: policy.sandboxPolicy, approvalPolicy: policy.approvalPolicy }, 60_000)
      run.turnId = response.turn.id
      if (run.interrupted) await rpc.request('turn/interrupt', { threadId: run.threadId, turnId: run.turnId })
    })().catch(error => finished.reject(error))
    run.cleanup = retryableCleanup(async () => {
      if (this.runs.get(run.threadId) === run) this.runs.delete(run.threadId)
      run.controller.abort(); run.requests.clear()
      await Promise.allSettled([...run.hostCalls])
      await drainAll([this.hostTools.drain?.(request.task.id) || Promise.resolve(), run.connection && !run.connection.alive ? run.connection.dispose() : Promise.resolve()])
      settled = true; this.active.delete(run)
    })
    const done = finishWithCleanup(finished.promise, run.cleanup, emit)
    return {
      done,
      interrupt: async () => {
        if (settled) { await done.catch(() => {}); return }
        run.interrupted = true; run.controller.abort()
        await interruptAndWait(done, async () => {
          if (run.threadId && run.turnId && this.connection?.alive) await this.connection.request('turn/interrupt', { threadId: run.threadId, turnId: run.turnId }, 3000)
          else await start
        }, async () => { await this.dispose(); finished.reject(abortError()) })
      },
      steer: async text => {
        await start
        if (!run.turnId || !this.runs.has(run.threadId)) throw new Error('There is no active Codex turn to steer')
        await (await this.connect()).request('turn/steer', { threadId: run.threadId, expectedTurnId: run.turnId, input: [{ type: 'text', text, text_elements: [] }] })
      },
      respond: async (id, response) => {
        const pending = run.requests.get(id)
        if (!pending) throw new Error('This request is no longer pending')
        const result = codexResponse(pending, response)
        ;(await this.connect()).send({ id: pending.id, result }); run.requests.delete(id)
      }
    }
  }
  private receive(rpc: JsonProcess, message: Json) {
    const p = message.params || {}
    if (message.method === 'currentTime/read' && message.id !== undefined) { rpc.send({ id: message.id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } }); return }
    const run = this.runs.get(p.threadId || p.thread_id)
    if (!run) { if (message.id !== undefined && message.method) rpc.send({ id: message.id, error: { code: -32601, message: 'No active Akorith task handles this request' } }); return }
    if (p.turnId && run.turnId && p.turnId !== run.turnId) return
    if (message.id !== undefined) {
      const request = this.serverRequest(rpc, run, message).catch(error => { try { rpc.send({ id: message.id, error: { code: -32603, message: errorText(error) } }) } catch { /* disconnected */ } })
      run.hostCalls.add(request); void request.finally(() => run.hostCalls.delete(request)); return
    }
    if (message.method === 'turn/started') run.turnId = p.turn.id
    if (message.method === 'item/started' || message.method === 'item/completed') this.item(run, p.item, message.method === 'item/completed')
    if (message.method === 'item/agentMessage/delta') {
      const item = run.items.get(p.itemId)
      if (item?.phase === 'commentary') {
        const existing = run.activities.get(p.itemId)
        this.activity(run, { id: p.itemId, kind: 'commentary', title: 'Update', detail: (existing?.detail || '') + p.delta, status: 'running', startedAt: existing?.startedAt || Date.now() })
      } else run.emit({ type: 'delta', text: p.delta })
    }
    if (message.method === 'item/commandExecution/outputDelta') {
      const existing = run.activities.get(p.itemId)
      if (existing) this.activity(run, { ...existing, ...run.commands.update(p.itemId, undefined, p.delta, true) })
    }
    if (message.method === 'turn/plan/updated') this.activity(run, { id: `plan-${p.turnId}`, kind: 'plan', title: p.explanation || 'Plan', detail: (p.plan || []).map((s: Json) => `${s.status === 'completed' ? '✓' : s.status === 'inProgress' ? '→' : '○'} ${s.step}`).join('\n'), status: p.plan?.every((s: Json) => s.status === 'completed') ? 'completed' : 'running', startedAt: Date.now() })
    if (message.method === 'thread/tokenUsage/updated') {
      const usage = p.tokenUsage?.last || p.tokenUsage?.total
      if (usage) {
        const total = p.tokenUsage.total
        run.usage.inputTokens += total && run.lastUsageTotal ? Math.max(0, total.inputTokens - run.lastUsageTotal.inputTokens) : usage.inputTokens || 0
        run.usage.outputTokens += total && run.lastUsageTotal ? Math.max(0, total.outputTokens - run.lastUsageTotal.outputTokens) : usage.outputTokens || 0
        run.lastUsageTotal = total
        run.emit({ type: 'usage', usage: { ...run.usage, totalTokens: run.usage.inputTokens + run.usage.outputTokens } })
      }
    }
    if (message.method === 'error') this.activity(run, { id: `error-${Date.now()}`, kind: 'error', title: p.willRetry ? 'Connection recovering' : 'Provider error', detail: p.error?.message || p.message || 'Codex reported an error', status: p.willRetry ? 'running' : 'failed', startedAt: Date.now() })
    if (message.method === 'turn/completed') {
      if (p.turn.status === 'failed') run.finished.reject(new Error(p.turn.error?.message || 'Codex turn failed'))
      else if (p.turn.status === 'interrupted' || run.interrupted) run.finished.reject(abortError())
      else if (!run.finalText.trim()) run.finished.reject(new Error('Codex completed without a final assistant message'))
      else { run.emit({ type: 'final', text: run.finalText }); run.finished.resolve() }
    }
  }
  private activity(run: ActiveRun, activity: Activity) { run.activities.set(activity.id, activity); run.emit({ type: 'activity', activity }) }
  private item(run: ActiveRun, item: Json, completed: boolean) {
    run.items.set(item.id, item)
    const previous = run.activities.get(item.id)
    const base = { id: item.id, status: (completed ? ['failed', 'declined', 'cancelled'].includes(item.status) || item.success === false ? 'failed' : 'completed' : 'running') as Activity['status'], startedAt: previous?.startedAt || Date.now(), endedAt: completed ? Date.now() : undefined }
    switch (item.type) {
      case 'agentMessage':
        if (item.phase === 'commentary') this.activity(run, { ...base, kind: 'commentary', title: 'Update', detail: item.text })
        else if (completed) run.finalText = item.text
        break
      case 'commandExecution': this.activity(run, { ...base, kind: 'command', ...run.commands.update(item.id, item.command, item.aggregatedOutput) }); break
      case 'fileChange': this.activity(run, { ...base, kind: 'file', title: (item.changes || []).map((c: Json) => c.path).join(', ') || 'File changes', detail: (item.changes || []).map((c: Json) => c.diff || '').join('\n'), filePath: item.changes?.[0]?.path }); break
      case 'mcpToolCall': case 'dynamicToolCall': this.activity(run, { ...base, kind: 'tool', title: item.server ? `${item.server} · ${item.tool}` : item.tool, detail: JSON.stringify(completed ? item.result || item.contentItems || item.error : item.arguments, null, 2)?.slice(0, 100_000) }); break
      case 'plan': this.activity(run, { ...base, kind: 'plan', title: 'Plan', detail: item.text }); break
      case 'webSearch': this.activity(run, { ...base, kind: 'tool', title: 'Web search', detail: item.query || JSON.stringify(item.action || {}) }); break
      case 'contextCompaction': this.activity(run, { ...base, kind: 'status', title: 'Compacting conversation context' }); break
      case 'collabAgentToolCall': this.activity(run, { ...base, kind: 'tool', title: `Agent · ${item.tool}`, detail: item.prompt }); break
    }
  }
  private async serverRequest(rpc: JsonProcess, run: ActiveRun, message: Json) {
    const p = message.params || {}, id = String(message.id)
    if (run.interrupted) { rpc.send({ id: message.id, error: { code: -32800, message: 'This Akorith turn has been interrupted' } }); return }
    if (message.method === 'item/tool/call') {
      try {
        run.controller.signal.throwIfAborted()
        const output = await this.hostTools.execute(p.tool, p.arguments || {}, { taskId: run.request.task.id, turnId: run.request.turnId, cwd: run.request.cwd, mode: run.request.task.mode }, run.controller.signal)
        const dataUrl = (output as Json)?.dataUrl
        const contentItems: Json[] = typeof dataUrl === 'string' && dataUrl.startsWith('data:image/') ? [{ type: 'inputText', text: JSON.stringify({ ...(output as Json), dataUrl: undefined }) }, { type: 'inputImage', imageUrl: dataUrl }] : [{ type: 'inputText', text: typeof output === 'string' ? output : JSON.stringify(output) ?? 'null' }]
        rpc.send({ id: message.id, result: { contentItems, success: true } })
      } catch (error) { rpc.send({ id: message.id, result: { contentItems: [{ type: 'inputText', text: errorText(error) }], success: false } }) }
      return
    }
    const question = message.method === 'item/tool/requestUserInput' || message.method === 'mcpServer/elicitation/request'
    if (!question && !message.method.includes('requestApproval')) { rpc.send({ id: message.id, error: { code: -32601, message: `Unsupported provider request: ${message.method}` } }); return }
    run.requests.set(id, message)
    const formQuestions = p.requestedSchema?.properties ? Object.entries(p.requestedSchema.properties).map(([key, field]: [string, any]) => ({ id: key, question: field.title || field.description || key, options: field.enum?.map((label: unknown) => ({ label: String(label) })) })) : undefined
    run.emit({ type: 'pending', request: { id, kind: question ? 'question' : 'approval', title: question ? p.message || 'Codex needs your input' : 'Permission requested', detail: p.reason || p.command || (p.permissions ? JSON.stringify(p.permissions) : p.url ? `Open ${p.url} and reply Continue when finished.` : undefined), choices: question ? undefined : ['Allow once', 'Deny'], questions: p.questions?.map((q: Json) => ({ id: q.id, question: q.question, options: q.options || undefined })) || formQuestions } })
  }
  async dispose() {
    this.generation++
    const runs = [...this.active], connections = [...this.ownedConnections]
    for (const run of runs) run.controller.abort()
    await drainAll(connections.map(async rpc => { await rpc.dispose(); this.ownedConnections.delete(rpc) }))
    for (const run of runs) run.finished.reject(abortError())
    await drainAll(runs.map(run => run.cleanup?.() || Promise.resolve()))
  }
}
export function codexResponse(request: Json, response: unknown): Json {
  const value = typeof response === 'object' && response !== null ? response as Json : { decision: response }
  if (request.method === 'item/tool/requestUserInput') {
    const answers: Json = {}
    for (const question of request.params.questions || []) {
      const answer = value.answers?.[question.id] ?? value[question.id] ?? (typeof response === 'string' ? response : '')
      answers[question.id] = { answers: Array.isArray(answer?.answers) ? answer.answers : Array.isArray(answer) ? answer : [String(answer)] }
    }
    return { answers }
  }
  const accepted = ['accept', 'acceptForSession', 'allow', 'Allow once', true].includes(value.decision)
  if (request.method === 'item/permissions/requestApproval') return { permissions: accepted ? request.params.permissions || {} : {}, scope: 'turn' }
  if (request.method === 'mcpServer/elicitation/request') {
    if (request.params.mode === 'url') return { action: accepted || typeof response === 'string' && /^(continue|done|accept|yes)$/i.test(response.trim()) ? 'accept' : 'decline', content: null }
    if (value.action === 'decline' || value.action === 'cancel') return { action: value.action, content: null }
    let content: Json = value.content || value.answers
    if (!content && typeof response === 'string') {
      try { content = JSON.parse(response) } catch { throw new Error('This tool requires structured answers. Please fill in the requested fields.') }
    }
    if (!content || typeof content !== 'object') throw new Error('This tool requires structured answers')
    const fields = request.params.requestedSchema?.properties || {}
    for (const [key, field] of Object.entries(fields) as Array<[string, Json]>) {
      if (field.type === 'number' || field.type === 'integer') { const number = Number(content[key]); if (!Number.isFinite(number)) throw new Error(`${key} must be a number`); content[key] = number }
      if (field.type === 'boolean') content[key] = content[key] === true || content[key] === 'true'
    }
    return { action: 'accept', content }
  }
  return { decision: accepted ? value.decision === 'acceptForSession' ? 'acceptForSession' : 'accept' : value.decision === 'cancel' ? 'cancel' : 'decline' }
}
