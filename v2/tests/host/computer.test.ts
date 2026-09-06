import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ComputerManager } from '../../main/host/computer'
import { createHostTools } from '../../main/host'
import type { HostContext } from '../../shared/contracts'

test('emergency stop persists and rejects model re-selection until trusted UI resume; normal disposal does not pause', async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'akorith-computer-latch-test-'))
  const events: Record<string, unknown>[] = []
  const context: HostContext = { taskId: 'test', cwd: userData, mode: 'full' }
  const manager = new ComputerManager(userData, event => events.push(event))
  let calls = 0
  // This test exercises the host latch without invoking macOS or any real application.
  ;(manager as any).call = async (input: Record<string, unknown>) => { calls++; return input.action === 'state' ? { accessibility: true, screenRecording: true, apps: [] } : { bundleId: input.bundleId, name: 'Fixture', pid: 1 } }
  try {
    await manager.execute('select', { bundleId: 'fixture.app' }, context)
    assert.equal(calls, 1)
    manager.stop()
    assert.equal((await manager.state() as { paused?: boolean }).paused, true)
    const before = calls
    await assert.rejects(manager.execute('select', { bundleId: 'fixture.app' }, context), /paused by the user/)
    await assert.rejects(manager.execute('click', { x: 1, y: 1 }, context), /paused by the user/)
    await assert.rejects(manager.capture(), /paused/)
    assert.equal(calls, before)
    assert.equal(JSON.parse(await fs.readFile(path.join(userData, 'computer-control.json'), 'utf8')).paused, true)
    const restarted = new ComputerManager(userData, () => {})
    await assert.rejects(restarted.execute('select', { bundleId: 'fixture.app' }, context), /paused by the user/)
    await restarted.dispose()
    const host = createHostTools({ userData, getWindow: () => null, emit: event => events.push(event), getContext: () => context })
    assert.equal(host.definitions.some(tool => tool.name === 'computer_resume'), false)
    await assert.rejects(host.execute('computer_resume', {}, context), /Unknown host tool/)
    await assert.rejects(host.execute('computer_select', { bundleId: 'fixture.app' }, context), /paused by the user/)
    await host.invoke('computer:resume', {})
    assert.equal(JSON.parse(await fs.readFile(path.join(userData, 'computer-control.json'), 'utf8')).paused, false)
    await host.dispose()
    assert.equal(JSON.parse(await fs.readFile(path.join(userData, 'computer-control.json'), 'utf8')).paused, false)
    assert.ok(events.some(event => event.type === 'computer:stopped' && event.paused === true))
    assert.ok(events.some(event => event.type === 'computer:resumed' && event.paused === false))
  } finally { await manager.dispose(); await fs.rm(userData, { recursive: true, force: true }) }
})
