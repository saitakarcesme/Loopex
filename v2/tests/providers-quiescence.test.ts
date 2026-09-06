import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createOwnedProcessSpawner, type ProcessRuntime } from '../main/providers/process-owner'
import { ProviderQuiescenceError, finishWithCleanup, retryableCleanup, deferred } from '../main/providers/common'
import { HostMcpBridge } from '../main/providers/mcp-bridge'
import type { ProviderEvent } from '../shared/contracts'

const syscall = (code: string) => Object.assign(new Error(`kill ${code}`), { code })
function fixture(signal: (value: NodeJS.Signals | 0, s: State) => void) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams
  Object.defineProperty(child, 'pid', { value: 41001 })
  const s: State = { now: 0, child, alive: true, calls: [], exit: () => { child.emit('exit', 0, null); child.emit('close', 0, null) } }
  const rt: ProcessRuntime = {
    platform: 'darwin', now: () => s.now, sleep: async ms => { s.now += ms; s.tick?.() }, ownershipId: () => 'synthetic-owner',
    spawn: (_file, _args, options) => { assert.equal(options.detached, true); queueMicrotask(() => child.emit('spawn')); return child },
    signal: (pid, value) => { assert.equal(pid, -41001); s.calls.push({ at: s.now, signal: value }); signal(value, s) },
  }
  return { s, owner: createOwnedProcessSpawner(rt)('synthetic', [], {}, { timeoutMs: 200, graceMs: 48, pollMs: 12, unknownTimeoutMs: 48 }) }
}
interface State { now: number; child: ChildProcessWithoutNullStreams; alive: boolean; calls: Array<{ at: number; signal: NodeJS.Signals | 0 }>; exit(): void; tick?: () => void }

