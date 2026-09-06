import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AppSnapshot } from '../../shared/contracts'
import type { ResearchDetail } from '../../main/research-types'
import type { BenchmarkRecord, BenchmarkVariant } from '../../main/benchmark-types'
import { ResearchStudyDetail, researchFormDefaults } from '../src/pages/ResearchPage'
import { BenchmarkComparison, benchmarkRunUnsupported, benchmarkMethodInput, benchmarkMethodSelection, benchmarkInitialVariants } from '../src/pages/BenchmarkPage'

const snapshot = { projects: [{ id: 'project', name: 'Fixture project', path: '/fixture', createdAt: 1 }] } as AppSnapshot
const noop = () => {}
const research: ResearchDetail = {
  study: { id: 'study', projectId: 'project', goal: 'Reduce build time', hypothesis: 'Cache parsing', metric: 'seconds', direction: 'minimize', evaluator: { command: 'node', args: ['measure.js'], timeoutMs: 1000 }, maxExperiments: 5, budgetMinutes: 10, providerId: 'codex', model: 'test', protocolHash: 'abc', evaluatorFileHashes: {}, initialCommit: 'fixture-sha', status: 'idle', elapsedMs: 0, createdAt: 1, updatedAt: 1 },
  experiments: [],
}
const variant: BenchmarkVariant = { id: 'a', label: 'A', providerId: 'codex', model: 'actual-catalog-model', effort: '', mode: 'work', method: { kind: 'default', allowedTools: [], mcpServerIds: [] }, taskId: null, turnId: null, status: 'not-started', startedAt: null, finishedAt: null, durationMs: null, timingSource: 'unavailable', usage: { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null, estimated: null }, output: '', execution: { toolScope: 'unverified', workspaceIsolation: 'unverified', notes: [] }, evidence: [], humanNotes: '' }
const benchmark: BenchmarkRecord = { schemaVersion: 1, id: 'benchmark', title: 'Compare implementations', prompt: 'Build a form', promptSha256: 'def', projectId: 'project', createdAt: 1, updatedAt: 1, humanNotes: '', variants: [variant, { ...variant, id: 'b', label: 'B' }] }
const renderResearch = (detail: ResearchDetail, busy: string | null = null) => renderToStaticMarkup(<ResearchStudyDetail detail={detail} snapshot={snapshot} busy={busy} onStart={noop} onStop={noop} onOpenTask={noop} onUpdated={noop} />)
const renderBenchmark = (record: BenchmarkRecord) => renderToStaticMarkup(<BenchmarkComparison record={record} busy={null} onStart={noop} onStop={noop} onOpenTask={noop} onUpdated={noop} onError={noop} />)

test('research distinguishes unmeasured baseline from a real zero and exposes evaluator provenance', () => {
  const empty = renderResearch(research)
  assert.match(empty, /Not measured/)
  assert.doesNotMatch(empty, /0%|winner|score/i)
  const measured: ResearchDetail = { ...research, experiments: [{ id: 'baseline', studyId: 'study', ordinal: 1, kind: 'baseline', hypothesis: 'Original', status: 'completed', decision: 'keep', startedAt: 1, measurement: { source: 'host-evaluator', command: 'node', args: ['measure.js'], cwd: '/fixture', startedAt: 1, durationMs: 12, exitCode: 0, stdout: '{"seconds":0}', stderr: '', stdoutSha256: 'sha', value: 0, timedOut: false, cancelled: false, protocolHash: 'abc' } }] }
  const html = renderResearch(measured)
  assert.match(html, /<dt>Baseline<\/dt><dd>0<\/dd>/)
  assert.match(html, /host-evaluator/)
  assert.match(html, /stdoutSha256/)
})

test('reopened running study has a usable stop control while start acknowledgement is pending', () => {
  const running = renderResearch({ ...research, study: { ...research.study, status: 'running' } }, 'research:start')
  assert.match(running, /<button class="secondary-button"><svg[^]*?Stop study<\/button>/)
  assert.doesNotMatch(running, /Run baseline and experiments<\/button>/)
  const stopping = renderResearch({ ...research, study: { ...research.study, status: 'stopping' } }, 'research:stop')
  assert.match(stopping, /<button class="secondary-button" disabled=""/)
})

test('native restricted methods cannot be run and actual output is escaped without a fabricated preview', () => {
  const restricted = { ...variant, method: { ...variant.method, kind: 'browser' as const }, output: '<script>private()</script>', status: 'completed' as const }
  assert.equal(benchmarkRunUnsupported(restricted), true)
  assert.equal(benchmarkRunUnsupported({ ...restricted, providerId: 'ollama' }), false)
  const html = renderBenchmark({ ...benchmark, variants: [restricted, benchmark.variants[1]] })
  assert.match(html, /cannot enforce/)
  assert.match(html, /class="primary-button" disabled=""/)
  assert.match(html, /&lt;script&gt;private\(\)&lt;\/script&gt;/)
  assert.doesNotMatch(html, /<script|<video|<img/)
})

