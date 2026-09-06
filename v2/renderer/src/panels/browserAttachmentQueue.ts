/** Native view mutations must finish in order: a late show must never overtake
 * the hide barrier preceding a layout change or a task switch. */
export class BrowserAttachmentQueue {
  private tail: Promise<unknown> = Promise.resolve()
  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation)
    this.tail = result.catch(() => {})
    return result
  }
}
export const browserAttachments = new BrowserAttachmentQueue()
