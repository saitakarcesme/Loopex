import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { runCommand } from '../../main/host/process'
import { PreviewManager } from '../../main/host/preview'
import { browserURL } from '../../main/host/browser'
import { createHostTools } from '../../main/host'
import type { HostContext } from '../../shared/contracts'

test('commands capture exit code and bounded output; cancellation kills descendants', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'akorith-process-test-'))
  try {
    const output = await runCommand('/bin/sh', ['-c', 'printf abc; printf error >&2; exit 7'], { cwd })
    assert.deepEqual(output, { stdout: 'abc', stderr: 'error', code: 7, truncated: false })
    const bounded = await runCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], { cwd, maxOutput: 1000 })
    assert.equal(bounded.stdout.length, 1000); assert.equal(bounded.truncated, true)
    const controller = new AbortController()
    const command = runCommand('/bin/sh', ['-c', '(sleep 1; touch marker) & wait'], { cwd, signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    await assert.rejects(command, /cancelled/)
    await new Promise(resolve => setTimeout(resolve, 1200))
    assert.equal(await fs.access(path.join(cwd, 'marker')).then(() => true, () => false), false)
  } finally { await fs.rm(cwd, { recursive: true, force: true }) }
})

test('managed static preview serves loopback, blocks traversal, secrets and links, and releases its server', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'akorith-preview-test-'))
  const cwd = path.join(base, 'project'); await fs.mkdir(cwd)
  const previews = new PreviewManager(() => {})
  try {
    await fs.writeFile(path.join(cwd, 'index.html'), '<h1>real preview</h1>')
    await fs.writeFile(path.join(cwd, '.env'), 'SECRET=fixture')
    await fs.writeFile(path.join(base, 'outside.txt'), 'outside')
    await fs.symlink(base, path.join(cwd, 'escape'))
    const context: HostContext = { cwd, taskId: 'preview-test', mode: 'work' }
    const [{ url }, again] = await Promise.all([previews.start(context), previews.start(context)])
    assert.equal(url, again.url); assert.match(url, /^http:\/\/127\.0\.0\.1:/)
    assert.equal(await fetch(url).then(response => response.text()), '<h1>real preview</h1>')
    for (const route of ['/..%2foutside.txt', '/escape/outside.txt', '/.env']) assert.equal((await fetch(url + route)).status, 404)
    await previews.stop(context.taskId)
    await assert.rejects(fetch(url))
  } finally { await previews.dispose(); await fs.rm(base, { recursive: true, force: true }) }
})

test('Work mode cannot launch project preview scripts or plugins with filesystem side effects', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'akorith-preview-boundary-test-'))
  const cwd = path.join(base, 'project'); await fs.mkdir(cwd)
  const previews = new PreviewManager(() => {})
  try {
    // If executed, this fixture would write outside the project but still inside our disposable test directory.
    await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { dev: 'node -e "require(\'fs\').writeFileSync(\'../outside.txt\',\'executed\')" # vite' } }))
    await assert.rejects(previews.start({ cwd, taskId: 'test', mode: 'work' }), /requires Full access/)
    await assert.rejects(fs.access(path.join(base, 'outside.txt')))
  } finally { await previews.dispose(); await fs.rm(base, { recursive: true, force: true }) }
})

test('browser URLs reject privileged protocols and accept general web plus localhost', () => {
  assert.equal(browserURL('example.com'), 'https://example.com/')
  assert.equal(browserURL('localhost:3000/path'), 'http://localhost:3000/path')
  assert.equal(browserURL('about:blank'), 'about:blank')
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'https://user:pass@example.com']) assert.throws(() => browserURL(url))
})

test('host IPC resolves task context and shell refuses work/read rather than claiming a sandbox', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'akorith-host-api-test-'))
  const context: HostContext = { cwd, taskId: 'allowed', mode: 'work' }
  const host = createHostTools({ userData: cwd, getWindow: () => null, emit: () => {}, getContext: id => { if (id !== 'allowed') throw new Error('Unknown task'); return context } })
  try {
    await assert.rejects(host.invoke('files:list', { taskId: 'other' }), /Unknown task/)
    await assert.rejects(host.execute('terminal_execute', { command: 'true' }, context), /requires Full access/)
    await host.invoke('files:write', { taskId: 'allowed', path: 'ok.txt', content: 'ok' })
    assert.equal((await host.invoke('files:read', { taskId: 'allowed', path: 'ok.txt' })).content, 'ok')
    await assert.rejects(host.execute('computer_click', { x: 0, y: 0 }, context), /Full access/)
    await assert.rejects(host.invoke('arbitrary:command', { taskId: 'allowed' }), /Unknown host command/)
    assert.equal((await host.execute('terminal_execute', { command: 'printf actual' }, { ...context, mode: 'full' }) as { stdout: string }).stdout, 'actual')
  } finally { await host.dispose(); await fs.rm(cwd, { recursive: true, force: true }) }
})

