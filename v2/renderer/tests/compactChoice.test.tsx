import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { CompactChoice } from '../src/components/CompactChoice'
import { choiceKey, restoreChoiceFocus } from '../src/components/compactChoiceState'

const options = [{ value: 'low', label: 'Low' }, { value: 'old', label: 'Retired', disabled: true }, { value: 'high', label: 'High' }]
test('choice keyboard selection skips unavailable values and commits the actual highlighted value', () => {
  assert.deepEqual(choiceKey('ArrowDown', options, 'low'), { handled: true, value: 'high' })
  assert.deepEqual(choiceKey('ArrowDown', options, 'high'), { handled: true, value: 'low' })
  assert.deepEqual(choiceKey('ArrowUp', options, ''), { handled: true, value: 'high' })
  assert.deepEqual(choiceKey('Enter', options, 'high'), { handled: true, commit: 'high' })
  assert.deepEqual(choiceKey(' ', options, 'low'), { handled: true, commit: 'low' })
  assert.deepEqual(choiceKey('Enter', options, 'old'), { handled: true })
  assert.deepEqual(choiceKey('Home', options, 'high'), { handled: true, value: 'low' })
})
test('Escape closes without selecting; composing input and empty lists cannot select a fabricated value', () => {
  assert.deepEqual(choiceKey('Escape', options, 'high'), { handled: true, close: true })
  assert.deepEqual(choiceKey('Escape', options, 'high', true), { handled: false })
  assert.deepEqual(choiceKey('Enter', [], 'missing'), { handled: true })
  assert.deepEqual(choiceKey('Enter', options, 'high', true), { handled: false })
})
test('Escape and selection restore trigger focus; outside click and detached/disabled triggers do not steal focus', () => {
  const calls: unknown[] = [], trigger = { isConnected: true, disabled: false, focus: (options: unknown) => calls.push(options) }
  restoreChoiceFocus(trigger, 'escape'); restoreChoiceFocus(trigger, 'selection'); restoreChoiceFocus(trigger, 'tab')
  assert.equal(calls.length, 3); assert.ok(calls.every(call => (call as any).preventScroll))
  restoreChoiceFocus(trigger, 'outside'); restoreChoiceFocus({ ...trigger, isConnected: false }, 'escape'); restoreChoiceFocus({ ...trigger, disabled: true }, 'selection'); restoreChoiceFocus(null, 'escape')
  assert.equal(calls.length, 3)
})
test('custom composer choice exposes real selected label and keyboard popup semantics without a native select', () => {
  const html = renderToStaticMarkup(<CompactChoice label="Reasoning effort" value="high" options={options} disabled onChoose={async () => {}} onError={() => {}} onOverlay={() => {}} />)
  assert.match(html, /aria-label="Reasoning effort: High"/); assert.match(html, /aria-haspopup="listbox"/)
  assert.match(html, /aria-expanded="false"/); assert.match(html, /disabled=""/); assert.doesNotMatch(html, /<select/)
})
