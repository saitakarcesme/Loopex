import { randomUUID } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import type {
  AppEvent,
  ProviderAdapter,
  ProviderEvent,
  RunHandle,
  Message,
  PendingRequest,
  Attachment,
  Task,
  RunStatus,
  Activity,
  NativeRunOutcome,
} from "../shared/contracts";
import { Store, type StoredTurn } from "./storage";
import type { PreparedTurnContext } from '../shared/context-contracts';

interface ActiveRun {
  turn: StoredTurn;
  message: Message;
  handle?: RunHandle;
  pending: Map<string, PendingRequest>;
  stopping: boolean;
  timer?: ReturnType<typeof setTimeout>;
  lease?: string;
  completion?: Promise<void>;
  cancelled: Promise<void>;
  cancel: () => void;
  interrupting?: Promise<void>;
  cleanupPending?: boolean;
  nativeOutcome?: NativeRunOutcome;
  quiescent: boolean;
  context?: PreparedTurnContext;
  contextController: AbortController;
}
function nativeOutcome(error: Error): NativeRunOutcome | undefined {
  const value = (error as Error & { nativeOutcome?: NativeRunOutcome }).nativeOutcome;
  if (value && ["completed", "failed", "interrupted"].includes(value.status)) return value;
}
export function workspacesOverlap(first: string, second: string): boolean {
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith("../"));
  };
  return contains(first, second) || contains(second, first);
}
export interface RunLifecycleHooks {
  beforeRun?: (task: Task, turnId: string, cwd: string) => Promise<Activity[] | void>;
  afterRun?: (task: Task, turnId: string, cwd: string) => Promise<Activity[] | void>;
}
export class Engine {
  private readonly active = new Map<string, ActiveRun>();
  private readonly leases = new Map<string, string>();
  private readonly manualOperations = new Map<string, Promise<unknown>>();
  private closing = false;
  private storageFault = false;
  constructor(
    private readonly store: Store,
    private readonly providers: ProviderAdapter[],
    private readonly cwd: (task: Task) => string,
    private readonly context: (task: Task, turnId?: string, signal?: AbortSignal) => Promise<string | PreparedTurnContext>,
    private readonly emit: (event: AppEvent) => void,
    private readonly lifecycle: RunLifecycleHooks = {},
  ) {}
  pending(taskId: string) {
    return [...(this.active.get(taskId)?.pending.values() ?? [])];
  }
  contextRoots(taskId: string, turnId?: string): string[] {
    const run = this.active.get(taskId);
    return turnId && run?.turn.id === turnId && !run.quiescent
      ? [...(run.context?.readRoots ?? [])] : [];
  }
  diagnostics() {
    return {
      closing: this.closing,
      storageFault: this.storageFault,
      active: [...this.active.values()].map((run) => ({
        taskId: run.turn.taskId,
        turnId: run.turn.id,
        providerId: run.turn.providerId,
        stopping: run.stopping,
        cleanupPending: !!run.cleanupPending,
        pendingRequests: run.pending.size,
        ownsWriterLease: !!run.lease,
      })),
      writerLeases: this.leases.size,
      manualOperations: this.manualOperations.size,
    };
  }
  workspaceBusy(cwd: string): boolean {
    return [...this.leases.keys()].some((leased) => workspacesOverlap(leased, cwd));
  }
  async withWorkspaceLock<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
    if (this.storageFault) throw new Error("Task storage failed. Reopen Akorith before changing workspace files.");
    if (this.closing) throw new Error("The app is closing. Reopen it before changing workspace files.");
    if (this.workspaceBusy(cwd)) throw new Error("This workspace is busy. Stop its active task or wait for the current file operation to finish.");
    const token = `manual:${randomUUID()}`;
    this.leases.set(cwd, token);
    const pending = Promise.resolve().then(operation);
    this.manualOperations.set(token, pending);
    try { return await pending }
    finally {
      this.manualOperations.delete(token);
      if (this.leases.get(cwd) === token) this.leases.delete(cwd);
      queueMicrotask(() => this.pump());
    }
  }
  async send(
    taskId: string,
    requestId: string,
    prompt: string,
    attachments: Attachment[] = [],
  ) {
    if (this.storageFault) throw new Error("Task storage failed. Your draft is retained; reopen Akorith before starting more work.");
    if (this.closing)
      throw new Error(
        "The app is closing. Your draft is safe; reopen to continue.",
      );
    if (!prompt.trim() && !attachments.length)
      throw new Error("Write a message or attach a file.");
    if (prompt.length > 200_000)
      throw new Error("Message is too large. Attach a file instead.");
    const accepted = this.store.acceptTurn(
      taskId,
      requestId,
      prompt.trim(),
      attachments,
    );
    if (!accepted.duplicate) {
      this.emit({ type: "changed", taskId });
      if (!this.active.has(taskId)) this.status(taskId, "queued");
      queueMicrotask(() => this.pump());
    }
    return { turnId: accepted.turn.id };
  }
  private status(taskId: string, status: RunStatus) {
    this.emit({
      type: "task",
      task: this.store.updateTask(taskId, { status }),
    });
  }
  private safelyRecord(action: () => void) {
    try { action(); }
    catch (error) {
      this.storageFault = true;
      this.notice(`Task storage failed; new work is paused until Akorith is reopened. ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  private notice(text: string) {
    try { this.emit({ type: "notice", text }); } catch { /* UI delivery cannot bypass resource ownership. */ }
  }
  private pump() {
    if (this.closing || this.storageFault) return;
    for (const task of this.store.tasks()) {
      if (this.active.has(task.id)) continue;
      const turn = this.store.queued(task.id)[0];
      if (!turn) continue;
      if (
        turn.providerId === "ollama" &&
        [...this.active.values()].some(
          (run) => run.turn.providerId === "ollama",
        )
      )
        continue;
      let cwd: string;
      try {
        cwd = this.cwd(task);
      } catch (error) {
        this.failQueued(turn, error);
        continue;
      }
      const writes = turn.mode !== "read";
      if (writes && this.workspaceBusy(cwd)) continue;
      let cancel!: () => void;
      const cancelled = new Promise<void>((resolve) => {
        cancel = resolve;
      });
      const run: ActiveRun = {
        turn,
        message: this.store.message(`${turn.id}:assistant`),
        pending: new Map(),
        stopping: false,
        quiescent: false,
        contextController: new AbortController(),
        lease: writes ? cwd : undefined,
        cancelled,
        cancel: () => { run.quiescent = true; cancel(); },
      };
      this.active.set(task.id, run);
      if (writes) this.leases.set(cwd, task.id);
      run.completion = this.execute(
        {
          ...task,
          providerId: turn.providerId,
          model: turn.model,
          effort: turn.effort,
          mode: turn.mode,
        },
        run,
        cwd,
      );
    }
  }
  private flush(run: ActiveRun) {
    if (run.timer) clearTimeout(run.timer);
    run.timer = undefined;
    this.store.saveMessage(run.message);
    this.emit({ type: "message", message: structuredClone(run.message) });
  }
  private later(run: ActiveRun) {
    if (!run.timer)
      run.timer = setTimeout(() => {
        try {
          this.flush(run);
        } catch (error) {
          void this.stop(run.turn.taskId).catch((failure) => this.notice(String(failure)));
          this.emit({
            type: "notice",
            text: `Could not save the response: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }, 50);
  }
  private onProvider(run: ActiveRun, event: ProviderEvent) {
    if (this.active.get(run.turn.taskId) !== run) return;
    const { taskId, id: turnId } = run.turn;
    if (event.type === 'context') {
      if (run.context) this.store.saveContextDelivery(taskId, turnId, event.receipt);
      this.emit({ type: 'changed', taskId });
      return;
    }
    if (event.type === "outcome") {
      run.nativeOutcome = event.outcome;
      return;
    }
    if (event.type === "session") {
      this.store.setTurnSession(turnId, event.id);
      const task = this.store.task(taskId);
      this.emit({
        type: "task",
        task: this.store.updateTask(taskId, {
          nativeSessions: {
            ...task.nativeSessions,
            [run.turn.providerId]: event.id,
          },
        }),
      });
      return;
    }
    if (event.type === "delta") {
      run.message.content += event.text;
      this.later(run);
      return;
    }
    if (event.type === "final") {
      run.message.content = event.text;
      this.flush(run);
      return;
    }
    if (event.type === "usage") {
      run.message.usage = { ...run.message.usage, ...event.usage };
      this.later(run);
      return;
    }
    if (event.type === "activity") {
      const i = run.message.activities.findIndex(
        (a) => a.id === event.activity.id,
      );
      if (i < 0) run.message.activities.push(event.activity);
      else
        run.message.activities[i] = {
          ...run.message.activities[i],
          ...event.activity,
        };
      this.store.event(taskId, turnId, "activity", event.activity);
      this.later(run);
      return;
    }
    if (event.type === "pending") {
      const request: PendingRequest = { ...event.request, taskId, turnId };
      run.pending.set(request.id, request);
      run.message.status = "waiting";
      this.store.setTurnStatus(turnId, "waiting");
      this.status(taskId, "waiting");
      this.flush(run);
      this.emit({ type: "pending", request });
      this.store.event(taskId, turnId, "pending", request);
    }
  }
  private async execute(task: Task, run: ActiveRun, cwd: string) {
    let terminal: RunStatus = "completed";
    let checkpointStarted = false;
    const tracking = async (hook: NonNullable<RunLifecycleHooks["beforeRun"]>) => {
      try {
        const activities = await hook(task, run.turn.id, cwd);
        for (const activity of activities ?? []) {
          const index = run.message.activities.findIndex((existing) => existing.id === activity.id);
          if (index < 0) run.message.activities.push(activity);
          else run.message.activities[index] = { ...run.message.activities[index], ...activity };
        }
        return true;
      } catch (error) {
        run.message.activities.push({ id: randomUUID(), kind: "error", title: "Change tracking unavailable", detail: error instanceof Error ? error.message : String(error), status: "failed", startedAt: Date.now(), endedAt: Date.now() });
        return false;
      }
    };
    try {
      const userMessage = {
        ...this.store.message(`${run.turn.id}:user`),
        status: "completed" as const,
      };
      this.store.saveMessage(userMessage);
      this.emit({ type: "message", message: userMessage });
      run.message.status = "starting";
      this.store.setTurnStatus(run.turn.id, "starting");
      this.status(task.id, "starting");
      this.flush(run);
      if (task.mode !== "read" && this.lifecycle.beforeRun)
        checkpointStarted = await tracking(this.lifecycle.beforeRun);
      if (run.stopping) throw new Error("Cancelled before start.");
      const adapter = this.providers.find((p) => p.id === task.providerId);
      if (!adapter) throw new Error("Provider unavailable.");
      const preparing = this.context(task, run.turn.id, run.contextController.signal).then(async value => {
        if (typeof value !== 'string') {
          if (run.stopping || this.active.get(task.id) !== run) await value.release();
          else run.context = value;
        }
        return value;
      });
      void preparing.catch(() => {});
      const prepared = await Promise.race([
        preparing,
        run.cancelled.then(() => {
          throw new Error("Cancelled before start.");
        }),
      ]);
      if (run.stopping) throw new Error("Cancelled before start.");
      const settings = this.store.settings();
      const history = this.store.historyBefore(run.turn);
      let freshSession = false;
      if (typeof prepared !== 'string') {
        const nativeId = task.nativeSessions[task.providerId];
        freshSession = !!nativeId && this.store.nativeContext(task.id, task.providerId, nativeId)?.fingerprint !== prepared.manifest.fingerprint;
        prepared.manifest.session = freshSession ? 'renewed-for-context' : nativeId ? 'resumed' : 'new';
        this.store.saveContext(prepared.manifest);
        if (freshSession) {
          task = { ...task, nativeSessions: { ...task.nativeSessions, [task.providerId]: undefined } };
          run.message.activities.push({ id: `context:${run.turn.id}`, kind: 'status', title: 'Context changed; using a fresh provider session', detail: 'The conversation is preserved in the handoff. Earlier instructions may still appear in conversation history.', status: 'completed', startedAt: Date.now() });
        }
      }
      const handoffContext = this.store.continuity(run.turn, history, freshSession);
      run.handle = adapter.run(
        {
          task,
          turnId: run.turn.id,
          prompt: run.turn.prompt,
          cwd,
          history,
          attachments: run.turn.attachments,
          systemContext: typeof prepared === 'string' ? prepared : prepared.systemContext,
          handoffContext,
          mcpServers: typeof prepared === 'string' ? settings.mcpServers : prepared.mcpServers,
          ollamaUrl: typeof prepared === 'string' ? settings.ollamaUrl : prepared.ollamaUrl,
          contextManifestId: typeof prepared === 'string' ? undefined : prepared.manifest.id,
        },
        (event) => {
          try { this.onProvider(run, event); }
          catch (error) {
            this.storageFault = true;
            this.notice(`Could not record provider output; new work is paused. ${error instanceof Error ? error.message : String(error)}`);
            void this.stop(run.turn.taskId).catch((failure) => this.notice(String(failure)));
          }
        },
      );
      run.quiescent = false;
      // A non-cleanup rejection still certifies that the adapter finished its cleanup.
      // Observe immediately, including failures while recording the running state below.
      const done = run.handle.done.then(() => { run.quiescent = true; }, (error) => {
        if (!(error instanceof Error && error.name === "ProviderQuiescenceError")) run.quiescent = true;
        throw error;
      });
      void done.catch(() => {});
      run.message.status = run.pending.size ? "waiting" : "running";
      this.store.setTurnStatus(run.turn.id, run.message.status);
      this.status(task.id, run.message.status);
      this.flush(run);
      if (run.stopping) await run.handle.interrupt();
      await Promise.race([done, run.cancelled]);
      if (
        (!run.stopping || run.nativeOutcome?.status === "completed") &&
        !run.message.content.trim() &&
        !run.message.activities.some(
          (a) => !["status", "commentary"].includes(a.kind),
        )
      )
        throw new Error(
          "Provider finished without a response. Check its connection and retry.",
        );
      if (run.nativeOutcome?.status === "completed") terminal = "completed";
      else if (run.stopping) terminal = this.closing ? "interrupted" : "cancelled";
    } catch (error) {
      let failure = error;
      if (error instanceof Error && error.name === "ProviderQuiescenceError") {
        const outcome = nativeOutcome(error) ?? run.nativeOutcome;
        run.cleanupPending = true;
        run.message.status = "cancelling";
        run.pending.clear();
        const cleanup: Activity = {
          id: `cleanup:${run.turn.id}`,
          kind: "status",
          title: outcome?.status === "completed" ? "Response complete; connection cleanup needs attention" : "Connection cleanup needs attention",
          detail: "This workspace remains locked until the connection and its tool calls have stopped. Retry Stop to finish cleanup.",
          status: "running",
          startedAt: Date.now(),
        };
        run.message.activities.push(cleanup);
        this.safelyRecord(() => {
          this.store.setTurnStatus(run.turn.id, "cancelling");
          this.store.event(task.id, run.turn.id, "cleanup-pending", {
            nativeStatus: outcome?.status ?? "unknown",
            error: error.message,
          });
          this.flush(run);
          this.status(task.id, "cancelling");
        });
        this.notice(`${error.message}. This workspace remains locked. Retry Stop to close the provider connection.`);
        // Only a successful provider disposal may release an unconfirmed writer.
        await run.cancelled;
        run.cleanupPending = false;
        cleanup.status = "completed";
        cleanup.title = "Connection cleanup complete";
        cleanup.endedAt = Date.now();
        terminal = outcome?.status === "completed"
          ? "completed"
          : outcome?.status === "failed"
            ? "failed"
            : run.stopping
              ? this.closing ? "interrupted" : "cancelled"
              : outcome?.status === "interrupted" ? "interrupted" : "failed";
        if (outcome && outcome.status !== "completed") failure = outcome.error;
      } else {
        if (run.nativeOutcome?.status === "failed") {
          terminal = "failed";
          failure = run.nativeOutcome.error;
        } else {
          terminal = run.nativeOutcome?.status === "completed" ? "failed"
            : run.stopping ? this.closing ? "interrupted" : "cancelled"
              : run.nativeOutcome?.status === "interrupted" ? "interrupted" : "failed";
        }
      }
      if (terminal === "failed") {
        const text = failure instanceof Error ? failure.message : String(failure);
        run.message.activities.push({
          id: randomUUID(),
          kind: "error",
          title: "The task could not finish",
          detail: text,
          status: "failed",
          startedAt: Date.now(),
          endedAt: Date.now(),
        });
      }
    } finally {
      run.contextController.abort();
      if (run.handle && !run.quiescent) {
        // An engine/storage/UI failure can happen before awaiting handle.done.
        // It must never skip the adapter's ownership barrier.
        try { await this.quiesce(run); run.cancel(); }
        catch (error) {
          run.cleanupPending = true;
          this.notice(`Connection cleanup is unconfirmed; this workspace remains locked. Retry Stop. ${error instanceof Error ? error.message : String(error)}`);
          await run.cancelled;
          run.cleanupPending = false;
        }
      }
      if (checkpointStarted && this.lifecycle.afterRun) await tracking(this.lifecycle.afterRun);
      if (run.context) {
        try { await run.context.release(); }
        catch (error) { this.notice(`Context files were retained because their release could not be confirmed: ${String(error)}`); }
      }
      run.message.status = terminal;
      run.pending.clear();
      for (const activity of run.message.activities)
        if (activity.status === "running") {
          // A parent turn outcome does not prove an individual tool succeeded.
          // Quiescence stops the spinner; only a tool's own event supplies its result.
          activity.status = terminal === "cancelled" || terminal === "interrupted"
            ? "interrupted" : "unknown";
        }
      try {
        this.store.setTurnStatus(run.turn.id, terminal);
        this.flush(run);
        this.store.event(task.id, run.turn.id, "ended", { status: terminal });
        this.status(task.id, terminal);
      } catch (error) {
        this.storageFault = true;
        this.notice(`The task stopped, but its final state could not be saved: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        if (run.timer) clearTimeout(run.timer);
        this.active.delete(task.id);
        if (run.lease && this.leases.get(run.lease) === task.id) this.leases.delete(run.lease);
        this.emit({ type: "changed", taskId: task.id });
        queueMicrotask(() => this.pump());
      }
    }
  }
  private failQueued(turn: StoredTurn, error: unknown) {
    const m = this.store.message(`${turn.id}:assistant`);
    m.status = "failed";
    m.activities.push({
      id: randomUUID(),
      kind: "error",
      title: "Workspace unavailable",
      detail: error instanceof Error ? error.message : String(error),
      status: "failed",
      startedAt: Date.now(),
    });
    this.store.setTurnStatus(turn.id, "failed");
    this.store.saveMessage(m);
    this.status(turn.taskId, "failed");
    this.emit({ type: "changed", taskId: turn.taskId });
  }
  async stop(taskId: string) {
    const run = this.active.get(taskId);
    if (run?.interrupting) return run.interrupting;
    // Stop also removes queued work; no hidden restart after a cancellation.
    let queued: StoredTurn[] = [];
    this.safelyRecord(() => { queued = this.store.queued(taskId); });
    this.safelyRecord(() => {
      for (const turn of queued) {
        this.store.setTurnStatus(turn.id, "cancelled");
        for (const role of ["user", "assistant"]) {
          const m = this.store.message(`${turn.id}:${role}`);
          m.status = "cancelled";
          this.store.saveMessage(m);
        }
      }
    });
    if (!run) {
      if (queued.length) this.safelyRecord(() => this.status(taskId, "cancelled"));
      this.emit({ type: "changed", taskId });
      return;
    }
    run.stopping = true;
    run.message.status = "cancelling";
    this.safelyRecord(() => {
      this.store.setTurnStatus(run.turn.id, "cancelling");
      this.status(taskId, "cancelling");
      this.flush(run);
    });
    run.interrupting = (async () => {
      if (!run.handle) run.cancel();
      else {
        await this.quiesce(run);
        run.cancel();
      }
      await run.completion;
    })();
    try { await run.interrupting } finally { run.interrupting = undefined }
  }
  private async quiesce(run: ActiveRun) {
    if (!run.handle || run.quiescent) return;
    try {
      await this.bounded(Promise.all([run.handle.interrupt(), run.handle.done.catch((error) => {
        if (error instanceof Error && error.name === "ProviderQuiescenceError") throw error;
      })]), 10_000);
    } catch (error) {
      const adapter = this.providers.find((p) => p.id === run.turn.providerId);
      if (!adapter) throw error;
      this.notice("The provider did not stop cleanly. Closing its connection before releasing this workspace.");
      await (run.handle.dispose ? run.handle.dispose() : adapter.dispose());
    }
    run.quiescent = true;
  }
  async steer(taskId: string, text: string) {
    const run = this.active.get(taskId);
    if (!run?.handle?.steer)
      throw new Error(
        "This provider cannot accept live guidance. Send a queued message instead.",
      );
    if (!text.trim()) throw new Error("Write guidance first.");
    await run.handle.steer(text);
    this.store.event(taskId, run.turn.id, "steering", { text });
    const m: Message = {
      id: randomUUID(),
      taskId,
      turnId: run.turn.id,
      role: "user",
      content: text,
      activities: [],
      status: "completed",
      createdAt: Date.now(),
    };
    this.store.saveMessage(m);
    this.emit({ type: "message", message: m });
  }
  async respond(taskId: string, requestId: string, response: unknown) {
    const run = this.active.get(taskId);
    if (!run?.pending.has(requestId) || !run.handle?.respond)
      throw new Error("This request is no longer waiting for an answer.");
    await run.handle.respond(requestId, response);
    if (this.active.get(taskId) !== run) return;
    run.pending.delete(requestId);
    this.store.event(taskId, run.turn.id, "response", { requestId, response });
    run.message.status = run.pending.size ? "waiting" : "running";
    this.store.setTurnStatus(run.turn.id, run.message.status);
    this.status(taskId, run.message.status);
    this.flush(run);
    this.emit({ type: "changed", taskId });
  }
  editQueued(taskId: string, turnId: string, prompt: string) {
    if (!prompt.trim() || prompt.length > 200_000)
      throw new Error("Write a message shorter than 200,000 characters.");
    const turn = this.store.editQueued(taskId, turnId, prompt.trim());
    this.emit({ type: "changed", taskId });
    return turn;
  }
  cancelQueued(taskId: string, turnId: string) {
    this.store.cancelQueued(taskId, turnId);
    if (!this.active.has(taskId) && !this.store.queued(taskId).length)
      this.status(taskId, "cancelled");
    this.emit({ type: "changed", taskId });
  }
  reorderQueued(taskId: string, turnIds: string[]) {
    const turns = this.store.reorderQueued(taskId, turnIds);
    this.emit({ type: "changed", taskId });
    return turns;
  }
  private async bounded(operation: Promise<unknown>, ms: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        operation,
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Provider did not become quiescent within the stop deadline")), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async shutdown() {
    this.closing = true;
    const running = [...this.active.values()];
    await Promise.allSettled(
      [...this.active.keys()].map((id) => this.stop(id)),
    );
    const disposed = await Promise.allSettled(this.providers.map((p) => p.dispose()));
    const failed = disposed.flatMap((result, index) => result.status === "rejected"
      ? [`${this.providers[index].id}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`] : []);
    if (failed.length) throw new Error(`Provider cleanup remains incomplete: ${failed.join("; ")}`);
    for (const run of running) run.cancel();
    await Promise.allSettled(running.map((run) => run.completion));
    await Promise.allSettled([...this.manualOperations.values()]);
  }
}
