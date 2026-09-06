import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { performance } from 'node:perf_hooks'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { IPty, IDisposable } from 'node-pty'
import type { HostContext } from '../../shared/contracts'
import { createOwnedProcessSpawner, type OwnedProcess, type ProcessRuntime, type StopPolicy } from '../providers/process-owner'
import { writable } from './files'
import { settleStages } from './lifecycle'
import { PtySessionOwner, ensurePtySessionProbe, type SessionRuntime } from './pty-session'

type PtyModule = Pick<typeof import('node-pty'), 'spawn'>
interface TerminalOptions { preflight?: () => Promise<void>; loadPty?: () => Promise<PtyModule>; runtime?: Pick<ProcessRuntime, 'platform' | 'signal' | 'now' | 'sleep'>; stopPolicy?: Partial<StopPolicy>; sessionRuntime?: SessionRuntime }
interface Terminal { id: string; taskId: string; pty: IPty; owner: OwnedProcess; sessionOwner: PtySessionOwner; subscriptions: IDisposable[]; pending: string; output: string; cols: number; rows: number; exited: boolean; stopping?: boolean; exitCode?: number; flush?: ReturnType<typeof setTimeout>; closing?: Promise<void> }
export class TerminalManager {
  private sessions = new Map<string, Terminal>()
  private closing = false
  constructor(private emit: (event: Record<string, unknown>) => void, private options: TerminalOptions = {}) {}
  list(taskId: string): Array<{ id: string; taskId: string; output: string; cols: number; rows: number; exited: boolean; exitCode?: number }> { return [...this.sessions.values()].filter(session => session.taskId === taskId).map(({ id, taskId, output, cols, rows, exited, exitCode }) => ({ id, taskId, output, cols, rows, exited, exitCode })) }
  async create(context: HostContext, cols = 100, rows = 28): Promise<{ id: string }> {
    writable(context)
    if (this.closing) throw new Error('Terminal host is shutting down.')
    if (this.options.preflight) await this.options.preflight()
    else if (!this.options.sessionRuntime) await ensurePtySessionProbe()
    if (this.closing) throw new Error('Terminal host is shutting down.')
    const { spawn } = await (this.options.loadPty?.() ?? import('node-pty'))
    if (this.closing) throw new Error('Terminal host is shutting down.')
    if ([...this.sessions.values()].filter(item => item.taskId === context.taskId).length >= 4) throw new Error('This task already has four terminals. Close one before opening another.')
    const shell = process.env.SHELL || '/bin/zsh'
    const dimensions = { cols: this.dimension(cols, 100, 500), rows: this.dimension(rows, 28, 200) }
    let pty!: IPty; let lifecycle!: IDisposable
    // This private spawn adapter records only the PTY created here. It cannot adopt arbitrary PIDs.
    // Unix forkpty creates a new session/process group with this child's PID as leader.
    const spawnOwnedPty = createOwnedProcessSpawner({
      platform: this.options.runtime?.platform ?? process.platform,
      signal: this.options.runtime?.signal ?? ((pid, signal) => process.kill(pid, signal)),
      now: this.options.runtime?.now ?? (() => performance.now()),
      sleep: this.options.runtime?.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
      ownershipId: randomUUID,
      spawn: (file, args) => {
        pty = spawn(file, args, { name: 'xterm-256color', ...dimensions, cwd: context.cwd, env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', AKORITH_TASK_ID: context.taskId } as Record<string, string> })
        const events = Object.assign(new EventEmitter(), { pid: pty.pid })
        lifecycle = pty.onExit(({ exitCode, signal }) => { events.emit('exit', exitCode, signal ?? null); events.emit('close', exitCode, signal ?? null) })
        queueMicrotask(() => events.emit('spawn'))
        return events as unknown as ChildProcessWithoutNullStreams
      }
    })
    const owner = spawnOwnedPty(shell, ['-l'], {}, this.options.stopPolicy)
    const sessionOwner = new PtySessionOwner(owner, this.options.sessionRuntime, this.options.stopPolicy)
    const session: Terminal = { id: randomUUID(), taskId: context.taskId, pty, owner, sessionOwner, subscriptions: [lifecycle], pending: '', output: '', ...dimensions, exited: false }
    this.sessions.set(session.id, session)
    session.subscriptions.push(pty.onData(data => {
      session.pending = (session.pending + data).slice(-512 * 1024)
      session.output = (session.output + data).slice(-512 * 1024)
      session.flush ??= setTimeout(() => this.flush(session), 16)
    }), pty.onExit(({ exitCode }) => {
      this.flush(session)
      session.exited = true; session.exitCode = exitCode
      this.emit({ type: 'terminal:exit', taskId: context.taskId, id: session.id, code: exitCode })
    }))
    await sessionOwner.initialize()
    return { id: session.id }
  }
  private dimension(value: number, fallback: number, maximum: number): number { return Number.isFinite(value) ? Math.max(2, Math.min(maximum, Math.round(value))) : fallback }
  private flush(session: Terminal): void {
    if (session.flush) clearTimeout(session.flush)
    session.flush = undefined
    if (session.pending) this.emit({ type: 'terminal:data', taskId: session.taskId, id: session.id, data: session.pending })
    session.pending = ''
  }
  private get(taskId: string, id: string): Terminal {
    const session = this.sessions.get(id)
    if (!session || session.taskId !== taskId) throw new Error('Terminal not found in this task.')
    return session
  }
  write(context: HostContext, id: string, data: string): void {
    writable(context)
    if (this.closing) throw new Error('Terminal host is shutting down.')
    if (typeof data !== 'string' || data.length > 64 * 1024) throw new Error('Terminal input exceeds 64 KB.')
    const session = this.get(context.taskId, id)
    if (session.stopping) throw new Error('This terminal is stopping. Retry Close if cleanup failed.')
    if (session.exited) throw new Error('This terminal has exited. Open a new terminal to continue.')
    session.pty.write(data)
  }
  resize(taskId: string, id: string, cols: number, rows: number): void {
    const session = this.get(taskId, id)
    session.cols = this.dimension(cols, 100, 500); session.rows = this.dimension(rows, 28, 200)
    if (!session.exited && !session.stopping) session.pty.resize(session.cols, session.rows)
  }
  close(taskId: string, id: string): Promise<void> {
    const session = this.get(taskId, id)
    if (session.closing) return session.closing
    session.stopping = true
    const operation = (async () => {
      await session.sessionOwner.stop()
      this.flush(session)
      for (const subscription of session.subscriptions) subscription.dispose()
      this.sessions.delete(id)
      this.emit({ type: 'terminal:closed', taskId, id })
    })()
    session.closing = operation
    void operation.catch(() => { session.closing = undefined })
    return operation
  }
  async dispose(): Promise<void> {
    this.closing = true
    await settleStages([...this.sessions.values()].map(session => [`terminal:${session.id}`, () => this.close(session.taskId, session.id)]), 5500)
  }
}