test('host model reads only this task’s explicitly attached files outside cwd; attachments remain read-only', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'akorith-attachments-test-'))
  const cwd = path.join(base, 'project'); const userData = path.join(base, 'data')
  const own = path.join(userData, 'attachments', 'allowed'); const other = path.join(userData, 'attachments', 'other')
  await Promise.all([fs.mkdir(cwd), fs.mkdir(own, { recursive: true }), fs.mkdir(other, { recursive: true })])
  const context: HostContext = { cwd, taskId: 'allowed', mode: 'work' }
  const host = createHostTools({ userData, getWindow: () => null, emit: () => {}, getContext: () => context })
  try {
    const attached = path.join(own, 'document.txt'); const unrelated = path.join(other, 'private.txt')
    await fs.writeFile(attached, 'selected attachment'); await fs.writeFile(unrelated, 'other task')
    assert.equal((await host.execute('files_read', { path: attached }, context) as { content: string }).content, 'selected attachment')
    await assert.rejects(host.execute('files_read', { path: unrelated }, context), /outside/)
    await fs.symlink(unrelated, path.join(own, 'escape.txt'))
    await assert.rejects(host.execute('files_read', { path: path.join(own, 'escape.txt') }, context), /outside/)
    await assert.rejects(host.execute('files_write', { path: attached, content: 'no' }, context), /outside/)
    await assert.rejects(host.invoke('files:read', { taskId: 'allowed', path: attached }), /outside/)
  } finally { await host.dispose(); await fs.rm(base, { recursive: true, force: true }) }
})

test('registered skill roots are read-only, task-scoped and cannot expose symlink targets outside the skill', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'akorith-skills-test-'))
  const cwd = path.join(base, 'project'); const selected = path.join(base, 'selected'); const disabled = path.join(base, 'disabled')
  await Promise.all([fs.mkdir(cwd), fs.mkdir(selected), fs.mkdir(disabled)])
  const context: HostContext = { cwd, taskId: 'task', mode: 'work' }
  const host = createHostTools({ userData: base, getWindow: () => null, emit: () => {}, getContext: () => context, getReadRoots: async taskId => taskId === 'task' ? [selected] : [] })
  try {
    await fs.writeFile(path.join(selected, 'reference.md'), 'enabled reference')
    await fs.writeFile(path.join(disabled, 'reference.md'), 'not enabled')
    assert.equal((await host.execute('files_read', { path: path.join(selected, 'reference.md') }, context) as { content: string }).content, 'enabled reference')
    await assert.rejects(host.execute('files_read', { path: path.join(selected, 'reference.md') }, { ...context, taskId: 'other' }), /outside/)
    await assert.rejects(host.execute('files_read', { path: path.join(disabled, 'reference.md') }, context), /outside/)
    await fs.symlink(disabled, path.join(selected, 'escape'))
    await assert.rejects(host.execute('files_read', { path: path.join(selected, 'escape/reference.md') }, context), /outside/)
    await assert.rejects(host.execute('files_write', { path: path.join(selected, 'reference.md'), content: 'no' }, context), /outside/)
  } finally { await host.dispose(); await fs.rm(base, { recursive: true, force: true }) }
})

test('process-backed Full preview starts a real owned server and concurrent Stop waits for its complete group once', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'akorith-preview-process-'))
  const events: Record<string, unknown>[] = []
  const previews = new PreviewManager(event => events.push(event))
  try {
    await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.cjs # vite' } }))
    await fs.writeFile(path.join(cwd, 'server.cjs'), `require('node:fs').writeFileSync('server.pid',String(process.pid));require('node:http').createServer((_q,r)=>r.end('owned server')).listen(Number(process.env.PORT),'127.0.0.1');`)
    const { url } = await previews.start({ cwd, taskId: 'owned-server', mode: 'full' })
    assert.equal(await fetch(url).then(response => response.text()), 'owned server')
    const pid = Number(await fs.readFile(path.join(cwd, 'server.pid'), 'utf8'))
    await Promise.all([previews.stop('owned-server'), previews.stop('owned-server')])
    assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH')
    await assert.rejects(fetch(url))
    assert.equal(events.filter(event => event.type === 'preview:stopped').length, 1)
  } finally { await previews.dispose(); await fs.rm(cwd, { recursive: true, force: true }) }
})
