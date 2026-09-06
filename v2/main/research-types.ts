import type { Task } from '../shared/contracts';
export interface ResearchEvaluator {
    command: string;
    args: string[];
    timeoutMs: number;
    protectedPaths?: string[];
}
export interface ResearchStudy {
    id: string;
    projectId: string;
    goal: string;
    hypothesis: string;
    metric: string;
    direction: 'minimize' | 'maximize';
    evaluator: ResearchEvaluator;
    maxExperiments: number;
    budgetMinutes: number;
    providerId: Task['providerId'];
    model: string;
    protocolHash: string;
    evaluatorFileHashes: Record<string, string>;
    initialCommit: string;
    status: 'idle' | 'running' | 'stopping' | 'paused' | 'completed' | 'failed';
    elapsedMs: number;
    activeStartedAt?: number;
    createdAt: number;
    updatedAt: number;
    error?: string;
}
export interface ResearchMeasurement {
    source: 'host-evaluator';
    command: string;
    args: string[];
    cwd: string;
    startedAt: number;
    durationMs: number;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    stdoutSha256: string;
    value: number | null;
    timedOut: boolean;
    cancelled: boolean;
    error?: string;
    protocolHash: string;
}
export interface ResearchExperiment {
    id: string;
    studyId: string;
    ordinal: number;
    kind: 'baseline' | 'candidate';
    hypothesis: string;
    status: 'preparing' | 'agent' | 'evaluating' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
    taskId?: string;
    turnId?: string;
    sourceCommit?: string;
    projectId?: string;
    cwd?: string;
    baseExperimentId?: string;
    measurement?: ResearchMeasurement;
    decision: 'pending' | 'keep' | 'discard';
    decisionReason?: string;
    startedAt: number;
    finishedAt?: number;
    error?: string;
}
export interface ResearchDetail {
    study: ResearchStudy;
    experiments: ResearchExperiment[];
}
