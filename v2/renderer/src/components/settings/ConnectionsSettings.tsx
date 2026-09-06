import { Check, ChevronRight, Copy, Cpu, ExternalLink, RefreshCw, Terminal, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ProviderId, ProviderInfo, Settings } from '../../../../shared/contracts'
import { api } from '../../api'
import { IconButton, Spinner } from '../Primitives'
import type { SettingsSectionProps } from './types'
const guides: Record<ProviderId, { url: string; command: string; description: string }> = {
  codex: {
    url: 'https://developers.openai.com/codex/cli/',
    command: 'codex login',
    description: 'Uses your Codex CLI connection and account.',
  },
  claude: {
    url: 'https://code.claude.com/docs/en/setup',
    command: 'claude auth login',
    description: 'Uses the installed Claude Code connection.',
  },
  opencode: {
    url: 'https://opencode.ai/docs/providers/',
    command: 'opencode auth login',
    description: 'Uses providers connected through OpenCode.',
  },
  ollama: {
    url: 'https://docs.ollama.com/',
    command: 'ollama serve',
    description: 'Uses models available at your Ollama endpoint.',
  },
}
export function ConnectionsSettings({
  snapshot,
  onSettings,
  onRefresh,
  onError,
  notify,
}: SettingsSectionProps) {
  const [providers, setProviders] = useState(snapshot.providers)
  const [refreshing, setRefreshing] = useState(false)
  const [ollamaUrl, setOllamaUrl] = useState(snapshot.settings.ollamaUrl)
  const [savingEndpoint, setSavingEndpoint] = useState(false)
  const patchSettings = async (patch: Partial<Settings>) => {
    const next = await api<Settings>('settings:update', { patch })
    onSettings(next)
  }
  const refreshProviders = async () => {
    setRefreshing(true)
    try {
      setProviders(await api<ProviderInfo[]>('providers:refresh'))
      await onRefresh()
    } catch (error) {
      onError(error)
    } finally {
      setRefreshing(false)
    }
  }
  useEffect(() => setProviders(snapshot.providers), [snapshot.providers])
  return (
    <>
      <div className="settings-section-title with-action">
        <div>
          <h3>Your connections</h3>
          <p>Subscriptions and local models, in one workspace.</p>
        </div>
        <button
          className="secondary-button"
          disabled={refreshing}
          onClick={() => void refreshProviders()}
        >
          {refreshing ? <Spinner /> : <RefreshCw size={13} />}Refresh
        </button>
      </div>
      <div className="connection-list">
        {providers.map((provider) => (
          <section key={provider.id} className="connection-card">
            <div className="connection-card-header">
              <div className={`connection-icon ${provider.id}`}>
                {provider.id === 'ollama' ? (
                  <Cpu size={20} />
                ) : provider.id === 'opencode' ? (
                  <Terminal size={20} />
                ) : (
                  <span>{provider.id === 'codex' ? '◈' : '✳'}</span>
                )}
              </div>
              <div>
                <h4>{provider.name}</h4>
                <p>{provider.connectionLabel || guides[provider.id].description}</p>
              </div>
              <span
                className={`health-badge ${provider.available && provider.authenticated !== false ? 'ready' : ''}`}
              >
                <span />
                {provider.available
                  ? provider.authenticated === false
                    ? 'Sign in needed'
                    : 'Available'
                  : 'Unavailable'}
              </span>
            </div>
            {provider.error ? <p className="connection-error">{provider.error}</p> : null}
            <div className="connection-capabilities">
              {[
                ['Tools', provider.capabilities.tools],
                ['Resume', provider.capabilities.resume],
                ['Steering', provider.capabilities.steer],
                ['Images', provider.capabilities.images],
              ].map(([label, available]) => (
                <span key={String(label)} className={available ? 'supported' : ''}>
                  {available ? <Check size={10} /> : <X size={10} />}
                  {label}
                </span>
              ))}
              <span>{provider.models.length} models</span>
              {provider.version ? <span>v{provider.version}</span> : null}
            </div>
            <details className="connection-details">
              <summary>
                Setup and model catalog
                <ChevronRight size={12} />
              </summary>
              <p>{guides[provider.id].description}</p>
              <div className="setup-command">
                <code>{guides[provider.id].command}</code>
                <IconButton
                  label="Copy setup command"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(guides[provider.id].command)
                      .then(() => notify('Setup command copied'))
                      .catch(onError)
                  }
                >
                  <Copy size={12} />
                </IconButton>
              </div>
              <button
                className="text-button"
                onClick={() =>
                  void api('app:openExternal', { url: guides[provider.id].url }).catch(onError)
                }
              >
                Setup documentation <ExternalLink size={11} />
              </button>
              {provider.models.length ? (
                <div className="model-catalog">
                  {provider.models.map((model) => (
                    <div key={model.id}>
                      <strong>{model.name}</strong>
                      <code>{model.id}</code>
                    </div>
                  ))}
                </div>
              ) : (
                <p>No models discovered. Set up the connection, then refresh.</p>
              )}
            </details>
          </section>
        ))}
      </div>
      <section className="settings-section">
        <h4>Ollama endpoint</h4>
        <p className="settings-description">
          Connect to Ollama on this Mac or an endpoint you control.
        </p>
        <form
          className="endpoint-form"
          onSubmit={(event) => {
            event.preventDefault()
            setSavingEndpoint(true)
            void patchSettings({ ollamaUrl: ollamaUrl.trim() })
              .then(refreshProviders)
              .catch(onError)
              .finally(() => setSavingEndpoint(false))
          }}
        >
          <input
            type="url"
            aria-label="Ollama endpoint"
            required
            value={ollamaUrl}
            onChange={(event) => setOllamaUrl(event.target.value)}
          />
          <button className="secondary-button" disabled={savingEndpoint}>
            {savingEndpoint ? <Spinner /> : <Check size={14} />}Save
          </button>
        </form>
      </section>
    </>
  )
}
