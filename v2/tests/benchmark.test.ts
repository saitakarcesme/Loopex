import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { Store } from '../main/storage';
import { BenchmarkStore } from '../main/benchmark';
import { BenchmarkEvidenceFiles } from '../main/benchmark-evidence';
import { benchmarkComparisonHtml, exportBenchmarkComparison } from '../main/benchmark-export';
import type { BenchmarkCreate, BenchmarkExecutionProof } from '../main/benchmark-types';

const input = (): BenchmarkCreate => ({ title: 'Compare real work', prompt: 'Same exact prompt\nwith a second line', variants: ['A', 'B'].map(label => ({ label, providerId: 'ollama', model: 'fixture', effort: '', mode: 'work', method: { kind: 'default', allowedTools: [], mcpServerIds: [] } })) });
const proof: BenchmarkExecutionProof = { toolScope: 'unverified', workspaceIsolation: 'unverified', notes: ['Fixture tests do not prove runtime isolation.'] };
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'akorith-benchmark-'));
  let store = new Store(join(root, 'db.sqlite')); let now = 1000, mono = 0;
  let benchmarks = new BenchmarkStore(store, { now: () => now, monotonic: () => mono });
  t.after(async () => { if (store.db.open) store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, get store() { return store; }, get benchmarks() { return benchmarks; }, advance(ms: number) { now += ms; mono += ms; }, reopen() { store.close(); store = new Store(join(root, 'db.sqlite')); benchmarks = new BenchmarkStore(store); benchmarks.reconcile(); },
    bind(record = benchmarks.create(input()), index = 0) {
      const variant = record.variants[index];
      let task = store.createTask({ providerId: variant.providerId, model: variant.model }); task = store.updateTask(task.id, { effort: variant.effort, mode: variant.mode });
      const turn = store.acceptTurn(task.id, randomUUID(), record.prompt, []).turn;
      benchmarks.bindTurn(record.id, variant.id, task.id, turn.id, proof);
      return { record, task, turn };
    } };
}
test('manifest freezes same prompt and profiles; bind rejects a different prompt or turn reuse', async t => {
  const f = await fixture(t), original = input(), record = f.benchmarks.create(original);
  original.variants[0].model = 'changed'; original.prompt = 'changed';
  assert.equal(f.benchmarks.read(record.id).variants[0].model, 'fixture');
  const { task, turn } = f.bind(record);
  assert.throws(() => f.benchmarks.bindTurn(record.id, record.variants[1].id, task.id, turn.id, proof), /separate task|already belongs/);
  const wrong = f.store.acceptTurn(task.id, randomUUID(), 'Different prompt', []).turn;
  assert.throws(() => f.benchmarks.bindTurn(record.id, record.variants[1].id, task.id, wrong.id, proof), /does not match/);
  assert.equal(f.benchmarks.read(record.id).variants[1].turnId, null);
  assert.equal(record.promptSha256, createHash('sha256').update(record.prompt).digest('hex'));
});
test('method isolation is unavailable for native providers and requires actual host proof for local methods', async t => {
  const f = await fixture(t), native = input(); native.variants[0].providerId = 'codex'; native.variants[0].method.kind = 'browser';
  const record = f.benchmarks.create(native);
  assert.throws(() => f.benchmarks.assertRunnableVariant(record.id, record.variants[0].id), /unavailable/);
  const local = input(); local.variants[0].method = { kind: 'browser', allowedTools: ['browser_open'], mcpServerIds: [] };
  const comparison = f.benchmarks.create(local), task = f.store.createTask({ providerId: 'ollama', model: 'fixture' });
  const turn = f.store.acceptTurn(task.id, randomUUID(), comparison.prompt, []).turn;
  assert.throws(() => f.benchmarks.bindTurn(comparison.id, comparison.variants[0].id, task.id, turn.id, proof), /not enforceable/);
  assert.equal(f.benchmarks.assertRunnableVariant(comparison.id, comparison.variants[0].id).method.kind, 'browser');
});
test('timing starts at execution, ends after quiescence, and copies measured usage including zero cost', async t => {
  const f = await fixture(t), { record, turn } = f.bind();
  f.advance(5000); assert.throws(() => f.benchmarks.started(turn.id), /not started/);
  f.store.setTurnStatus(turn.id, 'running'); f.benchmarks.started(turn.id); f.advance(250); f.benchmarks.started(turn.id);
  const message = f.store.message(`${turn.id}:assistant`); f.store.saveMessage({ ...message, content: 'Actual result', usage: { inputTokens: 12, outputTokens: 3, costUsd: 0 }, status: 'completed' });
  f.store.setTurnStatus(turn.id, 'completed');
  assert.equal(f.benchmarks.syncTurn(turn.id)?.variants[0].durationMs, null);
  f.advance(50); const variant = f.benchmarks.syncTurn(turn.id, true)!.variants[0];
  assert.equal(variant.durationMs, 300); assert.equal(variant.startedAt, 6000); assert.equal(variant.finishedAt, 6300);
  assert.deepEqual(variant.usage, { inputTokens: 12, outputTokens: 3, totalTokens: null, costUsd: 0, estimated: false });
  f.advance(200); assert.equal(f.benchmarks.syncTurn(turn.id, true)!.variants[0].durationMs, 300);
  assert.equal(f.benchmarks.list().find(item => item.id === record.id)?.terminalCount, 1);
});
test('restart recovery preserves incomplete output but does not invent finish time, duration, or absent metrics', async t => {
  const f = await fixture(t), { record, turn } = f.bind();
  f.store.setTurnStatus(turn.id, 'running'); f.benchmarks.started(turn.id);
  const message = f.store.message(`${turn.id}:assistant`); f.store.saveMessage({ ...message, content: 'Partial answer', status: 'running' });
  f.reopen();
  const variant = f.benchmarks.read(record.id).variants[0];
  assert.equal(variant.status, 'interrupted'); assert.equal(variant.output, 'Partial answer');
  assert.equal(variant.finishedAt, null); assert.equal(variant.durationMs, null); assert.equal(variant.usage.costUsd, null);
});
test('human notes persist without computed score, rank, percentage, or winner fields', async t => {
  const f = await fixture(t), record = f.benchmarks.create(input());
  f.benchmarks.annotate(record.id, 'I prefer the clearer explanation.', record.variants[1].id); f.reopen();
  assert.equal(f.benchmarks.read(record.id).variants[1].humanNotes, 'I prefer the clearer explanation.');
  assert.equal('score' in f.benchmarks.read(record.id).variants[1], false);
});
test('evidence capture requires authorized actual files; export copies exact bytes and escapes output HTML', async t => {
  const f = await fixture(t), { record } = f.bind();
  const source = join(f.root, 'workspace'); await mkdir(source); await writeFile(join(source, 'result.txt'), 'Real fixture artifact');
  const evidence = new BenchmarkEvidenceFiles(join(f.root, 'managed'));
  await assert.rejects(evidence.capture({ path: join(source, 'result.txt'), kind: 'artifact', label: 'Proof', origin: 'user-selected' }, [join(f.root, 'managed-missing')]));
  const receipt = await evidence.capture({ path: join(source, 'result.txt'), kind: 'artifact', label: '<script>bad</script>', origin: 'user-selected' }, [source]);
  f.benchmarks.recordEvidence(record.id, record.variants[0].id, receipt);
  const snapshot = f.benchmarks.read(record.id); snapshot.variants[0].output = '</pre><script>bad</script>'; snapshot.title = '</title><script>bad</script>';
  const exported = await exportBenchmarkComparison(snapshot, f.root, evidence.directory);
  assert.equal(await readFile(join(exported.directory, 'evidence', receipt.filename), 'utf8'), 'Real fixture artifact');
  const html = await readFile(exported.indexPath, 'utf8');
  assert.ok(html.includes('&lt;script&gt;bad&lt;/script&gt;')); assert.equal((html.match(/<script>/g) ?? []).length, 1);
  assert.ok(html.includes('No recording supplied')); assert.ok(html.includes('Unavailable')); assert.ok(html.includes('Content-Security-Policy'));
  const portable = JSON.parse(await readFile(exported.manifestPath, 'utf8')); assert.equal(portable.variants[0].evidence[0].sha256, receipt.sha256);
  await writeFile(join(evidence.directory, receipt.filename), 'tampered');
  await assert.rejects(exportBenchmarkComparison(snapshot, f.root, evidence.directory), /changed since capture/);
});
test('symlink escape and forged evidence filenames cannot export arbitrary local files', async t => {
  const f = await fixture(t), { record } = f.bind(); const workspace = join(f.root, 'workspace'); await mkdir(workspace);
  await writeFile(join(f.root, 'outside'), 'outside'); await symlink(join(f.root, 'outside'), join(workspace, 'alias'));
  const evidence = new BenchmarkEvidenceFiles(join(f.root, 'managed'));
  await assert.rejects(evidence.capture({ path: join(workspace, 'alias'), kind: 'artifact', label: 'Escape', origin: 'engine-capture' }, [workspace]), /outside/);
  assert.throws(() => f.benchmarks.recordEvidence(record.id, record.variants[0].id, { id: randomUUID(), filename: '../outside', kind: 'artifact', label: 'bad', origin: 'user-selected', bytes: 7, sha256: 'a'.repeat(64), addedAt: 1, videoStartOffsetMs: null }), /receipt/);
});
test('preview returns only captured image bytes and honors variant receipt membership', async t => {
  const f = await fixture(t), { record } = f.bind(); const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
  await writeFile(join(f.root, 'pixel.png'), png);
  const evidence = new BenchmarkEvidenceFiles(join(f.root, 'managed'));
  const receipt = await evidence.capture({ path: join(f.root, 'pixel.png'), kind: 'image', label: 'Synthetic test pixel', origin: 'user-selected' }, [f.root]);
  const snapshot = f.benchmarks.recordEvidence(record.id, record.variants[0].id, receipt);
  const preview = await evidence.preview(snapshot, receipt.id); assert.ok('dataUrl' in preview); if ('dataUrl' in preview) assert.equal(preview.dataUrl, 'data:image/png;base64,' + png.toString('base64'));
  await assert.rejects(evidence.preview(snapshot, 'unknown'), /not found/);
});

