import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { HostActivity, settleStages } from '../../main/host/lifecycle'
import { CommandRegistry, runCommand } from '../../main/host/process'
import { PreviewManager } from '../../main/host/preview'
import { TerminalManager } from '../../main/host/terminal'
import { BrowserManager } from '../../main/host/browser'
import { ComputerManager } from '../../main/host/computer'
import { createHostTools } from '../../main/host'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const absent = () => Object.assign(new Error('gone'), { code: 'ESRCH' })

test('drain timeout retains activity and an independent rejected stage does not skip cleanup', async () => {
  const activity = new HostActivity()
  let finish!: () => void
  const operation = activity.run('one', () => new Promise<void>(resolve => { finish = resolve }))
  await tick(); activity.close()
  await assert.rejects(activity.run('one', async () => {}), /shutting down/)
  await assert.rejects(activity.drain('one', 10), /ownership is retained/)
  let cleaned = false
  await assert.rejects(settleStages([['failure', () => { throw new Error('fixture') }], ['independent', async () => { cleaned = true }]], 20), /failure/)
  assert.equal(cleaned, true)
  finish(); await operation; await activity.drain('one', 10)
})

test('failed command quiescence retains ownership and drain is task scoped and retryable', async () => {
  const registry = new CommandRegistry()
  let uncertain = true; let destroyed = 0
  const owner = (name: string) => ({ ownershipId: name, child: { stdin: { destroy() { destroyed++ } }, stdout: { destroy() { destroyed++ } }, stderr: { destroy() { destroyed++ } } }, async stop() { if (name === 'one' && uncertain) throw new Error('EPERM fixture; unconfirmed') } }) as any
  registry.retain(owner('one'), 'task-one'); registry.retain(owner('two'), 'task-two')
  await assert.rejects(registry.drain('task-one'), /cleanup remains incomplete/)
  assert.equal(registry.size, 2); assert.equal(destroyed, 0)
  uncertain = false
  await registry.drain('task-one'); assert.equal(registry.size, 1); assert.equal(destroyed, 3)
  await registry.drain(); assert.equal(registry.size, 0); assert.equal(destroyed, 6)
})

test('a successful command waits for a surviving descendant instead of treating leader exit as completion', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'akorith-command-drain-'))
  try {
    const script = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.send('ready');setTimeout(()=>require('node:fs').writeFileSync('late-marker','bad'),2600);setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore','ipc']});c.once('message',()=>process.exit(0));`
    const result = await runCommand(process.execPath, ['-e', script], { cwd, timeout: 6000 })
    assert.equal(result.code, 0)
    await new Promise(resolve => setTimeout(resolve, 1200))
    await assert.rejects(fs.access(path.join(cwd, 'late-marker')))
  } finally { await fs.rm(cwd, { recursive: true, force: true }) }
})

test('preview stop during startup prevents late server launch; disposal rejects future starts', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'akorith-preview-drain-'))
  const events: Record<string, unknown>[] = []
  const previews = new PreviewManager(event => events.push(event))
  try {
    await fs.writeFile(path.join(cwd, 'index.html'), 'fixture')
    const context = { cwd, taskId: 'fixture', mode: 'work' as const }
    const starting = previews.start(context)
    const rejected = assert.rejects(starting, /Preview stopped/)
    await previews.stop('fixture'); await rejected
    assert.equal(events.some(event => event.type === 'preview:ready'), false)
    await previews.dispose(); await previews.dispose()
    await assert.rejects(previews.start(context), /shutting down/)
  } finally { await previews.dispose(); await fs.rm(cwd, { recursive: true, force: true }) }
})

