import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../main/storage';
import { PluginManager } from '../main/plugins';
import { Extensions } from '../main/extensions';
import { extensionCommand, assertManualMcp } from '../main/extension-commands';
import { quiesceExtensions } from '../main/extension-shutdown';
import type { PluginImportResult, PluginInspection } from '../shared/plugin-contracts';
import type { TurnContextManifest } from '../shared/context-contracts';

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'akorith-extension-ipc-'));
  const source = join(root, 'source'); await mkdir(source);
  await writeFile(join(source, 'SKILL.md'), 'Synthetic plugin instruction');
  await writeFile(join(source, 'akorith.plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'fixture', version: '1.0.0', name: 'Fixture', skills: [{ id: 'example', path: 'SKILL.md' }], mcpServers: [{ id: 'tools', name: 'Fixture tools', command: 'never-run', args: [] }] }));
  const store = new Store(join(root, 'workspace.sqlite'));
  const plugins = new PluginManager({ db: store.db, userData: root });
  const extensions = new Extensions(store, { plugins, skillRoots: () => [] });
  let changes = 0;
  const services = { store, plugins, extensions, changed: () => { changes++; }, pickLocal: async () => null };
  t.after(async () => { await extensions.dispose(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, source, store, plugins, extensions, changes: () => changes, run: (name: string, p = {}) => extensionCommand(name, p, services) };
}

test('plugin IPC cancellation, stale review rejection, disabled import, and conservative removal', async t => {
  const f = await fixture(t);
  assert.equal(await f.run('plugins:pickLocal'), null);
  assert.equal((await f.plugins.list()).plugins.length, 0);
  const initial = await f.run('plugins:inspectLocal', { path: f.source }) as PluginInspection;
  await writeFile(join(f.source, 'SKILL.md'), 'Changed after review');
  await assert.rejects(f.run('plugins:importLocal', { path: f.source, expectedDigest: initial.digest }), /changed/i);
  assert.equal(f.changes(), 0);
  const inspected = await f.run('plugins:inspectLocal', { path: f.source }) as PluginInspection;
  const imported = await f.run('plugins:importLocal', { path: f.source, expectedDigest: inspected.digest }) as PluginImportResult;
  assert.equal(imported.plugin.enabled, false);
  const listed = await f.run('mcp:list') as import('../shared/contracts').McpServer[];
  assert.equal(listed.length, 1); assert.equal(listed[0].enabled, false); assert.equal(listed[0].plugin?.pluginId, 'fixture');
  assert.equal(f.store.settings().mcpServers.length, 0);
  await assert.rejects(f.run('plugins:setEnabled', { pluginId: 'fixture', enabled: 'yes' }), /state/);
  const removed = await f.run('plugins:remove', { pluginId: 'fixture' }) as Awaited<ReturnType<PluginManager['remove']>>;
  assert.equal(removed.plugin.removed, true);
  assert.ok(removed.cleanup.some(item => item.status === 'retained' && item.reason === 'usage_unknown'));
  assert.equal(await readFile(join(imported.version.rootPath, 'SKILL.md'), 'utf8'), 'Changed after review');
});

test('context preview reflects explicit activation without inventing recorded turn context', async t => {
  const f = await fixture(t), task = f.store.createTask({ providerId: 'ollama', model: 'fixture' });
  const inspected = await f.run('plugins:inspectLocal', { path: f.source }) as PluginInspection;
  await f.run('plugins:importLocal', { path: f.source, expectedDigest: inspected.digest });
  const before = await f.run('context:preview', { taskId: task.id }) as TurnContextManifest;
  assert.equal(before.sources.length, 0);
  await f.run('plugins:setEnabled', { pluginId: 'fixture', enabled: true, digest: inspected.digest });
  const after = await f.run('context:preview', { taskId: task.id }) as TurnContextManifest;
  assert.equal(after.sources[0]?.plugin?.pluginId, 'fixture');
  assert.equal(after.sources[0]?.state, 'included');
  assert.equal(await f.run('context:read', { taskId: task.id, turnId: after.turnId }), null);
  await assert.rejects(f.run('context:preview', { taskId: 'missing' }), /Task not found/);
});

test('manual MCP project validation rejects missing scope and plugin impersonation', async t => {
  const f = await fixture(t), server = { id: 'mcp', name: 'Fixture', command: 'never-run', args: [], enabled: true };
  assert.doesNotThrow(() => assertManualMcp(f.store, server));
  assert.throws(() => assertManualMcp(f.store, { ...server, projectId: 'missing' }), /project is missing/);
  assert.doesNotThrow(() => assertManualMcp(f.store, { ...server, projectId: 'missing' }, false));
  const project = f.store.addProject(f.root, 'Synthetic');
  assert.doesNotThrow(() => assertManualMcp(f.store, { ...server, projectId: project.id }));
  assert.throws(() => assertManualMcp(f.store, { ...server, plugin: { pluginId: 'fixture', digest: 'a'.repeat(64), version: '1.0.0' } }, false), /managed through/);
});

test('shutdown retains extension pins after failed consumers and awaits accepted IPC before release', async () => {
  let releases = 0, hostAttempts = 0, fail = true, settle!: () => void;
  const accepted = new Promise<void>(resolve => { settle = resolve; });
  const resources = {
    engine: async () => { if (fail) throw new Error('native ownership unknown'); },
    host: async () => { hostAttempts++; },
    commands: () => accepted,
    extensions: async () => { releases++; },
  };
  let finished = false;
  const first = quiesceExtensions(resources); void first.then(() => { finished = true; }, () => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases, 0); assert.equal(hostAttempts, 1); assert.equal(finished, false);
  settle(); await assert.rejects(first, /native ownership unknown/); assert.equal(releases, 0);
  fail = false; await quiesceExtensions(resources); assert.equal(releases, 1);
});
