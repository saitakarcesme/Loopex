export interface TaskNavigationState { entries: string[]; index: number }
export const selectedTask = (state: TaskNavigationState) => state.entries[state.index] || null
export function visitTask(state: TaskNavigationState, id: string | null): TaskNavigationState {
  if (!id) return { entries: [], index: -1 }
  if (selectedTask(state) === id) return state
  const entries = [...state.entries.slice(0, state.index + 1), id].slice(-100)
  return { entries, index: entries.length - 1 }
}
export function navigationIndex(state: TaskNavigationState, direction: -1 | 1, available: ReadonlySet<string>): number {
  for (let index = state.index + direction; index >= 0 && index < state.entries.length; index += direction)
    if (available.has(state.entries[index])) return index
  return state.index
}
export function navigationShortcut(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'defaultPrevented'>, editable: boolean): -1 | 1 | null {
  if (event.defaultPrevented || event.isComposing || event.shiftKey) return null
  if ((event.metaKey || event.ctrlKey) && !event.altKey) {
    if (event.key === '[') return -1
    if (event.key === ']') return 1
  }
  if (event.altKey && !event.metaKey && !event.ctrlKey && !editable) {
    if (event.key === 'ArrowLeft') return -1
    if (event.key === 'ArrowRight') return 1
  }
  return null
}
