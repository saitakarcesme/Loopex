import type { BenchmarkLocalToolPolicy } from '../benchmark-tool-policy'
import type { HostTools, ProviderAdapter, RunRequest } from '../../shared/contracts'
import { CodexProvider } from './codex'
import { ClaudeProvider } from './claude'
import { OpenCodeProvider } from './opencode'
import { OllamaProvider } from './ollama'

export function createProviders(hostTools: HostTools, options: { getOllamaUrl?: () => string; getLocalToolPolicy?: (request: RunRequest) => BenchmarkLocalToolPolicy | null } = {}): ProviderAdapter[] {
  return [new CodexProvider(hostTools), new ClaudeProvider(hostTools), new OpenCodeProvider(hostTools), new OllamaProvider(hostTools, options.getOllamaUrl, options.getLocalToolPolicy)]
}
export { CodexProvider, ClaudeProvider, OpenCodeProvider, OllamaProvider }
