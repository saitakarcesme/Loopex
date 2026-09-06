import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, symlinkSync, truncateSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import type { Message, RunStatus } from "../shared/contracts";
import { Store } from "../main/storage";
import { importLegacy } from "../main/migration";

const schema = `
  CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,path TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
  CREATE TABLE sessions(id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,title TEXT NOT NULL,project_id TEXT,pinned INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
  CREATE TABLE messages(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('user','assistant')),content TEXT NOT NULL,provider_id TEXT NOT NULL,model TEXT,attachments TEXT,metadata TEXT,created_at INTEGER NOT NULL);
`;
function fixture(t: TestContext, options: { schema?: string; seed?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "akorith-import-")));
  const old = join(root, "old"), next = join(root, "next"), source = join(old, "loopex.db");
  mkdirSync(old); mkdirSync(next);
  const legacy = new Database(source);
  legacy.exec(options.schema ?? schema);
  let store = new Store(join(next, "workspace.sqlite"));
  t.after(() => { if (legacy.open) legacy.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const session = (id = "s", provider = "chatgpt", created = 1000, updated = 3000, project: string | null = "p") =>
    legacy.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,?)").run(id, provider, id, project, 1, created, updated);
  const message = (id: string, input: {
    session?: string; role?: "user" | "assistant"; content?: string; provider?: string; model?: string | null;
    metadata?: unknown; metadataText?: string; attachments?: unknown; created?: number;
  } = {}) => legacy.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?)").run(
    id, input.session ?? "s", input.role ?? "assistant", input.content ?? `Synthetic ${id}`,
    input.provider ?? "chatgpt", input.model ?? null,
    input.attachments === undefined ? null : JSON.stringify(input.attachments),
    input.metadataText ?? (input.metadata === undefined ? null : JSON.stringify(input.metadata)), input.created ?? 2000,
  );
  const attachment = (name = "example.txt", content = "synthetic attachment") => {
    const folder = join(old, "chat-attachments", "s", "request");
    mkdirSync(folder, { recursive: true });
    const path = join(folder, name); writeFileSync(path, content);
    return { id: name, name, path, mimeType: "text/plain", size: Buffer.byteLength(content) };
  };
  if (options.seed !== false) {
    legacy.prepare("INSERT INTO projects VALUES(?,?,?,?,?)").run("p", "Example", old, 900, 1000);
    session();
  }
  return {
    root, old, next, source, legacy, session, message, attachment,
    get store() { return store; },
    reopen() { store.close(); store = new Store(join(next, "workspace.sqlite")); },
    run(path = source) { return importLegacy(store, next, path); },
    messages() { return store.messages(store.tasks().find(task => task.title === "s")!.id); },
  };
}
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

