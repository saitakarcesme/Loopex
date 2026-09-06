import { createHash } from 'node:crypto'
import type { HostTools, McpServer, ToolDefinition } from '../../shared/contracts'
import { JsonProcess, abortError, errorText, findExecutable, type Json } from './common'

class McpClient {
  private process?: JsonProcess
  private counter = 0
  private pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void; cleanup: () => void }>()
  constructor(readonly config: McpServer, private cwd: string, private signal: AbortSignal) {}
  async start(): Promise<Array<ToolDefinition & { readOnly?: boolean }>> {
    this.signal.throwIfAborted()
    const executable = await findExecutable(this.config.command)
    this.signal.throwIfAborted()
    this.process = new JsonProcess(executable, this.config.args, this.cwd)
    this.process.onMessage = message => {
      const pending = this.pending.get(message.id)
      if (pending && !message.method) { this.pending.delete(message.id); pending.cleanup(); message.error ? pending.reject(new Error(message.error.message || JSON.stringify(message.error))) : pending.resolve(message.result || {}); return }
      if (message.method && message.id !== undefined) this.process!.send({ jsonrpc: '2.0', id: message.id, ...(message.method === 'ping' ? { result: {} } : { error: { code: -32601, message: `Akorith local MCP does not support server request ${message.method}` } }) })
    }
    this.process.onClose = error => { for (const entry of this.pending.values()) { entry.cleanup(); entry.reject(error) }; this.pending.clear() }
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'akorith-next', version: '2.0.0' } }, 15_000)
    this.process.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const tools: Array<ToolDefinition & { readOnly?: boolean }> = []; let cursor: string | undefined
    do {
      const response = await this.request('tools/list', cursor ? { cursor } : {}, 15_000)
      for (const tool of response.tools || []) if (typeof tool.name === 'string') tools.push({ name: tool.name, description: tool.description || '', inputSchema: tool.inputSchema || { type: 'object' }, readOnly: tool.annotations?.readOnlyHint === true })
      cursor = response.nextCursor
      if (tools.length > 500) throw new Error(`${this.config.name} exposes more than the 500-tool local catalog limit`)
    } while (cursor)
    return tools
  }
  request(method: string, params: Json, timeout = 120_000): Promise<Json> {
    this.signal.throwIfAborted()
    const id = ++this.counter
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id); cleanup()
        if (this.process?.alive) this.process.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'Task stopped' } })
        reject(abortError())
      }
      const timer = setTimeout(() => { this.pending.delete(id); cleanup(); reject(new Error(`${this.config.name}: ${method} timed out`)) }, timeout)
      const cleanup = () => { clearTimeout(timer); this.signal.removeEventListener('abort', abort) }
      this.signal.addEventListener('abort', abort, { once: true })
      this.pending.set(id, { resolve, reject, cleanup })
      try { this.process!.send({ jsonrpc: '2.0', id, method, params }) } catch (error) { this.pending.delete(id); cleanup(); reject(error) }
    })
  }
  async dispose() { await this.process?.dispose() }
}
export class LocalMcpTools {
  private clients: McpClient[] = []
  private routes = new Map<string, { client: McpClient; nativeName: string; readOnly: boolean }>()
  private definitions: ToolDefinition[] = []
  constructor(private servers: McpServer[], private cwd: string, private signal: AbortSignal, private approve?: (title: string, args: Json) => Promise<boolean>) {}
  async connect(host: HostTools): Promise<HostTools> {
    for (const config of this.servers.filter(s => s.enabled)) {
      const client = new McpClient(config, this.cwd, this.signal); this.clients.push(client)
      try {
        const definitions = await client.start()
        for (const definition of definitions) {
          const key = createHash('sha256').update(`${config.id}:${definition.name}`).digest('hex').slice(0, 10)
          const name = `mcp_${key}_${definition.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 44)}`
          this.routes.set(name, { client, nativeName: definition.name, readOnly: !!definition.readOnly })
          this.definitions.push({ ...definition, name, description: `${config.name}: ${definition.description}` })
        }
      } catch (error) { throw new Error(`MCP server ${config.name} could not connect: ${errorText(error)}`) }
    }
    return {
      definitions: [...host.definitions, ...this.definitions],
      execute: async (name, args, context, signal) => {
        const route = this.routes.get(name)
        if (!route) return host.execute(name, args, context, signal)
        if (context.mode === 'read' && !route.readOnly) throw new Error(`${route.client.config.name}: this MCP tool is not declared read-only. Switch to Work or Full access to use it.`)
        if (context.mode !== 'full' && !route.readOnly && !(await this.approve?.(`${route.client.config.name} · ${route.nativeName}`, args))) throw new Error('The user declined this MCP tool request')
        const response = await route.client.request('tools/call', { name: route.nativeName, arguments: args })
        const text = (response.content || []).filter((c: Json) => c.type === 'text').map((c: Json) => c.text).join('\n')
        if (response.isError) throw new Error(text || 'MCP tool reported an error')
        const images = (response.content || []).filter((c: Json) => c.type === 'image')
        if (images.length > 1) throw new Error('This local tool returned multiple images; only one image per tool result is supported')
        if (images.length) return { text, dataUrl: `data:${images[0].mimeType};base64,${images[0].data}` }
        return response.structuredContent || text || response
      },
      dispose: () => this.dispose()
    }
  }
  async dispose() { await Promise.all(this.clients.map(client => client.dispose())); this.clients = []; this.routes.clear(); this.definitions = [] }
}
