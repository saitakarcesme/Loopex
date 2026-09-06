import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { observeShellLifecycle, type ShellLifecycleEvent } from '../main/window-lifecycle'

test('main document reload hides surviving native views before a replacement document becomes ready', () => {
  const contents = new EventEmitter()
  let nativeViewVisible = true
  const events: ShellLifecycleEvent[] = []
  observeShellLifecycle(contents, () => { nativeViewVisible = false }, event => events.push(event))
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'file:///private/app' })
  assert.equal(nativeViewVisible, false)
  contents.emit('dom-ready')
  contents.emit('did-finish-load')
  assert.equal(nativeViewVisible, false, 'renderer must explicitly reattach at its new bounds')
  assert.deepEqual(events, [{ phase: 'navigation-started' }, { phase: 'dom-ready' }, { phase: 'load-finished' }])
})

test('subframe and same-document navigations do not hide the workspace browser', () => {
  const contents = new EventEmitter()
  let hides = 0
  const events: ShellLifecycleEvent[] = []
  observeShellLifecycle(contents, () => { hides++ }, event => events.push(event))
  contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
  contents.emit('did-fail-load', {}, -7, 'private description', 'https://private', false)
  assert.equal(hides, 0)
  assert.deepEqual(events, [])
})

test('main renderer failures hide views and record only static phases, numeric codes and allowlisted reasons', () => {
  const contents = new EventEmitter()
  let hides = 0
  const events: ShellLifecycleEvent[] = []
  observeShellLifecycle(contents, () => { hides++ }, event => events.push(event))
  contents.emit('did-fail-load', {}, -6, 'private description', 'file:///private?token=secret', true)
  contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 7 })
  contents.emit('render-process-gone', {}, { reason: 'secret unsupported reason', exitCode: 'secret' })
  assert.equal(hides, 3)
  assert.deepEqual(events, [{ phase: 'load-failed', code: -6 }, { phase: 'renderer-gone', reason: 'crashed', code: 7 }, { phase: 'renderer-gone', reason: 'unknown', code: undefined }])
  assert.doesNotMatch(JSON.stringify(events), /secret|private|file:|https:/)
})

test('hide failures remain bounded diagnostic events, with no reload retries; destruction unregisters observers', async () => {
  const contents = new EventEmitter()
  const events: ShellLifecycleEvent[] = []
  let calls = 0
  observeShellLifecycle(contents, async () => { calls++; throw new Error('private failure') }, event => events.push(event))
  contents.emit('destroyed')
  await Promise.resolve()
  assert.equal(calls, 1)
  assert.deepEqual(events, [{ phase: 'destroyed' }, { phase: 'browser-hide-failed' }])
  assert.equal(contents.eventNames().length, 0)
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  assert.equal(calls, 1)
})
