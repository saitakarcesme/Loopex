import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { SkillInfo, McpServer, Task } from "../shared/contracts";
import type { ContextSource, PreparedTurnContext, TurnContextManifest } from "../shared/context-contracts";
import type { PluginVersion } from "../shared/plugin-contracts";
import type { PluginManager } from "./plugins";
import type { Store } from "./storage";
import {
  spawnOwnedProcess,
  type OwnedProcess,
} from "./providers/process-owner";

interface SkillRoot {
  path: string;
  source: string;
  projectId?: string;
}
export interface ExtensionOptions {
  spawnProcess?: typeof spawnOwnedProcess;
  skillRoots?: () => SkillRoot[];
  readSkillFile?: (path: string) => Promise<string>;
  discoveryTimeoutMs?: number;
  plugins?: PluginManager;
}

export class ExtensionsClosingError extends Error {
  override name = "ExtensionsClosingError";
  readonly code = "AKORITH_EXTENSIONS_CLOSING";
  constructor() {
    super("Extensions are shutting down.");
  }
}

export class Extensions {
  private cache: SkillInfo[] = [];
  private scanned = 0;
  private closing = false;
  private operations = new Set<Promise<unknown>>();
  private probes = new Map<OwnedProcess, () => void>();
  private disposal?: Promise<void>;
  private bundles = new Map<string, () => Promise<void>>();
  private readonly spawnProcess: typeof spawnOwnedProcess;
  private readonly readSkillFile: (path: string) => Promise<string>;
  private readonly discoveryTimeoutMs: number;
  constructor(
    private readonly store: Store,
    private readonly options: ExtensionOptions = {},
  ) {
    this.spawnProcess = options.spawnProcess ?? spawnOwnedProcess;
    this.readSkillFile =
      options.readSkillFile ?? ((path) => readFile(path, "utf8"));
    this.discoveryTimeoutMs = options.discoveryTimeoutMs ?? 15_000;
    if (
      !Number.isFinite(this.discoveryTimeoutMs) ||
      this.discoveryTimeoutMs <= 0
    )
      throw new Error("Invalid MCP discovery timeout.");
  }
  private assertOpen() {
    if (this.closing) throw new ExtensionsClosingError();
  }
  private operation<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new ExtensionsClosingError());
    const pending = Promise.resolve().then(() => {
      this.assertOpen();
      return work();
    });
    this.operations.add(pending);
    pending.then(
      () => this.operations.delete(pending),
      () => this.operations.delete(pending),
    );
    return pending;
  }
  private async stopProbe(owner: OwnedProcess): Promise<void> {
    await owner.stop();
    this.probes.delete(owner);
  }
  dispose(): Promise<void> {
    this.closing = true;
    if (this.disposal) return this.disposal;
    for (const cancel of this.probes.values()) cancel();
    const cleanup = [...this.probes.keys()].map((owner) =>
      this.stopProbe(owner),
    );
    const pending = [...this.operations];
    const attempt = (async () => {
      const [stopped] = await Promise.all([
        Promise.allSettled(cleanup),
        Promise.allSettled(pending),
      ]);
      const errors = stopped
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map((result) => result.reason);
      const released = await Promise.allSettled([...this.bundles.values()].map(release => release()));
      for (const result of released) if (result.status === "rejected") errors.push(result.reason);
      if (this.probes.size || this.bundles.size)
        throw new AggregateError(
          errors,
          `Extension cleanup is unconfirmed for ${this.probes.size} owned process(es) and ${this.bundles.size} context bundle(s).`,
        );
    })();
    this.disposal = attempt;
    attempt.catch(() => {
      this.disposal = undefined;
    });
    return attempt;
  }
  skills(force = false): Promise<SkillInfo[]> {
    return this.operation(async () => {
      const skills = await this.scanSkills(force);
      this.assertOpen();
      if (!this.options.plugins) return skills;
      const snapshot = await this.options.plugins.list(); this.assertOpen();
      for (const plugin of snapshot.plugins.filter(plugin => !plugin.removed)) {
        const version = plugin.versions.find(version => version.digest === plugin.selectedDigest && version.state === "ready") ?? plugin.versions.filter(version => version.state === "ready").at(-1);
        if (version) skills.push(...this.pluginSkills(version, plugin.enabled));
      }
      return skills;
    });
  }
  private async scanSkills(force = false, selection?: ReadonlySet<string>, capturedRoots?: SkillRoot[], signal?: AbortSignal): Promise<SkillInfo[]> {
    this.assertOpen();
    signal?.throwIfAborted();
    const selected = selection ?? new Set(this.store.settings().skills);
    if (!force && Date.now() - this.scanned < 30_000) {
      return this.cache.map((s) => ({
        ...s,
        enabled: selected.has(s.id),
      }));
    }
    const roots: SkillRoot[] = capturedRoots ?? this.skillRoots();
    const results: SkillInfo[] = [];
    const seen = new Set<string>();
    let directories = 0;
    const check = () => { this.assertOpen(); signal?.throwIfAborted(); };
    const walk = async (
      path: string,
      source: string,
      depth: number,
      projectId?: string,
    ): Promise<void> => {
      check();
      if (depth > 7 || directories++ > 4500) return;
      let canonical: string;
      try { canonical = await realpath(path); } catch { check(); return; }
      check();
      if (seen.has(canonical)) return;
      seen.add(canonical);
      let entries;
      try { entries = await readdir(path, { withFileTypes: true }); } catch { check(); return; }
      check();
      if (entries.some((e) => e.name === "SKILL.md")) {
        try {
          const file = join(path, "SKILL.md"), info = await stat(file); check();
          if (info.size > 256_000) return;
          const text = await this.readSkillFile(file); check();
          const front = text.match(/^---\s*\n([\s\S]*?)\n---/)?.[1] ?? "";
          const value = (key: string) => front.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim().replace(/^['"]|['"]$/g, "") ?? "";
          const name = value("name") || basename(path);
          const id = createHash("sha256").update(`${projectId ?? source}:${name}`).digest("hex").slice(0, 24);
          results.push({ id, name, description: value("description") || text.split("\n").find(l => l.trim() && !l.startsWith("#") && !l.startsWith("---"))?.slice(0, 200) || "", path: file, source, projectId, enabled: selected.has(id) });
        } catch (error) { check(); }
        return;
      }
      for (const entry of entries) {
        if (["node_modules", ".git", ".build", "references", "assets", "scripts"].includes(entry.name) || (entry.name.startsWith(".") && entry.name !== ".system")) continue;
        if (entry.isDirectory() || entry.isSymbolicLink()) { await walk(join(path, entry.name), source, depth + 1, projectId); check(); }
      }
    };
    for (const root of roots) { await walk(root.path, root.source, 0, root.projectId); check(); }
    const unique = new Map<string, SkillInfo>();
    for (const skill of results) {
      const key = `${skill.projectId ?? skill.source}:${skill.name}`, prior = unique.get(key);
      if (!prior || skill.path.localeCompare(prior.path, undefined, { numeric: true }) > 0) unique.set(key, skill);
    }
    this.cache = [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
    this.scanned = Date.now();
    return this.cache.map(skill => ({ ...skill, enabled: selected.has(skill.id) }));
  }
  private skillRoots(): SkillRoot[] {
    return this.options.skillRoots?.() ?? [
      { path: join(homedir(), ".agents", "skills"), source: "Personal" },
      { path: join(homedir(), ".codex", "skills"), source: "Codex" },
      {
        path: join(homedir(), ".codex", "plugins", "cache"),
        source: "Installed plugins",
      },
      ...this.store.projects().map((p) => ({
        path: join(p.path, ".agents", "skills"),
        source: p.name,
        projectId: p.id,
      })),
    ];
  }
  toggle(id: string, enabled: boolean): Promise<SkillInfo[]> {
    return this.operation(async () => {
      const all = await this.skills();
      this.assertOpen();
      if (all.find(skill => skill.id === id)?.plugin) throw new Error("This skill is controlled by its plugin. Enable or disable the plugin instead.");
      if (!all.some((s) => s.id === id)) throw new Error("Skill not found.");
      const selected = new Set(this.store.settings().skills);
      if (enabled) selected.add(id);
      else selected.delete(id);
      this.store.saveSettings({ skills: [...selected] });
      return this.skills();
    });
  }
  private pluginSkills(version: PluginVersion, enabled: boolean): SkillInfo[] {
    const plugin = { pluginId: version.pluginId, version: version.version, digest: version.digest };
    return version.manifest.skills.map(skill => ({ id: createHash("sha256").update(`plugin:${version.pluginId}:skill:${skill.id}`).digest("hex").slice(0, 24), name: skill.id, description: version.manifest.description || "Plugin-controlled skill", path: join(version.rootPath, skill.path), source: version.manifest.name, enabled, plugin }));
  }
  prepare(task: Task, turnId: string, signal?: AbortSignal): Promise<PreparedTurnContext> {
    return this.operation(async () => {
      const check = () => { this.assertOpen(); signal?.throwIfAborted(); };
      check();
      // Capture mutable settings and project roots exactly once before the first await.
      const settings = structuredClone(this.store.settings());
      const project = task.projectId ? this.store.project(task.projectId) : null;
      const roots = this.skillRoots().map(root => ({ ...root }));
      const selected = new Set(settings.skills || []);
      let pinned = false, released = false;
      let releasing: Promise<void> | undefined;
      const release = () => {
        if (released) return Promise.resolve();
        if (releasing) return releasing;
        releasing = (async () => { if (pinned) await this.options.plugins!.releaseTurn(turnId); released = true; if (this.bundles.get(turnId) === release) this.bundles.delete(turnId); })();
        releasing.catch(() => { releasing = undefined; });
        return releasing;
      };
      try {
        const versions = this.options.plugins ? await this.options.plugins.acquireEnabled(turnId) : [];
        pinned = !!this.options.plugins; check();
        const manual = await this.scanSkills(false, selected, roots, signal); check();
        const skills = [...manual.filter(skill => selected.has(skill.id)), ...versions.flatMap(version => this.pluginSkills(version, true))];
        const sources: ContextSource[] = [];
        if (project) sources.push({ id: `project-instructions:${project.id}`, kind: "instructions", name: "Project AGENTS.md", path: join(project.path, "AGENTS.md"), scope: "project", projectId: project.id, state: "unavailable", includedBytes: 0 });
        for (const skill of skills) sources.push({ id: skill.id, kind: "skill", name: skill.name, path: skill.path, scope: skill.projectId ? "project" : "global", projectId: skill.projectId, plugin: skill.plugin, state: "unavailable", includedBytes: 0 });
        for (const selectedId of selected) if (!manual.some(skill => skill.id === selectedId)) sources.push({ id: selectedId, kind: "skill", name: "Unavailable selected skill", path: "", scope: "global", state: "unavailable", includedBytes: 0, reason: "The selected skill is no longer discoverable." });
        const blocks: string[] = [], readRoots = new Set<string>();
        const remaining = { instructions: 40_000, skill: 64_000 };
        const digest = (text: string) => createHash("sha256").update(text).digest("hex");
        const bytes = (text: string) => Buffer.byteLength(text, "utf8");
        const prefix = (text: string, limit: number) => {
          const input = Buffer.from(text); let end = Math.max(0, Math.min(input.length, limit));
          for (;;) { try { return new TextDecoder("utf-8", { fatal: true }).decode(input.subarray(0, end)); } catch { if (!end) return ""; end--; } }
        };
        for (const source of sources) {
          check();
          if (!source.path) continue;
          if (source.projectId && source.projectId !== task.projectId) { source.state = "omitted"; source.reason = "This skill belongs to another project."; continue; }
          let content: string;
          try { content = await this.readSkillFile(source.path); check(); }
          catch (error) { check(); source.reason = error instanceof Error ? error.message : String(error); source.state = "unavailable"; continue; }
          source.originalBytes = bytes(content); source.sha256 = digest(content);
          const header = `${source.kind === "instructions" ? "Project instructions" : "Skill"}: ${source.name}\nSource: ${source.path}\n`;
          const available = remaining[source.kind] - bytes(header) - 2;
          if (available < 0 || (available === 0 && content.length)) { source.state = "omitted"; source.reason = "Per-turn UTF-8 context budget exhausted."; continue; }
          const shortened = source.originalBytes > available;
          const suffix = shortened ? "\n[Source truncated for the per-turn UTF-8 context budget]" : "";
          const included = shortened ? prefix(content, Math.max(0, available - bytes(suffix))) : content;
          if (shortened && !included.length) { source.state = "omitted"; source.reason = "Insufficient UTF-8 budget to include this source."; continue; }
          const block = header + included + suffix + "\n\n";
          source.state = shortened ? "truncated" : "included"; source.includedBytes = bytes(included);
          if (shortened) source.reason = "Source content was shortened at a complete UTF-8 character boundary.";
          remaining[source.kind] -= bytes(block); blocks.push(block);
          const root = await realpath(dirname(source.path)); check(); readRoots.add(root);
        }
        const mcpServers: McpServer[] = (settings.mcpServers || []).filter(server => server.enabled && (!server.projectId || server.projectId === task.projectId)).map(server => ({ ...server, args: [...server.args] }));
        for (const version of versions) {
          const plugin = { pluginId: version.pluginId, version: version.version, digest: version.digest };
          for (const server of version.resolvedMcpServers) mcpServers.push({ ...server, id: `plugin_${digest(`${version.pluginId}:${server.id}`).slice(0, 24)}`, enabled: true, plugin });
        }
        const seen = new Set<string>();
        for (const server of mcpServers) { if (seen.has(server.id)) throw new Error(`Duplicate effective MCP server id: ${server.id}`); seen.add(server.id); }
        mcpServers.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        const systemContext = blocks.join("");
        const fingerprint = digest(JSON.stringify({ providerId: task.providerId, systemSha256: digest(systemContext), sources: sources.map(source => ({ id: source.id, path: source.path, projectId: source.projectId, plugin: source.plugin, state: source.state, sha256: source.sha256, includedBytes: source.includedBytes })), mcpServers: mcpServers.map(server => ({ id: server.id, command: server.command, args: server.args, projectId: server.projectId, plugin: server.plugin })) }));
        const manifest: TurnContextManifest = { id: randomUUID(), taskId: task.id, turnId, providerId: task.providerId, resolvedAt: Date.now(), selectionTiming: "turn-start", fingerprint, sources, systemBytes: bytes(systemContext), systemSha256: digest(systemContext), mcpServers: mcpServers.map(server => ({ id: server.id, name: server.name, scope: server.projectId ? "project" : "global", projectId: server.projectId, plugin: server.plugin, state: "configured" })), nativeInheritance: task.providerId === "ollama" ? "none" : "unknown", notes: ["Selection was resolved when this turn started; later settings changes do not mutate this bundle.", "UTF-8 budgets include source labels and truncation markers: project instructions 40000 bytes; skills 64000 bytes.", "Configured MCP servers are not evidence that every tool was discovered, exposed or used.", ...(task.providerId === "ollama" ? ["The local adapter may further shorten context; transport receipts describe the actual system message."] : ["Native provider instructions, skills and MCP inheritance may add context that Akorith cannot enumerate."])] };
        check(); this.bundles.set(turnId, release);
        return { manifest, systemContext, mcpServers, readRoots: [...readRoots], ollamaUrl: settings.ollamaUrl || "http://127.0.0.1:11434", release };
      } catch (error) { await release(); throw error; }
    });
  }
  async preview(task: Task): Promise<TurnContextManifest> {
    const prepared = await this.prepare(task, `preview-${randomUUID()}`);
    try { return prepared.manifest; } finally { await prepared.release(); }
  }
  async context(task: Task): Promise<string> {
    const prepared = await this.prepare(task, `compat-${randomUUID()}`);
    try { return prepared.systemContext; } finally { await prepared.release(); }
  }
  readRoots(taskId: string): Promise<string[]> {
    return this.operation(async () => {
      const task = this.store.task(taskId);
      const prepared = await this.prepare(task, `compat-roots-${randomUUID()}`);
      try { return prepared.readRoots; } finally { await prepared.release(); }
    });
  }
  probe(server: McpServer): Promise<McpServer> {
    return this.operation(async () => {
      if (
        !server.command.trim() ||
        server.command.includes("\0") ||
        server.args.some((a) => a.includes("\0"))
      )
        throw new Error("Invalid MCP command.");
      const project = server.projectId ? this.store.project(server.projectId) : null;
      if (server.projectId && !project)
        throw new Error("The MCP server's project no longer exists. Select an existing project before probing it.");
      const owner = this.spawnProcess(server.command, server.args, {
        cwd: project?.path,
        env: { ...process.env },
        shell: false,
      });
      let cancel = () => {};
      let removeListeners = () => {};
      this.probes.set(owner, () => cancel());
      let result: McpServer;
      try {
        result = await new Promise<McpServer>((resolve, reject) => {
          const child = owner.child;
          let buffer = "";
          let settled = false;
          let initialized = false;
          const finish = (patch: Partial<McpServer>) => {
            if (settled) return;
            settled = true;
            buffer = "";
            clearTimeout(timer);
            resolve({ ...server, ...patch });
          };
          cancel = () => {
            if (settled) return;
            settled = true;
            buffer = "";
            clearTimeout(timer);
            reject(new ExtensionsClosingError());
          };
          const timer = setTimeout(
            () =>
              finish({
                status: "error",
                error: `Server did not complete discovery within ${this.discoveryTimeoutMs / 1000} seconds.`,
                tools: [],
              }),
            this.discoveryTimeoutMs,
          );
          const send = (obj: unknown) => {
            if (settled) return;
            try {
              if (child.stdin.destroyed)
                throw new Error("MCP input stream is closed.");
              child.stdin.write(JSON.stringify(obj) + "\n");
            } catch (error) {
              finish({
                status: "error",
                error: error instanceof Error ? error.message : String(error),
                tools: [],
              });
            }
          };
          const onError = (error: Error) =>
            finish({ status: "error", error: error.message, tools: [] });
          const onExit = () =>
            finish({
              status: "error",
              error: "Server exited before tool discovery completed.",
              tools: [],
            });
          const onStderr = () => {};
          const onData = (data: Buffer) => {
            if (settled) return;
            buffer += data.toString();
            if (buffer.length > 2_000_000) {
              finish({
                status: "error",
                error: "Server output exceeded the discovery limit.",
                tools: [],
              });
              return;
            }
            let end: number;
            while (!settled && (end = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, end);
              buffer = buffer.slice(end + 1);
              let message;
              try {
                message = JSON.parse(line);
              } catch {
                continue;
              }
              if (message?.id === 1 && !initialized) {
                if (message.error || !message.result) {
                  finish({
                    status: "error",
                    error: "MCP initialization failed.",
                    tools: [],
                  });
                  return;
                }
                initialized = true;
                send({ jsonrpc: "2.0", method: "notifications/initialized" });
                send({
                  jsonrpc: "2.0",
                  id: 2,
                  method: "tools/list",
                  params: {},
                });
              } else if (message?.id === 2 && initialized) {
                if (message.error || !Array.isArray(message.result?.tools)) {
                  finish({
                    status: "error",
                    error: "MCP tool discovery failed.",
                    tools: [],
                  });
                  return;
                }
                finish({
                  status: "ready",
                  error: undefined,
                  tools: message.result.tools
                    .map((tool: { name?: unknown } | null) =>
                      typeof tool?.name === "string" ? tool.name : "",
                    )
                    .filter(Boolean),
                });
              }
            }
          };
          child.on("error", onError);
          child.on("exit", onExit);
          child.stderr.on("data", onStderr);
          child.stdin.on("error", onError);
          child.stdout.on("data", onData);
          child.stdout.on("error", onError);
          child.stderr.on("error", onError);
          removeListeners = () => {
            child.off("error", onError);
            child.off("exit", onExit);
            child.stderr.off("data", onStderr);
            child.stdin.off("error", onError);
            child.stdout.off("data", onData);
            child.stdout.off("error", onError);
            child.stderr.off("error", onError);
            const ignoreLateStreamError = () => {};
            child.stdin.on("error", ignoreLateStreamError);
            child.stdout.on("error", ignoreLateStreamError);
            child.stderr.on("error", ignoreLateStreamError);
            // A retained, unconfirmed child cannot keep growing protocol buffers.
            child.stdout.resume();
            child.stderr.resume();
          };
          send({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              clientInfo: { name: "akorith-next", version: "2.0.0-alpha.1" },
            },
          });
        });
      } finally {
        try {
          await this.stopProbe(owner);
        } finally {
          removeListeners();
        }
      }
      this.assertOpen();
      return result;
    });
  }
}
