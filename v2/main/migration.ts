import Database from "better-sqlite3";
import {
  closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync,
  readSync, realpathSync, statSync, unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { join, dirname, basename, relative, isAbsolute, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Message, ProviderId, Activity, Attachment, RunStatus, Task, Usage } from "../shared/contracts";
import { Store } from "./storage";

type Row = Record<string, unknown>;
const record = (value: unknown): Row | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;
const text = (value: unknown) => typeof value === "string" && value.length ? value : undefined;
const timestamp = (value: unknown): number | undefined =>
  (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) &&
  Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : undefined;
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};
const provider = (id: unknown): ProviderId | undefined => {
  if (id === "chatgpt" || id === "codex") return "codex";
  if (id === "local" || id === "ollama") return "ollama";
  if (id === "claude" || id === "opencode") return id;
};

function outcome(metadata: Row | undefined): Pick<Message, "status"> & { recorded: boolean; lifecycle?: string; goal?: NonNullable<Message["importProvenance"]>["workspaceGoal"] } {
  const lifecycle = text(record(metadata?.chatLifecycle)?.state);
  const workspaceGoal = record(metadata?.workspaceGoal);
  const goal = workspaceGoal && typeof workspaceGoal.status === "string"
    ? { status: workspaceGoal.status, ...(typeof workspaceGoal.final === "boolean" ? { final: workspaceGoal.final } : {}) }
    : undefined;
  let status: RunStatus = "interrupted", recorded = false;
  if (lifecycle === "completed") { status = "completed"; recorded = true; }
  else if (["error", "failed", "timed_out"].includes(lifecycle ?? "")) { status = "failed"; recorded = true; }
  else if (lifecycle === "cancelled") { status = "cancelled"; recorded = true; }
  else if (lifecycle === "interrupted") recorded = true;
  else if (!lifecycle && goal) {
    if (goal.status === "completed" && goal.final === true) { status = "completed"; recorded = true; }
    else if (goal.status === "error") { status = "failed"; recorded = true; }
    else if (goal.status === "cancelled") { status = "cancelled"; recorded = true; }
  }
  return { status, recorded, lifecycle, goal };
}