test('comparison leads with real media and compact metrics, keeping prompt and provenance collapsed', async t => {
  const f = await fixture(t), record = f.benchmarks.create(input()), variant = record.variants[0];
  variant.durationMs = 135930.404666; variant.output = 'Observed Counter: 1';
  variant.evidence = [{ id: randomUUID(), filename: `${randomUUID()}.mp4`, kind: 'video', label: 'Sampled task browser recording', origin: 'engine-capture', bytes: 100, sha256: 'a'.repeat(64), addedAt: 100, videoStartOffsetMs: 19967.399625 }];
  const html = benchmarkComparisonHtml(record), article = html.slice(html.indexOf('<article>'), html.indexOf('</article>'));
  assert.ok(article.indexOf('<video') < article.indexOf('<dl class="metrics">'));
  assert.ok(article.indexOf('<dl class="metrics">') < article.indexOf('<h3>Recorded output'));
  assert.ok(article.indexOf('<h3>Human assessment') < article.indexOf('<summary>Evidence and execution details'));
  assert.ok(article.includes('135.93 s')); assert.ok(!article.includes('135.930405 s'));
  assert.ok(article.includes('data-offset="19967.399625"'), 'rounding display must not alter synchronization offset');
  assert.match(html, /<details><summary>Shared prompt<\/summary><pre>/);
  assert.match(html, /<details><summary>Comparison provenance and playback<\/summary>/);
  assert.ok(!html.includes('<details open')); assert.ok(html.includes('grid-template-columns:repeat(2,minmax(0,1fr))'));
});

