import { Check, Layers3, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import type { McpServer } from '../../../../shared/contracts'
import { api } from '../../api'
import { EmptyState, IconButton, Spinner, Toggle } from '../Primitives'
import type { SettingsSectionProps } from './types'
export function McpSettings({
  snapshot,
  onSettings,
  onRefresh,
  onError,
  notify,
}: SettingsSectionProps) {
  const [servers, setServers] = useState(snapshot.settings.mcpServers)
  const [serverForm, setServerForm] = useState<McpServer | null>(null)
  const [serverArgs, setServerArgs] = useState('')
  const [savingServer, setSavingServer] = useState(false)
  const [probing, setProbing] = useState<string | null>(null)
  const saveServer = async () => {
    if (!serverForm) return
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
      setServers(next)
      setServerForm(null)
      await onRefresh()
    } catch (error) {
      onError(error)
    } finally {
      setSavingServer(false)
    }
  }
  const probe = async (id: string) => {
    setProbing(id)
    try {
      const server = await api<McpServer>('mcp:probe', { id })
      setServers((current) => current.map((item) => (item.id === server.id ? server : item)))
      if (server.error) notify(server.error)
    } catch (error) {
      onError(error)
    } finally {
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
              disabled={savingServer || !serverForm.name.trim() || !serverForm.command.trim()}
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
                <p>{server.status || 'Not tested'}</p>
              </div>
              <Toggle
                label={`Enable ${server.name}`}
                checked={server.enabled}
                onChange={(enabled) =>
                  void api<McpServer[]>('mcp:save', { server: { ...server, enabled } })
                    .then(async (next) => {
                      setServers(next)
                      await onRefresh()
                    })
                    .catch(onError)
                }
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
                disabled={probing === server.id}
                onClick={() => void probe(server.id)}
              >
                {probing === server.id ? <Spinner size={12} /> : <RefreshCw size={12} />}
                Test connection
              </button>
              <button
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
                onClick={() =>
                  void api<McpServer[]>('mcp:remove', { id: server.id })
                    .then(async (next) => {
                      setServers(next)
                      await onRefresh()
                    })
                    .catch(onError)
                }
              >
                <Trash2 size={14} />
              </IconButton>
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
