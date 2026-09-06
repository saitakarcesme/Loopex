import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { NativeRunOutcome } from '../../shared/contracts'

export type NativeOutcome = NativeRunOutcome
export class ProviderQuiescenceError extends Error {
  override name = 'ProviderQuiescenceError'
  readonly code = 'AKORITH_PROCESS_QUIESCENCE_UNCONFIRMED'
  nativeOutcome?: NativeOutcome
  constructor(message: string, readonly details?: unknown, options?: ErrorOptions) { super(message, options) }
}
export type Probe = { state: 'alive' | 'absent' } | { state: 'unknown'; code: string; message: string }
export interface StopPolicy { timeoutMs: number; graceMs: number; pollMs: number; unknownTimeoutMs: number }
export type OwnedSpawnOptions = SpawnOptionsWithoutStdio & { stdio?: ['pipe', 'pipe', 'pipe'] }
export interface ProcessRuntime {
  platform: NodeJS.Platform
  spawn(file: string, args: string[], options: OwnedSpawnOptions): ChildProcessWithoutNullStreams
  signal(pid: number, signal: NodeJS.Signals | 0): unknown
  now(): number
  sleep(ms: number): Promise<void>
  ownershipId(): string
}
export interface QuiescenceReceipt {
  quiescent: true; ownershipId: string; pid: number | undefined
  scope: 'owned-detached-process-group'; leaderState: 'exited' | 'spawn-failed'; groupState: 'absent'
}
const defaults: StopPolicy = { timeoutMs: 5000, graceMs: 1500, pollMs: 20, unknownTimeoutMs: 500 }
const runtime: ProcessRuntime = {
  platform: process.platform,
  spawn: (file, args, options) => spawn(file, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] }),
  signal: (pid, signal) => process.kill(pid, signal),
  now: () => performance.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  ownershipId: randomUUID,
}
export function classifyProbeError(error: unknown): Probe {
  const e = error as NodeJS.ErrnoException
  return e?.code === 'ESRCH' ? { state: 'absent' } : { state: 'unknown', code: e?.code || 'UNKNOWN', message: e?.message || String(error) }
}