test('export playback waits for metadata, idles without animation frames, restarts and switches alignment', async t => {
  const { runInNewContext } = await import('node:vm');
  const f = await fixture(t), html = benchmarkComparisonHtml(f.benchmarks.create(input()));
  const js = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  const element = (value = '') => ({ value, max: '', disabled: false, textContent: '', listeners: {} as Record<string, () => void>, addEventListener(name: string, fn: () => void) { this.listeners[name] = fn; } });
  const play = element(), seek = element('0'), status = element(), alignment = element('clip');
  const video = () => ({ ...element(), duration: NaN, currentTime: 0, error: null, paused: true, dataset: { offset: '20000' }, pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); } });
  const videos = [video(), video()], frames = new Map<number, () => void>(); let now = 0, nextFrame = 0;
  runInNewContext(js, { document: { querySelectorAll: () => videos, querySelector: (selector: string) => ({ '#play': play, '#seek': seek, '#playback-status': status, '#alignment': alignment })[selector] }, performance: { now: () => now }, requestAnimationFrame: (fn: () => void) => { frames.set(++nextFrame, fn); return nextFrame; }, cancelAnimationFrame: (id: number) => frames.delete(id) });
  assert.equal(play.disabled, true); assert.equal(frames.size, 0); assert.match(status.textContent, /Loading/);
  videos[0].duration = 10; videos[0].listeners.loadedmetadata(); assert.equal(play.disabled, true);
  videos[1].duration = 8; videos[1].listeners.loadedmetadata(); assert.equal(play.disabled, false); assert.equal(seek.max, '10');
  play.listeners.click(); assert.ok(videos.every(v => !v.paused)); assert.equal(frames.size, 1);
  play.listeners.click(); assert.ok(videos.every(v => v.paused)); assert.equal(frames.size, 0);
  seek.value = '10'; play.listeners.click(); assert.equal(seek.value, '0'); assert.equal(frames.size, 1);
  now = 11000; const queued = [...frames.values()][0]; frames.clear(); queued();
  assert.equal(frames.size, 0); assert.equal(play.textContent, 'Play recordings');
  play.listeners.click(); assert.equal(seek.value, '0'); assert.equal(frames.size, 1);
  alignment.value = 'run'; alignment.listeners.change(); assert.equal(frames.size, 0); assert.equal(seek.value, '0'); assert.equal(seek.max, '30'); assert.ok(videos.every(v => v.paused));
  play.listeners.click(); assert.ok(videos.every(v => v.paused), 'run alignment preserves real lead-in');
  seek.value = '22'; seek.listeners.input(); assert.ok(videos.every(v => v.currentTime === 2));
  alignment.value = 'clip'; alignment.listeners.change(); assert.equal(frames.size, 0); assert.equal(seek.max, '10'); assert.ok(videos.every(v => v.currentTime === 0));
});