test('preview process cleanup failure retains its entry and a later stop can confirm it', async () => {
  const previews = new PreviewManager(() => {})
  let fail = true; let destroyed = 0
  const owner = { async stop() { if (fail) throw new Error('uncertain process') }, child: { stdin: { destroy() { destroyed++ } }, stdout: { destroy() { destroyed++ } }, stderr: { destroy() { destroyed++ } } } }
  ;(previews as any).previews.set('fixture', { taskId: 'fixture', url: 'http://127.0.0.1:1', owner, output: '', controller: new AbortController() })
  await assert.rejects(previews.stop('fixture'), /cleanup remains incomplete/)
  assert.equal((previews as any).previews.size, 1); assert.equal(destroyed, 0)
  await assert.rejects(previews.start({ taskId: 'fixture', cwd: '/tmp', mode: 'work' }), /has not stopped/)
  fail = false; await previews.stop('fixture')
  assert.equal((previews as any).previews.size, 0); assert.equal(destroyed, 3)
  await previews.dispose()
})

function ptyFixture() {
  const events = new EventEmitter()
  let alive = true; let uncertain = false; let time = 0
  let spawnCount = 0; let subscriptions = 0
  const pty = { pid: 424242, write() {}, resize() {}, onData(listener: (...args: any[]) => void) { events.on('data', listener); subscriptions++; return { dispose() { events.off('data', listener); subscriptions-- } } }, onExit(listener: (...args: any[]) => void) { events.on('exit', listener); subscriptions++; return { dispose() { events.off('exit', listener); subscriptions-- } } } }
  const runtime = { platform: 'darwin' as const, now: () => time, sleep: async (ms: number) => { time += ms; await tick() }, signal: (_pid: number, signal: unknown) => { if (uncertain) throw Object.assign(new Error('uncertain'), { code: 'EPERM' }); if (!alive) throw absent(); if (signal) { alive = false; events.emit('exit', { exitCode: 0 }) } } }
  const sessionRuntime = { ...runtime, signal: (group: number, signal: NodeJS.Signals) => runtime.signal(-group, signal), probe: async () => { if (uncertain) throw Object.assign(new Error('uncertain'), { code: 'EPERM' }); return { sessionId: pty.pid, members: alive ? [{ pid: pty.pid, pgid: pty.pid, birth: '100:1' }] : [] } } }
  return { events, runtime, sessionRuntime, pty, loadPty: async () => ({ spawn() { spawnCount++; return pty as any } }), setUncertain(value: boolean) { uncertain = value }, naturalExit() { alive = false; events.emit('exit', { exitCode: 7 }) }, counts: () => ({ spawnCount, subscriptions }) }
}

test('PTY lifecycle keeps uncertain sessions, retries stop, and closes naturally exited sessions without waiting for another exit', async () => {
  const fixture = ptyFixture()
  const terminal = new TerminalManager(() => {}, { ...fixture, stopPolicy: { timeoutMs: 100, graceMs: 20, pollMs: 5, unknownTimeoutMs: 20 } })
  const context = { cwd: '/tmp', taskId: 'one', mode: 'work' as const }
  const { id } = await terminal.create(context); await tick()
  fixture.events.emit('data', 'prior output')
  fixture.setUncertain(true)
  await assert.rejects(terminal.close('one', id), /unconfirmed/)
  assert.equal(terminal.list('one')[0].output, 'prior output'); assert.equal(fixture.counts().subscriptions, 3)
  assert.throws(() => terminal.write(context, id, 'late'), /stopping/)
  fixture.setUncertain(false); await terminal.close('one', id)
  assert.deepEqual(terminal.list('one'), []); assert.equal(fixture.counts().subscriptions, 0)
  await terminal.dispose(); await terminal.dispose()
  await assert.rejects(terminal.create(context), /shutting down/)
  const natural = ptyFixture(); const second = new TerminalManager(() => {}, natural)
  const opened = await second.create(context); await tick(); natural.naturalExit()
  assert.equal(second.list('one')[0].exitCode, 7)
  await second.close('one', opened.id); await second.dispose()
  assert.equal(natural.counts().subscriptions, 0)
})

