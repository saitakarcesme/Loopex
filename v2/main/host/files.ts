import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { FileEntry, HostContext } from '../../shared/contracts'

const MAX_FILE = 4 * 1024 * 1024
const fileWrites = new Map<string, Promise<void>>()
export function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }
export function writable(context: HostContext): void {
  if (context.mode === 'read') throw new Error('This task is in Inspect mode. Switch to Work to change files or run commands.')
}
export function requireFull(context: HostContext): void {
  if (context.mode !== 'full') throw new Error('Computer control requires Full access for this task.')
}
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

/** Verify every existing ancestor, including symlinks, before touching project content. */
export async function containedPath(cwd: string, input = '.', allowMissing = false): Promise<string> {
  if (typeof input !== 'string' || input.includes('\0')) throw new Error('Invalid file path.')
  const root = await fs.realpath(cwd)
  const lexicalRoot = path.resolve(cwd)
  const lexical = path.resolve(cwd, input)
  let anchor = inside(lexicalRoot, lexical) ? lexicalRoot : inside(root, lexical) ? root : undefined
  if (!anchor && path.isAbsolute(input)) {
    // /var and /private/var (or a workspace symlink) can name the exact same root.
    // Find the FIRST root match from the outside inward; starting at the leaf could
    // skip a workspace symlink that escapes and later re-enters through another link.
    const volume = path.parse(lexical).root
    let ancestor = volume
    for (const segment of lexical.slice(volume.length).split(path.sep).filter(Boolean)) {
      ancestor = path.join(ancestor, segment)
      try {
        if (await fs.realpath(ancestor) === root) { anchor = ancestor; break }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') break
        throw error
      }
    }
  }
  if (!anchor) throw new Error('Path is outside the selected workspace.')
  const relative = path.relative(anchor, lexical)
  const segments = relative.split(path.sep).filter(Boolean)
  let resolved = root
  for (let index = 0; index < segments.length; index++) {
    const candidate = path.join(resolved, segments[index])
    try {
      resolved = await fs.realpath(candidate)
      if (!inside(root, resolved)) throw new Error('A symbolic link points outside the selected workspace.')
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        const existing = await fs.lstat(candidate).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
        // realpath also reports ENOENT for a dangling link. It must never authorize
        // mkdir/write through that existing link into an unverified target.
        if (existing?.isSymbolicLink()) throw new Error('A symbolic link cannot be resolved inside the selected workspace.')
        if (existing) throw error
        return path.join(candidate, ...segments.slice(index + 1))
      }
      throw error
    }
  }
  return resolved
}

export async function listFiles(context: HostContext, input = '.'): Promise<FileEntry[]> {
  const directory = await containedPath(context.cwd, input)
  const root = await fs.realpath(context.cwd)
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const result: FileEntry[] = []
  for (const entry of entries.slice(0, 5000)) {
    if (entry.name === '.git') continue
    try {
      const target = await containedPath(context.cwd, path.join(directory, entry.name))
      const stat = await fs.stat(target)
      result.push({ name: entry.name, path: path.relative(root, path.join(directory, entry.name)), directory: stat.isDirectory(), size: stat.size })
    } catch { /* Broken links and links outside the workspace are not exposed. */ }
  }
  return result.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
}

export async function readFile(context: HostContext, input: string, limit = MAX_FILE): Promise<{ path: string; content: string; hash: string; truncated: boolean; binary?: boolean }> {
  const target = await containedPath(context.cwd, input)
  if (!(await fs.stat(target)).isFile()) throw new Error('The selected path is not a regular file.')
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('The selected path is not a regular file.')
    const buffer = Buffer.alloc(Math.min(stat.size, Math.max(1, Math.min(limit, MAX_FILE))))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const data = buffer.subarray(0, bytesRead)
    const binary = data.subarray(0, 8192).includes(0)
    return { path: input, content: binary ? '' : data.toString('utf8'), hash: sha256(data), truncated: stat.size > bytesRead, ...(binary ? { binary: true } : {}) }
  } finally { await handle.close() }
}

