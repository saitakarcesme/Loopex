/** Explicit live integration harness. Never included in ordinary *.test.ts tests.
 * Run: npx tsx v2/tests/providers-live.ts codex|ollama|opencode [model]
 * Uses only a new scratch directory and the selected provider's existing connection.
 */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexProvider, OllamaProvider, OpenCodeProvider } from '../main/providers'
import { readFile as readWorkspaceFile } from '../main/host/files'
import type { HostTools, ProviderAdapter, ProviderId, RunRequest, Task } from '../shared/contracts'

async function main() {
  const id = process.argv[2] as ProviderId
  if (!['codex', 'ollama', 'opencode'].includes(id)) throw new Error('Choose codex, ollama or opencode explicitly')
  const cwd = await mkdtemp(join(tmpdir(), `akorith-live-${id}-`)), proof = `akorith-${randomUUID()}`
  await writeFile(join(cwd, 'proof.txt'), proof)
  let calls = 0
  const host: HostTools = {
    definitions: [{ name: 'files_read', description: 'Read a real file inside this task workspace.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }],
    execute: async (name, args, context) => { assert.equal(name, 'files_read'); calls++; return readWorkspaceFile(context, String(args.path)) }, dispose: async () => {}
  }
  const create = (): ProviderAdapter => id === 'codex' ? new CodexProvider(host) : id === 'ollama' ? new OllamaProvider(host) : new OpenCodeProvider(host)
  let provider = create()
  const catalog = await provider.discover()
  assert.equal(catalog.available, true, catalog.error || 'Provider is unavailable'); assert.equal(catalog.authenticated, true, catalog.error || 'Provider is not authenticated')
  const model = process.argv[3] || (id === 'opencode' ? '' : catalog.models[0]?.id)
  if (!model) throw new Error('Choose an explicit OpenCode model from its live catalog; this harness never falls back between billing routes')
  assert(catalog.models.some(m => m.id === model), `Model ${model} is not in the current catalog`)
  const task: Task = { id: randomUUID(), projectId: null, title: 'Bounded provider verification', providerId: id, model, effort: id === 'codex' ? 'low' : '', mode: 'work', status: 'running', pinned: false, archived: false, draft: '', createdAt: Date.now(), updatedAt: Date.now(), nativeSessions: {} }
  const request = (prompt: string): RunRequest => ({ task, turnId: randomUUID(), prompt, cwd, history: [], attachments: [], mcpServers: [], ollamaUrl: 'http://127.0.0.1:11434' })
  async function run(prompt: string) {
    let final = ''
    const handle = provider.run(request(prompt), event => {
      if (event.type === 'session') task.nativeSessions[id] = event.id
      if (event.type === 'final') final = event.text
      if (event.type === 'pending') {
        // Only the scratch read-only MCP call is authorized by this harness.
        const answer = event.request.kind === 'approval' && /files_read/.test(event.request.title) ? 'Allow once' : 'Deny'
        void handle.respond?.(event.request.id, answer)
      }
    })
    const timeout = setTimeout(() => void handle.interrupt(), 120_000)
    try { await handle.done } finally { clearTimeout(timeout) }
    return final
  }
  try {
    const answer = await run('Use the Akorith files_read tool to read proof.txt. Reply with its exact content. Use no other tools.')
    assert(answer.includes(proof), 'Final answer must contain the actual scratch file token'); assert(calls > 0, 'A real workspace read must have executed')
    const firstCalls = calls
    await provider.dispose()
    if (id !== 'ollama') {
      provider = create()
      const followup = await run('What exact verification token did you just read? Answer from our previous conversation. Do not use any tools.')
      assert(followup.includes(proof), 'Native session must retain the prior conversation after process restart'); assert.equal(calls, firstCalls)
    }
    console.log(JSON.stringify({ provider: id, version: catalog.version, model, workspace: cwd, nativeSession: task.nativeSessions[id], hostToolCalls: calls, realFileRead: true, processRestartResume: id === 'ollama' ? 'application-history contract; tested separately' : true }, null, 2))
  } finally { await provider.dispose() }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
