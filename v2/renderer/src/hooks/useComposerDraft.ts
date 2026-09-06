import { useCallback, useRef, useSyncExternalStore } from 'react'
import type { Attachment } from '../../../shared/contracts'
import { remember } from '../api'
import { restoreComposerDraft, type ComposerDraft } from '../components/composerDraftState'

const cache = new Map<string, ComposerDraft>()
const listeners = new Map<string, Set<() => void>>()

function read(taskId: string, databaseDraft: string) {
  const current = cache.get(taskId)
  if (current) return current
  const restored = restoreComposerDraft(
    remember<unknown>(`composerDraft.${taskId}`, null),
    databaseDraft,
    remember<Attachment[]>(`attachments.${taskId}`, []),
  )
  cache.set(taskId, restored)
  return restored
}

export function useComposerDraft(
  taskId: string,
  databaseDraft: string,
  onError: (error: unknown) => void,
) {
  const databaseDraftRef = useRef(databaseDraft)
  databaseDraftRef.current = databaseDraft
  const getSnapshot = useCallback(() => read(taskId, databaseDraftRef.current), [taskId])
  const subscribe = useCallback(
    (listener: () => void) => {
      const set = listeners.get(taskId) || new Set<() => void>()
      set.add(listener)
      listeners.set(taskId, set)
      return () => {
        set.delete(listener)
        if (!set.size) listeners.delete(taskId)
      }
    },
    [taskId],
  )
  const draft = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const update = useCallback(
    (change: (current: ComposerDraft) => ComposerDraft) => {
      const next = change(read(taskId, databaseDraftRef.current))
      cache.set(taskId, next)
      try {
        // An empty record is intentional: it prevents an older DB draft resurrecting a sent prompt.
        localStorage.setItem(`akorith.v2.composerDraft.${taskId}`, JSON.stringify(next))
      } catch (error) {
        onError(
          new Error(
            `Could not save the local draft: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
      }
      for (const listener of listeners.get(taskId) || []) listener()
      return next
    },
    [taskId, onError],
  )
  return { draft, update }
}
