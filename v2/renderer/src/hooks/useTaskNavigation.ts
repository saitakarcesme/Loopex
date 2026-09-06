import { useCallback, useRef, useState } from 'react'
import { navigationIndex, selectedTask, visitTask, type TaskNavigationState } from './taskNavigationState'

export function useTaskNavigation(initial: () => string | null) {
  const [history, setHistory] = useState<TaskNavigationState>(() => visitTask({ entries: [], index: -1 }, initial()))
  const current = useRef(history)
  const selectTask = useCallback((id: string | null) => {
    const next = visitTask(current.current, id)
    current.current = next
    setHistory(next)
  }, [])
  const navigate = useCallback((direction: -1 | 1, available: ReadonlySet<string>) => {
    const index = navigationIndex(current.current, direction, available)
    if (index === current.current.index) return null
    const next = { ...current.current, index }
    current.current = next
    setHistory(next)
    return selectedTask(next)
  }, [])
  return { selectedId: selectedTask(history), selectTask, navigate, history }
}