export async function readMedia(context: HostContext, input: string): Promise<{ dataUrl: string; mimeType: string }> {
  const target = await containedPath(context.cwd, input)
  const stat = await fs.stat(target)
  if (!stat.isFile() || stat.size > 12 * 1024 * 1024) throw new Error('Image preview supports regular files up to 12 MB.')
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  let data: Buffer
  try { data = await handle.readFile() } finally { await handle.close() }
  if (data.length > 12 * 1024 * 1024) throw new Error('Image exceeds 12 MB.')
  let mimeType: string | undefined
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mimeType = 'image/png'
  else if (data[0] === 255 && data[1] === 216 && data[2] === 255) mimeType = 'image/jpeg'
  else if (['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) mimeType = 'image/gif'
  else if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') mimeType = 'image/webp'
  else if (data.subarray(4, 12).toString('ascii') === 'ftypavif') mimeType = 'image/avif'
  if (!mimeType) throw new Error('Image preview supports PNG, JPEG, GIF, WebP and AVIF. SVG and other active formats open as source text.')
  return { dataUrl: `data:${mimeType};base64,${data.toString('base64')}`, mimeType }
}

export interface FileWriteOptions { expectedAbsent?: boolean; mode?: number; expectedMode?: number }
export async function withFileWriteLock<T>(context: HostContext, input: string, operation: (target: string) => Promise<T>): Promise<T> {
  writable(context)
  const target = await containedPath(context.cwd, input, true)
  const previous = fileWrites.get(target)
  let release!: () => void
  const lock = new Promise<void>(resolve => { release = resolve })
  fileWrites.set(target, lock)
  await previous
  try {
    if (await containedPath(context.cwd, input, true) !== target) throw new Error('The file path changed while waiting to save. Reload before saving.')
    return await operation(target)
  } finally { release(); if (fileWrites.get(target) === lock) fileWrites.delete(target) }
}

export async function writeFile(context: HostContext, input: string, content: string, expectedHash?: string, options: FileWriteOptions = {}): Promise<{ ok: true; hash: string }> {
  return withFileWriteLock(context, input, () => writeFileUnlocked(context, input, content, expectedHash, options))
}

async function writeFileUnlocked(context: HostContext, input: string, content: string, expectedHash?: string, options: FileWriteOptions = {}): Promise<{ ok: true; hash: string }> {
  writable(context)
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_FILE) throw new Error('File content must be text under 4 MB.')
  if (input.split(/[\\/]/).includes('.git')) throw new Error('Use Git commands to change repository metadata.')
  const target = await containedPath(context.cwd, input, true)
  if (path.relative(await fs.realpath(context.cwd), target).split(path.sep).includes('.git')) throw new Error('Use Git commands to change repository metadata.')
  if (options.mode !== undefined && (!Number.isInteger(options.mode) || options.mode < 0 || options.mode > 0o777)) throw new Error('Invalid file permissions.')
  let mode = options.mode ?? 0o644
  try {
    if (!(await fs.stat(target)).isFile()) throw new Error('The selected path is not a regular file.')
    if (options.expectedAbsent) throw new Error('A file now exists at this path. Undo would overwrite newer work.')
    const current = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await current.stat()
      if (!stat.isFile()) throw new Error('The selected path is not a regular file.')
      if (stat.size > MAX_FILE) throw new Error('This file is too large for the editor.')
      if (options.expectedMode !== undefined && (stat.mode & 0o777) !== options.expectedMode) throw new Error('File permissions changed on disk. Reload before saving.')
      mode = options.mode ?? stat.mode & 0o777
      if (expectedHash && sha256(await current.readFile()) !== expectedHash) throw new Error('The file changed on disk. Reload it before saving to avoid overwriting those changes.')
    } finally { await current.close() }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (expectedHash) throw new Error('The file no longer exists. Reload before saving.')
  }
  await fs.mkdir(path.dirname(target), { recursive: true })
  // Revalidate after mkdir, so a newly encountered symlink cannot escape the workspace.
  const verified = await containedPath(context.cwd, input, true)
  if (verified !== target) throw new Error('The file path changed during the write. Try again.')
  const temporary = path.join(path.dirname(target), `.akorith-${randomUUID()}.tmp`)
  try {
    const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
    try { await handle.chmod(mode); await handle.writeFile(content, 'utf8'); await handle.sync() } finally { await handle.close() }
    if (expectedHash) {
      const latestPath = await containedPath(context.cwd, input)
      if (options.expectedMode !== undefined && ((await fs.stat(latestPath)).mode & 0o777) !== options.expectedMode) throw new Error('File permissions changed while saving. Reload before retrying.')
      const latest = await fs.readFile(latestPath)
      if (sha256(latest) !== expectedHash) throw new Error('The file changed on disk while saving. Reload it before retrying.')
    }
    if (options.expectedAbsent) {
      // Creating a hard link is atomic and refuses an occupied path; rename would overwrite it.
      try { await fs.link(temporary, target) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('A file appeared while restoring. Undo was cancelled to preserve newer work.'); throw error }
    } else await fs.rename(temporary, target)
    return { ok: true, hash: sha256(content) }
  } finally { await fs.unlink(temporary).catch(() => {}) }
}

export async function searchFiles(context: HostContext, query: string, maxResults = 80): Promise<{ results: Array<{ path: string; line: number; text: string }>; truncated: boolean }> {
  if (!query || query.length > 500) throw new Error('Provide a search string of 1–500 characters.')
  const results: Array<{ path: string; line: number; text: string }> = []
  const queue = ['.']; const seen = new Set<string>(); let inspected = 0; let truncated = false
  while (queue.length && results.length < maxResults && inspected < 5000) {
    const directory = queue.shift()!
    const canonical = await containedPath(context.cwd, directory)
    if (seen.has(canonical)) continue
    seen.add(canonical)
    for (const entry of await listFiles(context, directory)) {
      if (['node_modules', '.git', '.next', 'dist', 'out', '.venv', 'vendor'].includes(entry.name)) continue
      if (entry.directory) { queue.push(entry.path); continue }
      if ((entry.size ?? 0) > 512 * 1024) continue
      inspected++
      const file = await readFile(context, entry.path, 512 * 1024).catch(() => null)
      if (!file || file.binary) continue
      const lines = file.content.split('\n')
      for (let index = 0; index < lines.length; index++) {
        if (lines[index].toLocaleLowerCase().includes(query.toLocaleLowerCase())) results.push({ path: entry.path, line: index + 1, text: lines[index].slice(0, 500) })
        if (results.length >= maxResults) { truncated = true; break }
      }
      if (results.length >= maxResults) break
    }
  }
  return { results, truncated: truncated || queue.length > 0 }
}
