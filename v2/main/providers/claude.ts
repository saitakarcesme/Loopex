import { CommandDetails } from './command-summary'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { Activity, HostTools, ProviderAdapter, ProviderInfo, RunHandle, RunRequest } from '../../shared/contracts'
import { contextReceipt, JsonProcess, abortError, capture, deferred, drainAll, errorText, findExecutable, finishWithCleanup, interruptAndWait, nativePrompt, retryableCleanup, type Emit, type Json } from './common'
import { HostMcpBridge } from './mcp-bridge'

/** Claude's supported stream-json/control protocol, as used by the official Agent SDK. */
export class ClaudeConnection {
  readonly process: JsonProcess
  private requests = new Map<string, { resolve: (value: Json) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  onMessage: (message: Json) => void = () => {}
  onClose: (error: Error) => void = () => {}
  constructor(executable: string, args: string[], cwd: string) {
    this.process = new JsonProcess(executable, ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio', ...args], cwd)
    this.process.onMessage = message => {
      if (message.type === 'control_response') {
        const response = message.response, pending = this.requests.get(response.request_id)
        if (pending) { clearTimeout(pending.timer); this.requests.delete(response.request_id); response.subtype === 'error' ? pending.reject(new Error(response.error)) : pending.resolve(response.response || {}) }
      } else this.onMessage(message)
    }
    this.process.onClose = error => { for (const pending of this.requests.values()) { clearTimeout(pending.timer); pending.reject(error) }; this.requests.clear(); this.onClose(error) }
  }
  control(request: Json, timeout = 30_000): Promise<Json> {
    const request_id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(request_id); reject(new Error(`Claude ${request.subtype} timed out`)) }, timeout)
      this.requests.set(request_id, { resolve, reject, timer })
      try { this.process.send({ type: 'control_request', request_id, request }) } catch (error) { clearTimeout(timer); this.requests.delete(request_id); reject(error) }
    })
  }
  reply(requestId: string, response: Json) { if (this.process.alive) this.process.send({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } }) }
  async dispose() { await this.process.dispose() }
}
export class ClaudeProvider implements ProviderAdapter {
  readonly id = 'claude' as const
  private connections = new Set<ClaudeConnection>()
  private generation = 0
  private active = new Map<Promise<unknown>, { cancel: () => void; cleanup: () => Promise<void> }>()
  constructor(private hostTools: HostTools, private executable = 'claude') {}
  async discover(): Promise<ProviderInfo> {
    const generation = this.generation
    const capabilities = { resume: true, steer: false, tools: true, approvals: true, images: true }
    let connection: ClaudeConnection | undefined
    try {
      const [path, version, authText] = await Promise.all([findExecutable(this.executable), capture(this.executable, ['--version']), capture(this.executable, ['auth', 'status', '--json'], 12_000, true)])
      const auth = JSON.parse(authText)
      if (generation !== this.generation) throw abortError()
      connection = new ClaudeConnection(path, [], tmpdir())
      this.connections.add(connection)
      const info = await connection.control({ subtype: 'initialize', hooks: null }, 20_000)
      const models = (info.models || []).map((m: Json) => ({ id: m.value, name: m.displayName, description: m.description, efforts: m.supportedEffortLevels || [] }))
      return { id: this.id, name: 'Claude Code', available: true, authenticated: !!auth.loggedIn, version: version.trim(), models, capabilities, connectionLabel: auth.loggedIn ? 'Claude Code · existing CLI account' : 'Sign in with claude auth login', error: auth.loggedIn ? undefined : 'Claude Code is installed but not signed in. Run claude auth login in Terminal.' }
    } catch (error) { return { id: this.id, name: 'Claude Code', available: false, models: [], capabilities, connectionLabel: 'Claude Code unavailable', error: errorText(error) } }
    finally { if (connection) { await connection.dispose(); this.connections.delete(connection) } }
  }
  run(request: RunRequest, emit: Emit): RunHandle {
    const result = deferred<void>(), controller = new AbortController()
    void result.promise.catch(() => {})
    let connection: ClaudeConnection | undefined, cancelled = false, completed = false, settled = false, streamed = '', finalText = ''
    const approvals = new Map<string, Json>(), activities = new Map<string, Activity>(), commands = new CommandDetails()
    const bridge = new HostMcpBridge(this.hostTools, { taskId: request.task.id, turnId: request.turnId, cwd: request.cwd, mode: request.task.mode }, controller.signal)
    const toolActivity = (activity: Activity) => { activities.set(activity.id, activity); emit({ type: 'activity', activity }) }
    const start = (async () => {
      const executable = await findExecutable(this.executable)
      if (cancelled) throw abortError()
      const mcpServers: Json = { akorith: { type: 'sdk', name: 'akorith' } }
      for (const server of request.mcpServers.filter(s => s.enabled)) mcpServers[server.id] = { command: server.command, args: server.args }
      const args = ['--mcp-config', JSON.stringify({ mcpServers }), '--permission-mode', request.task.mode === 'full' ? 'bypassPermissions' : request.task.mode === 'read' ? 'plan' : 'manual']
      if (request.task.mode === 'full') args.push('--allow-dangerously-skip-permissions')
      if (request.task.mode === 'read') args.push('--tools', 'Read,Grep,Glob,WebSearch,WebFetch,AskUserQuestion')
      if (request.task.model) args.push('--model', request.task.model)
      if (request.task.effort) args.push('--effort', request.task.effort)
      if (request.task.nativeSessions.claude) args.push('--resume', request.task.nativeSessions.claude)
      if (request.systemContext) args.push('--append-system-prompt', request.systemContext)
      connection = new ClaudeConnection(executable, args, request.cwd); this.connections.add(connection)
      connection.onClose = error => { if (!completed) result.reject(cancelled ? abortError() : error) }
      connection.onMessage = message => {
        if (message.session_id) emit({ type: 'session', id: message.session_id })
        if (message.type === 'control_request') {
          const p = message.request, id = message.request_id
          if (p.subtype === 'mcp_message') { void bridge.handle(p.message).then(mcp_response => connection!.reply(id, { mcp_response })).catch(error => connection?.reply(id, { mcp_response: { jsonrpc: '2.0', id: p.message.id, error: { code: -32603, message: errorText(error) } } })); return }
          if (p.subtype === 'can_use_tool') {
            if (cancelled) { connection!.reply(id, { behavior: 'deny', message: 'This Akorith turn has been interrupted' }); return }
            approvals.set(id, p)
            const question = p.tool_name === 'AskUserQuestion'
            emit({ type: 'pending', request: { id, kind: question ? 'question' : 'approval', title: question ? 'Claude needs your input' : `Allow ${p.tool_name}?`, detail: p.description || p.decision_reason || JSON.stringify(p.input, null, 2), choices: question ? undefined : ['Allow once', 'Deny'], questions: question ? (p.input.questions || []).map((q: Json, index: number) => ({ id: String(index), question: q.question, options: q.options })) : undefined } })
          } else connection!.reply(id, { behavior: 'deny', message: `Unsupported control request: ${p.subtype}` })
          return
        }
        if (message.type === 'control_cancel_request') { approvals.delete(message.request_id); return }
        if (message.type === 'stream_event' && message.event?.type === 'content_block_delta' && message.event.delta?.type === 'text_delta') { const text = message.event.delta.text; streamed += text; emit({ type: 'delta', text }) }
        if (message.type === 'assistant') {
          const blocks = message.message?.content || []
          const text = blocks.filter((b: Json) => b.type === 'text').map((b: Json) => b.text).join('\n')
          if (text) { finalText = text; if (!streamed) emit({ type: 'delta', text }); streamed = '' }
          for (const block of blocks.filter((b: Json) => b.type === 'tool_use')) toolActivity({ id: block.id, kind: block.name === 'Bash' ? 'command' : ['Edit', 'Write'].includes(block.name) ? 'file' : 'tool', ...(block.name === 'Bash' ? commands.update(block.id, block.input?.command) : { title: block.name, detail: JSON.stringify(block.input, null, 2) }), status: 'running', startedAt: Date.now(), filePath: block.input?.file_path })
        }
        if (message.type === 'user' && Array.isArray(message.message?.content)) for (const block of message.message.content.filter((b: Json) => b.type === 'tool_result')) {
          const previous = activities.get(block.tool_use_id)
          if (previous) toolActivity({ ...previous, status: block.is_error ? 'failed' : 'completed', ...(previous.kind === 'command' ? commands.update(block.tool_use_id, undefined, typeof block.content === 'string' ? block.content : JSON.stringify(block.content)) : { detail: (typeof block.content === 'string' ? block.content : JSON.stringify(block.content)).slice(0, 100_000) }), endedAt: Date.now() })
        }
        if (message.type === 'result') {
          completed = true
          if (cancelled) result.reject(abortError())
          else if (message.is_error || message.subtype !== 'success') result.reject(new Error(message.errors?.join('\n') || message.result || `Claude ended with ${message.subtype}`))
          else if (!(message.result || finalText).trim()) result.reject(new Error('Claude completed without a final assistant message'))
          else { emit({ type: 'final', text: message.result || finalText }); emit({ type: 'usage', usage: { inputTokens: message.usage?.input_tokens, outputTokens: message.usage?.output_tokens, costUsd: message.total_cost_usd } }); result.resolve() }
        }
      }
      await connection.control({ subtype: 'initialize', hooks: null }, 60_000)
      if (cancelled) throw abortError()
      const content: Json[] = [{ type: 'text', text: nativePrompt(request) }]
      for (const attachment of request.attachments.filter(a => a.mimeType.startsWith('image/'))) {
        if (attachment.size > 20 * 1024 * 1024) throw new Error('Image attachments must be smaller than 20 MB')
        content.push({ type: 'image', source: { type: 'base64', media_type: attachment.mimeType, data: (await readFile(attachment.path)).toString('base64') } })
      }
      controller.signal.throwIfAborted()
      connection.process.send({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: request.task.nativeSessions.claude || '' })
      contextReceipt(request, emit, { stage: 'submitted', channel: 'native-prompt', notes: ['Akorith append-system-prompt was supplied to the CLI and the user message was written to its transport. This is submission, not a native acceptance or compliance claim.'] })
    })().catch(error => result.reject(error))
    const cleanup = retryableCleanup(async () => {
      controller.abort(); approvals.clear()
      await drainAll([connection?.dispose() || Promise.resolve(), bridge.dispose()])
      await start
      if (connection) await connection.dispose()
      await bridge.dispose()
      if (connection) this.connections.delete(connection)
      settled = true; this.active.delete(done)
    })
    const done = finishWithCleanup(result.promise, cleanup, emit)
    this.active.set(done, { cancel: () => { cancelled = true; controller.abort(); result.reject(abortError()) }, cleanup })
    return {
      done,
      dispose: async () => { cancelled = true; controller.abort(); result.reject(abortError()); await cleanup() },
      interrupt: async () => {
        if (settled) { await done.catch(() => {}); return }
        cancelled = true; controller.abort()
        await interruptAndWait(done, async () => {
          if (connection) { try { await connection.control({ subtype: 'interrupt' }, 3000) } catch { /* owned process termination below */ }; result.reject(abortError()) }
          else await start
        }, async () => { await connection?.dispose(); result.reject(abortError()) })
      },
      respond: async (id, response) => {
        const pending = approvals.get(id)
        if (!pending || !connection) throw new Error('This Claude request is no longer pending')
        connection.reply(id, claudePermissionResponse(pending, response)); approvals.delete(id)
      }
    }
  }
  async dispose() {
    this.generation++
    const active = [...this.active]
    for (const [, run] of active) run.cancel()
    await drainAll([...this.connections].map(connection => connection.dispose()).concat(active.map(([, run]) => run.cleanup())))
    await Promise.allSettled(active.map(([done]) => done)); this.connections.clear()
  }
}
export function claudePermissionResponse(request: Json, response: unknown): Json {
  if (request.tool_name === 'AskUserQuestion') {
    const values = typeof response === 'object' && response !== null ? response as Json : {}
    const answers: Json = {}
    for (const [index, question] of (request.input.questions || []).entries()) answers[question.question] = String(values.answers?.[index] ?? (typeof response === 'string' ? response : ''))
    return { behavior: 'allow', updatedInput: { ...request.input, answers } }
  }
  const choice = typeof response === 'object' && response !== null ? (response as Json).decision : response
  return ['Allow once', 'allow', 'accept', true].includes(choice) ? { behavior: 'allow', updatedInput: request.input } : { behavior: 'deny', message: 'The user declined this tool request' }
}
