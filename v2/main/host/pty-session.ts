import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { performance } from 'node:perf_hooks'
import { settleWithin } from './lifecycle'
import { ProviderQuiescenceError, type OwnedProcess, type StopPolicy } from '../providers/process-owner'

export interface SessionMember { pid: number; pgid: number; birth: string }
export interface SessionSnapshot { sessionId: number; members: SessionMember[] }
export interface SessionRuntime {
  probe(sessionId: number): Promise<SessionSnapshot>
  signal(group: number, signal: NodeJS.Signals): void
  now(): number
  sleep(ms: number): Promise<void>
}
let binary: Promise<string> | undefined
async function helperPath(): Promise<string> {
  return binary ??= (async () => {
    if (process.platform !== 'darwin') throw new Error('Verified terminal session cleanup is currently supported on macOS.')
    const electron = process as NodeJS.Process & { resourcesPath?: string; defaultApp?: boolean }
    if (electron.resourcesPath) {
      const bundled = path.join(electron.resourcesPath, 'native/akorith-process-session')
      if (await fs.access(bundled, fs.constants.X_OK).then(() => true, () => false)) return bundled
      if (!electron.defaultApp && process.env.ELECTRON_RUN_AS_NODE !== '1') throw new Error('The packaged terminal session helper is missing. Rebuild Akorith Next.')
    }
    // A packaged Quit never consults its launch cwd or development source directory.
    const candidates = [path.join(__dirname, '../../v2/native/akorith-process-session'), path.join(process.cwd(), 'v2/native/akorith-process-session')]
    for (const file of candidates) if (await fs.access(file, fs.constants.X_OK).then(() => true, () => false)) return file
    throw new Error('The terminal session helper is missing. Rebuild native resources before opening a terminal.')
  })().catch(error => { binary = undefined; throw error })
}
export async function ensurePtySessionProbe(): Promise<void> { await helperPath() }
export async function probePtySession(sessionId: number): Promise<SessionSnapshot> {
  const file = await helperPath()
  const stdout = await new Promise<string>((resolve, reject) => {
    // Fixed read-only helper: it never forks, writes workspace files, or sends signals.
    execFile(file, [String(sessionId)], { cwd: os.tmpdir(), timeout: 1000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(`Terminal session observation failed: ${stderr.trim() || error.message}`)) : resolve(stdout))
  })
  const result = JSON.parse(stdout) as SessionSnapshot
  if (result.sessionId !== sessionId || !Array.isArray(result.members) || result.members.some(member => !Number.isSafeInteger(member.pid) || member.pid <= 1 || !Number.isSafeInteger(member.pgid) || member.pgid <= 1 || !/^\d+:\d+$/.test(member.birth))) throw new Error('Invalid terminal session observation.')
  return result
}
const runtime: SessionRuntime = { probe: probePtySession, signal: (group, signal) => { process.kill(-group, signal) }, now: () => performance.now(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) }

/** Trusted adapter for a PTY just spawned by TerminalManager, never a user-provided PID. */
export class PtySessionOwner {
  private birth?: string
  private initialized = false
  private pending?: Promise<void>
  private succeeded?: Promise<void>
  private terms = new Map<number, number>()
  private kills = new Set<number>()
  private policy: StopPolicy
  constructor(private owner: OwnedProcess, private rt: SessionRuntime = runtime, policy: Partial<StopPolicy> = {}) { this.policy = { timeoutMs: 5000, graceMs: 1500, pollMs: 30, unknownTimeoutMs: 500, ...policy } }
  private pid(): number { const pid = this.owner.child.pid; if (!Number.isSafeInteger(pid) || pid! <= 1) throw new Error('The owned PTY has no valid process identity.'); return pid! }
  private validate(snapshot: SessionSnapshot): void {
    if (snapshot.sessionId !== this.pid()) throw new ProviderQuiescenceError('The terminal session identity changed.')
    const leader = snapshot.members.find(member => member.pid === this.pid())
    if (this.birth && leader && leader.birth !== this.birth) throw new ProviderQuiescenceError('Terminal PID reuse detected; no signal was sent to the replacement session.')
  }
  async initialize(): Promise<void> {
    if (this.initialized) return
    const deadline = this.rt.now() + this.policy.timeoutMs
    while (this.rt.now() < deadline) {
      const snapshot = await this.rt.probe(this.pid())
      if (this.initialized) return // A concurrent close may have finished the same initial observation.
      this.validate(snapshot)
      const leader = snapshot.members.find(member => member.pid === this.pid())
      if (!leader && snapshot.members.length) throw new ProviderQuiescenceError('Terminal leader identity disappeared before session ownership was recorded.')
      if (!leader) {
        const state = this.owner.snapshot().leaderState
        // forkpty can return before the child establishes its new session. An empty census then is not exit evidence.
        if (state !== 'exited' && state !== 'spawn-failed') { await this.rt.sleep(this.policy.pollMs); continue }
      }
      this.birth = leader?.birth; this.initialized = true; return
    }
    throw new ProviderQuiescenceError('Terminal session initialization is unconfirmed; ownership is retained.')
  }
  stop(): Promise<void> {
    if (this.succeeded) return this.succeeded
    if (this.pending) return settleWithin(this.pending, 'Terminal session cleanup', this.policy.timeoutMs + 1200)
    const operation = this.attempt(); this.pending = operation
    void operation.then(() => { this.succeeded = operation; this.pending = undefined }, () => { this.pending = undefined })
    return settleWithin(operation, 'Terminal session cleanup', this.policy.timeoutMs + 1200)
  }
  private async attempt(): Promise<void> {
    await this.initialize()
    const deadline = this.rt.now() + this.policy.timeoutMs
    let uncertainSince: number | undefined; let lastError: unknown
    while (this.rt.now() < deadline) {
      try {
        const snapshot = await this.rt.probe(this.pid())
        this.validate(snapshot)
        if (!snapshot.members.length) { await this.owner.stop(); return }
        if (!this.birth) throw new ProviderQuiescenceError('A new session appeared after the original terminal had already exited.')
        for (const group of new Set(snapshot.members.map(member => member.pgid))) {
          const termAt = this.terms.get(group)
          let signal: NodeJS.Signals | undefined
          if (termAt === undefined) signal = 'SIGTERM'
          else if (!this.kills.has(group) && this.rt.now() - termAt >= this.policy.graceMs) signal = 'SIGKILL'
          if (signal) {
            // Only groups in this fresh, exact-session observation can receive a signal.
            try { this.rt.signal(group, signal) }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue; throw error }
            if (signal === 'SIGTERM') this.terms.set(group, this.rt.now()); else this.kills.add(group)
          }
        }
        uncertainSince = undefined
      } catch (error) {
        // A replaced session is a permanent ownership mismatch, not a transient permission race.
        if (error instanceof ProviderQuiescenceError) throw error
        lastError = error; uncertainSince ??= this.rt.now()
        if (this.rt.now() - uncertainSince >= this.policy.unknownTimeoutMs) throw new ProviderQuiescenceError('Terminal session cleanup is unconfirmed; its ownership is retained.', { sessionId: this.pid() }, { cause: error })
      }
      await this.rt.sleep(this.policy.pollMs)
    }
    throw new ProviderQuiescenceError('Terminal jobs did not become quiescent before the deadline; ownership is retained.', { sessionId: this.pid() }, { cause: lastError })
  }
}
