import { randomUUID, createHash } from 'node:crypto';
import type { Store } from './storage';
import type { Engine } from './engine';
import type { ResearchStudy, ResearchExperiment, ResearchDetail, ResearchEvaluator } from './research-types';
import { ResearchEvaluatorRunner } from './research-evaluator';
import { ResearchWorkspaces } from './research-workspaces';
const text = (value: unknown, label: string, max = 4000) => { if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0'))
    throw new Error(`Invalid ${label}.`); return value.trim(); };
const number = (value: unknown, min: number, max: number, label: string) => { if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw new Error(`Invalid ${label}.`); return value; };
export function validateResearchInput(input: Record<string, unknown>) {
    const goal = text(input.goal, 'goal'), hypothesis = text(input.hypothesis, 'hypothesis'), metric = text(input.metric, 'metric', 80);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(metric))
        throw new Error('Use a simple JSON property name for the metric.');
    if (!['minimize', 'maximize'].includes(String(input.direction)))
        throw new Error('Choose minimize or maximize.');
    if (!['codex', 'claude', 'opencode', 'ollama'].includes(String(input.providerId)))
        throw new Error('Choose an available research provider.');
    const raw = input.evaluator as Partial<ResearchEvaluator> | null;
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.args) || raw.args.length > 40 || raw.args.some(arg => typeof arg !== 'string' || arg.length > 4000 || arg.includes('\0')))
        throw new Error('Invalid evaluator arguments.');
    if (raw.protectedPaths !== undefined && (!Array.isArray(raw.protectedPaths) || raw.protectedPaths.length > 50 || raw.protectedPaths.some(path => typeof path !== 'string' || !path.length || path.length > 4000 || path.includes('\0'))))
        throw new Error('Invalid evaluator dependency files.');
    return { projectId: text(input.projectId, 'project'), goal, hypothesis, metric, direction: input.direction as ResearchStudy['direction'], providerId: input.providerId as ResearchStudy['providerId'], model: text(input.model, 'model', 200), evaluator: { command: text(raw.command, 'evaluator command', 1000), args: [...raw.args], timeoutMs: number(raw.timeoutMs, 30, 300000, 'evaluator timeout'), protectedPaths: [...(raw.protectedPaths ?? [])] }, maxExperiments: number(input.maxExperiments, 1, 20, 'experiment count'), budgetMinutes: number(input.budgetMinutes, 1, 120, 'research budget') };
}
export function improves(value: number, reference: number, direction: ResearchStudy['direction']) { return direction === 'minimize' ? value < reference : value > reference; }
interface Running {
    controller: AbortController;
    promise: Promise<void>;
    taskId?: string;
}
export class ResearchService {
    private runner = new ResearchEvaluatorRunner();
    private workspaces: ResearchWorkspaces;
    private running = new Map<string, Running>();
    private closing = false;
    constructor(private store: Store, private engine: Engine, userData: string, private changed: () => void) {
        this.workspaces = new ResearchWorkspaces(userData);
        store.db.exec(`CREATE TABLE IF NOT EXISTS research_studies(id TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE IF NOT EXISTS research_experiments(id TEXT PRIMARY KEY,study_id TEXT NOT NULL REFERENCES research_studies(id),data TEXT NOT NULL);`);
        for (const study of this.list())
            if (['running', 'stopping'].includes(study.status)) {
                study.elapsedMs = Math.min(study.budgetMinutes * 60000, study.elapsedMs + Math.max(0, Date.now() - (study.activeStartedAt ?? study.updatedAt)));
                delete study.activeStartedAt;
                study.status = 'paused';
                study.error = 'App restarted. Incomplete experiments require a new attempt.';
                this.saveStudy(study);
            }
        for (const row of store.db.prepare('SELECT data FROM research_experiments').all() as {
            data: string;
        }[]) {
            const exp = JSON.parse(row.data) as ResearchExperiment;
            if (['preparing', 'agent', 'evaluating'].includes(exp.status)) {
                exp.status = 'interrupted';
                exp.finishedAt = Date.now();
                exp.error = 'App restarted before this experiment completed.';
                this.saveExperiment(exp);
            }
        }
    }
    list(projectId?: string): ResearchStudy[] { return (this.store.db.prepare('SELECT data FROM research_studies').all() as {
        data: string;
    }[]).map(row => JSON.parse(row.data) as ResearchStudy).filter(study => !projectId || study.projectId === projectId).sort((a, b) => b.createdAt - a.createdAt); }
    read(id: string): ResearchDetail {
        const row = this.store.db.prepare('SELECT data FROM research_studies WHERE id=?').get(id) as {
            data: string;
        } | undefined;
        if (!row)
            throw new Error('Research study not found.');
        return { study: JSON.parse(row.data), experiments: (this.store.db.prepare('SELECT data FROM research_experiments WHERE study_id=?').all(id) as {
                data: string;
            }[]).map(row => JSON.parse(row.data) as ResearchExperiment).sort((a, b) => a.ordinal - b.ordinal) };
    }
    private saveStudy(study: ResearchStudy) { study.updatedAt = Date.now(); this.store.db.prepare('INSERT INTO research_studies VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(study.id, JSON.stringify(study)); this.changed(); }
    private saveExperiment(exp: ResearchExperiment) { this.store.db.prepare('INSERT INTO research_experiments VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(exp.id, exp.studyId, JSON.stringify(exp)); this.changed(); }
    async create(input: Record<string, unknown>): Promise<ResearchStudy> {
        if (this.closing)
            throw new Error('Research is shutting down.');
        const fields = validateResearchInput(input), project = this.store.project(fields.projectId);
        if (!project)
            throw new Error('Project not found.');
        const initialCommit = await this.workspaces.verifyProject(project.path);
        const evaluatorFileHashes = await this.workspaces.protectEvaluator(project.path, fields.evaluator);
        if (this.closing)
            throw new Error('Research is shutting down.');
        const protocolHash = createHash('sha256').update(JSON.stringify({ metric: fields.metric, direction: fields.direction, evaluator: fields.evaluator, evaluatorFileHashes, initialCommit })).digest('hex');
        const study: ResearchStudy = { ...fields, id: randomUUID(), initialCommit, evaluatorFileHashes, protocolHash, status: 'idle', elapsedMs: 0, createdAt: Date.now(), updatedAt: Date.now() };
        this.saveStudy(study);
        return study;
    }
    start(id: string): ResearchDetail {
        if (this.closing)
            throw new Error('Research is shutting down.');
        if (this.runner.hasOwnedProcesses || this.workspaces.hasOwnedProcesses)
            throw new Error('Research process cleanup is still unconfirmed. Reopen after cleanup before starting another study.');
        if (this.running.size)
            throw new Error('Wait for the active research run or stop it first; evaluator runs are serialized.');
        const detail = this.read(id);
        if (detail.experiments.length >= detail.study.maxExperiments || detail.study.elapsedMs >= detail.study.budgetMinutes * 60000)
            throw new Error('This study has exhausted its experiment or time budget. Create a new study to continue.');
        if (!this.store.project(detail.study.projectId))
            throw new Error('The research project no longer exists.');
        const running: Running = { controller: new AbortController(), promise: Promise.resolve() };
        this.running.set(id, running);
        detail.study.status = 'running';
        detail.study.activeStartedAt = Date.now();
        delete detail.study.error;
        this.saveStudy(detail.study);
        running.promise = Promise.resolve().then(() => this.loop(id, running)).finally(() => this.running.delete(id));
        void running.promise.catch(() => { });
        return this.read(id);
    }
    private async loop(id: string, run: Running) {
        const started = Date.now(), initialElapsed = this.read(id).study.elapsedMs;
        const remaining = this.read(id).study.budgetMinutes * 60000 - initialElapsed;
        const timer = setTimeout(() => { void this.stop(id).catch(() => { }); }, remaining);
        let current: ResearchExperiment | undefined;
        try {
            while (!run.controller.signal.aborted) {
                const detail = this.read(id), study = detail.study;
                if (detail.experiments.length >= study.maxExperiments)
                    break;
                const best = detail.experiments.filter(exp => exp.status === 'completed' && exp.decision === 'keep' && exp.measurement?.value !== null).reduce<ResearchExperiment | undefined>((best, exp) => !best || improves(exp.measurement!.value!, best.measurement!.value!, study.direction) ? exp : best, undefined);
                current = { id: randomUUID(), studyId: id, ordinal: detail.experiments.length + 1, kind: best ? 'candidate' : 'baseline', hypothesis: best ? study.hypothesis : 'Measure the unchanged baseline.', status: 'preparing', decision: 'pending', startedAt: Date.now(), baseExperimentId: best?.id };
                this.saveExperiment(current);
                const root = this.store.project(study.projectId)!.path;
                current.cwd = await this.workspaces.create(root, current.id, best?.cwd, run.controller.signal, best?.sourceCommit ?? study.initialCommit);
                const project = this.store.addProject(current.cwd, `Research ${current.ordinal} · ${study.goal.slice(0, 40)}`);
                current.projectId = project.id;
                if (best) {
                    const task = this.store.createTask({ projectId: project.id, title: `Experiment ${current.ordinal}: ${study.hypothesis.slice(0, 80)}`, providerId: study.providerId, model: study.model });
                    current.taskId = task.id;
                    run.taskId = task.id;
                    const prompt = `Run one bounded research experiment in this isolated worktree. Goal: ${study.goal}\nHypothesis: ${study.hypothesis}\nMetric: ${study.metric} (${study.direction}); current measured reference: ${best.measurement!.value}.\nEvaluator argv: ${JSON.stringify([study.evaluator.command, ...study.evaluator.args])}. The host will run this evaluator independently after your turn. Its final stdout line must contain numeric JSON property ${study.metric}. Do not modify the evaluator protocol or these protected files: ${JSON.stringify(Object.keys(study.evaluatorFileHashes))}. Do not fabricate metric evidence or perform a keep/discard decision. Make one meaningful candidate change and validate correctness using actual tools. Do not deploy, purchase resources, access credentials, or claim CUDA hardware exists without detection. Explain the change and any limitations. Remaining wall budget: ${Math.max(0, Math.round((remaining - (Date.now() - started)) / 1000))} seconds.`;
                    current.status = 'agent';
                    this.saveExperiment(current);
                    const accepted = await this.engine.send(task.id, `research:${current.id}`, prompt);
                    current.turnId = accepted.turnId;
                    this.saveExperiment(current);
                    while (true) {
                        if (run.controller.signal.aborted)
                            throw new Error('Research stopped.');
                        const turn = this.store.turn(accepted.turnId);
                        if (!['queued', 'starting', 'running', 'waiting', 'cancelling'].includes(turn.status) && !this.engine.diagnostics().active.some(active => active.taskId === task.id)) {
                            if (turn.status !== 'completed')
                                throw new Error(`Research agent turn ended ${turn.status}.`);
                            break;
                        }
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                    run.taskId = undefined;
                }
                run.controller.signal.throwIfAborted();
                current.status = 'evaluating';
                this.saveExperiment(current);
                await this.engine.withWorkspaceLock(current.cwd, async () => {
                    await this.workspaces.verifyEvaluator(current!.cwd!, study.evaluatorFileHashes);
                    await this.workspaces.checkpoint(current!.cwd!, run.controller.signal);
                    current!.sourceCommit = (await this.workspaces.git(current!.cwd!, ['rev-parse', 'HEAD'], run.controller.signal)).trim();
                    current!.measurement = await this.runner.measure(study, current!.cwd!, run.controller.signal);
                    await this.workspaces.verifyEvaluator(current!.cwd!, study.evaluatorFileHashes);
                    if ((await this.workspaces.git(current!.cwd!, ['status', '--porcelain', '--untracked-files=no'], run.controller.signal)).trim())
                        throw new Error('Evaluator modified tracked experiment files; metric is not accepted.');
                    if (current!.measurement.error)
                        throw new Error(current!.measurement.error);
                    const keep = !best || improves(current!.measurement.value!, best.measurement!.value!, study.direction);
                    current!.decision = keep ? 'keep' : 'discard';
                    current!.decisionReason = !best ? 'Measured baseline.' : keep ? 'Strict measured improvement against the current kept result.' : 'No strict measured improvement; isolated candidate remains available for inspection.';
                });
                current.status = 'completed';
                current.finishedAt = Date.now();
                this.saveExperiment(current);
                current = undefined;
                study.elapsedMs = initialElapsed + Date.now() - started;
                study.activeStartedAt = Date.now();
                this.saveStudy(study);
            }
            const study = this.read(id).study;
            study.status = run.controller.signal.aborted ? 'paused' : 'completed';
            study.elapsedMs = initialElapsed + Date.now() - started;
            delete study.activeStartedAt;
            this.saveStudy(study);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (current) {
                current.status = run.controller.signal.aborted ? 'cancelled' : 'failed';
                current.error = message;
                current.finishedAt = Date.now();
                this.saveExperiment(current);
            }
            const study = this.read(id).study;
            study.status = run.controller.signal.aborted ? 'paused' : 'failed';
            study.error = message;
            study.elapsedMs = initialElapsed + Date.now() - started;
            delete study.activeStartedAt;
            this.saveStudy(study);
        }
        finally {
            clearTimeout(timer);
        }
    }
    async stop(id: string): Promise<ResearchDetail> {
        const running = this.running.get(id);
        if (!running)
            return this.read(id);
        const study = this.read(id).study;
        study.status = 'stopping';
        this.saveStudy(study);
        running.controller.abort();
        if (running.taskId)
            await this.engine.stop(running.taskId);
        await running.promise;
        return this.read(id);
    }
    async decide(id: string, experimentId: string, decision: 'keep' | 'discard', reason: string): Promise<ResearchDetail> {
        if (this.running.has(id))
            throw new Error('Stop research before changing a recorded decision.');
        const detail = this.read(id), exp = detail.experiments.find(exp => exp.id === experimentId);
        if (!exp || exp.kind === 'baseline' || exp.status !== 'completed' || exp.measurement?.value == null || exp.measurement.error)
            throw new Error('Only successfully measured candidate experiments can be reviewed.');
        if (!['keep', 'discard'].includes(decision))
            throw new Error('Invalid research decision.');
        if (decision === 'keep') {
            const best = detail.experiments.filter(item => item.id !== exp.id && item.decision === 'keep' && item.measurement?.value != null);
            if (best.some(item => !improves(exp.measurement!.value!, item.measurement!.value!, detail.study.direction)))
                throw new Error('Keep requires a strict measured improvement over the other kept results.');
            await this.engine.withWorkspaceLock(exp.cwd!, async () => {
                if ((await this.workspaces.git(exp.cwd!, ['rev-parse', 'HEAD'])).trim() !== exp.sourceCommit || (await this.workspaces.git(exp.cwd!, ['status', '--porcelain', '--untracked-files=no'])).trim())
                    throw new Error('The candidate changed after measurement; run a new experiment before keeping it.');
            });
        }
        exp.decision = decision;
        exp.decisionReason = text(reason, 'decision reason');
        this.saveExperiment(exp);
        return this.read(id);
    }
    async dispose(): Promise<void> {
        this.closing = true;
        const stopped = await Promise.allSettled([...this.running.keys()].map(id => this.stop(id)));
        const cleaned = await Promise.allSettled([this.runner.dispose(), this.workspaces.dispose()]);
        const failed = [...stopped, ...cleaned].find(result => result.status === 'rejected');
        if (failed?.status === 'rejected')
            throw failed.reason;
    }
}
export async function researchCommand(name: string, p: Record<string, unknown>, service: ResearchService): Promise<unknown> {
    switch (name) {
        case 'research:list': return service.list(p.projectId === undefined ? undefined : text(p.projectId, 'project'));
        case 'research:create': return service.create(p);
        case 'research:read': return service.read(text(p.studyId, 'study'));
        case 'research:start': return service.start(text(p.studyId, 'study'));
        case 'research:stop': return service.stop(text(p.studyId, 'study'));
        case 'research:decide': return service.decide(text(p.studyId, 'study'), text(p.experimentId, 'experiment'), p.decision as 'keep' | 'discard', text(p.reason, 'decision reason'));
        default: throw new Error('Unknown research command.');
    }
}
