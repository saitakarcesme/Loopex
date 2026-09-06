import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../main/storage';
import { Engine } from '../main/engine';
import { BenchmarkStore } from '../main/benchmark';
import { BenchmarkRuntime } from '../main/benchmark-runtime';
import { scopedBenchmarkHost } from '../main/benchmark-tool-policy';
import type { ProviderAdapter, RunRequest, ProviderEvent, HostTools } from '../shared/contracts';

async function until(check: () => boolean) { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw new Error('Timed out waiting for benchmark fixture'); await new Promise(r => setTimeout(r, 10)); } }
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'akorith-benchmark-runtime-')); const store = new Store(join(root, 'db.sqlite')), benchmarks = new BenchmarkStore(store);
  const runs: Array<{ request: RunRequest; emit(event: ProviderEvent): void; finish(): void }> = [], order: string[] = [];
  const provider: ProviderAdapter = { id: 'ollama', discover: async () => { throw new Error('unused'); }, dispose: async () => {}, run(request, emit) {
    assert.equal(benchmarks.variantForTurn(request.turnId)?.turnId, request.turnId, 'binding must precede provider execution'); order.push('provider');
    let finish!: () => void; const done = new Promise<void>(resolve => { finish = resolve; }); runs.push({ request, emit, finish });
    return { done, interrupt: async () => { finish(); }, respond: async () => {} };
  } };
  let runtime!: BenchmarkRuntime;
  const engine = new Engine(store, [provider], task => store.project(task.projectId!)!.path, async () => '', () => {}, {
    executionStarted: async (task, turnId) => { order.push('started'); await runtime.executionStarted(task, turnId); },
    executionSettled: async (task, turnId) => { assert.ok(['completed', 'failed', 'cancelled', 'interrupted'].includes(store.turn(turnId).status)); order.push('settled'); await runtime.executionSettled(task, turnId); },
  });
  runtime = new BenchmarkRuntime({ benchmarks, engine, directory: join(root, 'workspaces'), changed: () => {}, notice: () => {} });
  t.after(async () => { await runtime.dispose(); await engine.shutdown(); store.close(); await rm(root, { recursive: true, force: true }); });
  const source = join(root, 'source'); await mkdir(source); await mkdir(join(source, 'empty')); await writeFile(join(source, 'seed.txt'), 'identical baseline');
  const project = store.addProject(source, 'Fixture');
  const record = benchmarks.create({ title: 'Runtime fixture', prompt: 'Use the common fixture', projectId: project.id, variants: ['A', 'B'].map(label => ({ label, providerId: 'ollama', model: 'fixture', effort: '', mode: 'read', method: { kind: 'default', allowedTools: [], mcpServerIds: [] } })) });
  return { root, source, store, benchmarks, engine, runtime, runs, order, record };
}
test('runtime binds before execution, runs sequential independent copies, and freezes a common baseline', async t => {
  const f = await fixture(t); await f.runtime.start(f.record.id); await until(() => f.runs.length === 1);
  assert.deepEqual(f.order, ['started', 'provider']);
  const first = f.runs[0]; assert.equal(await readFile(join(first.request.cwd, 'seed.txt'), 'utf8'), 'identical baseline');
  await writeFile(join(first.request.cwd, 'seed.txt'), 'variant A mutation'); await writeFile(join(f.source, 'seed.txt'), 'later source mutation');
  assert.equal(f.runs.length, 1); first.emit({ type: 'final', text: 'A result' }); first.finish();
  await until(() => f.runs.length === 2);
  const second = f.runs[1]; assert.notEqual(second.request.cwd, first.request.cwd);
  assert.equal(await readFile(join(second.request.cwd, 'seed.txt'), 'utf8'), 'identical baseline');
  second.emit({ type: 'final', text: 'B result' }); second.finish();
  await until(() => f.benchmarks.read(f.record.id).variants.every(v => v.status === 'completed'));
  const result = f.benchmarks.read(f.record.id);
  assert.equal(result.variants[0].execution.fixtureSha256, result.variants[1].execution.fixtureSha256);
  assert.ok(result.variants.every(v => v.execution.workspaceIsolation === 'isolated-copy' && v.durationMs !== null));
  assert.deepEqual(f.order, ['started', 'provider', 'settled', 'started', 'provider', 'settled']);
});
test('atomic acceptance hook rollback leaves no queued turn and never starts a provider', async t => {
  const f = await fixture(t), project = f.store.projects()[0], task = f.store.createTask({ projectId: project.id, providerId: 'ollama', model: 'fixture' });
  await assert.rejects(f.engine.send(task.id, randomUUID(), 'rollback', [], () => { throw new Error('binding rejected'); }), /binding rejected/);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.store.queued(task.id).length, 0); assert.equal(f.store.messages(task.id).length, 0); assert.equal(f.runs.length, 0);
});
test('Stop interrupts only the active variant and never launches remaining variants', async t => {
  const f = await fixture(t); await f.runtime.start(f.record.id); await until(() => f.runs.length === 1);
  await f.runtime.stop(f.record.id); await new Promise(resolve => setTimeout(resolve, 50));
  const result = f.benchmarks.read(f.record.id); assert.equal(f.runs.length, 1); assert.equal(result.variants[1].status, 'not-started');
  assert.ok(['cancelled', 'interrupted'].includes(result.variants[0].status));
});
test('method wrapper filters search catalog and refuses forged execution or other task/turn contexts', async () => {
  const calls: string[] = []; const host: HostTools = { definitions: ['browser_open', 'files_read', 'terminal_execute'].map(name => ({ name, description: name, inputSchema: {} })), execute: async name => { calls.push(name); return 'real fixture result'; }, dispose: async () => {} };
  const request = { task: { id: 'task' }, turnId: 'turn' } as RunRequest;
  const scoped = scopedBenchmarkHost(host, request, { allowedHostTools: ['browser_open'], allowedMcpServerIds: [] });
  assert.deepEqual(scoped.definitions.map(tool => tool.name), ['browser_open']);
  const context = { taskId: 'task', turnId: 'turn', cwd: '/fixture', mode: 'work' as const };
  await assert.rejects(scoped.execute('terminal_execute', {}, context), /outside/);
  await assert.rejects(scoped.execute('browser_open', {}, { ...context, turnId: 'other' }), /outside/);
  await scoped.execute('browser_open', {}, context); assert.deepEqual(calls, ['browser_open']);
  assert.throws(() => scopedBenchmarkHost(host, request, { allowedHostTools: ['browser_unknown'], allowedMcpServerIds: [] }), /unavailable/);
});
