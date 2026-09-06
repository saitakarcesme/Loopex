import { createHash } from "node:crypto";
import type { McpServer } from '../shared/contracts';
import type { Extensions } from './extensions';
import type { PluginManager } from './plugins';
import type { Store } from './storage';

interface Services {
  store: Store;
  plugins: PluginManager;
  extensions: Extensions;
  changed(): void;
  pickLocal(): Promise<{ path: string } | null>;
}
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.length || value.length > max || value.includes('\0'))
    throw new Error(`Invalid ${label}.`);
  return value;
}
function digest(value: unknown): string {
  const result = text(value, 'plugin digest', 64);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error('Invalid plugin digest.');
  return result;
}

/** The main IPC closing fence and accepted-operation tracker wrap this dispatch. */
export async function extensionCommand(name: string, p: Record<string, unknown>, services: Services): Promise<unknown> {
  const { store, plugins, extensions, changed } = services;
  switch (name) {
    case 'mcp:list': {
      const registry = await plugins.list();
      const servers: McpServer[] = store.settings().mcpServers.map(server => ({ ...server, args: [...server.args] }));
      for (const entry of registry.plugins.filter(plugin => !plugin.removed)) {
        const version = entry.versions.find(version => version.digest === entry.selectedDigest)
          ?? entry.versions.filter(version => version.state === 'ready').at(-1);
        if (!version) continue;
        const plugin = { pluginId: entry.id, version: version.version, digest: version.digest };
        for (const server of version.resolvedMcpServers) servers.push({ ...server,
          id: `plugin_${createHash('sha256').update(`${entry.id}:${server.id}`).digest('hex').slice(0, 24)}`,
          enabled: entry.enabled && version.digest === entry.selectedDigest && version.state === 'ready', plugin,
        });
      }
      return servers;
    }
    case 'plugins:pickLocal': return services.pickLocal();
    case 'plugins:list': return plugins.list();
    case 'plugins:inspectLocal': return plugins.inspectLocal(text(p.path, 'plugin folder', 4000));
    case 'plugins:importLocal': {
      const result = await plugins.importLocal(text(p.path, 'plugin folder', 4000), { expectedDigest: digest(p.expectedDigest) });
      changed(); return result;
    }
    case 'plugins:setEnabled': {
      if (typeof p.enabled !== 'boolean') throw new Error('Invalid plugin state.');
      const result = await plugins.setEnabled(text(p.pluginId, 'plugin identifier', 80), p.enabled, p.digest === undefined ? undefined : digest(p.digest));
      changed(); return result;
    }
    case 'plugins:remove': {
      const result = await plugins.remove(text(p.pluginId, 'plugin identifier', 80));
      changed(); return result;
    }
    case 'plugins:collectUnused': {
      const result = await plugins.collectUnused();
      changed(); return result;
    }
    case 'context:preview': return extensions.preview(store.task(text(p.taskId, 'task identifier', 160)));
    case 'context:read': {
      const taskId = text(p.taskId, 'task identifier', 160);
      store.task(taskId);
      return store.contextRecord(taskId, text(p.turnId, 'turn identifier', 160));
    }
    default: throw new Error('Unknown extension command.');
  }
}

/** Invalid project references stay scoped; removal may clean an orphan manually. */
export function assertManualMcp(store: Store, server: McpServer, requireProject = true): void {
  if (server.plugin || server.id.startsWith('plugin_')) throw new Error('Plugin MCP servers are managed through their plugin.');
  if (requireProject && server.projectId != null && !store.project(server.projectId))
    throw new Error('This MCP server’s project is missing. Choose an existing project or explicitly select global scope.');
}
