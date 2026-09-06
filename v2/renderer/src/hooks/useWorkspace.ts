import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppEvent, AppSnapshot, Message, PendingRequest, Task, TaskDetail } from '../../../shared/contracts'
import { useTaskNavigation } from './useTaskNavigation'
import { mergeTaskRead } from './taskReadState'
import { api, errorText, persist, remember } from '../api'

export function useWorkspace() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [details, setDetails] = useState<Record<string, TaskDetail>>({})
  const navigation = useTaskNavigation(() => remember('selectedTask', null))
  const { selectedId, selectTask: setSelectedId } = navigation
  const selectedRef = useRef(selectedId)
  selectedRef.current = selectedId
  const [error, setError] = useState<string | null>(null)
  const [notices, setNotices] = useState<Array<{ id: string; text: string }>>([])
  const [loadingTask, setLoadingTask] = useState(false)
  const initialLoaded = useRef(false)
  const revisions = useRef(new Map<string, number>())
  const answered = useRef(new Map<string, Set<string>>())
  const pendingEvents = useRef(new Map<string, Map<string, { revision: number; request: PendingRequest }>>())
  const reread = useRef(new Set<string>())
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
  const readTask = useCallback(async (taskId: string): Promise<TaskDetail> => {
    const pending = pendingReads.current.get(taskId)
    if (pending) { reread.current.add(taskId); return pending }
    const revision = revisions.current.get(taskId) || 0
    const promise = api<TaskDetail>('task:read', { taskId })
    pendingReads.current.set(taskId, promise)
    try {
      const incoming = await promise
      setDetails((current) => {
        return { ...current, [taskId]: mergeTaskRead(
          current[taskId], incoming, revision !== (revisions.current.get(taskId) || 0),
          [...(pendingEvents.current.get(taskId)?.values() || [])]
            .filter(event => event.revision > revision).map(event => event.request),
          answered.current.get(taskId) || new Set(),
        ) }
      })
      return incoming
    } finally {
      pendingReads.current.delete(taskId)
      if (reread.current.delete(taskId)) void readTask(taskId).catch(reportError)
    }
  }, [reportError])
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
  }, [setSelectedId])
  useEffect(() => {
    void refresh().catch((error) => setError(errorText(error)))
    if (!window.akorith) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = window.akorith.onEvent((event: AppEvent) => {
      if (event.type === 'task') updateTask(event.task)
      else if (event.type === 'message') updateMessage(event.message)
      else if (event.type === 'pending') {
        if (answered.current.get(event.request.taskId)?.has(event.request.id)) return
        revisions.current.set(
          event.request.taskId,
          (revisions.current.get(event.request.taskId) || 0) + 1,
        )
        let events = pendingEvents.current.get(event.request.taskId)
        if (!events) { events = new Map(); pendingEvents.current.set(event.request.taskId, events) }
        events.set(event.request.id, { revision: revisions.current.get(event.request.taskId)!, request: event.request })
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
    [updateTask, setSelectedId],
  )
  const respond = useCallback(async (taskId: string, requestId: string, response: unknown) => {
    await api('task:respond', { taskId, requestId, response })
    let resolved = answered.current.get(taskId)
    if (!resolved) { resolved = new Set(); answered.current.set(taskId, resolved) }
    resolved.add(requestId)
    pendingEvents.current.get(taskId)?.delete(requestId)
    revisions.current.set(taskId, (revisions.current.get(taskId) || 0) + 1)
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
    navigation,
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
