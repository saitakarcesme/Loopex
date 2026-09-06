import type { Attachment } from '../../../shared/contracts'

export interface ComposerSubmission {
  requestId: string
  kind: 'send' | 'steer'
  fingerprint: string
  text: string
  attachmentIds: string[]
}
export interface ComposerDraft {
  version: 1
  text: string
  attachments: Attachment[]
  pending: ComposerSubmission | null
}

export function restoreComposerDraft(
  cached: unknown,
  databaseDraft: string,
  legacyAttachments: Attachment[] = [],
): ComposerDraft {
  const value = cached as Partial<ComposerDraft> | null
  if (value?.version === 1 && typeof value.text === 'string' && Array.isArray(value.attachments)) {
    const pending = value.pending
    return {
      version: 1,
      text: value.text,
      attachments: value.attachments,
      pending:
        pending &&
        typeof pending.requestId === 'string' &&
        typeof pending.text === 'string' &&
        typeof pending.fingerprint === 'string' &&
        Array.isArray(pending.attachmentIds) &&
        (pending.kind === 'send' || pending.kind === 'steer')
          ? pending
          : null,
    }
  }
  return { version: 1, text: databaseDraft, attachments: legacyAttachments, pending: null }
}

export function beginComposerSubmission(
  draft: ComposerDraft,
  kind: ComposerSubmission['kind'],
  requestId: string,
): ComposerDraft {
  const fingerprint = JSON.stringify({
    kind,
    prompt: draft.text.trim(),
    attachments: draft.attachments.map((file) => file.id),
  })
  const pending =
    draft.pending?.kind === 'send' && kind === 'send' && draft.pending.fingerprint === fingerprint
      ? draft.pending
      : {
          requestId,
          kind,
          fingerprint,
          text: draft.text,
          attachmentIds: draft.attachments.map((file) => file.id),
        }
  return { ...draft, pending }
}

export function acknowledgeComposerSubmission(
  draft: ComposerDraft,
  requestId: string,
): ComposerDraft {
  const pending = draft.pending
  if (pending?.requestId !== requestId) return draft
  return {
    ...draft,
    text: draft.text === pending.text ? '' : draft.text,
    attachments: draft.attachments.filter((file) => !pending.attachmentIds.includes(file.id)),
    pending: null,
  }
}
