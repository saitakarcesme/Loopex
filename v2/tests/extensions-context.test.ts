import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { Extensions } from '../main/extensions';
import { PluginManager } from '../main/plugins';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function exists(path: string) {
  try { await stat(path); return true; } catch (error: any) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
async function fixture(t: any, instructions = 'Use the synthetic project reference KIRAZ-421.') {
  const root = await mkdtemp(join(tmpdir(), 'akorith-p18-context-'));
  const projectA = { id: 'project-a', path: join(root, 'project-a'), name: 'Synthetic A' };
  const projectB = { id: 'project-b', path: join(root, 'project-b'), name: 'Synthetic B' };
  await mkdir(projectA.path); await mkdir(projectB.path);
  await writeFile(join(projectA.path, 'AGENTS.md'), instructions);
  const db = new Database(join(root, 'synthetic.sqlite'));
  let settings: any = { skills: [], mcpServers: [], ollamaUrl: 'http://127.0.0.1:11434' };
  let settingsReads = 0;
  const task: any = {
    id: 'task-a', projectId: projectA.id, providerId: 'codex', model: 'synthetic-model',
    mode: 'work', effort: 'medium', title: 'Synthetic task', nativeSessions: {},
  };
  const store: any = {
    db,
    settings: () => { settingsReads++; return structuredClone(settings); },
    project: (id: string) => [projectA, projectB].find(project => project.id === id) ?? null,
    projects: () => [projectA, projectB],
    task: (id: string) => id === task.id ? task : null,
  };
  const plugins = new PluginManager({ db, userData: join(root, 'data'), isVersionInUse: () => false });
  const extensions = new Extensions(store, { plugins, skillRoots: () => [] });
  // Deliberate fixture boundary: never touch ~/.agents, ~/.codex or real projects.
  t.after(async () => {
    await extensions.dispose();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  async function addPlugin(id = 'synthetic-plugin', skillText = 'Apply the synthetic plugin skill.') {
    const source = join(root, `${id}-source`);
    await mkdir(join(source, 'skills'), { recursive: true });
    await writeFile(join(source, 'skills', 'SKILL.md'), skillText);
    await writeFile(join(source, 'akorith.plugin.json'), JSON.stringify({
      schemaVersion: 1, id, version: '1.0.0', name: id,
      skills: [{ id: 'fixture-skill', path: 'skills/SKILL.md' }],
      mcpServers: [{ id: 'fixture-mcp', name: 'Synthetic configuration only', command: 'node', args: ['--version'] }],
    }));
    const imported = await plugins.importLocal(source);
    await plugins.setEnabled(id, true, imported.version.digest);
    return { ...imported, source, id };
  }
  return {
    root, projectA, projectB, task, store, plugins, extensions, addPlugin,
    get settingsReads() { return settingsReads; },
    setSettings(value: any) { settings = value; },
    getSettings() { return structuredClone(settings); },
  };
}

test('plugin copies remain owned while a prepared turn is pinned even if external usage says false', async t => {
  const f = await fixture(t); const plugin = await f.addPlugin();
  const controller = new AbortController();
  const prepared = await f.extensions.prepare(f.task, 'turn-pinned', controller.signal);
  assert.equal(prepared.manifest.selectionTiming, 'turn-start');
  assert.ok(prepared.manifest.sources.some(source => source.plugin?.pluginId === plugin.id));
  assert.ok(prepared.mcpServers.some(server => server.plugin?.pluginId === plugin.id));
  await f.plugins.remove(plugin.id);
  assert.equal(await exists(plugin.version.rootPath), true, 'remove must retain a pinned copy');
  controller.abort();
  await f.plugins.collectUnused();
  assert.equal(await exists(plugin.version.rootPath), true, 'post-return abort is not quiescence');
  await prepared.release(); await prepared.release();
  await f.plugins.collectUnused();
  assert.equal(await exists(plugin.version.rootPath), false, 'explicit release permits managed cleanup');
  assert.equal(await exists(join(plugin.source, 'skills', 'SKILL.md')), true, 'source is never removed');
});

test('abort while acquire is pending releases its pin before prepare rejects', async t => {
  const f = await fixture(t); const plugin = await f.addPlugin();
  const acquired = deferred(); const resume = deferred();
  const actualAcquire = f.plugins.acquireEnabled.bind(f.plugins);
  f.plugins.acquireEnabled = async turnId => {
    const versions = await actualAcquire(turnId);
    acquired.resolve(); await resume.promise; return versions;
  };
  const controller = new AbortController();
  const preparing = f.extensions.prepare(f.task, 'turn-aborted', controller.signal);
  const rejection = assert.rejects(preparing, /abort/i);
  await acquired.promise;
  await f.plugins.remove(plugin.id);
  assert.equal(await exists(plugin.version.rootPath), true, 'pin exists before delayed acquire returns');
  controller.abort(); resume.resolve(); await rejection;
  await f.plugins.collectUnused();
  assert.equal(await exists(plugin.version.rootPath), false, 'aborted preparation cannot leak a pin');
});

test('one preparation snapshots settings before asynchronous plugin verification', async t => {
  const f = await fixture(t);
  const original = {
    skills: ['missing-selected-skill'], ollamaUrl: 'http://127.0.0.1:19191',
    mcpServers: [{ id: 'original', name: 'Original', enabled: true, command: 'node', args: ['original'] }],
  };
  f.setSettings(original);
  const acquired = deferred(); const resume = deferred();
  const actualAcquire = f.plugins.acquireEnabled.bind(f.plugins);
  f.plugins.acquireEnabled = async turnId => {
    const versions = await actualAcquire(turnId);
    acquired.resolve(); await resume.promise; return versions;
  };
  const readsBefore = f.settingsReads;
  const pending = f.extensions.prepare(f.task, 'turn-snapshot');
  await acquired.promise;
  f.setSettings({ skills: [], ollamaUrl: 'http://127.0.0.1:29292', mcpServers: [] });
  resume.resolve();
  const prepared = await pending;
  assert.equal(f.settingsReads - readsBefore, 1);
  assert.equal(prepared.ollamaUrl, original.ollamaUrl);
  assert.deepEqual(prepared.mcpServers.map(server => server.id), ['original']);
  assert.ok(prepared.manifest.sources.some(source => source.id === 'missing-selected-skill' && source.state === 'unavailable'));
  await prepared.release();
});

test('context fingerprint excludes turn/time identity and changes with content or resolved MCP configuration', async t => {
  const f = await fixture(t);
  const settings = f.getSettings();
  settings.mcpServers = [{ id: 'global', name: 'Fixture', enabled: true, command: 'node', args: ['one'] }];
  f.setSettings(settings);
  const first = await f.extensions.prepare(f.task, 'turn-one');
  const second = await f.extensions.prepare(f.task, 'turn-two');
  assert.notEqual(first.manifest.id, second.manifest.id);
  assert.notEqual(first.manifest.turnId, second.manifest.turnId);
  assert.equal(first.manifest.fingerprint, second.manifest.fingerprint);
  assert.equal(first.manifest.systemSha256, hash(first.systemContext));
  await writeFile(join(f.projectA.path, 'AGENTS.md'), 'Changed synthetic project reference ERIK-842.');
  const changedContent = await f.extensions.prepare(f.task, 'turn-three');
  assert.notEqual(changedContent.manifest.fingerprint, first.manifest.fingerprint);
  settings.mcpServers[0].args = ['two']; f.setSettings(settings);
  const changedConfiguration = await f.extensions.prepare(f.task, 'turn-four');
  assert.notEqual(changedConfiguration.manifest.fingerprint, changedContent.manifest.fingerprint);
  for (const prepared of [first, second, changedContent, changedConfiguration]) await prepared.release();
});

test('manual MCP is isolated by project, global MCP is shared, and disabled MCP is excluded', async t => {
  const f = await fixture(t);
  const server = (id: string, projectId?: string, enabled = true) => ({ id, name: id, command: 'node', args: [], enabled, projectId });
  f.setSettings({ skills: [], mcpServers: [server('global'), server('a', f.projectA.id), server('b', f.projectB.id), server('disabled', undefined, false)] });
  const a = await f.extensions.prepare(f.task, 'turn-a');
  const b = await f.extensions.prepare({ ...f.task, id: 'task-b', projectId: f.projectB.id }, 'turn-b');
  const unscoped = await f.extensions.prepare({ ...f.task, id: 'task-global', projectId: null }, 'turn-global');
  assert.deepEqual(a.mcpServers.map(server => server.id).sort(), ['a', 'global']);
  assert.deepEqual(b.mcpServers.map(server => server.id).sort(), ['b', 'global']);
  assert.deepEqual(unscoped.mcpServers.map(server => server.id), ['global']);
  assert.ok(a.manifest.mcpServers.every(server => server.state === 'configured'));
  for (const prepared of [a, b, unscoped]) await prepared.release();
});

test('UTF-8 budgets include block framing and preserve complete Turkish and emoji codepoints', async t => {
  const body = 'Türkçe 🧪 çalışma\n'.repeat(9000);
  const f = await fixture(t, body); await f.addPlugin('unicode-plugin', body);
  const prepared = await f.extensions.prepare(f.task, 'turn-unicode');
  assert.ok(Buffer.byteLength(prepared.systemContext, 'utf8') <= 104000, '40k instructions + 64k skills including framing');
  assert.equal(prepared.manifest.systemBytes, Buffer.byteLength(prepared.systemContext, 'utf8'));
  assert.equal(prepared.manifest.systemSha256, hash(prepared.systemContext));
  assert.equal(prepared.systemContext.includes('\uFFFD'), false);
  const included = prepared.manifest.sources.filter(source => source.state === 'included' || source.state === 'truncated');
  assert.equal(included.length, 2);
  for (const source of included) {
    assert.equal(source.state, 'truncated');
    assert.equal(source.sha256, hash(body));
    assert.equal(source.originalBytes, Buffer.byteLength(body, 'utf8'));
    assert.ok(source.includedBytes > 0 && source.includedBytes < source.originalBytes!);
    assert.ok(source.reason);
  }
  await prepared.release();
});

test('preview releases its pin, marks configured MCP honestly, and cannot imply provider transport', async t => {
  const f = await fixture(t); const plugin = await f.addPlugin();
  const preview = await f.extensions.preview(f.task);
  assert.equal(preview.selectionTiming, 'turn-start');
  assert.equal(preview.nativeInheritance, 'unknown');
  assert.ok(preview.mcpServers.every(server => server.state === 'configured'));
  assert.equal('deliveries' in preview, false, 'preparation is not a provider submission receipt');
  await f.plugins.remove(plugin.id); await f.plugins.collectUnused();
  assert.equal(await exists(plugin.version.rootPath), false, 'preview must not leak a turn pin');
});

test('duplicate preparation cannot discard the original bundle cleanup ownership', async t => {
  const f = await fixture(t); const plugin = await f.addPlugin();
  await f.extensions.prepare(f.task, 'same-turn');
  await assert.rejects(f.extensions.prepare(f.task, 'same-turn'), /unique turn ID/);
  await f.plugins.remove(plugin.id);
  assert.equal(await exists(plugin.version.rootPath), true);
  await f.extensions.dispose();
  await f.plugins.collectUnused();
  assert.equal(await exists(plugin.version.rootPath), false);
});

test('managed skills are delivered as instructions with honest native catalog guidance', async t => {
  const f = await fixture(t);
  const body = 'When explicitly asked, use inventory_health and report its actual output.';
  await f.addPlugin('guidance-plugin', body);
  const prepared = await f.extensions.prepare({ ...f.task, providerId: 'opencode' }, 'native-guidance');
  const source = prepared.manifest.sources.find(source => source.plugin?.pluginId === 'guidance-plugin')!;
  assert.equal(source.state, 'included');
  assert.equal(source.includedBytes, Buffer.byteLength(body));
  assert.equal(source.sha256, hash(body), 'source hash remains the original skill, not wrapper text');
  assert.ok(prepared.systemContext.includes(body));
  assert.match(prepared.systemContext, /already supplied below as context text/);
  assert.match(prepared.systemContext, /do not call a native skill loader to load this source by name/);
  assert.match(prepared.systemContext, /not registered this source in the provider's native skill catalog/);
  assert.match(prepared.systemContext, /only when exposed by the actual tool catalog/);
  assert.ok(prepared.manifest.notes.some(note => note.includes('not as verified entries')));
  assert.equal(prepared.manifest.systemBytes, Buffer.byteLength(prepared.systemContext));
  assert.equal(prepared.manifest.systemSha256, hash(prepared.systemContext));
  await prepared.release();
});
