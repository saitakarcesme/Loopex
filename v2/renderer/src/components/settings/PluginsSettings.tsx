import { CircleAlert, FolderOpen, Package, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type {
  ManagedPlugin, PluginCleanupResult, PluginImportResult, PluginInspection,
  PluginRegistrySnapshot, PluginVersion,
} from '../../../../shared/plugin-contracts'
import { api, errorText } from '../../api'
import { EmptyState, IconButton, Spinner } from '../Primitives'
import type { SettingsSectionProps } from './types'

const cleanupReason: Record<NonNullable<PluginCleanupResult['reason']>, string> = {
  in_use: 'A turn is still using this version.',
  usage_unknown: 'Version usage could not be established.',
  usage_check_failed: 'The usage check failed.',
  ownership_unconfirmed: 'File ownership could not be confirmed.',
  cleanup_failed: 'File cleanup could not finish.',
  registered_version: 'This version is still registered.',
}

export function PluginInspectionContent({ inspection }: { inspection: PluginInspection }) {
  const [fileLimit, setFileLimit] = useState(60)
  const { manifest } = inspection
  return (
    <div className="plugin-inspection-content">
      <h4>{manifest.name} <span>{manifest.version}</span></h4>
      {manifest.description ? <p>{manifest.description}</p> : null}
      <p>{manifest.skills.length} skills · {manifest.mcpServers.length} local MCP servers · {manifest.assets.length} assets</p>
      <p className="settings-description">Import copies a verified package into Akorith. Activation is a separate action. MCP executables run on this Mac when enabled tools are used or tested.</p>
      <details><summary>Package identity</summary>
        <p>ID: <code>{manifest.id}</code></p><p>Selected folder: <code>{inspection.sourcePath}</code></p>
        <p>Content digest: <code>{inspection.digest}</code></p>
        <p>{inspection.totalBytes.toLocaleString()} bytes across {inspection.files.length} declared files.</p>
      </details>
      {manifest.skills.length ? <details><summary>Declared skills ({manifest.skills.length})</summary>
        <ul>{manifest.skills.map(skill => <li key={skill.id}>{skill.id}<code>{skill.path}</code></li>)}</ul>
      </details> : null}
      {manifest.mcpServers.length ? <details><summary>Declared MCP commands ({manifest.mcpServers.length})</summary>
        <ul>{manifest.mcpServers.map(server => <li key={server.id}><strong>{server.name}</strong><code>{[server.command, ...server.args].join(' ')}</code></li>)}</ul>
      </details> : null}
      <details><summary>Inspected files ({inspection.files.length})</summary>
        <ul className="plugin-file-list">{inspection.files.slice(0, fileLimit).map(file => <li key={file.path}><code>{file.path}</code><span>{file.bytes.toLocaleString()} bytes{file.executable ? ' · executable' : ''}</span><code>{file.sha256}</code></li>)}</ul>
        {inspection.files.length > fileLimit ? <button type="button" className="small-button" onClick={() => setFileLimit(value => value + 60)}>Show more files ({inspection.files.length - fileLimit})</button> : null}
      </details>
    </div>
  )
}

export function PluginCleanupReceipt({ results }: { results: PluginCleanupResult[] }) {
  return <section className="plugin-cleanup" aria-label="Plugin cleanup result">
    <h4>Managed file cleanup</h4>
    {!results.length ? <p>No unused files were reported for cleanup.</p> : <ul>{results.map((result, index) => <li key={`${result.digest}:${index}`}>
      <strong>{result.pluginId} · {result.version}</strong>
      <span>{result.status === 'retained' ? 'Files retained' : result.status === 'recovered' ? 'Recovery completed' : 'Managed files removed'}</span>
      {result.reason ? <p>{cleanupReason[result.reason]}</p> : null}
      {result.detail ? <p>{result.detail}</p> : null}
      <details><summary>Version identity</summary><code>{result.digest}</code>{result.operationId ? <code>{result.operationId}</code> : null}</details>
    </li>)}</ul>}
    <p className="settings-description">Retained versions can be cleaned up after their usage or ownership is resolved. Original source folders are not removed.</p>
  </section>
}

function VersionDetails({ version }: { version: PluginVersion }) {
  return <details className="plugin-version-detail"><summary>Version contents and origin</summary>
    <p>{version.manifest.skills.length} skills · {version.manifest.mcpServers.length} local MCP servers · {version.manifest.assets.length} assets</p>
    {version.manifest.description ? <p>{version.manifest.description}</p> : null}
    <p>Imported {new Date(version.importedAt).toLocaleString()}</p>
    <p>Source folder <code>{version.sourcePath}</code></p><p>Managed copy <code>{version.rootPath}</code></p>
    <p>Digest <code>{version.digest}</code></p>
    {version.resolvedMcpServers.length ? <details><summary>Resolved local commands</summary><ul>{version.resolvedMcpServers.map(server => <li key={server.id}>{server.name}<code>{[server.command, ...server.args].join(' ')}</code></li>)}</ul></details> : null}
  </details>
}

export function PluginCard({ plugin, busy, onEnable, onRemove }: {
  plugin: ManagedPlugin; busy: boolean
  onEnable: (pluginId: string, enabled: boolean, digest?: string) => void
  onRemove: (pluginId: string) => void
}) {
  const ready = plugin.versions.filter(version => version.state === 'ready').sort((a, b) => b.importedAt - a.importedAt)
  const [choice, setChoice] = useState(plugin.selectedDigest || ready[0]?.digest || '')
  const selected = ready.find(version => version.digest === choice) || ready.find(version => version.digest === plugin.selectedDigest) || ready[0]
  const activeVersion = plugin.versions.find(version => version.digest === plugin.selectedDigest)
  const selectedActive = plugin.enabled && selected?.digest === plugin.selectedDigest
  return <section className="mcp-card plugin-card" aria-label={`Plugin ${plugin.name}`}>
    <div className="mcp-card-heading"><Package size={18} /><div><h4>{plugin.name}</h4>
      <p>{plugin.removed ? 'Removed from configuration' : plugin.enabled ? `Enabled · ${activeVersion?.version || 'version unavailable'}` : 'Disabled'} · Global</p>
    </div></div>
    {ready.length && !plugin.removed ? <>
      <label className="field-label" htmlFor={`plugin-version-${plugin.id}`}>Version to use</label>
      <select id={`plugin-version-${plugin.id}`} aria-label={`${plugin.name} version`} value={selected?.digest || ''} disabled={busy} onChange={event => setChoice(event.target.value)}>
        {ready.map(version => <option key={version.digest} value={version.digest}>{version.version} · {version.digest.slice(0, 10)}</option>)}
      </select>
      {selected ? <VersionDetails version={selected} /> : null}
      {selected && !selectedActive ? <p className="settings-description">This selected version is not active. Choose {plugin.enabled ? 'Activate selected version' : 'Enable selected version'} to apply it to future turns.</p> : null}
    </> : <p className="settings-description">{plugin.removed
      ? 'Import this plugin again to use it. Any retained files remain tracked for safe cleanup.'
      : 'No ready version is available. You can still disable or remove this plugin, then import a valid package.'}</p>}
    <div className="mcp-actions">
      {!plugin.removed && selected && !selectedActive ? <button className="small-button" disabled={busy} onClick={() => onEnable(plugin.id, true, selected.digest)}>{plugin.enabled ? 'Activate selected version' : 'Enable selected version'}</button> : null}
      {plugin.enabled ? <button className="small-button" disabled={busy} onClick={() => onEnable(plugin.id, false)}>Disable plugin</button> : null}
      {!plugin.removed ? <IconButton label={`Remove plugin ${plugin.name}`} disabled={busy} onClick={() => onRemove(plugin.id)}><Trash2 size={14} /></IconButton> : null}
    </div>
  </section>
}

export function PluginsSettings({ onRefresh, onError }: SettingsSectionProps) {
  const [registry, setRegistry] = useState<PluginRegistrySnapshot | null>(null)
  const [inspection, setInspection] = useState<PluginInspection | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<PluginImportResult | null>(null)
  const [cleanup, setCleanup] = useState<PluginCleanupResult[] | null>(null)
  const [limit, setLimit] = useState(30)
  const mounted = useRef(false), busyRef = useRef(false), loadGeneration = useRef(0)
  useEffect(() => {
    mounted.current = true
    const generation = ++loadGeneration.current
    setBusy('Reading plugins')
    void api<PluginRegistrySnapshot>('plugins:list').then(result => {
      if (mounted.current && generation === loadGeneration.current) setRegistry(result)
    }).catch(error => {
      if (mounted.current && generation === loadGeneration.current) setFailure(errorText(error))
    }).finally(() => {
      if (mounted.current && generation === loadGeneration.current) setBusy(null)
    })
    return () => { mounted.current = false; loadGeneration.current++ }
  }, [])
  const retainConfirmedPlugin = (plugin: ManagedPlugin) => {
    if (!mounted.current) return
    setRegistry(current => current ? {
      ...current,
      plugins: current.plugins.some(item => item.id === plugin.id)
        ? current.plugins.map(item => item.id === plugin.id ? plugin : item)
        : [...current.plugins, plugin],
    } : current)
  }
  const refresh = async () => {
    const next = await api<PluginRegistrySnapshot>('plugins:list')
    if (mounted.current) setRegistry(next)
    await onRefresh()
  }
  const run = async (label: string, operation: () => Promise<void>) => {
    if (busyRef.current || busy) return
    busyRef.current = true
    setBusy(label); setFailure(null)
    try { await operation() }
    catch (error) {
      if (mounted.current) setFailure(errorText(error))
      else onError(error)
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(null)
    }
  }
  const inspect = () => void run('Inspecting local package', async () => {
    const folder = await api<{ path: string } | null>('plugins:pickLocal')
    if (!folder) return
    const next = await api<PluginInspection>('plugins:inspectLocal', { path: folder.path })
    if (mounted.current) { setInspection(next); setReceipt(null) }
  })
  const importPackage = () => {
    if (!inspection) return
    const selected = inspection
    void run('Importing inspected package', async () => {
      const result = await api<PluginImportResult>('plugins:importLocal', { path: selected.sourcePath, expectedDigest: selected.digest })
      retainConfirmedPlugin(result.plugin)
      if (mounted.current) { setReceipt(result); setInspection(null) }
      await refresh()
    })
  }
  const enable = (pluginId: string, enabled: boolean, digest?: string) => void run(enabled ? 'Applying selected version' : 'Disabling plugin', async () => {
    const plugin = await api<ManagedPlugin>('plugins:setEnabled', { pluginId, enabled, ...(digest ? { digest } : {}) })
    retainConfirmedPlugin(plugin)
    await refresh()
  })
  const remove = (pluginId: string) => void run('Removing plugin configuration', async () => {
    const result = await api<{ plugin: ManagedPlugin; cleanup: PluginCleanupResult[] }>('plugins:remove', { pluginId })
    retainConfirmedPlugin(result.plugin)
    if (mounted.current) setCleanup(result.cleanup)
    await refresh()
  })
  return <>
    <div className="settings-section-title with-action"><div><h3>Plugins</h3><p>Local skill and MCP packages managed by Akorith.</p></div>
      <button className="secondary-button" disabled={!!busy} onClick={inspect}><FolderOpen size={14} />Inspect local folder</button>
    </div>
    {busy ? <p className="plugin-operation" role="status"><Spinner size={13} />{busy}…</p> : null}
    {failure ? <div className="plugin-error" role="alert"><CircleAlert size={15} /><p>{failure}</p></div> : null}
    {receipt ? <section className="plugin-import-receipt" aria-label="Plugin import result"><strong>{receipt.imported ? 'Version imported' : 'Version already imported'}</strong>
      <p>{receipt.version.manifest.name} · {receipt.version.version}. Activation was not changed. Enable or switch versions separately below.</p>
    </section> : null}
    {inspection ? <section className="plugin-inspection" aria-label="Inspected local plugin">
      <PluginInspectionContent key={inspection.digest} inspection={inspection} />
      <div className="dialog-actions"><button className="secondary-button" disabled={!!busy} onClick={() => setInspection(null)}>Cancel inspection</button>
        <button className="primary-button" disabled={!!busy} onClick={importPackage}>Import without enabling</button></div>
    </section> : null}
    <div className="plugin-list-toolbar"><span>{registry ? `${registry.plugins.filter(plugin => !plugin.removed).length} registered plugins` : 'Plugin registry'}</span>
      <IconButton label="Refresh plugins" disabled={!!busy} onClick={() => void run('Reading plugins', refresh)}><RefreshCw size={14} /></IconButton>
    </div>
    {registry?.plugins.slice(0, limit).map(plugin => <PluginCard key={plugin.id} plugin={plugin} busy={!!busy} onEnable={enable} onRemove={remove} />)}
    {registry && registry.plugins.length > limit ? <button className="secondary-button load-more" onClick={() => setLimit(value => value + 30)}>Show more plugins ({registry.plugins.length - limit})</button> : null}
    {registry && !registry.plugins.length && !inspection ? <EmptyState icon={<Package size={28} />} title="Add a local plugin"><p>Inspect a package folder to review its skills and commands before importing it.</p></EmptyState> : null}
    {registry?.recovery.length ? <section className="plugin-recovery" aria-label="Plugin recovery records"><h4>Recovery records</h4>
      <p>These operations need inspection or another cleanup attempt.</p><ul>{registry.recovery.map(entry => <li key={entry.operationId}><strong>{entry.pluginId} · {entry.version}</strong><span>{entry.phase}</span>{entry.error ? <p>{entry.error}</p> : null}<details><summary>Operation identity</summary><code>{entry.operationId}</code><code>{entry.digest}</code></details></li>)}</ul>
    </section> : null}
    {cleanup ? <PluginCleanupReceipt results={cleanup} /> : null}
    <section className="settings-section"><div className="settings-row"><div><h4>Unused managed versions</h4><p>Clean up copies no longer registered or in use by a turn.</p></div>
      <button className="secondary-button" disabled={!!busy} onClick={() => void run('Checking unused versions', async () => {
        const result = await api<PluginCleanupResult[]>('plugins:collectUnused')
        if (mounted.current) setCleanup(result)
        await refresh()
      })}>Clean up unused versions</button></div></section>
    <p className="settings-bottom-note">Packages apply globally to future turns. Other apps’ plugin caches and original source folders are outside this manager.</p>
  </>
}
