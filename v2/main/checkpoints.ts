import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { TextDecoder } from 'node:util'
import { containedPath, sha256, withFileWriteLock, writeFile } from './host/files'
import type { HostContext } from '../shared/contracts'

export interface CheckpointBudgets {
  maxFiles: number
  maxBytes: number
  maxFileBytes: number
  maxEntries: number
}
export interface CheckpointChange {
  path: string
  status: 'created' | 'modified' | 'deleted'
  beforeHash: string | null
  afterHash: string | null
  beforeMode?: number
  afterMode?: number
  beforeSize?: number
  afterSize?: number
  undoneAt?: number
}
export interface CheckpointSummary {
  taskId: string
  turnId: string
  cwd: string
  status: 'active' | 'finished'
  startedAt: number
  finishedAt?: number
  complete: boolean
  changes: CheckpointChange[]
  warnings: string[]
  beforeFiles: number
  afterFiles: number
}
interface FileVersion { hash: string; mode: number; size: number }
interface Snapshot {
  files: Record<string, FileVersion>
  observed: string[]
  absent: string[]
  complete: boolean
  warnings: string[]
}
interface Manifest {
  version: 1
  taskId: string
  turnId: string
  cwd: string
  startedAt: number
  finishedAt?: number
  before: Snapshot
  after?: Snapshot
  changes: CheckpointChange[]
  undo?: { path: string; trash?: string; startedAt: number }
}

const DEFAULTS: CheckpointBudgets = { maxFiles: 2000, maxBytes: 20 * 1024 * 1024, maxFileBytes: 1024 * 1024, maxEntries: 20_000 }
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'bower_components', '.next', '.nuxt', '.output', '.turbo', '.cache', '.parcel-cache', '.venv', 'venv', 'dist', 'dist-v2', 'build', 'out', 'out-v2', 'target', 'coverage', '__pycache__', '.pytest_cache', '.mypy_cache', '.idea', '.ssh', '.aws', '.azure', '.gcloud', '.gnupg', '.secrets', 'artifacts-v2'])
const decoder = new TextDecoder('utf-8', { fatal: true })
const noEntry = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR'
function validateId(value: string, label: string): void {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(value)) throw new Error(`Invalid ${label}.`)
}
function relativeFile(value: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') || path.isAbsolute(value)) throw new Error('Choose a relative checkpoint file path.')
  const segments = value.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) throw new Error('Invalid checkpoint file path.')
  return segments.join(path.sep)
}
function secretFile(name: string): boolean {
  return /^\.env(?:\.|$)|^\.envrc$|^\.(?:npmrc|pypirc|netrc|git-credentials|yarnrc)|(?:credentials?|secrets?|service[-_]?account)(?:\.|[-_]|$)|^(?:auth|token|tokens)\.json$|^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)|\.(?:pem|p12|pfx|key|keystore|jks)$/i.test(name)
}
function skippedPath(relative: string): boolean {
  const segments = relative.split(path.sep)
  return segments.some(segment => IGNORED_DIRECTORIES.has(segment.toLowerCase()) || secretFile(segment) || segment.startsWith('.akorith-')) || segments.at(-1) === '.DS_Store'
}
function cloneSummary(manifest: Manifest): CheckpointSummary {
  return {
    taskId: manifest.taskId, turnId: manifest.turnId, cwd: manifest.cwd,
    status: manifest.after ? 'finished' : 'active', startedAt: manifest.startedAt,
    ...(manifest.finishedAt ? { finishedAt: manifest.finishedAt } : {}),
    complete: manifest.before.complete && (manifest.after?.complete ?? false),
    changes: manifest.changes.map(change => ({ ...change })),
    warnings: [...manifest.before.warnings, ...manifest.after?.warnings ?? [], ...(manifest.undo ? ['A file undo was interrupted. Its retained snapshot is intact; retry that file to reconcile it.'] : [])],
    beforeFiles: Object.keys(manifest.before.files).length, afterFiles: Object.keys(manifest.after?.files ?? {}).length,
  }
}

