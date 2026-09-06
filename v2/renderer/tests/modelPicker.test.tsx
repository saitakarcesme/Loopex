import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ProviderInfo, Task } from '../../shared/contracts'
import { ModelPicker } from '../src/components/ModelPicker'
import { modelChoices, modelSelectionPatch, providerAvailability } from '../src/components/modelPickerState'

const capabilities = { resume: true, steer: false, tools: true, approvals: true, images: false }
const providers: ProviderInfo[] = [
  { id: 'codex', name: 'Codex', available: true, authenticated: true, connectionLabel: 'Connected account', capabilities, models: [{ id: 'cloud-model', name: 'Cloud model', efforts: ['low', 'high'] }] },
  { id: 'ollama', name: 'Ollama', available: true, connectionLabel: 'Local endpoint', capabilities, models: [{ id: 'local-model', name: 'Local model' }] },
  { id: 'claude', name: 'Claude', available: true, authenticated: false, connectionLabel: 'Claude connection', capabilities, models: [{ id: 'sign-in-model', name: 'Sign in model' }] },
]
const task: Task = { id: 'task', projectId: null, title: 'Task', providerId: 'codex', model: 'cloud-model', effort: 'high', mode: 'work', status: 'idle', pinned: false, archived: false, draft: '', createdAt: 1, updatedAt: 1, nativeSessions: {} }

test('model search uses actual provider catalogs and connection labels, keeping unavailable choices disabled', () => {
  assert.deepEqual(modelChoices(providers, 'local endpoint').map(choice => choice.model.id), ['local-model'])
  assert.deepEqual(modelChoices(providers, 'Codex').map(choice => choice.model.id), ['cloud-model'])
  assert.equal(modelChoices(providers, 'sign in')[0].enabled, false)
  assert.deepEqual(modelChoices(providers, 'invented model'), [])
  assert.equal(providerAvailability(providers[2]), 'Sign in required')
})

test('selection changes connection and model together and only retains supported effort', () => {
  assert.deepEqual(modelSelectionPatch(providers, 'ollama', 'local-model', 'high'), { providerId: 'ollama', model: 'local-model', effort: '' })
  assert.deepEqual(modelSelectionPatch(providers, 'codex', 'cloud-model', 'low'), { providerId: 'codex', model: 'cloud-model', effort: 'low' })
  assert.deepEqual(modelSelectionPatch(providers, 'codex', 'cloud-model', 'obsolete'), { providerId: 'codex', model: 'cloud-model', effort: 'high' })
})

test('missing or unavailable catalog entries fail explicitly without substituting a model', () => {
  assert.throws(() => modelSelectionPatch(providers, 'codex', 'missing', 'high'), /no longer in/)
  assert.throws(() => modelSelectionPatch(providers, 'ollama', 'cloud-model', 'high'), /no longer in/)
  assert.throws(() => modelSelectionPatch(providers, 'claude', 'sign-in-model', ''), /not ready/)
  assert.throws(() => modelSelectionPatch([{ ...providers[0], available: false }], 'codex', 'cloud-model', ''), /not ready/)
})

test('duplicate native catalog rows do not create ambiguous picker options', () => {
  const duplicate = { ...providers[0], models: [...providers[0].models, ...providers[0].models] }
  assert.equal(modelChoices([duplicate], '').length, 1)
})

test('one compact trigger identifies both model and connection, and remains disabled during work', () => {
  const html = renderToStaticMarkup(<ModelPicker task={task} providers={providers} disabled onChoose={async () => {}} onConnections={() => {}} onOverlay={() => {}} onError={() => {}} />)
  assert.match(html, /Choose model and connection: Cloud model, Codex/)
  assert.match(html, /aria-haspopup="dialog"/)
  assert.match(html, /disabled=""/)
  assert.doesNotMatch(html, /<select/)
})

test('OpenCode trigger shortens only known provider suffix and preserves full accessible identity', async () => {
  const { modelTriggerLabel } = await import('../src/components/modelPickerState')
  assert.equal(modelTriggerLabel('opencode', 'Muse Spark 1.3 Free · OpenCode Zen'), 'Muse Spark 1.3 Free')
  assert.equal(modelTriggerLabel('opencode', 'Model · OpenCode Go'), 'Model')
  assert.equal(modelTriggerLabel('opencode', 'Model · Other router'), 'Model · Other router')
  assert.equal(modelTriggerLabel('codex', 'Model · OpenCode Zen'), 'Model · OpenCode Zen')
  const full = 'Muse Spark 1.3 Free · OpenCode Zen'
  const catalog: ProviderInfo[] = [{ ...providers[0], id: 'opencode', name: 'OpenCode', models: [{ id: 'opencode/muse', name: full }] }]
  const html = renderToStaticMarkup(<ModelPicker task={{ ...task, providerId: 'opencode', model: 'opencode/muse' }} providers={catalog} disabled={false} onChoose={async () => {}} onConnections={() => {}} onOverlay={() => {}} onError={() => {}} />)
  assert.ok(html.includes('<span>Muse Spark 1.3 Free</span>'))
  assert.ok(html.includes(`title="${full} · OpenCode"`)); assert.ok(html.includes(`aria-label="Choose model and connection: ${full}, OpenCode"`))
  assert.equal(catalog[0].models[0].id, 'opencode/muse'); assert.equal(catalog[0].models[0].name, full)
})