test('owned stop is concurrent-idempotent and never signals again after confirmed disappearance', async () => {
  const { s, owner } = fixture((value, state) => { if (!state.alive) throw syscall('ESRCH'); if (value === 'SIGTERM') { state.alive = false; state.exit() } })
  const first = owner.stop(); assert.equal(owner.stop(), first)
  const receipt = await first
  assert.equal(receipt.quiescent, true); assert.equal(receipt.leaderState, 'exited')
  const count = s.calls.length
  assert.equal(owner.stop(), first); await owner.stop(); assert.equal(s.calls.length, count)
  assert.deepEqual(s.calls.filter(c => c.signal !== 0).map(c => c.signal), ['SIGTERM'])
})
test('recorded macOS post-KILL EPERM transition waits for ESRCH 12ms later with leader already exited', async () => {
  let killed = false, probe = 0
  const { s, owner } = fixture(value => { if (value === 'SIGKILL') killed = true; if (value === 0 && killed) throw syscall(probe++ === 0 ? 'EPERM' : 'ESRCH') })
  await Promise.resolve(); s.exit()
  const receipt = await owner.stop(), events = owner.snapshot().observations
  const unknown = events.find(e => e.phase === 'group-probe' && e.code === 'EPERM')!
  const absent = events.find(e => e.phase === 'group-probe' && e.state === 'absent')!
  assert.equal(Number(absent.atMs) - Number(unknown.atMs), 12)
  assert.equal(receipt.quiescent, true)
  assert.deepEqual(s.calls.filter(c => c.signal !== 0).map(c => c.signal), ['SIGTERM', 'SIGKILL'])
})
test('persistent EPERM cannot certify absence, and failed ownership remains retryable', async () => {
  let uncertain = true
  const { s, owner } = fixture((value, state) => { if (uncertain) throw syscall('EPERM'); if (!state.alive) throw syscall('ESRCH'); if (value === 'SIGTERM') { state.alive = false; state.exit() } })
  await assert.rejects(owner.stop(), error => { assert.ok(error instanceof ProviderQuiescenceError); assert.equal((error.cause as NodeJS.ErrnoException).code, 'EPERM'); return true })
  assert.ok(s.calls.every(c => c.signal === 0))
  uncertain = false
  assert.equal((await owner.stop()).quiescent, true); assert.equal(owner.snapshot().attempts, 2)
})
test('leader exit and group disappearance are both required before stop completes', async () => {
  const { owner } = fixture((value, state) => {
    if (!state.alive) throw syscall('ESRCH')
    if (value === 'SIGTERM') { state.alive = false; const exitAt = state.now + 36; state.tick = () => { if (state.now >= exitAt) state.exit() } }
  })
  await owner.stop()
  const events = owner.snapshot().observations
  assert.ok(Number(events.find(e => e.phase === 'leader-exit')!.atMs) > Number(events.find(e => e.phase === 'group-probe' && e.state === 'absent')!.atMs))
})
test('group absence without an observed leader exit stays unconfirmed at the deadline', async () => {
  const { owner } = fixture((value, state) => { if (!state.alive) throw syscall('ESRCH'); if (value === 'SIGTERM') state.alive = false })
  await assert.rejects(owner.stop(), ProviderQuiescenceError)
  assert.equal(owner.snapshot().leaderState, 'spawned')
})
test('successful native outcome survives a cleanup failure as a separate typed outcome', async () => {
  const native = deferred<void>(), stopped = deferred<void>()
  let complete = false
  const done = finishWithCleanup(native.promise, () => stopped.promise).then(() => { complete = true })
  const rejected = assert.rejects(done, error => { assert.ok(error instanceof ProviderQuiescenceError); assert.deepEqual(error.nativeOutcome, { status: 'completed' }); return true })
  native.resolve(); await Promise.resolve(); assert.equal(complete, false)
  stopped.reject(syscall('EPERM')); await rejected
})
test('native failure and interruption survive cleanup uncertainty without being overwritten', async () => {
  for (const name of ['Error', 'AbortError']) {
    const nativeError = Object.assign(new Error('native original'), { name })
    await assert.rejects(finishWithCleanup(Promise.reject(nativeError), async () => { throw syscall('EPERM') }), error => {
      assert.ok(error instanceof ProviderQuiescenceError)
      assert.equal(error.nativeOutcome?.status, name === 'AbortError' ? 'interrupted' : 'failed')
      assert.equal((error.nativeOutcome as { error: unknown }).error, nativeError); return true
    })
  }
})
test('cleanup retries share in-flight work and only cache successful cleanup', async () => {
  let calls = 0
  const action = retryableCleanup(async () => { if (++calls === 1) throw syscall('EPERM') })
  const first = action(); assert.equal(action(), first); await assert.rejects(first)
  const second = action(); assert.equal(action(), second); await second
  assert.equal(action(), second); assert.equal(calls, 2)
})
test('host bridge retries task-owned cleanup after an errored tool has already settled', async () => {
  let drains = 0
  const bridge = new HostMcpBridge({ definitions: [{ name: 'write', description: 'synthetic', inputSchema: {} }], execute: async () => { throw new Error('tool exited but retained an owned writer') }, dispose: async () => {}, drain: async taskId => { assert.equal(taskId, 'task-proof'); if (++drains === 1) throw syscall('EPERM') } }, { taskId: 'task-proof', cwd: '/tmp', mode: 'work' }, new AbortController().signal)
  const result = await bridge.handle({ id: 1, method: 'tools/call', params: { name: 'write' } })
  assert.equal(result.result.isError, true)
  await assert.rejects(bridge.dispose(), /EPERM/)
  await bridge.dispose(); assert.equal(drains, 2)
  assert.equal((await bridge.handle({ id: 2, method: 'tools/call', params: { name: 'write' } })).result.isError, true)
})
test('native outcome is emitted once before cleanup and does not infer success from final text', async () => {
  for (const status of ['completed', 'failed', 'interrupted'] as const) {
    const native = deferred<void>(), cleanup = deferred<void>(), entered = deferred<void>()
    const events: ProviderEvent[] = []
    let settled = false
    const done = finishWithCleanup(native.promise, async () => {
      assert.equal(events.length, 1)
      assert.equal(events[0].type, 'outcome')
      if (events[0].type === 'outcome') assert.equal(events[0].outcome.status, status)
      entered.resolve(); await cleanup.promise
    }, event => events.push(event))
    const error = Object.assign(new Error('original native outcome'), { name: status === 'interrupted' ? 'AbortError' : 'Error' })
    const observed = done.then(() => { settled = true; assert.equal(status, 'completed') }, cause => { settled = true; assert.equal(cause, error) })
    if (status === 'completed') native.resolve(); else native.reject(error)
    await entered.promise; assert.equal(settled, false)
    cleanup.resolve(); await observed
    assert.equal(events.length, 1)
    assert.ok(events.every(event => event.type !== 'final'), 'outcome must not require a final-text event')
  }
})
test('outcome delivery failure cannot skip or shorten resource cleanup', async () => {
  const cleanup = deferred<void>(), entered = deferred<void>(), delivery = new Error('storage unavailable')
  let settled = false
  const done = finishWithCleanup(Promise.resolve(), async () => { entered.resolve(); await cleanup.promise }, () => { throw delivery })
  const rejected = assert.rejects(done, error => { assert.equal(error, delivery); settled = true; return true })
  await entered.promise; assert.equal(settled, false)
  cleanup.resolve(); await rejected
})
