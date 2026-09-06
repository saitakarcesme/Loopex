import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppEvent, AppSnapshot, Message, Task, TaskDetail } from '../../../shared/contracts'
import { api, errorText, persist, remember } from '../api'

export function useWorkspace() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [details, setDetails] = useState<Record<string, TaskDetail>>({})
  const [selectedId, setSelectedId] = useState<string | null>(() => remember('selectedTask', null))
  const selectedRef = useRef(selectedId)
  selectedRef.current = selectedId
  const [error, setError] = useState<string | null>(null)
  const [notices, setNotices] = useState<Array<{ id: string; text: string }>>([])
  const [loadingTask, setLoadingTask] = useState(false)
  const initialLoaded = useRef(false)
  const revisions = useRef(new Map<string, number>())
  const pendingReads = useRef(new Map<string, Promise<TaskDetail>>())

  const notify = useCallback((text: string) => {
    const id = crypto.randomUUID()
    setNotices((current) => [...current.slice(-3), { id, text }])
  }, [])
  const dismissNotice = useCallback(
    (id: string) => setNotices((current) => current.filter((notice) => notice.id !== id)),
    [],
  )
  const reportError = useCallback((error: unknown) => notify(errorText(error)), [notify])
  const updateTask = useCallback((task: Task) => {
    revisions.current.set(task.id, (revisions.current.get(task.id) || 0) + 1)
    setSnapshot((current) =>
      current
        ? { ...current, tasks: [task, ...current.tasks.filter((item) => item.id !== task.id)] }
        : current,
    )
    setDetails((current) =>
      current[task.id] ? { ...current, [task.id]: { ...current[task.id], task } } : current,
    )
  }, [])
  const updateMessage = useCallback((message: Message) => {
    revisions.current.set(message.taskId, (revisions.current.get(message.taskId) || 0) + 1)
    setDetails((current) => {
      const detail = current[message.taskId]
      if (!detail) return current
      const index = detail.messages.findIndex((item) => item.id === message.id)
      const messages =
        index === -1
          ? [...detail.messages, message]
          : detail.messages.map((item) => (item.id === message.id ? message : item))
      return { ...current, [message.taskId]: { ...detail, messages } }
    })
  }, [])
  const readTask = useCallback(async (taskId: string) => {
    const pending = pendingReads.current.get(taskId)
    if (pending) return pending
    const revision = revisions.current.get(taskId) || 0
    const promise = api<TaskDetail>('task:read', { taskId })
    pendingReads.current.set(taskId, promise)
    try {
      const incoming = await promise
      setDetails((current) => {
        // A full read started before a stream update must not replace newer output.
        const existing = current[taskId]
        if (existing && revision !== (revisions.current.get(taskId) || 0)) {
          const latest = new Map(existing.messages.map((message) => [message.id, message]))
          const messages = incoming.messages.map((message) => latest.get(message.id) || message)
          for (const message of existing.messages)
            if (!messages.some((item) => item.id === message.id)) messages.push(message)
          return {
            ...current,
            [taskId]: {
              ...incoming,
              task:
                existing.task.updatedAt >= incoming.task.updatedAt ? existing.task : incoming.task,
              messages,
              pending: [
                ...new Map(
                  [...incoming.pending, ...existing.pending].map((request) => [
                    request.id,
                    request,
                  ]),
                ).values(),
              ],
            },
          }
        }
        return { ...current, [taskId]: incoming }
      })
      return incoming
    } finally {
      pendingReads.current.delete(taskId)
    }
  }, [])
  const refresh = useCallback(async () => {
    const next = await api<AppSnapshot>('app:snapshot')
    setSnapshot(next)
    setError(null)
    if (!initialLoaded.current) {
      initialLoaded.current = true
      if (selectedRef.current && !next.tasks.some((task) => task.id === selectedRef.current))
        setSelectedId(null)
    }
    return next
  }, [])
  useEffect(() => {
    void refresh().catch((error) => setError(errorText(error)))
    if (!window.akorith) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = window.akorith.onEvent((event: AppEvent) => {
      if (event.type === 'task') updateTask(event.task)
      else if (event.type === 'message') updateMessage(event.message)
      else if (event.type === 'pending') {
        revisions.current.set(
          event.request.taskId,
          (revisions.current.get(event.request.taskId) || 0) + 1,
        )
        setDetails((current) => {
          const detail = current[event.request.taskId]
          return detail
            ? {
                ...current,
                [event.request.taskId]: {
                  ...detail,
                  pending: [
                    ...detail.pending.filter((request) => request.id !== event.request.id),
                    event.request,
                  ],
                },
              }
            : current
        })
      } else if (event.type === 'notice') notify(event.text)
      else if (event.type === 'changed') {
        if (event.taskId) void readTask(event.taskId).catch(reportError)
        clearTimeout(timer)
        timer = setTimeout(() => void refresh().catch(reportError), 100)
      }
    })
    return () => {
      clearTimeout(timer)
      unsubscribe()
    }
  }, [notify, readTask, refresh, reportError, updateMessage, updateTask])
  useEffect(() => {
    persist('selectedTask', selectedId)
    if (!selectedId) return
    let disposed = false
    setLoadingTask(true)
    void readTask(selectedId)
      .catch(reportError)
      .finally(() => {
        if (!disposed) setLoadingTask(false)
      })
    return () => {
      disposed = true
    }
  }, [selectedId, readTask, reportError])
  const patchTask = useCallback(
    async (taskId: string, patch: Partial<Task>) => {
      const task = await api<Task>('task:update', { taskId, patch })
      updateTask(task)
      return task
    },
    [updateTask],
  )
  const createTask = useCallback(
    async (projectId: string | null = null, providerId?: string, model?: string) => {
      const task = await api<Task>('task:create', { projectId, providerId, model })
      updateTask(task)
      setDetails((current) => ({ ...current, [task.id]: { task, messages: [], pending: [] } }))
      setSelectedId(task.id)
      return task
    },
    [updateTask],
  )
  const respond = useCallback(async (taskId: string, requestId: string, response: unknown) => {
    await api('task:respond', { taskId, requestId, response })
    setDetails((current) =>
      current[taskId]
        ? {
            ...current,
            [taskId]: {
              ...current[taskId],
              pending: current[taskId].pending.filter((request) => request.id !== requestId),
            },
          }
        : current,
    )
  }, [])
  return {
    snapshot,
    setSnapshot,
    detail: selectedId ? details[selectedId] : undefined,
    selectedId,
    selectTask: setSelectedId,
    loadingTask,
    error,
    notices,
    dismissNotice,
    notify,
    reportError,
    refresh,
    readTask,
    patchTask,
    createTask,
    respond,
  }
}