test("read-only snapshot preserves partial content, attribution, timestamps, usage and managed attachments across repeat/reopen", async t => {
  const f = fixture(t), attachment = f.attachment();
  f.message("m", { content: "Important synthetic partial", model: "old-model", attachments: [attachment], metadata: {
    chatLifecycle: { state: "running" },
    activities: [{ id: "a", kind: "command", label: "Run checks", status: "complete", detail: "fixture tests passed", timestamp: 1500 }],
    usage: { promptTokens: 42, completionTokens: 13, totalTokens: 55, estimated: false },
  } });
  f.legacy.close();
  const before = hash(f.source), beforeAttachment = hash(attachment.path);
  const result = await f.run();
  assert.equal(hash(f.source), before); assert.equal(hash(attachment.path), beforeAttachment);
  assert.equal(result.tasks, 1); assert.equal(result.attachments, 1);
  assert.deepEqual(result.skipped, { projects: 0, tasks: 0, messages: 0, attachments: 0, activities: 0, metadata: 0 });
  const task = f.store.tasks()[0], message = f.messages()[0];
  assert.equal(task.createdAt, 1000); assert.equal(task.updatedAt, 3000); assert.equal(task.pinned, true);
  assert.equal(f.store.projects()[0].createdAt, 900);
  assert.equal(task.providerId, "codex"); assert.equal(task.model, "old-model");
  assert.equal(message.status, "interrupted"); assert.equal(message.content, "Important synthetic partial");
  assert.equal(message.activities[0].status, "completed"); assert.equal(message.activities[0].detail, "fixture tests passed");
  assert.equal(message.activities[0].endedAt, undefined); assert.equal(message.usage?.totalTokens, 55);
  assert.deepEqual(message.attribution, { providerId: "codex", originalProviderId: "chatgpt", model: "old-model" });
  assert.equal(readFileSync(message.attachments![0].path, "utf8"), "synthetic attachment");
  assert.ok(message.attachments![0].path.startsWith(f.next)); assert.deepEqual(task.nativeSessions, {});
  assert.equal(JSON.parse(readFileSync(result.attachmentManifestPath!, "utf8")).state, "committed");
  const repeated = await f.run();
  assert.equal(repeated.tasks, 0); assert.equal(repeated.messages, 0); assert.equal(repeated.attachments, 0);
  assert.deepEqual(repeated.alreadyImported, { projects: 1, tasks: 1, messages: 1 });
  f.reopen();
  assert.deepEqual(f.store.task(task.id), task); assert.deepEqual(f.messages()[0], message);
  const backup = new Database(result.backupPath, { readonly: true });
  try { assert.equal((backup.prepare("SELECT COUNT(*) AS count FROM messages").get() as { count: number }).count, 1); }
  finally { backup.close(); }
});

test("all legacy lifecycle states preserve terminal evidence and never fabricate success for missing/unknown outcomes", async t => {
  const f = fixture(t);
  const cases: Array<[string | undefined, RunStatus, boolean]> = [
    ["completed", "completed", true], ["error", "failed", true], ["failed", "failed", true], ["timed_out", "failed", true],
    ["cancelled", "cancelled", true], ["interrupted", "interrupted", true], ["running", "interrupted", false],
    ["queued", "interrupted", false], ["starting", "interrupted", false], ["waiting", "interrupted", false],
    ["cancelling", "interrupted", false], ["future-status", "interrupted", false], [undefined, "interrupted", false],
  ];
  for (const [i, [state]] of cases.entries()) f.message(`m${i}`, { metadata: state ? { chatLifecycle: { state } } : undefined, created: 2000 + i });
  await f.run();
  for (const [i, [state, expected, recorded]] of cases.entries()) {
    const m = f.messages()[i]; assert.equal(m.status, expected, String(state));
    assert.equal(m.importProvenance?.lifecycle, state); assert.equal(m.importProvenance?.outcomeRecorded, recorded);
    assert.equal(m.content, `Synthetic m${i}`);
  }
});

test("child activity outcomes stay independent of parent completion and missing end times stay absent", async t => {
  const f = fixture(t);
  const activities = [
    { id: "same", kind: "command", label: "Finished", status: "complete", timestamp: 2100, endedAt: 2200 },
    { id: "same", kind: "tool", label: "Failed", status: "error", timestamp: 2100 },
    { id: "running", kind: "file", label: "Still running", status: "running", timestamp: 2100 },
    { id: "unknown", kind: "tool", label: "Unknown", timestamp: 2100 },
    { id: "warning", kind: "warning", label: "Notice", status: "complete", timestamp: 2100, endedAt: 1000 },
    { id: "bad-time", kind: "tool", label: "Bad time", status: "complete", timestamp: 2100, endedAt: "invalid" },
    null,
  ];
  for (const parent of ["completed", "running", "error"]) f.message(parent, { metadata: { chatLifecycle: { state: parent }, activities } });
  const result = await f.run();
  for (const m of f.messages()) {
    assert.deepEqual(m.activities.map(a => a.status), ["completed", "failed", "interrupted", "unknown", "completed", "completed"]);
    assert.equal(m.activities[0].endedAt, 2200);
    for (const a of m.activities.slice(1)) assert.equal(a.endedAt, undefined);
    assert.equal(m.activities[2].importProvenance?.originalStatus, "running");
    assert.equal(m.activities[4].kind, "status"); assert.equal(new Set(m.activities.map(a => a.id)).size, 6);
  }
  assert.equal(result.skipped.activities, 3);
});

