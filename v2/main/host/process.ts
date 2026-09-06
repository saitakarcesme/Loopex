import { AsyncLocalStorage } from 'node:async_hooks'
import { spawnOwnedProcess, type OwnedProcess } from '../providers/process-owner'
import { settleStages, settleWithin } from './lifecycle'

export interface CommandResult { stdout: string; stderr: string; code: number; truncated: boolean }
interface CommandScope { registry: CommandRegistry; taskId?: string; signal?: AbortSignal }
const scope = new AsyncLocalStorage<CommandScope>()

/** Keeps failed cleanup ownership even after the command/tool promise has rejected. */
export class CommandRegistry {
  private owners = new Map<OwnedProcess, string | undefined>()
  run<T>(taskId: string | undefined, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> { return scope.run({ registry: this, taskId, signal }, operation) }
  retain(owner: OwnedProcess, taskId?: string): void { this.owners.set(owner, taskId) }
  async stop(owner: OwnedProcess): Promise<void> {
    await owner.stop()
    owner.child.stdin.destroy(); owner.child.stdout.destroy(); owner.child.stderr.destroy()
    this.owners.delete(owner)
  }
  async drain(taskId?: string): Promise<void> {
    await settleStages([...this.owners].filter(([, id]) => taskId === undefined || id === taskId).map(([owner]) => [`command:${owner.ownershipId}`, () => this.stop(owner)]), 5500)
  }
  get size(): number { return this.owners.size }
}
const fallbackRegistry = new CommandRegistry()
export function drainCommands(): Promise<void> { return fallbackRegistry.drain() }

export async function runCommand(command: string, args: string[], options: { cwd: string; signal?: AbortSignal; timeout?: number; maxOutput?: number; env?: NodeJS.ProcessEnv; input?: string; onData?: (data: string) => void }): Promise<CommandResult> {
  const current = scope.getStore()
  const signal = options.signal && current?.signal ? AbortSignal.any([options.signal, current.signal]) : options.signal ?? current?.signal
  if (signal?.aborted) throw new Error('Command cancelled.')
  const registry = current?.registry ?? fallbackRegistry
  const owner = spawnOwnedProcess(command, args, { cwd: options.cwd, env: options.env ?? process.env })
  const child = owner.child
  registry.retain(owner, current?.taskId)
  return new Promise((resolve, reject) => {
    const max = options.maxOutput ?? 1024 * 1024
    let stdout = ''; let stderr = ''; let truncated = false; let cancellation: string | undefined
    let finishing = false; let closed = false
    let resolveClose!: () => void
    const close = new Promise<void>(resolve => { resolveClose = resolve })
    child.once('close', () => { closed = true; resolveClose() })
    const append = (chunk: Buffer, error: boolean) => {
      const text = chunk.toString('utf8')
      try { options.onData?.(text) } catch { /* A UI observer cannot sever process ownership. */ }
      const available = max - Buffer.byteLength(stdout) - Buffer.byteLength(stderr)
      if (Buffer.byteLength(text) > available) truncated = true
      const bounded = Buffer.from(text).subarray(0, Math.max(0, available)).toString('utf8')
      if (error) stderr += bounded; else stdout += bounded
    }
    child.stdout.on('data', (chunk: Buffer) => append(chunk, false))
    child.stderr.on('data', (chunk: Buffer) => append(chunk, true))
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel) }
    const finish = async (error?: Error) => {
      if (finishing) return
      finishing = true; cleanup()
      try {
        // Leader exit alone is insufficient: background writers can survive in its process group.
        await owner.stop()
        if (!closed) await settleWithin(close, 'Command output streams', 1000)
        await registry.stop(owner)
        if (error) reject(error)
        else if (cancellation) reject(new Error(cancellation))
        else resolve({ stdout, stderr, code: child.exitCode ?? -1, truncated })
      } catch (cleanupError) { reject(cleanupError) }
    }
    const cancel = () => { cancellation = 'Command cancelled.'; void finish() }
    signal?.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(() => { cancellation = 'Command timed out.'; void finish() }, options.timeout ?? 60_000)
    child.once('error', error => { void finish(error) })
    child.once('exit', () => { void finish() })
    child.stdin.on('error', () => {})
    child.stdin.end(options.input)
    if (signal?.aborted) cancel()
  })
}
