import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMcpTools } from '../main/providers/mcp-client'
import type { HostTools } from '../shared/contracts'

const fixture = `#!/usr/bin/env node
const readline=require('node:readline');const fs=require('node:fs');
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.jsonrpc!=='2.0')process.exit(8);if(m.id===undefined)return;let result={};
if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}};
if(m.method==='tools/list')result={tools:[{name:'read_proof',description:'Read the proof',annotations:{readOnlyHint:true},inputSchema:{type:'object'}},{name:'write_proof',description:'Write the proof',inputSchema:{type:'object'}},{name:'wait',description:'Wait',inputSchema:{type:'object'}}]};
if(m.method==='tools/call'){if(m.params.name==='wait')return;if(m.params.name==='write_proof')fs.writeFileSync('output.txt','written');result={content:[{type:'text',text:m.params.name==='read_proof'?fs.readFileSync('proof.txt','utf8'):'written'}]}};
send({jsonrpc:'2.0',id:m.id,result});});
`
const empty: HostTools = { definitions: [], execute: async () => { throw new Error('unexpected host tool') }, dispose: async () => {} }
async function setup(t: any, approve?: (name: string, args: any) => Promise<boolean>) {
  const cwd = await mkdtemp(join(tmpdir(), 'akorith-mcp-test-')), executable = join(cwd, 'mcp')
  await writeFile(executable, fixture); await chmod(executable, 0o755); await writeFile(join(cwd, 'proof.txt'), 'observed mcp proof')
  const controller = new AbortController(), plugins = new LocalMcpTools([{ id: 'test-server', name: 'Test plugin', command: executable, args: [], enabled: true }], cwd, controller.signal, approve)
  t.after(async () => { controller.abort(); await plugins.dispose(); await rm(cwd, { recursive: true, force: true }) })
  const tools = await plugins.connect(empty)
  return { tools, cwd, controller, name: (suffix: string) => tools.definitions.find(t => t.name.endsWith(suffix))!.name }
}
test('Local MCP discovers namespaced tools and exchanges a real stdio file result', async t => {
  const { tools, cwd, name } = await setup(t)
  assert.equal(tools.definitions.length, 3)
  assert.equal(await tools.execute(name('read_proof'), {}, { taskId: 'a', cwd, mode: 'read' }), 'observed mcp proof')
})
test('Local MCP requires approval for mutations and enforces Inspect mode', async t => {
  let allowed = false, approvals = 0
  const { tools, cwd, name } = await setup(t, async () => { approvals++; return allowed })
  await assert.rejects(tools.execute(name('write_proof'), {}, { taskId: 'a', cwd, mode: 'read' }), /not declared read-only/)
  await assert.rejects(tools.execute(name('write_proof'), {}, { taskId: 'a', cwd, mode: 'work' }), /declined/)
  await assert.rejects(readFile(join(cwd, 'output.txt')), /ENOENT/)
  allowed = true; await tools.execute(name('write_proof'), {}, { taskId: 'a', cwd, mode: 'work' })
  assert.equal(await readFile(join(cwd, 'output.txt'), 'utf8'), 'written'); assert.equal(approvals, 2)
})
test('Local MCP aborts a pending upstream tool request', async t => {
  const { tools, cwd, name, controller } = await setup(t)
  const result = tools.execute(name('wait'), {}, { taskId: 'a', cwd, mode: 'full' })
  const rejected = assert.rejects(result, { name: 'AbortError' }); controller.abort(); await rejected
})