test("Workspace goal imports are inactive and only an explicit completed/final pair establishes success", async t => {
  const f = fixture(t);
  const cases: Array<[string, boolean | undefined, RunStatus, boolean]> = [
    ["running", false, "interrupted", false], ["paused", false, "interrupted", false], ["needs_review", false, "interrupted", false],
    ["error", false, "failed", true], ["completed", true, "completed", true], ["completed", false, "interrupted", false],
    ["completed", undefined, "interrupted", false], ["future", false, "interrupted", false],
  ];
  cases.forEach(([status, final], i) => f.message(String(i), { metadata: { workspaceGoal: { status, final } }, created: 2000 + i }));
  await f.run();
  cases.forEach(([status, final, expected, recorded], i) => {
    const m = f.messages()[i]; assert.equal(m.status, expected); assert.equal(m.importProvenance?.outcomeRecorded, recorded);
    assert.deepEqual(m.importProvenance?.workspaceGoal, { status, ...(final === undefined ? {} : { final }) });
  });
  assert.equal((f.store.db.prepare("SELECT COUNT(*) AS n FROM turns").get() as { n: number }).n, 0);
});

test("mixed history selects the latest known assistant pair and preserves per-message attribution and final task dates", async t => {
  const f = fixture(t);
  f.session("other", "local", 500, 4000);
  f.message("first", { provider: "chatgpt", model: "codex-model", metadata: { chatLifecycle: { state: "completed" } }, created: 1500 });
  f.message("other-message", { session: "other", provider: "local", model: "local-model", created: 1700 });
  f.message("second", { provider: "claude", model: "claude-model", metadata: { chatLifecycle: { state: "timed_out" } }, created: 1800 });
  f.message("trailing-user", { role: "user", provider: "local", model: "user-selected-model", created: 1800 });
  await f.run();
  let tasks = f.store.tasks();
  assert.deepEqual(tasks.map(task => task.title), ["other", "s"]);
  const task = tasks[1];
  assert.equal(task.providerId, "claude"); assert.equal(task.model, "claude-model"); assert.equal(task.status, "failed");
  assert.equal(task.createdAt, 1000); assert.equal(task.updatedAt, 3000);
  assert.deepEqual(f.messages().map(m => m.importProvenance?.messageId), ["first", "second", "trailing-user"]);
  assert.deepEqual(f.messages().map(m => m.attribution?.providerId), ["codex", "claude", "ollama"]);
  assert.deepEqual(f.messages().map(m => m.attribution?.model), ["codex-model", "claude-model", "user-selected-model"]);
  f.reopen(); tasks = f.store.tasks();
  assert.deepEqual(tasks.map(t => [t.title, t.createdAt, t.updatedAt]), [["other", 500, 4000], ["s", 1000, 3000]]);
  assert.deepEqual(f.store.task(task.id), task);
});

test("unknown providers remain explicit and cannot silently become Claude or overwrite a known continuation pair", async t => {
  const f = fixture(t);
  f.legacy.prepare("UPDATE sessions SET provider_id=?").run("unknown-old-provider");
  f.message("unknown", { provider: "unknown-old-provider", model: "unknown-model", metadata: { chatLifecycle: { state: "completed" } } });
  f.session("mixed", "chatgpt");
  f.message("known", { session: "mixed", provider: "claude", model: "known-model", created: 1500 });
  f.message("later-unknown", { session: "mixed", provider: "unknown-old-provider", model: "unknown-model", created: 2500 });
  const report = await f.run();
  const unknownTask = f.store.tasks().find(task => task.title === "s")!, mixedTask = f.store.tasks().find(task => task.title === "mixed")!;
  assert.equal(unknownTask.providerId, "codex"); assert.equal(unknownTask.model, "");
  assert.equal(mixedTask.providerId, "claude"); assert.equal(mixedTask.model, "known-model");
  assert.deepEqual(f.messages()[0].attribution, { originalProviderId: "unknown-old-provider", model: "unknown-model" });
  assert.ok(report.warnings.some(w => w.includes("unrecognized")));
});

