import type { HostTools, ProviderAdapter } from '../../shared/contracts'
import { CodexProvider } from './codex'
import { ClaudeProvider } from './claude'
import { OpenCodeProvider } from './opencode'
import { OllamaProvider } from './ollama'

export function createProviders(hostTools: HostTools, options: { getOllamaUrl?: () => string } = {}): ProviderAdapter[] {
  return [new CodexProvider(hostTools), new ClaudeProvider(hostTools), new OpenCodeProvider(hostTools), new OllamaProvider(hostTools, options.getOllamaUrl)]
}
export { CodexProvider, ClaudeProvider, OpenCodeProvider, OllamaProvider }
