import { app, BrowserWindow, nativeImage } from 'electron'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserManager } from '../../main/host/browser'

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'akorith-hidden-browser-e2e-'))
  await mkdir(join(directory, 'data'))
  app.setPath('userData', join(directory, 'data'))
  const server = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Hidden capture</title><style>html,body{margin:0;background:#d02020}div{position:absolute;left:100px;top:100px;width:150px;height:150px;background:#20b040}</style><div>Real fixture</div>') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  await app.whenReady()
  const win = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } })
  const manager = new BrowserManager(() => win, () => {})
  const context = { taskId: 'capture-fixture', cwd: directory, mode: 'full' as const }
  const results: Record<string, unknown>[] = []
  try {
    const tab = await manager.create(context, `http://127.0.0.1:${(server.address() as { port: number }).port}`)
    const owned = (manager as any).tabs.get(tab.id)
    assert.equal(owned.view.getVisible(), false)
    const originalBounds = owned.view.getBounds()
    manager.attach(context.taskId, tab.id, { x: 0, y: 0, width: 1, height: 1 }, false)
    assert.deepEqual(owned.view.getBounds(), originalBounds, 'hidden placeholder does not shrink real page')
    const result = await manager.screenshot(context.taskId, tab.id)
    const image = nativeImage.createFromDataURL(result.dataUrl)
    assert.ok(!image.isEmpty() && result.width > 500 && result.height > 400)
    const bytes = image.toBitmap(), scale = result.width / originalBounds.width
    const pixel = (x: number, y: number) => [...bytes.subarray((Math.round(y * scale) * result.width + Math.round(x * scale)) * 4, (Math.round(y * scale) * result.width + Math.round(x * scale)) * 4 + 4)]
    const red = pixel(20, 20), green = pixel(150, 150)
    assert.ok(red[2] > red[1] * 3, `Red fixture pixels missing: ${red}`)
    assert.ok(green[1] > green[2] * 3, `Green fixture pixels missing: ${green}`)
    assert.equal(owned.view.getVisible(), false)
    assert.deepEqual(owned.view.getBounds(), originalBounds)
    assert.equal(owned.attachedTo, win)
    assert.equal(BrowserWindow.getAllWindows().length, 1)
    await writeFile(join(directory, 'hidden.png'), image.toPNG())
    results.push({ check: 'hidden actual page capture', width: result.width, height: result.height, red, green })
    const abort = new AbortController(); abort.abort()
    await assert.rejects(manager.screenshot(context.taskId, tab.id, abort.signal), /cancelled/)
    await assert.rejects(manager.screenshot('different-task', tab.id), /not found/)
    const pending = manager.screenshot(context.taskId, tab.id)
    manager.attach(context.taskId, tab.id, { x: 10, y: 20, width: 700, height: 500 }, true)
    await pending
    assert.equal(owned.view.getVisible(), true)
    assert.deepEqual(owned.view.getBounds(), { x: 10, y: 20, width: 700, height: 500 })
    const cancel = new AbortController()
    const cancelled = manager.screenshot(context.taskId, tab.id, cancel.signal)
    cancel.abort()
    await assert.rejects(cancelled, /cancelled/)
    assert.equal(owned.attachedTo, win)
    assert.equal(BrowserWindow.getAllWindows().length, 1)
    const originalProtocol = (manager as any).protocol.bind(manager)
    ;(manager as any).protocol = async () => { throw new Error('Injected capture transport failure') }
    await assert.rejects(manager.screenshot(context.taskId, tab.id), /Injected capture transport failure/)
    assert.equal(owned.attachedTo, win)
    assert.equal(BrowserWindow.getAllWindows().length, 1)
    let entered!: () => void, releaseTransport!: (value: unknown) => void
    const transportEntered = new Promise<void>(resolve => { entered = resolve })
    ;(manager as any).protocol = async () => {
      entered()
      return new Promise(resolve => { releaseTransport = resolve })
    }
    const lateAbort = new AbortController()
    const delayed = manager.screenshot(context.taskId, tab.id, lateAbort.signal)
    await transportEntered
    assert.equal(owned.capture.window.isVisible(), false, 'capture owner is never shown')
    const nativePending = owned.capturePending
    manager.attach(context.taskId, tab.id, { x: 30, y: 40, width: 650, height: 450 }, true)
    manager.hideAll()
    lateAbort.abort()
    await assert.rejects(delayed, /cancelled/)
    assert.equal(owned.attachedTo, win)
    assert.deepEqual(owned.view.getBounds(), { x: 30, y: 40, width: 650, height: 450 })
    assert.equal(owned.view.getVisible(), false, 'task switch hide wins over original visible state')
    assert.equal(BrowserWindow.getAllWindows().length, 1)
    await assert.rejects(manager.screenshot(context.taskId, tab.id), /already being captured/)
    releaseTransport({ data: result.dataUrl.split(',')[1] })
    await nativePending
    await Promise.resolve()
    assert.equal(owned.view.getVisible(), false, 'late native completion never re-shows target')
    assert.deepEqual(owned.view.getBounds(), { x: 30, y: 40, width: 650, height: 450 })
    assert.equal(owned.capturePending, undefined)
    ;(manager as any).protocol = originalProtocol
    results.push({ check: 'post-reparent injected transport error/abort, hidden owner, latest attachment/hide, retained pending native read and no late view mutation', passed: true })
    const closingCapture = manager.screenshot(context.taskId, tab.id)
    const rejection = assert.rejects(closingCapture, /cancelled/)
    await manager.close(context.taskId, tab.id)
    await rejection
    assert.equal(manager.list(context.taskId).length, 0)
    results.push({ check: 'scope, cancellation, deferred latest attachment, concurrent close', passed: true })
  } finally {
    await manager.dispose()
    win.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  await writeFile(join(directory, 'receipt.json'), JSON.stringify({ electron: process.versions.electron, results }, null, 2))
  console.log(JSON.stringify({ directory, results }))
}
app.on('window-all-closed', () => {})
const watchdog = setTimeout(() => { console.error('Browser capture fixture deadline'); app.exit(2) }, 35000)
void main().then(() => { clearTimeout(watchdog); app.exit(0) }, error => { console.error(error); app.exit(1) })