test("canonical aliases reuse historical mappings/projects while incremental import preserves all existing V2 task state", async t => {
  const f = fixture(t), alias = join(f.root, "old-alias");
  symlinkSync(f.old, alias);
  f.legacy.prepare("UPDATE projects SET path=?").run(alias);
  const existingProject = f.store.addProject(f.old, "V2 project name", 111);
  f.message("initial", { model: "old-model", metadata: { chatLifecycle: { state: "completed" } } });
  await f.run(join(alias, "loopex.db"));
  assert.equal(f.store.projects().length, 1); assert.deepEqual(f.store.projects()[0], existingProject);
  const task = f.store.tasks()[0];
  // Simulate mappings made by the previous literal-path importer.
  f.store.db.prepare("UPDATE imports SET source=?").run(join(alias, "loopex.db"));
  const current = f.store.updateTask(task.id, { title: "Current V2 title", providerId: "opencode", model: "current-model", mode: "full", status: "running", draft: "current draft", updatedAt: 9000, nativeSessions: { opencode: "existing-native-id" } });
  f.message("later-legacy", { provider: "claude", model: "legacy-model", metadata: { chatLifecycle: { state: "error" } }, created: 2500 });
  const report = await f.run();
  assert.equal(report.tasks, 0); assert.equal(report.messages, 1);
  assert.deepEqual(f.store.task(task.id), current);
  assert.equal(f.store.messages(task.id).length, 2);
  assert.equal((f.store.db.prepare("SELECT COUNT(*) AS n FROM imports WHERE source=?").get(realpathSync(f.source)) as { n: number }).n, 4);
  const repeated = await f.run(join(alias, "loopex.db"));
  assert.equal(repeated.messages, 0); assert.equal(f.store.tasks().length, 1);
});

test("online read-only backup includes committed WAL rows without changing source database or WAL bytes", async t => {
  const f = fixture(t);
  f.legacy.pragma("journal_mode = WAL"); f.legacy.pragma("wal_autocheckpoint = 0");
  f.message("in-wal", { metadata: { chatLifecycle: { state: "completed" } } });
  assert.ok(existsSync(`${f.source}-wal`));
  const databaseHash = hash(f.source), walHash = hash(`${f.source}-wal`);
  const result = await f.run();
  assert.equal(result.messages, 1); assert.equal(hash(f.source), databaseHash); assert.equal(hash(`${f.source}-wal`), walHash);
  assert.equal((f.legacy.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n, 1);
});

test("unsupported schemas reject atomically and retain a source snapshot", async t => {
  for (const [label, sql] of [
    ["missing tables", "CREATE TABLE unrelated(id TEXT)"],
    ["missing provider", "CREATE TABLE sessions(id TEXT,provider_id TEXT,title TEXT,created_at INTEGER,updated_at INTEGER); CREATE TABLE messages(id TEXT,session_id TEXT,role TEXT,content TEXT,created_at INTEGER)"],
  ]) await t.test(label, async sub => {
    const f = fixture(sub, { schema: sql, seed: false });
    await assert.rejects(f.run(), /Unsupported legacy schema/);
    assert.equal(f.store.tasks().length, 0); assert.equal(f.store.projects().length, 0);
    assert.equal(readdirSync(join(f.next, "backups")).filter(name => name.endsWith(".sqlite")).length, 1);
  });
});

test("older optional-column schema retains history with explicit unavailable-field and outcome reporting", async t => {
  const f = fixture(t, { seed: false, schema: `
    CREATE TABLE sessions(id TEXT,provider_id TEXT,title TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE messages(id TEXT,session_id TEXT,role TEXT,content TEXT,provider_id TEXT,created_at INTEGER);
  ` });
  f.legacy.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run("s", "opencode", "s", 1000, 2000);
  f.legacy.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?)").run("m", "s", "assistant", "Synthetic old schema", "opencode", 1500);
  const result = await f.run();
  assert.equal(result.messages, 1); assert.equal(result.unverifiedMessages, 1);
  assert.ok(result.warnings.some(w => w.includes("messages.metadata")));
  assert.equal(f.messages()[0].status, "interrupted"); assert.equal(f.messages()[0].attribution?.providerId, "opencode");
});

