import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Engine, type RunLifecycleHooks } from '../main/engine'
import { Store } from '../main/storage'
import type { ProviderAdapter, ProviderEvent, RunRequest } from '../shared/contracts'

async function until(check: () => boolean) {
  const deadline = Date.now() + 2000
  while (!check()) { if (Date.now() > deadline) throw new Error('Condition did not settle'); await new Promise(resolve => setTimeout(resolve, 5)) }
}
function fixture(t: any, options: { dispose?: () => Promise<void>; runDispose?: () => Promise<void>; lifecycle?: RunLifecycleHooks } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'akorith-integration-review-')), path = join(dir, 'review.sqlite'), store = new Store(path)
  const runs: Array<{ request: RunRequest; emit: (event: ProviderEvent) => void; finish: () => void; fail: (error: Error) => void; interrupted: boolean }> = []
  const adapter = (id: ProviderAdapter['id']): ProviderAdapter => ({ id, discover: async () => { throw new Error('unused') }, dispose: async () => { await options.dispose?.(); for (const run of runs) run.finish() }, run(request, emit) {
    let finish!: () => void, fail!: (error: Error) => void
    const done = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject })
    const run = { request, emit, finish, fail, interrupted: false }; runs.push(run)
    return { done, dispose: options.runDispose, interrupt: async () => { run.interrupted = true }, steer: async text => { emit({ type: 'activity', activity: { id: 'guidance', kind: 'commentary', title: text, status: 'completed', startedAt: Date.now() } }) } }
  } })
  const engine = new Engine(store, [adapter('codex'), adapter('claude')], task => task.projectId ? store.project(task.projectId)!.path : join(dir, task.id), async () => '', () => {}, options.lifecycle)
  t.after(async () => { for (const run of runs) run.finish(); await engine.shutdown(); if (store.db.open) store.close(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, path, store, engine, runs }
}
test('stop acknowledgement cannot release the workspace before its previous writer is done', async t => {
  const f = fixture(t), project = f.store.addProject(f.dir, 'Shared'), first = f.store.createTask({ projectId: project.id }), second = f.store.createTask({ projectId: project.id })
  await f.engine.send(first.id, 'first', 'old writer'); await until(() => f.runs.length === 1)
  await f.engine.send(second.id, 'second', 'new writer')
  let stopped = false
  const stopping = f.engine.stop(first.id).then(() => { stopped = true })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(stopped, false)
  assert.equal(f.runs.length, 1, 'new writer must remain queued after an interrupt acknowledgement')
  f.runs[0].finish(); await stopping; await until(() => f.runs.length === 2)
  assert.equal(f.store.task(first.id).status, 'cancelled')
  assert.equal(f.runs[1].request.task.id, second.id)
})
test('ancestor and descendant project roots share the writer lease, but sibling projects do not', async t => {
  const f = fixture(t), parent = join(f.dir, 'repo'), child = join(parent, 'sub'), sibling = join(f.dir, 'repo-other')
  mkdirSync(child, { recursive: true }); mkdirSync(sibling)
  const tasks = [parent, child, sibling].map(path => f.store.createTask({ projectId: f.store.addProject(path, path).id }))
  await f.engine.send(tasks[0].id, 'parent', 'parent'); await until(() => f.runs.length === 1)
  await f.engine.send(tasks[1].id, 'child', 'child'); await f.engine.send(tasks[2].id, 'sibling', 'sibling')
  await until(() => f.runs.length === 2)
  assert.equal(f.runs.some(run => run.request.task.id === tasks[1].id), false)
  f.runs[0].finish(); await until(() => f.runs.length === 3)
  assert.equal(f.runs[2].request.task.id, tasks[1].id)
})
test('failed process termination keeps the lease until a later disposal confirms quiescence', async t => {
  const unsafe = new Error('Process is still alive'); unsafe.name = 'ProviderQuiescenceError'
  let canDispose = false
  const f = fixture(t, { dispose: async () => { if (!canDispose) throw unsafe } }), project = f.store.addProject(f.dir, 'Shared')
  const first = f.store.createTask({ projectId: project.id }), second = f.store.createTask({ projectId: project.id })
  try {
    await f.engine.send(first.id, 'first', 'old writer'); await until(() => f.runs.length === 1)
    f.runs[0].fail(unsafe); await until(() => f.store.task(first.id).status === 'cancelling')
    await f.engine.send(second.id, 'second', 'new writer')
    await assert.rejects(f.engine.stop(first.id), /still alive/)
    assert.equal(f.runs.length, 1)
    canDispose = true
    await f.engine.stop(first.id); await until(() => f.runs.length === 2)
    assert.equal(f.runs[1].request.task.id, second.id)
  } finally { canDispose = true }
})
test('cleanup retry preserves completed native output and usage without disposing unrelated runs', async t => {
  let safe = false, globalDisposals = 0
  const cleanupError = Object.assign(new Error('Connection cleanup is unconfirmed'), { name: 'ProviderQuiescenceError', nativeOutcome: { status: 'completed' } })
  const f = fixture(t, { dispose: async () => { globalDisposals++ }, runDispose: async () => { if (!safe) throw cleanupError } })
  const shared = join(f.dir, 'shared'); mkdirSync(shared)
  const project = f.store.addProject(shared, 'Shared'), first = f.store.createTask({ projectId: project.id }), queued = f.store.createTask({ projectId: project.id })
  const other = f.store.createTask()
  try {
    await f.engine.send(first.id, 'first', 'finish then cleanup'); await until(() => f.runs.length === 1)
    await f.engine.send(other.id, 'other', 'independent run'); await until(() => f.runs.length === 2)
    f.runs[0].emit({ type: 'final', text: 'Completed native response — İstanbul' })
    f.runs[0].emit({ type: 'usage', usage: { inputTokens: 12, outputTokens: 8 } })
    f.runs[0].fail(cleanupError); await until(() => f.store.task(first.id).status === 'cancelling')
    await f.engine.send(queued.id, 'queued', 'next writer')
    assert.equal(f.engine.workspaceBusy(f.dir), true)
    await assert.rejects(f.engine.stop(first.id), /unconfirmed/)
    assert.equal(globalDisposals, 0)
    assert.equal(f.runs.length, 2)
    assert.equal(f.runs[1].interrupted, false)
    safe = true
    await f.engine.stop(first.id); await until(() => f.runs.length === 3)
    const response = f.store.messages(first.id)[1]
    assert.equal(response.status, 'completed')
    assert.equal(response.content, 'Completed native response — İstanbul')
    assert.deepEqual(response.usage, { inputTokens: 12, outputTokens: 8 })
    assert.equal(f.store.task(first.id).status, 'completed')
    assert.equal(response.activities.find(a => a.id.startsWith('cleanup:'))?.status, 'completed')
    assert.equal(f.runs[2].request.task.id, queued.id)
    assert.equal(globalDisposals, 0)
    assert.equal(f.runs[1].interrupted, false)
  } finally { safe = true }
})
test('native failure survives a cleanup error and retry instead of becoming cancelled', async t => {
  const failure = new Error('Original native request failed')
  const cleanupError = Object.assign(new Error('Cleanup failed afterward'), { name: 'ProviderQuiescenceError', nativeOutcome: { status: 'failed', error: failure } })
  const f = fixture(t, { runDispose: async () => {} }), task = f.store.createTask()
  await f.engine.send(task.id, 'request', 'request'); await until(() => f.runs.length === 1)
  f.runs[0].emit({ type: 'delta', text: 'Partial native content' })
  f.runs[0].fail(cleanupError); await until(() => f.store.task(task.id).status === 'cancelling')
  await f.engine.stop(task.id)
  assert.equal(f.store.task(task.id).status, 'failed')
  const response = f.store.messages(task.id)[1]
  assert.equal(response.content, 'Partial native content')
  assert.equal(response.activities.find(a => a.title === 'The task could not finish')?.detail, failure.message)
})
test('late Stop does not relabel an already completed response as cancelled', async t => {
  const f = fixture(t), task = f.store.createTask()
  await f.engine.send(task.id, 'request', 'request'); await until(() => f.runs.length === 1)
  f.runs[0].emit({ type: 'final', text: 'Completed' }); f.runs[0].finish()
  await until(() => f.store.task(task.id).status === 'completed')
  await f.engine.stop(task.id)
  assert.equal(f.store.task(task.id).status, 'completed')
  assert.equal(f.store.messages(task.id)[1].status, 'completed')
})
test('submission receipt survives restart and cannot acknowledge another task or an unaccepted draft', t => {
  const f = fixture(t), first = f.store.createTask(), second = f.store.createTask()
  f.store.acceptTurn(first.id, 'accepted-before-renderer-ack', 'Submitted prompt', [])
  assert.deepEqual(f.store.submissionStatus(first.id, 'accepted-before-renderer-ack'), { accepted: true })
  assert.deepEqual(f.store.submissionStatus(second.id, 'accepted-before-renderer-ack'), { accepted: false })
  assert.deepEqual(f.store.submissionStatus(first.id, 'never-submitted'), { accepted: false })
  f.store.close()
  const reopened = new Store(f.path)
  try {
    assert.deepEqual(reopened.submissionStatus(first.id, 'accepted-before-renderer-ack'), { accepted: true })
    assert.equal(reopened.messages(first.id)[0].content, 'Submitted prompt')
    assert.equal(reopened.messages(first.id).length, 2)
  } finally { reopened.close() }
})
for (const action of ['stop', 'shutdown'] as const) {
  test(`${action} during successful cleanup preserves the already observed native result`, async t => {
    const f = fixture(t), task = f.store.createTask()
    await f.engine.send(task.id, 'request', 'request'); await until(() => f.runs.length === 1)
    f.runs[0].emit({ type: 'final', text: 'Finished before cleanup' })
    f.runs[0].emit({ type: 'usage', usage: { outputTokens: 9 } })
    f.runs[0].emit({ type: 'outcome', outcome: { status: 'completed' } })
    let stopped = false
    const stopping = (action === 'stop' ? f.engine.stop(task.id) : f.engine.shutdown()).then(() => { stopped = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(stopped, false, 'native completion alone does not certify cleanup')
    f.runs[0].finish(); await stopping
    assert.equal(f.store.task(task.id).status, 'completed')
    assert.equal(f.store.messages(task.id)[1].content, 'Finished before cleanup')
    assert.equal(f.store.messages(task.id)[1].usage?.outputTokens, 9)
  })
}
test('native failure observed before Stop is not changed into cancellation by clean delayed disposal', async t => {
  const f = fixture(t), task = f.store.createTask(), error = new Error('Native rejected request')
  await f.engine.send(task.id, 'request', 'request'); await until(() => f.runs.length === 1)
  f.runs[0].emit({ type: 'outcome', outcome: { status: 'failed', error } })
  const stopping = f.engine.stop(task.id)
  f.runs[0].fail(error); await stopping
  assert.equal(f.store.task(task.id).status, 'failed')
  assert.equal(f.store.messages(task.id)[1].activities.find(a => a.title === 'The task could not finish')?.detail, error.message)
})
test('failure recording cleanup cannot bypass the writer barrier or start queued work', async t => {
  let safe = false, failStorage = false
  const unsafe = Object.assign(new Error('Writer ownership is unconfirmed'), { name: 'ProviderQuiescenceError', nativeOutcome: { status: 'completed' } })
  const f = fixture(t, { runDispose: async () => { if (!safe) throw unsafe } })
  const project = f.store.addProject(f.dir, 'Shared'), first = f.store.createTask({ projectId: project.id }), second = f.store.createTask({ projectId: project.id })
  const setStatus = f.store.setTurnStatus.bind(f.store)
  f.store.setTurnStatus = (turnId, status) => { if (failStorage) throw new Error('Synthetic database write failure'); return setStatus(turnId, status) }
  try {
    await f.engine.send(first.id, 'first', 'first'); await until(() => f.runs.length === 1)
    await f.engine.send(second.id, 'second', 'queued writer')
    f.runs[0].emit({ type: 'final', text: 'Real completed output' })
    failStorage = true
    f.runs[0].fail(unsafe)
    await until(() => f.engine.diagnostics().active.some(run => run.cleanupPending))
    await assert.rejects(f.engine.stop(first.id), /unconfirmed/)
    assert.equal(f.engine.workspaceBusy(f.dir), true)
    assert.equal(f.runs.length, 1)
    failStorage = false; safe = true
    await f.engine.stop(first.id)
    assert.equal(f.engine.workspaceBusy(f.dir), false)
    assert.equal(f.engine.diagnostics().storageFault, true)
    assert.equal(f.runs.length, 1, 'new work remains paused after persistence failed')
    await assert.rejects(f.engine.send(second.id, 'third', 'more work'), /storage failed/i)
  } finally { failStorage = false; safe = true }
})
test('a provider final callback never throws a database error into the native event loop', async t => {
  const f = fixture(t), task = f.store.createTask()
  await f.engine.send(task.id, 'request', 'request'); await until(() => f.runs.length === 1)
  const save = f.store.saveMessage.bind(f.store)
  let fail = true
  f.store.saveMessage = message => { if (fail) throw new Error('Synthetic final write failure'); return save(message) }
  try {
    assert.doesNotThrow(() => f.runs[0].emit({ type: 'final', text: 'Native output' }))
    assert.equal(f.engine.diagnostics().storageFault, true)
    assert.equal(f.engine.diagnostics().active.length, 1)
    fail = false
    f.runs[0].emit({ type: 'outcome', outcome: { status: 'completed' } })
    f.runs[0].finish()
    await until(() => f.engine.diagnostics().active.length === 0)
    assert.equal(f.store.messages(task.id)[1].content, 'Native output')
  } finally { fail = false }
})
test('queue reorder preserves selected options and uses execution order for history and native handoff', async t => {
  const f = fixture(t), task = f.store.createTask({ model: 'A-model' })
  await f.engine.send(task.id, 'A', 'A prompt'); await until(() => f.runs.length === 1)
  f.runs[0].emit({ type: 'session', id: 'codex-native' })
  f.store.updateTask(task.id, { model: 'B-model', effort: 'low' })
  const b = await f.engine.send(task.id, 'B', 'B prompt')
  f.store.updateTask(task.id, { providerId: 'claude', model: 'C-model', effort: 'high', mode: 'full' })
  const c = await f.engine.send(task.id, 'C', 'C prompt')
  assert.throws(() => f.engine.reorderQueued(task.id, [c.turnId, c.turnId]), /exactly once/)
  assert.throws(() => f.engine.reorderQueued(task.id, [c.turnId]), /exactly once/)
  f.engine.reorderQueued(task.id, [c.turnId, b.turnId])
  assert.deepEqual(f.store.queued(task.id).map(turn => turn.id), [c.turnId, b.turnId])
  await f.engine.steer(task.id, 'Late A guidance')
  f.runs[0].emit({ type: 'final', text: 'A answer' }); f.runs[0].finish()
  await until(() => f.runs.length === 2)
  const cr = f.runs[1].request
  assert.equal(cr.prompt, 'C prompt'); assert.equal(cr.task.model, 'C-model'); assert.equal(cr.task.mode, 'full')
  assert.deepEqual(cr.history.map(message => message.content), ['A prompt', 'A answer', 'Late A guidance'])
  assert.doesNotMatch(cr.handoffContext!, /B prompt/)
  f.runs[1].emit({ type: 'session', id: 'claude-native' }); f.runs[1].emit({ type: 'final', text: 'C answer' }); f.runs[1].finish()
  await until(() => f.runs.length === 3)
  const br = f.runs[2].request
  assert.equal(br.prompt, 'B prompt'); assert.equal(br.task.model, 'B-model'); assert.equal(br.task.effort, 'low'); assert.equal(br.task.mode, 'work')
  assert.deepEqual(br.history.map(message => message.content), ['A prompt', 'A answer', 'Late A guidance', 'C prompt', 'C answer'])
  assert.match(br.handoffContext!, /C answer/); assert.doesNotMatch(br.handoffContext!, /A answer/)
  f.runs[2].emit({ type: 'session', id: 'codex-native' }); f.runs[2].emit({ type: 'final', text: 'B answer' }); f.runs[2].finish()
  await until(() => f.store.task(task.id).status === 'completed')
  assert.equal(f.store.turn(c.turnId).executionOrder, 2); assert.equal(f.store.turn(b.turnId).executionOrder, 3)
  await f.engine.shutdown(); f.store.close()
  const reopened = new Store(f.path)
  try {
    assert.deepEqual(reopened.messages(task.id).map(message => message.content), ['A prompt', 'A answer', 'Late A guidance', 'C prompt', 'C answer', 'B prompt', 'B answer'])
    reopened.updateTask(task.id, { providerId: 'claude' })
    const next = reopened.acceptTurn(task.id, 'D', 'D prompt', []).turn
    assert.match(reopened.continuity(next, reopened.historyBefore(next)), /B answer/)
    assert.doesNotMatch(reopened.continuity(next, reopened.historyBefore(next)), /C answer/)
  } finally { reopened.close() }
})
test('order migration preserves completed legacy turns and excludes never-run recovered queued prompts', t => {
  const f = fixture(t), task = f.store.createTask()
  const a = f.store.acceptTurn(task.id, 'A', 'completed old prompt', []).turn
  f.store.setTurnStatus(a.id, 'completed')
  const b = f.store.acceptTurn(task.id, 'B', 'never submitted queued prompt', []).turn
  for (const turn of [f.store.turn(a.id), f.store.turn(b.id)]) {
    delete turn.executionOrder; delete turn.queueOrder
    f.store.db.prepare('UPDATE turns SET data=? WHERE id=?').run(JSON.stringify(turn), turn.id)
  }
  f.store.db.pragma('user_version=1'); f.store.close()
  const reopened = new Store(f.path)
  try {
    assert.equal(reopened.turn(a.id).executionOrder, 1)
    assert.equal(reopened.turn(b.id).executionOrder, undefined)
    assert.equal(reopened.turn(b.id).status, 'interrupted')
    const next = reopened.acceptTurn(task.id, 'C', 'next', []).turn
    assert.deepEqual(reopened.historyBefore(next).filter(message => message.role === 'user').map(message => message.content), ['completed old prompt'])
  } finally { reopened.close() }
})
test('change tracking starts under the writer lease and finishes before the next writer begins', async t => {
  let releaseBefore!: () => void, releaseAfter!: () => void, beforeStarted = false, afterStarted = false
  const before = new Promise<void>(resolve => { releaseBefore = resolve }), after = new Promise<void>(resolve => { releaseAfter = resolve })
  const f = fixture(t, { lifecycle: {
    beforeRun: async () => { if (!beforeStarted) { beforeStarted = true; await before } },
    afterRun: async () => { if (!afterStarted) { afterStarted = true; await after }; return [{ id: 'tracked', kind: 'file', title: 'Changes captured', status: 'completed', startedAt: Date.now() }] },
  } })
  const project = f.store.addProject(f.dir, 'Shared'), first = f.store.createTask({ projectId: project.id }), second = f.store.createTask({ projectId: project.id })
  try {
    await f.engine.send(first.id, 'first', 'first'); await until(() => beforeStarted)
    await f.engine.send(second.id, 'second', 'second')
    assert.equal(f.runs.length, 0)
    releaseBefore(); await until(() => f.runs.length === 1)
    f.runs[0].emit({ type: 'final', text: 'Finished work' }); f.runs[0].finish()
    await until(() => afterStarted)
    assert.equal(f.runs.length, 1, 'checkpoint capture must retain the writer lease')
    releaseAfter(); await until(() => f.runs.length === 2)
    assert.equal(f.store.messages(first.id)[1].activities.find(activity => activity.id === 'tracked')?.title, 'Changes captured')
  } finally { releaseBefore(); releaseAfter() }
})
test('change tracking failures are visible without changing provider success, and Inspect skips hooks', async t => {
  let beforeCalls = 0, afterCalls = 0
  const f = fixture(t, { lifecycle: { beforeRun: async () => { beforeCalls++; throw new Error('checkpoint unavailable') }, afterRun: async () => { afterCalls++ } } })
  const task = f.store.createTask()
  await f.engine.send(task.id, 'work', 'work'); await until(() => f.runs.length === 1)
  f.runs[0].emit({ type: 'final', text: 'Actual answer' }); f.runs[0].finish()
  await until(() => f.store.task(task.id).status === 'completed')
  assert.equal(f.store.messages(task.id)[1].content, 'Actual answer')
  assert.equal(f.store.messages(task.id)[1].activities[0].title, 'Change tracking unavailable')
  assert.equal(afterCalls, 0)
  f.store.updateTask(task.id, { mode: 'read' })
  await f.engine.send(task.id, 'read', 'inspect'); await until(() => f.runs.length === 2)
  f.runs[1].emit({ type: 'final', text: 'Inspected' }); f.runs[1].finish()
  await until(() => f.store.task(task.id).status === 'completed')
  assert.equal(beforeCalls, 1); assert.equal(afterCalls, 0)
})
test('manual workspace operations hold an exclusive overlapping lease and restart queued work on release', async t => {
  const f = fixture(t), project = f.store.addProject(f.dir, 'Shared'), task = f.store.createTask({ projectId: project.id })
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const operation = f.engine.withWorkspaceLock(f.dir, async () => { await waiting; return 'restored' })
  try {
    assert.equal(f.engine.workspaceBusy(join(f.dir, 'child')), true)
    await assert.rejects(f.engine.withWorkspaceLock(join(f.dir, 'child'), async () => {}), /workspace is busy/)
    await f.engine.send(task.id, 'queued', 'run after restore')
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(f.runs.length, 0)
    release(); assert.equal(await operation, 'restored')
    await until(() => f.runs.length === 1)
    f.runs[0].finish(); await until(() => !f.engine.workspaceBusy(f.dir))
    await assert.rejects(f.engine.withWorkspaceLock(f.dir, async () => { throw new Error('restore failed') }), /restore failed/)
    assert.equal(f.engine.workspaceBusy(f.dir), false)
  } finally { release() }
})
