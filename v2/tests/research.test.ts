import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Store } from '../main/storage';
import { Engine } from '../main/engine';
import type { ProviderAdapter } from '../shared/contracts';
import { ResearchService, validateResearchInput, improves } from '../main/research';
import { ResearchEvaluatorRunner } from '../main/research-evaluator';
import { ResearchWorkspaces } from '../main/research-workspaces';
import type { ResearchStudy } from '../main/research-types';
const input = { projectId: 'project', goal: 'Improve synthetic score', hypothesis: 'Change candidate implementation', metric: 'score', direction: 'minimize', providerId: 'codex', model: 'synthetic', evaluator: { command: 'node', args: ['bench.cjs'], timeoutMs: 1000 }, maxExperiments: 3, budgetMinutes: 1 };
async function until(check: () => boolean) { const deadline = Date.now() + 15000; while (!check()) {
    if (Date.now() > deadline)
        throw new Error('Research fixture timed out');
    await new Promise(r => setTimeout(r, 10));
} }
function study(script: string, timeoutMs = 1000): ResearchStudy { return { ...input, id: 'fixture-study', direction: 'minimize', providerId: 'codex', evaluator: { command: 'node', args: ['-e', script], timeoutMs }, protocolHash: 'fixture-protocol', evaluatorFileHashes: {}, initialCommit: 'fixture', status: 'idle', elapsedMs: 0, createdAt: 1, updatedAt: 1 }; }
test('host evaluator captures real metric output, byte hash, exit and duration without a Git repository', async () => {
    const runner = new ResearchEvaluatorRunner();
    try {
        const measured = await runner.measure(study('console.log(JSON.stringify({score:8,note:"Türkçe 🧪"}))'), tmpdir(), new AbortController().signal);
        assert.equal(measured.value, 8);
        assert.equal(measured.exitCode, 0);
        assert.equal(measured.source, 'host-evaluator');
        assert.ok(measured.durationMs >= 0);
        assert.equal(measured.stdoutSha256, createHash('sha256').update(measured.stdout).digest('hex'));
        assert.equal(measured.protocolHash, 'fixture-protocol');
        const failed = await runner.measure(study('console.log("{\\"score\\":1}");process.exit(3)'), tmpdir(), new AbortController().signal);
        assert.equal(failed.value, null);
        assert.equal(failed.exitCode, 3);
        assert.match(failed.error!, /exited/);
        const malformed = await runner.measure(study('console.log("no metric")'), tmpdir(), new AbortController().signal);
        assert.equal(malformed.value, null);
        assert.match(malformed.error!, /final stdout line/);
    }
    finally {
        await runner.dispose();
    }
});
test('preabort, timeout and cancellation terminate only owned evaluator work', async () => {
    const runner = new ResearchEvaluatorRunner();
    try {
        const aborted = new AbortController();
        aborted.abort();
        await assert.rejects(runner.measure(study('process.exit(0)'), tmpdir(), aborted.signal), { name: 'AbortError' });
        const timed = await runner.measure(study('setInterval(()=>{},1000)', 50), tmpdir(), new AbortController().signal);
        assert.equal(timed.timedOut, true);
        assert.equal(timed.value, null);
        const stop = new AbortController(), pending = runner.measure(study('setInterval(()=>{},1000)'), tmpdir(), stop.signal);
        setTimeout(() => stop.abort(), 50);
        const cancelled = await pending;
        assert.equal(cancelled.cancelled, true);
        assert.equal(cancelled.value, null);
    }
    finally {
        await runner.dispose();
    }
});
test('invalid unbounded evaluator options reject before research starts and comparison requires strict improvement', () => {
    for (const patch of [{ maxExperiments: 0 }, { budgetMinutes: 121 }, { direction: 'sideways' }, { metric: 'a.b' }, { evaluator: { command: 'node', args: [], timeoutMs: 0 } }])
        assert.throws(() => validateResearchInput({ ...input, ...patch }));
    assert.equal(improves(1, 1, 'minimize'), false);
    assert.equal(improves(1, 2, 'minimize'), true);
    assert.equal(improves(3, 2, 'maximize'), true);
});
async function fixture(t: any, mutate: (cwd: string, index: number) => Promise<void>, hang = false) {
    const root = await mkdtemp(join(tmpdir(), 'akorith-research-')), projectPath = join(root, 'project');
    await mkdir(projectPath);
    await writeFile(join(projectPath, 'bench.cjs'), "console.log(JSON.stringify({score:Number(require('node:fs').readFileSync('candidate.txt','utf8'))}))");
    await writeFile(join(projectPath, 'candidate.txt'), '10');
    const workspace = new ResearchWorkspaces(root);
    await workspace.git(projectPath, ['init']);
    await workspace.git(projectPath, ['add', '--', 'bench.cjs', 'candidate.txt']);
    await workspace.git(projectPath, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Synthetic baseline']);
    const store = new Store(join(root, 'workspace.sqlite')), project = store.addProject(projectPath, 'Synthetic research');
    let calls = 0;
    const provider: ProviderAdapter = { id: 'codex', discover: async () => { throw new Error('unused'); }, dispose: async () => { }, run(request, emit) { calls++; let reject!: (error: Error) => void; const done = hang ? new Promise<void>((_, no) => { reject = no; }) : mutate(request.cwd, calls).then(() => { emit({ type: 'final', text: 'Synthetic candidate edited.' }); }); return { done, interrupt: async () => { if (hang) {
                const error = new Error('Synthetic agent stopped');
                error.name = 'AbortError';
                reject(error);
                await done.catch(() => { });
            }
            else
                await done; } }; } };
    const engine = new Engine(store, [provider], task => store.project(task.projectId!)!.path, async () => '', () => { });
    const service = new ResearchService(store, engine, root, () => { });
    t.after(async () => { await service.dispose(); await engine.shutdown(); await workspace.dispose(); store.close(); });
    return { root, projectPath, project, store, service, workspace, get calls() { return calls; } };
}
test('baseline and Engine candidate turns use separate worktrees; host keeps strict improvement and discards regression within budget', async (t) => {
    const f = await fixture(t, (cwd, index) => writeFile(join(cwd, 'candidate.txt'), index === 1 ? '8' : '12'));
    const s = await f.service.create({ ...input, projectId: f.project.id });
    assert.equal(f.service.start(s.id).study.status, 'running');
    await until(() => ['completed', 'failed'].includes(f.service.read(s.id).study.status));
    const result = f.service.read(s.id);
    assert.equal(result.study.status, 'completed', result.study.error ?? 'Research should complete');
    assert.equal(f.calls, 2);
    assert.deepEqual(result.experiments.map(e => e.measurement?.value), [10, 8, 12]);
    assert.deepEqual(result.experiments.map(e => e.decision), ['keep', 'keep', 'discard']);
    assert.equal(new Set(result.experiments.map(e => e.cwd)).size, 3);
    assert.ok(result.experiments[1].turnId);
    assert.equal(result.experiments[1].measurement?.protocolHash, s.protocolHash);
    assert.equal(await readFile(join(f.projectPath, 'candidate.txt'), 'utf8'), '10');
    await assert.rejects(f.service.decide(s.id, result.experiments[2].id, 'keep', 'Prefer regression'), /strict measured improvement/);
    assert.throws(() => f.service.start(s.id), /exhausted/);
});
test('agent changes to protected evaluator fail rather than publishing fabricated metric', async (t) => {
    const f = await fixture(t, cwd => writeFile(join(cwd, 'bench.cjs'), 'console.log("{\\"score\\":-999}")'));
    const s = await f.service.create({ ...input, projectId: f.project.id, maxExperiments: 2 });
    f.service.start(s.id);
    await until(() => f.service.read(s.id).study.status === 'failed');
    const result = f.service.read(s.id);
    assert.match(result.study.error!, /Evaluator protocol changed/);
    assert.equal(result.experiments[1].measurement, undefined);
    assert.equal(result.experiments[1].decision, 'pending');
});
test('stop during evaluator settles its process and prevents the next iteration; journal survives reopening', async (t) => {
    const f = await fixture(t, async () => { });
    await writeFile(join(f.projectPath, 'bench.cjs'), "setInterval(()=>{},1000)");
    await f.workspace.git(f.projectPath, ['add', '--', 'bench.cjs']);
    await f.workspace.git(f.projectPath, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Slow evaluator fixture']);
    const s = await f.service.create({ ...input, projectId: f.project.id, evaluator: { command: 'node', args: ['bench.cjs'], timeoutMs: 5000 } });
    f.service.start(s.id);
    await until(() => f.service.read(s.id).experiments[0]?.status === 'evaluating');
    await f.service.stop(s.id);
    const result = f.service.read(s.id);
    assert.equal(result.study.status, 'paused');
    assert.equal(result.experiments.length, 1);
    assert.equal(result.experiments[0].status, 'cancelled');
    assert.equal(f.calls, 0);
    const independent = new Store(join(f.root, 'workspace.sqlite'));
    try {
        const saved = independent.db.prepare('SELECT data FROM research_studies WHERE id=?').get(s.id) as {
            data: string;
        };
        assert.equal(JSON.parse(saved.data).status, 'paused');
    }
    finally {
        independent.close();
    }
});
test('dirty projects are rejected before creating a study or worktree', async (t) => {
    const f = await fixture(t, async () => { });
    await writeFile(join(f.projectPath, 'candidate.txt'), 'uncommitted');
    await assert.rejects(f.service.create({ ...input, projectId: f.project.id }), /clean Git project/);
    assert.equal(f.service.list().length, 0);
});
test('relative evaluator executable resolves inside the experiment cwd, not the app cwd', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'akorith-evaluator-path-')), file = join(cwd, 'measure');
    await writeFile(file, '#!/usr/bin/env node\nconsole.log(JSON.stringify({score:4}))\n');
    await chmod(file, 0o755);
    const runner = new ResearchEvaluatorRunner();
    try {
        const config = { ...study(''), evaluator: { command: './measure', args: [], timeoutMs: 1000 } };
        assert.equal((await runner.measure(config, cwd, new AbortController().signal)).value, 4);
    }
    finally {
        await runner.dispose();
    }
});
test('saved experiment commit wins even when a kept worktree HEAD changes later', async (t) => {
    const f = await fixture(t, async () => { }), saved = (await f.workspace.git(f.projectPath, ['rev-parse', 'HEAD'])).trim();
    await writeFile(join(f.projectPath, 'candidate.txt'), '99');
    await f.workspace.git(f.projectPath, ['add', '--', 'candidate.txt']);
    await f.workspace.git(f.projectPath, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Changed after measurement']);
    const isolated = await f.workspace.create(f.projectPath, randomUUID(), f.projectPath, new AbortController().signal, saved);
    assert.equal(await readFile(join(isolated, 'candidate.txt'), 'utf8'), '10');
});
test('declared evaluator dependency files are hash protected alongside the entry script', async (t) => {
    const f = await fixture(t, cwd => writeFile(join(cwd, 'benchmark-helper.cjs'), 'changed'));
    await writeFile(join(f.projectPath, 'benchmark-helper.cjs'), 'fixed protocol');
    await f.workspace.git(f.projectPath, ['add', '--', 'benchmark-helper.cjs']);
    await f.workspace.git(f.projectPath, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Evaluator helper']);
    const s = await f.service.create({ ...input, projectId: f.project.id, maxExperiments: 2, evaluator: { ...input.evaluator, protectedPaths: ['benchmark-helper.cjs'] } });
    assert.deepEqual(Object.keys(s.evaluatorFileHashes).sort(), ['bench.cjs', 'benchmark-helper.cjs']);
    f.service.start(s.id);
    await until(() => f.service.read(s.id).study.status === 'failed');
    assert.match(f.service.read(s.id).study.error!, /Evaluator protocol changed: benchmark-helper/);
});
test('stop during a real Engine-managed agent turn waits for interruption and starts no next candidate', async (t) => {
    const f = await fixture(t, async () => { }, true), s = await f.service.create({ ...input, projectId: f.project.id });
    f.service.start(s.id);
    await until(() => f.calls === 1);
    await f.service.stop(s.id);
    const detail = f.service.read(s.id);
    assert.equal(detail.study.status, 'paused');
    assert.equal(detail.experiments.length, 2);
    assert.equal(detail.experiments[1].status, 'cancelled');
    assert.equal(detail.experiments[1].measurement, undefined);
    assert.equal(f.store.turn(detail.experiments[1].turnId!).status, 'cancelled');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(f.calls, 1);
});
