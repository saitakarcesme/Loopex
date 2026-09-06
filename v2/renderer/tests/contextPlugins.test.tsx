import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TurnContextRecord } from '../../shared/context-contracts'
import type { ManagedPlugin, PluginInspection, PluginVersion } from '../../shared/plugin-contracts'
import { ContextContent } from '../src/components/ContextDialog'
import { PluginCard, PluginCleanupReceipt, PluginInspectionContent } from '../src/components/settings/PluginsSettings'

const noop = () => {}
const context: TurnContextRecord = {
  manifest: {
    id: 'manifest', taskId: 'task', turnId: 'turn', providerId: 'codex', resolvedAt: 1000,
    selectionTiming: 'turn-start', fingerprint: 'a'.repeat(64), systemBytes: 37, systemSha256: 'b'.repeat(64),
    sources: [
      { id: 'instructions', kind: 'instructions', name: 'Project instructions', path: '/fixture/AGENTS.md', scope: 'project', projectId: 'project', state: 'truncated', includedBytes: 37, originalBytes: 80, reason: 'Instruction budget reached.', sha256: 'c'.repeat(64) },
      { id: 'skill', kind: 'skill', name: 'Unavailable skill', path: '/fixture/SKILL.md', scope: 'global', state: 'unavailable', includedBytes: 0, reason: 'Source is unavailable.' },
    ],
    mcpServers: [{ id: 'tools', name: 'Project tools', scope: 'project', projectId: 'project', state: 'configured' }],
    nativeInheritance: 'unknown', notes: ['Native instructions are recorded separately.'],
  },
  deliveries: [],
}
const version: PluginVersion = {
  pluginId: 'fixture', version: '1.0.0', digest: 'a'.repeat(64), rootPath: '/managed/fixture/v1', sourcePath: '/source/fixture',
  importedAt: 1000, state: 'ready', resolvedMcpServers: [], files: [],
  manifest: { schemaVersion: 1, id: 'fixture', name: 'Fixture plugin', version: '1.0.0', skills: [], mcpServers: [], assets: [] },
}
const plugin: ManagedPlugin = { id: 'fixture', name: 'Fixture plugin', enabled: false, selectedDigest: null, removed: false, revision: 1, versions: [version] }

test('context preview separates prepared sources from transport and unknown native inheritance', () => {
  const html = renderToStaticMarkup(<ContextContent record={context} preview />)
  assert.match(html, /Current preparation preview/)
  assert.match(html, /Queued turns resolve their context when they start/)
  assert.match(html, /Nothing is submitted by opening this preview/)
  assert.match(html, />Truncated</)
  assert.match(html, />Unavailable</)
  assert.match(html, /37 bytes included of 80 bytes/)
  assert.match(html, /Configured servers are not proof of a successful connection/)
  assert.match(html, /Unknown. The native provider may load additional instructions/)
  assert.doesNotMatch(html, /Accepted by provider transport|Followed by the model/)
})

test('historical transport receipts preserve trimming evidence without implying model compliance', () => {
  const record: TurnContextRecord = { ...context, deliveries: [{
    at: 1200, providerId: 'codex', stage: 'accepted', channel: 'native-prompt',
    systemBytes: 20, systemSha256: 'd'.repeat(64), contextTrimmed: true, configuredMcpIds: ['tools'],
  }] }
  const html = renderToStaticMarkup(<ContextContent record={record} preview={false} />)
  assert.match(html, /Saved turn record/)
  assert.match(html, /Accepted by provider transport/)
  assert.match(html, /Context was trimmed for transport/)
  assert.match(html, /Delivery does not confirm that a model followed an instruction/)
  assert.match(html, /20 bytes/)
})

test('older or imported turns explicitly lack a context record instead of borrowing current settings', () => {
  const html = renderToStaticMarkup(<ContextContent record={null} preview={false} />)
  assert.match(html, /No saved context record/)
  assert.match(html, /Older or imported history cannot establish which instructions were delivered/)
  assert.doesNotMatch(html, /Prepared sources|Accepted by provider|No native provider inheritance/)
})

