import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acknowledgeEditorSave,
  compareEditor,
  fileDraft,
  hasFileDraft,
  openEditor,
  resolveEditor,
  type OpenFile,
} from '../src/panels/fileEditorState'

const initial: OpenFile = {
  path: 'journey.md',
  content: 'original',
  hash: 'original-hash',
  truncated: false,
}
const external: OpenFile = { ...initial, content: 'external edit', hash: 'external-hash' }

test('a disk comparison preserves the draft and original write precondition', () => {
  const edited = {
    ...openEditor(initial, null),
    content: 'my edits',
    editing: true,
    needsComparison: true,
  }
  const compared = compareEditor(edited, external)
  assert.equal(compared.content, 'my edits')
  assert.equal(compared.base.hash, 'original-hash')
  assert.equal(compared.base.content, 'original')
  assert.equal(compared.disk?.content, 'external edit')
  assert.equal(compared.needsComparison, true)
  assert.deepEqual(fileDraft(compared), {
    content: 'my edits',
    baseContent: 'original',
    hash: 'original-hash',
  })
})

test('explicit draft resolution uses only the reviewed disk hash and keeps later typing', () => {
  const compared = compareEditor(
    { ...openEditor(initial, null), editing: true, content: 'my edits' },
    external,
  )
  const merged = { ...compared, content: 'my edits plus external edit' }
  const ready = resolveEditor(merged, 'keep-draft')
  assert.equal(ready.base.hash, external.hash)
  assert.equal(ready.content, merged.content)
  assert.equal(ready.disk, null)
  assert.equal(hasFileDraft(ready), true)
  assert.deepEqual(fileDraft(ready), {
    content: merged.content,
    baseContent: external.content,
    hash: external.hash,
  })
})

test('confirmed reload replaces the draft with the displayed disk version', () => {
  const compared = compareEditor(
    { ...openEditor(initial, null), editing: true, content: 'my edits' },
    external,
  )
  const reloaded = resolveEditor(compared, 'reload')
  assert.equal(reloaded.content, external.content)
  assert.equal(reloaded.base.hash, external.hash)
  assert.equal(fileDraft(reloaded), null)
  assert.equal(hasFileDraft(reloaded), false)
})

test('saving acknowledges the submitted version without clearing newer unsaved typing', () => {
  const state = { ...openEditor(initial, null), editing: true, content: 'typed while saving' }
  const next = acknowledgeEditorSave(state, 'submitted earlier', 'saved-hash')
  assert.equal(next.base.content, 'submitted earlier')
  assert.equal(next.content, 'typed while saving')
  assert.deepEqual(fileDraft(next), {
    content: 'typed while saving',
    baseContent: 'submitted earlier',
    hash: 'saved-hash',
  })
})

test('reopening a persisted draft after external change requires comparison', () => {
  const recovered = openEditor(external, {
    content: 'my edits',
    baseContent: initial.content,
    hash: initial.hash,
  })
  assert.equal(recovered.content, 'my edits')
  assert.equal(recovered.base.hash, initial.hash)
  assert.equal(recovered.needsComparison, true)
  assert.equal(openEditor(initial, { content: 'legacy draft without hash' }).needsComparison, true)
})

test('another file or incomplete/binary contents cannot become the save base', () => {
  const state = { ...openEditor(initial, null), editing: true, content: 'my edits' }
  assert.equal(compareEditor(state, { ...external, path: 'other.md' }), state)
  for (const disk of [
    { ...external, binary: true },
    { ...external, truncated: true },
    { ...external, hash: undefined },
  ]) {
    const compared = compareEditor(state, disk)
    assert.equal(resolveEditor(compared, 'keep-draft'), compared)
  }
})
