import { Check, Layers3, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { McpServer } from '../../../../shared/contracts'
import { api, errorText } from '../../api'
import { EmptyState, IconButton, Spinner, Toggle } from '../Primitives'
import type { SettingsSectionProps } from './types'
export function mcpScopeLabel(server: Pick<McpServer, 'projectId'>, projects: Array<{ id: string; name: string }>): string {
  if (!server.projectId) return 'All projects'
  return projects.find(project => project.id === server.projectId)?.name || `Unavailable project (${server.projectId})`
}
export function McpSettings({
  snapshot,
  onRefresh,
  onError,
  notify,
  onManagePlugins,
}: SettingsSectionProps & { onManagePlugins: () => void }) {
  const [servers, setServers] = useState(snapshot.settings.mcpServers)
  const [serverForm, setServerForm] = useState<McpServer | null>(null)
  const [serverArgs, setServerArgs] = useState('')
  const [savingServer, setSavingServer] = useState(false)
  const [probing, setProbing] = useState<string | null>(null)
  const busy = savingServer || !!probing
  const mutation = useRef(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const loadGeneration = useRef(0)
  const loadServers = async () => {
    const generation = ++loadGeneration.current
    const next = await api<McpServer[]>('mcp:list')
    if (generation === loadGeneration.current) { setServers(next); setLoadError(null) }
  }
  useEffect(() => {
    void loadServers().catch(error => setLoadError(errorText(error)))
    return () => { loadGeneration.current++ }
  }, [snapshot.settings.mcpServers])
  const mutate = async (command: 'mcp:save' | 'mcp:remove', payload: object) => {
    if (mutation.current) return
    mutation.current = true
    setSavingServer(true)
    try {
      await api<McpServer[]>(command, payload)
      await loadServers()
      await onRefresh()
    } catch (error) { onError(error) }
    finally { mutation.current = false; setSavingServer(false) }
  }
  const saveServer = async () => {
    if (!serverForm || mutation.current || serverForm.plugin) return
    mutation.current = true
    setSavingServer(true)
    try {
      const next = await api<McpServer[]>('mcp:save', {
        server: {
          ...serverForm,
          name: serverForm.name.trim(),
          command: serverForm.command.trim(),
          args: serverArgs
            .split('\n')
            .map((value) => value.trim())
            .filter(Boolean),
        },
      })
      setServerForm(null)
      await loadServers()
      await onRefresh()
    } catch (error) {
      onError(error)
    } finally {
      mutation.current = false
      setSavingServer(false)
    }
  }
  const probe = async (id: string) => {
    if (mutation.current) return
    mutation.current = true
    setProbing(id)
    try {
      const server = await api<McpServer>('mcp:probe', { id })
      setServers((current) => current.map((item) => (item.id === server.id ? server : item)))
      if (server.error) notify(server.error)
    } catch (error) {
      onError(error)
    } finally {
      mutation.current = false
      setProbing(null)
    }
  }

  return (
    <>
      <div className="settings-section-title with-action">
        <div>
          <h3>MCP servers</h3>
          <p>Connect tools through local Model Context Protocol servers.</p>
        </div>
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() => {
            setServerForm({
              id: crypto.randomUUID(),
              name: '',
              command: '',
              args: [],
              enabled: true,
            })
            setServerArgs('')
          }}
        >
          <Plus size={14} />
          Add server
        </button>
      </div>
      {loadError ? <p className="panel-error" role="alert">{loadError}</p> : null}
      {serverForm ? (
        <form
          className="mcp-form"
          onSubmit={(event) => {
            event.preventDefault()
            void saveServer()
          }}
        >
          <div className="mcp-form-title">
            <h4>
              {servers.some((server) => server.id === serverForm.id) ? 'Edit server' : 'New server'}
            </h4>
            <IconButton label="Cancel server edit" onClick={() => setServerForm(null)}>
              <X size={15} />
            </IconButton>
          </div>
          <label className="field-label" htmlFor="mcp-name">
            Name
          </label>
          <input
            id="mcp-name"
            required
            placeholder="My tools"
            value={serverForm.name}
            onChange={(event) => setServerForm({ ...serverForm, name: event.target.value })}
          />
          <label className="field-label" htmlFor="mcp-scope">Available in</label>
          <select id="mcp-scope" value={serverForm.projectId || ''} onChange={event => setServerForm({ ...serverForm, projectId: event.target.value || undefined })}>
            <option value="">All projects</option>
            {serverForm.projectId && !snapshot.projects.some(project => project.id === serverForm.projectId) ? <option value={serverForm.projectId}>Unavailable project ({serverForm.projectId})</option> : null}
            {snapshot.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <label className="field-label" htmlFor="mcp-command">
            Executable
          </label>
          <input
            id="mcp-command"
            required
            placeholder="Path to executable, or command name"
            value={serverForm.command}
            onChange={(event) => setServerForm({ ...serverForm, command: event.target.value })}
          />
          <label className="field-label" htmlFor="mcp-args">
            Arguments <span>One per line</span>
          </label>
          <textarea
            id="mcp-args"
            rows={3}
            value={serverArgs}
            onChange={(event) => setServerArgs(event.target.value)}
          />
          <p className="settings-description">
            The executable runs on this Mac. Use a server you trust; put each argument on a separate
            line.
          </p>
          <div className="dialog-actions">
            <button type="button" className="secondary-button" onClick={() => setServerForm(null)}>
              Cancel
            </button>
            <button
              className="primary-button"
              disabled={busy || !serverForm.name.trim() || !serverForm.command.trim()}
            >
              {savingServer ? <Spinner /> : <Check size={14} />}Save server
            </button>
          </div>
        </form>
      ) : null}
      <div className="mcp-list">
        {servers.map((server) => (
          <section key={server.id} className="mcp-card">
            <div className="mcp-card-heading">
              <Layers3 size={18} />
              <div>
                <h4>{server.name}</h4>
                <p>{server.status || 'Not tested'} · {mcpScopeLabel(server, snapshot.projects)}</p>
              </div>
              <Toggle
                label={`Enable ${server.name}`}
                checked={server.enabled}
                disabled={busy || !!server.plugin}
                onChange={(enabled) => void mutate('mcp:save', { server: { ...server, enabled } })}
              />
            </div>
            <code className="mcp-command">{[server.command, ...server.args].join(' ')}</code>
            {server.error ? <p className="connection-error">{server.error}</p> : null}
            {server.tools?.length ? (
              <details className="mcp-tools">
                <summary>{server.tools.length} discovered tools</summary>
                {server.tools.map((tool) => (
                  <code key={tool}>{tool}</code>
                ))}
              </details>
            ) : null}
            <div className="mcp-actions">
              <button
                className="small-button"
                disabled={busy || !!server.plugin}
                onClick={() => void probe(server.id)}
              >
                {probing === server.id ? <Spinner size={12} /> : <RefreshCw size={12} />}
                Test connection
              </button>
              {server.plugin ? <button className="text-button" onClick={onManagePlugins}>Manage plugin · {server.plugin.version}</button> : <>
              <button
                disabled={busy}
                className="text-button"
                onClick={() => {
                  setServerForm(server)
                  setServerArgs(server.args.join('\n'))
                }}
              >
                Edit
              </button>
              <IconButton
                label={`Remove ${server.name}`}
                disabled={busy}
                onClick={() => void mutate('mcp:remove', { id: server.id })}
              >
                <Trash2 size={14} />
              </IconButton>
              </>}
            </div>
          </section>
        ))}
      </div>
      {!servers.length && !serverForm ? (
        <EmptyState icon={<Layers3 size={28} />} title="Bring your tools">
          <p>Add an MCP server to discover and use its tools from your tasks.</p>
        </EmptyState>
      ) : null}
    </>
  )
}
