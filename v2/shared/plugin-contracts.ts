/** Akorith-managed local packages only. External/native plugin caches are not owned. */
export interface LocalPluginManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  name: string;
  description?: string;
  skills: Array<{ id: string; path: string }>;
  mcpServers: Array<{ id: string; name: string; command: string; args: string[] }>;
  assets: string[];
}
export interface PluginFile {
  path: string;
  bytes: number;
  sha256: string;
  executable: boolean;
}
export interface PluginInspection {
  sourcePath: string;
  manifest: LocalPluginManifest;
  digest: string;
  files: PluginFile[];
  totalBytes: number;
}
export interface PluginVersionRef { pluginId: string; version: string; digest: string }
export interface PluginVersion extends PluginVersionRef {
  rootPath: string;
  manifest: LocalPluginManifest;
  files: PluginFile[];
  importedAt: number;
  state: "ready" | "removed";
  sourcePath: string;
  resolvedMcpServers: LocalPluginManifest["mcpServers"];
}
export interface ManagedPlugin {
  id: string;
  name: string;
  enabled: boolean;
  selectedDigest: string | null;
  removed: boolean;
  revision: number;
  versions: PluginVersion[];
}
export interface PluginRecovery {
  operationId: string;
  pluginId: string;
  version: string;
  digest: string;
  phase: string;
  error?: string;
}
export interface PluginRegistrySnapshot {
  plugins: ManagedPlugin[];
  recovery: PluginRecovery[];
}
export interface PluginCleanupResult extends PluginVersionRef {
  status: "removed" | "retained" | "recovered";
  reason?: "in_use" | "usage_unknown" | "usage_check_failed" | "ownership_unconfirmed" | "cleanup_failed" | "registered_version";
  detail?: string;
  operationId?: string;
}
export interface PluginImportResult {
  plugin: ManagedPlugin;
  version: PluginVersion;
  imported: boolean;
  /** Import never activates a new version, even when another version is enabled. */
  activationChanged: false;
}
