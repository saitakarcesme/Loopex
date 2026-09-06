import type { ModelInfo, ProviderInfo, Task } from '../../../shared/contracts'
export interface ModelChoice { provider: ProviderInfo; model: ModelInfo; key: string; enabled: boolean }
export function modelChoices(providers: ProviderInfo[], query: string): ModelChoice[] {
  const search = query.trim().toLocaleLowerCase()
  return providers.flatMap(provider => {
    const seen = new Set<string>()
    return provider.models.filter(model => {
      if (seen.has(model.id)) return false
      seen.add(model.id)
      return `${provider.name} ${provider.connectionLabel} ${model.id} ${model.name} ${model.description || ''}`.toLocaleLowerCase().includes(search)
    }).map(model => ({ provider, model, key: `${provider.id}:${model.id}`, enabled: provider.available && provider.authenticated !== false }))
  })
}
export function modelSelectionPatch(providers: ProviderInfo[], providerId: string, modelId: string, currentEffort: string): Partial<Task> {
  const provider = providers.find(item => item.id === providerId)
  if (!provider?.available || provider.authenticated === false) throw new Error('This connection is not ready. Open Connections to set it up.')
  const model = provider.models.find(item => item.id === modelId)
  if (!model) throw new Error('This model is no longer in the connection’s catalog. Refresh Connections and choose again.')
  const efforts = model.efforts || []
  const effort = efforts.includes(currentEffort) ? currentEffort : efforts.includes('high') ? 'high' : efforts.includes('medium') ? 'medium' : efforts[0] || ''
  return { providerId: provider.id, model: model.id, effort }
}
export function providerAvailability(provider: ProviderInfo): string {
  return !provider.available ? 'Unavailable' : provider.authenticated === false ? 'Sign in required' : !provider.models.length ? 'No models available' : provider.connectionLabel
}

/** Shorten only the provider-added routing suffix, never the model identifier or arbitrary names. */
export function modelTriggerLabel(providerId: string, label: string): string {
  return providerId === 'opencode' ? label.replace(/ · OpenCode (?:Zen|Go)$/, '') : label
}
