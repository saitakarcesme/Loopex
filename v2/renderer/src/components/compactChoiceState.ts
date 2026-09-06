export interface CompactOption { value: string; label: string; description?: string; disabled?: boolean }
export function choiceKey(key: string, options: CompactOption[], current: string, composing = false): { value?: string; commit?: string; close?: boolean; handled: boolean } {
  if (composing) return { handled: false }
  if (key === 'Escape') return { handled: true, close: true }
  const enabled = options.filter(option => !option.disabled)
  if (!enabled.length) return { handled: ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(key) }
  const index = enabled.findIndex(option => option.value === current)
  if (key === 'Enter' || key === ' ') return { handled: true, ...(index >= 0 ? { commit: enabled[index].value } : {}) }
  if (key === 'Home' || key === 'End') return { handled: true, value: enabled[key === 'Home' ? 0 : enabled.length - 1].value }
  if (key === 'ArrowDown' || key === 'ArrowUp') return { handled: true, value: enabled[index < 0 ? (key === 'ArrowDown' ? 0 : enabled.length - 1) : (index + (key === 'ArrowDown' ? 1 : enabled.length - 1)) % enabled.length].value }
  return { handled: false }
}
export function restoreChoiceFocus(trigger: { isConnected: boolean; disabled: boolean; focus(options: { preventScroll: boolean }): void } | null, reason: 'escape' | 'selection' | 'tab' | 'outside') {
  if (reason !== 'outside' && trigger?.isConnected && !trigger.disabled) trigger.focus({ preventScroll: true })
}