test("malformed metadata, orphan rows and invalid paths are counted while valid content remains readable", async t => {
  const f = fixture(t);
  f.legacy.prepare("INSERT INTO projects VALUES(?,?,?,?,?)").run("invalid-project", "Invalid", "relative/path", 1000, 1000);
  f.session("orphan-project-task", "claude", 1000, 1000, "invalid-project");
  f.message("bad-json", { metadataText: "{invalid" });
  f.message("bad-shape", { metadata: [] });
  f.message("bad-parts", { metadata: { activities: [null], usage: { promptTokens: -1, completionTokens: "4", totalTokens: 3.5, costUsd: -5, estimated: "yes" } } });
  f.message("orphan", { session: "missing-task" });
  const report = await f.run();
  assert.equal(report.skipped.projects, 1); assert.equal(report.skipped.messages, 1); assert.equal(report.skipped.metadata, 2); assert.equal(report.skipped.activities, 1);
  assert.equal(report.messages, 3); assert.equal(f.messages().length, 3);
  assert.deepEqual(f.messages()[2].usage, {});
  assert.equal(f.store.tasks().find(task => task.title === "orphan-project-task")!.projectId, null);
});

test("attachments only copy from the managed subtree and reject escapes, missing, credentials and oversize files", async t => {
  const f = fixture(t), good = f.attachment();
  const external = join(f.root, "external.txt"); writeFileSync(external, "external synthetic data");
  const escaped = join(f.old, "chat-attachments", "escape.txt"); symlinkSync(external, escaped);
  const credential = join(f.old, "config.json"); writeFileSync(credential, "synthetic credential marker");
  const large = f.attachment("large.txt"); truncateSync(large.path, 25 * 1024 * 1024 + 1);
  f.message("m", { attachments: [good, { ...good, path: escaped }, { ...good, path: credential }, { ...good, path: join(f.old, "chat-attachments", "missing.txt") }, large] });
  const result = await f.run();
  assert.equal(result.attachments, 1); assert.equal(result.skipped.attachments, 4);
  const saved = f.messages()[0].attachments!; assert.equal(saved.length, 1);
  assert.equal(readFileSync(saved[0].path, "utf8"), "synthetic attachment");
  assert.equal(readFileSync(external, "utf8"), "external synthetic data");
  assert.equal(readFileSync(credential, "utf8"), "synthetic credential marker");
});

test("an attachment target symlink cannot create task directories or files outside V2 data", async t => {
  const f = fixture(t), attachment = f.attachment(), outside = join(f.root, "outside");
  mkdirSync(outside); symlinkSync(outside, join(f.next, "attachments"));
  f.message("m", { attachments: [attachment] });
  const result = await f.run();
  assert.equal(result.attachments, 0); assert.equal(result.skipped.attachments, 1); assert.deepEqual(readdirSync(outside), []);
});

test("a symlink replacing the managed source root never authorizes external attachment data", async t => {
  const f = fixture(t), outside = join(f.root, "external-attachments");
  mkdirSync(outside);
  const external = join(outside, "example.txt"); writeFileSync(external, "external synthetic data");
  symlinkSync(outside, join(f.old, "chat-attachments"));
  f.message("m", { attachments: [{ path: join(f.old, "chat-attachments", "example.txt"), name: "example.txt" }] });
  const result = await f.run();
  assert.equal(result.attachments, 0); assert.equal(result.skipped.attachments, 1);
  assert.equal(readFileSync(external, "utf8"), "external synthetic data");
});

