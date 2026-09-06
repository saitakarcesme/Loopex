import { ArrowUp, ChevronDown, Paperclip, ShieldCheck, Square, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Attachment, PermissionMode, ProviderInfo, Task } from '../../../shared/contracts'
import { api, isActive } from '../api'
import { useComposerDraft } from '../hooks/useComposerDraft'
import { AttachmentLink } from './ArtifactPreview'
import { acknowledgeComposerSubmission, beginComposerSubmission } from './composerDraftState'
import { IconButton, Spinner } from './Primitives'
import { Queue } from './Queue'

const preferredEffort = (efforts?: string[]) =>
  efforts?.includes('high') ? 'high' : efforts?.includes('medium') ? 'medium' : efforts?.[0] || ''
const preferredModel = (provider: ProviderInfo) =>
  provider.id === 'codex'
    ? provider.models.find((model) => model.id === 'gpt-6-astra') || provider.models[0]
    : provider.models[0]

interface ComposerProps {
  task: Task
  providers: ProviderInfo[]
  onPatch: (patch: Partial<Task>) => Promise<unknown>
  onSent: () => void
  onError: (error: unknown) => void
  onConnections: () => void
  suggestion?: { id: string; text: string } | null
}
export function Composer({
  task,
  providers,
  onPatch,
  onSent,
  onError,
  onConnections,
  suggestion,
}: ComposerProps) {
  const { draft: localDraft, update: updateLocalDraft } = useComposerDraft(
    task.id,
    task.draft,
    onError,
  )
  const { text: draft, attachments } = localDraft
  const [sending, setSending] = useState(false)
  const [attaching, setAttaching] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [sendMode, setSendMode] = useState<'queue' | 'steer'>('queue')
  const textarea = useRef<HTMLTextAreaElement>(null)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const lastSaved = useRef(task.draft)
  const sendingRef = useRef(false)
  const initializedModel = useRef<string | null>(null)
  const patchRef = useRef(onPatch)
  patchRef.current = onPatch
  const errorRef = useRef(onError)
  errorRef.current = onError
  const active = isActive(task.status)
  const provider = providers.find((item) => item.id === task.providerId)
  const model = provider?.models.find((item) => item.id === task.model)
  const available = !!provider?.available && provider.authenticated !== false
  const allowSteer = !!provider?.capabilities.steer
  const update = (patch: Partial<Task>) => void onPatch(patch).catch(onError)
  useEffect(() => {
    if (suggestion) {
      const next = updateLocalDraft((current) => ({ ...current, text: suggestion.text }))
      draftRef.current = next.text
      textarea.current?.focus()
    }
  }, [suggestion, updateLocalDraft])
  useEffect(() => {
    if (
      task.model ||
      task.status !== 'idle' ||
      !provider?.models.length ||
      initializedModel.current === provider.id
    )
      return
    const model = preferredModel(provider)
    initializedModel.current = provider.id
    void patchRef
      .current({ model: model.id, effort: task.effort || preferredEffort(model.efforts) })
      .catch(errorRef.current)
  }, [task.model, task.status, task.effort, provider])

  useEffect(() => {
    clearTimeout(saveTimer.current)
    if (draft === lastSaved.current) return
    saveTimer.current = setTimeout(() => {
      const value = draftRef.current
      void api<Task>('task:update', { taskId: task.id, patch: { draft: value } })
        .then(() => {
          lastSaved.current = value
        })
        .catch(errorRef.current)
    }, 350)
    return () => clearTimeout(saveTimer.current)
  }, [draft, task.id])
  useEffect(
    () => () => {
      clearTimeout(saveTimer.current)
      if (draftRef.current !== lastSaved.current)
        void api('task:update', { taskId: task.id, patch: { draft: draftRef.current } }).catch(
          errorRef.current,
        )
    },
    [task.id],
  )
  useLayoutEffect(() => {
    const element = textarea.current
    if (element) {
      element.style.height = '0px'
      element.style.height = `${Math.min(element.scrollHeight, 220)}px`
    }
  }, [draft])
  useEffect(() => {
    if (!active) setStopping(false)
  }, [active])
  useEffect(() => {
    const pending = localDraft.pending
    if (!pending || pending.kind !== 'send' || sending) return
    let disposed = false
    void api<{ accepted: boolean }>('task:submissionStatus', {
      taskId: task.id,
      requestId: pending.requestId,
    })
      .then((result) => {
        if (disposed || !result.accepted) return
        const next = updateLocalDraft((current) =>
          acknowledgeComposerSubmission(current, pending.requestId),
        )
        draftRef.current = next.text
        void api<Task>('task:update', { taskId: task.id, patch: { draft: next.text } })
          .then(() => {
            lastSaved.current = next.text
          })
          .catch(errorRef.current)
      })
      .catch(errorRef.current)
    return () => {
      disposed = true
    }
  }, [localDraft.pending, sending, task.id, updateLocalDraft])
  const submit = async () => {
    if (
      !draftRef.current.trim() ||
      sendingRef.current ||
      !available ||
      localDraft.pending?.kind === 'steer'
    )
      return
    const kind = active && sendMode === 'steer' && allowSteer ? 'steer' : 'send'
    sendingRef.current = true
    setSending(true)
    clearTimeout(saveTimer.current)
    const journal = updateLocalDraft((current) =>
      beginComposerSubmission(current, kind, crypto.randomUUID()),
    )
    const submitted = journal.pending!
    try {
      if (kind === 'steer')
        await api('task:steer', { taskId: task.id, text: submitted.text.trim() })
      else
        await api('task:send', {
          taskId: task.id,
          requestId: submitted.requestId,
          prompt: submitted.text.trim(),
          attachments: journal.attachments,
        })
      const next = updateLocalDraft((current) =>
        acknowledgeComposerSubmission(current, submitted.requestId),
      )
      draftRef.current = next.text
      onSent()
      await api<Task>('task:update', { taskId: task.id, patch: { draft: next.text } })
      lastSaved.current = next.text
      textarea.current?.focus()
    } catch (error) {
      onError(error)
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }
  const attach = async () => {
    setAttaching(true)
    try {
      const added = await api<Attachment[]>('attachments:add', { taskId: task.id })
      updateLocalDraft((current) => ({
        ...current,
        attachments: [
          ...current.attachments,
          ...added.filter(
            (file) => !current.attachments.some((existing) => existing.path === file.path),
          ),
        ],
      }))
    } catch (error) {
      onError(error)
    } finally {
      setAttaching(false)
    }
  }
  const stop = async () => {
    setStopping(true)
    try {
      await api('task:stop', { taskId: task.id })
    } catch (error) {
      setStopping(false)
      onError(error)
    }
  }
  return (
    <div className="composer-region">
      <Queue taskId={task.id} onError={onError} />
      {localDraft.pending?.kind === 'steer' && !sending ? (
        <div className="composer-recovery" role="alert">
          <strong>Guidance status needs review</strong>
          <p>
            This guidance may already have reached the running task. Check the conversation before
            sending it again.
          </p>
          <div>
            <button
              className="small-button"
              onClick={() => updateLocalDraft((current) => ({ ...current, pending: null }))}
            >
              Keep as draft
            </button>
            <button
              className="text-button"
              onClick={() => {
                const pending = localDraft.pending
                if (!pending) return
                const next = updateLocalDraft((current) =>
                  acknowledgeComposerSubmission(current, pending.requestId),
                )
                draftRef.current = next.text
              }}
            >
              Mark as sent
            </button>
          </div>
        </div>
      ) : null}
      <div className={`composer ${sending ? 'submitting' : ''}`}>
        {attachments.length ? (
          <div className="composer-attachments">
            {attachments.map((attachment) => (
              <div key={attachment.id} className="attachment-chip">
                <AttachmentLink attachment={attachment} />
                <IconButton
                  label={`Remove ${attachment.name}`}
                  onClick={() =>
                    updateLocalDraft((current) => ({
                      ...current,
                      attachments: current.attachments.filter((file) => file.id !== attachment.id),
                    }))
                  }
                >
                  <X size={12} />
                </IconButton>
              </div>
            ))}
          </div>
        ) : null}
        <textarea
          ref={textarea}
          id="prompt-input"
          aria-label="Message"
          placeholder={
            active
              ? 'Add a follow-up or guide the current task…'
              : 'Ask anything, or describe what to build…'
          }
          value={draft}
          rows={2}
          spellCheck={false}
          onChange={(event) => {
            const next = updateLocalDraft((current) => ({ ...current, text: event.target.value }))
            draftRef.current = next.text
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void submit()
            }
          }}
        />
        <div className="composer-toolbar">
          <div className="composer-controls">
            <IconButton
              label={attaching ? 'Adding attachments' : 'Add files or images'}
              disabled={attaching || sending || (active && sendMode === 'steer')}
              onClick={() => void attach()}
            >
              {attaching ? <Spinner /> : <Paperclip size={17} />}
            </IconButton>
            <label
              className="compact-select provider-select"
              title={active ? 'Connection is fixed while this task is running' : 'Connection'}
            >
              <span className={`provider-dot ${provider?.available ? '' : 'unavailable'}`} />
              <select
                aria-label="Provider"
                value={task.providerId}
                disabled={active || sending}
                onChange={(event) => {
                  const next = providers.find((item) => item.id === event.target.value)
                  if (next) {
                    const model = preferredModel(next)
                    update({
                      providerId: next.id,
                      model: model?.id || '',
                      effort: preferredEffort(model?.efforts),
                    })
                  }
                }}
              >
                {providers.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {!item.available
                      ? ' · unavailable'
                      : item.authenticated === false
                        ? ' · sign in'
                        : ''}
                  </option>
                ))}
              </select>
              <ChevronDown size={11} />
            </label>
            <label className="compact-select model-select" title={model?.description || 'Model'}>
              <select
                aria-label="Model"
                value={task.model}
                disabled={active || sending || !provider?.models.length}
                onChange={(event) => {
                  const next = provider?.models.find((item) => item.id === event.target.value)
                  update({
                    model: event.target.value,
                    effort: next?.efforts?.includes(task.effort)
                      ? task.effort
                      : preferredEffort(next?.efforts),
                  })
                }}
              >
                {!provider?.models.some((item) => item.id === task.model) ? (
                  <option value={task.model}>{task.model || 'Default model'}</option>
                ) : null}
                {provider?.models.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={11} />
            </label>
            {model?.efforts?.length ? (
              <label className="compact-select effort-select" title="Reasoning effort">
                <select
                  aria-label="Reasoning effort"
                  value={task.effort}
                  disabled={active || sending}
                  onChange={(event) => update({ effort: event.target.value })}
                >
                  {!model.efforts.includes(task.effort) ? (
                    <option value={task.effort}>{task.effort || 'Default'}</option>
                  ) : null}
                  {model.efforts.map((effort) => (
                    <option key={effort} value={effort}>
                      {effort.charAt(0).toUpperCase() + effort.slice(1)}
                    </option>
                  ))}
                </select>
                <ChevronDown size={11} />
              </label>
            ) : null}
          </div>
          <div className="composer-send-controls">
            {active ? (
              <IconButton
                label={stopping ? 'Stopping task' : 'Stop task'}
                className="stop-button"
                disabled={stopping}
                onClick={() => void stop()}
              >
                {stopping ? <Spinner /> : <Square size={13} fill="currentColor" />}
              </IconButton>
            ) : null}
            <IconButton
              label={
                sending
                  ? 'Sending'
                  : active
                    ? sendMode === 'steer' && allowSteer
                      ? 'Guide current task'
                      : 'Queue message'
                    : 'Send message'
              }
              className="send-button"
              disabled={
                !draft.trim() || sending || !available || localDraft.pending?.kind === 'steer'
              }
              onClick={() => void submit()}
            >
              {sending ? <Spinner /> : <ArrowUp size={18} strokeWidth={2} />}
            </IconButton>
          </div>
        </div>
      </div>
      <div className="composer-meta">
        <label
          className="permission-select"
          title="Read: inspect only. Work: changes inside the project. Full access: includes the wider computer."
        >
          <ShieldCheck size={12} />
          <select
            aria-label="Permission mode"
            disabled={active || sending}
            value={task.mode}
            onChange={(event) => update({ mode: event.target.value as PermissionMode })}
          >
            <option value="read">Read only</option>
            <option value="work">Workspace access</option>
            <option value="full">Full access</option>
          </select>
          <ChevronDown size={10} />
        </label>
        {!available ? (
          <button className="connection-warning" onClick={onConnections}>
            {provider?.authenticated === false
              ? 'Sign in to this connection'
              : 'Set up your connection'}
            <ChevronDown size={11} />
          </button>
        ) : active ? (
          <label className="queue-select">
            <select
              aria-label="Follow-up behavior"
              value={sendMode}
              onChange={(event) => setSendMode(event.target.value as 'queue' | 'steer')}
            >
              <option value="queue">Queue next message</option>
              {allowSteer ? <option value="steer">Guide current task</option> : null}
            </select>
            <ChevronDown size={10} />
          </label>
        ) : (
          <span className="composer-hint">
            Enter to send <span>·</span> Shift Enter for a new line
          </span>
        )}
      </div>
    </div>
  )
}
