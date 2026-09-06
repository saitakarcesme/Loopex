import { createServer, type Server } from 'node:http'
import { createServer as createPortServer } from 'node:net'
import { spawnOwnedProcess, type OwnedProcess } from '../providers/process-owner'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import type { HostContext } from '../../shared/contracts'
import { containedPath, writable } from './files'
import { settleStages, settleWithin } from './lifecycle'

interface Preview { taskId: string; url: string; owner?: OwnedProcess; server?: Server; output: string; controller: AbortController; cleanup?: Promise<void>; stopping?: Promise<void> }
const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp4': 'video/mp4' }
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createPortServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { const port = (server.address() as { port: number }).port; server.close(error => error ? reject(error) : resolve(port)) })
  })
}
export class PreviewManager {
  private previews = new Map<string, Preview>()
  private starting = new Map<string, Promise<{ url: string }>>()
  private closing = false
  constructor(private emit: (event: Record<string, unknown>) => void) {}
  async start(context: HostContext, signal?: AbortSignal): Promise<{ url: string }> {
    writable(context)
    if (this.closing) throw new Error('Preview host is shutting down.')
    if (signal?.aborted) throw new Error('Preview stopped.')
    const pending = this.starting.get(context.taskId)
    if (pending) return pending
    const current = this.previews.get(context.taskId)
    if (current) {
      if (current.controller.signal.aborted) throw new Error('The previous preview has not stopped. Retry Stop before starting another.')
      return { url: current.url }
    }
    const preview: Preview = { taskId: context.taskId, url: '', output: '', controller: new AbortController() }
    this.previews.set(context.taskId, preview)
    const abort = () => { preview.controller.abort(); void this.stop(context.taskId).catch(error => this.emit({ type: 'preview:error', taskId: context.taskId, error: String(error) })) }
    signal?.addEventListener('abort', abort, { once: true })
    const promise = this.launch(context, preview).finally(() => { this.starting.delete(context.taskId); signal?.removeEventListener('abort', abort) })
    this.starting.set(context.taskId, promise)
    return promise
  }
  private async launch(context: HostContext, preview: Preview): Promise<{ url: string }> {
    const assertRunning = () => { if (this.closing || preview.controller.signal.aborted) throw new Error('Preview stopped.') }
    let url = ''
    try {
      const port = await freePort(); assertRunning(); url = `http://127.0.0.1:${port}`; preview.url = url
      let manifest: { scripts?: Record<string, string>; packageManager?: string } = {}
      try { manifest = JSON.parse(await fs.readFile(await containedPath(context.cwd, 'package.json'), 'utf8')) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      assertRunning()
      const scriptName = ['dev', 'start', 'serve'].find(name => manifest.scripts?.[name])
      const script = scriptName ? manifest.scripts![scriptName] : ''
      if (scriptName) {
        if (context.mode !== 'full') throw new Error('Running a project preview script requires Full access because its scripts and plugins are not OS-sandboxed. Static HTML preview works in Work mode; the provider can also start a server through its own sandboxed command tool.')
        let flags: string[]
        if (/\bnext\s+dev\b/.test(script)) flags = ['--hostname', '127.0.0.1', '--port', String(port)]
        else if (/\b(vite|astro)\b/.test(script)) flags = ['--host', '127.0.0.1', '--port', String(port)]
        else if (/\bhttp-server\b/.test(script)) flags = ['-a', '127.0.0.1', '-p', String(port)]
        else throw new Error('Automatic preview supports Vite, Next.js, Astro and static HTML projects. For this project, start the server in Terminal and paste its localhost URL in Browser.')
        const manager = manifest.packageManager?.split('@')[0] || (await fs.access(path.join(context.cwd, 'pnpm-lock.yaml')).then(() => 'pnpm', () => 'npm'))
        const command = ['pnpm', 'yarn', 'bun'].includes(manager) ? manager : 'npm'
        const args = command === 'npm' ? ['run', scriptName, '--', ...flags] : ['run', scriptName, ...flags]
        assertRunning()
        const owner = spawnOwnedProcess(command, args, { cwd: context.cwd, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), BROWSER: 'none', FORCE_COLOR: '0' } })
        preview.owner = owner
        const child = owner.child
        child.stdin.end()
        let launchError: Error | undefined
        child.once('error', error => { launchError = error })
        const capture = (chunk: Buffer) => {
          const data = chunk.toString('utf8'); preview.output = (preview.output + data).slice(-32 * 1024)
          this.emit({ type: 'preview:output', taskId: context.taskId, data: data.slice(-8192) })
        }
        child.stdout?.on('data', capture); child.stderr?.on('data', capture)
        child.once('exit', code => {
          this.emit({ type: 'preview:exit', taskId: context.taskId, code })
          if (!this.starting.has(context.taskId)) void this.stop(context.taskId).catch(error => this.emit({ type: 'preview:error', taskId: context.taskId, error: String(error) }))
        })
        const deadline = Date.now() + 30_000
        let ready = false
        while (Date.now() < deadline) {
          assertRunning()
          if (launchError) throw launchError
          if (child.exitCode !== null) throw new Error(`Preview server exited: ${preview.output.slice(-2000)}`)
          try { const response = await fetch(url, { signal: AbortSignal.timeout(800) }); await response.body?.cancel(); ready = true; break } catch {}
          await new Promise(resolve => setTimeout(resolve, 200))
        }
        if (!ready) throw new Error(`The preview server did not become ready within 30 seconds. ${preview.output.slice(-2000)}`)
      } else {
        await containedPath(context.cwd, 'index.html')
        assertRunning()
        const server = createServer(async (request, response) => {
          try {
            if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return }
            const pathname = decodeURIComponent(new URL(request.url || '/', url).pathname)
            if (pathname.split('/').some(segment => segment.startsWith('.'))) { response.writeHead(404).end('File not found'); return }
            let file = await containedPath(context.cwd, `.${pathname}`)
            if ((await fs.stat(file)).isDirectory()) file = await containedPath(context.cwd, path.join(file, 'index.html'))
            const stat = await fs.stat(file)
            if (!stat.isFile() || stat.size > 32 * 1024 * 1024) { response.writeHead(413).end(); return }
            const content = await fs.readFile(file)
            response.writeHead(200, { 'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
            response.end(request.method === 'HEAD' ? undefined : content)
          } catch { response.writeHead(404, { 'Content-Type': 'text/plain' }).end('File not found') }
        })
        preview.server = server
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
      }
      assertRunning()
      this.emit({ type: 'preview:ready', taskId: context.taskId, url })
      return { url }
    } catch (error) {
      preview.controller.abort()
      await this.stopResource(preview)
      if (this.previews.get(context.taskId) === preview) this.previews.delete(context.taskId)
      throw error
    }
  }
  private stopResource(preview: Preview): Promise<void> {
    if (preview.cleanup) return preview.cleanup
    const operation = (async () => {
      await settleStages([
        ['Preview process', async () => {
          if (!preview.owner) return
          await preview.owner.stop()
          preview.owner.child.stdin.destroy(); preview.owner.child.stdout.destroy(); preview.owner.child.stderr.destroy()
          preview.owner = undefined
        }],
        ['Preview HTTP server', async () => {
          const server = preview.server
          if (!server) return
          server.closeAllConnections()
          await settleWithin(new Promise<void>((resolve, reject) => server.close(error => {
            if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
            else resolve()
          })), 'Preview HTTP server')
          preview.server = undefined
        }]
      ], 5500)
    })()
    preview.cleanup = operation
    void operation.then(() => { preview.cleanup = undefined }, () => { preview.cleanup = undefined })
    return operation
  }
  stop(taskId: string): Promise<void> {
    const preview = this.previews.get(taskId)
    if (!preview) return Promise.resolve()
    if (preview.stopping) return preview.stopping
    preview.controller.abort()
    const operation = (async () => {
      const starting = this.starting.get(taskId)
      if (starting) await settleWithin(Promise.allSettled([starting]), 'Preview startup', 5500)
      await this.stopResource(preview)
      if (this.previews.get(taskId) === preview) this.previews.delete(taskId)
      this.emit({ type: 'preview:stopped', taskId })
    })()
    preview.stopping = operation
    void operation.catch(() => { preview.stopping = undefined })
    return operation
  }
  async dispose(): Promise<void> {
    this.closing = true
    for (const preview of this.previews.values()) preview.controller.abort()
    await settleStages([...this.previews.keys()].map(id => [`preview:${id}`, () => this.stop(id)]), 6000)
  }
}