test("conflicting prior mappings across source aliases abort without merging unrelated V2 tasks", async t => {
  const f = fixture(t), alias = join(f.root, "alias"); symlinkSync(f.old, alias);
  const first = f.store.createTask({ title: "First V2 task" }), second = f.store.createTask({ title: "Second V2 task" });
  f.store.db.prepare("INSERT INTO imports VALUES(?,?,?)").run(f.source, "task:s", first.id);
  f.store.db.prepare("INSERT INTO imports VALUES(?,?,?)").run(join(alias, "loopex.db"), "task:s", second.id);
  await assert.rejects(f.run(), /Conflicting previous import mappings/);
  assert.equal(f.store.tasks().length, 2); assert.deepEqual(f.store.task(first.id), first); assert.deepEqual(f.store.task(second.id), second);
  assert.equal(f.store.projects().length, 0);
});

test("a later target SQL failure rolls back mappings and only removes exclusive import-created copies", async t => {
  const f = fixture(t), attachment = f.attachment();
  const keep = join(f.next, "keep.txt"); writeFileSync(keep, "existing V2 data");
  f.message("m", { attachments: [attachment] });
  const save = f.store.saveMessage.bind(f.store);
  let copiedPath = "";
  f.store.saveMessage = (m: Message) => { copiedPath = m.attachments![0].path; throw new Error("injected target failure"); };
  await assert.rejects(f.run(), /injected target failure.*rolled back/);
  assert.ok(copiedPath); assert.equal(existsSync(copiedPath), false);
  assert.equal(f.store.tasks().length, 0); assert.equal(f.store.projects().length, 0);
  assert.equal((f.store.db.prepare("SELECT COUNT(*) AS n FROM imports").get() as { n: number }).n, 0);
  assert.equal(readFileSync(keep, "utf8"), "existing V2 data"); assert.ok(existsSync(attachment.path));
  const manifest = readdirSync(join(f.next, "backups")).find(name => name.endsWith(".attachments.json"))!;
  const recovery = JSON.parse(readFileSync(join(f.next, "backups", manifest), "utf8"));
  assert.equal(recovery.state, "rolled_back"); assert.deepEqual(recovery.retained, []);
  f.store.saveMessage = save;
  const retry = await f.run(); assert.equal(retry.messages, 1); assert.equal(retry.attachments, 1);
});

test("rollback retains a copy path whose identity changed instead of removing replacement user data", async t => {
  const f = fixture(t), attachment = f.attachment();
  f.message("m", { attachments: [attachment] });
  let replacedPath = "";
  f.store.saveMessage = (m: Message) => {
    replacedPath = m.attachments![0].path;
    renameSync(replacedPath, `${replacedPath}.retained-original`);
    writeFileSync(replacedPath, "replacement user data");
    throw new Error("injected replacement failure");
  };
  await assert.rejects(f.run(), /1 copied files require recovery/);
  assert.equal(readFileSync(replacedPath, "utf8"), "replacement user data");
  const name = readdirSync(join(f.next, "backups")).find(name => name.endsWith(".attachments.json"))!;
  const report = JSON.parse(readFileSync(join(f.next, "backups", name), "utf8"));
  assert.deepEqual(report.retained, [replacedPath]); assert.equal(f.store.tasks().length, 0);
});

test("unavailable project paths remain associated and warning truncation keeps a truthful total", async t => {
  const f = fixture(t), missing = join(f.root, "unavailable-project");
  f.legacy.prepare("UPDATE projects SET path=?").run(missing);
  for (let i = 0; i < 120; i++) f.message(`m${i}`, { created: 2000 + i });
  const report = await f.run();
  assert.equal(f.store.projects()[0].path, missing); assert.equal(f.store.tasks()[0].projectId, f.store.projects()[0].id);
  assert.equal(report.unverifiedMessages, 120); assert.equal(report.warnings.length, 100); assert.ok(report.warningCount > report.warnings.length);
});
