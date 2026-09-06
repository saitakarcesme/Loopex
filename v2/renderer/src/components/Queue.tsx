import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  ListOrdered,
  Pencil,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { Attachment, ProviderId } from '../../../shared/contracts'
import { api } from '../api'
import { IconButton, Spinner } from './Primitives'

interface QueuedTurn {
  id: string
  taskId: string
  prompt: string
  attachments: Attachment[]
  createdAt: number
  providerId: ProviderId
  model: string
  effort: string
  mode: string
}
export function Queue({ taskId, onError }: { taskId: string; onError: (error: unknown) => void }) {
  const [turns, setTurns] = useState<QueuedTurn[]>([])
  const [expanded, setExpanded] = useState(true)
  const [editing, setEditing] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [reordering, setReordering] = useState(false)
  const refresh = useCallback(async () => {
    setTurns(await api<QueuedTurn[]>('task:queue', { taskId }))
  }, [taskId])
  useEffect(() => {
    void refresh().catch(onError)
    return window.akorith.onEvent((event) => {
      if (
        (event.type === 'changed' && event.taskId === taskId) ||
        (event.type === 'task' && event.task.id === taskId)
      )
        void refresh().catch(onError)
    })
  }, [refresh, taskId, onError])
  const mutate = async (turnId: string, action: 'task:queueEdit' | 'task:queueRemove') => {
    if (busy || reordering) return
    setBusy(turnId)
    try {
      await api(action, {
        taskId,
        turnId,
        prompt: action === 'task:queueEdit' ? prompt.trim() : undefined,
      })
      setEditing(null)
      await refresh()
    } catch (error) {
      onError(error)
    } finally {
      setBusy(null)
    }
  }
  const reorder = async (turnId: string, direction: -1 | 1) => {
    if (busy || reordering) return
    const index = turns.findIndex((turn) => turn.id === turnId)
    const target = index + direction
    if (index < 0 || target < 0 || target >= turns.length) return
    const turnIds = turns.map((turn) => turn.id)
    ;[turnIds[index], turnIds[target]] = [turnIds[target], turnIds[index]]
    setReordering(true)
    try {
      await api('task:queueReorder', { taskId, turnIds })
      await refresh()
    } catch (error) {
      onError(error)
      await refresh().catch(onError)
    } finally {
      setReordering(false)
    }
  }
  if (!turns.length) return null
  return (
    <div className="queue-tray" aria-busy={reordering}>
      <button className="queue-heading" onClick={() => setExpanded((value) => !value)}>
        <ListOrdered size={13} />
        <span>
          {turns.length} message{turns.length > 1 ? 's' : ''} queued
        </span>
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {expanded ? (
        <div className="queue-items">
          {turns.map((turn, index) => (
            <div key={turn.id} className="queue-item">
              <span className="queue-number">{index + 1}</span>
              {editing === turn.id ? (
                <form
                  className="queue-edit"
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (prompt.trim()) void mutate(turn.id, 'task:queueEdit')
                  }}
                >
                  <textarea
                    aria-label="Edit queued message"
                    disabled={busy === turn.id}
                    value={prompt}
                    autoFocus
                    onChange={(event) => setPrompt(event.target.value)}
                  />
                  <div>
                    <div className="queue-reorder-actions" role="group" aria-label="Queue position">
                      <IconButton
                        label={`Move queued message ${index + 1} up`}
                        disabled={!!busy || reordering || index === 0}
                        onClick={() => void reorder(turn.id, -1)}
                      >
                        <ArrowUp size={12} />
                      </IconButton>
                      <IconButton
                        label={`Move queued message ${index + 1} down`}
                        disabled={!!busy || reordering || index === turns.length - 1}
                        onClick={() => void reorder(turn.id, 1)}
                      >
                        <ArrowDown size={12} />
                      </IconButton>
                    </div>
                    <button type="button" className="text-button" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                    <button
                      className="small-button"
                      disabled={!prompt.trim() || !!busy || reordering}
                    >
                      {busy === turn.id ? <Spinner size={12} /> : <Check size={12} />}Save
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="queue-prompt">
                    <p>{turn.prompt}</p>
                    <small>
                      {turn.providerId} · {turn.model || 'Default model'}
                      {turn.effort ? ` · ${turn.effort}` : ''}
                      {turn.attachments.length
                        ? ` · ${turn.attachments.length} attachment${turn.attachments.length > 1 ? 's' : ''}`
                        : ''}
                    </small>
                  </div>
                  <div
                    className="queue-reorder-actions"
                    role="group"
                    aria-label={`Reorder queued message ${index + 1}`}
                  >
                    <IconButton
                      label={`Move queued message ${index + 1} up`}
                      disabled={!!busy || reordering || index === 0}
                      onClick={() => void reorder(turn.id, -1)}
                    >
                      <ArrowUp size={12} />
                    </IconButton>
                    <IconButton
                      label={`Move queued message ${index + 1} down`}
                      disabled={!!busy || reordering || index === turns.length - 1}
                      onClick={() => void reorder(turn.id, 1)}
                    >
                      <ArrowDown size={12} />
                    </IconButton>
                  </div>
                  <IconButton
                    label="Edit queued message"
                    disabled={!!busy || reordering}
                    onClick={() => {
                      setEditing(turn.id)
                      setPrompt(turn.prompt)
                    }}
                  >
                    <Pencil size={12} />
                  </IconButton>
                  <IconButton
                    label="Remove queued message"
                    disabled={!!busy || reordering}
                    onClick={() => void mutate(turn.id, 'task:queueRemove')}
                  >
                    {busy === turn.id ? <Spinner size={12} /> : <X size={12} />}
                  </IconButton>
                </>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
