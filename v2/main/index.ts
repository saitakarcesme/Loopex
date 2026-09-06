import { createProjectFolder } from './project-creation';
import { projectFolderName } from './project-names';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  Menu,
  nativeTheme,
  globalShortcut,
} from "electron";
import {
  join,
  basename,
  resolve,
  extname,
  relative,
  isAbsolute,
} from "node:path";
import { homedir } from "node:os";
import { mkdirSync, realpathSync, statSync, existsSync } from "node:fs";
import { copyFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Store } from "./storage";
import { searchProjectFiles, attachProjectFile } from "./project-files";
import { Engine } from "./engine";
import { ResearchService, researchCommand } from './research';
import { BenchmarkStore } from './benchmark';
import { BenchmarkRuntime } from './benchmark-runtime';
import { BenchmarkEvidenceFiles } from './benchmark-evidence';
import { BenchmarkBrowserRecorder } from './benchmark-video';
import { exportBenchmarkComparison } from './benchmark-export';
import { observeShellLifecycle } from "./window-lifecycle";
import { ShutdownCoordinator } from "./shutdown";
import { CommandOperations } from "./operations";
import { Extensions } from "./extensions";
import { PluginManager } from "./plugins";
import { extensionCommand, assertManualMcp } from "./extension-commands";
import { quiesceExtensions } from "./extension-shutdown";
import { importLegacy } from "./migration";
import { CheckpointManager } from "./checkpoints";
import { createProviders } from "./providers";
import { drainCapturedProcesses } from "./providers/common";
import { createHostTools } from "./host";
import type {
  AppEvent,
  ProviderInfo,
  Task,
  Settings,
  Attachment,
  McpServer,
  ProviderId,
} from "../shared/contracts";

app.setName("Akorith Next");
const userData =
  process.env.AKORITH_USER_DATA || join(app.getPath("appData"), "Akorith Next");
