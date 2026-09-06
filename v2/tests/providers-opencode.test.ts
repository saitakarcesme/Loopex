import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenCodeProvider } from '../main/providers/opencode'
import { ProviderQuiescenceError } from '../main/providers/common'
import type { HostTools, ProviderEvent, RunRequest } from '../shared/contracts'

// Loopback protocol fixture only. No installed provider, account, or model is used.
const fixture = `#!/usr/bin/env node
if(process.argv.includes('--version')){console.log('opencode synthetic');process.exit(0)}
const http=require('node:http');let events,text='',created=Date.now();const session='synthetic-'+process.pid;
const send=(type,properties)=>events.write('data: '+JSON.stringify({type,properties:{sessionID:session,...properties}})+'\\n\\n');
const server=http.createServer(async(req,res)=>{const path=new URL(req.url,'http://localhost').pathname;let data='';for await(const chunk of req)data+=chunk;const body=data?JSON.parse(data):{};
const json=value=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value))};
if(path==='/event'){events=res;res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();return}
if(path==='/provider')return json({connected:['synthetic'],all:[{id:'synthetic',name:'Synthetic',models:{model:{id:'model',name:'Synthetic model'}}}]});
if(path.endsWith('/message'))return json([{info:{role:'assistant',time:{created},tokens:{input:5,output:3},cost:0},parts:[{type:'text',text}]}]);
if(path.endsWith('/prompt_async')){require('node:fs').writeFileSync(require('node:path').join(__dirname,'received-prompt.json'),JSON.stringify(body));if(body.system==='reject-context'){res.writeHead(503).end('synthetic rejection');return}if(body.parts[0].text==='approval-fixture'){json({});setImmediate(()=>{
send('session.status',{status:{type:'busy'}});
send('message.part.updated',{part:{id:'foreign',type:'tool',sessionID:'other-session',messageID:'other-message',callID:'same-call',tool:'files_read',state:{input:{path:'FOREIGN-SECRET.txt'}}}});
send('message.part.updated',{part:{id:'current',type:'tool',sessionID:session,messageID:'current-message',callID:'same-call',tool:'files_read',state:{input:{path:'actual-target.txt'}}}});
send('permission.asked',{id:'matched',permission:'files_read',patterns:['*'],tool:{messageID:'current-message',callID:'same-call'}});
send('permission.asked',{id:'unmatched',permission:'files_read',patterns:['*'],tool:{messageID:'other-message',callID:'same-call'}});
send('permission.asked',{id:'metadata',permission:'bash',patterns:['npm *'],metadata:{command:'npm test'}});
});return}
text=body.parts[0].text==='wait'?'partial':'synthetic final';created=Date.now();json({});setImmediate(()=>{send('session.status',{status:{type:'busy'}});if(body.parts[0].text==='command-display'){send('message.part.updated',{part:{id:'command',sessionID:session,type:'tool',tool:'bash',state:{status:'running',input:{command:'echo exact-command'}}}});send('message.part.updated',{part:{id:'command',sessionID:session,type:'tool',tool:'bash',state:{status:'completed',title:'Long misleading provider title',output:'final output'}}})}send('message.updated',{info:{id:'assistant',role:'assistant',sessionID:session}});send('message.part.updated',{part:{id:'part',messageID:'assistant',sessionID:session,type:'text',text}});if(body.parts[0].text!=='wait')send('session.status',{status:{type:'idle'}})});return}
if(path.endsWith('/abort'))return json({});
if(path==='/session'||path==='/session/'+session)return json({id:session});
res.writeHead(404).end();
});server.listen(0,'127.0.0.1',()=>console.log('opencode server listening on http://127.0.0.1:'+server.address().port));
`
async function setup(t: any, drain?: HostTools['drain']) {
  const dir = await mkdtemp(join(tmpdir(), 'akorith-opencode-protocol-')), executable = join(dir, 'opencode')
  await writeFile(executable, fixture); await chmod(executable, 0o755)
  const host: HostTools = { definitions: [], execute: async () => { throw new Error('No synthetic tools') }, dispose: async () => {}, drain }
  const provider = new OpenCodeProvider(host, executable)
  t.after(async () => { await provider.dispose(); await rm(dir, { recursive: true, force: true }) })
  const request = (taskId: string, prompt: string): RunRequest => ({ task: { id: taskId, projectId: null, title: 'Synthetic', providerId: 'opencode', model: 'synthetic/model', effort: 'high', mode: 'work', status: 'running', pinned: false, archived: false, draft: '', nativeSessions: {}, createdAt: 1, updatedAt: 1 }, cwd: dir, turnId: taskId + '-turn', prompt, history: [], attachments: [], mcpServers: [], ollamaUrl: '' })
  return { provider, request, dir }
}
test('OpenCode discovery retries transient signal-0 EPERM after terminating its owned fixture server', async t => {
  const { provider } = await setup(t)
  const original = process.kill
  const terminated = new Set<number>()
  let injected = 0
  process.kill = ((pid: number, signal: NodeJS.Signals | number = 'SIGTERM') => {
    if (pid < -1 && signal === 'SIGTERM') terminated.add(pid)
    if (pid < -1 && signal === 0 && terminated.delete(pid)) { injected++; throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' }) }
    return original(pid, signal)
  }) as typeof process.kill
  try {
    const info = await provider.discover()
    assert.equal(info.available, true); assert.equal(info.models[0].id, 'synthetic/model'); assert.ok(injected > 0)
  } finally { process.kill = original }
})
test('OpenCode preserves final result through task cleanup uncertainty and scoped retry leaves another run active', async t => {
  let failDrain = true
  const { provider, request } = await setup(t, async taskId => { if (taskId === 'first' && failDrain) throw Object.assign(new Error('owned host writer unconfirmed'), { code: 'EPERM' }) })
  const events: ProviderEvent[] = []
  const first = provider.run(request('first', 'hello'), event => events.push(event))
  await assert.rejects(first.done, error => { assert.ok(error instanceof ProviderQuiescenceError); assert.deepEqual(error.nativeOutcome, { status: 'completed' }); return true })
  assert.equal(events.find(e => e.type === 'final')?.text, 'synthetic final')
  assert.deepEqual(events.find(e => e.type === 'outcome'), { type: 'outcome', outcome: { status: 'completed' } })
  assert.deepEqual(events.find(e => e.type === 'usage')?.usage, { inputTokens: 5, outputTokens: 3, costUsd: 0 })
  let ready!: () => void, secondSettled = false
  const partial = new Promise<void>(resolve => { ready = resolve })
  const second = provider.run(request('second', 'wait'), event => { if (event.type === 'delta') ready() })
  const secondRejected = assert.rejects(second.done, { name: 'AbortError' }).then(() => { secondSettled = true })
  await partial; failDrain = false; await first.dispose!()
  assert.equal(secondSettled, false, 'scoped cleanup retry must not cancel an unrelated native run')
  await second.interrupt(); await secondRejected
})
test('OpenCode reports native success before delayed successful cleanup even when Stop arrives', async t => {
  let release!: () => void, draining!: () => void, settled = false
  const wait = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { draining = resolve })
  const events: ProviderEvent[] = []
  const { provider, request } = await setup(t, async () => { draining(); await wait })
  const handle = provider.run(request('delayed', 'hello'), event => events.push(event))
  void handle.done.then(() => { settled = true }, () => {})
  await started
  assert.equal(settled, false)
  assert.deepEqual(events.find(event => event.type === 'outcome'), { type: 'outcome', outcome: { status: 'completed' } })
  const stopped = handle.interrupt()
  release(); await stopped; await handle.done
  assert.equal(settled, true)
  assert.deepEqual(events.filter(event => event.type === 'outcome'), [{ type: 'outcome', outcome: { status: 'completed' } }])
})

