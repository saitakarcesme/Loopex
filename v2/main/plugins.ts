import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { LocalPluginManifest, ManagedPlugin, PluginCleanupResult, PluginFile, PluginImportResult, PluginInspection, PluginRecovery, PluginRegistrySnapshot, PluginVersion, PluginVersionRef } from "../shared/plugin-contracts";

const MANIFEST = "akorith.plugin.json";
const OWNER = ".akorith-owner.json";
const LIMITS = { manifest: 64 * 1024, files: 512, fileBytes: 8 * 1024 * 1024, totalBytes: 32 * 1024 * 1024, components: 32, depth: 12 };
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => compare(a, b))) : item);

export class PluginManagerError extends Error {
  override name = "PluginManagerError";
  constructor(readonly code: string, text: string, readonly recovery?: PluginRecovery) { super(text); }
}
function fail(text: string): never { throw new PluginManagerError("INVALID_PLUGIN", text); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[], label: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`Unsupported ${label} field: ${key}. No hooks, lifecycle scripts or dependency installation are supported.`);
}
function text(value: unknown, label: string, max = 1024): string {
  if (typeof value !== "string" || !value.trim().length || value.length > max || value.includes("\0")) fail(`Invalid ${label}.`);
  return value;
}
function id(value: unknown, label: string): string {
  const result = text(value, label, 80);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(result) || result.endsWith(".") || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) fail(`Unsafe ${label}.`);
  return result;
}
function relativePath(value: unknown, label: string): string {
  const result = text(value, label);
  const pieces = result.split("/");
  if (isAbsolute(result) || result.includes("\\") || /^[a-z]:/i.test(result) || pieces.some(piece => !piece || [".", ".."].includes(piece) || /[\x00-\x1f<>:"|?*]/.test(piece) || /[. ]$/.test(piece) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(piece))) fail(`Unsafe ${label}: ${result}`);
  if (pieces.length > LIMITS.depth || pieces.some(piece => piece === OWNER || /^\.env(?:\.|$)/i.test(piece))) fail(`Unsupported ${label}: ${result}`);
  return result;
}
function version(value: unknown): string {
  const result = text(value, "plugin version", 100);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.test(result)) fail("Plugin version must be a semantic version such as 1.0.0.");
  const prerelease = result.split("+")[0].split("-").slice(1).join("-");
  if (prerelease.split(".").some(part => /^0\d+$/.test(part))) fail("Numeric prerelease identifiers cannot have leading zeroes.");
  return result;
}
function array(value: unknown, label: string, max = LIMITS.components): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(`${label} must be an array with at most ${max} entries.`);
  return value;
}
function parseManifest(value: unknown): LocalPluginManifest {
  const input = object(value, "manifest");
  fields(input, ["schemaVersion", "id", "version", "name", "description", "skills", "mcpServers", "assets"], "manifest");
  if (input.schemaVersion !== 1) fail("Only plugin schemaVersion 1 is supported.");
  const identifiers = new Set<string>();
  const componentId = (value: unknown) => { const result = id(value, "component id"); if (identifiers.has(result)) fail(`Duplicate component id: ${result}`); identifiers.add(result); return result; };
  const skills = array(input.skills ?? [], "skills").map(raw => {
    const skill = object(raw, "skill"); fields(skill, ["id", "path"], "skill");
    const path = relativePath(skill.path, "skill path");
    if (basename(path) !== "SKILL.md") fail("Each skill path must name SKILL.md.");
    return { id: componentId(skill.id), path };
  });
  const mcpServers = array(input.mcpServers ?? [], "mcpServers").map(raw => {
    const server = object(raw, "MCP server"); fields(server, ["id", "name", "command", "args"], "MCP server");
    const command = text(server.command, "MCP command");
    if (command.trim() !== command || /[\r\n]/.test(command) || (!isAbsolute(command) && !command.startsWith("{pluginRoot}/") && /[\s/\\]/.test(command))) fail("MCP command must be one executable name, an absolute path, or {pluginRoot}/relative-file. It is never a shell string.");
    const args = array(server.args ?? [], "MCP arguments", 64).map(value => {
      if (typeof value !== "string" || value.length > 4096 || value.includes("\0")) fail("Invalid MCP argument.");
      return value;
    });
    return { id: componentId(server.id), name: text(server.name, "MCP name", 200), command, args };
  });
  if (!skills.length && !mcpServers.length) fail("A plugin must declare at least one skill or MCP server.");
  return { schemaVersion: 1, id: id(input.id, "plugin id"), version: version(input.version), name: text(input.name, "plugin name", 200), ...(input.description === undefined ? {} : { description: text(input.description, "description", 2000) }), skills, mcpServers, assets: array(input.assets ?? [], "assets", 128).map(value => relativePath(value, "asset path")) };
}
function contained(root: string, target: string) {
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail("Plugin path escapes its selected root.");
}
async function checkedPath(root: string, path: string) {
  const rel = relative(root, path); contained(root, path);
  for (const part of rel ? rel.split(sep).map((_, index, pieces) => join(root, ...pieces.slice(0, index + 1))) : [root]) {
    const info = await lstat(part);
    if (info.isSymbolicLink()) fail(`Symlinks are not supported in plugin paths: ${part}`);
  }
  contained(root, await realpath(path));
}
async function readRegular(root: string, path: string, limit: number) {
  await checkedPath(root, path);
  const initial = await lstat(path);
  if (!initial.isFile() || initial.nlink !== 1 || initial.size > limit) fail(`Plugin file must be regular, have one link, and be within the size limit: ${path}`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > limit) fail(`Plugin file must be regular, have one link, and be within the size limit: ${path}`);
    const chunks: Buffer[] = []; let length = 0;
    while (length <= limit) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, limit + 1 - length));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, length);
      if (!bytesRead) break;
      chunks.push(buffer.subarray(0, bytesRead)); length += bytesRead;
    }
    const data = Buffer.concat(chunks, length);
    const after = await handle.stat();
    await checkedPath(root, path);
    const current = await lstat(path);
    if (data.length > limit || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== current.ino || before.dev !== current.dev) fail(`Plugin file changed while being inspected: ${path}`);
    return { data, executable: !!(before.mode & 0o111) };
  } finally { await handle.close(); }
}
interface Inspected extends PluginInspection { contents: Map<string, { data: Buffer; executable: boolean }> }
function expand(value: string, root: string) { return value.split("{pluginRoot}").join(root); }
function checkPlaceholders(manifest: LocalPluginManifest, paths: Set<string>) {
  for (const server of manifest.mcpServers) for (const value of [server.command, ...server.args]) {
    if (!value.includes("{pluginRoot}")) continue;
    if (value.split("{pluginRoot}").length !== 2) fail("Only one {pluginRoot} placeholder is supported per argument.");
    const [prefix, suffix] = value.split("{pluginRoot}");
    if (prefix && !/^--[a-zA-Z0-9_-]+=$/.test(prefix)) fail("{pluginRoot} must start a path or follow --option=.");
    if (!suffix) { if (value === server.command) fail("The MCP command cannot be the plugin directory."); continue; }
    if (!suffix.startsWith("/")) fail("{pluginRoot} must be followed by a relative path.");
    const target = relativePath(suffix.slice(1), "pluginRoot path");
    const exists = paths.has(target) || (value !== server.command && [...paths].some(path => path.startsWith(`${target}/`)));
    if (!exists) fail(`MCP path is not a declared copied component or asset: ${target}`);
  }
}