/** Actual per-turn file snapshots. No Git HEAD/reset operation is used. */
export class CheckpointManager {
  private readonly budgets: CheckpointBudgets
  private readonly locks = new Map<string, Promise<void>>()
  private readonly storage: string
  constructor(private readonly userData: string, budgets: Partial<CheckpointBudgets> = {}) {
    this.storage = path.join(userData, 'checkpoints')
    this.budgets = { ...DEFAULTS, ...budgets }
    for (const [key, value] of Object.entries(this.budgets)) if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Checkpoint ${key} must be a positive integer.`)
    this.budgets.maxFileBytes = Math.min(this.budgets.maxFileBytes, 4 * 1024 * 1024)
    this.budgets.maxFiles = Math.min(this.budgets.maxFiles, 10_000)
    this.budgets.maxEntries = Math.min(this.budgets.maxEntries, 100_000)
    this.budgets.maxBytes = Math.min(this.budgets.maxBytes, 128 * 1024 * 1024)
  }
  private async locked<T>(turnId: string, operation: () => Promise<T>): Promise<T> {
    validateId(turnId, 'turn identifier')
    const previous = this.locks.get(turnId)
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    this.locks.set(turnId, current)
    await previous
    try { return await operation() }
    finally { release(); if (this.locks.get(turnId) === current) this.locks.delete(turnId) }
  }
  private async directory(turnId: string, create = false): Promise<string> {
    validateId(turnId, 'turn identifier')
    await fs.mkdir(this.userData, { recursive: true })
    const root = await containedPath(this.userData, 'checkpoints', true)
    if (create) await fs.mkdir(root, { recursive: true })
    const directory = await containedPath(this.userData, path.join(root, turnId), create)
    if (create) { await fs.mkdir(directory, { recursive: true }); await fs.mkdir(path.join(directory, 'blobs'), { recursive: true }) }
    return directory
  }
  private async readManifest(turnId: string): Promise<Manifest | null> {
    try {
      const directory = await this.directory(turnId)
      const file = await containedPath(directory, 'manifest.json')
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
      let value: Manifest
      try {
        if ((await handle.stat()).size > 32 * 1024 * 1024) throw new Error('Checkpoint metadata exceeds its size limit.')
        value = JSON.parse(await handle.readFile('utf8')) as Manifest
      } finally { await handle.close() }
      if (value.version !== 1 || value.turnId !== turnId || !value.before || !value.before.files || !Array.isArray(value.changes) || typeof value.cwd !== 'string') throw new Error('Checkpoint metadata is invalid.')
      validateId(value.taskId, 'checkpoint task identifier')
      for (const change of value.changes) relativeFile(change.path)
      for (const snapshot of [value.before, value.after].filter(Boolean) as Snapshot[]) {
        snapshot.files = Object.assign(Object.create(null), snapshot.files)
        if (!Array.isArray(snapshot.observed) || !Array.isArray(snapshot.absent) || !Array.isArray(snapshot.warnings)) throw new Error('Checkpoint snapshot metadata is invalid.')
        for (const [file, version] of Object.entries(snapshot.files)) {
          relativeFile(file)
          if (skippedPath(file) || !/^[a-f0-9]{64}$/.test(version.hash) || !Number.isSafeInteger(version.size) || version.size < 0 || version.size > 4 * 1024 * 1024 || !Number.isInteger(version.mode) || version.mode < 0 || version.mode > 0o777) throw new Error('Checkpoint file metadata is invalid.')
        }
      }
      return value
    } catch (error) { if (noEntry(error)) return null; throw error }
  }
  private async writeManifest(manifest: Manifest): Promise<void> {
    const directory = await this.directory(manifest.turnId, true)
    const temporary = path.join(directory, `.manifest-${randomUUID()}.tmp`)
    try {
      const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await handle.writeFile(JSON.stringify(manifest)); await handle.sync() } finally { await handle.close() }
      await fs.rename(temporary, path.join(directory, 'manifest.json'))
    } finally { await fs.unlink(temporary).catch(() => {}) }
  }
  private async verify(manifest: Manifest, taskId: string, cwd?: string): Promise<void> {
    validateId(taskId, 'task identifier')
    if (manifest.taskId !== taskId) throw new Error('This checkpoint belongs to another task.')
    if (cwd !== undefined && await fs.realpath(cwd) !== manifest.cwd) throw new Error('This checkpoint belongs to another workspace.')
  }
  private async plainPath(cwd: string, input: string, allowMissing = false): Promise<string> {
    const relative = relativeFile(input)
    const root = await fs.realpath(cwd)
    let current = root
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment)
      try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Checkpoint operations never follow symbolic links.') }
      catch (error) { if (allowMissing && noEntry(error)) break; throw error }
    }
    return containedPath(root, relative, allowMissing)
  }
  private async readText(cwd: string, relative: string): Promise<{ version: FileVersion; data: Buffer }> {
    const file = await this.plainPath(cwd, relative)
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await handle.stat()
      if (!before.isFile()) throw new Error('not-regular')
      if (before.size > this.budgets.maxFileBytes) throw new Error('file-budget')
      const buffer = Buffer.alloc(before.size + 1)
      let length = 0
      while (length < buffer.length) {
        const result = await handle.read(buffer, length, buffer.length - length, length)
        if (!result.bytesRead) break
        length += result.bytesRead
      }
      const after = await handle.stat(); const current = await fs.lstat(file)
      if (before.ino !== current.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || length !== before.size) throw new Error('changed-during-capture')
      const data = buffer.subarray(0, length)
      if (data.includes(0)) throw new Error('binary')
      try { decoder.decode(data) } catch { throw new Error('binary') }
      return { version: { hash: sha256(data), size: data.length, mode: before.mode & 0o777 }, data }
    } finally { await handle.close() }
  }
  private async saveBlob(directory: string, version: FileVersion, data: Buffer): Promise<void> {
    const file = await containedPath(directory, path.join('blobs', `${version.hash}.txt`), true)
    try {
      const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await handle.writeFile(data); await handle.sync() } finally { await handle.close() }
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
  private async blob(manifest: Manifest, version: FileVersion): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(version.hash) || version.size > 4 * 1024 * 1024) throw new Error('Checkpoint file metadata is invalid.')
    const directory = await this.directory(manifest.turnId)
    const file = await containedPath(directory, path.join('blobs', `${version.hash}.txt`))
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      if ((await handle.stat()).size !== version.size) throw new Error('Checkpoint snapshot is incomplete.')
      const data = await handle.readFile()
      if (sha256(data) !== version.hash) throw new Error('Checkpoint snapshot failed its integrity check.')
      decoder.decode(data)
      return data.toString('utf8') // Preserve a UTF-8 BOM and exact CRLF bytes on restoration.
    } finally { await handle.close() }
  }
  private async scan(cwd: string, turnId: string, phase: 'Before' | 'After', priority: string[] = []): Promise<Snapshot> {
    const directory = await this.directory(turnId, true)
    const storage = await fs.realpath(this.storage)
    const result: Snapshot = { files: Object.create(null), observed: [], absent: [], complete: true, warnings: [] }
    const observed = new Set<string>(); const attempted = new Set<string>(); const counts = new Map<string, number>()
    let bytes = 0; let files = 0; let entries = 0
    const count = (reason: string) => counts.set(reason, (counts.get(reason) ?? 0) + 1)
    const capture = async (relative: string, known = false) => {
      if (attempted.has(relative) || skippedPath(relative)) return
      attempted.add(relative)
      let info: Awaited<ReturnType<typeof fs.lstat>>
      try { info = await fs.lstat(await this.plainPath(cwd, relative, true)) }
      catch (error) {
        if (noEntry(error)) { if (known) result.absent.push(relative) }
        else { observed.add(relative); count('unreadable or symbolic-link paths') }
        return
      }
      observed.add(relative)
      if (!info.isFile()) { count('non-regular paths'); return }
      if (files >= this.budgets.maxFiles) { count('file-count budget omissions'); result.complete = false; return }
      if (info.size > this.budgets.maxFileBytes) { count('per-file byte budget omissions'); return }
      if (bytes + info.size > this.budgets.maxBytes) { count('total-byte budget omissions'); result.complete = false; return }
      try {
        const { version, data } = await this.readText(cwd, relative)
        await this.saveBlob(directory, version, data)
        result.files[relative] = version; bytes += data.length; files++
      } catch (error) { count(error instanceof Error && error.message === 'binary' ? 'non-text files' : 'files unavailable or changed during capture') }
    }
    // Tracked files are read first, so traversal limits cannot invent a deletion.
    for (const relative of priority) await capture(relative, true)
    const queue = ['']
    while (queue.length) {
      if (entries >= this.budgets.maxEntries) { count('directory-entry budget omissions'); result.complete = false; break }
      const relative = queue.shift()!
      let children: string[]
      try {
        const target = relative ? await this.plainPath(cwd, relative) : cwd
        if (target === storage || target.startsWith(`${storage}${path.sep}`)) continue
        children = await fs.readdir(target)
      } catch { count('unreadable directories'); result.complete = false; continue }
      for (const name of children.sort()) {
        entries++
        if (entries > this.budgets.maxEntries) { count('directory-entry budget omissions'); result.complete = false; break }
        const child = relative ? path.join(relative, name) : name
        if (skippedPath(child)) continue
        try {
          const target = await this.plainPath(cwd, child)
          if (target === storage || target.startsWith(`${storage}${path.sep}`)) continue
          const stat = await fs.lstat(target)
          if (stat.isDirectory()) queue.push(child)
          else await capture(child)
        } catch { observed.add(child); count('unreadable or symbolic-link paths'); result.complete = false }
      }
    }
    result.observed = [...observed].sort()
    for (const [reason, total] of counts) result.warnings.push(`${phase} checkpoint: ${total} ${reason}.`)
    if (!result.complete) result.warnings.push(`${phase} checkpoint is partial (limits: ${this.budgets.maxFiles} files, ${this.budgets.maxBytes} bytes, ${this.budgets.maxEntries} entries). Uncaptured paths cannot be undone.`)
    return result
  }
  async begin(taskId: string, turnId: string, cwd: string): Promise<CheckpointSummary> {
    return this.locked(turnId, async () => {
      validateId(taskId, 'task identifier')
      const root = await fs.realpath(cwd)
      if (!(await fs.stat(root)).isDirectory()) throw new Error('Checkpoint workspace is not a directory.')
      const existing = await this.readManifest(turnId)
      if (existing) { await this.verify(existing, taskId, root); return cloneSummary(existing) }
      const manifest: Manifest = { version: 1, taskId, turnId, cwd: root, startedAt: Date.now(), before: await this.scan(root, turnId, 'Before'), changes: [] }
      await this.writeManifest(manifest)
      return cloneSummary(manifest)
    })
  }
  async finish(taskId: string, turnId: string, cwd: string): Promise<CheckpointSummary> {
    return this.locked(turnId, async () => {
      const manifest = await this.readManifest(turnId)
      if (!manifest) throw new Error('This turn has no before checkpoint.')
      await this.verify(manifest, taskId, cwd)
      if (manifest.after) return cloneSummary(manifest)
      const after = await this.scan(manifest.cwd, turnId, 'After', Object.keys(manifest.before.files))
      const before = manifest.before; const seenBefore = new Set(before.observed); const absentAfter = new Set(after.absent)
      const changes: CheckpointChange[] = []
      for (const file of Object.keys(before.files)) {
        const original = before.files[file]; const latest = after.files[file]
        if (latest && (original.hash !== latest.hash || original.mode !== latest.mode)) changes.push({ path: file, status: 'modified', beforeHash: original.hash, afterHash: latest.hash, beforeMode: original.mode, afterMode: latest.mode, beforeSize: original.size, afterSize: latest.size })
        else if (!latest && absentAfter.has(file)) changes.push({ path: file, status: 'deleted', beforeHash: original.hash, afterHash: null, beforeMode: original.mode, beforeSize: original.size })
        else if (!latest) after.warnings.push(`Changes to ${file} could not be captured safely; no undo is offered.`)
      }
      for (const [file, latest] of Object.entries(after.files)) {
        if (!before.files[file] && !seenBefore.has(file)) {
          if (before.complete) changes.push({ path: file, status: 'created', beforeHash: null, afterHash: latest.hash, afterMode: latest.mode, afterSize: latest.size })
          else after.warnings.push(`Creation status for ${file} is unknown because the before checkpoint was partial; no undo is offered.`)
        }
      }
      manifest.after = after; manifest.finishedAt = Date.now(); manifest.changes = changes.sort((a, b) => a.path.localeCompare(b.path))
      await this.writeManifest(manifest)
      return cloneSummary(manifest)
    })
  }
  async list(turnId: string, taskId?: string): Promise<CheckpointSummary | null> {
    return this.locked(turnId, async () => { const manifest = await this.readManifest(turnId); if (!manifest) return null; if (taskId !== undefined) await this.verify(manifest, taskId); return cloneSummary(manifest) })
  }
  async read(taskId: string, turnId: string, filePath: string): Promise<{ change: CheckpointChange; before: string | null; after: string | null }> {
    return this.locked(turnId, async () => {
      const manifest = await this.readManifest(turnId); if (!manifest?.after) throw new Error('No completed checkpoint exists for this turn.')
      await this.verify(manifest, taskId)
      const file = relativeFile(filePath); const change = manifest.changes.find(item => item.path === file)
      if (!change) throw new Error('This file is not part of the turn checkpoint.')
      return { change: { ...change }, before: manifest.before.files[file] ? await this.blob(manifest, manifest.before.files[file]) : null, after: manifest.after.files[file] ? await this.blob(manifest, manifest.after.files[file]) : null }
    })
  }
  async undo(taskId: string, turnId: string, filePath: string, cwd: string): Promise<{ ok: true; change: CheckpointChange; retainedPath?: string }> {
    return this.locked(turnId, async () => {
      const manifest = await this.readManifest(turnId); if (!manifest?.after) throw new Error('No completed checkpoint exists for this turn.')
      await this.verify(manifest, taskId, cwd)
      const file = relativeFile(filePath); const change = manifest.changes.find(item => item.path === file)
      if (!change) throw new Error('This file is not part of the turn checkpoint.')
      if (change.undoneAt) throw new Error('This file has already been undone.')
      if (manifest.undo && manifest.undo.path !== file) throw new Error('Finish reconciling the interrupted file undo before undoing another file.')
      await this.plainPath(manifest.cwd, file, true)
      const context: HostContext = { taskId, cwd: manifest.cwd, mode: 'work' }
      const before = manifest.before.files[file]; const after = manifest.after.files[file]
      let retainedPath: string | undefined
      // Reconcile a process exit after the atomic file operation but before its metadata save.
      if (manifest.undo) {
        const current = await this.readText(manifest.cwd, file).catch(error => { if (noEntry(error)) return null; throw error })
        const restored = before ? current?.version.hash === before.hash && current.version.mode === before.mode : !current && !!manifest.undo.trash
        if (restored) {
          if (manifest.undo.trash) {
            const directory = await this.directory(turnId)
            retainedPath = await containedPath(directory, manifest.undo.trash)
            if (sha256(await fs.readFile(retainedPath)) !== after?.hash) throw new Error('The retained file failed its integrity check.')
          }
          change.undoneAt = Date.now(); delete manifest.undo; await this.writeManifest(manifest)
          return { ok: true, change: { ...change }, ...(retainedPath ? { retainedPath } : {}) }
        }
      }
      const current = await this.readText(manifest.cwd, file).catch(error => { if (noEntry(error)) return null; throw error })
      if (after ? !current || current.version.hash !== after.hash || current.version.mode !== after.mode : current !== null) throw new Error('This file changed after the turn. Undo was cancelled to preserve newer work.')
      manifest.undo = { path: file, startedAt: Date.now() }
      if (change.status === 'created') {
        const directory = await this.directory(turnId)
        await fs.mkdir(path.join(directory, 'trash'), { recursive: true })
        manifest.undo.trash = path.join('trash', `${sha256(file)}-${randomUUID()}.txt`)
        retainedPath = await containedPath(directory, manifest.undo.trash, true)
        await this.writeManifest(manifest)
        try {
          await withFileWriteLock(context, file, async target => {
            await this.plainPath(manifest.cwd, file)
            const latest = await this.readText(manifest.cwd, file)
            if (latest.version.hash !== after?.hash || latest.version.mode !== after.mode) throw new Error('This file changed while undoing. Newer work was preserved.')
            try { await fs.rename(target, retainedPath!) }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'EXDEV') throw new Error('The workspace and checkpoint archive are on different volumes. The created file was left unchanged.'); throw error }
          })
        } catch (error) { delete manifest.undo; await this.writeManifest(manifest).catch(() => {}); throw error }
      } else {
        const content = await this.blob(manifest, before)
        await this.writeManifest(manifest)
        try { await writeFile(context, file, content, after?.hash, { expectedAbsent: !after, mode: before.mode, expectedMode: after?.mode }) }
        catch (error) { delete manifest.undo; await this.writeManifest(manifest).catch(() => {}); throw error }
      }
      change.undoneAt = Date.now(); delete manifest.undo; await this.writeManifest(manifest)
      return { ok: true, change: { ...change }, ...(retainedPath ? { retainedPath } : {}) }
    })
  }
}
