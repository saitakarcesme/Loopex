import type { McpServer, ProviderId } from './contracts'
import type { PluginVersionRef } from './plugin-contracts'

export interface ContextSource {
  id: string
  kind: 'instructions' | 'skill'
  name: string
  path: string
  scope: 'global' | 'project'
  projectId?: string
  plugin?: PluginVersionRef
  state: 'included' | 'truncated' | 'omitted' | 'unavailable'
  originalBytes?: number
  includedBytes: number
  sha256?: string
  reason?: string
}

/** Describes what Akorith prepared; native provider inheritance is separate. */
export interface TurnContextManifest {
  id: string
  taskId: string
  turnId: string
  providerId: ProviderId
  resolvedAt: number
  selectionTiming: 'turn-start'
  fingerprint: string
  sources: ContextSource[]
  systemBytes: number
  systemSha256: string
  mcpServers: Array<{
    id: string
    name: string
    scope: 'global' | 'project'
    projectId?: string
    plugin?: PluginVersionRef
    state: 'configured'
  }>
  nativeInheritance: 'unknown' | 'none'
  notes: string[]
  session?: 'new' | 'resumed' | 'renewed-for-context'
}

/** A transport receipt is evidence of submission, never of model compliance. */
export interface ContextDeliveryReceipt {
  at: number
  providerId: ProviderId
  stage: 'submitted' | 'accepted'
  channel: 'native-session' | 'native-prompt' | 'local-request'
  systemBytes: number
  systemSha256: string
  contextTrimmed: boolean
  configuredMcpIds: string[]
  notes?: string[]
}

export interface TurnContextRecord {
  manifest: TurnContextManifest
  deliveries: ContextDeliveryReceipt[]
}

/** Main-process value. Only the manifest/receipts are exposed to the renderer. */
export interface PreparedTurnContext {
  manifest: TurnContextManifest
  systemContext: string
  mcpServers: McpServer[]
  readRoots: string[]
  ollamaUrl: string
  release(): Promise<void>
}