export interface PluginManagerOptions {
  db: Database.Database;
  userData: string;
  /** Must account for queued and active turns. Omission/errors retain all versions. */
  isVersionInUse?: (version: PluginVersionRef) => boolean | Promise<boolean>;
}
interface Row { id: string; name: string; enabled: number; selected_digest: string | null; removed: number; revision: number }
interface VersionRow { plugin_id: string; version: string; digest: string; manifest: string; files: string; source_path: string; imported_at: number; state: "ready" | "removed" }
interface OperationRow { operation_id: string; plugin_id: string; version: string; digest: string; phase: string; error: string | null }

/** One manager per Store connection; manager never closes the caller-owned database. */
export class PluginManager {
  private readonly db: Database.Database;
  private readonly managerId: string;
  private queue: Promise<unknown> = Promise.resolve();
  private root?: string;
  private pins = new Map<string, PluginVersionRef[]>();
  constructor(private readonly options: PluginManagerOptions) {
    this.db = options.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS akorith_plugin_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS akorith_plugins(id TEXT PRIMARY KEY,name TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,selected_digest TEXT,removed INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS akorith_plugin_versions(plugin_id TEXT NOT NULL,version TEXT NOT NULL,digest TEXT NOT NULL,manifest TEXT NOT NULL,files TEXT NOT NULL,source_path TEXT NOT NULL,imported_at INTEGER NOT NULL,state TEXT NOT NULL,PRIMARY KEY(plugin_id,digest),UNIQUE(plugin_id,version),FOREIGN KEY(plugin_id) REFERENCES akorith_plugins(id));
      CREATE TABLE IF NOT EXISTS akorith_plugin_operations(operation_id TEXT PRIMARY KEY,plugin_id TEXT NOT NULL,version TEXT NOT NULL,digest TEXT NOT NULL,phase TEXT NOT NULL,error TEXT);
    `);
    this.db.prepare("INSERT OR IGNORE INTO akorith_plugin_meta(key,value) VALUES('managerId',?)").run(randomUUID());
    this.managerId = (this.db.prepare("SELECT value FROM akorith_plugin_meta WHERE key='managerId'").get() as { value: string }).value;
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work); this.queue = result.catch(() => {}); return result;
  }
  private async managedRoot() {
    if (this.root) { await checkedPath(this.root, this.root); return this.root; }
    await mkdir(this.options.userData, { recursive: true });
    const userData = await realpath(this.options.userData);
    let root = userData;
    for (const piece of ["extensions", "plugins"]) {
      root = join(root, piece);
      try { await mkdir(root, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const info = await lstat(root); if (!info.isDirectory() || info.isSymbolicLink()) fail("Managed plugin root must contain only real directories.");
    }
    this.root = root; return root;
  }
  private async inspect(source: string): Promise<Inspected> {
    const sourcePath = resolve(source);
    const rootInfo = await lstat(sourcePath); if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail("Select a real local plugin directory, not a symlink.");
    const root = await realpath(sourcePath);
    const raw = await readRegular(root, join(root, MANIFEST), LIMITS.manifest);
    let parsed: unknown;
    try { parsed = JSON.parse(raw.data.toString("utf8")); } catch { fail("akorith.plugin.json must be valid JSON."); }
    const manifest = parseManifest(parsed);
    const contents = new Map<string, { data: Buffer; executable: boolean }>();
    const normalized = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
    if (normalized.length > LIMITS.manifest) fail("Normalized plugin manifest exceeds the 64 KiB limit.");
    contents.set(MANIFEST, { data: normalized, executable: false });
    let bytes = contents.get(MANIFEST)!.data.length;
    let visited = 0;
    const add = async (name: string, allowDirectory: boolean, depth = 0): Promise<void> => {
      relativePath(name, "declared file"); if (contents.has(name)) return;
      if (depth > LIMITS.depth || ++visited > LIMITS.files * 2) fail("Plugin directory traversal limit exceeded.");
      const path = join(root, name); await checkedPath(root, path); const info = await lstat(path);
      if (info.isDirectory()) {
        if (!allowDirectory) fail(`Skill path is not a file: ${name}`);
        for await (const entry of await opendir(path)) await add(`${name}/${entry.name}`, true, depth + 1);
        return;
      }
      const content = await readRegular(root, path, LIMITS.fileBytes);
      bytes += content.data.length; if (bytes > LIMITS.totalBytes || contents.size >= LIMITS.files) fail("Plugin file count or total byte limit exceeded.");
      contents.set(name, content);
    };
    for (const skill of manifest.skills) await add(skill.path, false);
    for (const asset of manifest.assets) await add(asset, true);
    const files: PluginFile[] = [...contents].map(([path, content]) => ({ path, bytes: content.data.length, sha256: hash(content.data), executable: content.executable })).sort((a, b) => compare(a.path, b.path));
    checkPlaceholders(manifest, new Set(contents.keys()));
    return { sourcePath: root, manifest, digest: hash(canonical({ manifest, files })), files, totalBytes: bytes, contents };
  }
  async inspectLocal(source: string): Promise<PluginInspection> { const { contents: _, ...inspection } = await this.inspect(source); return inspection; }
  private ref(row: VersionRow | OperationRow): PluginVersionRef { return { pluginId: row.plugin_id, version: row.version, digest: row.digest }; }
  private recovery(row: OperationRow): PluginRecovery { return { ...this.ref(row), operationId: row.operation_id, phase: row.phase, ...(row.error ? { error: row.error } : {}) }; }
  private async directory(ref: PluginVersionRef) { id(ref.pluginId, "registered plugin id"); if (!/^[a-f0-9]{64}$/.test(ref.digest)) fail("Invalid registered plugin digest."); return join(await this.managedRoot(), ref.pluginId, ref.digest); }
  private async versionInfo(row: VersionRow): Promise<PluginVersion> {
    const rootPath = join(await this.directory(this.ref(row)), "content"), manifest = parseManifest(JSON.parse(row.manifest));
    return { ...this.ref(row), rootPath, manifest, files: JSON.parse(row.files), importedAt: row.imported_at, state: row.state, sourcePath: row.source_path, resolvedMcpServers: manifest.mcpServers.map(server => ({ ...server, command: expand(server.command, rootPath), args: server.args.map(arg => expand(arg, rootPath)) })) };
  }
  private async pluginInfo(row: Row): Promise<ManagedPlugin> {
    const versions = this.db.prepare("SELECT * FROM akorith_plugin_versions WHERE plugin_id=? ORDER BY imported_at,digest").all(row.id) as VersionRow[];
    return { id: row.id, name: row.name, enabled: !!row.enabled, selectedDigest: row.selected_digest, removed: !!row.removed, revision: row.revision, versions: await Promise.all(versions.map(version => this.versionInfo(version))) };
  }
  async list(): Promise<PluginRegistrySnapshot> {
    return { plugins: await Promise.all((this.db.prepare("SELECT * FROM akorith_plugins ORDER BY id").all() as Row[]).map(row => this.pluginInfo(row))), recovery: (this.db.prepare("SELECT * FROM akorith_plugin_operations ORDER BY operation_id").all() as OperationRow[]).map(row => this.recovery(row)) };
  }
  acquireEnabled(turnId: string): Promise<PluginVersion[]> {
    return this.serial(async () => {
      if (!turnId || this.pins.has(turnId)) throw new PluginManagerError("INVALID_TURN_PIN", "A unique turn ID is required to acquire plugin versions.");
      const rows = this.db.prepare("SELECT v.* FROM akorith_plugin_versions v JOIN akorith_plugins p ON p.id=v.plugin_id AND p.selected_digest=v.digest WHERE p.enabled=1 AND p.removed=0 AND v.state='ready' ORDER BY p.id").all() as VersionRow[];
      // Pin the complete selection under the same lock as Remove before any filesystem await.
      this.pins.set(turnId, rows.map(row => this.ref(row)));
      try {
        const versions: PluginVersion[] = [];
        for (const row of rows) { await this.verifyVersion(row); versions.push(await this.versionInfo(row)); }
        return versions;
      } catch (error) { this.pins.delete(turnId); throw error; }
    });
  }
  releaseTurn(turnId: string): Promise<void> { return this.serial(async () => { this.pins.delete(turnId); }); }
  private async get(pluginId: string) {
    const row = this.db.prepare("SELECT * FROM akorith_plugins WHERE id=?").get(id(pluginId, "plugin id")) as Row | undefined;
    if (!row) throw new PluginManagerError("PLUGIN_NOT_FOUND", "Managed plugin not found.");
    return this.pluginInfo(row);
  }
  private owner(ref: PluginVersionRef, operationId: string) { return { schemaVersion: 1, managerId: this.managerId, ...ref, operationId }; }
  private async verifyOwner(directory: string, ref: PluginVersionRef, operationId?: string) {
    const root = await this.managedRoot(); await checkedPath(root, directory);
    const record = JSON.parse((await readRegular(root, join(directory, OWNER), 4096)).data.toString("utf8"));
    if (record.schemaVersion !== 1 || record.managerId !== this.managerId || record.pluginId !== ref.pluginId || record.digest !== ref.digest || record.version !== ref.version || (operationId && record.operationId !== operationId)) throw new PluginManagerError("OWNERSHIP_UNCONFIRMED", "Managed-copy ownership marker does not match its registry.");
  }
  private async verifyVersion(row: VersionRow) {
    const directory = await this.directory(this.ref(row)); await this.verifyOwner(directory, this.ref(row));
    const inspected = await this.inspect(join(directory, "content"));
    if (inspected.digest !== row.digest) throw new PluginManagerError("PLUGIN_CHANGED", "The managed plugin copy changed; import a new version instead of activating it.");
  }
  importLocal(source: string, options: { expectedDigest?: string } = {}): Promise<PluginImportResult> {
    return this.serial(async () => {
      const inspection = await this.inspect(source), { manifest, digest } = inspection;
      if (options.expectedDigest && options.expectedDigest !== digest) throw new PluginManagerError("SOURCE_CHANGED", "Plugin contents changed after inspection. Inspect the current copy before importing.");
      const old = this.db.prepare("SELECT * FROM akorith_plugin_versions WHERE plugin_id=? AND version=?").get(manifest.id, manifest.version) as VersionRow | undefined;
      if (old && old.digest !== digest) throw new PluginManagerError("VERSION_CONFLICT", "This plugin version already has different content. Increment its version; existing copies are never overwritten.");
      if (old?.state === "ready") {
        await this.verifyVersion(old);
        this.db.prepare("UPDATE akorith_plugins SET removed=0,revision=revision+1 WHERE id=? AND removed=1").run(manifest.id);
        return { plugin: await this.get(manifest.id), version: await this.versionInfo(old), imported: false, activationChanged: false };
      }
      if (this.db.prepare("SELECT 1 FROM akorith_plugin_operations WHERE plugin_id=? AND version=?").get(manifest.id, manifest.version)) throw new PluginManagerError("RECOVERY_REQUIRED", "An earlier import needs recovery before retrying this version.");
      const root = await this.managedRoot(), operationId = randomUUID(), ref = { pluginId: manifest.id, version: manifest.version, digest };
      const stages = join(root, ".staging"); await mkdir(stages, { recursive: true, mode: 0o700 }); await checkedPath(root, stages);
      const staging = join(stages, operationId), destination = await this.directory(ref);
      this.db.prepare("INSERT INTO akorith_plugin_operations(operation_id,plugin_id,version,digest,phase) VALUES(?,?,?,?,?)").run(operationId, manifest.id, manifest.version, digest, "copying");
      let published = false;
      try {
        await mkdir(staging, { mode: 0o700 }); await writeFile(join(staging, OWNER), JSON.stringify(this.owner(ref, operationId)), { flag: "wx", mode: 0o600 });
        for (const file of inspection.files) {
          const target = join(staging, file.path); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await checkedPath(staging, dirname(target));
          const value = inspection.contents.get(file.path)!;
          await writeFile(target, value.data, { flag: "wx", mode: value.executable ? 0o700 : 0o600 });
        }
        const parent = dirname(destination); await mkdir(parent, { recursive: true, mode: 0o700 }); await checkedPath(root, parent);
        // Exclusive wrapper prevents POSIX rename from replacing an existing empty version directory.
        await mkdir(destination, { mode: 0o700 });
        await writeFile(join(destination, OWNER), JSON.stringify(this.owner(ref, operationId)), { flag: "wx", mode: 0o600 });
        await rename(staging, join(destination, "content")); published = true;
        this.db.prepare("UPDATE akorith_plugin_operations SET phase='published' WHERE operation_id=?").run(operationId);
        this.db.transaction(() => {
          this.db.prepare("INSERT INTO akorith_plugins(id,name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET removed=0,revision=revision+1").run(manifest.id, manifest.name);
          this.db.prepare("INSERT INTO akorith_plugin_versions(plugin_id,version,digest,manifest,files,source_path,imported_at,state) VALUES(?,?,?,?,?,?,?,'ready') ON CONFLICT(plugin_id,digest) DO UPDATE SET state='ready',source_path=excluded.source_path,imported_at=excluded.imported_at").run(manifest.id, manifest.version, digest, JSON.stringify(manifest), JSON.stringify(inspection.files), inspection.sourcePath, Date.now());
          this.db.prepare("DELETE FROM akorith_plugin_operations WHERE operation_id=?").run(operationId);
        })();
        const plugin = await this.get(manifest.id), stored = plugin.versions.find(version => version.digest === digest)!;
        return { plugin, version: stored, imported: true, activationChanged: false };
      } catch (error) {
        // Preserve published data if SQLite commit failed. Recovery never guesses it was registered.
        if (!published) try { await this.verifyOwner(staging, ref, operationId); await rm(staging, { recursive: true }); } catch {}
        try { this.db.prepare("UPDATE akorith_plugin_operations SET error=? WHERE operation_id=?").run(message(error), operationId); } catch {}
        const recovery: PluginRecovery = { ...ref, operationId, phase: published ? "published" : "copying", error: message(error) };
        throw new PluginManagerError("IMPORT_FAILED", `Plugin import failed; existing versions are preserved. ${message(error)}`, recovery);
      }
    });
  }
  setEnabled(pluginId: string, enabled: boolean, digest?: string): Promise<ManagedPlugin> {
    return this.serial(async () => {
      if (typeof enabled !== "boolean") fail("Plugin enabled state must be boolean.");
      const plugin = await this.get(pluginId);
      if (enabled && plugin.removed) throw new PluginManagerError("PLUGIN_REMOVED", "Import the removed plugin again before enabling it.");
      if (!enabled) { this.db.prepare("UPDATE akorith_plugins SET enabled=0,revision=revision+1 WHERE id=?").run(pluginId); return this.get(pluginId); }
      const ready = plugin.versions.filter(version => version.state === "ready");
      const target = digest ?? (ready.some(version => version.digest === plugin.selectedDigest) ? plugin.selectedDigest! : ready.length === 1 ? ready[0].digest : undefined);
      const row = this.db.prepare("SELECT * FROM akorith_plugin_versions WHERE plugin_id=? AND digest=? AND state='ready'").get(pluginId, target ?? "") as VersionRow | undefined;
      if (!row) throw new PluginManagerError("VERSION_REQUIRED", "Select a ready imported plugin version explicitly.");
      await this.verifyVersion(row);
      const manifest = parseManifest(JSON.parse(row.manifest));
      this.db.prepare("UPDATE akorith_plugins SET enabled=1,selected_digest=?,name=?,revision=revision+1 WHERE id=?").run(row.digest, manifest.name, pluginId);
      return this.get(pluginId);
    });
  }
  remove(pluginId: string): Promise<{ plugin: ManagedPlugin; cleanup: PluginCleanupResult[] }> {
    return this.serial(async () => {
      await this.get(pluginId);
      // Disable synchronously before awaiting any usage/cleanup decision.
      this.db.prepare("UPDATE akorith_plugins SET enabled=0,removed=1,revision=revision+1 WHERE id=?").run(pluginId);
      const cleanup = await this.collect(pluginId);
      return { plugin: await this.get(pluginId), cleanup };
    });
  }
  collectUnused(): Promise<PluginCleanupResult[]> { return this.serial(() => this.collect()); }
  private async unused(ref: PluginVersionRef): Promise<PluginCleanupResult | undefined> {
    if ([...this.pins.values()].some(versions => versions.some(version => version.pluginId === ref.pluginId && version.digest === ref.digest))) return { ...ref, status: "retained", reason: "in_use" };
    if (!this.options.isVersionInUse) return { ...ref, status: "retained", reason: "usage_unknown" };
    try { const used = await this.options.isVersionInUse(ref); if (used !== false) return { ...ref, status: "retained", reason: used === true ? "in_use" : "usage_unknown" }; }
    catch (error) { return { ...ref, status: "retained", reason: "usage_check_failed", detail: message(error) }; }
  }
  private async deleteOwned(directory: string, ref: PluginVersionRef, operationId?: string) {
    try { await lstat(directory); } catch (error) { if (missing(error)) return; throw error; }
    await this.verifyOwner(directory, ref, operationId);
    await rm(directory, { recursive: true });
  }
  private async collect(pluginId?: string): Promise<PluginCleanupResult[]> {
    const results: PluginCleanupResult[] = [];
    const versions = this.db.prepare("SELECT v.* FROM akorith_plugin_versions v JOIN akorith_plugins p ON p.id=v.plugin_id WHERE p.removed=1 AND v.state='ready'").all() as VersionRow[];
    for (const row of versions.filter(row => !pluginId || row.plugin_id === pluginId)) {
      const ref = this.ref(row), retain = await this.unused(ref);
      if (retain) { results.push(retain); continue; }
      try { await this.deleteOwned(await this.directory(ref), ref); this.db.prepare("UPDATE akorith_plugin_versions SET state='removed' WHERE plugin_id=? AND digest=?").run(ref.pluginId, ref.digest); results.push({ ...ref, status: "removed" }); }
      catch (error) { results.push({ ...ref, status: "retained", reason: error instanceof PluginManagerError ? "ownership_unconfirmed" : "cleanup_failed", detail: message(error) }); }
    }
    const operations = this.db.prepare("SELECT * FROM akorith_plugin_operations").all() as OperationRow[];
    for (const operation of operations.filter(row => !pluginId || row.plugin_id === pluginId)) {
      const ref = this.ref(operation), retain = await this.unused(ref);
      if (retain) { results.push({ ...retain, operationId: operation.operation_id }); continue; }
      const registered = this.db.prepare("SELECT state FROM akorith_plugin_versions WHERE plugin_id=? AND digest=?").get(ref.pluginId, ref.digest) as { state: string } | undefined;
      try {
        await this.deleteOwned(join(await this.managedRoot(), ".staging", operation.operation_id), ref, operation.operation_id);
        if (registered?.state !== "ready") await this.deleteOwned(await this.directory(ref), ref, operation.operation_id);
        this.db.prepare("DELETE FROM akorith_plugin_operations WHERE operation_id=?").run(operation.operation_id);
        results.push({ ...ref, operationId: operation.operation_id, status: "recovered", ...(registered?.state === "ready" ? { reason: "registered_version" as const } : {}) });
      } catch (error) { results.push({ ...ref, operationId: operation.operation_id, status: "retained", reason: "ownership_unconfirmed", detail: message(error) }); }
    }
    return results;
  }
}
