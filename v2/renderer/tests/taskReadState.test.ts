import assert from 'node:assert/strict'
import test from 'node:test'
import type { PendingRequest, TaskDetail } from '../../shared/contracts'
import { mergeTaskRead } from '../src/hooks/taskReadState'

const prompt: PendingRequest = { id: 'approval', taskId: 'task', turnId: 'turn', kind: 'approval', title: 'Read file' }
const old: TaskDetail = {
  task: { id: 'task', projectId: null, title: 'Task', providerId: 'codex', model: 'fixture', effort: '', mode: 'work', status: 'running', pinned: false, archived: false, draft: '', createdAt: 1, updatedAt: 1, nativeSessions: {} },
  messages: [{ id: 'response', taskId: 'task', turnId: 'turn', role: 'assistant', content: 'First', status: 'running', createdAt: 1, activities: [] }],
  pending: [prompt],
}

test('a stale read cannot resurrect an acknowledged approval while preserving streamed content', () => {
  const current = { ...old, messages: [{ ...old.messages[0], content: 'First and latest' }], pending: [] }
  const result = mergeTaskRead(current, old, true, [], new Set(['approval']))
  assert.deepEqual(result.pending, [])
  assert.equal(result.messages[0].content, 'First and latest')
})

test('full read removes expired prompts despite unrelated concurrent message updates', () => {
  const result = mergeTaskRead(old, { ...old, pending: [] }, true, [], new Set())
  assert.deepEqual(result.pending, [])
})

test('new prompt events after a read began survive its stale pending snapshot without duplication', () => {
  const latest = { ...prompt, id: 'new', title: 'New operation' }
  const result = mergeTaskRead(old, { ...old, pending: [] }, true, [latest], new Set())
  assert.deepEqual(result.pending, [latest])
  const dedup = mergeTaskRead(old, { ...old, pending: [latest] }, true, [{ ...latest, detail: 'Current detail' }], new Set())
  assert.equal(dedup.pending.length, 1)
  assert.equal(dedup.pending[0].detail, 'Current detail')
})

test('answered request exclusion also applies when no task was loaded or stream update occurred', () => {
  assert.deepEqual(mergeTaskRead(undefined, old, false, [prompt], new Set(['approval'])).pending, [])
})
