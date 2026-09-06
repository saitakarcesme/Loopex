import type { EventEmitter } from 'node:events'

export type ShellLifecycleEvent = {
  phase: 'navigation-started' | 'dom-ready' | 'load-finished' | 'load-failed' | 'renderer-gone' | 'unresponsive' | 'responsive' | 'destroyed' | 'browser-hide-failed'
  code?: number
  reason?: string
}
const goneReasons = new Set(['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction'])
const numericCode = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined

/** Main owns native views beyond a renderer document's lifetime. React cleanup
 * cannot be relied upon when that document reloads or its process exits. */
export function observeShellLifecycle(
  contents: Pick<EventEmitter, 'on' | 'removeListener'>,
  hideBrowserViews: () => unknown | Promise<unknown>,
  log: (event: ShellLifecycleEvent) => void,
): () => void {
  const listeners: Array<[string, (...args: any[]) => void]> = []
  const on = (event: string, listener: (...args: any[]) => void) => {
    contents.on(event, listener)
    listeners.push([event, listener])
  }
  const hide = () => {
    try { void Promise.resolve(hideBrowserViews()).catch(() => log({ phase: 'browser-hide-failed' })) }
    catch { log({ phase: 'browser-hide-failed' }) }
  }
  const dispose = () => { for (const [event, listener] of listeners) contents.removeListener(event, listener) }
  on('did-start-navigation', (details: { isMainFrame?: boolean; isSameDocument?: boolean }) => {
    if (!details.isMainFrame || details.isSameDocument) return
    hide()
    log({ phase: 'navigation-started' })
  })
  on('dom-ready', () => log({ phase: 'dom-ready' }))
  on('did-finish-load', () => log({ phase: 'load-finished' }))
  on('did-fail-load', (_event, errorCode: number, _description: string, _url: string, isMainFrame: boolean) => {
    if (!isMainFrame) return
    hide()
    log({ phase: 'load-failed', code: numericCode(errorCode) })
  })
  on('render-process-gone', (_event, details: { reason?: string; exitCode?: number }) => {
    hide()
    log({ phase: 'renderer-gone', code: numericCode(details.exitCode), reason: goneReasons.has(details.reason || '') ? details.reason : 'unknown' })
  })
  on('unresponsive', () => log({ phase: 'unresponsive' }))
  on('responsive', () => log({ phase: 'responsive' }))
  on('destroyed', () => { hide(); log({ phase: 'destroyed' }); dispose() })
  return dispose
}
