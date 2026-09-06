import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { PtySessionOwner, probePtySession, type SessionSnapshot } from '../../main/host/pty-session'
import { TerminalManager } from '../../main/host/terminal'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
test('session drain tracks separate job groups after leader exit and confirms the group owner only when the session is empty', async () => {
  let time = 0; let leader = true; let jobs = true; let confirmed = 0
  const signals: Array<[number, string]> = []
  const owner = { child: { pid: 12345 }, async stop() { assert.equal(jobs, false); confirmed++ } } as any
  const runtime = {
    now: () => time, sleep: async (ms: number) => { time += ms; await tick() },
    probe: async () => ({ sessionId: 12345, members: [...(leader ? [{ pid: 12345, pgid: 12345, birth: '100:1' }] : []), ...(jobs ? [{ pid: 12346, pgid: 12346, birth: '100:2' }] : [])] }),
    signal(group: number, signal: NodeJS.Signals) { signals.push([group, signal]); if (group === 12345) leader = false; if (group === 12346 && signal === 'SIGKILL') jobs = false }
  }
  const tracker = new PtySessionOwner(owner, runtime, { timeoutMs: 100, graceMs: 20, pollMs: 5, unknownTimeoutMs: 20 })
  await tracker.initialize(); leader = false // natural shell exit does not imply its jobs exited.
  await tracker.stop(); await tracker.stop()
  assert.deepEqual(signals, [[12346, 'SIGTERM'], [12346, 'SIGKILL']]); assert.equal(confirmed, 1)
})

test('session identity reuse is rejected without signaling the replacement, and persistent probe failures retain retryable ownership', async () => {
  let snapshot: SessionSnapshot = { sessionId: 12345, members: [{ pid: 12345, pgid: 12345, birth: '100:1' }] }
  let time = 0; let failed = false; let signals = 0
  const owner = { child: { pid: 12345 }, async stop() {} } as any
  const runtime = { now: () => time, sleep: async (ms: number) => { time += ms }, probe: async () => { if (failed) throw new Error('permission uncertainty'); return snapshot }, signal() { signals++ } }
  const tracker = new PtySessionOwner(owner, runtime, { timeoutMs: 100, graceMs: 20, pollMs: 5, unknownTimeoutMs: 20 })
  await tracker.initialize(); snapshot = { sessionId: 12345, members: [{ pid: 12345, pgid: 12345, birth: '200:1' }] }
  await assert.rejects(tracker.stop(), /PID reuse/); assert.equal(signals, 0)
  failed = true; await assert.rejects(tracker.stop(), /unconfirmed/); assert.equal(signals, 0)
  failed = false; snapshot = { sessionId: 12345, members: [] }; await tracker.stop()
})

test('actual macOS PTY foreground and background job groups are gone before close resolves', { skip: process.platform !== 'darwin' }, async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'akorith-pty-session-live-'))
  const terminal = new TerminalManager(() => {})
  const context = { cwd, taskId: 'owned-live', mode: 'work' as const }
  try {
    // Both jobs ignore graceful termination. Their writes remain inside this disposable fixture.
    await fs.writeFile(path.join(cwd, 'job.cjs'), `const fs=require('node:fs'); process.on('SIGTERM',()=>{}); process.on('SIGHUP',()=>{}); fs.writeFileSync(process.argv[2]+'.ready',String(process.pid)); setTimeout(()=>fs.writeFileSync(process.argv[2]+'.late','bad'),5000); setInterval(()=>{},1000);`)
    const { id } = await terminal.create(context)
    const shellPid = (terminal as any).sessions.get(id).pty.pid as number
    const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'"
    terminal.write(context, id, `${quote(process.execPath)} job.cjs background &\n${quote(process.execPath)} job.cjs foreground\n`)
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await fs.access(path.join(cwd, 'foreground.ready')).then(() => true, () => false)) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await fs.access(path.join(cwd, 'foreground.ready')); await fs.access(path.join(cwd, 'background.ready'))
    const before = await probePtySession(shellPid)
    assert.ok(new Set(before.members.map(member => member.pgid)).size >= 3, 'fixture must really exercise shell, background and foreground groups')
    await terminal.close(context.taskId, id)
    assert.deepEqual((await probePtySession(shellPid)).members, [])
    for (const name of ['foreground', 'background']) {
      const pid = Number(await fs.readFile(path.join(cwd, `${name}.ready`), 'utf8'))
      assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH')
      await assert.rejects(fs.access(path.join(cwd, `${name}.late`)))
    }
  } finally { await terminal.dispose(); await fs.rm(cwd, { recursive: true, force: true }) }
})

test('actual macOS PTY jobs remain discoverable and are drained after their shell has already exited', { skip: process.platform !== 'darwin' }, async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'akorith-pty-leader-exit-'))
  const terminal = new TerminalManager(() => {})
  const context = { cwd, taskId: 'leader-exit', mode: 'work' as const }
  try {
    await fs.writeFile(path.join(cwd, 'job.cjs'), `const fs=require('node:fs');process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});fs.writeFileSync('child.ready',String(process.pid));setTimeout(()=>fs.writeFileSync('late-marker','bad'),5000);setInterval(()=>{},1000);`)
    const { id } = await terminal.create(context)
    const shellPid = (terminal as any).sessions.get(id).pty.pid as number
    const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'"
    // zsh &! disowns the job, but does not move it to a new session. The ownership scope still includes it.
    terminal.write(context, id, `${quote(process.execPath)} job.cjs > child.log 2>&1 &!\n`)
    for (let attempt = 0; attempt < 150; attempt++) { if (await fs.access(path.join(cwd, 'child.ready')).then(() => true, () => false)) break; await new Promise(resolve => setTimeout(resolve, 20)) }
    const childPid = Number(await fs.readFile(path.join(cwd, 'child.ready'), 'utf8'))
    terminal.write(context, id, 'exit\n')
    for (let attempt = 0; attempt < 100 && !terminal.list(context.taskId)[0].exited; attempt++) await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(terminal.list(context.taskId)[0].exited, true)
    const orphaned = await probePtySession(shellPid)
    assert.equal(orphaned.members.some(member => member.pid === shellPid), false)
    assert.equal(orphaned.members.some(member => member.pid === childPid), true)
    await terminal.close(context.taskId, id)
    assert.deepEqual((await probePtySession(shellPid)).members, [])
    assert.throws(() => process.kill(childPid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH')
    await assert.rejects(fs.access(path.join(cwd, 'late-marker')))
  } finally { await terminal.dispose(); await fs.rm(cwd, { recursive: true, force: true }) }
})

test('an empty census while forkpty is still starting is not mistaken for a dead or replacement session', async () => {
  let time = 0; let probes = 0
  const owner = { child: { pid: 12345 }, snapshot() { return { leaderState: 'spawned' } }, async stop() {} } as any
  const tracker = new PtySessionOwner(owner, { now: () => time, sleep: async ms => { time += ms }, signal() {}, probe: async () => ({ sessionId: 12345, members: ++probes === 1 ? [] : [{ pid: 12345, pgid: 12345, birth: '100:1' }] }) }, { timeoutMs: 100, pollMs: 5 })
  await tracker.initialize()
  assert.equal(probes, 2)
})
