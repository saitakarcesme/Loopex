import type { PendingRequest, TaskDetail } from '../../../shared/contracts'

/** Reads may overlap streamed output. Only pending events received since the read
 * began are newer than its pending snapshot; an old visible prompt is not evidence. */
export function mergeTaskRead(
  existing: TaskDetail | undefined,
  incoming: TaskDetail,
  streamed: boolean,
  pendingSinceRead: PendingRequest[],
  answered: ReadonlySet<string>,
): TaskDetail {
  const pending = [...new Map([...incoming.pending, ...pendingSinceRead]
    .filter(request => !answered.has(request.id))
    .map(request => [request.id, request])).values()]
  if (!existing || !streamed) return { ...incoming, pending }
  const latest = new Map(existing.messages.map(message => [message.id, message]))
  const messages = incoming.messages.map(message => latest.get(message.id) || message)
  const known = new Set(messages.map(message => message.id))
  for (const message of existing.messages) if (!known.has(message.id)) messages.push(message)
  return {
    ...incoming,
    task: existing.task.updatedAt >= incoming.task.updatedAt ? existing.task : incoming.task,
    messages,
    pending,
  }
}