test('missing benchmark measurements stay unknown while actual zero cost remains a measured value', () => {
  const empty = renderBenchmark(benchmark)
  assert.match(empty, /Not recorded/)
  assert.doesNotMatch(empty, /\$0\.0000|0%|\b100%/)
  const real = renderBenchmark({ ...benchmark, variants: [{ ...variant, durationMs: 1234, timingSource: 'engine-monotonic', usage: { ...variant.usage, totalTokens: 200, costUsd: 0 } }, benchmark.variants[1]] })
  assert.match(real, /1\.2 s/)
  assert.match(real, /\$0\.0000/)
  assert.match(real, /engine-monotonic/)
})

test('evidence renders metadata first and never embeds arbitrary local paths or inline media without a scoped read', () => {
  const html = renderBenchmark({ ...benchmark, variants: [{ ...variant, evidence: [{ id: 'video', kind: 'video', label: 'Actual recording', filename: '/fixture/example.mp4', origin: 'user-selected', bytes: 1234, sha256: 'verified', addedAt: 1, videoStartOffsetMs: null }] }, benchmark.variants[1]] })
  assert.match(html, /Actual recording/)
  assert.match(html, /run offset not recorded/)
  assert.match(html, /Added by a reviewer/)
  assert.doesNotMatch(html, /src=|file:\/\/|data:video/)
})

test('method presets submit exact tools without stale custom or MCP scope and computer visibly selects full access', () => {
  assert.deepEqual(benchmarkMethodInput('browser', 'files_write', 'private-server', '').allowedTools, ['browser_list', 'browser_open', 'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_key', 'browser_scroll', 'browser_screenshot'])
  assert.deepEqual(benchmarkMethodInput('computer', '', '', '').allowedTools, ['computer_state', 'computer_select', 'computer_snapshot', 'computer_capture', 'computer_click', 'computer_type', 'computer_key', 'computer_stop'])
  assert.deepEqual(benchmarkMethodSelection('computer'), { kind: 'computer', mode: 'full' })
  assert.deepEqual(benchmarkMethodSelection('browser'), { kind: 'browser' })
  assert.deepEqual(benchmarkMethodInput('custom', ' files_read\nfiles_write ', 'stale-server', '').allowedTools, ['files_read', 'files_write'])
  assert.deepEqual(benchmarkMethodInput('browser', '', 'stale-server', '').mcpServerIds, [])
  assert.deepEqual(benchmarkMethodInput('default', 'files_write', '', '').allowedTools, [])
})

test('sampled recording limits are displayed with actual evidence', () => {
  const html = renderBenchmark({ ...benchmark, variants: [{ ...variant, evidence: [{ id: 'v', kind: 'video', label: 'Recording', filename: 'recording.mp4', origin: 'engine-capture', bytes: 100, sha256: 'sha', addedAt: 1, videoStartOffsetMs: 0, recordingNote: 'Sampled task browser at roughly 1 Hz; not frame-accurate transitions.' }] }, benchmark.variants[1]] })
  assert.match(html, /Sampled task browser at roughly 1 Hz; not frame-accurate transitions/)
})

test('new lab forms default only to available actual models and a still-valid current project', () => {
  const actual = { ...snapshot, providers: [
    { id: 'claude', name: 'Disconnected', available: true, authenticated: false, models: [{ id: 'no', name: 'No' }] },
    { id: 'codex', name: 'Subscription', available: true, authenticated: true, models: [{ id: 'm1', name: 'First', efforts: ['high'] }, { id: 'm1', name: 'Duplicate' }, { id: 'm2', name: 'Second' }] },
  ] } as AppSnapshot
  assert.deepEqual(researchFormDefaults(actual, 'project'), { projectId: 'project', choice: 'codex:m1' })
  assert.equal(researchFormDefaults(actual, 'removed').projectId, '')
  const variants = benchmarkInitialVariants(actual)
  assert.deepEqual(variants.map(item => item.choice), ['codex:m1', 'codex:m2'])
  assert.equal(variants[0].label, 'First · Subscription')
  assert.equal(variants[0].effort, 'high')
  const none = { ...actual, providers: [] }
  assert.equal(researchFormDefaults(none).choice, '')
  assert.deepEqual(benchmarkInitialVariants(none).map(item => item.choice), ['', ''])
  const one = { ...actual, providers: [{ ...actual.providers[1], models: [actual.providers[1].models[0]] }] }
  assert.deepEqual(benchmarkInitialVariants(one).map(item => item.choice), ['codex:m1', ''])
})
