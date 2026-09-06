import type { HostTools, RunRequest } from '../shared/contracts';
export interface BenchmarkLocalToolPolicy { allowedHostTools: string[]; allowedMcpServerIds: string[] }
/** Per-turn immutable wrapper: catalog search and invocation share exactly one whitelist. */
export function scopedBenchmarkHost(host: HostTools, request: RunRequest, policy: BenchmarkLocalToolPolicy): HostTools {
  const allowed = new Set(policy.allowedHostTools);
  for (const name of allowed) if (!host.definitions.some(tool => tool.name === name)) throw new Error(`Requested benchmark tool is unavailable: ${name}`);
  return {
    definitions: host.definitions.filter(tool => allowed.has(tool.name)),
    execute: (name, args, context, signal) => {
      if (context.taskId !== request.task.id || context.turnId !== request.turnId || !allowed.has(name)) return Promise.reject(new Error('Tool is outside this benchmark method scope.'));
      return host.execute(name, args, context, signal);
    },
    drain: host.drain ? taskId => host.drain!(taskId) : undefined,
    dispose: async () => {}, // Wrapper does not own the shared host.
  };
}
