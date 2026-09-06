import { BookOpen, CircleAlert, RefreshCw, ScrollText } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ContextSource, TurnContextManifest, TurnContextRecord } from '../../../shared/context-contracts'
import { api, errorText } from '../api'
import { Dialog, EmptyState, IconButton, Spinner } from './Primitives'

const bytes = (value: number) => `${value.toLocaleString()} bytes`
const sourceStates: Record<ContextSource['state'], string> = {
  included: 'Included', truncated: 'Truncated', omitted: 'Omitted', unavailable: 'Unavailable',
}

export function ContextContent({ record, preview }: { record: TurnContextRecord | null; preview: boolean }) {
  const [limit, setLimit] = useState(40)
  if (!record) return (
    <EmptyState icon={<ScrollText size={27} />} title="No saved context record">
      <p>This turn has no recorded context manifest. Older or imported history cannot establish which instructions were delivered.</p>
    </EmptyState>
  )
  const { manifest, deliveries } = record
  return (
    <>
      <div className="context-intro">
        <span className="context-kicker">{preview ? 'Current preparation preview' : 'Saved turn record'}</span>
        <h3>{preview ? 'What the next turn would receive' : 'What Akorith prepared for this turn'}</h3>
        <p>{preview
          ? 'This is a preview, not a delivery receipt. Queued turns resolve their context when they start.'
          : 'Prepared sources and transport receipts are recorded separately. Delivery does not confirm that a model followed an instruction.'}</p>
        <div className="context-facts">
          <span>{manifest.providerId}</span><span>{bytes(manifest.systemBytes)} prepared</span>
          <span>{new Date(manifest.resolvedAt).toLocaleString()}</span>
        </div>
        {manifest.session ? <p>Session: {manifest.session === 'renewed-for-context' ? 'New session for changed context' : manifest.session === 'resumed' ? 'Resumed' : 'New'}.</p> : null}
      </div>
      <section className="context-section" aria-label="Prepared sources">
        <h4>Instructions and skills <span>{manifest.sources.length}</span></h4>
        {!manifest.sources.length ? <p className="context-note">No Akorith-managed instruction or skill sources were included in this manifest.</p> : null}
        <div className="context-sources">
          {manifest.sources.slice(0, limit).map(source => (
            <details className="context-source" key={source.id}>
              <summary>
                {source.kind === 'skill' ? <BookOpen size={14} /> : <ScrollText size={14} />}
                <span className="context-source-name">{source.name}<small>{source.scope === 'project' ? 'Project' : 'Global'} · {source.kind === 'skill' ? 'Skill' : 'Instructions'}</small></span>
                <span className={`context-state ${source.state}`}>{sourceStates[source.state]}</span>
              </summary>
              <div className="context-source-detail">
                {source.reason ? <p>{source.reason}</p> : null}
                <p>{bytes(source.includedBytes)} included{source.originalBytes !== undefined ? ` of ${bytes(source.originalBytes)}` : ''}.</p>
                <code>{source.path}</code>
                {source.projectId ? <p>Project ID: <code>{source.projectId}</code></p> : null}
                {source.plugin ? <p>Plugin: {source.plugin.pluginId} · {source.plugin.version}<br /><code>{source.plugin.digest}</code></p> : null}
                {source.sha256 ? <p>Source SHA-256 <code>{source.sha256}</code></p> : null}
              </div>
            </details>
          ))}
        </div>
        {manifest.sources.length > limit ? <button className="small-button" onClick={() => setLimit(value => value + 40)}>Show more sources ({manifest.sources.length - limit})</button> : null}
      </section>
      <section className="context-section" aria-label="Configured MCP servers">
        <h4>MCP configuration <span>{manifest.mcpServers.length}</span></h4>
        <p className="context-note">Configured servers are not proof of a successful connection or tool call.</p>
        {manifest.mcpServers.length ? <ul className="context-mcp-list">
          {manifest.mcpServers.map(server => <li key={server.id}><span>{server.name}</span><small>{server.scope === 'project' ? 'Project' : 'Global'}{server.plugin ? ` · ${server.plugin.pluginId} ${server.plugin.version}` : ''}</small></li>)}
        </ul> : <p className="context-note">No MCP servers configured in this manifest.</p>}
      </section>
      <section className="context-section" aria-label="Context delivery receipts">
        <h4>Transport receipts <span>{deliveries.length}</span></h4>
        {preview ? <p className="context-note">Nothing is submitted by opening this preview.</p>
          : !deliveries.length ? <p className="context-note">No transport receipt was recorded. Prepared context alone does not establish delivery.</p> : null}
        {deliveries.map((delivery, index) => (
          <details className="context-delivery" key={`${delivery.at}:${index}`}>
            <summary><span>{delivery.stage === 'accepted' ? 'Accepted by provider transport' : 'Submitted to provider transport'}</span><small>{new Date(delivery.at).toLocaleTimeString()}</small></summary>
            <p>{delivery.providerId} · {delivery.channel} · {bytes(delivery.systemBytes)}</p>
            <p>{delivery.contextTrimmed ? 'Context was trimmed for transport.' : 'Transport did not report context trimming.'}</p>
            <p>Configured MCP IDs: {delivery.configuredMcpIds.length ? delivery.configuredMcpIds.join(', ') : 'None'}</p>
            <p>System SHA-256 <code>{delivery.systemSha256}</code></p>
            {delivery.notes?.map((note, index) => <p key={index}>{note}</p>)}
          </details>
        ))}
      </section>
      <section className="context-section" aria-label="Native provider inheritance">
        <h4>Provider-managed context</h4>
        <p className="context-note">{manifest.nativeInheritance === 'unknown'
          ? 'Unknown. The native provider may load additional instructions or tools outside this Akorith manifest.'
          : 'No native provider inheritance is declared for this context.'}</p>
        {manifest.notes.length ? <ul className="context-notes">{manifest.notes.map((note, index) => <li key={index}>{note}</li>)}</ul> : null}
        <details className="context-identity"><summary>Record identity and hashes</summary>
          <p>Task <code>{manifest.taskId}</code></p><p>Turn <code>{manifest.turnId}</code></p>
          <p>Manifest <code>{manifest.id}</code></p><p>Fingerprint <code>{manifest.fingerprint}</code></p>
          <p>Prepared system SHA-256 <code>{manifest.systemSha256}</code></p>
        </details>
      </section>
    </>
  )
}

