export interface ShutdownOperation {
  name: string;
  run(): Promise<void> | void;
}
interface Stage extends ShutdownOperation {
  status: "idle" | "running" | "completed" | "failed";
  pending?: Promise<void>;
  error?: string;
}

/** Retains unfinished cleanup across deadlines; retry never starts a duplicate operation. */
export class ShutdownCoordinator {
  private readonly stages: Stage[];
  private readonly storage: Stage;
  private pending?: Promise<void>;
  state: "idle" | "stopping" | "failed" | "ready" = "idle";

  constructor(
    operations: ShutdownOperation[],
    finalize: () => Promise<void> | void,
    private readonly timeoutMs = 15_000,
    private readonly report: (event: { stage: string; status: Stage["status"]; error?: string }) => void = () => {},
  ) {
    this.stages = operations.map((operation) => ({ ...operation, status: "idle" }));
    this.storage = { name: "storage", run: finalize, status: "idle" };
  }

  snapshot() {
    return {
      state: this.state,
      stages: [...this.stages, this.storage].map(({ name, status, error }) => ({ name, status, error })),
    };
  }

  run(): Promise<void> {
    if (this.state === "ready") return Promise.resolve();
    if (this.pending) return this.pending;
    this.state = "stopping";
    this.pending = (async () => {
      const results = await Promise.allSettled(this.stages.map((stage) => this.settle(stage)));
      const errors = results.flatMap((result, index) => result.status === "rejected"
        ? [`${this.stages[index].name}: ${message(result.reason)}`] : []);
      if (errors.length) throw new Error(errors.join("; "));
      await this.settle(this.storage);
      this.state = "ready";
    })().catch((error) => {
      this.state = "failed";
      throw error;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async settle(stage: Stage) {
    if (stage.status === "completed") return;
    if (!stage.pending) {
      stage.status = "running";
      stage.error = undefined;
      this.report({ stage: stage.name, status: stage.status });
      stage.pending = Promise.resolve().then(() => stage.run()).then(() => {
        stage.status = "completed";
        stage.error = undefined;
        this.report({ stage: stage.name, status: stage.status });
      }, (error) => {
        stage.status = "failed";
        stage.error = message(error);
        this.report({ stage: stage.name, status: stage.status, error: stage.error });
        throw error;
      }).finally(() => { stage.pending = undefined; });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        stage.pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Cleanup is still running; ownership is retained. Retry Quit to check again.")), this.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
