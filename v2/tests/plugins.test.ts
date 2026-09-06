import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { mkdtemp, mkdir, writeFile, readFile, lstat, readdir, symlink, link, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { PluginManager, PluginManagerError } from "../main/plugins";
import type { PluginVersionRef } from "../shared/plugin-contracts";

async function fixture(t: { after(fn: () => void | Promise<void>): void }, used?: (ref: PluginVersionRef) => boolean | Promise<boolean>) {
  const root = await mkdtemp(join(tmpdir(), "akorith-plugin-test-")), source = join(root, "source"), userData = join(root, "data");
  await mkdir(join(source, "skills", "example"), { recursive: true });
  await mkdir(join(source, "server")); await mkdir(userData);
  await writeFile(join(source, "skills", "example", "SKILL.md"), "---\nname: example\n---\nSynthetic Türkçe 👩🏽‍💻 skill.\n");
  await writeFile(join(source, "server", "main.cjs"), "require('node:fs').writeFileSync('SHOULD_NOT_RUN', 'bad');\n");
  await writeFile(join(source, "not-declared.txt"), "This is never copied.");
  const manifest = { schemaVersion: 1, id: "fixture.plugin", version: "1.0.0", name: "Synthetic plugin", skills: [{ id: "example", path: "skills/example/SKILL.md" }], mcpServers: [{ id: "tools", name: "Fixture tools", command: "node", args: ["{pluginRoot}/server/main.cjs"] }], assets: ["server"] };
  const save = async (patch: Record<string, unknown> = {}) => { await writeFile(join(source, "akorith.plugin.json"), JSON.stringify({ ...manifest, ...patch })); };
  await save();
  const db = new Database(join(userData, "workspace.sqlite")); db.pragma("journal_mode=WAL");
  const manager = new PluginManager({ db, userData, isVersionInUse: used });
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  return { root, source, userData, db, manager, manifest, save };
}
const exists = async (path: string) => { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } };

test("inspection executes nothing; import copies only declared files and starts disabled", async t => {
  const f = await fixture(t), before = await readFile(join(f.source, "akorith.plugin.json"));
  const inspection = await f.manager.inspectLocal(f.source);
  assert.equal((await f.manager.list()).plugins.length, 0);
  assert.equal(await exists(join(f.userData, "extensions")), false);
  assert.deepEqual(inspection.files.map(file => file.path), ["akorith.plugin.json", "server/main.cjs", "skills/example/SKILL.md"]);
  const imported = await f.manager.importLocal(f.source, { expectedDigest: inspection.digest });
  assert.equal(imported.plugin.enabled, false); assert.equal(imported.plugin.selectedDigest, null);
  assert.equal(imported.activationChanged, false);
  assert.equal(await exists(join(imported.version.rootPath, "not-declared.txt")), false);
  assert.equal(await exists(join(f.source, "SHOULD_NOT_RUN")), false);
  assert.equal(await exists(join(imported.version.rootPath, "SHOULD_NOT_RUN")), false);
  assert.match(await readFile(join(imported.version.rootPath, "skills/example/SKILL.md"), "utf8"), /Türkçe/);
  assert.deepEqual(await readFile(join(f.source, "akorith.plugin.json")), before);
  assert.equal(imported.version.resolvedMcpServers[0].command, "node");
  assert.equal(imported.version.resolvedMcpServers[0].args[0], join(imported.version.rootPath, "server/main.cjs"));
  assert.equal((await f.manager.setEnabled(f.manifest.id, true)).enabled, true);
});