/** Trusted spawn seam for lifecycle tests/PTY adapters, never an arbitrary-PID adoption API. */
export function createOwnedProcessSpawner(rt: ProcessRuntime) {
  return (file: string, args: string[] = [], options: OwnedSpawnOptions = {}, overrides: Partial<StopPolicy> = {}) => {
    if (rt.platform === 'win32') throw new Error('Owned process-group cleanup requires a Unix host')
    if (options.uid !== undefined || options.gid !== undefined) throw new TypeError('Changing process credentials is unsupported')
    const policy = { ...defaults, ...overrides }
    for (const [key, value] of Object.entries(policy)) if (!Object.hasOwn(defaults, key) || !Number.isFinite(value) || value <= 0) throw new TypeError(`Invalid stop policy: ${key}`)
    if (policy.graceMs >= policy.timeoutMs || policy.pollMs > policy.timeoutMs || policy.unknownTimeoutMs > policy.timeoutMs) throw new TypeError('Stop intervals must fit inside the total timeout')
    const ownershipId = rt.ownershipId()
    const child = rt.spawn(file, args, { ...options, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let pid = child.pid
    const lifecycle: { state: 'starting' | 'spawned' | 'exited' | 'spawn-failed'; exit?: { code: number | null; signal: NodeJS.Signals | null } } = { state: 'starting' }
    let absent = false, closed = false, attempts = 0, termAt: number | undefined, killSent = false, lastError: unknown
    let pending: Promise<QuiescenceReceipt> | undefined, succeeded: Promise<QuiescenceReceipt> | undefined
    const observations: Array<Record<string, unknown>> = [], signals: Array<{ atMs: number; pid: number; signal: NodeJS.Signals }> = []
    const record = (phase: string, values: Record<string, unknown> = {}) => { observations.push({ atMs: rt.now(), phase, ...values }); if (observations.length > 128) observations.shift() }
    const validPid = (value: number | undefined): value is number => Number.isSafeInteger(value) && value! > 1
    const snapshot = () => ({ ownershipId, pid, leaderState: lifecycle.state, leaderExit: lifecycle.exit, closed, groupState: absent ? 'absent' : 'unconfirmed', attempts, signals: signals.map(x => ({ ...x })), observations: observations.map(x => ({ ...x })) })
    child.on('spawn', () => {
      if (!validPid(child.pid) || (pid !== undefined && child.pid !== pid)) { lastError = new Error('Owned child PID is invalid or changed'); record('invalid-owned-pid'); return }
      pid = child.pid; lifecycle.state = 'spawned'; record('leader-spawn')
    })
    child.on('error', error => {
      lastError = error
      if (lifecycle.state === 'starting' && child.pid === undefined) { lifecycle.state = 'spawn-failed'; absent = true }
      record('leader-error', { message: error.message })
    })
    child.on('exit', (code, signal) => { lifecycle.state = 'exited'; lifecycle.exit = { code, signal }; record('leader-exit', { code, signal }) })
    child.on('close', (code, signal) => { closed = true; record('leader-close', { code, signal }) })
    const quiet = () => absent && (lifecycle.state === 'exited' || lifecycle.state === 'spawn-failed')
    function signal(value: NodeJS.Signals | 0): Probe {
      if (absent) return { state: 'absent' }
      if (!validPid(pid) || lifecycle.state === 'starting') return { state: 'unknown', code: 'SPAWN_UNCONFIRMED', message: 'Waiting for owned child spawn confirmation' }
      const phase = value === 0 ? 'group-probe' : 'group-signal'
      try {
        rt.signal(-pid, value)
        if (value !== 0) signals.push({ atMs: rt.now(), pid: -pid, signal: value })
        record(phase, { state: 'alive', signal: value }); return { state: 'alive' }
      } catch (error) {
        lastError = error; const result = classifyProbeError(error)
        if (result.state === 'absent') absent = true
        record(phase, { ...result, signal: value }); return result
      }
    }
    async function attempt(): Promise<QuiescenceReceipt> {
      attempts++; const deadline = rt.now() + policy.timeoutMs; let unknownSince: number | undefined
      record('stop-begin', { attempt: attempts })
      for (;;) {
        if (quiet()) { record('quiescent'); return { quiescent: true, ownershipId, pid, scope: 'owned-detached-process-group', leaderState: lifecycle.state as 'exited' | 'spawn-failed', groupState: 'absent' } }
        let result = signal(0)
        if (result.state === 'alive') {
          if (termAt === undefined) { result = signal('SIGTERM'); if (result.state === 'alive') termAt = rt.now() }
          else if (!killSent && rt.now() - termAt >= policy.graceMs) { result = signal('SIGKILL'); if (result.state === 'alive') killSent = true }
        }
        if (quiet()) continue
        if (result.state === 'unknown') unknownSince ??= rt.now(); else unknownSince = undefined
        const now = rt.now(), unknownExpired = unknownSince !== undefined && now - unknownSince >= policy.unknownTimeoutMs
        if (unknownExpired || now >= deadline) {
          const reason = unknownExpired ? 'persistent-uncertainty' : 'deadline'
          record('stop-unconfirmed', { reason, observation: result })
          throw new ProviderQuiescenceError(`Owned process termination is unconfirmed (${reason})`, { ...snapshot(), reason, lastObservation: result }, { cause: lastError })
        }
        await rt.sleep(Math.min(policy.pollMs, deadline - now))
      }
    }
    function stop(): Promise<QuiescenceReceipt> {
      if (succeeded) return succeeded
      if (pending) return pending
      const completion = attempt(); pending = completion
      completion.then(() => { succeeded = completion; pending = undefined }, () => { pending = undefined })
      return completion
    }
    return Object.freeze({ child, ownershipId, stop, snapshot })
  }
}
export const spawnOwnedProcess = createOwnedProcessSpawner(runtime)
export type OwnedProcess = ReturnType<typeof spawnOwnedProcess>
