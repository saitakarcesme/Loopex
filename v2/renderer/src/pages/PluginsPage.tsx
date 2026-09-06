import { Blocks, Search, Plus, Check, ArrowUpRight, FolderOpen, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ManagedPlugin, PluginRegistrySnapshot, PluginInspection, PluginImportResult } from '../../../shared/plugin-contracts'
import { api } from '../api'
import { Dialog, Spinner } from '../components/Primitives'

export function PluginsPage({ onError, onRefresh }: { onError(error: unknown): void; onRefresh(): Promise<unknown> }) {
  const [plugins, setPlugins] = useState<ManagedPlugin[]>([])
  const [query, setQuery] = useState(''), [filter, setFilter] = useState<'all' | 'enabled'>('all')
  const [selected, setSelected] = useState<string | null>(null), [inspection, setInspection] = useState<PluginInspection | null>(null)
  const [versionChoice, setVersionChoice] = useState<{ pluginId: string; digest: string } | null>(null)
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const mounted = useRef(true), locked = useRef(false)
  const refresh = async () => { const r = await api<PluginRegistrySnapshot>('plugins:list'); if (mounted.current) setPlugins(r.plugins.filter(p => !p.removed)) }
  useEffect(() => { mounted.current = true; void refresh().catch(e => { if (mounted.current) setError(String(e)) }).finally(() => { if (mounted.current) setLoading(false) }); return () => { mounted.current = false } }, [])
  const run = async (operation: () => Promise<void>) => {
    if (locked.current) return
    locked.current = true; setBusy(true); setError('')
    try { await operation(); await refresh(); await onRefresh() }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); else onError(e) }
    finally { locked.current = false; if (mounted.current) setBusy(false) }
  }
  const inspect = () => void run(async () => {
    const folder = await api<{path:string} | null>('plugins:pickLocal')
    if (folder) { const value = await api<PluginInspection>('plugins:inspectLocal', {path:folder.path}); if (mounted.current) setInspection(value) }
  })
  const plugin = plugins.find(p => p.id === selected)
  const version = (versionChoice?.pluginId === plugin?.id ? plugin?.versions.find(v => v.digest === versionChoice?.digest) : undefined) || plugin?.versions.find(v => v.digest === plugin.selectedDigest) || plugin?.versions.find(v => v.state === 'ready')
  const selectedVersionActive = !!plugin?.enabled && plugin.selectedDigest === version?.digest
  const activeVersion = plugin?.versions.find(v => v.digest === plugin.selectedDigest)?.version
  const visible = plugins.filter(p => (filter === 'all' || p.enabled) && `${p.name} ${p.versions[0]?.manifest.description || ''}`.toLowerCase().includes(query.toLowerCase()))
  return <section className="destination-page plugins-destination" aria-label="Plugins">
    <div className="destination-heading"><h1>Make Akorith work your way</h1><p>Bring your tools and skills into every conversation.</p></div>
    <div className="destination-toolbar"><label className="destination-search"><Search size={17}/><input aria-label="Search plugins" placeholder="Search plugins" value={query} onChange={e=>setQuery(e.target.value)}/>{query ? <button aria-label="Clear plugin search" onClick={()=>setQuery('')}><X size={14}/></button> : null}</label><button className="secondary-button" onClick={inspect} disabled={busy}><Plus size={16}/>Add plugin</button></div>
    <div className="destination-tabs" role="tablist" aria-label="Plugin filter"><button role="tab" aria-selected={filter === 'all'} onClick={()=>setFilter('all')}>Installed <span>{plugins.length}</span></button><button role="tab" aria-selected={filter === 'enabled'} onClick={()=>setFilter('enabled')}>Enabled</button></div>
    {error ? <p role="alert" className="destination-error">{error}<button onClick={()=>void run(refresh)}>Try again</button></p> : null}
    {loading ? <div className="destination-empty"><Spinner/><p>Loading plugins</p></div> : <div className="plugin-catalog">{visible.map(p => { const v = p.versions.find(v=>v.digest===p.selectedDigest)||p.versions[0]; return <button className="plugin-catalog-card" key={p.id} onClick={()=>{setVersionChoice(null);setSelected(p.id)}}><span className="catalog-icon"><Blocks size={24} strokeWidth={1.5}/></span><span><strong>{p.name}</strong><p>{v?.manifest.description || 'Skills and tools for your workspace.'}</p><small>{v?.manifest.skills.length || 0} skills · {v?.manifest.mcpServers.length || 0} tool servers</small></span><span className="catalog-state">{p.enabled ? <Check size={16}/> : <ArrowUpRight size={16}/>}</span></button> })}</div>}
    {!loading && !visible.length ? <div className="destination-empty"><Blocks size={30} strokeWidth={1.4}/><h2>{query ? 'No matching plugins' : 'Your next capability starts here'}</h2><p>{query ? 'Try another name or description.' : 'Add a local plugin to see its skills, tools and connection details.'}</p>{!query ? <button className="secondary-button" onClick={inspect} disabled={busy}><FolderOpen size={15}/>Choose plugin folder</button> : null}</div> : null}
    {plugin && version ? <Dialog title={plugin.name} onClose={()=>{if(!busy)setSelected(null)}} className="plugin-detail-dialog"><div className="plugin-detail-body"><span className="catalog-icon"><Blocks size={30}/></span><p>{version.manifest.description}</p><div className="plugin-detail-status"><span>{plugin.enabled ? `Enabled · ${activeVersion}` : 'Disabled'}</span><button className="primary-button" disabled={busy} onClick={()=>void run(async()=>{await api('plugins:setEnabled',{pluginId:plugin.id,enabled:!selectedVersionActive,...(!selectedVersionActive ? {digest:version.digest} : {})})})}>{busy ? 'Updating…' : selectedVersionActive ? 'Disable' : plugin.enabled ? 'Use this version' : 'Enable plugin'}</button></div><h3>Included skills</h3>{version.manifest.skills.length ? version.manifest.skills.map(s=><div className="plugin-capability" key={s.id}><Blocks size={16}/><span>{s.id}</span></div>) : <p>No skills declared.</p>}<h3>Connected tools</h3>{version.manifest.mcpServers.length ? version.manifest.mcpServers.map(s=><div className="plugin-capability" key={s.id}><span>{s.name}</span><small>Local MCP</small></div>) : <p>No tool servers declared.</p>}<label className="field-label">Installed version<select value={version.digest} disabled={busy} onChange={e=>setVersionChoice({pluginId:plugin.id,digest:e.target.value})}>{plugin.versions.filter(v=>v.state==='ready').map(v=><option key={v.digest} value={v.digest}>{v.version}</option>)}</select></label><details><summary>Technical details</summary><code>{plugin.id}</code><p>Applies to future turns. Active turns retain their original version.</p>{version.manifest.mcpServers.map(s=><pre key={s.id}>{[s.command,...s.args].join(' ')}</pre>)}</details></div></Dialog> : null}
    {inspection ? <Dialog title="Add plugin" onClose={()=>{if(!busy)setInspection(null)}}><div className="plugin-detail-body"><h2>{inspection.manifest.name}</h2><p>{inspection.manifest.description}</p><p>{inspection.manifest.version} · {inspection.manifest.skills.length} skills · {inspection.manifest.mcpServers.length} tool servers</p><p>The package is added disabled. Enable it when you are ready to use its tools.</p><details><summary>Review commands and files</summary>{inspection.manifest.mcpServers.map(s=><pre key={s.id}>{[s.command,...s.args].join(' ')}</pre>)}<p>{inspection.files.length} files · {inspection.totalBytes.toLocaleString()} bytes</p></details><div className="dialog-actions"><button className="secondary-button" disabled={busy} onClick={()=>setInspection(null)}>Cancel</button><button className="primary-button" disabled={busy} onClick={()=>void run(async()=>{const r=await api<PluginImportResult>('plugins:importLocal',{path:inspection.sourcePath,expectedDigest:inspection.digest});if(mounted.current){setInspection(null);setSelected(r.plugin.id)}})}>{busy ? 'Adding…' : 'Add plugin'}</button></div></div></Dialog> : null}
  </section>
}