export function ContextDialog({ taskId, turnId, onClose }: { taskId: string; turnId?: string; onClose: () => void }) {
  const [record, setRecord] = useState<TurnContextRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const generation = useRef(0)
  useEffect(() => {
    const current = ++generation.current
    setLoading(true); setFailure(null); setRecord(null)
    const request = turnId
      ? api<TurnContextRecord | null>('context:read', { taskId, turnId })
      : api<TurnContextManifest>('context:preview', { taskId }).then(manifest => ({ manifest, deliveries: [] }))
    void request.then(result => {
      if (generation.current === current) setRecord(result)
    }).catch(error => {
      if (generation.current === current) setFailure(errorText(error))
    }).finally(() => {
      if (generation.current === current) setLoading(false)
    })
    return () => { generation.current++ }
  }, [taskId, turnId, revision])
  return (
    <Dialog title={turnId ? 'Turn context' : 'Task context'} onClose={onClose} className="context-dialog">
      <div className="context-toolbar">
        <span>{turnId ? 'Recorded evidence for this turn' : 'Resolved from current task settings'}</span>
        <IconButton label="Refresh context" disabled={loading} onClick={() => setRevision(value => value + 1)}><RefreshCw size={14} /></IconButton>
      </div>
      <div className="context-body">
        {loading ? <div className="context-loading" role="status"><Spinner />Reading context…</div>
          : failure ? <div className="context-failure" role="alert"><CircleAlert size={17} /><p>{failure}</p><button className="small-button" onClick={() => setRevision(value => value + 1)}>Try again</button></div>
            : <ContextContent key={`${taskId}:${turnId || 'preview'}:${revision}`} record={record} preview={!turnId} />}
      </div>
    </Dialog>
  )
}
