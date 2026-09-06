/** Tracks accepted asynchronous IPC work until every continuation has settled. */
export class CommandOperations {
  private readonly active = new Set<Promise<unknown>>();

  get size() { return this.active.size; }

  run<T>(action: () => Promise<T>): Promise<T> {
    const operation = Promise.resolve().then(action);
    this.active.add(operation);
    void operation.finally(() => this.active.delete(operation)).catch(() => {});
    return operation;
  }

  async drain(): Promise<void> {
    // Main's closing fence rejects new asynchronous mutations. Read-only and
    // draft-only synchronous commands may still settle while resources close.
    while (this.active.size) await Promise.allSettled([...this.active]);
  }
}