test('pending PTY module load cannot create a terminal after disposal', async () => {
  let loaded!: (value: any) => void; let spawned = false
  const terminal = new TerminalManager(() => {}, { sessionRuntime: ptyFixture().sessionRuntime, loadPty: () => new Promise(resolve => { loaded = resolve }) })
  const creating = terminal.create({ cwd: '/tmp', taskId: 'one', mode: 'work' })
  const rejected = assert.rejects(creating, /shutting down/)
  await terminal.dispose(); loaded({ spawn() { spawned = true } }); await rejected
  assert.equal(spawned, false)
})

test('browser disposal awaits actual contents destruction and bypasses remote unload decisions', async () => {
  const manager = new BrowserManager(() => null, () => {})
  let closed = false; let calls = 0; let resolveClose!: () => void
  const wc = Object.assign(new EventEmitter(), { isDestroyed: () => closed, close(options: unknown) { calls++; assert.deepEqual(options, { waitForBeforeUnload: false }); resolveClose = () => { closed = true; wc.emit('destroyed') } } })
  ;(manager as any).tabs.set('one', { state: { id: 'one', taskId: 'task' }, view: { webContents: wc } })
  const first = manager.dispose(); const second = manager.dispose(); await tick()
  assert.equal(calls, 1); assert.equal(manager.list('task').length, 1)
  resolveClose(); await Promise.all([first, second]); assert.equal(manager.list('task').length, 0)
  await assert.rejects(manager.create({ cwd: '/tmp', taskId: 'task', mode: 'work' }), /shutting down/)
})

test('computer disposal waits pending helper resolution and never launches it after cancellation', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'akorith-computer-drain-'))
  const manager = new ComputerManager(cwd, () => {})
  let resolveBinary!: (value: string) => void
  ;(manager as any).binary = () => new Promise<string>(resolve => { resolveBinary = resolve })
  try {
    const state = manager.state(); let done = false
    const disposing = manager.dispose().then(() => { done = true })
    await tick(); assert.equal(done, false)
    resolveBinary('/must-not-spawn'); assert.match(String((await state).error), /cancelled/)
    await disposing; await manager.dispose()
    await assert.rejects(manager.capture(), /shutting down/)
    await assert.rejects(fs.access(path.join(cwd, 'computer-control.json')))
  } finally { await manager.dispose(); await fs.rm(cwd, { recursive: true, force: true }) }
})

test('host disposal drains an in-flight command and rejects new IPC and model tools immediately', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'akorith-host-drain-'))
  const context = { cwd, taskId: 'one', mode: 'full' as const }
  const host = createHostTools({ userData: cwd, getWindow: () => null, emit: () => {}, getContext: () => context })
  try {
    const command = host.execute('terminal_execute', { command: 'printf ready > ready; sleep 30' }, context)
    const rejected = assert.rejects(command, /cancelled/)
    for (let attempt = 0; attempt < 100; attempt++) { if (await fs.access(path.join(cwd, 'ready')).then(() => true, () => false)) break; await new Promise(resolve => setTimeout(resolve, 10)) }
    await fs.access(path.join(cwd, 'ready'))
    const disposing = host.dispose()
    await assert.rejects(host.invoke('files:write', { taskId: 'one', path: 'late', content: 'no' }), /shutting down/)
    await assert.rejects(host.execute('files_write', { path: 'late', content: 'no' }, context), /shutting down/)
    await disposing; await rejected; await host.dispose(); await host.drain?.('one')
    await assert.rejects(fs.access(path.join(cwd, 'late')))
  } finally { await host.dispose(); await fs.rm(cwd, { recursive: true, force: true }) }
})


test('missing session-helper preflight rejects before loading node-pty or creating an unmanaged shell', async () => {
  let loaded = false
  const terminal = new TerminalManager(() => {}, { preflight: async () => { throw new Error('helper missing fixture') }, loadPty: async () => { loaded = true; throw new Error('must not load') } })
  await assert.rejects(terminal.create({ cwd: '/tmp', taskId: 'test', mode: 'work' }), /helper missing fixture/)
  assert.equal(loaded, false)
  assert.deepEqual(terminal.list('test'), [])
  await terminal.dispose()
})
