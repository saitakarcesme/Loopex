import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { OllamaProvider, readJsonLines } from '../main/providers/ollama'
import { readSse } from '../main/providers/opencode'
import { HostMcpBridge } from '../main/providers/mcp-bridge'
import { localMessages, localToolsPayload, initialLocalTools, toolSearch, bytes, LOCAL_INPUT_BYTES, checkLocalContext } from '../main/providers/local-context'
import type { HostTools, ProviderEvent, RunRequest } from '../shared/contracts'

const baseRequest: RunRequest = { task: { id: 'local-task', projectId: null, title: 'Test', providerId: 'ollama', model: 'test:small', effort: '', mode: 'work', status: 'running', pinned: false, archived: false, draft: '', createdAt: 1, updatedAt: 1, nativeSessions: {} }, cwd: '/tmp/test-workspace', turnId: 'turn-1', prompt: 'Read proof.txt', history: [], attachments: [], mcpServers: [], ollamaUrl: '' }
async function setup(t: any, chat: (body: any, res: any) => void) {
  const requests: any[] = [], calls: any[] = []
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk
    const body = text ? JSON.parse(text) : {}; requests.push({ path: req.url, body })
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/tags') res.end(JSON.stringify({ models: [{ name: 'test:small', size: 123, details: { parameter_size: '1B' } }] }))
    else if (req.url === '/api/version') res.end(JSON.stringify({ version: 'test-version' }))
    else if (req.url === '/api/show') res.end(JSON.stringify({ capabilities: ['tools'], model_info: { 'test.context_length': 8192 } }))
    else chat(body, res)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as any).port}`
  const host: HostTools = { definitions: [{ name: 'files_read', description: 'Read', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }], execute: async (name, args, context) => { calls.push({ name, args, context }); return { content: 'proof observed' } }, dispose: async () => {} }
  const provider = new OllamaProvider(host, () => url)
  t.after(async () => { await provider.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return { provider, requests, calls, request: { ...baseRequest, ollamaUrl: url }, host }
}
test('Ollama discovers models and completes an actual two-step host tool exchange', async t => {
  let count = 0
  const setupResult = await setup(t, (body, res) => {
    if (++count === 1) res.end(JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'files_read', arguments: { path: 'proof.txt' } } }] }, done: true, prompt_eval_count: 12, eval_count: 4 }) + '\n')
    else { assert.equal(body.messages.at(-1).role, 'tool'); assert.match(body.messages.at(-1).content, /proof observed/); res.write(JSON.stringify({ message: { content: 'Observed ' }, done: false }) + '\n'); res.end(JSON.stringify({ message: { content: 'proof.' }, done: true, prompt_eval_count: 20, eval_count: 3 }) + '\n') }
  })
  const { provider, request, calls } = setupResult, events: ProviderEvent[] = []
  assert.equal((await provider.discover()).capabilities.tools, true)
  await provider.run(request, e => events.push(e)).done
  assert.equal(calls.length, 1); assert.equal(calls[0].context.taskId, 'local-task')
  assert.equal(events.find(e => e.type === 'final')?.text, 'Observed proof.')
  assert.deepEqual(events.at(-1), { type: 'outcome', outcome: { status: 'completed' } })
  assert.deepEqual((events.filter(e => e.type === 'usage').at(-1) as any).usage, { inputTokens: 32, outputTokens: 7, totalTokens: 39 })
})
test('Ollama propagates server errors and truncated streams instead of reporting success', async t => {
  let invocation = 0
  const { provider, request } = await setup(t, (_, res) => { if (++invocation === 1) res.end(JSON.stringify({ error: 'model unavailable' }) + '\n'); else res.end(JSON.stringify({ message: { content: 'partial' }, done: false }) + '\n') })
  await assert.rejects(provider.run(request, () => {}).done, /model unavailable/)
  await assert.rejects(provider.run(request, () => {}).done, /before the response completed/)
})
test('Ollama cancellation aborts a streaming request without erasing received text', async t => {
  const { provider, request } = await setup(t, (_, res) => { res.write(JSON.stringify({ message: { content: 'partial' }, done: false }) + '\n') })
  let notify!: () => void; const received = new Promise<void>(resolve => { notify = resolve })
  const events: ProviderEvent[] = []
  const handle = provider.run(request, e => { events.push(e); if (e.type === 'delta') notify() })
  const done = assert.rejects(handle.done, { name: 'AbortError' })
  await received; await handle.interrupt(); await done
  assert.equal((events.find(e => e.type === 'delta') as any).text, 'partial')
})
test('Ollama does not execute unknown tools and sends a real tool failure back to the model', async t => {
  let count = 0
  const { provider, request, calls } = await setup(t, (body, res) => {
    if (++count === 1) res.end(JSON.stringify({ message: { tool_calls: [{ function: { name: 'invented_tool', arguments: {} } }] }, done: true }) + '\n')
    else { assert.match(body.messages.at(-1).content, /Unknown tool/); res.end(JSON.stringify({ message: { content: 'Tool unavailable.' }, done: true }) + '\n') }
  })
  await provider.run(request, () => {}).done; assert.equal(calls.length, 0)
})
test('Ollama restores application history without duplicating the active user turn', async t => {
  const { provider, request } = await setup(t, (body, res) => {
    assert.deepEqual(body.messages.slice(1).map((m: any) => [m.role, m.content]), [['user', 'Remember violet'], ['assistant', 'I remember violet'], ['user', 'Read proof.txt']])
    res.end(JSON.stringify({ message: { content: 'History retained.' }, done: true }) + '\n')
  })
  request.history = [
    { id: 'u1', taskId: 'local-task', turnId: 'old', role: 'user', content: 'Remember violet', activities: [], status: 'completed', createdAt: 1 },
    { id: 'a1', taskId: 'local-task', turnId: 'old', role: 'assistant', content: 'I remember violet', activities: [], status: 'completed', createdAt: 2 },
    { id: 'u2', taskId: 'local-task', turnId: 'turn-1', role: 'user', content: request.prompt, activities: [], status: 'completed', createdAt: 3 }
  ]
  await provider.run(request, () => {}).done
})
test('Ollama can discover a host tool omitted from the initial small catalog', async t => {
  let count = 0
  const { provider, request, host, calls } = await setup(t, (body, res) => {
    count++
    if (count === 1) {
      assert(!body.tools.some((tool: any) => tool.function.name === 'browser_open'))
      res.end(JSON.stringify({ message: { tool_calls: [{ function: { name: 'akorith_tool_search', arguments: { query: 'browser_open' } } }] }, done: true }) + '\n')
    } else if (count === 2) {
      assert(body.tools.some((tool: any) => tool.function.name === 'browser_open'))
      res.end(JSON.stringify({ message: { tool_calls: [{ function: { name: 'browser_open', arguments: { url: 'https://example.com' } } }] }, done: true }) + '\n')
    } else res.end(JSON.stringify({ message: { content: 'Opened with a real tool.' }, done: true }) + '\n')
  })
  host.definitions.push(...Array.from({ length: 10 }, (_, i) => ({ name: `utility_${i}`, description: 'Utility', inputSchema: { type: 'object' } })), { name: 'browser_open', description: 'Open a browser', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } })
  await provider.run(request, () => {}).done
  assert.equal(calls.length, 1); assert.equal(calls[0].name, 'browser_open')
})
test('NDJSON and SSE parsers preserve multibyte text and split frames', async () => {
  const encoded = new TextEncoder().encode(JSON.stringify({ text: 'çağrı 🦦' }) + '\n')
  const chunks = new ReadableStream<Uint8Array>({ start(c) { for (const byte of encoded) c.enqueue(Uint8Array.of(byte)); c.close() } })
  const output = []; for await (const value of readJsonLines(chunks)) output.push(value)
  assert.deepEqual(output, [{ text: 'çağrı 🦦' }])
  const sse = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('event: update\ndata: {"type":"message.part.delta",')); c.enqueue(new TextEncoder().encode('"properties":{"delta":"hello"}}\n\n')); c.close() } })
  const events = []; for await (const event of readSse(sse)) events.push(event)
  assert.equal(events[0].properties.delta, 'hello')
})
test('Local context budget includes skill text, tools and history without truncating the current prompt', () => {
  const request = { ...baseRequest, systemContext: 'skill instruction\n'.repeat(4000), prompt: 'Current task must remain exact.' }
  const definitions = Array.from({ length: 40 }, (_, i) => ({ name: `files_read_${i}`, description: 'Read files safely.'.repeat(15), inputSchema: { type: 'object' } }))
  const tools = localToolsPayload([...initialLocalTools(definitions, request.prompt), toolSearch])
  const packed = localMessages(request, request.prompt, tools, 'Host instructions')
  assert.equal(packed.contextTrimmed, true); assert.equal(packed.messages.at(-1)!.content, request.prompt)
  assert(bytes({ messages: packed.messages, tools }) <= LOCAL_INPUT_BYTES)
  assert.throws(() => localMessages(request, 'huge'.repeat(10_000), tools, 'Host instructions'), /prompt was not truncated/)
  assert.throws(() => checkLocalContext([{ role: 'tool', content: 'huge'.repeat(10_000) }], tools), /full next prompt was not sent/)
})
test('MCP HTTP bridge requires run bearer, scopes host calls, and sends screenshots as image content', async t => {
  let contextSeen: any
  const host: HostTools = { definitions: [{ name: 'capture', description: 'capture', inputSchema: { type: 'object' } }], execute: async (_, __, context) => { contextSeen = context; return { dataUrl: 'data:image/png;base64,aGVsbG8=', width: 1, height: 1 } }, dispose: async () => {} }
  const context = { taskId: 'task-7', cwd: '/tmp/scope', mode: 'full' as const }
  const bridge = new HostMcpBridge(host, context, new AbortController().signal), url = await bridge.listen()
  t.after(() => bridge.dispose())
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'capture', arguments: {} } })
  assert.equal((await fetch(url, { method: 'POST', body })).status, 403)
  assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${bridge.token}`, Origin: 'https://untrusted.test' }, body })).status, 403)
  const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${bridge.token}` }, body })
  const payload: any = await response.json()
  assert.deepEqual(contextSeen, context); assert.deepEqual(payload.result.content, [{ type: 'text', text: '{"width":1,"height":1}' }, { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }])
})
