import { validateEvidenceReceipt } from './benchmark-evidence';
import { randomUUID, createHash } from 'node:crypto';
import type { Store } from './storage';
import type { BenchmarkCreate, BenchmarkEvidence, BenchmarkExecutionProof, BenchmarkMethod, BenchmarkRecord, BenchmarkSummary, BenchmarkVariant } from './benchmark-types';

export const benchmarkTerminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const providers = ['codex', 'claude', 'opencode', 'ollama'];
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const emptyUsage = () => ({ inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null, estimated: null });
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a benchmark object.');
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, limit: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > limit || value.includes('\0')) throw new Error(`Invalid ${label}.`);
  return value;
}
function names(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error('Tool scope must be an explicit bounded list.');
  return [...new Set(value.map(item => text(item, 'tool identifier', 200)))].sort();
}
function method(input: unknown): BenchmarkMethod {
  const item = object(input);
  if (!['default', 'browser', 'computer', 'mcp', 'custom'].includes(String(item.kind))) throw new Error('Invalid benchmark method.');
  return { kind: item.kind as BenchmarkMethod['kind'], allowedTools: names(item.allowedTools), mcpServerIds: names(item.mcpServerIds), ...(item.notes === undefined ? {} : { notes: text(item.notes, 'method notes', 4000, true) }) };
}
function proof(input: BenchmarkExecutionProof): BenchmarkExecutionProof {
  if (!['unverified', 'host-enforced', 'native-enforced'].includes(input.toolScope) || !['unverified', 'isolated-copy', 'shared-read-only'].includes(input.workspaceIsolation)) throw new Error('Invalid execution proof.');
  if (input.fixtureSha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.fixtureSha256)) throw new Error('Invalid fixture digest.');
  if (!Array.isArray(input.notes) || input.notes.length > 20) throw new Error('Invalid execution notes.');
  return { ...input, notes: input.notes.map(note => text(note, 'execution note', 4000, true)) };
}
const metric = (value: unknown, integer = false): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 && (!integer || Number.isSafeInteger(value)) ? value : null;

