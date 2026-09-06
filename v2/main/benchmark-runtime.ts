import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Task, RunRequest } from '../shared/contracts';
import type { Engine } from './engine';
import type { BenchmarkStore } from './benchmark';
import type { BenchmarkLocalToolPolicy } from './benchmark-tool-policy';
import { snapshotBenchmarkWorkspace } from './benchmark-workspace';
import type { BenchmarkBrowserRecorder, BrowserRecordingSession } from './benchmark-video';
import type { BenchmarkEvidenceFiles } from './benchmark-evidence';

interface RuntimeOptions {
  benchmarks: BenchmarkStore;
  engine: Engine;
  directory: string;
  changed(): void;
  notice(text: string): void;
  recorder?: BenchmarkBrowserRecorder;
  evidence?: BenchmarkEvidenceFiles;
}
/** One comparison at a time, one variant at a time; no scheduler or autonomous retries. */
export class BenchmarkRuntime {
  private active?: { id: string; stopping: boolean; taskId?: string };
  private pending = new Set<Promise<unknown>>();
  private recordings = new Map<string, BrowserRecordingSession>();
  private closing = false;
  constructor(private readonly options: RuntimeOptions) {
    options.benchmarks.store.db.exec('CREATE TABLE IF NOT EXISTS benchmark_baselines(benchmark_id TEXT PRIMARY KEY REFERENCES benchmarks(id),path TEXT NOT NULL,digest TEXT NOT NULL,excluded TEXT NOT NULL)');
  }
  private track<T>(promise: Promise<T>) { this.pending.add(promise); void promise.finally(() => this.pending.delete(promise)).catch(() => {}); return promise; }
  async start(benchmarkId: string) {
    if (this.closing) throw new Error('Benchmark runtime is closing.');
    if (this.active) throw new Error('A comparison is already running. Stop or finish it first.');
    const record = this.options.benchmarks.read(benchmarkId);
    const remaining = record.variants.filter(v => !v.turnId);
    if (!remaining.length) throw new Error('Every variant already has a run. Create a new comparison to repeat it.');
    for (const variant of remaining) { this.options.benchmarks.assertRunnableVariant(benchmarkId, variant.id); this.policy(variant); }
    const owner = this.active = { id: benchmarkId, stopping: false };
    try { await this.track(this.next()); return this.options.benchmarks.read(benchmarkId); }
    catch (error) { if (this.active === owner) this.active = undefined; throw error; }
  }
  private policy(variant: ReturnType<BenchmarkStore['assertRunnableVariant']>): BenchmarkLocalToolPolicy | null {
    if (variant.method.kind === 'default') return null;
    if (variant.providerId !== 'ollama') throw new Error('Only the local adapter can enforce method isolation.');
    const { kind, allowedTools, mcpServerIds } = variant.method;
    if (kind === 'browser' && (allowedTools.some(name => !name.startsWith('browser_')) || mcpServerIds.length)) throw new Error('Browser method allows only browser tools and no MCP servers.');
    if (kind === 'computer' && (variant.mode !== 'full' || allowedTools.some(name => !name.startsWith('computer_')) || mcpServerIds.length)) throw new Error('Computer method requires Full access, computer tools only, and no MCP servers.');
    if (kind === 'mcp' && (allowedTools.length || !mcpServerIds.length)) throw new Error('MCP method requires selected MCP servers and no host tools.');
    if (kind !== 'mcp' && !allowedTools.length && !mcpServerIds.length) throw new Error('Choose at least one tool for the method.');
    return { allowedHostTools: [...allowedTools], allowedMcpServerIds: [...mcpServerIds] };
  }
  localPolicy(request: RunRequest): BenchmarkLocalToolPolicy | null {
    const variant = this.options.benchmarks.variantForTurn(request.turnId);
    if (!variant) return null;
    if (variant.taskId !== request.task.id) throw new Error('Benchmark turn/task mismatch.');
    return this.policy(variant);
  }
  private async baseline(id: string) {
    const db = this.options.benchmarks.store.db;
    let row = db.prepare('SELECT path,digest,excluded FROM benchmark_baselines WHERE benchmark_id=?').get(id) as { path: string; digest: string; excluded: string } | undefined;
    if (row) return row;
    const record = this.options.benchmarks.read(id), store = this.options.benchmarks.store;
    const source = record.projectId ? store.project(record.projectId)?.path : null;
    if (record.projectId && !source) throw new Error('Benchmark source project is missing.');
    await mkdir(this.options.directory, { recursive: true });
    const path = join(this.options.directory, `baseline-${id}-${randomUUID()}`);
    const snapshot = await snapshotBenchmarkWorkspace(source ?? null, path);
    row = { path, digest: snapshot.digest, excluded: JSON.stringify(snapshot.excluded) };
    db.prepare('INSERT INTO benchmark_baselines(benchmark_id,path,digest,excluded) VALUES(?,?,?,?)').run(id, row.path, row.digest, row.excluded);
    return row;
  }
  private async next() {
    const active = this.active;
    if (!active || active.stopping || this.closing) { this.active = undefined; return; }
    const record = this.options.benchmarks.read(active.id), variant = record.variants.find(v => !v.turnId);
    if (!variant) { this.active = undefined; this.options.changed(); return; }
    const base = await this.baseline(record.id);
    if (this.active !== active) return;
    if (active.stopping || this.closing) { this.active = undefined; return; }
    const workspace = join(this.options.directory, `variant-${variant.id}-${randomUUID()}`);
    const copied = await snapshotBenchmarkWorkspace(base.path, workspace);
    if (copied.digest !== base.digest) throw new Error('Stored benchmark baseline changed. Variant was not started.');
    if (this.active !== active) return;
    if (active.stopping || this.closing) { this.active = undefined; return; }
    const store = this.options.benchmarks.store, project = store.addProject(workspace, `${record.title} · ${variant.label}`, Date.now(), 'benchmark');
    let task = store.createTask({ projectId: project.id, providerId: variant.providerId, model: variant.model, title: `${record.title} · ${variant.label}` });
    task = store.updateTask(task.id, { effort: variant.effort, mode: variant.mode });
    active.taskId = task.id;
    const scope = this.policy(variant);
    await this.options.engine.send(task.id, randomUUID(), record.prompt, [], turn => {
      this.options.benchmarks.bindTurn(record.id, variant.id, task.id, turn.id, {
        toolScope: scope ? 'host-enforced' : 'unverified', workspaceIsolation: 'isolated-copy', fixtureSha256: copied.digest,
        notes: ['Independent conversation and workspace copied from the same frozen baseline.', 'Elapsed time includes context setup and runtime cleanup; recording/encoding overhead is additional work.', ...(scope ? ['Both local tool catalog and invocation are restricted; only selected MCP servers are connected.'] : ['Default method retains provider-native tools and instructions; method isolation is not claimed.']), ...(JSON.parse(base.excluded).length ? [`Excluded fixture entries: ${JSON.parse(base.excluded).join(', ')}`] : [])],
      });
    });
    this.options.changed();
  }
  async executionStarted(task: Task, turnId: string) {
    const variant = this.options.benchmarks.variantForTurn(turnId); if (!variant) return;
    this.options.benchmarks.started(turnId);
    if (this.options.recorder) {
      try { this.recordings.set(turnId, await this.options.recorder.start(task.id, turnId)); }
      catch (error) { this.options.notice(`${variant.label}: browser recording could not start: ${error instanceof Error ? error.message : String(error)}`); }
    }
    this.options.changed();
  }
  async executionSettled(_task: Task, turnId: string) {
    const record = this.options.benchmarks.syncTurn(turnId, true); if (!record) return;
    const variant = record.variants.find(v => v.turnId === turnId)!;
    const recording = this.recordings.get(turnId); this.recordings.delete(turnId);
    if (recording) {
      try {
        const captured = await recording.stop();
        if (captured.path && this.options.evidence) {
          const receipt = await this.options.evidence.capture({ path: captured.path, kind: 'video', label: 'Sampled task browser recording', origin: 'engine-capture', videoStartOffsetMs: captured.startOffsetMs }, [this.options.recorder!.directory]);
          this.options.benchmarks.recordEvidence(record.id, variant.id, { ...receipt, recordingNote: captured.note });
        }
        if (captured.note) this.options.notice(`${variant.label}: ${captured.note}`);
      } catch (error) { this.options.notice(`${variant.label}: browser recording unavailable: ${error instanceof Error ? error.message : String(error)}`); }
    }
    this.options.changed();
    if (this.active?.id === record.id) {
      // Do not enqueue inside Engine's current settlement stack.
      const owner = this.active;
      queueMicrotask(() => { if (this.active !== owner) return; void this.track(this.next()).catch(error => { if (this.active === owner) this.active = undefined; this.options.notice(error instanceof Error ? error.message : String(error)); this.options.changed(); }); });
    }
  }
  async stop(benchmarkId: string) {
    if (this.active?.id !== benchmarkId) return this.options.benchmarks.read(benchmarkId);
    const active = this.active; active.stopping = true;
    if (active.taskId) await this.options.engine.stop(active.taskId);
    if (this.active === active) this.active = undefined;
    this.options.changed(); return this.options.benchmarks.read(benchmarkId);
  }
  async dispose() {
    this.closing = true;
    if (this.active) await this.stop(this.active.id);
    await Promise.allSettled([...this.pending]);
    await Promise.all([...this.recordings.values()].map(recording => recording.stop()));
    this.recordings.clear();
  }
}
