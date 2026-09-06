import type { AkorithAPI, RunStatus } from '../../shared/contracts'

declare global {
  interface Window {
    akorith: AkorithAPI
  }
}

export const api = <T = unknown>(command: string, payload?: unknown): Promise<T> => {
  if (!window.akorith)
    return Promise.reject(
      new Error('Akorith’s desktop connection is unavailable. Reopen the desktop app.'),
    )
  return window.akorith.invoke<T>(command, payload)
}
export const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    : String(error)
export const activeStatuses: RunStatus[] = [
  'queued',
  'starting',
  'running',
  'waiting',
  'cancelling',
]
export const isActive = (status?: RunStatus) => !!status && activeStatuses.includes(status)
export const statusLabel: Record<RunStatus, string> = {
  idle: 'Ready',
  queued: 'Queued',
  starting: 'Starting',
  running: 'Working',
  waiting: 'Needs your input',
  cancelling: 'Stopping',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Stopped',
  interrupted: 'Interrupted',
}
export function remember<T>(key: string, fallback: T): T {
  try {
    const saved = localStorage.getItem(`akorith.v2.${key}`)
    return saved === null ? fallback : (JSON.parse(saved) as T)
  } catch {
    return fallback
  }
}
export function persist(key: string, value: unknown) {
  try {
    localStorage.setItem(`akorith.v2.${key}`, JSON.stringify(value))
  } catch {
    /* Nonessential preferences must never block working. */
  }
}
export const basename = (path: string) => path.split('/').filter(Boolean).at(-1) || path
export const compactNumber = (number: number) =>
  new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(number)