/** Main-process only. Never expose bind/start/settle or proof fields as renderer writes. */
export class BenchmarkStore {
  private readonly clocks = new Map<string, number>();
  constructor(readonly store: Store, private readonly clock = { now: () => Date.now(), monotonic: () => performance.now() }) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS benchmarks(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS benchmark_turns(turn_id TEXT PRIMARY KEY REFERENCES turns(id),benchmark_id TEXT NOT NULL REFERENCES benchmarks(id),variant_id TEXT NOT NULL UNIQUE);`);
  }
  create(raw: BenchmarkCreate | unknown): BenchmarkRecord {
    const input = object(raw), title = text(input.title, 'benchmark title', 200), prompt = text(input.prompt, 'benchmark prompt', 200_000).trim();
    const projectId = input.projectId == null ? null : text(input.projectId, 'project identifier', 160);
    if (projectId && !this.store.project(projectId)) throw new Error('Benchmark project not found.');
    if (!Array.isArray(input.variants) || input.variants.length < 2 || input.variants.length > 8) throw new Error('Compare between two and eight variants.');
    const variants = input.variants.map(raw => {
      const variant = object(raw);
      if (!providers.includes(String(variant.providerId)) || !['read', 'work', 'full'].includes(String(variant.mode))) throw new Error('Invalid execution profile.');
      return { id: randomUUID(), label: text(variant.label, 'variant label', 120), providerId: variant.providerId, model: text(variant.model, 'model', 300), effort: text(variant.effort, 'effort', 50, true), mode: variant.mode,
        method: method(variant.method), taskId: null, turnId: null, status: 'not-started', startedAt: null, finishedAt: null, durationMs: null, timingSource: 'unavailable', usage: emptyUsage(), output: '',
        execution: { toolScope: 'unverified', workspaceIsolation: 'unverified', notes: [] }, evidence: [], humanNotes: '',
      } as BenchmarkVariant;
    });
    const now = this.clock.now();
    const record: BenchmarkRecord = { schemaVersion: 1, id: randomUUID(), title, prompt, promptSha256: sha(prompt), projectId, createdAt: now, updatedAt: now, humanNotes: '', variants };
    this.store.db.prepare('INSERT INTO benchmarks(id,created_at,updated_at,data) VALUES(?,?,?,?)').run(record.id, now, now, JSON.stringify(record));
    return structuredClone(record);
  }
  read(id: string): BenchmarkRecord {
    const row = this.store.db.prepare('SELECT data FROM benchmarks WHERE id=?').get(text(id, 'benchmark identifier', 160)) as { data: string } | undefined;
    if (!row) throw new Error('Benchmark not found.');
    return JSON.parse(row.data);
  }
  list(): BenchmarkSummary[] {
    return (this.store.db.prepare('SELECT data FROM benchmarks ORDER BY updated_at DESC,id').all() as Array<{ data: string }>).map(row => {
      const r: BenchmarkRecord = JSON.parse(row.data);
      return { id: r.id, title: r.title, createdAt: r.createdAt, updatedAt: r.updatedAt, variantCount: r.variants.length, terminalCount: r.variants.filter(v => benchmarkTerminal.has(v.status)).length, runningCount: r.variants.filter(v => ['queued', 'starting', 'running', 'waiting', 'cancelling'].includes(v.status)).length };
    });
  }
  private save(record: BenchmarkRecord) {
    record.updatedAt = this.clock.now();
    this.store.db.prepare('UPDATE benchmarks SET updated_at=?,data=? WHERE id=?').run(record.updatedAt, JSON.stringify(record), record.id);
    return record;
  }
  private variant(record: BenchmarkRecord, id: string) {
    const result = record.variants.find(v => v.id === id);
    if (!result) throw new Error('Benchmark variant not found.');
    return result;
  }
  assertRunnableVariant(benchmarkId: string, variantId: string): BenchmarkVariant {
    const variant = this.variant(this.read(benchmarkId), variantId);
    if (variant.turnId) throw new Error('This variant already has a run. Create a new comparison to run it again.');
    if (variant.method.kind !== 'default' && variant.providerId !== 'ollama')
      throw new Error('Method isolation is unavailable for this native provider. Its additional native tools cannot be restricted by Akorith.');
    return variant;
  }
  /** Bind only to a real accepted turn with the exact common prompt/profile. */
  bindTurn(benchmarkId: string, variantId: string, taskId: string, turnId: string, execution: BenchmarkExecutionProof): BenchmarkRecord {
    return this.store.db.transaction(() => {
      const record = this.read(benchmarkId), variant = this.variant(record, variantId), turn = this.store.turn(turnId), verified = proof(execution);
      if (variant.method.kind !== 'default' && (variant.providerId !== 'ollama' || verified.toolScope !== 'host-enforced')) throw new Error('Requested method isolation is not enforceable for this variant.');
      if (turn.taskId !== taskId || turn.prompt !== record.prompt || turn.providerId !== variant.providerId || turn.model !== variant.model || turn.effort !== variant.effort || turn.mode !== variant.mode) throw new Error('Accepted turn does not match benchmark prompt and execution profile.');
      if (variant.turnId) {
        if (variant.turnId !== turnId || variant.taskId !== taskId) throw new Error('Benchmark variant is already bound.');
        return record;
      }
      if (record.variants.some(v => v.taskId === taskId)) throw new Error('Each variant requires a separate task to isolate its conversation.');
      if (this.store.db.prepare('SELECT 1 FROM benchmark_turns WHERE turn_id=?').get(turnId)) throw new Error('This turn already belongs to a benchmark.');
      this.store.db.prepare('INSERT INTO benchmark_turns(turn_id,benchmark_id,variant_id) VALUES(?,?,?)').run(turnId, benchmarkId, variantId);
      Object.assign(variant, { taskId, turnId, status: turn.status, execution: verified });
      return this.save(record);
    })();
  }
  private bound(turnId: string) {
    const row = this.store.db.prepare('SELECT benchmark_id,variant_id FROM benchmark_turns WHERE turn_id=?').get(turnId) as { benchmark_id: string; variant_id: string } | undefined;
    if (!row) return null;
    const record = this.read(row.benchmark_id);
    return { record, variant: this.variant(record, row.variant_id) };
  }
  /** Call at actual execution start, not when queued or clicked. Duplicate calls are inert. */
  started(turnId: string): void {
    const found = this.bound(turnId); if (!found || found.variant.startedAt !== null) return;
    const turn = this.store.turn(turnId);
    if (!['starting', 'running', 'waiting', 'cancelling'].includes(turn.status)) throw new Error('Benchmark turn has not started.');
    found.variant.startedAt = this.clock.now(); found.variant.status = turn.status;
    this.clocks.set(turnId, this.clock.monotonic()); this.save(found.record);
  }
  /** Snapshot real persisted output/usage/status; complete timing only after quiescence. */
  syncTurn(turnId: string, quiescent = false): BenchmarkRecord | null {
    const found = this.bound(turnId); if (!found) return null;
    const turn = this.store.turn(turnId), message = this.store.messages(turn.taskId).find(m => m.turnId === turnId && m.role === 'assistant');
    const v = found.variant; v.status = turn.status;
    if (message) {
      v.output = message.content;
      const u = message.usage;
      v.usage = { inputTokens: metric(u?.inputTokens, true), outputTokens: metric(u?.outputTokens, true), totalTokens: metric(u?.totalTokens, true), costUsd: metric(u?.costUsd), estimated: u ? u.estimated === true : null };
    }
    if (quiescent && benchmarkTerminal.has(turn.status) && v.finishedAt === null) {
      const started = this.clocks.get(turnId);
      if (started !== undefined) {
        const duration = this.clock.monotonic() - started;
        if (Number.isFinite(duration) && duration >= 0) { v.durationMs = duration; v.timingSource = 'engine-monotonic'; }
        v.finishedAt = this.clock.now(); this.clocks.delete(turnId);
      }
      // After restart no finish timestamp or elapsed measurement is fabricated.
    }
    return this.save(found.record);
  }
  variantForTurn(turnId: string): BenchmarkVariant | null {
    return this.bound(turnId)?.variant ?? null;
  }
  /** Invoke after Store startup recovery; retain unavailable timing on interrupted work. */
  reconcile(): void {
    for (const row of this.store.db.prepare('SELECT turn_id FROM benchmark_turns').all() as Array<{ turn_id: string }>) this.syncTurn(row.turn_id);
  }
  annotate(benchmarkId: string, notes: unknown, variantId?: string): BenchmarkRecord {
    const record = this.read(benchmarkId), value = text(notes, 'human notes', 20_000, true);
    if (variantId) this.variant(record, variantId).humanNotes = value; else record.humanNotes = value;
    return this.save(record);
  }
  /** Receives only a receipt produced by the trusted managed evidence copier. */
  recordEvidence(benchmarkId: string, variantId: string, evidence: BenchmarkEvidence): BenchmarkRecord {
    validateEvidenceReceipt(evidence);
    const record = this.read(benchmarkId), variant = this.variant(record, variantId);
    if (!variant.turnId) throw new Error('Start the variant before attaching evidence.');
    if (variant.evidence.length >= 32 || variant.evidence.some(e => e.id === evidence.id)) throw new Error('Evidence limit reached or duplicate receipt.');
    variant.evidence.push(structuredClone(evidence)); return this.save(record);
  }
}
