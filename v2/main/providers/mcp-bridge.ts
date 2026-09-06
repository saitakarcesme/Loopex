import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { HostContext, HostTools } from '../../shared/contracts'
import { errorText, type Json } from './common'

/** Minimal stateless Streamable HTTP MCP host. Each run has its own bearer and task scope. */
export class HostMcpBridge {
  private server?: Server
  private active = new Set<Promise<unknown>>()
  private closed = false
  readonly token = randomBytes(32).toString('hex')
  constructor(private tools: HostTools, private context: HostContext, private signal: AbortSignal) {}
  async handle(message: Json): Promise<Json> {
    const result = (value: Json) => ({ jsonrpc: '2.0', id: message.id, result: value })
    if (message.method === 'initialize') return result({ protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'akorith-workspace', version: '2.0.0' } })
    if (message.method === 'ping') return result({})
    if (message.method === 'tools/list') return result({ tools: this.tools.definitions })
    if (message.method === 'tools/call') {
      try {
        if (!this.tools.definitions.some(t => t.name === message.params?.name)) throw new Error(`Unknown tool: ${message.params?.name}`)
        if (this.closed) throw new Error('This tool bridge is closed')
        this.signal.throwIfAborted()
        const operation = this.tools.execute(message.params.name, message.params.arguments || {}, this.context, this.signal)
        this.active.add(operation)
        let output: unknown
        try { output = await operation } finally { this.active.delete(operation) }
        const dataUrl = (output as Json)?.dataUrl
        const match = typeof dataUrl === 'string' ? /^data:(image\/[^;]+);base64,(.+)$/s.exec(dataUrl) : null
        return result({ content: match ? [{ type: 'text', text: JSON.stringify({ ...(output as Json), dataUrl: undefined }) }, { type: 'image', mimeType: match[1], data: match[2] }] : [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output) ?? 'null' }], isError: false })
      } catch (error) { return result({ content: [{ type: 'text', text: errorText(error) }], isError: true }) }
    }
    if (message.id === undefined) return { jsonrpc: '2.0', result: {} }
    return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Unsupported MCP method: ${message.method}` } }
  }
  async listen(): Promise<string> {
    if (this.closed) throw new Error('This tool bridge is closed')
    this.signal.throwIfAborted()
    this.server = createServer(async (req, res) => {
      if (req.headers.authorization !== `Bearer ${this.token}` || req.headers.origin) { res.writeHead(403).end(); return }
      if (req.method !== 'POST') { res.writeHead(405).end(); return }
      let data = ''
      try {
        for await (const chunk of req) { data += chunk; if (data.length > 4_000_000) { res.writeHead(413).end(); return } }
        const message = JSON.parse(data)
        if (message.id === undefined) { res.writeHead(202).end(); return }
        const response = await this.handle(message)
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(response))
      } catch (error) { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: errorText(error) })) }
    })
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(0, '127.0.0.1', resolve) })
    if (this.closed || this.signal.aborted) { await this.dispose(); throw new Error('This tool bridge was stopped during startup') }
    return `http://127.0.0.1:${(this.server.address() as { port: number }).port}/mcp`
  }
  async dispose() {
    this.closed = true
    if (this.server) { this.server.closeAllConnections(); await new Promise<void>(resolve => this.server!.close(() => resolve())) }
    await Promise.allSettled([...this.active])
    await this.tools.drain?.(this.context.taskId)
  }
}
