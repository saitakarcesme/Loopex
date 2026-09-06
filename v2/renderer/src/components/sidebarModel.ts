import type { Task } from '../../../shared/contracts'

export const TASK_PAGE_SIZE = 30
export const PROJECT_PAGE_SIZE = 12

export function groupSidebarTasks(tasks: Task[], archived: boolean, projectIds: Set<string>) {
  const pinned: Task[] = [],
    loose: Task[] = []
  const byProject = new Map<string, Task[]>()
  let count = 0
  for (const task of tasks) {
    if (task.archived !== archived) continue
    count++
    if (task.pinned) pinned.push(task)
    else if (task.projectId && projectIds.has(task.projectId)) {
      const group = byProject.get(task.projectId)
      if (group) group.push(task)
      else byProject.set(task.projectId, [task])
    } else loose.push(task)
  }
  const recent = (a: Task, b: Task) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)
  pinned.sort(
    (a, b) =>
      (a.pinOrder ?? Number.MAX_SAFE_INTEGER) - (b.pinOrder ?? Number.MAX_SAFE_INTEGER) ||
      recent(a, b),
  )
  loose.sort(recent)
  for (const group of byProject.values()) group.sort(recent)
  return { pinned, loose, byProject, count }
}

// Keep the selected older item reachable without mounting every intervening row.
export function sidebarPage<T extends { id: string }>(
  items: T[],
  limit: number,
  selectedId: string | null,
) {
  const visible = items.slice(0, limit)
  const selected =
    selectedId && !visible.some((item) => item.id === selectedId)
      ? (items.find((item) => item.id === selectedId) ?? null)
      : null
  return { visible, selected, remaining: items.length - visible.length - (selected ? 1 : 0) }
}
