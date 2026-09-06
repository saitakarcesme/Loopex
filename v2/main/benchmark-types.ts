import type { ProviderId, PermissionMode, RunStatus } from '../shared/contracts';

export interface BenchmarkMethod {
  kind: 'default' | 'browser' | 'computer' | 'mcp' | 'custom';
  allowedTools: string[];
  mcpServerIds: string[];
  notes?: string;
}
export interface BenchmarkVariantInput {
  label: string;
  providerId: ProviderId;
  model: string;
  effort: string;
  mode: PermissionMode;
  method: BenchmarkMethod;
}
export interface BenchmarkCreate {
  title: string;
  prompt: string;
  projectId?: string | null;
  variants: BenchmarkVariantInput[];
}
export interface BenchmarkExecutionProof {
  toolScope: 'unverified' | 'host-enforced' | 'native-enforced';
  workspaceIsolation: 'unverified' | 'isolated-copy' | 'shared-read-only';
  fixtureSha256?: string;
  notes: string[];
}
export interface BenchmarkEvidence {
  id: string;
  kind: 'video' | 'image' | 'artifact';
  label: string;
  origin: 'engine-capture' | 'user-selected';
  filename: string;
  bytes: number;
  sha256: string;
  addedAt: number;
  /** Actual capture's offset from run start, if known; not inferred from file time. */
  videoStartOffsetMs: number | null;
  recordingNote?: string;
}
export interface BenchmarkVariant extends BenchmarkVariantInput {
  id: string;
  taskId: string | null;
  turnId: string | null;
  status: 'not-started' | RunStatus;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  timingSource: 'engine-monotonic' | 'unavailable';
  usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; costUsd: number | null; estimated: boolean | null };
  output: string;
  execution: BenchmarkExecutionProof;
  evidence: BenchmarkEvidence[];
  humanNotes: string;
}
export interface BenchmarkRecord {
  schemaVersion: 1;
  id: string;
  title: string;
  prompt: string;
  promptSha256: string;
  projectId: string | null;
  createdAt: number;
  updatedAt: number;
  humanNotes: string;
  variants: BenchmarkVariant[];
}
export interface BenchmarkSummary {
  id: string; title: string; createdAt: number; updatedAt: number;
  variantCount: number; terminalCount: number; runningCount: number;
}