test("immutable versions, stale inspection, and explicit activation preserve the current version", async t => {
  const f = await fixture(t), first = await f.manager.importLocal(f.source);
  await f.manager.setEnabled(f.manifest.id, true);
  assert.equal((await f.manager.importLocal(f.source)).imported, false);
  const inspected = await f.manager.inspectLocal(f.source);
  await writeFile(join(f.source, "skills/example/SKILL.md"), "Changed source\n");
  await assert.rejects(f.manager.importLocal(f.source, { expectedDigest: inspected.digest }), error => error instanceof PluginManagerError && error.code === "SOURCE_CHANGED");
  await assert.rejects(f.manager.importLocal(f.source), error => error instanceof PluginManagerError && error.code === "VERSION_CONFLICT");
  assert.match(await readFile(join(first.version.rootPath, "skills/example/SKILL.md"), "utf8"), /Synthetic/);
  await f.save({ version: "2.0.0", name: "Updated plugin" });
  const second = await f.manager.importLocal(f.source);
  assert.equal(second.plugin.enabled, true); assert.equal(second.plugin.selectedDigest, first.version.digest);
  const activated = await f.manager.setEnabled(f.manifest.id, true, second.version.digest);
  assert.equal(activated.selectedDigest, second.version.digest); assert.equal(activated.name, "Updated plugin");
  assert.equal((await f.manager.collectUnused()).length, 0, "Inactive versions are not deleted without Remove.");
});

