import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexProvider, codexResponse } from '../main/providers/codex'
import { nativePrompt, providerEnv } from '../main/providers/common'
import type { HostTools, ProviderEvent, RunRequest } from '../shared/contracts'

const fixture = `#!/usr/bin/env node
const readline=require('node:readline');
if(process.argv.includes('--version')){console.log('codex-cli test');process.exit(0)}
let prompt='',thread='thread-test',turn='turn-1',counter=0;
const out=m=>process.stdout.write(JSON.stringify(m)+'\\n');
const event=(method,params)=>out({method,params:{threadId:thread,turnId:turn,...params}});
const final=text=>{event('item/completed',{item:{id:'answer',type:'agentMessage',phase:'final_answer',text}});event('turn/completed',{turn:{id:turn,status:'completed'}})};
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);const p=m.params||{};
if(m.id==='tool-server'){if(!m.result.success)return final('tool failed');return final(m.result.contentItems[0].text)}
if(m.id==='approval-server'){return final(m.result.decision)}
if(m.method==='initialize')return out({id:m.id,result:{}});
if(m.method==='model/list')return out({id:m.id,result:{data:[{model:'test-model',displayName:'Test model',supportedReasoningEfforts:[{reasoningEffort:'high'}]}]}});
if(m.method==='account/read')return out({id:m.id,result:{account:{type:'chatgpt'}}});
if(m.method==='thread/start'){if(p.ephemeral!==false)return out({id:m.id,error:{message:'must persist'}});if(p.config['skills.include_instructions']!==false)return out({id:m.id,error:{message:'must use host-selected skills'}});return out({id:m.id,result:{thread:{id:thread}}})}
if(m.method==='thread/resume'){thread=p.threadId;return out({id:m.id,result:{thread:{id:thread}}})}
if(m.method==='turn/start'){prompt=p.input[0].text;turn='turn-'+(++counter);out({id:m.id,result:{turn:{id:turn}}});event('turn/started',{turn:{id:turn}});
out({method:'item/agentMessage/delta',params:{threadId:'other-thread',turnId:turn,itemId:'wrong',delta:'LEAK'}});
if(prompt==='crash')return process.exit(9);
if(prompt==='tool')return out({id:'tool-server',method:'item/tool/call',params:{threadId:thread,turnId:turn,tool:'files_read',arguments:{path:'test.txt'}}});
if(prompt==='approval')return out({id:'approval-server',method:'item/commandExecution/requestApproval',params:{threadId:thread,turnId:turn,command:'echo test'}});
if(['wait','delayed-stop','ack-only'].includes(prompt)){event('item/agentMessage/delta',{itemId:'answer',delta:'partial'});return}
event('item/started',{item:{id:'update',type:'agentMessage',phase:'commentary',text:''}});event('item/agentMessage/delta',{itemId:'update',delta:'working'});event('item/completed',{item:{id:'update',type:'agentMessage',phase:'commentary',text:'working'}});
event('item/agentMessage/delta',{itemId:'answer',delta:'hello'});return final('hello')}
if(m.method==='turn/steer'){out({id:m.id,result:{turnId:turn}});return final(p.input[0].text)}
if(m.method==='turn/interrupt'){out({id:m.id,result:{}});if(prompt==='ack-only')return;if(prompt==='delayed-stop')return setTimeout(()=>event('turn/completed',{turn:{id:turn,status:'interrupted'}}),100);return event('turn/completed',{turn:{id:turn,status:'interrupted'}})}
});
`
async function setup(t: any, execute?: HostTools['execute']) {
  const dir = await mkdtemp(join(tmpdir(), 'akorith-codex-test-')), executable = join(dir, 'codex')
  await writeFile(executable, fixture); await chmod(executable, 0o755)
  const calls: any[] = []
  const tools: HostTools = { definitions: [{ name: 'files_read', description: 'Read', inputSchema: { type: 'object' } }], execute: execute ?? (async (name, args, context) => { calls.push({ name, args, context }); return 'observed proof' }), dispose: async () => {} }
  const provider = new CodexProvider(tools, executable)
  t.after(async () => { await provider.dispose(); await rm(dir, { recursive: true, force: true }) })
  const request = (prompt: string, nativeSessions = {}): RunRequest => ({ task: { id: 'task-a', projectId: null, title: 'Test', providerId: 'codex', model: 'test-model', effort: 'high', mode: 'work', status: 'running', pinned: false, archived: false, draft: '', createdAt: 1, updatedAt: 1, nativeSessions }, cwd: dir, turnId: 'app-turn', prompt, history: [], attachments: [], mcpServers: [], ollamaUrl: 'http://localhost:11434' })
  return { provider, request, calls, dir }
}
test('Codex discovers real protocol data and separates commentary from final tokens', async t => {
  const { provider, request } = await setup(t), events: ProviderEvent[] = []
  const info = await provider.discover(); assert.equal(info.authenticated, true); assert.equal(info.models[0].id, 'test-model')
  await provider.run(request('hello'), event => events.push(event)).done
  assert.deepEqual(events.filter(e => e.type === 'delta').map(e => e.text), ['hello'])
  assert.equal(events.find(e => e.type === 'activity')?.activity.kind, 'commentary')
  assert.deepEqual(events.at(-1), { type: 'outcome', outcome: { status: 'completed' } })
  await provider.run(request('hello', { codex: 'thread-test' }), () => {}).done
})
test('Codex dynamic host tool executes once in the correct task scope', async t => {
  const { provider, request, calls, dir } = await setup(t), events: ProviderEvent[] = []
  await provider.run(request('tool'), e => events.push(e)).done
  assert.deepEqual(calls, [{ name: 'files_read', args: { path: 'test.txt' }, context: { taskId: 'task-a', cwd: dir, mode: 'work' } }])
  assert.equal(events.find(e => e.type === 'final')?.text, 'observed proof')
})
test('Codex native approvals accept the renderer choice and reject stale answers', async t => {
  const { provider, request } = await setup(t)
  let handle: ReturnType<CodexProvider['run']>
  const pending = new Promise<string>(resolve => { handle = provider.run(request('approval'), e => { if (e.type === 'pending') resolve(e.request.id) }) })
  const id = await pending; await handle!.respond!(id, 'Allow once'); await handle!.done
  await assert.rejects(handle!.respond!(id, 'Allow once'), /no longer pending/)
})
test('Codex interrupt preserves partial output and steer targets the active native turn', async t => {
  const { provider, request } = await setup(t), events: ProviderEvent[] = []
  let notify!: () => void; const partial = new Promise<void>(resolve => { notify = resolve })
  const handle = provider.run(request('wait'), e => { events.push(e); if (e.type === 'delta') notify() })
  const stopped = assert.rejects(handle.done, { name: 'AbortError' })
  await partial; await handle.interrupt(); await stopped
  assert.equal((events.find(e => e.type === 'delta') as any).text, 'partial')
  const second = provider.run(request('wait'), () => {})
  await second.steer!('follow-up'); await second.done
})
test('Codex child crash rejects the turn and reconnects on the next run', async t => {
  const { provider, request } = await setup(t)
  await assert.rejects(provider.run(request('crash'), () => {}).done, /exited/)
  await provider.run(request('hello'), () => {}).done
})
test('Codex stop waits for native completion after an early interrupt acknowledgement', async t => {
  const { provider, request } = await setup(t)
  let ready!: () => void, settled = false
  const started = new Promise<void>(resolve => { ready = resolve })
  const handle = provider.run(request('delayed-stop'), e => { if (e.type === 'delta') ready() })
  void handle.done.catch(() => {}).then(() => { settled = true })
  await started
  const stopped = handle.interrupt()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(settled, false)
  await stopped
  assert.equal(settled, true, 'stop must not release the workspace while the native turn is active')
})
test('Codex stop drains in-flight host calls even when native completion arrives first', async t => {
  let started!: () => void, release!: () => void, wrote = false
  const running = new Promise<void>(resolve => { started = resolve }), waiting = new Promise<void>(resolve => { release = resolve })
  const { provider, request } = await setup(t, async () => { started(); await waiting; wrote = true; return 'written' })
  const handle = provider.run(request('tool'), () => {})
  void handle.done.catch(() => {})
  await running
  let stopped = false
  const stopping = handle.interrupt().then(() => { stopped = true })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(stopped, false)
  release(); await stopping
  assert.equal(wrote, true)
})
test('Codex stop terminates an unresponsive native connection and the next run reconnects', async t => {
  const { provider, request } = await setup(t)
  let ready!: () => void
  const started = new Promise<void>(resolve => { ready = resolve })
  const handle = provider.run(request('ack-only'), e => { if (e.type === 'delta') ready() })
  const rejected = assert.rejects(handle.done)
  await started; await handle.interrupt(); await rejected
  await provider.run(request('hello'), () => {}).done
})
test('Codex maps structured questions and isolates parent-session environment', () => {
  assert.deepEqual(codexResponse({ method: 'item/tool/requestUserInput', params: { questions: [{ id: 'color' }] } }, { answers: { color: 'Blue' } }), { answers: { color: { answers: ['Blue'] } } })
  const env = providerEnv({ CODEX_THREAD_ID: 'parent', CODEX_PERMISSION_PROFILE: 'disabled', CLAUDECODE: 'parent' })
  assert.equal(env.CODEX_THREAD_ID, undefined); assert.equal(env.CODEX_PERMISSION_PROFILE, undefined); assert.equal(env.CLAUDECODE, undefined)
})
test('Native handoff includes intervening provider context before the current user request', () => {
  const text = nativePrompt({ prompt: 'Continue with the new design', attachments: [], handoffContext: 'Other provider: changed the accent to green.' } as unknown as RunRequest)
  assert.match(text, /changed the accent to green/)
  assert(text.indexOf('changed the accent to green') < text.indexOf('Current user request:'))
  assert(text.endsWith('Continue with the new design'))
})