/** Read one online snapshot; importing never opens the legacy database for writes. */
export async function importLegacy(
  store: Store,
  userData: string,
  sourcePath = join(homedir(), "Library", "Application Support", "Akorith", "loopex.db"),
) {
  if (!existsSync(sourcePath)) throw new Error("No previous Akorith history was found on this Mac.");
  const sourceIdentity = realpathSync(sourcePath);
  const oldRoot = dirname(sourceIdentity);
  const dir = join(userData, "backups");
  mkdirSync(dir, { recursive: true });
  const snapshot = join(dir, `legacy-${Date.now()}-${randomUUID().slice(0, 8)}.sqlite`);
  const source = new Database(sourceIdentity, { readonly: true, fileMustExist: true });
  try { await source.backup(snapshot); } finally { source.close(); }
  const legacy = new Database(snapshot, { readonly: true, fileMustExist: true });
  const result = {
    projects: 0, tasks: 0, messages: 0, attachments: 0,
    skipped: { projects: 0, tasks: 0, messages: 0, attachments: 0, activities: 0, metadata: 0 },
    alreadyImported: { projects: 0, tasks: 0, messages: 0 },
    unverifiedMessages: 0, warningCount: 0, warnings: [] as string[], backupPath: snapshot,
    attachmentManifestPath: undefined as string | undefined,
  };
  const warn = (message: string) => {
    result.warningCount++;
    if (result.warnings.length < 100) result.warnings.push(message);
  };
  const date = (value: unknown, fallback: number, label: string) => {
    const valueAt = timestamp(value);
    if (valueAt === undefined) warn(`${label} had no valid timestamp; a fallback was recorded.`);
    return valueAt ?? fallback;
  };
  const parsed = (value: unknown, label: string): unknown => {
    if (value === null || value === undefined || value === "") return undefined;
    try { return typeof value === "string" ? JSON.parse(value) : value; }
    catch { result.skipped.metadata++; warn(`${label} contains malformed JSON; the original remains in the backup.`); return undefined; }
  };

  // Only exclusive files created by this import can be removed on rollback.
  const copied: Array<{ path: string; dev: number; ino: number }> = [];
  const manifest = `${snapshot}.attachments.json`;
  let attachmentBytes = 0;
  const saveManifest = (state: string, retained: string[] = []) => {
    if (!copied.length) return;
    writeFileSync(manifest, JSON.stringify({ version: 1, state, backupPath: snapshot, files: copied, retained }, null, 2), { mode: 0o600 });
    result.attachmentManifestPath = manifest;
  };

  try {
    const tables = new Set((legacy.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name));
    const validateTable = (name: string, required: string[], optional: string[] = []) => {
      if (!tables.has(name)) throw new Error(`Unsupported legacy schema: missing ${name} table. No history was imported. Snapshot: ${snapshot}`);
      // Names come only from the fixed schema below, never from legacy values.
      const columns = new Set((legacy.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map(row => row.name));
      const missing = required.filter(column => !columns.has(column));
      if (missing.length) throw new Error(`Unsupported legacy schema: ${name} is missing ${missing.join(", ")}. No history was imported. Snapshot: ${snapshot}`);
      for (const column of optional) if (!columns.has(column)) warn(`Legacy ${name}.${column} is unavailable; that field cannot be restored.`);
    };
    validateTable("sessions", ["id", "provider_id", "title", "created_at", "updated_at"], ["project_id", "pinned"]);
    validateTable("messages", ["id", "session_id", "role", "content", "provider_id", "created_at"], ["model", "attachments", "metadata"]);
    if (tables.has("projects")) validateTable("projects", ["id", "name", "path"], ["created_at"]);

    // Recognize older literal symlink mappings and normalize them transactionally.
    const identities = new Set([sourceIdentity, sourcePath, resolve(sourcePath)]);
    for (const row of store.db.prepare("SELECT DISTINCT source FROM imports").all() as { source: string }[]) {
      try { if (realpathSync(row.source) === sourceIdentity) identities.add(row.source); } catch { /* Unavailable aliases cannot prove identity. */ }
    }
    const mappings = new Map<string, string>();
    for (const identity of identities) {
      for (const row of store.db.prepare("SELECT legacy_id,new_id FROM imports WHERE source=?").all(identity) as { legacy_id: string; new_id: string }[]) {
        const previous = mappings.get(row.legacy_id);
        if (previous && previous !== row.new_id) throw new Error("Conflicting previous import mappings refer to the same legacy database. No history was imported.");
        mappings.set(row.legacy_id, row.new_id);
      }
    }
    const remember = (id: string, value: string) => {
      store.db.prepare("INSERT OR IGNORE INTO imports(source,legacy_id,new_id) VALUES (?,?,?)").run(sourceIdentity, id, value);
      mappings.set(id, value);
    };

    const attachments = (value: unknown, taskId: string): Attachment[] => {
      const values = parsed(value, "Attachment metadata");
      if (values === undefined) return [];
      if (!Array.isArray(values)) { result.skipped.attachments++; warn("An attachment list has an unsupported shape and was skipped."); return []; }
      const imported: Attachment[] = [];
      const managedRoot = join(oldRoot, "chat-attachments");
      for (const value of values) {
        const row = record(value);
        if (!row || typeof row.path !== "string") { result.skipped.attachments++; warn("An attachment has no valid managed path and was skipped."); continue; }
        let sourceFd: number | undefined;
        try {
          // The old writer only creates this subtree. A forged pointer to app
          // config/credentials or external files must never become an attachment.
          if (!lstatSync(managedRoot).isDirectory() || realpathSync(managedRoot) !== managedRoot) throw new Error("unmanaged");
          const file = realpathSync(row.path);
          if (!inside(managedRoot, file) || file === managedRoot) throw new Error("unmanaged");
          sourceFd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
          const info = fstatSync(sourceFd);
          if (!info.isFile() || info.size > 25 * 1024 * 1024 || copied.length >= 2048 || attachmentBytes + info.size > 512 * 1024 * 1024) throw new Error("size");
          const targetParent = join(realpathSync(userData), "attachments");
          mkdirSync(targetParent, { recursive: true });
          if (realpathSync(targetParent) !== targetParent) throw new Error("target");
          const target = join(targetParent, taskId);
          mkdirSync(target, { recursive: true });
          if (realpathSync(target) !== target) throw new Error("target");
          const id = randomUUID();
          const name = basename(text(row.name) ?? file).replace(/[\0\r\n]/g, "").slice(0, 180) || "attachment";
          const path = join(target, `${id}-${name}`);
          const destinationFd = openSync(path, "wx", 0o600);
          try {
            const identity = fstatSync(destinationFd);
            copied.push({ path, dev: identity.dev, ino: identity.ino });
            saveManifest("copying");
            let offset = 0;
            const buffer = Buffer.alloc(64 * 1024);
            while (offset < info.size) {
              const length = readSync(sourceFd, buffer, 0, Math.min(buffer.length, info.size - offset), offset);
              if (!length) throw new Error("Attachment changed during import.");
              let written = 0;
              while (written < length) {
                const count = writeSync(destinationFd, buffer, written, length - written, offset + written);
                if (!count) throw new Error("Attachment copy made no write progress.");
                written += count;
              }
              offset += length;
            }
            const after = fstatSync(sourceFd);
            if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error("Attachment changed during import.");
          } finally { closeSync(destinationFd); }
          attachmentBytes += info.size;
          imported.push({ id, name, path, size: info.size, mimeType: text(row.mimeType) ?? "application/octet-stream" });
          result.attachments++;
        } catch (error) {
          // A copy failure rolls back the import instead of exposing partial bytes.
          if (copied.length > result.attachments) throw error;
          result.skipped.attachments++;
          warn("An attachment was unavailable, outside legacy chat-attachments, or exceeded the import budget; its original metadata remains in the backup.");
        } finally { if (sourceFd !== undefined) closeSync(sourceFd); }
      }
      return imported;
    };

    const activities = (value: unknown, createdAt: number): Activity[] => {
      if (value === undefined) return [];
      if (!Array.isArray(value)) { result.skipped.activities++; warn("An activity list has an unsupported shape and was skipped."); return []; }
      const rows: Activity[] = [], ids = new Set<string>();
      for (const valueAt of value) {
        const a = record(valueAt);
        if (!a) { result.skipped.activities++; warn("A malformed activity was skipped."); continue; }
        const originalStatus = text(a.status);
        const status: Activity["status"] = originalStatus === "complete" || originalStatus === "completed" ? "completed"
          : originalStatus === "error" || originalStatus === "failed" ? "failed"
          : ["running", "queued", "starting", "waiting", "cancelling", "interrupted"].includes(originalStatus ?? "") ? "interrupted" : "unknown";
        if (status === "unknown") warn("An activity has no recognized outcome; it was retained as unknown.");
        const kinds: Activity["kind"][] = ["commentary", "command", "file", "tool", "plan", "status", "error"];
        const kind = kinds.includes(a.kind as Activity["kind"]) ? a.kind as Activity["kind"] : a.kind === "reasoning" ? "commentary" : "status";
        const startedAt = date(a.startedAt ?? a.timestamp, createdAt, "An activity start");
        let endedAt = timestamp(a.endedAt);
        if (endedAt !== undefined && endedAt < startedAt) { endedAt = undefined; warn("An activity end preceded its start; no duration was invented."); }
        if (a.endedAt !== undefined && timestamp(a.endedAt) === undefined) warn("An activity has an invalid end timestamp; it was omitted.");
        let id = text(a.id) ?? randomUUID();
        if (ids.has(id)) { id = randomUUID(); warn("A duplicate activity ID was replaced while preserving the activity."); }
        ids.add(id);
        rows.push({ id, kind, title: text(a.label) ?? text(a.title) ?? "Imported activity", detail: typeof a.detail === "string" ? a.detail : undefined,
          status, startedAt, ...(endedAt !== undefined ? { endedAt } : {}), importProvenance: { source: "akorith", originalStatus } });
      }
      return rows;
    };
    const usage = (value: unknown): Usage | undefined => {
      if (value === undefined) return undefined;
      const input = record(value);
      if (!input) { result.skipped.metadata++; warn("Malformed usage metadata was omitted."); return undefined; }
      const output: Usage = {};
      for (const [from, to] of [["promptTokens", "inputTokens"], ["completionTokens", "outputTokens"], ["totalTokens", "totalTokens"], ["costUsd", "costUsd"]] as const) {
        const count = input[from];
        if (count === undefined) continue;
        if (typeof count === "number" && Number.isFinite(count) && count >= 0 && (from === "costUsd" || Number.isInteger(count))) output[to] = count;
        else warn(`Invalid ${from} usage was omitted.`);
      }
      if (typeof input.estimated === "boolean") output.estimated = input.estimated;
      return output;
    };

    store.db.transaction(() => {
      for (const [key, id] of mappings) remember(key, id);
      if (tables.has("projects")) for (const row of legacy.prepare("SELECT * FROM projects ORDER BY rowid").all() as Row[]) {
        if (!text(row.id)) { result.skipped.projects++; warn("A legacy project has no valid ID and was skipped."); continue; }
        const key = `project:${row.id}`;
        if (mappings.has(key)) { result.alreadyImported.projects++; continue; }
        if (!text(row.path) || !isAbsolute(row.path as string)) { result.skipped.projects++; warn("A legacy project has no absolute directory; its conversations can still be imported without a project."); continue; }
        let path = row.path as string;
        try { path = realpathSync(path); if (!statSync(path).isDirectory()) throw new Error("Not a directory"); }
        catch { warn("A legacy project directory is unavailable; its original path was preserved."); path = row.path as string; }
        const existing = store.projects().find(project => {
          if (project.path === path) return true;
          try { return realpathSync(project.path) === path; } catch { return false; }
        });
        const p = existing ?? store.addProject(path, text(row.name) ?? "Imported project", date(row.created_at, Date.now(), "A project creation"));
        remember(key, p.id);
        result.projects++;
      }
      const newTasks = new Map<string, Partial<Task>>();
      for (const row of legacy.prepare("SELECT * FROM sessions ORDER BY rowid").all() as Row[]) {
        if (!text(row.id)) { result.skipped.tasks++; warn("A legacy session has no valid ID and was skipped."); continue; }
        const key = `task:${row.id}`;
        if (mappings.has(key)) { result.alreadyImported.tasks++; continue; }
        const mappedProject = text(row.project_id) ? mappings.get(`project:${row.project_id}`) : undefined;
        const projectId = mappedProject && store.project(mappedProject) ? mappedProject : null;
        if (row.project_id && !projectId) warn("A conversation's legacy project is unavailable; the conversation was retained without a project.");
        const selectedProvider = provider(row.provider_id);
        if (!selectedProvider) warn("An unrecognized legacy session provider was not relabeled; continuation uses the configured default until an attributable assistant is found.");
        const t = store.createTask({ projectId, title: typeof row.title === "string" ? row.title : "Imported task", providerId: selectedProvider ?? store.settings().defaultProvider });
        const restored = { ...t, pinned: row.pinned === true || row.pinned === 1, archived: row.archived === true || row.archived === 1,
          createdAt: date(row.created_at, t.createdAt, "A task creation"), updatedAt: date(row.updated_at, t.updatedAt, "A task update") };
        store.db.prepare("UPDATE tasks SET data=?,updated_at=? WHERE id=?").run(JSON.stringify(restored), restored.updatedAt, t.id);
        remember(key, t.id);
        newTasks.set(t.id, {});
        result.tasks++;
      }
      for (const row of legacy.prepare("SELECT * FROM messages ORDER BY created_at,rowid").all() as Row[]) {
        if (!text(row.id) || !text(row.session_id) || !["user", "assistant"].includes(String(row.role)) || typeof row.content !== "string") {
          result.skipped.messages++; warn("A message has invalid identity, role, or content and was skipped; the original remains in the backup."); continue;
        }
        const key = `message:${row.id}`;
        if (mappings.has(key)) { result.alreadyImported.messages++; continue; }
        const taskId = mappings.get(`task:${row.session_id}`);
        if (!taskId || !store.db.prepare("SELECT 1 FROM tasks WHERE id=?").get(taskId)) { result.skipped.messages++; warn("An orphan message has no available imported task and was skipped."); continue; }
        const rawMetadata = parsed(row.metadata, "Message metadata"), metadata = record(rawMetadata);
        if (rawMetadata !== undefined && !metadata) { result.skipped.metadata++; warn("Message metadata has an unsupported shape; its original remains in the backup."); }
        const createdAt = date(row.created_at, store.task(taskId).createdAt, "A message creation");
        const state = outcome(metadata), role = row.role as Message["role"];
        if (role === "assistant" && !state.recorded) { result.unverifiedMessages++; warn("An imported assistant message has no recorded terminal outcome; it remains interrupted or unverified."); }
        const originalProviderId = text(row.provider_id), providerId = provider(row.provider_id), model = text(row.model);
        if (!providerId) warn("A message's provider is unrecognized; original attribution was retained without assigning a different provider.");
        const m: Message = {
          id: randomUUID(), taskId, turnId: `import:${row.id}`, role, content: row.content,
          activities: activities(metadata?.activities, createdAt), attachments: attachments(row.attachments, taskId),
          status: role === "user" ? "completed" : state.status, createdAt, usage: usage(metadata?.usage),
          attribution: { providerId, originalProviderId, model },
          importProvenance: { source: "akorith", messageId: row.id as string, lifecycle: state.lifecycle, outcomeRecorded: role === "user" || state.recorded, workspaceGoal: state.goal },
        };
        store.saveMessage(m);
        remember(key, m.id);
        result.messages++;
        const patch = newTasks.get(taskId);
        if (patch && role === "assistant") {
          patch.status = m.status;
          if (providerId) { patch.providerId = providerId; patch.model = model ?? ""; }
        }
      }
      // Existing V2 selections/live state must survive incremental historical import.
      for (const [taskId, patch] of newTasks) store.updateTask(taskId, patch);
      saveManifest("committing");
    })();
    // A report-write failure after commit must not remove committed attachments.
    try { saveManifest("committed"); } catch { warn("The attachment recovery manifest could not be finalized; committed attachment files were preserved."); }
  } catch (error) {
    const retained: string[] = [];
    for (const receipt of copied) {
      try {
        const current = lstatSync(receipt.path);
        if (current.isSymbolicLink() || current.dev !== receipt.dev || current.ino !== receipt.ino) { retained.push(receipt.path); continue; }
        unlinkSync(receipt.path);
      } catch (cleanupError) { if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") retained.push(receipt.path); }
    }
    try { saveManifest("rolled_back", retained); } catch { /* The thrown error still identifies recovery paths. */ }
    throw new Error(`${error instanceof Error ? error.message : "Legacy import failed."} Target database changes were rolled back. Snapshot: ${snapshot}.${copied.length ? ` Attachment recovery manifest: ${manifest}. ${retained.length} copied files require recovery.` : ""}`, { cause: error });
  } finally { legacy.close(); }
  warn("This is a snapshot of conversations and available managed attachments. Continuing starts a fresh provider session. The original database is retained in the backup; legacy schedulers, native sessions, and actionable Undo checkpoints are not imported.");
  return result;
}
