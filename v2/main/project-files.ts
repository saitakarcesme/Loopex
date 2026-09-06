import { constants } from 'node:fs'
import { opendir, realpath, lstat, open, mkdir } from 'node:fs/promises'
import { basename, extname, join, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { containedPath } from './host/files'
import type { Attachment } from '../shared/contracts'
import type { ProjectFileChoice } from '../shared/project-files'

const excluded = new Set(['node_modules', 'vendor', 'dist', 'build', 'out', 'coverage', 'target', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa'])
export function mentionPathAllowed(path: string): boolean {
  return !!path && !isAbsolute(path) && !path.includes('\\') && !/[\0-\x1f]/.test(path) && path.split('/').every(part =>
    !!part && !part.startsWith('.') && !excluded.has(part.toLowerCase()) &&
    !/(^|[-_.])(credentials?|secrets?|tokens?|passwords?)([-_.]|$)/i.test(part) &&
    !/\.(pem|key|p12|pfx|keystore|sqlite|sqlite3|db)$/i.test(part))
}
export async function searchProjectFiles(root: string, query: string): Promise<ProjectFileChoice[]> {
  if (typeof query !== 'string' || query.length > 200 || /[\0-\x1f\\]/.test(query) || query.startsWith('/') || query.split('/').some(part => part === '..')) throw new Error('Invalid project file search.')
  const canonical = await realpath(root), matches: ProjectFileChoice[] = []
  const pending = [{ path: '', depth: 0 }]; let scanned = 0, directories = 0
  while (pending.length && scanned < 5000 && directories < 250 && matches.length < 20) {
    const current = pending.shift()!; directories++
    const directory = await containedPath(canonical, current.path || '.')
    const entries = await opendir(directory)
    for await (const entry of entries) {
      if (++scanned > 5000 || matches.length >= 20) break
      const path = current.path ? `${current.path}/${entry.name}` : entry.name
      if (!mentionPathAllowed(path) || entry.isSymbolicLink()) continue
      if (entry.isDirectory() && current.depth < 8) pending.push({ path, depth: current.depth + 1 })
      if (entry.isFile() && path.toLowerCase().includes(query.toLowerCase())) {
        const info = await lstat(join(canonical, path)).catch(() => null)
        if (info?.isFile() && info.nlink === 1 && info.size <= 25 * 1024 * 1024) matches.push({ path, name: entry.name })
      }
    }
  }
  return matches.sort((a, b) => a.path.localeCompare(b.path))
}
export async function attachProjectFile(root: string, relative: string, userData: string, taskId: string): Promise<Attachment> {
  if (!mentionPathAllowed(relative)) throw new Error('This file cannot be mentioned. Choose a visible project file without credentials.')
  const canonical = await realpath(root)
  let current = canonical
  for (const segment of relative.split('/')) {
    current = join(current, segment)
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Symbolic links cannot be attached through project mentions.')
  }
  const source = await containedPath(canonical, relative)
  const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
  let content: Buffer
  try {
    const info = await handle.stat()
    const verified = await containedPath(canonical, relative)
    const pathInfo = await lstat(verified)
    if (await realpath(canonical) !== canonical || verified !== source || pathInfo.dev !== info.dev || pathInfo.ino !== info.ino) throw new Error('The project file changed location while attaching. Try again.')
    if (!info.isFile() || info.nlink !== 1 || info.size > 25 * 1024 * 1024) throw new Error('Choose a regular project file smaller than 25 MB.')
    content = Buffer.alloc(info.size)
    let offset = 0
    while (offset < content.length) { const result = await handle.read(content, offset, content.length-offset, offset); if (!result.bytesRead) break; offset += result.bytesRead }
    const after = await handle.stat()
    if (offset !== content.length || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('This file changed while attaching. Try again.')
  } finally { await handle.close() }
  const dir = join(userData, 'attachments', taskId); await mkdir(dir, { recursive: true })
  const id = randomUUID(), name = basename(relative), path = join(dir, `${id}-${name}`)
  const output = await open(path, 'wx', 0o600)
  try { await output.writeFile(content) } finally { await output.close() }
  const mime: Record<string, string> = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.pdf':'application/pdf', '.txt':'text/plain', '.md':'text/markdown' }
  return { id, name, path, size:content.length, mimeType:mime[extname(name).toLowerCase()] ?? 'application/octet-stream' }
}