app.setPath("userData", userData);
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on("second-instance", () => {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
});
process.env.PATH = [
  join(homedir(), ".local", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  process.env.PATH || "",
].join(":");
let window: BrowserWindow | null = null;
let store: Store,
  engine: Engine,
  extensions: Extensions,
  plugins: PluginManager,
  host: ReturnType<typeof createHostTools>;
let checkpoints: CheckpointManager;
let research: ResearchService | undefined;
let benchmarks: BenchmarkStore, benchmarkRuntime: BenchmarkRuntime | undefined, benchmarkEvidence: BenchmarkEvidenceFiles;
let providers: ReturnType<typeof createProviders> = [];
let providerInfo: ProviderInfo[] = [];
let refresh: Promise<ProviderInfo[]> | undefined;
const commandOperations = new CommandOperations();
const shutdown = new ShutdownCoordinator([
  { name: "runtime and extensions", run: () => quiesceExtensions({
    engine: async () => { await Promise.all([research?.dispose(), benchmarkRuntime?.dispose()]); await engine?.shutdown(); },
    host: () => host?.dispose(),
    commands: () => commandOperations.drain(),
    extensions: () => extensions?.dispose(),
  }) },
  { name: "discovery", run: async () => {
    try { await refresh; } finally { await drainCapturedProcesses(); }
  } },
], () => { if (store?.db.open) store.close(); }, 15_000, (event) => {
  console.info("[akorith:shutdown]", JSON.stringify(event));
});
const send = (event: AppEvent) => {
  if (window && !window.isDestroyed())
    window.webContents.send("akorith:event", event);
};
const cwd = (task: Task) => {
  const path = task.projectId
    ? store.project(task.projectId)?.path
    : join(userData, "workspaces", task.id);
  if (!path) throw new Error("The project directory is missing.");
  if (!task.projectId) mkdirSync(path, { recursive: true });
  const actual = realpathSync(path);
  if (!statSync(actual).isDirectory())
    throw new Error("The project directory is not available.");
  return actual;
};
const getContext = (taskId: string) => {
  const task = store.task(taskId);
  return { taskId, cwd: cwd(task), mode: task.mode };
};
function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid request.");
  return value as Record<string, unknown>;
}
function string(value: unknown, name: string, max = 20_000) {
  if (typeof value !== "string" || value.length > max || value.includes("\0"))
    throw new Error(`Invalid ${name}.`);
  return value;
}
function id(value: unknown) {
  const valueString = string(value, "identifier", 160);
  if (!valueString) throw new Error("Missing identifier.");
  return valueString;
}
const ids: ProviderId[] = ["codex", "claude", "opencode", "ollama"];
async function refreshProviders() {
  if (shutdown.state !== "idle") return providerInfo;
  if (refresh) return refresh;
  refresh = (async () => {
    await Promise.allSettled(
      providers.map(async (adapter) => {
        try {
          const info = await adapter.discover();
          providerInfo = providerInfo
            .filter((p) => p.id !== info.id)
            .concat(info)
            .sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
          send({ type: "changed" });
        } catch (error) {
          const previous = providerInfo.find((p) => p.id === adapter.id);
          if (previous)
            Object.assign(previous, {
              available: false,
              connectionLabel: "Connection failed",
              error: error instanceof Error ? error.message : String(error),
            });
          send({ type: "changed" });
        }
      }),
    );
    return providerInfo;
  })().finally(() => {
    refresh = undefined;
  });
  return refresh;
}
function updateSettings(input: unknown) {
  const patch = requireObject(input);
  const next: Partial<Settings> = {};
  if (patch.theme !== undefined) {
    if (!["system", "dark", "light"].includes(String(patch.theme)))
      throw new Error("Unknown theme.");
    next.theme = patch.theme as Settings["theme"];
    nativeTheme.themeSource = next.theme;
  }
  if (patch.sidebarWidth !== undefined)
    next.sidebarWidth = Math.max(
      200,
      Math.min(420, Number(patch.sidebarWidth) || 265),
    );
  if (patch.panelWidth !== undefined)
    next.panelWidth = Math.max(
      300,
      Math.min(1200, Number(patch.panelWidth) || 480),
    );
  if (patch.ollamaUrl !== undefined) {
    const url = new URL(string(patch.ollamaUrl, "Ollama address", 2048));
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error(
        "Use an HTTP(S) model endpoint without embedded credentials.",
      );
    next.ollamaUrl = url.toString().replace(/\/$/, "");
  }
  if (patch.defaultProvider !== undefined) {
    if (!ids.includes(patch.defaultProvider as ProviderId))
      throw new Error("Unknown provider.");
    next.defaultProvider = patch.defaultProvider as ProviderId;
  }
  const result = store.saveSettings(next);
  send({ type: "changed" });
  return result;
}
async function command(name: string, payload: unknown) {
  const p = payload === undefined ? {} : requireObject(payload);
  if (shutdown.state !== "idle" && name !== "app:diagnostics") {
    const draftOnly = name === "task:update" && p.patch && typeof p.patch === "object"
      && Object.keys(p.patch).length === 1 && Object.keys(p.patch)[0] === "draft";
    const readOnly = name === "app:snapshot" || name === "task:read" || name === "task:submissionStatus";
    if (!store?.db.open || (!draftOnly && !readOnly))
      throw new Error("Akorith is closing. Your saved work is retained. Choose Quit again if cleanup needs a retry.");
  }
  if (name === "mcp:list" || /^(plugins|context):/.test(name)) {
    return extensionCommand(name, p, { store, plugins, extensions,
      changed: () => send({ type: "changed" }),
      pickLocal: async () => {
        const result = await dialog.showOpenDialog(window!, { properties: ["openDirectory"], title: "Choose a local plugin" });
        return result.canceled ? null : { path: result.filePaths[0] };
      },
    });
  }
  if (name.startsWith('research:')) {
    if (!research) throw new Error('Research is not ready yet.');
    return researchCommand(name, p, research);
  }
  if (name.startsWith('benchmark:')) {
    const benchmarkId = name === 'benchmark:create' || name === 'benchmark:list' ? '' : id(p.benchmarkId);
    switch (name) {
      case 'benchmark:list': return benchmarks.list();
      case 'benchmark:create': { const record = benchmarks.create(p); send({type:'changed'}); return record; }
      case 'benchmark:read': return benchmarks.read(benchmarkId);
      case 'benchmark:start': return benchmarkRuntime!.start(benchmarkId);
      case 'benchmark:stop': return benchmarkRuntime!.stop(benchmarkId);
      case 'benchmark:annotate': { const record = benchmarks.annotate(benchmarkId, p.notes, p.variantId === undefined ? undefined : id(p.variantId)); send({type:'changed'}); return record; }
      case 'benchmark:media': {
        const record = benchmarks.read(benchmarkId), variant = record.variants.find(v => v.id === id(p.variantId));
        if (!variant?.evidence.some(e => e.id === id(p.evidenceId))) throw new Error('Evidence does not belong to this variant.');
        return benchmarkEvidence.preview(record, id(p.evidenceId));
      }
      case 'benchmark:addEvidence': {
        const record = benchmarks.read(benchmarkId), variantId = id(p.variantId);
        if (!record.variants.some(v => v.id === variantId && v.turnId)) throw new Error('Start the variant before adding evidence.');
        const picked = await dialog.showOpenDialog(window!, {title:'Add comparison evidence',properties:['openFile']});
        if (picked.canceled) return null;
        const path = picked.filePaths[0], extension = extname(path).toLowerCase();
        const kind = ['.mp4','.webm','.mov'].includes(extension) ? 'video' : ['.png','.jpg','.jpeg','.webp','.gif'].includes(extension) ? 'image' : 'artifact';
        const evidence = await benchmarkEvidence.capture({path,kind,label:basename(path).slice(0,200),origin:'user-selected'},[resolve(path,'..')]);
        const updated = benchmarks.recordEvidence(benchmarkId,variantId,evidence); send({type:'changed'}); return updated;
      }
      case 'benchmark:export': {
        const picked = await dialog.showOpenDialog(window!, {title:'Save comparison results',properties:['openDirectory','createDirectory']});
        if(picked.canceled) return null;
        const result = await exportBenchmarkComparison(benchmarks.read(benchmarkId),picked.filePaths[0],benchmarkEvidence.directory);
        const error = await shell.openPath(result.indexPath); if(error) throw new Error(error);
        return result;
      }
      default: throw new Error('Unknown benchmark command.');
    }
  }
  switch (name) {
    case "app:diagnostics":
      return {
        version: app.getVersion(),
        platform: process.platform,
        architecture: process.arch,
        uptimeSeconds: process.uptime(),
        mainMemory: process.memoryUsage(),
        processes: app.getAppMetrics(),
        windows: BrowserWindow.getAllWindows().length,
        providerRefreshPending: !!refresh,
        acceptedCommands: commandOperations.size,
        engine: engine?.diagnostics(),
        shutdown: shutdown.snapshot(),
      };
    case "app:snapshot":
      return {
        projects: store.projects(),
        tasks: store.tasks(),
        providers: providerInfo,
        settings: store.settings(),
        version: app.getVersion(),
      };
    case "providers:refresh":
      return refreshProviders();
    case "project:create": {
      const name = projectFolderName(p.name);
      const selected = await dialog.showOpenDialog(window!, { properties: ["openDirectory"], title: `Choose a location for ${name}`, buttonLabel: "Create project here" });
      if (selected.canceled) return null;
      const project = createProjectFolder(store, selected.filePaths[0], name);
      send({ type: "changed" }); return project;
    }
    case "project:pin": {
      if (typeof p.pinned !== 'boolean') throw new Error('Project pinned state must be a boolean.');
      const project = store.setProjectPinned(id(p.projectId), p.pinned);
      send({ type: 'changed' }); return project;
    }
    case "project:rename": {
      const project = store.renameProject(id(p.projectId), p.name);
      send({ type: "changed" }); return project;
    }
    case "project:open": {
      const selected = await dialog.showOpenDialog(window!, {
        properties: ["openDirectory", "createDirectory"],
        title: "Open a project",
      });
      if (selected.canceled) return null;
      const path = realpathSync(selected.filePaths[0]);
      const project = store.addProject(path, basename(path));
      send({ type: "changed" });
      return project;
    }
    case "project:add": {
      const path = realpathSync(string(p.path, "project path"));
      if (!statSync(path).isDirectory()) throw new Error("Choose a directory.");
      const project = store.addProject(path, basename(path));
      send({ type: "changed" });
      return project;
    }
    case "project:relocate": {
      const projectId=id(p.projectId),project=store.project(projectId)
      if(!project)throw new Error('Project not found.')
      const busy=()=>store.tasks().some(t=>t.projectId===projectId&&['queued','starting','running','waiting','cancelling'].includes(t.status))
      if(busy())throw new Error('Stop or finish this project’s active tasks before relocating its folder.')
      const selected=await dialog.showOpenDialog(window!,{properties:['openDirectory'],title:`Locate ${project.name}`,defaultPath:project.path})
      if(selected.canceled)return null
      if(busy())throw new Error('A task started while choosing the folder. Finish it and try again.')
      const path=realpathSync(selected.filePaths[0])
      if(store.projects().some(other=>other.id!==projectId&&other.path===path))throw new Error('That folder is already open as another project.')
      const next={...project,path}
      store.db.prepare('UPDATE projects SET path=?,data=? WHERE id=?').run(path,JSON.stringify(next),projectId)
      send({type:'changed'});return next
    }
    case "tasks:reorderPinned": {
      if(!Array.isArray(p.taskIds))throw new Error('Missing pinned task order.')
      const taskIds=p.taskIds.map(id),expected=store.tasks().filter(t=>t.pinned&&!t.archived).map(t=>t.id)
      if(taskIds.length!==expected.length||new Set(taskIds).size!==taskIds.length||taskIds.some(value=>!expected.includes(value)))throw new Error('The pinned tasks changed. Refresh and try again.')
      store.db.transaction(()=>taskIds.forEach((taskId,index)=>store.updateTask(taskId,{pinOrder:index})))()
      send({type:'changed'});return store.tasks()
    }
    case "task:create": {
      const providerId =
        p.providerId === undefined ? undefined : (p.providerId as ProviderId);
      if (providerId && !ids.includes(providerId))
        throw new Error("Unknown provider.");
      const selectedProvider = providerId ?? store.settings().defaultProvider;
      const catalog =
        providerInfo.find((info) => info.id === selectedProvider)?.models ?? [];
      const preferred =
        catalog.find(
          (model) => selectedProvider === "codex" && model.id === "gpt-6-astra",
        ) ?? catalog[0];
      const model =
        p.model === undefined
          ? (preferred?.id ?? "")
          : string(p.model, "model", 200);
      const created = store.createTask({
        projectId:
          p.projectId === null || p.projectId === undefined
            ? null
            : id(p.projectId),
        providerId: selectedProvider,
        model,
      });
      const efforts = catalog.find((item) => item.id === model)?.efforts ?? [];
      const task = store.updateTask(created.id, {
        effort: efforts.includes("high")
          ? "high"
          : efforts.includes("medium")
            ? "medium"
            : (efforts[0] ?? ""),
      });
      cwd(task);
      send({ type: "changed" });
      return task;
    }
    case "task:read": {
      const taskId = id(p.taskId);
      return {
        task: store.task(taskId),
        messages: store.messages(taskId),
        pending: engine.pending(taskId),
      };
    }
    case "task:update": {
      const taskId = id(p.taskId),
        patch = requireObject(p.patch),
        next: Partial<Task> = {};
      if (patch.title !== undefined) {
        const title = string(patch.title, "title", 200).trim();
        if (!title) throw new Error("Give the task a title.");
        next.title = title;
      }
      if (patch.draft !== undefined)
        next.draft = string(patch.draft, "draft", 200_000);
      for (const key of ["pinned", "archived"] as const)
        if (patch[key] !== undefined) {
          if (typeof patch[key] !== "boolean")
            throw new Error(`Invalid ${key}.`);
          next[key] = patch[key] as boolean;
        }
      if (patch.providerId !== undefined) {
        if (!ids.includes(patch.providerId as ProviderId))
          throw new Error("Unknown provider.");
        next.providerId = patch.providerId as ProviderId;
      }
      if (patch.model !== undefined)
        next.model = string(patch.model, "model", 200);
      if (patch.effort !== undefined)
        next.effort = string(patch.effort, "reasoning effort", 40);
      if (patch.mode !== undefined) {
        if (!["read", "work", "full"].includes(String(patch.mode)))
          throw new Error("Unknown permission mode.");
        next.mode = patch.mode as Task["mode"];
      }
      if(next.pinned===true&&store.task(taskId).pinOrder===undefined){const orders=store.tasks().filter(t=>t.pinned).map(t=>t.pinOrder??0);next.pinOrder=(orders.length?Math.max(...orders):-1)+1}
      const task = store.updateTask(taskId, next);
      send({ type: "task", task });
      return task;
    }
    case "task:send": {
      const taskId = id(p.taskId),
        attachments: Array<Attachment> = [];
      if (p.attachments !== undefined) {
        if (!Array.isArray(p.attachments) || p.attachments.length > 20)
          throw new Error("Too many attachments.");
        for (const entry of p.attachments) {
          const a = requireObject(entry);
          const dir = realpathSync(join(userData, "attachments", taskId));
          const path = realpathSync(string(a.path, "attachment path"));
          const rel = relative(dir, path);
          if (
            rel.startsWith("..") ||
            isAbsolute(rel) ||
            !statSync(path).isFile()
          )
            throw new Error("Attachment is outside this task.");
          attachments.push({
            id: id(a.id),
            name: string(a.name ?? basename(path), "attachment name", 500),
            path,
            size: statSync(path).size,
            mimeType: string(
              a.mimeType ?? "application/octet-stream",
              "MIME type",
              100,
            ),
          });
        }
      }
      return engine.send(
        taskId,
        id(p.requestId),
        string(p.prompt, "message", 200_000),
        attachments,
      );
    }
    case "task:submissionStatus":
      return store.submissionStatus(id(p.taskId), id(p.requestId));
    case "task:queue": {
      const taskId = id(p.taskId);
      store.task(taskId);
      return store.queued(taskId);
    }
    case "task:queueEdit":
      return engine.editQueued(
        id(p.taskId),
        id(p.turnId),
        string(p.prompt, "message", 200_000),
      );
    case "task:queueRemove":
      return engine.cancelQueued(id(p.taskId), id(p.turnId));
    case "task:queueReorder": {
      if(!Array.isArray(p.turnIds)||p.turnIds.length>1000)throw new Error('Invalid queued message order.')
      return engine.reorderQueued(id(p.taskId),p.turnIds.map(id))
    }
    case "task:stop":
      return engine.stop(id(p.taskId));
    case "task:steer":
      return engine.steer(id(p.taskId), string(p.text, "guidance", 100_000));
    case "task:respond":
      return engine.respond(id(p.taskId), id(p.requestId), p.response);
    case "projectFiles:search":
    case "projectFiles:attach": {
      const taskId = id(p.taskId), task = store.task(taskId);
      const project = task.projectId ? store.project(task.projectId) : null;
      if (!project) throw new Error("Choose an existing project before mentioning files.");
      if (name === "projectFiles:search" && typeof p.query !== "string") throw new Error("Invalid project file search.");
      return name === "projectFiles:search"
        ? searchProjectFiles(project.path, p.query as string)
        : attachProjectFile(project.path, string(p.path, "project file", 2000), userData, taskId);
    }
    case "attachments:add": {
      const taskId = id(p.taskId);
      store.task(taskId);
      const picked = await dialog.showOpenDialog(window!, {
        properties: ["openFile", "multiSelections"],
        title: "Attach files",
      });
      if (picked.canceled) return [];
      const dir = join(userData, "attachments", taskId);
      mkdirSync(dir, { recursive: true });
      const result: Attachment[] = [];
      for (const file of picked.filePaths.slice(0, 20)) {
        const info = await stat(file);
        if (info.size > 25 * 1024 * 1024)
          throw new Error("Each attachment must be smaller than 25 MB.");
        const attachmentId = randomUUID(),
          name = basename(file),
          path = join(dir, `${attachmentId}-${name}`);
        await copyFile(file, path);
        const mime: Record<string, string> = {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".webp": "image/webp",
          ".pdf": "application/pdf",
          ".txt": "text/plain",
          ".md": "text/markdown",
        };
        result.push({
          id: attachmentId,
          name,
          path,
          size: info.size,
          mimeType:
            mime[extname(name).toLowerCase()] ?? "application/octet-stream",
        });
      }
      return result;
    }
    case "settings:update":
      return updateSettings(p.patch);
    case "skills:list":
      return extensions.skills();
    case "skills:toggle": {
      if (typeof p.enabled !== "boolean")
        throw new Error("Invalid skill state.");
      const result = await extensions.toggle(id(p.id), p.enabled);
      send({ type: "changed" });
      return result;
    }
    case "mcp:save": {
      const input = requireObject(p.server);
      if (input.plugin !== undefined) throw new Error("Plugin MCP servers are managed through their plugin.");
      const server: McpServer = {
        id: input.id ? id(input.id) : randomUUID(),
        name: string(input.name, "server name", 100),
        command: string(input.command, "server command", 2000),
        args: Array.isArray(input.args)
          ? input.args.map((a) => string(a, "server argument", 4000))
          : [],
        enabled: input.enabled === true,
        projectId: input.projectId == null ? undefined : id(input.projectId),
      };
      assertManualMcp(store, server);
      const existing = store.settings().mcpServers.find(item => item.id === server.id);
      if (existing) assertManualMcp(store, existing, false);
      if (!server.name.trim() || !server.command.trim())
        throw new Error("Name and command are required.");
      const servers = store
        .settings()
        .mcpServers.filter((s) => s.id !== server.id)
        .concat(server);
      store.saveSettings({ mcpServers: servers });
      send({ type: "changed" });
      return servers;
    }
    case "mcp:probe": {
      const server = store.settings().mcpServers.find((s) => s.id === id(p.id));
      if (!server) throw new Error("Server not found.");
      assertManualMcp(store, server);
      const result = await extensions.probe(server);
      store.saveSettings({
        mcpServers: store
          .settings()
          .mcpServers.map((s) => (s.id === result.id ? result : s)),
      });
      send({ type: "changed" });
      return result;
    }
    case "mcp:remove": {
      const serverId = id(p.id);
      const existing = store.settings().mcpServers.find(item => item.id === serverId);
      if (existing) assertManualMcp(store, existing, false);
      const servers = store
        .settings()
        .mcpServers.filter((s) => s.id !== id(p.id));
      store.saveSettings({ mcpServers: servers });
      send({ type: "changed" });
      return servers;
    }
    case "checkpoints:list": {
      const taskId=id(p.taskId),turnId=id(p.turnId);store.task(taskId)
      if(turnId.startsWith('import:'))return null
      return checkpoints.list(turnId,taskId)
    }
    case "checkpoints:read":return checkpoints.read(id(p.taskId),id(p.turnId),string(p.path,'checkpoint path',4000))
    case "checkpoints:undo": {
      const taskId=id(p.taskId),task=store.task(taskId)
      if(task.mode==='read')throw new Error('Switch to Workspace or Full access to restore a file.')
      const path=cwd(task)
      const result=await engine.withWorkspaceLock(path,()=>checkpoints.undo(taskId,id(p.turnId),string(p.path,'checkpoint path',4000),path))
      send({type:'changed',taskId});return result
    }
    case "history:import": {
      const result = await importLegacy(store, userData);
      send({ type: "changed" });
      return result;
    }
    case "app:openExternal": {
      const url = new URL(string(p.url, "URL", 8000));
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error("Only public HTTP(S) links can be opened.");
      return shell.openExternal(url.toString());
    }
    case "app:reveal": {
      const context = getContext(id(p.taskId)),
        path = realpathSync(resolve(context.cwd, string(p.path, "path"))),
        rel = relative(context.cwd, path);
      if (rel.startsWith("..") || isAbsolute(rel))
        throw new Error("This file is outside the project.");
      shell.showItemInFolder(path);
      return;
    }
    default:
      if (/^(files|git|terminal|browser|computer|preview):/.test(name))
        return host.invoke(name, p);
      throw new Error("Unknown application command.");
  }
}
async function createWindow() {
  window = new BrowserWindow({
    title: "Akorith Next",
    width: 1440,
    height: 920,
    minWidth: 760,
    minHeight: 560,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#181818" : "#faf9f7",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 19 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  observeShellLifecycle(
    window.webContents,
    () => host?.invoke("browser:hideAll", {}),
    (event) => console.info("[akorith:shell]", JSON.stringify(event)),
  );
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (["http:", "https:"].includes(parsed.protocol))
        void shell.openExternal(url);
    } catch {}
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window?.webContents.getURL()) event.preventDefault();
  });
  window.once("ready-to-show", () => window?.show());
  window.on("closed", () => {
    window = null;
  });
  if (process.env.ELECTRON_RENDERER_URL)
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await window.loadFile(join(__dirname, "../renderer/index.html"));
}
app
  .whenReady()
  .then(async () => {
    mkdirSync(userData, { recursive: true });
    store = new Store(join(userData, "workspace.sqlite"));
    benchmarks = new BenchmarkStore(store); benchmarks.reconcile();
    benchmarkEvidence = new BenchmarkEvidenceFiles(join(userData,'benchmarks','evidence'));
    // Native sessions can retain MCP assets beyond a turn. Without a complete
    // ownership proof, cleanup reports usage_unknown and preserves those copies.
    plugins = new PluginManager({ db: store.db, userData });
    extensions = new Extensions(store, { plugins });
    checkpoints = new CheckpointManager(userData);
    nativeTheme.themeSource = store.settings().theme;
    host = createHostTools({
      getContext,
      getReadRoots: async (taskId, turnId) => engine?.contextRoots(taskId, turnId) ?? [],
      getWindow: () => window,
      emit: (event) => {
        if (window && !window.isDestroyed())
          window.webContents.send("akorith:host", event);
      },
      userData,
    });
    providers = createProviders(host, {
      getOllamaUrl: () => store.settings().ollamaUrl,
      getLocalToolPolicy: request => benchmarkRuntime?.localPolicy(request) ?? null,
    });
    providerInfo = providers.map((p) => ({
      id: p.id,
      name:
        p.id === "codex"
          ? "Codex"
          : p.id === "ollama"
            ? "Ollama"
            : p.id === "claude"
              ? "Claude Code"
              : "OpenCode",
      available: false,
      models: [],
      error: "Checking connection…",
      connectionLabel: "Checking",
      capabilities: {
        resume: false,
        steer: false,
        tools: false,
        approvals: false,
        images: false,
      },
    }));
    engine = new Engine(
      store,
      providers,
      cwd,
      (task, turnId, signal) => {
        if (!turnId) throw new Error("Turn context requires an accepted turn ID.");
        return extensions.prepare(task, turnId, signal);
      },
      send,
      {
        executionStarted: (task,turnId) => benchmarkRuntime?.executionStarted(task,turnId),
        executionSettled: (task,turnId) => benchmarkRuntime?.executionSettled(task,turnId),
        beforeRun:async(task,turnId,path)=>{await checkpoints.begin(task.id,turnId,path)},
        afterRun:async(task,turnId,path)=>{
          const summary=await checkpoints.finish(task.id,turnId,path)
          const activities:import('../shared/contracts').Activity[]=[]
          if(summary.changes.length)activities.push({id:`checkpoint:${turnId}`,kind:'file',title:`Changed ${summary.changes.length} ${summary.changes.length===1?'file':'files'}`,detail:summary.changes.map(change=>`${change.status}: ${change.path}`).join('\n'),status:'completed',startedAt:summary.startedAt,endedAt:summary.finishedAt})
          if(summary.warnings.length)activities.push({id:`checkpoint-warning:${turnId}`,kind:'status',title:'Change tracking is limited',detail:summary.warnings.join('\n'),status:'completed',startedAt:summary.startedAt,endedAt:summary.finishedAt})
          return activities
        }
      }
    );
    research = new ResearchService(store, engine, userData, () => send({ type: 'changed' }));
    benchmarkRuntime = new BenchmarkRuntime({benchmarks,engine,directory:join(userData,'benchmarks','workspaces'),changed:()=>send({type:'changed'}),notice:text=>send({type:'notice',text}),evidence:benchmarkEvidence,
      recorder:new BenchmarkBrowserRecorder({directory:join(userData,'benchmarks','recordings'),ffmpeg:'/opt/homebrew/bin/ffmpeg',captureFrame:async(taskId,turnId,signal)=>{
        const tabs = await host.invoke('browser:list',{taskId}) as Array<{id:string}>;
        if(!tabs.length)return null;
        const result = await host.execute('browser_screenshot',{id:tabs[0].id},{...getContext(taskId),turnId},signal) as {dataUrl:string};
        return result.dataUrl;
      }})});
    ipcMain.handle("akorith:command", async (event, input: unknown) => {
      try {
        if (
          !window ||
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame
        )
          throw new Error("Untrusted application request.");
        const request = requireObject(input);
        const value = await commandOperations.run(() => command(
          string(request.command, "command", 100),
          request.payload,
        ));
        return { ok: true, value };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "Akorith Next",
          submenu: [
            { role: "about" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
        {
          label: "Edit",
          submenu: [
            { role: "undo" },
            { role: "redo" },
            { type: "separator" },
            { role: "cut" },
            { role: "copy" },
            { role: "paste" },
            { role: "selectAll" },
          ],
        },
        {
          label: "View",
          submenu: [
            { role: "reload" },
            { role: "toggleDevTools" },
            { role: "resetZoom" },
            { role: "zoomIn" },
            { role: "zoomOut" },
            { role: "togglefullscreen" },
          ],
        },
        {
          label: "Window",
          submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "front" }],
        },
      ]),
    );
    globalShortcut.register("CommandOrControl+Shift+Escape", () => {
      void host.invoke("computer:stop", {});
    });
    await createWindow();
    void refreshProviders();
    app.on("activate", () => {
      if (!window) void createWindow();
    });
  })
  .catch((error) => {
    console.error(
      "Akorith startup failed:",
      error instanceof Error ? error.message : String(error),
    );
    app.exit(1);
  });
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", (event) => {
  if (shutdown.state === "ready") return;
  event.preventDefault();
  if (shutdown.state === "stopping") return;
  void shutdown.run().then(() => {
    globalShortcut.unregisterAll();
    app.quit();
  }).catch(async (error) => {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("Akorith could not finish quitting:", detail);
    try {
      if (!window) await createWindow();
      window?.show();
      send({ type: "notice", text: `Could not finish quitting: ${detail}. Saved work is retained. Choose Quit again to retry cleanup.` });
    } catch (windowError) {
      console.error("Could not show shutdown status:", windowError instanceof Error ? windowError.message : String(windowError));
    }
  });
});

process.once("SIGTERM", () => app.quit());