test('OpenCode receipt hashes accepted prompt system text and excludes rejected submissions', async t => {
  const { provider, request, dir } = await setup(t)
  const input = { ...request('context', 'hello'), systemContext: 'OpenCode selected Türkçe 🧪' }
  const events: ProviderEvent[] = []
  await provider.run(input, event => events.push(event)).done
  const received = JSON.parse(await readFile(join(dir, 'received-prompt.json'), 'utf8'))
  assert.equal(received.system, input.systemContext)
  const receipt = events.find(event => event.type === 'context')?.receipt
  assert.equal(receipt?.stage, 'accepted'); assert.equal(receipt?.channel, 'native-prompt')
  assert.equal(receipt?.systemSha256, createHash('sha256').update(received.system).digest('hex'))
  const rejected: ProviderEvent[] = []
  await assert.rejects(provider.run({ ...request('rejected-context', 'hello'), systemContext: 'reject-context' }, event => rejected.push(event)).done, /503/)
  assert.equal(rejected.some(event => event.type === 'context'), false)
})

test('OpenCode approval details preserve broad native scope and match only the referenced session and tool call', async t => {
  const { provider, request } = await setup(t)
  const approvals: Extract<ProviderEvent, { type: 'pending' }>[] = []
  let ready!: () => void
  const received = new Promise<void>(resolve => { ready = resolve })
  const handle = provider.run(request('approval-task', 'approval-fixture'), event => {
    if (event.type === 'pending') { approvals.push(event); if (approvals.length === 3) ready() }
  })
  const stopped = assert.rejects(handle.done, { name: 'AbortError' })
  await received
  const matched = approvals.find(event => event.request.id === 'matched')!.request.detail!
  assert.match(matched, /Permission scope supplied by OpenCode:\n\*/)
  assert.match(matched, /do not narrow/)
  assert.match(matched, /actual-target.txt/)
  assert.doesNotMatch(matched, /FOREIGN-SECRET/)
  const unmatched = approvals.find(event => event.request.id === 'unmatched')!.request.detail!
  assert.match(unmatched, /No additional tool details/)
  assert.doesNotMatch(unmatched, /actual-target|FOREIGN-SECRET/)
  const metadata = approvals.find(event => event.request.id === 'metadata')!.request.detail!
  assert.match(metadata, /npm \*/); assert.match(metadata, /npm test/)
  await handle.interrupt(); await stopped
})

test('OpenCode retains command input when a completed part contains only output and a new title', async t => {
  const { provider, request } = await setup(t), events: ProviderEvent[] = [];
  await provider.run(request('display', 'command-display'), event => events.push(event)).done;
  const activities = events.filter(event => event.type === 'activity').map(event => event.activity);
  assert.equal(activities.at(-1)?.title, 'echo exact-command');
  assert.equal(activities.at(-1)?.detail, 'Command:\necho exact-command\n\nOutput:\nfinal output');
});
