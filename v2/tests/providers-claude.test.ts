import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeProvider, claudePermissionResponse } from '../main/providers/claude'
import type { HostTools, ProviderEvent, RunRequest } from '../shared/contracts'

const executableSource = `#!/usr/bin/env node
const readline=require('node:readline');const args=process.argv;
if(args.includes('--version')){console.log('Claude test');process.exit(0)}
if(args.includes('auth')){console.log(JSON.stringify({loggedIn:true}));process.exit(0)}
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
const result=text=>send({type:'result',subtype:'success',session_id:'session-claude',result:text,usage:{input_tokens:5,output_tokens:3},total_cost_usd:0});
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.type==='control_request'){
send({type:'control_response',response:{request_id:m.request_id,subtype:'success',response:m.request.subtype==='initialize'?{models:[{value:'actual-model',displayName:'Actual model',supportedEffortLevels:['high']}]}:{}}});
return}
if(m.type==='user'){
require('node:fs').writeFileSync(require('node:path').join(__dirname,'received-context.json'),JSON.stringify({system:args[args.indexOf('--append-system-prompt')+1],message:m}));
send({type:'system',subtype:'init',session_id:'session-claude'});
if(m.message.content[0].text==='tool')return send({type:'control_request',request_id:'mcp-call',request:{subtype:'mcp_message',server_name:'akorith',message:{jsonrpc:'2.0',id:9,method:'tools/call',params:{name:'files_read',arguments:{path:'proof.txt'}}}}});
if(m.message.content[0].text==='permission')return send({type:'control_request',request_id:'permission',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'echo ok'}}});
if(m.message.content[0].text==='command-display'){send({type:'assistant',message:{content:[{type:'tool_use',id:'command',name:'Bash',input:{command:'echo exact-command'}}]}});send({type:'user',message:{content:[{type:'tool_result',tool_use_id:'command',content:'final output'}]}});return result('done')}
if(m.message.content[0].text==='wait'){send({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'partial'}}});return}
send({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'hello'}}});send({type:'assistant',message:{content:[{type:'text',text:'hello'}]}});return result('hello')}
if(m.type==='control_response'){if(m.response.request_id==='mcp-call')return result(m.response.response.mcp_response.result.content[0].text);if(m.response.request_id==='permission')return result(m.response.response.behavior)}
});
`
async function setup(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'akorith-claude-test-')), executable = join(dir, 'claude')
  await writeFile(executable, executableSource); await chmod(executable, 0o755)
  let calls = 0
  const host: HostTools = { definitions: [{ name: 'files_read', description: 'Read', inputSchema: { type: 'object' } }], execute: async () => { calls++; return 'real result' }, dispose: async () => {} }
  const provider = new ClaudeProvider(host, executable)
  t.after(async () => { await provider.dispose(); await rm(dir, { recursive: true, force: true }) })
  const request = (prompt: string): RunRequest => ({ task: { id: 'test', projectId: null, title: 'Test', providerId: 'claude', model: 'actual-model', effort: 'high', mode: 'work', status: 'running', pinned: false, archived: false, draft: '', createdAt: 1, updatedAt: 1, nativeSessions: {} }, cwd: dir, turnId: 'turn-1', prompt, history: [], attachments: [], mcpServers: [], ollamaUrl: '' })
  return { provider, request, dir, calls: () => calls }
}
test('Claude discovers supported control catalog and does not duplicate streamed text', async t => {
  const { provider, request } = await setup(t), events: ProviderEvent[] = []
  const info = await provider.discover(); assert.equal(info.models[0].id, 'actual-model'); assert.equal(info.authenticated, true)
  await provider.run(request('hello'), e => events.push(e)).done
  assert.deepEqual(events.filter(e => e.type === 'delta').map(e => e.text), ['hello'])
  assert.equal(events.find(e => e.type === 'session')?.id, 'session-claude')
})
test('Claude SDK MCP tool result returns through its native control protocol', async t => {
  const { provider, request, calls } = await setup(t), events: ProviderEvent[] = []
  await provider.run(request('tool'), e => events.push(e)).done
  assert.equal(calls(), 1); assert.equal((events.find(e => e.type === 'final') as any).text, 'real result')
})
test('Claude permission answers and interruption settle the active run', async t => {
  const { provider, request } = await setup(t)
  let handle: ReturnType<ClaudeProvider['run']>
  const pending = new Promise<string>(resolve => { handle = provider.run(request('permission'), e => { if (e.type === 'pending') resolve(e.request.id) }) })
  await handle!.respond!(await pending, 'Allow once'); await handle!.done
  let ready!: () => void; const partial = new Promise<void>(resolve => { ready = resolve })
  const stopped = provider.run(request('wait'), e => { if (e.type === 'delta') ready() })
  const done = assert.rejects(stopped.done, { name: 'AbortError' }); await partial; await stopped.interrupt(); await done
})
test('Claude questions preserve native question names while accepting renderer IDs', () => {
  assert.deepEqual(claudePermissionResponse({ tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which color?' }] } }, { answers: { '0': 'Blue' } }), { behavior: 'allow', updatedInput: { questions: [{ question: 'Which color?' }], answers: { 'Which color?': 'Blue' } } })
})

test('Claude records only submission for the actual append-system-prompt CLI argument', async t => {
  const { provider, request, dir } = await setup(t)
  const input = { ...request('hello'), systemContext: 'Claude selected Türkçe 🧪' }
  const events: ProviderEvent[] = []
  await provider.run(input, event => events.push(event)).done
  const received = JSON.parse(await readFile(join(dir, 'received-context.json'), 'utf8'))
  assert.equal(received.system, input.systemContext)
  assert.equal(received.message.message.content[0].text, input.prompt)
  const receipt = events.find(event => event.type === 'context')?.receipt
  assert.equal(receipt?.stage, 'submitted')
  assert.equal(receipt?.channel, 'native-prompt')
  assert.equal(receipt?.systemSha256, createHash('sha256').update(received.system).digest('hex'))
  assert.equal(events.some(event => event.type === 'context' && event.receipt.stage === 'accepted'), false)
})

test('Claude command input survives the terminal tool result', async t => {
  const { provider, request } = await setup(t), events: ProviderEvent[] = [];
  await provider.run(request('command-display'), event => events.push(event)).done;
  const activities = events.filter(event => event.type === 'activity').map(event => event.activity);
  assert.equal(activities.at(-1)?.title, 'echo exact-command');
  assert.equal(activities.at(-1)?.detail, 'Command:\necho exact-command\n\nOutput:\nfinal output');
});
