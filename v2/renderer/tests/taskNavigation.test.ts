import assert from 'node:assert/strict'
import test from 'node:test'
import { navigationIndex, navigationShortcut, selectedTask, visitTask, type TaskNavigationState } from '../src/hooks/taskNavigationState'
import { BrowserAttachmentQueue } from '../src/panels/browserAttachmentQueue'

const empty: TaskNavigationState = { entries: [], index: -1 }
const available = new Set(['a', 'b', 'c', 'd'])
function move(state: TaskNavigationState, direction: -1 | 1) { return { ...state, index: navigationIndex(state, direction, available) } }

test('back and forward navigate visits without creating tasks or changing stored task data', () => {
  let state = visitTask(visitTask(visitTask(empty, 'a'), 'b'), 'c')
  state = move(state, -1)
  assert.equal(selectedTask(state), 'b')
  state = move(state, -1)
  assert.equal(selectedTask(state), 'a')
  assert.equal(navigationIndex(state, -1, available), state.index)
  state = move(state, 1)
  assert.equal(selectedTask(state), 'b')
  assert.deepEqual(state.entries, ['a', 'b', 'c'])
})

test('new selection after going back discards forward visits; reselecting current task does not', () => {
  const original = visitTask(visitTask(visitTask(empty, 'a'), 'b'), 'c')
  const back = move(original, -1)
  assert.equal(visitTask(back, 'b'), back)
  const branch = visitTask(back, 'd')
  assert.deepEqual(branch.entries, ['a', 'b', 'd'])
  assert.equal(navigationIndex(branch, 1, available), branch.index)
})

test('unavailable tasks are skipped, valid revisits remain, and history stays bounded', () => {
  const state = { entries: ['a', 'deleted', 'b', 'a', 'c'], index: 4 }
  assert.equal(navigationIndex(state, -1, new Set(['a', 'c'])), 3)
  assert.equal(navigationIndex({ ...state, index: 3 }, -1, new Set(['a', 'c'])), 0)
  let long = empty
  for (let index = 0; index < 150; index++) long = visitTask(long, String(index))
  assert.equal(long.entries.length, 100)
  assert.equal(selectedTask(long), '149')
  assert.deepEqual(visitTask(long, null), empty)
})

const key = (values: Partial<KeyboardEvent>) => ({ key: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, defaultPrevented: false, ...values })
test('history shortcuts respect composing, consumed keys and editor word navigation', () => {
  assert.equal(navigationShortcut(key({ key: '[', metaKey: true }), true), -1)
  assert.equal(navigationShortcut(key({ key: ']', metaKey: true }), false), 1)
  assert.equal(navigationShortcut(key({ key: 'ArrowLeft', altKey: true }), true), null)
  assert.equal(navigationShortcut(key({ key: 'ArrowRight', altKey: true }), false), 1)
  assert.equal(navigationShortcut(key({ key: '[', metaKey: true, isComposing: true }), false), null)
  assert.equal(navigationShortcut(key({ key: '[', metaKey: true, defaultPrevented: true }), false), null)
  assert.equal(navigationShortcut(key({ key: '[', metaKey: true, shiftKey: true }), false), null)
  assert.equal(navigationShortcut(key({ key: 'ArrowLeft' }), false), null)
})

test('native attachment hide barrier waits for preceding shows before geometry changes', async () => {
  const queue = new BrowserAttachmentQueue()
  const order: string[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const show = queue.enqueue(async () => { order.push('show started'); await gate; order.push('show acknowledged') })
  const hide = queue.enqueue(async () => { order.push('hide acknowledged') })
  const geometry = hide.then(() => { order.push('geometry changed') })
  await Promise.resolve()
  assert.deepEqual(order, ['show started'])
  release()
  await Promise.all([show, geometry])
  assert.deepEqual(order, ['show started', 'show acknowledged', 'hide acknowledged', 'geometry changed'])
})

test('a rejected native attachment does not poison later hide or restore operations', async () => {
  const queue = new BrowserAttachmentQueue()
  const failed = queue.enqueue(async () => { throw new Error('Closed tab') })
  const restored = queue.enqueue(async () => 'current bounds')
  await assert.rejects(failed, /Closed tab/)
  assert.equal(await restored, 'current bounds')
})