test("remove disables before awaiting use checks; queued/active versions survive until released", async t => {
  let used = true, release!: () => void, checking!: () => void;
  const checked = new Promise<void>(resolve => { checking = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let block = true;
  const f = await fixture(t, async () => { if (block) { checking(); await gate; } return used; });
  const imported = await f.manager.importLocal(f.source); await f.manager.setEnabled(f.manifest.id, true);
  const removed = f.manager.remove(f.manifest.id); await checked;
  assert.equal((await f.manager.list()).plugins[0].enabled, false);
  release(); block = false;
  assert.equal((await removed).cleanup[0].reason, "in_use");
  assert.equal(await exists(imported.version.rootPath), true);
  used = false;
  assert.equal((await f.manager.collectUnused())[0].status, "removed");
  assert.equal(await exists(imported.version.rootPath), false);
  assert.equal(await exists(join(f.source, "skills/example/SKILL.md")), true);
  assert.equal((await f.manager.list()).plugins[0].versions[0].state, "removed");
});

test("no usage callback or callback failure retains copies honestly; removed copy can be reimported disabled", async t => {
  const f = await fixture(t), imported = await f.manager.importLocal(f.source);
  await f.manager.setEnabled(f.manifest.id, true);
  assert.equal((await f.manager.remove(f.manifest.id)).cleanup[0].reason, "usage_unknown");
  assert.equal(await exists(imported.version.rootPath), true);
  await assert.rejects(f.manager.setEnabled(f.manifest.id, true), /Import the removed plugin/);
  const restored = await f.manager.importLocal(f.source);
  assert.equal(restored.plugin.removed, false); assert.equal(restored.plugin.enabled, false);
  const another = new PluginManager({ db: f.db, userData: f.userData, isVersionInUse: () => { throw new Error("usage registry offline"); } });
  const removal = await another.remove(f.manifest.id);
  assert.equal(removal.cleanup[0].reason, "usage_check_failed");
  assert.equal(await exists(imported.version.rootPath), true);
});

test("registry survives manager restart and refuses modified managed content", async t => {
  const f = await fixture(t), imported = await f.manager.importLocal(f.source);
  const restarted = new PluginManager({ db: f.db, userData: f.userData });
  assert.equal((await restarted.list()).plugins[0].versions[0].digest, imported.version.digest);
  await writeFile(join(imported.version.rootPath, "skills/example/SKILL.md"), "Tampered managed content\n");
  await assert.rejects(restarted.setEnabled(f.manifest.id, true), error => error instanceof PluginManagerError && error.code === "PLUGIN_CHANGED");
  assert.equal((await restarted.list()).plugins[0].enabled, false);
});

test("failed SQLite publication preserves previous enabled version and exposes recoverable ownership", async t => {
  const f = await fixture(t, () => false), first = await f.manager.importLocal(f.source);
  await f.manager.setEnabled(f.manifest.id, true);
  await f.save({ version: "2.0.0" });
  f.db.exec("CREATE TRIGGER synthetic_import_failure BEFORE INSERT ON akorith_plugin_versions WHEN NEW.version='2.0.0' BEGIN SELECT RAISE(ABORT,'synthetic durable commit failure'); END;");
  await assert.rejects(f.manager.importLocal(f.source), error => error instanceof PluginManagerError && error.code === "IMPORT_FAILED" && error.recovery?.phase === "published");
  const snapshot = await f.manager.list();
  assert.equal(snapshot.plugins[0].enabled, true); assert.equal(snapshot.plugins[0].selectedDigest, first.version.digest);
  assert.equal(snapshot.plugins[0].versions.length, 1); assert.equal(snapshot.recovery.length, 1);
  f.db.exec("DROP TRIGGER synthetic_import_failure");
  assert.equal((await f.manager.collectUnused())[0].status, "recovered");
  assert.equal((await f.manager.list()).recovery.length, 0);
  assert.equal(await exists(first.version.rootPath), true);
  assert.equal((await f.manager.importLocal(f.source)).plugin.selectedDigest, first.version.digest);
});

test("strict schema rejects hooks, dependencies, duplicate IDs, traversal and undeclared MCP paths", async t => {
  const f = await fixture(t);
  const cases = [
    { hooks: { install: "touch SHOULD_NOT_RUN" } },
    { dependencies: ["unvalidated-package"] },
    { id: "../escape" },
    { version: "1.0.0-01" },
    { skills: [{ id: "tools", path: "skills/example/SKILL.md" }] },
    { assets: ["../outside"] },
    { assets: ["/tmp/outside"] },
    { assets: ["server\\main.cjs"] },
    { assets: [".env"] },
    { mcpServers: [{ id: "tools", name: "Tools", command: "sh -c bad", args: [] }] },
    { mcpServers: [{ id: "tools", name: "Tools", command: "node", args: ["{pluginRoot}/not-declared.txt"] }] },
    { mcpServers: [{ id: "tools", name: "Tools", command: "node", args: ["{pluginRoot}/../outside"] }] },
  ];
  for (const patch of cases) { await f.save(patch); await assert.rejects(f.manager.inspectLocal(f.source), PluginManagerError); }
  assert.equal((await f.manager.list()).plugins.length, 0);
});

test("declared symlinks and hardlinks are rejected without copying outside content", async t => {
  const f = await fixture(t), outside = join(f.root, "outside.txt"); await writeFile(outside, "outside synthetic sentinel");
  await symlink(outside, join(f.source, "server", "linked.txt"));
  await assert.rejects(f.manager.inspectLocal(f.source), /Symlinks/);
  await rm(join(f.source, "server", "linked.txt"));
  await link(outside, join(f.source, "server", "linked.txt"));
  await assert.rejects(f.manager.inspectLocal(f.source), /one link/);
  assert.equal(await readFile(outside, "utf8"), "outside synthetic sentinel");
});

test("bounded asset count and bytes are enforced before publication", async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, "server", "huge.dat"), Buffer.alloc(8 * 1024 * 1024 + 1));
  await assert.rejects(f.manager.inspectLocal(f.source), /size limit/);
  await rm(join(f.source, "server", "huge.dat"));
  for (let index = 0; index < 512; index++) await writeFile(join(f.source, "server", `${index}.txt`), "x");
  await assert.rejects(f.manager.inspectLocal(f.source), /file count/);
  assert.equal((await f.manager.list()).plugins.length, 0);
});

test("cleanup rejects replaced ownership marker and never removes a foreign directory", async t => {
  const f = await fixture(t, () => false), imported = await f.manager.importLocal(f.source);
  await writeFile(join(imported.version.rootPath, "..", ".akorith-owner.json"), JSON.stringify({ managerId: "foreign" }));
  const removal = await f.manager.remove(f.manifest.id);
  assert.equal(removal.plugin.enabled, false); assert.equal(removal.cleanup[0].reason, "ownership_unconfirmed");
  assert.equal(await exists(imported.version.rootPath), true);
  assert.equal((await readdir(f.source)).includes("akorith.plugin.json"), true);
});

test("special asset sockets and symlinked managed roots are rejected without touching targets", async t => {
  const f = await fixture(t);
  const socket = join(f.source, "server", "special.sock"), server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  try { await assert.rejects(f.manager.inspectLocal(f.source), /regular/); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  const external = join(f.root, "external-root"); await mkdir(external); await writeFile(join(external, "sentinel.txt"), "retained");
  await symlink(external, join(f.userData, "extensions"));
  await assert.rejects(f.manager.importLocal(f.source), /real directories/);
  assert.deepEqual(await readdir(external), ["sentinel.txt"]);
});
