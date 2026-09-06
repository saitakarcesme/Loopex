/** A failed drain retains the underlying operations; a timeout is never evidence of quiescence. */
export class HostDrainError extends Error {
  readonly code = 'HOST_DRAIN_INCOMPLETE'
  constructor(message: string, readonly failures: unknown[] = []) { super(message); this.name = 'HostDrainError' }
}

export async function settleWithin<T>(operation: Promise<T>, label: string, milliseconds = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new HostDrainError(`${label} has not stopped; ownership is retained.`)), milliseconds)
    })])
  } finally { if (timer) clearTimeout(timer) }
}

export async function settleStages(stages: Array<[string, () => void | Promise<unknown>]>, milliseconds = 5000): Promise<void> {
  const results = await Promise.allSettled(stages.map(([name, run]) => settleWithin(Promise.resolve().then(run), name, milliseconds)))
  const failures = results.flatMap((result, index) => result.status === 'rejected' ? [{ stage: stages[index][0], error: result.reason }] : [])
  if (failures.length) throw new HostDrainError(`Host cleanup remains incomplete: ${failures.map(item => item.stage).join(', ')}.`, failures)
}

export class HostActivity {
  private active = new Map<Promise<unknown>, string | undefined>()
  private closing = false
  close(): void { this.closing = true }
  run<T>(taskId: string | undefined, operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Host is shutting down; new actions are unavailable.'))
    const result = Promise.resolve().then(operation)
    this.active.set(result, taskId)
    void result.then(() => this.active.delete(result), () => this.active.delete(result))
    return result
  }
  async drain(taskId?: string, milliseconds = 5000): Promise<void> {
    // New work is prevented globally on dispose. Turn drains are called after the provider stops dispatching.
    while (true) {
      const pending = [...this.active].filter(([, id]) => taskId === undefined || id === taskId).map(([promise]) => promise)
      if (!pending.length) return
      await settleWithin(Promise.allSettled(pending), 'Host operations', milliseconds)
    }
  }
}
