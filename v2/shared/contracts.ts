import type { ContextDeliveryReceipt } from './context-contracts';
import type { PluginVersionRef } from './plugin-contracts';

export type ProviderId = "codex" | "claude" | "opencode" | "ollama";
export type RunStatus =
  | "idle"
  | "queued"
  | "starting"
  | "running"
  | "waiting"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export type PermissionMode = "read" | "work" | "full";
export type ActivityKind =
  | "commentary"
  | "command"
  | "file"
  | "tool"
  | "plan"
  | "status"
  | "error";
export interface Project {
  hiddenFromSidebar?: boolean;
  pinned?: boolean;
  /** Internal lab workspaces remain addressable but are not ordinary user projects. */
  origin?: 'research' | 'benchmark';
  id: string;
  name: string;
  path: string;
  createdAt: number;
}
export interface Task {
  id: string;
  projectId: string | null;
  title: string;
  providerId: ProviderId;
  model: string;
  effort: string;
  mode: PermissionMode;
  status: RunStatus;
  pinOrder?: number;
  pinned: boolean;
  archived: boolean;
  draft: string;
  createdAt: number;
  updatedAt: number;
  nativeSessions: Partial<Record<ProviderId, string>>;
}
export interface Attachment {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  size: number;
}
export interface Activity {
  id: string;
  kind: ActivityKind;
  title: string;
  detail?: string;
  status: "running" | "completed" | "failed" | "interrupted" | "unknown";
  startedAt: number;
  endedAt?: number;
  filePath?: string;
  importProvenance?: { source: "akorith"; originalStatus?: string };
}
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  estimated?: boolean;
}
export interface Message {
  id: string;
  taskId: string;
  turnId: string;
  role: "user" | "assistant";
  content: string;
  activities: Activity[];
  attachments?: Attachment[];
  status: RunStatus;
  createdAt: number;
  usage?: Usage;
  /** The provider selected for this message's turn, independent of later task changes. */
  attribution?: {
    providerId?: ProviderId;
    originalProviderId?: string;
    model?: string;
  };
  importProvenance?: {
    source: "akorith";
    messageId: string;
    lifecycle?: string;
    outcomeRecorded: boolean;
    workspaceGoal?: { status: string; final?: boolean };
  };
}
export interface PendingRequest {
  id: string;
  taskId: string;
  turnId: string;
  kind: "approval" | "question";
  title: string;
  detail?: string;
  choices?: string[];
  questions?: Array<{
    id: string;
    question: string;
    options?: Array<{ label: string; description?: string }>;
  }>;
}
export interface ModelInfo {
  id: string;
  name: string;
  description?: string;
  efforts?: string[];
  contextWindow?: number;
}
export interface ProviderInfo {
  id: ProviderId;
  name: string;
  available: boolean;
  authenticated?: boolean;
  version?: string;
  error?: string;
  models: ModelInfo[];
  capabilities: {
    resume: boolean;
    steer: boolean;
    tools: boolean;
    approvals: boolean;
    images: boolean;
  };
  connectionLabel: string;
}
export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  path: string;
  source: string;
  enabled: boolean;
  projectId?: string;
  plugin?: PluginVersionRef;
}
export interface McpServer {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  status?: string;
  tools?: string[];
  error?: string;
  projectId?: string;
  plugin?: PluginVersionRef;
}
export interface Settings {
  theme: "system" | "dark" | "light";
  sidebarWidth: number;
  panelWidth: number;
  ollamaUrl: string;
  defaultProvider: ProviderId;
  skills: string[];
  mcpServers: McpServer[];
}
export interface AppSnapshot {
  projects: Project[];
  tasks: Task[];
  providers: ProviderInfo[];
  settings: Settings;
  version: string;
  fullscreen?: boolean;
  profile?: import('./profile-contracts').LocalProfile;
}
export interface TaskDetail {
  task: Task;
  messages: Message[];
  pending: PendingRequest[];
}
export type AppEvent =
  | { type: "window"; fullscreen: boolean }
  | { type: "changed"; taskId?: string }
  | { type: "task"; task: Task }
  | { type: "message"; message: Message }
  | { type: "pending"; request: PendingRequest }
  | { type: "notice"; text: string };
export interface RunRequest {
  task: Task;
  turnId: string;
  prompt: string;
  cwd: string;
  history: Message[];
  attachments: Attachment[];
  systemContext?: string;
  handoffContext?: string;
  mcpServers: McpServer[];
  ollamaUrl: string;
  contextManifestId?: string;
}
export type NativeRunOutcome =
  | { status: "completed" }
  | { status: "failed" | "interrupted"; error: unknown };
export type ProviderEvent =
  | { type: "context"; receipt: ContextDeliveryReceipt }
  | { type: "outcome"; outcome: NativeRunOutcome }
  | { type: "session"; id: string }
  | { type: "delta"; text: string }
  | { type: "activity"; activity: Activity }
  | { type: "pending"; request: Omit<PendingRequest, "taskId" | "turnId"> }
  | { type: "usage"; usage: Usage }
  | { type: "final"; text: string };
export interface RunHandle {
  done: Promise<void>;
  interrupt(): Promise<void>;
  /** Retry cleanup of this run only; resolution confirms process and host-call quiescence. */
  dispose?(): Promise<void>;
  steer?(text: string): Promise<void>;
  respond?(requestId: string, response: unknown): Promise<void>;
}
export interface ProviderAdapter {
  id: ProviderId;
  discover(): Promise<ProviderInfo>;
  run(request: RunRequest, emit: (event: ProviderEvent) => void): RunHandle;
  dispose(): Promise<void>;
}
export interface FileEntry {
  name: string;
  path: string;
  directory: boolean;
  size?: number;
}
export interface GitFile {
  path: string;
  status: string;
  additions?: number;
  deletions?: number;
}
export interface GitStatus {
  branch: string;
  isRepo: boolean;
  files: GitFile[];
}
export interface BrowserState {
  id: string;
  taskId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
}
export interface ComputerState {
  paused?: boolean;
  accessibility: boolean;
  screenRecording: boolean;
  apps: Array<{ name: string; bundleId: string; pid: number }>;
  error?: string;
}
export interface HostContext {
  taskId: string;
  turnId?: string;
  cwd: string;
  mode: PermissionMode;
}
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface HostTools {
  execute(
    name: string,
    args: Record<string, unknown>,
    context: HostContext,
    signal?: AbortSignal,
  ): Promise<unknown>;
  definitions: ToolDefinition[];
  /** Wait for owned model-tool calls and retry retained command cleanup, optionally for one task. */
  drain?(taskId?: string): Promise<void>;
  dispose(): Promise<void>;
}
export interface AkorithAPI {
  invoke<T = unknown>(command: string, payload?: unknown): Promise<T>;
  onEvent(callback: (event: AppEvent) => void): () => void;
  onHostEvent(
    callback: (event: { type: string; [key: string]: unknown }) => void,
  ): () => void;
}
