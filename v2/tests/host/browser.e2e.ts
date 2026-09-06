import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { BrowserManager } from '../../main/host/browser'
import { TerminalManager } from '../../main/host/terminal'
import type { HostContext } from '../../shared/contracts'

async function main(): Promise<void> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'akorith-browser-e2e-'))
  await fs.mkdir(path.join(base, 'data'))
  app.setPath('userData', path.join(base, 'data'))
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end(request.url === '/next' ? '<html><title>Next page</title><body><h1>Arrived</h1></body></html>' : `<html><title>Browser lab</title><body><h1>Host test</h1><label>Name <input id="name"></label><button id="go">Apply</button><p id="output">Waiting</p><a href="/next">Next page</a><script>document.querySelector('#go').onclick=()=>document.querySelector('#output').textContent='Hello '+document.querySelector('#name').value;</script></body></html>`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  await app.whenReady()
  const win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } })
  win.showInactive()
  const events: Record<string, unknown>[] = []
  const browsers = new BrowserManager(() => win, event => events.push(event))
  const terminalEvents: Record<string, unknown>[] = []
  const terminals = new TerminalManager(event => terminalEvents.push(event))
  const context: HostContext = { taskId: 'browser-test', cwd: base, mode: 'full' }
  try {
    const tab = await browsers.create(context, url)
    assert.equal(tab.title, 'Browser lab')
    browsers.attach(context.taskId, tab.id, { x: 0, y: 0, width: 1000, height: 700 }, true)
    const snapshot = await browsers.snapshot(context.taskId, tab.id) as any
    assert.match(snapshot.text, /Host test/)
    const input = snapshot.elements.find((e: any) => e.role === 'input')
    const button = snapshot.elements.find((e: any) => e.label === 'Apply')
    await browsers.type(context, input.ref, 'Akorith', tab.id)
    await browsers.click(context, button.ref, tab.id)
    await new Promise(resolve => setTimeout(resolve, 150))
    const after = await browsers.snapshot(context.taskId, tab.id) as any
    assert.match(after.text, /Hello Akorith/, JSON.stringify(after))
    await assert.rejects(browsers.click(context, button.ref, tab.id), /reference expired/)
    const screenshot = await browsers.screenshot(context.taskId, tab.id)
    assert.ok(screenshot.width > 500); assert.match(screenshot.dataUrl, /^data:image\/png;base64,/)
    await fs.writeFile(path.join(base, 'browser.png'), Buffer.from(screenshot.dataUrl.split(',')[1], 'base64'))
    await assert.rejects(browsers.snapshot('another-task', tab.id), /not found/)
    await assert.rejects(browsers.navigate(context.taskId, tab.id, 'file:///etc/passwd'), /only opens/)
    await assert.rejects(browsers.click({ ...context, mode: 'read' }, button.ref, tab.id), /Inspect mode/)
    const preferences = (browsers as any).tabs.get(tab.id).view.webContents.getLastWebPreferences()
    assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.preload, undefined)
    const link = after.elements.find((e: any) => e.label === 'Next page')
    await browsers.click(context, link.ref, tab.id)
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.match((await browsers.snapshot(context.taskId, tab.id) as any).text, /Arrived/)
    assert.equal(browsers.list(context.taskId)[0].canGoBack, true)
    browsers.hideAll()
    await browsers.navigate(context.taskId, tab.id, url)
    const hidden = await browsers.snapshot(context.taskId, tab.id) as any
    await browsers.type(context, hidden.elements.find((e: any) => e.role === 'input').ref, 'Hidden', tab.id)
    await browsers.click(context, hidden.elements.find((e: any) => e.label === 'Apply').ref, tab.id)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.match((await browsers.snapshot(context.taskId, tab.id) as any).text, /Hello Hidden/)
    const background = await browsers.create(context, url)
    const backgroundSnapshot = await browsers.snapshot(context.taskId, background.id) as any
    await browsers.type(context, backgroundSnapshot.elements.find((e: any) => e.role === 'input').ref, 'Background', background.id)
    await browsers.click(context, backgroundSnapshot.elements.find((e: any) => e.label === 'Apply').ref, background.id)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.match((await browsers.snapshot(context.taskId, background.id) as any).text, /Hello Background/)
    await assert.rejects(browsers.snapshot(context.taskId), /multiple browser tabs/)
    await browsers.close(context.taskId, background.id)
    await browsers.navigate(context.taskId, tab.id, 'https://example.com', AbortSignal.timeout(20_000))
    assert.match((await browsers.snapshot(context.taskId, tab.id) as any).text, /Example Domain/)
    const terminal = await terminals.create(context, 80, 24)
    terminals.write(context, terminal.id, "printf '__AKORITH_%s__\\n' PTY_WORKS\r")
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !terminalEvents.some(event => String(event.data).includes('__AKORITH_PTY_WORKS__'))) await new Promise(resolve => setTimeout(resolve, 50))
    assert.ok(terminalEvents.some(event => String(event.data).includes('__AKORITH_PTY_WORKS__')))
    assert.match(terminals.list(context.taskId)[0].output, /__AKORITH_PTY_WORKS__/)
    assert.throws(() => terminals.write({ ...context, taskId: 'other' }, terminal.id, 'bad'), /not found/)
    terminals.resize(context.taskId, terminal.id, 90, 30)
    await terminals.close(context.taskId, terminal.id)
    await browsers.close(context.taskId, tab.id)
    assert.equal(browsers.list(context.taskId).length, 0)
    console.log(JSON.stringify({ ok: true, httpsVerified: true, browserEvents: events.length, terminalEvents: terminalEvents.length, screenshot: path.join(base, 'browser.png') }))
  } finally {
    await Promise.all([terminals.dispose(), browsers.dispose()]); win.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