test('large source lists remain bounded while exposing a Show more control', () => {
  const record = { ...context, manifest: { ...context.manifest, sources: Array.from({ length: 100 }, (_, index) => ({ ...context.manifest.sources[0], id: `source-${index}` })) } }
  const html = renderToStaticMarkup(<ContextContent record={record} preview={false} />)
  assert.equal((html.match(/class="context-source"/g) ?? []).length, 40)
  assert.match(html, /Show more sources \(60\)/)
})

test('plugin inspection is metadata only and makes activation separate', () => {
  const inspection: PluginInspection = {
    sourcePath: '/fixture/<unsafe>', digest: 'e'.repeat(64), totalBytes: 10, files: [],
    manifest: { ...version.manifest, description: '<script>unsafe()</script>', mcpServers: [{ id: 'tool', name: 'Local tools', command: '/fixture/run', args: ['--fixture'] }] },
  }
  const html = renderToStaticMarkup(<PluginInspectionContent inspection={inspection} />)
  assert.match(html, /Activation is a separate action/)
  assert.match(html, /\/fixture\/run --fixture/)
  assert.match(html, /&lt;script&gt;/)
  assert.doesNotMatch(html, /<script|<iframe|href=/)
})

test('imported disabled versions require an explicit enable action; removed plugins cannot activate', () => {
  const html = renderToStaticMarkup(<PluginCard plugin={plugin} busy={false} onEnable={noop} onRemove={noop} />)
  assert.match(html, /Disabled · Global/)
  assert.match(html, />Enable selected version<\/button>/)
  assert.match(html, /This selected version is not active/)
  assert.doesNotMatch(html, />Disable plugin</)
  const removed = renderToStaticMarkup(<PluginCard plugin={{ ...plugin, removed: true }} busy={false} onEnable={noop} onRemove={noop} />)
  assert.match(removed, /Removed from configuration/)
  assert.doesNotMatch(removed, /<select|Enable selected version<\/button>/)
})

test('a live selected version can be disabled and cleanup retention never looks like removal', () => {
  const html = renderToStaticMarkup(<PluginCard plugin={{ ...plugin, enabled: true, selectedDigest: version.digest }} busy={false} onEnable={noop} onRemove={noop} />)
  assert.match(html, /Enabled · 1.0.0 · Global/)
  assert.match(html, />Disable plugin<\/button>/)
  assert.doesNotMatch(html, /Enable selected version<\/button>/)
  const cleanup = renderToStaticMarkup(<PluginCleanupReceipt results={[{ pluginId: 'fixture', version: '1.0.0', digest: version.digest, status: 'retained', reason: 'usage_unknown' }]} />)
  assert.match(cleanup, /Files retained/)
  assert.match(cleanup, /Version usage could not be established/)
  assert.doesNotMatch(cleanup, /Managed files removed|Recovery completed/)
})


test('unavailable plugin versions retain recovery controls without offering activation', () => {
  for (const versions of [[], [{ ...version, state: 'removed' as const }]]) {
    const html = renderToStaticMarkup(<PluginCard plugin={{ ...plugin, enabled: true, selectedDigest: version.digest, versions }} busy={false} onEnable={noop} onRemove={noop} />)
    assert.match(html, /No ready version is available/)
    assert.match(html, />Disable plugin<\/button>/)
    assert.match(html, /aria-label="Remove plugin Fixture plugin"/)
    assert.doesNotMatch(html, /<select|Activate selected version<\/button>|Enable selected version<\/button>/)
  }
})


test('MCP scope preserves missing project identity instead of implying global access', async () => {
  const { mcpScopeLabel } = await import('../src/components/settings/McpSettings')
  assert.equal(mcpScopeLabel({}, []), 'All projects')
  assert.equal(mcpScopeLabel({ projectId: 'present' }, [{ id: 'present', name: 'Workspace' }]), 'Workspace')
  assert.equal(mcpScopeLabel({ projectId: 'missing' }, []), 'Unavailable project (missing)')
})
