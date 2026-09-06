import * as fs from 'node:fs/promises'
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { ComputerState, HostContext } from '../../shared/contracts'
import { requireFull } from './files'
import { runCommand } from './process'
import { settleWithin } from './lifecycle'

export class ComputerManager {
  private selected = new Map<string, { bundleId: string; pid: number }>()
  private active = new Set<AbortController>()
  private helper?: Promise<string>
  private busy = false
  private generation = 0
  private paused = false
  private closed = false
  private lifetime = new AbortController()
  private pending = new Set<Promise<unknown>>()
  constructor(private userData: string, private emit: (event: Record<string, unknown>) => void) {
    try { this.paused = JSON.parse(readFileSync(path.join(userData, 'computer-control.json'), 'utf8')).paused === true } catch {}
  }
  private persistPause(): void {
    mkdirSync(this.userData, { recursive: true })
    const file = path.join(this.userData, 'computer-control.json')
    const temporary = `${file}.tmp`
    writeFileSync(temporary, JSON.stringify({ paused: this.paused }), { mode: 0o600 })
    renameSync(temporary, file)
  }
  private binary(): Promise<string> { return this.helper ??= this.findOrBuild().catch(error => { this.helper = undefined; throw error }) }
  private async findOrBuild(): Promise<string> {
    if (process.platform !== 'darwin') throw new Error('Computer tools are available on macOS only.')
    const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    if (resources) {
      const bundled = path.join(resources, 'native', 'akorith-computer')
      if (await fs.access(bundled, fs.constants.X_OK).then(() => true, () => false)) return bundled
    }
    const locations = [path.join(process.cwd(), 'v2/native/ComputerBridge.swift'), path.join(__dirname, '../../v2/native/ComputerBridge.swift')]
    if (resources) locations.push(path.join(resources, 'native/ComputerBridge.swift'))
    let source = ''
    for (const candidate of locations) if (await fs.access(candidate).then(() => true, () => false)) { source = candidate; break }
    if (!source) throw new Error('The macOS computer helper is not bundled. Rebuild Akorith Next with the native helper.')
    const hash = createHash('sha256').update(await fs.readFile(source)).digest('hex').slice(0, 16)
    const directory = path.join(this.userData, 'native', hash)
    await fs.mkdir(directory, { recursive: true })
    const binary = path.join(directory, 'akorith-computer')
    if (await fs.access(binary, fs.constants.X_OK).then(() => true, () => false)) return binary
    if (this.closed) throw new Error('Computer host is shutting down.')
    const result = await runCommand('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-O', source, '-o', binary, '-framework', 'AppKit', '-framework', 'ScreenCaptureKit', '-framework', 'ApplicationServices'], { cwd: directory, signal: this.lifetime.signal, timeout: 120_000, maxOutput: 12000 })
    if (result.code !== 0) throw new Error(`Could not build the macOS helper. Xcode Command Line Tools are required. ${result.stderr.slice(-1000)}`)
    return binary
  }
  private call(payload: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Computer host is shutting down.'))
    const operation = this.performCall(payload, signal)
    this.pending.add(operation)
    void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation))
    return operation
  }
  private async performCall(payload: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    const generation = this.generation
    const binary = await this.binary()
    if (this.closed || signal?.aborted || generation !== this.generation) throw new Error('Computer action cancelled.')
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true }); this.active.add(controller)
    try {
      const result = await runCommand(binary, [], { cwd: this.userData, signal: controller.signal, timeout: payload.action === 'permissions' ? 60_000 : 15_000, maxOutput: 24 * 1024 * 1024, input: JSON.stringify(payload) })
      if (this.closed || controller.signal.aborted || generation !== this.generation) throw new Error('Computer action cancelled.')
      let output: any
      try { output = JSON.parse(result.stdout) } catch { throw new Error(result.stderr.trim() || 'The computer helper returned invalid output.') }
      if (result.code !== 0 || output.error) throw new Error(output.error || result.stderr || 'Computer action failed.')
      return output
    } finally { this.active.delete(controller); signal?.removeEventListener('abort', abort) }
  }
  async state(prompt = false): Promise<ComputerState> {
    try { return { ...await this.call({ action: prompt ? 'permissions' : 'state' }), paused: this.paused } }
    catch (error) { return { accessibility: false, screenRecording: false, apps: [], error: error instanceof Error ? error.message : String(error), paused: this.paused } as ComputerState }
  }
  async capture(bundleId?: string): Promise<{ dataUrl: string }> {
    if (this.paused) throw new Error('Computer control is paused. Resume it in the Computer panel before capturing.')
    return this.call({ action: 'capture', ...(bundleId ? { bundleId } : {}) })
  }
  async execute(action: string, args: Record<string, unknown>, context: HostContext, signal?: AbortSignal): Promise<unknown> {
    if (action === 'state') return this.state()
    requireFull(context)
    if (this.paused) throw new Error('Computer control is paused by the user. Only the user can resume it from the Computer panel. Do not retry or attempt to resume through other tools.')
    if (this.busy) throw new Error('Another computer action is in progress. Wait for its result before continuing.')
    this.busy = true
    try {
      if (action === 'select') {
        const result = await this.call({ action, bundleId: args.bundleId }, signal)
        this.selected.set(context.taskId, { bundleId: String(args.bundleId), pid: result.pid })
        this.emit({ type: 'computer:selected', taskId: context.taskId, bundleId: args.bundleId, name: result.name })
        return result
      }
      const selected = this.selected.get(context.taskId)
      if (!selected) throw new Error('Select an application with computer_select before using computer tools.')
      this.emit({ type: 'computer:active', taskId: context.taskId, bundleId: selected.bundleId, action })
      return await this.call({ ...args, action, ...selected }, signal)
    } finally { this.busy = false; this.emit({ type: 'computer:idle', taskId: context.taskId }) }
  }
  private cancel(): void { this.generation++; for (const controller of this.active) controller.abort(); this.selected.clear() }
  stop(): void {
    this.paused = true; this.cancel()
    try { this.persistPause() } catch (error) { this.emit({ type: 'notice', text: `Computer control stopped, but its paused state could not be saved: ${error instanceof Error ? error.message : String(error)}` }) }
    this.emit({ type: 'computer:stopped', paused: true })
  }
  resume(): void {
    if (this.closed) throw new Error('Computer host is shutting down.')
    this.cancel(); this.paused = false
    try { this.persistPause() } catch (error) { this.paused = true; throw error }
    this.emit({ type: 'computer:resumed', paused: false })
  }
  async dispose(): Promise<void> {
    this.closed = true; this.cancel(); this.lifetime.abort()
    await settleWithin(Promise.allSettled([...this.pending, ...(this.helper ? [this.helper] : [])]), 'Computer helper operations')
  }
}
